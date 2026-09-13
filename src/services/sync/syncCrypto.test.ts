/**
 * Sync crypto tests. PBKDF2 is deliberately slow (150k iterations), so keys are
 * derived once per shared code and reused: the cost would otherwise dominate the
 * suite without testing anything more.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveSyncKeys,
  formatSyncCode,
  newSyncSalt,
  openSnapshot,
  parseSyncCode,
  randomPassphrase,
  sealSnapshot,
  type SyncKeys,
} from './crypto';
import type { Snapshot } from './types';

const PASSPHRASE = 'ABCDE-FGHJK-MNPQR-STVWX';
const OTHER_PASSPHRASE = 'ZZZZZ-YYYYY-22222-33333';

let salt: string;
let keys: SyncKeys;
let otherSaltKeys: SyncKeys;

beforeAll(async () => {
  salt = newSyncSalt();
  keys = await deriveSyncKeys(PASSPHRASE, salt);
  otherSaltKeys = await deriveSyncKeys(PASSPHRASE, newSyncSalt());
});

const snapshot: Snapshot = {
  v: 1,
  device: 'aaaaaa',
  records: {
    'account:acc-1': { c: { ms: 1, seq: 0, device: 'aaaaaa' }, value: { id: 'acc-1', name: 'Salaire' } },
  },
};

describe('sync keys', () => {
  it('gives two devices the same channel and token for one code', async () => {
    const onSecondDevice = await deriveSyncKeys(PASSPHRASE, salt);
    expect(onSecondDevice.channelId).toBe(keys.channelId);
    expect(onSecondDevice.writeToken).toBe(keys.writeToken);
  });

  it('separates channels by phrase and by salt', async () => {
    const otherPhrase = await deriveSyncKeys(OTHER_PASSPHRASE, salt);
    expect(otherPhrase.channelId).not.toBe(keys.channelId);
    expect(otherPhrase.writeToken).not.toBe(keys.writeToken);
    expect(otherSaltKeys.channelId).not.toBe(keys.channelId);
  });

  it('derives a locator (22 chars) and a token, neither of which is the phrase', () => {
    expect(keys.channelId).toHaveLength(22);
    expect(keys.writeToken).toHaveLength(43);
    expect(keys.channelId).not.toContain(PASSPHRASE.slice(0, 5));
    expect(keys.writeToken).not.toContain('ABCDE');
  });
});

describe('snapshot sealing', () => {
  it('round-trips a snapshot', async () => {
    const blob = await sealSnapshot(keys, 7, snapshot);
    expect(JSON.stringify(blob)).not.toContain('Salaire');
    await expect(openSnapshot(keys, 7, blob)).resolves.toEqual(snapshot);
  });

  it('uses a fresh IV every time (same plaintext, different ciphertext)', async () => {
    const first = await sealSnapshot(keys, 1, snapshot);
    const second = await sealSnapshot(keys, 1, snapshot);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it('refuses a blob transplanted into another version', async () => {
    const blob = await sealSnapshot(keys, 3, snapshot);
    // A relay that replays version 3's payload as if it were version 4 fails
    // the auth check: the version is authenticated data.
    await expect(openSnapshot(keys, 4, blob)).resolves.toBeNull();
    await expect(openSnapshot(keys, 2, blob)).resolves.toBeNull();
  });

  it('refuses another channel and a wrong phrase', async () => {
    const blob = await sealSnapshot(keys, 1, snapshot);
    await expect(openSnapshot(otherSaltKeys, 1, blob)).resolves.toBeNull();
    const wrongPhrase = await deriveSyncKeys(OTHER_PASSPHRASE, salt);
    await expect(openSnapshot(wrongPhrase, 1, blob)).resolves.toBeNull();
  });

  it('returns null, rather than throwing, on tampered ciphertext', async () => {
    const blob = await sealSnapshot(keys, 1, snapshot);
    const tampered = { ...blob, ct: `A${blob.ct.slice(1)}` };
    await expect(openSnapshot(keys, 1, tampered)).resolves.toBeNull();
    await expect(openSnapshot(keys, 1, { v: 1, iv: blob.iv, ct: 'not-base64!!' })).resolves.toBeNull();
  });
});

describe('sync code', () => {
  it('generates a high-entropy phrase with a readable alphabet', () => {
    const phrase = randomPassphrase();
    // Crockford base32: no I, L, O or U — the four letters people mistype.
    expect(phrase).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    for (const char of phrase.replace(/-/g, '')) {
      expect('ILOU'.includes(char)).toBe(false);
    }
    expect(randomPassphrase()).not.toBe(phrase);
  });

  it('accepts a salt retyped in lower case (case must not change the channel)', async () => {
    const parsed = parseSyncCode(formatSyncCode(salt, PASSPHRASE).toLowerCase());
    expect(parsed).not.toBeNull();
    const fromLowered = await deriveSyncKeys(parsed!.passphrase, parsed!.saltB64);
    expect(fromLowered.channelId).toBe(keys.channelId);
    expect(fromLowered.writeToken).toBe(keys.writeToken);
  });

  it('round-trips and tolerates what a human retypes', () => {
    const code = formatSyncCode(salt, PASSPHRASE);
    expect(parseSyncCode(code)).toEqual({ saltB64: salt, passphrase: PASSPHRASE });
    expect(parseSyncCode(`  ${code}  `)).not.toBeNull();
    // Case and the Crockford confusables (O → 0) are folded, not trusted.
    expect(parseSyncCode(code.toLowerCase())).toEqual({ saltB64: salt, passphrase: PASSPHRASE });
    expect(parseSyncCode(`bsc1.${salt}.${PASSPHRASE.replace(/O/g, '0')}`)).toEqual({
      saltB64: salt,
      passphrase: PASSPHRASE,
    });
  });

  it('rejects malformed codes instead of deriving a wrong key', () => {
    expect(parseSyncCode('')).toBeNull();
    expect(parseSyncCode('BCP1.only.two')).toBeNull();
    expect(parseSyncCode(`BSC9.${salt}.${PASSPHRASE}`)).toBeNull();
    expect(parseSyncCode(`BSC1.trop-court.${PASSPHRASE}`)).toBeNull();
    expect(parseSyncCode(`BSC1.${salt}.ABC`)).toBeNull();
    // A salt of the wrong length would silently derive another channel.
    expect(parseSyncCode(`BSC1.${newSyncSalt()}AAAA.${PASSPHRASE}`)).toBeNull();
  });
});
