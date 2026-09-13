/**
 * End-to-end tests of the sync engine, with two devices talking through the same
 * in-memory relay slot and a controllable clock. These are the tests that say
 * what the feature *is*: offline edits never lost, a joining device adopting the
 * shared data, concurrent edits resolved the same way everywhere, and a relay
 * that cannot roll a device back.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SyncEngine, type EnableResult, type SyncReport, type SyncStorage } from './engine';
import { memoryTransport, type MemoryTransport } from './transport';
import { deriveSyncKeys, parseSyncCode, sealSnapshot } from './crypto';
import type { SyncTransport } from './types';
import { applyRecords, canonical, flatten, recordId } from './records';
import { initialData, type AppData } from '../storage';

const RELAY = 'http://relais.test';

interface Device {
  engine: SyncEngine;
  data: AppData;
  state: SyncStorage;
  cache: Map<string, string>;
  /** Kept so a "restart" can reopen the same vault key (sealed passphrase). */
  vaultKey: CryptoKey;
}

function storageOf(cache: Map<string, string>): SyncStorage {
  return {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => void cache.set(key, value),
    removeItem: (key) => void cache.delete(key),
  };
}

/** One device: its own storage, its own engine, one shared clock. */
async function device(options: {
  id: string;
  transport: SyncTransport;
  now: () => number;
  data?: AppData;
  cache?: Map<string, string>;
  vaultKey?: CryptoKey;
}): Promise<Device> {
  const cache = options.cache ?? new Map<string, string>();
  const vaultKey = options.vaultKey ?? (await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  ));
  const engine = new SyncEngine({
    storage: storageOf(cache),
    now: options.now,
    transportFor: () => options.transport,
    autoSync: false,
    newDeviceId: () => options.id,
  });
  // Opening syncs, so a device that reconnects on launch adopts what it pulls —
  // exactly what App does with the report.
  let data = options.data ?? initialData();
  const openReport = await engine.open({ vaultKey, data });
  if (openReport?.data) {
    data = openReport.data;
    engine.publish(data);
  }
  return { engine, data, state: storageOf(cache), cache, vaultKey };
}

/** Applies whatever the engine pulled, the way the app does after a sync. */
function absorb(target: Device, report: EnableResult | SyncReport | null): void {
  // A refused enable carries no data; a report's data is null when nothing
  // changed locally.
  if (!report || !('data' in report) || !report.data) return;
  target.data = report.data;
  target.engine.publish(report.data);
}

async function sync(device: Device) {
  const report = await device.engine.sync();
  absorb(device, report);
  return report;
}

/** Entity values only — ignores array order, which has no meaning here. */
function values(data: AppData): Record<string, string> {
  const flat = flatten(data);
  return Object.fromEntries(Object.entries(flat).map(([id, value]) => [id, canonical(value)]));
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-local-1',
    date: '2026-09-01',
    title: 'Achat de rentrée',
    amount: 25_000,
    type: 'expense' as const,
    category: 'Scolarité & Enfants',
    accountId: 'acc-1',
    member: 'Awa',
    ...overrides,
  };
}

let clock = 1_700_000_000_000;
const now = () => clock;

beforeEach(() => {
  clock = 1_700_000_000_000;
});

describe('two devices and one relay', () => {
  let relay: MemoryTransport;
  let a: Device;
  let b: Device;

  beforeEach(async () => {
    relay = memoryTransport();
    a = await device({ id: 'aaaaaa', transport: relay, now });
    b = await device({ id: 'bbbbbb', transport: relay, now });
  });

  async function pair(): Promise<string> {
    const enabled = await a.engine.enable({ relayUrl: RELAY });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) throw new Error('enable failed');
    absorb(a, enabled);
    const joined = await b.engine.enable({ relayUrl: RELAY, code: enabled.code });
    expect(joined.ok).toBe(true);
    absorb(b, joined);
    return enabled.code;
  }

  it('sends a local edit to the other device', async () => {
    await pair();
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction()] };
    a.engine.publish(a.data);
    expect(a.engine.state().status).toMatchObject({ kind: 'idle', pending: 1 });

    await sync(a);
    expect(a.engine.state().status).toMatchObject({ kind: 'synced', pending: 0 });
    expect(relay.slot.version).toBe(2); // v1 = the initial exchange, v2 = the edit

    await sync(b);
    expect(b.data.transactions.some((t) => t.id === 'tx-local-1')).toBe(true);
  });

  it('flows edits in both directions and converges on the same state', async () => {
    await pair();
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction({ title: 'Payé par A' })] };
    a.engine.publish(a.data);
    await sync(a);

    b.data = {
      ...b.data,
      goals: b.data.goals.map((goal) => (goal.id === 'g-2' ? { ...goal, currentAmount: 6_000_000 } : goal)),
    };
    b.engine.publish(b.data);
    await sync(b);

    await sync(a);
    expect(values(a.data)).toEqual(values(b.data));
    expect((a.data.goals.find((g) => g.id === 'g-2') as { currentAmount: number }).currentAmount).toBe(6_000_000);
    expect(b.data.transactions.some((t) => t.title === 'Payé par A')).toBe(true);
  });

  it('adopts the shared family data on a first join, archiving what it replaced', async () => {
    a.data = {
      ...a.data,
      accounts: a.data.accounts.map((account) =>
        account.id === 'acc-1' ? { ...account, name: 'Compte réel de la famille' } : account
      ),
    };
    a.engine.publish(a.data);
    await a.engine.enable({ relayUrl: RELAY }).then((result) => absorb(a, result));

    const code = a.engine.revealCode();
    expect(code).not.toBeNull();
    const joined = await b.engine.enable({ relayUrl: RELAY, code: code as string });
    absorb(b, joined);

    // Device B's seed for the same id is replaced, and the loss is archived.
    expect(b.data.accounts.find((account) => account.id === 'acc-1')?.name).toBe('Compte réel de la famille');
    const archive = b.engine.state().archive;
    expect(archive.some((entry) => entry.target === recordId('account', 'acc-1'))).toBe(true);
    expect(archive.find((entry) => entry.target === recordId('account', 'acc-1'))?.reason).toBe('first-join');
  });

  it('keeps local changes while offline, then catches up without losing anything', async () => {
    await pair();
    relay.failNext(1);
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction()] };
    a.engine.publish(a.data);

    const offline = await a.engine.sync();
    expect(offline.status.kind).toBe('offline');
    expect(offline.data).toBeNull();
    expect(a.data.transactions.some((t) => t.id === 'tx-local-1')).toBe(true);
    expect(a.engine.pending()).toBe(1);

    await sync(a);
    expect(a.engine.pending()).toBe(0);
    await sync(b);
    expect(b.data.transactions.some((t) => t.id === 'tx-local-1')).toBe(true);
  });

  it('retries when the relay refuses a stale version, without dropping either edit', async () => {
    await pair();
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction({ id: 'tx-a', title: 'Payé par A' })] };
    a.engine.publish(a.data);
    await sync(a);
    b.data = { ...b.data, transactions: [...b.data.transactions, transaction({ id: 'tx-b', title: 'Payé par B' })] };
    b.engine.publish(b.data);

    // B pulls, and while it is merging, A slips a newer edit in: B's push must be
    // refused (409), and B must re-merge rather than overwrite A.
    let raced = false;
    const racing: SyncTransport = {
      pull: () => relay.pull(),
      push: async (etag, version, blob) => {
        if (!raced) {
          raced = true;
          a.data = { ...a.data, transactions: [...a.data.transactions, transaction({ id: 'tx-c', title: 'Payé par A aussi' })] };
          a.engine.publish(a.data);
          await sync(a);
          return { ok: false, current: await relay.pull() };
        }
        return relay.push(etag, version, blob);
      },
    };
    const b2 = await device({ id: 'bbbbbb', transport: racing, now, cache: b.cache, data: b.data, vaultKey: b.vaultKey });
    const report = await sync(b2);

    expect(b2.data.transactions.some((t) => t.id === 'tx-c')).toBe(true);
    expect(b2.data.transactions.some((t) => t.id === 'tx-b')).toBe(true);
    expect(report.status).toMatchObject({ kind: 'synced' });

    await sync(a);
    expect(a.data.transactions.some((t) => t.id === 'tx-b')).toBe(true);
  });

  it('refuses a replayed older version instead of reverting the device', async () => {
    const code = await pair();
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction()] };
    a.engine.publish(a.data);
    await sync(a);
    expect(a.engine.state().status).toMatchObject({ kind: 'synced', version: 2 });

    // A hostile or buggy relay serves version 1 again, correctly sealed.
    const parsed = parseSyncCode(code);
    if (!parsed) throw new Error('bad code');
    const keys = await deriveSyncKeys(parsed.passphrase, parsed.saltB64);
    const old = await sealSnapshot(keys, 1, {
      v: 1,
      device: 'aaaaaa',
      records: {
        'account:acc-1': {
          c: { ms: 1, seq: 0, device: 'aaaaaa' },
          value: { id: 'acc-1', name: 'VERSION ANCIENNE', type: 'checking' },
        },
      },
    });
    relay.slot = { version: 1, etag: 'r1', blob: old };

    const report = await a.engine.sync();
    expect(report.status).toMatchObject({ kind: 'problem', problem: 'rollback' });
    expect(a.data.accounts.find((account) => account.id === 'acc-1')?.name).not.toBe('VERSION ANCIENNE');
    expect(a.engine.pending()).toBe(0);
  });

  it('treats a blob it cannot open as a problem, not as empty data', async () => {
    await pair();
    const blob = relay.slot.blob;
    expect(blob).not.toBeNull();
    relay.slot = {
      version: 3,
      etag: 'r3',
      blob: { v: 1, iv: (blob as { iv: string }).iv, ct: `A${(blob as { ct: string }).ct.slice(1)}` },
    };
    const report = await a.engine.sync();
    expect(report.status).toMatchObject({ kind: 'problem', problem: 'corrupt' });
  });

  it('carries a deletion as a tombstone so an offline device cannot resurrect it', async () => {
    await pair();
    a.data = { ...a.data, accounts: a.data.accounts.filter((account) => account.id !== 'acc-2') };
    a.engine.publish(a.data);
    await sync(a);
    expect(a.data.accounts.some((account) => account.id === 'acc-2')).toBe(false);

    clock += 60_000;
    await sync(b);
    expect(b.data.accounts.some((account) => account.id === 'acc-2')).toBe(false);
  });

  it('archives the conflict when both devices edited the same record', async () => {
    await pair();
    clock += 1_000;
    a.data = {
      ...a.data,
      goals: a.data.goals.map((goal) => (goal.id === 'g-1' ? { ...goal, targetAmount: 7_000_000 } : goal)),
    };
    a.engine.publish(a.data);

    clock += 1_000;
    b.data = {
      ...b.data,
      goals: b.data.goals.map((goal) => (goal.id === 'g-1' ? { ...goal, targetAmount: 9_000_000 } : goal)),
    };
    b.engine.publish(b.data);

    await sync(a);
    clock += 1_000;
    await sync(b); // detects the conflict, keeps the deterministic winner (B's clock is later)

    const kept = b.data.goals.find((goal) => goal.id === 'g-1')?.targetAmount;
    expect(kept).toBe(9_000_000);
    expect(b.engine.state().archive).toHaveLength(1);
    const conflict = b.engine.state().archive[0];
    expect(conflict.target).toBe(recordId('goal', 'g-1'));
    expect((conflict.discarded.value as { targetAmount: number }).targetAmount).toBe(7_000_000);
    expect(conflict.winner).toBe('local');

    // The archive travels: device A learns that an edit was overwritten.
    clock += 1_000;
    await sync(a);
    expect(a.engine.state().archive).toHaveLength(1);
    expect(a.data.goals.find((goal) => goal.id === 'g-1')?.targetAmount).toBe(9_000_000);
  });

  it('lets the losing version be put back, everywhere', async () => {
    await pair();
    clock += 1_000;
    a.data = { ...a.data, goals: a.data.goals.map((g) => (g.id === 'g-1' ? { ...g, targetAmount: 7_000_000 } : g)) };
    a.engine.publish(a.data);
    clock += 1_000;
    b.data = { ...b.data, goals: b.data.goals.map((g) => (g.id === 'g-1' ? { ...g, targetAmount: 9_000_000 } : g)) };
    b.engine.publish(b.data);

    await sync(a);
    clock += 1_000;
    await sync(b);
    const entry = b.engine.state().archive[0];

    const restored = await b.engine.restore(entry.id);
    expect(restored).not.toBeNull();
    b.data = restored as AppData;
    expect(b.data.goals.find((goal) => goal.id === 'g-1')?.targetAmount).toBe(7_000_000);
    expect(b.engine.state().archive).toHaveLength(0);

    clock += 1_000;
    await sync(a);
    expect(a.data.goals.find((goal) => goal.id === 'g-1')?.targetAmount).toBe(7_000_000);
    // The restored version is the shared truth, not a new conflict.
    expect(a.engine.state().archive).toHaveLength(0);
  });

  it('keeps the archive bounded and dismissible', async () => {
    await pair();
    clock += 1_000;
    a.data = { ...a.data, goals: a.data.goals.map((g) => (g.id === 'g-1' ? { ...g, targetAmount: 1 } : g)) };
    a.engine.publish(a.data);
    clock += 1_000;
    b.data = { ...b.data, goals: b.data.goals.map((g) => (g.id === 'g-1' ? { ...g, targetAmount: 2 } : g)) };
    b.engine.publish(b.data);
    await sync(a);
    clock += 1_000;
    await sync(b);
    const entry = b.engine.state().archive[0];
    await b.engine.dismiss(entry.id);
    expect(b.engine.state().archive).toHaveLength(0);
    clock += 1_000;
    await sync(b);
    await sync(a);
    expect(a.engine.state().archive).toHaveLength(0);
  });

  it('stores no record value in the sync state (ids and clocks only)', async () => {
    await pair();
    a.data = {
      ...a.data,
      accounts: a.data.accounts.map((account) =>
        account.id === 'acc-1' ? { ...account, name: 'SALAIRE-CONFIDENTIEL-9137', initialBalance: 987_654_321 } : account
      ),
    };
    a.engine.publish(a.data);
    await sync(a);
    await sync(b);

    for (const cache of [a.cache, b.cache]) {
      const raw = [...cache.entries()].map(([key, value]) => `${key}=${value}`).join('\n');
      expect(raw).not.toContain('SALAIRE-CONFIDENTIEL-9137');
      expect(raw).not.toContain('987654321');
      // …but the ids and stamps it needs are there.
      expect(raw).toContain('account:acc-1');
    }
  });

  it('survives a restart: the sealed passphrase reopens the same channel', async () => {
    await pair();
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction({ title: 'Après redémarrage' })] };
    a.engine.publish(a.data);
    await sync(a);

    // Same device id, storage and vault key; fresh engine: as after a reload.
    const restarted = await device({ id: 'aaaaaa', transport: relay, now, cache: a.cache, vaultKey: a.vaultKey });
    expect(restarted.engine.state().enabled).toBe(true);
    expect(restarted.engine.state().unlocked).toBe(true);
    expect(restarted.engine.revealCode()).not.toBeNull();
    await sync(restarted);
    expect(restarted.data.transactions.some((t) => t.title === 'Après redémarrage')).toBe(true);
  });

  it('asks for the code again when the vault password changed', async () => {
    await pair();
    // A new vault key means the sealed passphrase can no longer be opened.
    const otherVault = await crypto.subtle.importKey(
      'raw',
      crypto.getRandomValues(new Uint8Array(32)),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    const restarted = await device({ id: 'aaaaaa', transport: relay, now, cache: a.cache, vaultKey: a.vaultKey });
    const report = await restarted.engine.open({ vaultKey: otherVault, data: restarted.data });
    expect(report).toBeNull();
    expect(restarted.engine.state()).toMatchObject({ enabled: true, needsCode: true, unlocked: false });
    expect(restarted.engine.state().status.kind).toBe('locked');
  });

  it('re-publishes everything after a relay wipe (resetRemote)', async () => {
    await pair();
    relay.slot = { version: 0, etag: null, blob: null };
    const report = await a.engine.sync();
    expect(report.status).toMatchObject({ kind: 'problem', problem: 'rollback' });

    await a.engine.resetRemote();
    expect(relay.slot.version).toBeGreaterThan(0);
    await sync(b);
    expect(values(a.data)).toEqual(values(b.data));
  });

  it('turns sync back on with the same channel, keeping the changes made while it was off', async () => {
    const code = await pair();
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction({ id: 'tx-on' })] };
    a.engine.publish(a.data);
    await sync(a);

    a.engine.disable();
    expect(a.engine.state()).toMatchObject({ enabled: false, hasSetup: true });

    // A change made while sync is off must not be lost, and must not create a
    // second channel: re-enabling reuses the sealed setup.
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction({ id: 'tx-off' })] };
    a.engine.publish(a.data);
    await sync(a); // still off: nothing happens
    expect(a.engine.pending()).toBe(1);

    const resumed = await a.engine.enable({ relayUrl: RELAY });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.code).toBe(code);
    absorb(a, resumed);
    expect(a.engine.pending()).toBe(0);

    await sync(b);
    expect(b.data.transactions.some((t) => t.id === 'tx-off')).toBe(true);
  });

  it('leaves the data alone after a forget, and stops syncing', async () => {
    await pair();
    a.engine.forget();
    expect(a.engine.state()).toMatchObject({ enabled: false, unlocked: false, archive: [] });
    a.data = { ...a.data, transactions: [...a.data.transactions, transaction()] };
    a.engine.publish(a.data);
    const report = await a.engine.sync();
    expect(report.status.kind).toBe('off');
    expect(a.engine.pending()).toBe(0);
  });
});

describe('applyRecords rebuilds the app data', () => {
  it('keeps the conflict archive out of the entity arrays', async () => {
    const relay = memoryTransport();
    const a = await device({ id: 'aaaaaa', transport: relay, now });
    const enabled = await a.engine.enable({ relayUrl: RELAY });
    absorb(a, enabled);
    const rebuilt = applyRecords(
      Object.fromEntries(
        Object.entries(flatten(a.data)).map(([id, value]) => [id, { c: { ms: 1, seq: 0, device: 'a' }, value }])
      )
    );
    expect(rebuilt.accounts).toHaveLength(a.data.accounts.length);
    expect(rebuilt.syncConflicts).toBeUndefined();
  });
});
