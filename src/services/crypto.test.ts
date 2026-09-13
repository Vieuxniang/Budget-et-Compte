import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, parseHashRecord, timingSafeEqual, sha256Hex,
  PBKDF2_ITERATIONS, PBKDF2_PREFIX,
} from './crypto';

describe('hashPassword record format', () => {
  it('produces a parseable pbkdf2 record', async () => {
    const record = await hashPassword('mama-ndeye-2026');
    const parts = parseHashRecord(record);
    expect(parts).not.toBeNull();
    expect(parts?.prefix).toBe(PBKDF2_PREFIX);
    expect(parts?.iterations).toBe(PBKDF2_ITERATIONS);
    expect(parts?.saltHex).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(parts?.hashHex).toMatch(/^[0-9a-f]{64}$/); // 256 bits
  });

  it('generates a fresh salt on every call', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(parseHashRecord(a)?.saltHex).not.toBe(parseHashRecord(b)?.saltHex);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const record = await hashPassword('mot-de-passe-familial');
    expect(await verifyPassword('mot-de-passe-familial', record)).toBe('ok');
  });

  it('rejects a wrong password', async () => {
    const record = await hashPassword('mot-de-passe-familial');
    expect(await verifyPassword('autre', record)).toBe('wrong-password');
  });

  it('rejects against a record from a different password', async () => {
    const a = await hashPassword('alpha');
    const b = await hashPassword('beta');
    expect(await verifyPassword('beta', a)).toBe('wrong-password');
    expect(await verifyPassword('alpha', b)).toBe('wrong-password');
  });

  it('rejects malformed or empty records', async () => {
    expect(await verifyPassword('x', undefined)).toBe('invalid-record');
    expect(await verifyPassword('x', '')).toBe('invalid-record');
    expect(await verifyPassword('x', 'garbage')).toBe('invalid-record');
    expect(await verifyPassword('x', 'pbkdf2$abc$zz$00')).toBe('invalid-record');
  });

  it('detects a matching legacy SHA-256 hash for migration', async () => {
    const legacy = await sha256Hex('ancien-mdp');
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPassword('ancien-mdp', legacy)).toBe('legacy-hash');
  });

  it('rejects a wrong password against a legacy hash', async () => {
    const legacy = await sha256Hex('ancien-mdp');
    expect(await verifyPassword('faux', legacy)).toBe('wrong-password');
  });

  it('is case-sensitive', async () => {
    const record = await hashPassword('Salarie');
    expect(await verifyPassword('salarie', record)).toBe('wrong-password');
  });
});

describe('parseHashRecord', () => {
  it('returns null for non-pbkdf2 records', () => {
    expect(parseHashRecord('sha256abcdef')).toBeNull();
    expect(parseHashRecord('')).toBeNull();
    expect(parseHashRecord('pbkdf2$0$a$b')).toBeNull(); // iterations must be > 0
    expect(parseHashRecord('pbkdf2$150000$a')).toBeNull(); // too few parts
  });
});

describe('timingSafeEqual', () => {
  it('matches identical strings and rejects different ones', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
