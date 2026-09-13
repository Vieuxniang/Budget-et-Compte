import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildBackup,
  buildEncryptedBackup,
  parseBackup,
  readPlainBackup,
  readEncryptedBackup,
  backupFilename,
  backupSummary,
  downloadBackup,
} from './backup';
import { AppData, initialData } from './storage';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

const sample = (): AppData => {
  const d = initialData();
  d.transactions = d.transactions.slice(0, 2);
  return d;
};

const now = new Date('2026-09-10T12:00:00Z');

describe('plain backups', () => {
  it('round-trips: build → parse → read returns equal data', () => {
    const file = buildBackup(sample(), now);
    const json = JSON.stringify(file);
    const parsed = parseBackup(json);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    const read = readPlainBackup(parsed.file as never);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.data).toEqual(sample());
  });

  it('rejects non-JSON, foreign app ids, and missing data', () => {
    expect(parseBackup('not json').kind).toBe('invalid');
    const foreign = parseBackup(JSON.stringify({ ...buildBackup(sample(), now), app: 'other-app' }));
    expect(foreign.kind).toBe('invalid');
    const noData = parseBackup(JSON.stringify({ app: 'patrifamille-fcfa', kind: 'plain', version: 1, exportedAt: now.toISOString() }));
    expect(noData.kind).toBe('invalid');
  });

  it('rejects a future backup version with a clear reason', () => {
    const file = { ...buildBackup(sample(), now), version: 99 };
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.kind).toStrictEqual('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('Version');
  });
});

describe('encrypted backups', () => {
  it('round-trips: build → parse → read with the passphrase', async () => {
    const data = sample();
    const file = await buildEncryptedBackup(data, 'phrase-secrete', now);
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    const read = await readEncryptedBackup(parsed.file as never, 'phrase-secrete');
    expect(read.kind).toStrictEqual('ok');
    if (read.kind !== 'ok') return;
    expect(read.data).toEqual(data);
  });

  it('envelope stays prefixed and carries no plaintext', async () => {
    const file = await buildEncryptedBackup(sample(), 'phrase-secrete', now);
    expect(file.envelope.startsWith('pfbak1$')).toBe(true);
    expect(file.envelope).not.toContain('Compte');
    const json = JSON.stringify(file);
    expect(json).not.toContain('"transactions":[{');
  });

  it('rejects the wrong passphrase cleanly', async () => {
    const file = await buildEncryptedBackup(sample(), 'phrase-secrete', now);
    const parsed = parseBackup(JSON.stringify(file));
    if (parsed.kind !== 'ok') throw new Error('parse failed');
    const read = await readEncryptedBackup(parsed.file as never, 'mauvaise-phrase');
    expect(read.kind).toBe('wrong-passphrase');
  });

  it('detects a tampered ciphertext byte', async () => {
    const file = await buildEncryptedBackup(sample(), 'phrase-secrete', now);
    const parts = file.envelope.split('$');
    const b64 = parts[3];
    const decoded = atob(b64);
    const flipped = btoa(String.fromCharCode(decoded.charCodeAt(0) ^ 0x01) + decoded.slice(1));
    const tampered = { ...file, envelope: [parts[0], parts[1], parts[2], flipped].join('$') };
    const parsed = parseBackup(JSON.stringify(tampered));
    if (parsed.kind !== 'ok') throw new Error('parse failed');
    const read = await readEncryptedBackup(parsed.file as never, 'phrase-secrete');
    expect(['wrong-passphrase']).toContain(read.kind);
  });

  it('rejects malformed envelopes', async () => {
    const file = { ...(await buildEncryptedBackup(sample(), 'p', now)), envelope: 'pfbak1$only-salt' };
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    const read = await readEncryptedBackup(parsed.file as never, 'p');
    expect(read.kind).toBe('invalid');
  });

  it('a plain backup is not readable through the encrypted path', () => {
    const file = buildBackup(sample(), now);
    expect(file.kind).toBe('plain');
    expect('envelope' in file).toBe(false);
  });
});

describe('helpers', () => {
  it('filename reflects the mode and date', () => {
    expect(backupFilename(buildBackup(sample(), now), now)).toBe('budget-et-compte-sauvegarde-2026-09-10.json');
    expect(backupFilename({ kind: 'encrypted' }, now)).toBe('budget-et-compte-sauvegarde-chiffree-2026-09-10.json');
  });

  it('summary counts sections', () => {
    const s = backupSummary(sample());
    expect(s).toContain('6 comptes');
    expect(s).toContain('2 opérations');
    expect(s).toContain('6 catégories');
    expect(s).toContain('2 objectifs');
    expect(s).not.toContain('NaN');
    expect(s).not.toContain('undefined');
  });

  it('summary counts the optional tontine and pack sections, singular included', () => {
    const data = sample();
    data.tontineGroups = [{ id: 'tg-1', name: 'G', contribution: 5000, currency: 'XOF', frequency: 'monthly', startDate: '2026-01-01' }];
    data.tontineGroups.push({ ...data.tontineGroups[0], id: 'tg-2' });
    data.installedPacks = [{ id: 'sn-2025', version: 1, installedAt: '2026-09-01' }];

    const s = backupSummary(data);
    expect(s).toContain('2 tontines');
    expect(s).toContain('1 pack');
    expect(s).not.toContain('1 packs');
  });

  it('downloadBackup is a safe no-op outside the browser', () => {
    expect(() => downloadBackup('{}', 'x.json')).not.toThrow();
  });
});
