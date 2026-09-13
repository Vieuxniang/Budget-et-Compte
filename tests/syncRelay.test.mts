/**
 * Integration test of the sync relay — the only test that uses the real HTTP
 * stack, a real spawned process and real files.
 *
 * It answers the questions the unit tests cannot: does the relay enforce its
 * protocol (tokens, ETag preconditions, no gaps and no rewinds in the version
 * sequence), do two engines converge through it using the *default* transport,
 * and is what lands on disk genuinely opaque?
 *
 * It lives in `tests/` rather than `src/` because it needs Node builtins (spawn,
 * fs, net) while `tsc` only type-checks the app under `src/`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncEngine } from '../src/services/sync/engine';
import { deriveSyncKeys, parseSyncCode, sealSnapshot } from '../src/services/sync/crypto';
import { initialData, type AppData } from '../src/services/storage';

let child: ChildProcess;
let relayUrl = '';
let dataDir = '';
let log = '';

/** Waits for the relay's banner line and returns the port it bound. */
function waitForUrl(process: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start:\n${log}`)), 10_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    process.stdout?.on('data', onData);
    process.stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    process.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code}:\n${log}`));
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Device {
  engine: SyncEngine;
  data: AppData;
}

function makeDevice(id: string): Device {
  const cache = new Map<string, string>();
  const engine = new SyncEngine({
    storage: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => void cache.set(key, value),
      removeItem: (key) => void cache.delete(key),
    },
    autoSync: false,
    // No transportFor override: the engine builds the real HTTP transport.
    newDeviceId: () => id,
  });
  return { engine, data: initialData() };
}

async function open(device: Device): Promise<void> {
  const vaultKey = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  const report = await device.engine.open({ vaultKey, data: device.data });
  if (report?.data) {
    device.data = report.data;
    device.engine.publish(device.data);
  }
}

async function apply(device: Device, action: (data: AppData) => AppData): Promise<void> {
  device.data = action(device.data);
  device.engine.publish(device.data);
  const report = await device.engine.sync();
  if (report.data) {
    device.data = report.data;
    device.engine.publish(device.data);
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-relay-'));
  const port = await freePort();
  child = spawn(process.execPath, ['scripts/sync-relay.mjs', '--port', String(port), '--dir', dataDir], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relayUrl = await waitForUrl(child);
});

afterAll(() => {
  child?.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('reference relay over HTTP', () => {
  it('answers a health check', async () => {
    const response = await fetch(`${relayUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it('enforces the protocol: token, precondition, no gaps, no rewinds', async () => {
    const channel = 'c'.repeat(24);
    const token = 'jeton-de-test';
    const url = `${relayUrl}/v1/channels/${channel}`;
    const put = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const blob = { v: 1, iv: 'aXY=', ct: 'Y3Q=' };

    // An unknown channel is empty, not an error.
    const empty = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ version: 0, etag: null, blob: null });

    // No precondition at all means "overwrite whatever is there": refused.
    expect((await put({ version: 1, blob })).status).toBe(428);
    // Wrong version for an empty channel.
    expect((await put({ version: 2, blob }, { 'if-none-match': '*' })).status).toBe(409);
    // First write.
    const first = await put({ version: 1, blob }, { 'if-none-match': '*' });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ version: 1, etag: 'r1' });
    // Rewriting the same version, and skipping a version, are both refused.
    expect((await put({ version: 1, blob }, { 'if-match': 'r1' })).status).toBe(409);
    expect((await put({ version: 3, blob }, { 'if-match': 'r1' })).status).toBe(409);
    // A stale etag is refused, the next version is accepted.
    expect((await put({ version: 2, blob }, { 'if-match': 'r0' })).status).toBe(409);
    expect((await put({ version: 2, blob }, { 'if-match': 'r1' })).status).toBe(200);

    // The channel is claimed by the first token: another one cannot read or write.
    expect((await fetch(url)).status).toBe(401);
    const intruder = await fetch(url, { headers: { authorization: 'Bearer autre-jeton' } });
    expect(intruder.status).toBe(403);
    expect(
      (
        await fetch(url, {
          method: 'PUT',
          headers: { authorization: 'Bearer autre-jeton', 'content-type': 'application/json', 'if-match': 'r2' },
          body: JSON.stringify({ version: 3, blob }),
        })
      ).status
    ).toBe(403);
  });

  it('stores opaquely: no name, no amount, not even the code', async () => {
    const device = makeDevice('cccccc');
    device.data = {
      ...device.data,
      accounts: device.data.accounts.map((account) =>
        account.id === 'acc-1' ? { ...account, name: 'MARQUEUR-CONFIDENTIEL-2481' } : account
      ),
    };
    await open(device);
    const enabled = await device.engine.enable({ relayUrl });
    if (!enabled.ok) throw new Error('enable failed');
    const code = enabled.code;
    const parsed = parseSyncCode(code);
    if (!parsed) throw new Error('bad code');
    const keys = await deriveSyncKeys(parsed.passphrase, parsed.saltB64);

    const files = fs.readdirSync(dataDir);
    expect(files.length).toBeGreaterThan(0);
    const onDisk = files.map((file) => fs.readFileSync(path.join(dataDir, file), 'utf8')).join('\n');
    expect(onDisk).not.toContain('MARQUEUR-CONFIDENTIEL-2481');
    expect(onDisk).not.toContain(parsed.passphrase);
    expect(onDisk).not.toContain(code);
    // The row name is the derived channel id, which is not the code.
    expect(files.some((file) => file.startsWith(keys.channelId))).toBe(true);

    // A blob dropped into the relay is unreadable without the phrase.
    const decoy = await sealSnapshot(keys, 1, { v: 1, device: 'zz', records: {} });
    expect(JSON.stringify(decoy)).not.toContain('records');
  });

  it('converges two devices through the real transport', async () => {
    const a = makeDevice('aaaaaa');
    const b = makeDevice('bbbbbb');
    await open(a);
    await open(b);

    const enabled = await a.engine.enable({ relayUrl });
    if (!enabled.ok) throw new Error('enable failed');
    if (enabled.data) {
      a.data = enabled.data;
      a.engine.publish(a.data);
    }

    const joined = await b.engine.enable({ relayUrl, code: enabled.code });
    if (!joined.ok) throw new Error('join failed');
    if (joined.data) {
      b.data = joined.data;
      b.engine.publish(b.data);
    }

    await apply(a, (data) => ({
      ...data,
      transactions: [
        ...data.transactions,
        {
          id: 'tx-relais', date: '2026-09-01', title: 'Cotisation tontine', amount: 50_000,
          type: 'expense' as const, category: 'Épargne & Projets', accountId: 'acc-1', member: 'Awa',
        },
      ],
    }));
    await apply(b, () => b.data);

    expect(b.data.transactions.some((transaction) => transaction.id === 'tx-relais')).toBe(true);
    expect(a.engine.state().status).toMatchObject({ kind: 'synced' });
    expect(b.engine.state().status).toMatchObject({ kind: 'synced' });

    // And back the other way, so the two devices really converge.
    await apply(b, (data) => ({
      ...data,
      goals: data.goals.map((goal) => (goal.id === 'g-1' ? { ...goal, currentAmount: 4_500_000 } : goal)),
    }));
    await apply(a, () => a.data);
    expect(a.data.goals.find((goal) => goal.id === 'g-1')?.currentAmount).toBe(4_500_000);
  });
});
