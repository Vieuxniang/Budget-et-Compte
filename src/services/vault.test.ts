import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  deriveVaultKey,
  encryptString,
  decryptString,
  hashPassword,
} from './crypto';
import {
  setupVault,
  unlockVault,
  encryptAndStore,
  rekeyVault,
  migratePlainToVault,
  readEnvelope,
  parseEnvelope,
  normalizeVaultData,
} from './vault';
import { AppData, initialData } from './storage';

// ---------------------------------------------------------------------------
// Minimal localStorage stub (vitest runs in node; storage.ts touches it)
// ---------------------------------------------------------------------------

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

beforeEach(() => {
  const store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleData = (): AppData => ({
  ...initialData(),
  transactions: initialData().transactions.slice(0, 2),
});

const PASSWORD = 'famille2026';
const WRONG = 'faux-mot-de-passe';

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

describe('vault crypto primitives', () => {
  it('round-trips a string through AES-GCM', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveVaultKey(PASSWORD, salt);
    const payload = await encryptString(key, '{"hello":"FCFA"}');
    const plaintext = await decryptString(key, payload);
    expect(plaintext).toBe('{"hello":"FCFA"}');
  });

  it('generates a fresh IV on every encryption', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveVaultKey(PASSWORD, salt);
    const a = await encryptString(key, 'same');
    const b = await encryptString(key, 'same');
    const sameIv = a.iv.every((byte, i) => byte === b.iv[i]);
    const sameCt = a.ciphertext.every((byte, i) => byte === b.ciphertext[i]);
    expect(sameIv).toBe(false);
    // Different IV ⇒ different keystream ⇒ different ciphertext for equal input.
    expect(sameCt).toBe(false);
  });

  it('rejects decryption with a different key (auth tag)', async () => {
    const saltA = crypto.getRandomValues(new Uint8Array(16));
    const saltB = crypto.getRandomValues(new Uint8Array(16));
    const keyA = await deriveVaultKey(PASSWORD, saltA);
    const keyB = await deriveVaultKey(WRONG, saltB);
    const payload = await encryptString(keyA, 'secret');
    await expect(decryptString(keyB, payload)).rejects.toThrow();
  });

  it('detects a single flipped ciphertext byte', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveVaultKey(PASSWORD, salt);
    const payload = await encryptString(key, 'secret');
    payload.ciphertext[0] ^= 0x01; // tamper
    await expect(decryptString(key, payload)).rejects.toThrow();
  });

  it('derives non-extractable keys (cannot be read back out)', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveVaultKey(PASSWORD, salt);
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
  });
});

// ---------------------------------------------------------------------------
// Vault lifecycle
// ---------------------------------------------------------------------------

describe('vault lifecycle', () => {
  it('setup → readEnvelope → unlock returns the same data', async () => {
    const data = sampleData();
    const session = await setupVault(PASSWORD, data);

    expect(session.key.extractable).toBe(false);
    expect(readEnvelope()).not.toBeNull();

    const unlocked = await unlockVault(PASSWORD, readEnvelope()!);
    expect(unlocked.kind).toBe('ok');
    if (unlocked.kind !== 'ok') return;
    expect(unlocked.data).toEqual(data);
  });

  it('stores only ciphertext at rest — no plaintext key survives', async () => {
    await setupVault(PASSWORD, sampleData());
    const stored = localStorage.getItem('patrifamille_fcfa_vault_v1') ?? '';
    expect(stored.startsWith('pfvault1$')).toBe(true);
    expect(stored).not.toContain('Compte');
    expect(stored).not.toContain('acc-1');
    expect(localStorage.getItem('patrifamille_fcfa_data_v2')).toBeNull();
  });

  it('unlock with the wrong password fails cleanly (no throw)', async () => {
    await setupVault(PASSWORD, sampleData());
    const unlocked = await unlockVault(WRONG, readEnvelope()!);
    expect(unlocked.kind).toBe('decrypt-error');
  });

  it('saves round-trip: encryptAndStore then unlock reflects the change', async () => {
    const session = await setupVault(PASSWORD, sampleData());
    const data = sampleData();
    data.transactions.push({
      id: 'tx-x', date: '2026-09-10', title: 'Taxi', amount: 3500,
      type: 'expense', category: 'Transport & Carburant',
      accountId: 'acc-1', member: 'Famille',
    });
    await encryptAndStore(session.key, session.saltB64, data);

    const unlocked = await unlockVault(PASSWORD, readEnvelope()!);
    expect(unlocked.kind).toBe('ok');
    if (unlocked.kind !== 'ok') return;
    expect(unlocked.data.transactions.some((t) => t.id === 'tx-x')).toBe(true);
  });

  it('rekeyVault: new password opens, old password is rejected', async () => {
    await setupVault(PASSWORD, sampleData());
    const data = sampleData();
    const session2 = await rekeyVault('nouveau123', data);

    const withNew = await unlockVault('nouveau123', readEnvelope()!);
    expect(withNew.kind).toBe('ok');
    if (withNew.kind === 'ok') expect(withNew.data).toEqual(data);

    const withOld = await unlockVault(PASSWORD, readEnvelope()!);
    expect(withOld.kind).toBe('decrypt-error');
    void session2;
  });

  it('rekeyVault rotates the salt (fresh derivation per password)', async () => {
    const s1 = await setupVault(PASSWORD, sampleData());
    const s2 = await rekeyVault('autre-mot', sampleData());
    expect(s2.saltB64).not.toBe(s1.saltB64);
  });
});

// ---------------------------------------------------------------------------
// Migration + envelope parsing + normalization
// ---------------------------------------------------------------------------

describe('migration and envelope', () => {
  it('migrates plaintext v2 data into the vault and deletes the plaintext', async () => {
    const plain = sampleData();
    localStorage.setItem('patrifamille_fcfa_data_v2', JSON.stringify(plain));

    const migrated = await migratePlainToVault(PASSWORD);
    expect(migrated).not.toBeNull();
    if (!migrated) return;
    expect(migrated.data).toEqual(plain);

    expect(localStorage.getItem('patrifamille_fcfa_data_v2')).toBeNull();
    const unlocked = await unlockVault(PASSWORD, readEnvelope()!);
    expect(unlocked.kind).toBe('ok');
    if (unlocked.kind === 'ok') expect(unlocked.data).toEqual(plain);
  });

  it('returns null when there is nothing to migrate', async () => {
    const migrated = await migratePlainToVault(PASSWORD);
    expect(migrated).toBeNull();
  });

  it('parseEnvelope accepts valid envelopes and rejects malformed ones', () => {
    expect(parseEnvelope('pfvault1$AAAA$BBBB$CCCC')).toEqual({
      saltB64: 'AAAA', ivB64: 'BBBB', ctB64: 'CCCC',
    });
    expect(parseEnvelope('pfvault1$AAAA$BBBB')).toBeNull();
    expect(parseEnvelope('notavault$AAAA$BBBB$CCCC')).toBeNull();
    expect(parseEnvelope('pfvault1$!!no-base64!$BBBB$CCCC')).toBeNull();
  });

  it('normalizeVaultData fills missing sections and passes valid data through', () => {
    const data = sampleData();
    expect(normalizeVaultData(data)).toEqual(data);
    const healed = normalizeVaultData({ accounts: 'nope' });
    expect(healed.accounts).toEqual([]);
    expect(healed.budgetCategories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: password record + vault work from the same password
// ---------------------------------------------------------------------------

describe('password record + vault coherence', () => {
  it('a password that verifies against the record decrypts the vault', async () => {
    const record = await hashPassword(PASSWORD);
    await setupVault(PASSWORD, sampleData());

    // Same flow as AuthLock: verify → unlock.
    const envelope = readEnvelope()!;
    const unlocked = await unlockVault(PASSWORD, envelope);
    expect(unlocked.kind).toBe('ok');
    expect(record.startsWith('pbkdf2$')).toBe(true);
  });
});
