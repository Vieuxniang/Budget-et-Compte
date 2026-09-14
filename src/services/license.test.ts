/**
 * License verification is the one piece of the paywall that has to be right:
 * a forged or altered key must never unlock Pro, and a valid one must verify
 * with no network. The tests sign with ECDSA P-256 keypairs generated on the
 * spot and pass the matching public key explicitly, so the repo never contains
 * a usable license (the embedded public key only ever proves authenticity).
 * The end-to-end check with the real private key is the documented procedure
 * in .freebuff/run.md: mint a key, paste it into Réglages → Offre.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  savingsGoalLimit, tontineGroupLimit, tontineMemberLimit,
  verifyLicenseKey, parseLicenseKey, getStoredLicense, saveLicense,
  subscribeLicense, isInvalidReason, isRevokedId, LICENSE_PREFIX, LICENSE_PUBLIC_KEY,
  ECDSA_PUBLIC_KEY_BYTES,
} from './license';
import revocations from './revocations.json';
import { fromBase64Url, toBase64Url } from './crypto';

/** base64url of a UTF-8 string — no Buffer, so no @types/node needed. */
const encode = (text: string) => toBase64Url(new TextEncoder().encode(text));

interface Signer {
  publicKeyB64: string;
  sign: (payload: Record<string, unknown>) => Promise<string>;
}

async function makeSigner(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKeyB64: toBase64Url(rawPublic),
    sign: async (payload) => {
      const payloadB64 = encode(JSON.stringify(payload));
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new TextEncoder().encode(payloadB64)
        )
      );
      return `${LICENSE_PREFIX}.${payloadB64}.${toBase64Url(signature)}`;
    },
  };
}

const proPayload = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  id: 'lic_test01',
  plan: 'pro',
  name: 'Famille Test',
  issued: '2026-09-12',
  expires: null,
  ...overrides,
});

let signer: Signer;
let otherSigner: Signer;

beforeAll(async () => {
  signer = await makeSigner();
  otherSigner = await makeSigner();
});

const verifyWith = (key: string, now?: Date) =>
  verifyLicenseKey(key, { publicKey: signer.publicKeyB64, now });

describe('verifyLicenseKey', () => {
  it('accepts a correctly signed key and returns its payload', async () => {
    const state = await verifyWith(await signer.sign(proPayload()));
    expect(state.status).toBe('active');
    if (state.status !== 'active') throw new Error('expected an active license');
    expect(state.plan).toBe('pro');
    expect(state.payload.id).toBe('lic_test01');
    expect(state.payload.name).toBe('Famille Test');
  });

  it('reports no license as free, not as an error', async () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(await verifyWith(empty as unknown as string)).toEqual({ status: 'free' });
    }
  });

  it('rejects a payload that was altered after signing', async () => {
    const key = await signer.sign(proPayload());
    const [, , signature] = key.split('.');
    const forgedPayload = encode(
      JSON.stringify(proPayload({ expires: '2099-12-31', id: 'lic_stolen' }))
    );
    const state = await verifyWith(`${LICENSE_PREFIX}.${forgedPayload}.${signature}`);
    expect(state).toEqual({ status: 'invalid', reason: 'signature' });
  });

  it('rejects a key signed by someone else', async () => {
    const state = await verifyWith(await otherSigner.sign(proPayload()));
    expect(state).toEqual({ status: 'invalid', reason: 'signature' });
  });

  it('rejects a key whose signature bytes were tampered with', async () => {
    const key = await signer.sign(proPayload());
    const [prefix, payload, signature] = key.split('.');
    const flipped = fromBase64Url(signature);
    flipped[0] ^= 0xff;
    const state = await verifyWith(`${prefix}.${payload}.${toBase64Url(flipped)}`);
    expect(state).toEqual({ status: 'invalid', reason: 'signature' });
  });

  it('expires a dated license, and only after its last day', async () => {
    const key = await signer.sign(proPayload({ expires: '2026-12-31' }));
    expect((await verifyWith(key, new Date('2026-12-31T10:00:00Z'))).status).toBe('active');
    expect(await verifyWith(key, new Date('2027-01-01T00:00:01Z'))).toEqual({
      status: 'invalid', reason: 'expired',
    });
  });

  it('never lets a tampered expiry buy extra time', async () => {
    // Signature first: the payload below is unsigned, so the reason is the
    // signature, not the (undetectably changed) date.
    const key = await signer.sign(proPayload({ expires: '2020-01-01' }));
    const [, payload, signature] = key.split('.');
    const forged = encode(JSON.stringify(proPayload({ expires: '2099-12-31' })));
    expect(await verifyWith(`${LICENSE_PREFIX}.${forged}.${signature}`, new Date('2030-01-01')))
      .toEqual({ status: 'invalid', reason: 'signature' });
    // …and the genuine key is simply expired.
    expect(await verifyWith(key, new Date('2030-01-01')))
      .toEqual({ status: 'invalid', reason: 'expired' });
    expect(payload.length).toBeGreaterThan(10);
  });

  it('rejects malformed keys instead of throwing', async () => {
    const broken = ['nope', 'BCP1', 'BCP1.only-two', 'XXX.aaa.bbb', 'BCP1.!!!.!!!', 'BCP1.a.b.c'];
    for (const key of broken) {
      const state = await verifyWith(key);
      expect(state.status).toBe('invalid');
    }
  });

  it('rejects an unknown payload version and an unknown plan', async () => {
    expect(await verifyWith(await signer.sign(proPayload({ v: 2 }))))
      .toEqual({ status: 'invalid', reason: 'format' });
    expect(await verifyWith(await signer.sign(proPayload({ plan: 'free' }))))
      .toEqual({ status: 'invalid', reason: 'unsupported' });
  });

  it('accepts the association plan, which unlocks the group module', async () => {
    const state = await verifyWith(await signer.sign(proPayload({ plan: 'association' })));
    expect(state).toMatchObject({ status: 'active', plan: 'association' });
  });

  it('rejects a signed payload with an unreadable expiry date', async () => {
    expect(await verifyWith(await signer.sign(proPayload({ expires: '31/12/2026' }))))
      .toEqual({ status: 'invalid', reason: 'payload' });
  });

  it('revokes a key by id even though its signature is perfectly valid', async () => {
    // The dry-run demo key whose text was published during the sale rehearsal.
    const key = await signer.sign(proPayload({ id: 'lic_dryrun_demo' }));
    expect(await verifyWith(key)).toEqual({ status: 'invalid', reason: 'revoked' });
    // An unlisted id verifies as before — the list refuses, it never doubts.
    const live = await verifyWith(await signer.sign(proPayload({ id: 'lic_other' })));
    expect(live.status).toBe('active');
  });

  it('checks revocation after the signature, so forgery still reports as forgery', async () => {
    const key = await signer.sign(proPayload({ id: 'lic_dryrun_demo' }));
    const [, , signature] = key.split('.');
    const forged = encode(JSON.stringify(proPayload({ id: 'lic_innocent' })));
    expect(await verifyWith(`${LICENSE_PREFIX}.${forged}.${signature}`))
      .toEqual({ status: 'invalid', reason: 'signature' });
  });

  it('embeds a shape-checked revocation list', () => {
    expect(revocations.v).toBe(1);
    expect(Array.isArray(revocations.revoked)).toBe(true);
    for (const id of revocations.revoked) {
      expect(typeof id).toBe('string');
      expect(id.startsWith('lic_')).toBe(true);
      expect(isRevokedId(id)).toBe(true);
    }
    expect(isRevokedId('lic_never_issued')).toBe(false);
  });

  it('ignores surrounding whitespace (keys get pasted by hand)', async () => {
    const key = await signer.sign(proPayload());
    expect((await verifyWith(`  ${key}\n`)).status).toBe('active');
  });

  it('blames the platform, not the key, when verification is impossible at all', async () => {
    // A 9-byte "public key" cannot be imported as a P-256 point: importKey
    // throws, which is the same path an engine without P-256 would take, so the
    // message stays actionable instead of accusing the customer's key.
    const state = await verifyLicenseKey(await signer.sign(proPayload()), {
      publicKey: toBase64Url(new Uint8Array(9)),
    });
    expect(state).toEqual({ status: 'invalid', reason: 'unavailable' });
  });

  it('ships an embedded public key that is a real uncompressed P-256 point', () => {
    const raw = fromBase64Url(LICENSE_PUBLIC_KEY);
    expect(raw).toHaveLength(ECDSA_PUBLIC_KEY_BYTES);
    expect(raw[0]).toBe(0x04); // uncompressed point marker
  });
});

describe('parseLicenseKey', () => {
  it('exposes the parts without touching crypto', async () => {
    const parsed = parseLicenseKey(await signer.sign(proPayload()));
    expect(parsed?.payload.plan).toBe('pro');
    expect(parsed?.signatureB64.length).toBeGreaterThan(10);
    expect(parseLicenseKey('BCP1.nope.nope')).toBeNull();
  });

  it('validates the payload shape field by field', async () => {
    for (const broken of [{ id: 42 }, { plan: 'ultra' }, { issued: 7 }, { name: 3 }]) {
      const key = await signer.sign(proPayload(broken));
      expect(parseLicenseKey(key)).toBeNull();
    }
  });
});

describe('feature gates', () => {
  it('allows one savings goal for free and many for pro', () => {
    expect(savingsGoalLimit('free')).toBe(1);
    expect(savingsGoalLimit('pro')).toBeGreaterThan(1);
    expect(savingsGoalLimit('association')).toBe(savingsGoalLimit('pro'));
    // The group module is paid-only, and the association plan lifts its limit.
    expect(tontineGroupLimit('free')).toBe(0);
    expect(tontineGroupLimit('pro')).toBe(1);
    expect(tontineGroupLimit('association')).toBeGreaterThan(1);
    expect(tontineMemberLimit('association')).toBeGreaterThan(tontineMemberLimit('pro'));
  });
});

describe('isInvalidReason', () => {
  it('accepts the reasons verify can report and nothing else', () => {
    for (const reason of ['format', 'signature', 'payload', 'expired', 'unsupported', 'revoked', 'unavailable']) {
      expect(isInvalidReason(reason)).toBe(true);
    }
    expect(isInvalidReason('whatever')).toBe(false);
    expect(isInvalidReason(undefined)).toBe(false);
  });
});

describe('local store', () => {
  /** Minimal localStorage so the store logic is covered without jsdom. */
  const installFakeStorage = () => {
    const map = new Map<string, string>();
    const fake = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    vi.stubGlobal('localStorage', fake);
    return map;
  };

  it('keeps the raw key, trims it, and clears it', () => {
    const map = installFakeStorage();
    saveLicense('  BCP1.a.b  ');
    expect(getStoredLicense()).toBe('BCP1.a.b');
    expect([...map.values()]).toEqual(['BCP1.a.b']);

    saveLicense(null);
    expect(getStoredLicense()).toBeNull();
    expect(map.size).toBeLessThanOrEqual(0);

    saveLicense('   ');
    expect(getStoredLicense()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    installFakeStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeLicense(listener);
    saveLicense('BCP1.x.y');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    saveLicense(null);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('degrades to null instead of throwing when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(getStoredLicense()).toBeNull();
    expect(() => saveLicense('BCP1.a.b')).not.toThrow();
    vi.unstubAllGlobals();
  });
});
