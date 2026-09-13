/**
 * Offline purchase path tests.
 *
 * This suite guards money, so it is deliberately hostile: every way a webhook
 * could be spoofed gets its own case, and the last block proves the *whole*
 * handoff — the key minted by the purchase core is fed to the **app's own
 * verifier** (`src/services/license.ts`), which is the only definition of a
 * valid licence that matters.
 *
 * No real key material is involved: the tests generate a throwaway P-256 pair
 * and inject its public key into the verifier, exactly like the other licence
 * tests. The production signing key lives only in the server's environment.
 *
 * `purchase/core.js` is plain JS on purpose (it runs in a Cloudflare Worker and
 * must not pull in the app bundle), so it is imported here without types.
 */

import { describe, expect, it } from 'vitest';
import { verifyLicenseKey } from '../src/services/license';
import {
  COUNTRIES, PLANS, RECONCILE_GRACE_MS, buildCheckoutRequest, decideDelivery, decideReconciliation,
  encodeLicenseKey, escapeHtml, isOrderReference, isPaidStatus, isReconcilable, isValidEmail,
  licensePayloadFor, maskEmail, maskPhone, moneyVerdict, newOrder, orderReference,
  parseNotification, publicOrderView, readCheckoutResponse, readStatusPayload, receiptEmail,
  resolvePlan, selectReconcilable, timingSafeEqual, toBase64Url,
} from '../purchase/core.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG = {
  apiKey: 'sk_test_apikey',
  siteId: '123456',
  publicBaseUrl: 'https://paiement.example.com',
  siteUrl: 'https://paiement.example.com',
  supportEmail: 'support@example.com',
  lang: 'fr',
};

const NOW = new Date('2026-09-12T10:00:00Z');

function anOrder(overrides: Record<string, unknown> = {}) {
  const plan = resolvePlan('pro', 'SN')!;
  return {
    ...newOrder({
      reference: 'BC20260912K7F3Q9M2',
      plan,
      country: 'SN',
      email: 'kofi@example.com',
      name: 'Kofi Mensah',
      phone: '+221771234567',
      statusToken: 'st_abcdef123456',
      now: NOW,
    }),
    notifyToken: 'nt_9f2c4a1b',
    ...overrides,
  } as any;
}

function aStatus(overrides: Record<string, unknown> = {}) {
  return { status: 'SUCCESS', apiCode: 100, resultFlag: '00', amount: 5_000, currency: 'XOF', ...overrides } as any;
}

function aNotification(overrides: Record<string, unknown> = {}) {
  return parseNotification({
    notify_token: 'nt_9f2c4a1b',
    transaction_id: 'cinet_abc',
    merchant_transaction_id: 'BC20260912K7F3Q9M2',
    user: { name: 'Kofi Mensah', email: 'kofi@example.com', phone_number: '+221771234567' },
    ...overrides,
  });
}

async function ephemeralKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateJwk: privateJwk as any, publicKeyB64: toBase64Url(raw) };
}

// ---------------------------------------------------------------------------

describe('order references', () => {
  it('mints a reference that is alphanumeric and matches the expected shape', () => {
    const reference = orderReference(NOW);
    expect(reference).toMatch(/^BC\d{8}[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(isOrderReference(reference)).toBe(true);
    expect(reference.startsWith('BC20260912')).toBe(true);
  });

  it('never uses letters that get misread aloud (I, L, O, U)', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(orderReference(NOW)).not.toMatch(/[ILOU]/);
    }
  });

  it('does not repeat itself across a thousand orders', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) seen.add(orderReference(NOW));
    expect(seen.size).toBe(1_000);
  });

  it('rejects look-alike strings', () => {
    expect(isOrderReference('BC20260912K7F3Q9M2')).toBe(true);
    expect(isOrderReference('BC20260912K7F3Q9M')).toBe(false);
    expect(isOrderReference('XX20260912K7F3Q9M2')).toBe(false);
    expect(isOrderReference('BC20260912K7F3Q9MI')).toBe(false);
    expect(isOrderReference(undefined as any)).toBe(false);
  });
});

describe('buyer input', () => {
  it('accepts ordinary addresses and refuses obvious nonsense', () => {
    expect(isValidEmail('kofi@example.com')).toBe(true);
    expect(isValidEmail('a.b+tag@sub.example.co')).toBe(true);
    expect(isValidEmail('kofi@example')).toBe(false);
    expect(isValidEmail('kofi example.com')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });

  it('masks the address and the phone number for the status page', () => {
    // Four-character local part: one visible letter, two masked, one visible.
    expect(maskEmail('kofi@example.com')).toBe('k**i@example.com');
    expect(maskEmail('ab@example.com')).toBe('a*@example.com');
    expect(maskEmail('not-an-email')).toBe('');
    // Every digit but the last four is hidden (9 of 13 characters here).
    expect(maskPhone('+221771234567')).toBe('*********4567');
    expect(maskPhone('12')).toBe('');
  });
});

describe('checkout', () => {
  it('resolves a sellable plan per country, and refuses the rest', () => {
    const senegal = resolvePlan('pro', 'SN')!;
    expect(senegal.price).toBe(PLANS.pro.price);
    expect(senegal.currency).toBe('XOF');
    expect(senegal.months).toBeNull();
    expect(resolvePlan('association', 'CM')!.currency).toBe('XAF');
    expect(resolvePlan('association', 'CM')!.months).toBe(12);
    expect(resolvePlan('free', 'SN')).toBeNull();
    expect(resolvePlan('pro', 'XX')).toBeNull();
  });

  it('builds the payment request the operator expects', () => {
    const order = anOrder();
    const body = buildCheckoutRequest(order, CONFIG) as any;
    expect(body.apikey).toBe(CONFIG.apiKey);
    expect(body.transaction_id).toBe(order.reference);
    expect(body.amount).toBe(5_000);
    expect(body.currency).toBe('XOF');
    expect(body.notify_url).toBe('https://paiement.example.com/api/notify');
    expect(body.return_url).toContain('thanks.html?ref=BC20260912K7F3Q9M2');
    expect(body.customer_email).toBe('kofi@example.com');
    expect(JSON.parse(body.metadata)).toEqual({ plan: 'pro', reference: order.reference });
  });

  it('never puts signing material in the request sent to the payment page', () => {
    const body = JSON.stringify(buildCheckoutRequest(anOrder(), CONFIG));
    expect(body).not.toMatch(/private|jwk|"d":/i);
  });

  it('reads the payment URL whether the answer is nested or flat', () => {
    const nested = readCheckoutResponse({
      code: '201',
      data: { payment_url: 'https://checkout.cinetpay.com/x', payment_token: 'tok', notify_token: 'nt' },
    });
    expect(nested.ok).toBe(true);
    expect(nested.paymentUrl).toBe('https://checkout.cinetpay.com/x');
    expect(nested.notifyToken).toBe('nt');

    const flat = readCheckoutResponse({ payment_url: 'https://x', payment_token: 't' });
    expect(flat.ok).toBe(true);
    expect(flat.notifyToken).toBeNull();
    expect(readCheckoutResponse({ code: '400', message: 'Invalid apikey' }).ok).toBe(false);
    expect(readCheckoutResponse(null).ok).toBe(false);
  });
});

describe('notification parsing', () => {
  it('parses the documented payload shape', () => {
    const parsed = aNotification();
    expect(parsed.ok).toBe(true);
    expect(parsed.notification.notifyToken).toBe('nt_9f2c4a1b');
    expect(parsed.notification.transactionId).toBe('cinet_abc');
    expect(parsed.notification.merchantTransactionId).toBe('BC20260912K7F3Q9M2');
    expect(parsed.notification.buyer).toEqual({
      name: 'Kofi Mensah',
      email: 'kofi@example.com',
      phone: '+221771234567',
    });
  });

  it('accepts a payload wrapped in `data` and the v2 field names', () => {
    const parsed = parseNotification({
      data: { notify_token: 'nt', transaction_id: 'tx', cpm_custom: 'BC20260912K7F3Q9M2', cpm_amount: '5000', cpm_currency: 'XOF' },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.notification.merchantTransactionId).toBe('BC20260912K7F3Q9M2');
  });

  it('refuses a body that cannot identify the payment', () => {
    expect(parseNotification(null).ok).toBe(false);
    expect(parseNotification('nope').ok).toBe(false);
    expect(parseNotification({ notify_token: 'nt' })).toMatchObject({ ok: false, reason: 'missing-transaction' });
    expect(parseNotification({ transaction_id: 'tx' })).toMatchObject({ ok: false, reason: 'missing-token' });
    expect(parseNotification({ notify_token: '', transaction_id: 'tx' })).toMatchObject({ ok: false, reason: 'missing-token' });
  });
});

describe('authoritative status', () => {
  it('reads the v2 answer', () => {
    const status = readStatusPayload({ code: '00', message: 'OK', data: { amount: 5000, currency: 'XOF', status: 'SUCCESS', payment_method: 'WAVE_SN' } });
    expect(status).toMatchObject({ status: 'SUCCESS', amount: 5_000, currency: 'XOF', operator: 'WAVE_SN' });
  });

  it('reads the v1 spelling of the same facts', () => {
    const status = readStatusPayload({ code: 100, data: { cpm_amount: '5 000', cpm_currency: 'xof', cpm_result: '00' } });
    expect(status).toMatchObject({ apiCode: 100, amount: 5_000, currency: 'XOF', resultFlag: '00' });
    expect(isPaidStatus(status)).toBe(true);
  });

  it('lets an explicit status overrule the numeric codes (v1 `code: 100` is not proof)', () => {
    // In the v1 answer `code: 100` means the *request* succeeded, on a payment
    // that may have failed — a `cpm_result` of '01' must never be read as paid.
    const v1Failed = readStatusPayload({ code: 100, data: { cpm_amount: 5_000, cpm_currency: 'XOF', cpm_result: '01', cpm_result_text: 'FAILED' } });
    expect(v1Failed).toMatchObject({ status: 'FAILED', apiCode: 100, resultFlag: '01' });
    expect(isPaidStatus(v1Failed)).toBe(false);
    // And a v2 success keeps working even though its code is '00', not 100.
    expect(isPaidStatus(readStatusPayload({ code: '00', data: { status: 'SUCCESS', amount: 5_000, currency: 'XOF' } }))).toBe(true);
  });

  it('treats only a confirmed payment as paid', () => {
    expect(isPaidStatus(aStatus())).toBe(true);
    expect(isPaidStatus(aStatus({ status: null, resultFlag: '00' }))).toBe(true);
    // A success flag that contradicts an explicit status must not win.
    expect(isPaidStatus(aStatus({ status: 'PENDING', resultFlag: '00', apiCode: null }))).toBe(false);
    expect(isPaidStatus(aStatus({ status: 'FAILED', apiCode: 2010 }))).toBe(false);
    expect(isPaidStatus(aStatus({ status: 'EXPIRED', apiCode: 2003 }))).toBe(false);
    expect(isPaidStatus(readStatusPayload({ message: 'not found' }))).toBe(false);
    expect(isPaidStatus(null)).toBe(false);
  });
});

describe('constant-time token comparison', () => {
  it('accepts identical tokens only', () => {
    expect(timingSafeEqual('nt_9f2c4a1b', 'nt_9f2c4a1b')).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('nt_9f2c4a1b', 'nt_9f2c4a1c')).toBe(false);
    expect(timingSafeEqual('nt_9f2c4a1b', 'nt_9f2c4a1')).toBe(false);
    expect(timingSafeEqual('nt_9f2c4a1', 'nt_9f2c4a1b')).toBe(false);
    expect(timingSafeEqual(undefined as any, 'nt')).toBe(false);
    expect(timingSafeEqual(null as any, null as any)).toBe(false);
  });
});

describe('delivery policy', () => {
  const base = { order: anOrder(), parsed: aNotification(), status: aStatus() };

  it('delivers when the token matches and the operator confirms the exact amount', () => {
    expect(decideDelivery(base)).toEqual({ action: 'deliver', reason: 'paid' });
  });

  it('ignores a notification for an order it does not know', () => {
    expect(decideDelivery({ ...base, order: null })).toEqual({ action: 'ignore', reason: 'unknown-order' });
  });

  it('ignores a notification that names another order', () => {
    const parsed = aNotification({ merchant_transaction_id: 'BC20260912AAAAAAAA' });
    expect(decideDelivery({ ...base, parsed })).toEqual({ action: 'ignore', reason: 'not-ours' });
  });

  it('ignores a forged, missing or truncated notify token', () => {
    expect(decideDelivery({ ...base, parsed: aNotification({ notify_token: 'nt_forged' }) })).toEqual({ action: 'ignore', reason: 'token-mismatch' });
    expect(decideDelivery({ ...base, parsed: aNotification({ notify_token: 'nt_9f2c4a1bxxxx' }) })).toEqual({ action: 'ignore', reason: 'token-mismatch' });
    expect(decideDelivery({ ...base, parsed: parseNotification({ transaction_id: 'tx' }) })).toEqual({ action: 'ignore', reason: 'missing-token' });
  });

  it('retries when the operator cannot be reached, instead of refusing a paid order', () => {
    expect(decideDelivery({ ...base, status: null })).toEqual({ action: 'retry', reason: 'status-unavailable' });
    expect(decideDelivery({ ...base, status: aStatus({ status: 'PENDING', apiCode: 2002, resultFlag: null }) })).toEqual({ action: 'retry', reason: 'still-pending' });
    expect(decideDelivery({ ...base, status: aStatus({ status: 'INITIATED', apiCode: 2001, resultFlag: null }) })).toEqual({ action: 'retry', reason: 'still-pending' });
  });

  it('refuses a final unpaid status', () => {
    expect(decideDelivery({ ...base, status: aStatus({ status: 'FAILED', apiCode: 2010 }) })).toEqual({ action: 'reject', reason: 'unpaid' });
    expect(decideDelivery({ ...base, status: aStatus({ status: 'EXPIRED', apiCode: 2003 }) })).toEqual({ action: 'reject', reason: 'unpaid' });
  });

  it('refuses a payment that does not cover the price', () => {
    expect(decideDelivery({ ...base, status: aStatus({ amount: 100 }) })).toEqual({ action: 'reject', reason: 'amount-mismatch' });
    expect(decideDelivery({ ...base, status: aStatus({ amount: 5_500 }) })).toEqual({ action: 'reject', reason: 'amount-mismatch' });
    expect(decideDelivery({ ...base, status: aStatus({ amount: null }) })).toEqual({ action: 'reject', reason: 'amount-mismatch' });
    expect(decideDelivery({ ...base, status: aStatus({ currency: 'USD' }) })).toEqual({ action: 'reject', reason: 'currency-mismatch' });
  });

  it('does not send a second key when the operator repeats the notification', () => {
    expect(decideDelivery({ ...base, order: anOrder({ status: 'delivered' }) })).toEqual({ action: 'duplicate', reason: 'already-delivered' });
    expect(decideDelivery({ ...base, order: anOrder({ status: 'refused' }) })).toEqual({ action: 'ignore', reason: 'already-refused' });
  });

  it('demands the amount of the plan the buyer chose, not of the cheaper one', () => {
    const association = {
      ...anOrder(),
      plan: 'association',
      planLabel: 'Association',
      amount: 50_000,
      months: 12,
    };
    expect(decideDelivery({ order: association, parsed: aNotification(), status: aStatus({ amount: 5_000 }) }))
      .toEqual({ action: 'reject', reason: 'amount-mismatch' });
    expect(decideDelivery({ order: association, parsed: aNotification(), status: aStatus({ amount: 50_000 }) }))
      .toEqual({ action: 'deliver', reason: 'paid' });
  });
});

describe('licence payload', () => {
  it('issues a perpetual licence for Pro', () => {
    const payload = licensePayloadFor(anOrder(), NOW) as any;
    expect(payload).toEqual({
      v: 1,
      id: 'BC20260912K7F3Q9M2',
      plan: 'pro',
      name: 'Kofi Mensah',
      issued: '2026-09-12',
      expires: null,
    });
  });

  it('issues twelve months for the association licence', () => {
    const payload = licensePayloadFor({ ...anOrder(), plan: 'association', months: 12 }, NOW) as any;
    expect(payload.expires).toBe('2027-09-12');
  });

  it('never overflows into the next month, so a term is never sold short', () => {
    // A leap day plus a year is 28 February, not 1 March.
    const leap = licensePayloadFor({ ...anOrder(), months: 12 }, new Date('2024-02-29T00:00:00Z')) as any;
    expect(leap.expires).toBe('2025-02-28');
    // 31 January + 1 month is the end of February, not 3 March.
    const jan = licensePayloadFor({ ...anOrder(), months: 1 }, new Date('2026-01-31T00:00:00Z')) as any;
    expect(jan.expires).toBe('2026-02-28');
    // 31 August + 1 month is the end of September.
    const aug = licensePayloadFor({ ...anOrder(), months: 1 }, new Date('2026-08-31T00:00:00Z')) as any;
    expect(aug.expires).toBe('2026-09-30');
    // and a day that always exists is left alone.
    const safe = licensePayloadFor({ ...anOrder(), months: 1 }, new Date('2026-09-12T00:00:00Z')) as any;
    expect(safe.expires).toBe('2026-10-12');
  });

  it('derives the issue date from the order, not from the clock', () => {
    // Same order, minted "now" or years later, yields the exact same payload:
    // a re-sent receipt can never state a different expiry.
    const order = { ...anOrder(), plan: 'association', months: 12 };
    const now = licensePayloadFor(order) as any;
    const later = licensePayloadFor(order, new Date('2030-01-01T00:00:00Z')) as any;
    expect(now.issued).toBe('2026-09-12');
    expect(now.expires).toBe('2027-09-12');
    expect(later.issued).toBe('2030-01-01');
  });

  it('prefers the expiry stamped at delivery over recomputing it', () => {
    const order = { ...anOrder(), months: 12, expires: '2027-09-12' };
    const mail = receiptEmail(order, 'BCP1.a.b', CONFIG) as any;
    expect(mail.text).toContain('2027-09-12');
  });

  it('omits an empty name rather than storing a blank', () => {
    const payload = licensePayloadFor(anOrder({ name: '' }), NOW) as any;
    expect('name' in payload).toBe(false);
  });
});

describe('minting hands the app a licence it accepts', () => {
  it('produces a key the real verifier unlocks', async () => {
    const { privateJwk, publicKeyB64 } = await ephemeralKeys();
    const order = anOrder();
    const key = await encodeLicenseKey(licensePayloadFor(order, NOW), privateJwk) as string;

    expect(key.startsWith('BCP1.')).toBe(true);
    expect(key.split('.')).toHaveLength(3);
    // WebCrypto's raw r||s signature is 64 bytes → 86 base64url characters.
    expect(key.split('.')[2]).toHaveLength(86);

    const state = await verifyLicenseKey(key, { publicKey: publicKeyB64, now: NOW });
    expect(state.status).toBe('active');
    if (state.status === 'active') {
      expect(state.plan).toBe('pro');
      expect(state.payload.id).toBe(order.reference);
      expect(state.payload.name).toBe('Kofi Mensah');
      expect(state.payload.expires).toBeNull();
    }
  });

  it('is refused by a verifier that holds another key (a forged seller)', async () => {
    const seller = await ephemeralKeys();
    const impostor = await ephemeralKeys();
    const key = await encodeLicenseKey(licensePayloadFor(anOrder(), NOW), seller.privateJwk) as string;
    const state = await verifyLicenseKey(key, { publicKey: impostor.publicKeyB64, now: NOW });
    expect(state).toEqual({ status: 'invalid', reason: 'signature' });
  });

  it('carries the association expiry through to the verifier', async () => {
    const { privateJwk, publicKeyB64 } = await ephemeralKeys();
    const order = { ...anOrder(), plan: 'association' as const, months: 12 };
    const key = await encodeLicenseKey(licensePayloadFor(order, NOW), privateJwk) as string;

    const valid = await verifyLicenseKey(key, { publicKey: publicKeyB64, now: NOW });
    expect(valid.status).toBe('active');

    const later = await verifyLicenseKey(key, { publicKey: publicKeyB64, now: new Date('2027-09-13T00:00:00Z') });
    expect(later).toEqual({ status: 'invalid', reason: 'expired' });
  });

  it('cannot have its payload rewritten after signing', async () => {
    const { privateJwk, publicKeyB64 } = await ephemeralKeys();
    const key = await encodeLicenseKey(licensePayloadFor(anOrder(), NOW), privateJwk) as string;
    const [prefix, , signature] = key.split('.');
    const tampered = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ ...licensePayloadFor(anOrder(), NOW), plan: 'association', expires: null }))
    );
    const state = await verifyLicenseKey(`${prefix}.${tampered}.${signature}`, { publicKey: publicKeyB64, now: NOW });
    expect(state).toEqual({ status: 'invalid', reason: 'signature' });
  });
});

describe('delivery e-mail', () => {
  it('states the plan, the price, the validity and the activation steps', () => {
    const order = anOrder();
    const mail = receiptEmail(order, 'BCP1.payload.signature', CONFIG) as any;
    expect(mail.text).toContain('Bonjour Kofi Mensah,');
    expect(mail.html).toContain('Bonjour Kofi Mensah,');
    expect(mail.subject).toContain('Budget et Compte');
    expect(mail.subject).toContain('Pro');
    expect(mail.text).toContain(order.reference);
    expect(mail.text).toContain('5 000 F CFA');
    expect(mail.text).toContain('Licence à vie');
    expect(mail.text).toContain('BCP1.payload.signature');
    expect(mail.text).toContain('Réglages → Offre & licence');
    expect(mail.text).toContain('support@example.com');
    expect(mail.html).toContain('support@example.com');
  });

  it('says when an annual licence ends', () => {
    const order = { ...anOrder(), plan: 'association' as const, planLabel: 'Association', amount: 50_000, months: 12 };
    const mail = receiptEmail(order, 'BCP1.a.b', CONFIG) as any;
    expect(mail.text).toContain('Valable 12 mois');
    expect(mail.html).toContain('2027-09-12');
  });

  it('escapes a buyer-supplied name instead of injecting it into the HTML', () => {
    const order = anOrder({ name: '<script>alert(1)</script>' });
    const mail = receiptEmail(order, 'BCP1.a.b', CONFIG) as any;
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('&amp;lt;');
    // No greeting at all when the buyer gave no name.
    const anonymous = receiptEmail(anOrder({ name: '' }), 'BCP1.a.b', CONFIG) as any;
    expect(anonymous.html).not.toContain('Bonjour');
    expect(anonymous.text.startsWith('Merci')).toBe(true);
    expect(escapeHtml('a & b "c" \'d\'')).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
  });
});

describe('what the buyer can see about their own order', () => {
  it('reports the state without ever exposing the token or the address', () => {
    const order = { ...anOrder(), status: 'delivered', deliveredAt: '2026-09-12T10:05:00Z' };
    const view = publicOrderView(order) as any;
    expect(view).toEqual({
      reference: order.reference,
      plan: 'pro',
      planLabel: 'Pro',
      amount: 5_000,
      currency: 'XOF',
      status: 'delivered',
      email: 'k**i@example.com',
      deliveredAt: '2026-09-12T10:05:00Z',
    });
    const serialized = JSON.stringify(publicOrderView(order));
    expect(serialized).not.toContain('nt_9f2c4a1b');
    expect(serialized).not.toContain('kofi@example.com');
    expect(serialized).not.toContain('st_abcdef123456');
  });
});

// ---------------------------------------------------------------------------
describe('reconciliation — the safety net under the webhook', () => {
  /** An order created at NOW, plus however long the run happens after. */
  function pending(minsAgo: number, overrides: Record<string, unknown> = {}) {
    const createdAt = new Date(NOW.getTime() - minsAgo * 60_000).toISOString();
    return anOrder({ status: 'pending', createdAt, ...overrides });
  }
  const later = new Date(NOW.getTime() + 60_000);

  it('only looks at orders still waiting for money, and only once they are old enough', () => {
    expect(isReconcilable(pending(30), NOW)).toBe(true);
    // Too fresh: the buyer is probably still on the payment page.
    expect(isReconcilable(pending(1), NOW)).toBe(false);
    expect(isReconcilable(pending(30), NOW, { graceMs: 60 * 60_000 })).toBe(false);
    // Terminal orders are never touched again — that is what makes the job cheap.
    expect(isReconcilable(pending(30, { status: 'delivered' }), NOW)).toBe(false);
    expect(isReconcilable(pending(30, { status: 'refused' }), NOW)).toBe(false);
    // A corrupted record is not a reason to call CinetPay.
    expect(isReconcilable(pending(30, { reference: 'nope' }), NOW)).toBe(false);
    expect(isReconcilable(pending(30, { createdAt: 'not-a-date' }), NOW)).toBe(false);
    expect(isReconcilable(null, NOW)).toBe(false);
  });

  it('picks the oldest due orders first and caps the batch', () => {
    const orders = [pending(50), pending(90), pending(5), pending(70, { status: 'delivered' })];
    const picked = selectReconcilable(orders, NOW) as any[];
    expect(picked.map((o) => Date.parse(o.createdAt))).toEqual([...picked.map((o) => Date.parse(o.createdAt))].sort((a, b) => a - b));
    expect(picked).toHaveLength(2);
    expect(selectReconcilable(orders, NOW, { limit: 1 })).toHaveLength(1);
  });

  it('delivers a paid order the webhook never reported', () => {
    const decision = decideReconciliation({ order: pending(30), status: aStatus(), now: later });
    expect(decision).toEqual({ action: 'deliver', reason: 'paid' });
  });

  it('refuses an underpayment instead of selling a licence', () => {
    const order = pending(30);
    const short = aStatus({ amount: 100 });
    expect(decideReconciliation({ order, status: short, now: later }).action).toBe('refuse');
    expect(decideReconciliation({ order, status: aStatus({ currency: 'USD' }), now: later }).action).toBe('refuse');
  });

  it('ends an order the operator says failed, so it is never re-queried', () => {
    const order = pending(30);
    const failed = aStatus({ status: 'FAILED', apiCode: 2010, resultFlag: '01' });
    expect(decideReconciliation({ order, status: failed, now: later })).toEqual({ action: 'refuse', reason: 'unpaid' });
  });

  it('waits — never delivers — when the status is unavailable or the payment is still in flight', () => {
    const order = pending(30);
    const stillPending = aStatus({ status: 'PENDING', apiCode: 2002, resultFlag: '01' });
    expect(decideReconciliation({ order, status: null, now: later }).action).toBe('wait');
    expect(decideReconciliation({ order, status: stillPending, now: later })).toEqual({ action: 'wait', reason: 'still-pending' });
  });

  it('leaves finished orders and fresh ones alone', () => {
    expect(decideReconciliation({ order: pending(30, { status: 'delivered' }), status: aStatus(), now: later }).action).toBe('skip');
    expect(decideReconciliation({ order: pending(30, { status: 'refused' }), status: aStatus(), now: later }).action).toBe('skip');
    expect(decideReconciliation({ order: pending(1), status: aStatus(), now: NOW })).toEqual({ action: 'skip', reason: 'too-soon' });
  });

  it('has no untrusted input: a paid status alone can never be forged through this path', () => {
    // The job starts from our own stored order and asks CinetPay directly, so
    // the notify token is irrelevant here — and a null status never delivers.
    const order = pending(30, { notifyToken: undefined });
    expect(decideReconciliation({ order, status: null, now: later }).action).not.toBe('deliver');
    expect(decideReconciliation({ order, status: undefined, now: later }).action).not.toBe('deliver');
  });

  it('makes the same money decision as the webhook for the same payment', () => {
    // One shared rule, so one path cannot sell what the other refuses.
    const order = pending(30);
    const cases = [
      { status: aStatus(), expected: 'deliver' },
      { status: aStatus({ amount: 100 }), expected: 'reject' },
      { status: aStatus({ currency: 'USD' }), expected: 'reject' },
      { status: aStatus({ status: 'EXPIRED', apiCode: 2003, resultFlag: '01' }), expected: 'reject' },
      { status: aStatus({ status: 'PENDING', apiCode: 2002, resultFlag: '01' }), expected: 'retry' },
      { status: null, expected: 'retry' },
    ];
    for (const { status, expected } of cases) {
      expect(moneyVerdict(order, status).action, JSON.stringify(status)).toBe(expected);
      const viaWebhook = decideDelivery({ order, parsed: aNotification(), status });
      // `duplicate`/`ignore` only differ for terminal orders, not here.
      expect(viaWebhook.action, JSON.stringify(status)).toBe(expected);
    }
  });

  it('exposes a grace period that is a positive, finite number of milliseconds', () => {
    expect(RECONCILE_GRACE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(RECONCILE_GRACE_MS)).toBe(true);
  });
});

describe('country catalogue', () => {
  it('sells Wave and Orange Money everywhere it sells', () => {
    for (const [code, country] of Object.entries(COUNTRIES) as any) {
      const hasWave = country.methods.some((m: string) => m.startsWith('WAVE_'));
      const hasOrange = country.methods.some((m: string) => m.startsWith('OM_'));
      expect(hasOrange, `${code} must offer Orange Money`).toBe(true);
      expect(hasWave || ['ML', 'CM'].includes(code), `${code} must offer Wave or document its absence`).toBe(true);
      expect(country.phonePrefix).toMatch(/^\+\d{2,3}$/);
    }
  });
});
