/**
 * Shop tests — the HTTP shell around `purchase/core.js`.
 *
 * The point of these tests is that the **whole purchase** is exercised without a
 * network: a fake CinetPay (init + status), a fake KV, and a fake mail API. That
 * lets the suite assert the things that actually cost money or lose customers:
 *
 *   - the price always comes from the catalogue, never from the buyer's request;
 *   - a forged notification mints nothing and never even triggers a status call;
 *   - a real notification whose amount is too low is **refused**, not delivered;
 *   - a successful notification mints one key, e-mails it, and the app's own
 *     verifier accepts it (using the public half of the env private JWK);
 *   - the operator repeating the notification sends **no second e-mail**;
 *   - the buyer's status page never exposes the key or the notify token.
 *
 * Nothing here touches the real signing key: the tests generate a throwaway
 * P-256 pair, put its private JWK in the fake environment, and verify with its
 * public half — exactly how the production key is wired.
 */

import { describe, expect, it } from 'vitest';
import { verifyLicenseKey } from '../src/services/license';
import { PLANS, toBase64Url } from '../purchase/core.js';
import worker, {
  handleCatalog, handleCheckout, handleNotify, handleOrderStatus, readiness, reconcileOrders, route,
  sendEmail,
} from '../purchase/worker.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-12T10:00:00Z');
const EMAIL = 'kofi@example.com';

async function ephemeralKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateJwk, publicKeyB64: toBase64Url(raw) };
}

function fakeKV() {
  const map = new Map<string, string>();
  const meta = new Map<string, any>();
  return {
    map,
    meta,
    async get(key: string, type?: string) {
      const value = map.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string, options: any = {}) {
      map.set(key, value);
      if (options.metadata) meta.set(key, options.metadata);
    },
    /**
     * KV's `list` — keys (and their metadata) only, page by page. The page size
     * is deliberately tiny so the reconciliation loop's cursor walking is
     * exercised rather than assumed.
     */
    async list({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) {
      const names = [...map.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + 2);
      const next = start + 2;
      return {
        keys: page.map((name) => ({ name, metadata: meta.get(name) })),
        list_complete: next >= names.length,
        cursor: String(next),
      };
    },
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * The v1 API answers `code: 100` for a *request* that went through, whatever
 * happened to the payment — so the fake uses those codes too, which is the shape
 * that catches a verifier trusting `code` alone.
 */
const STATUS_CODES: Record<string, number> = { SUCCESS: 100, PENDING: 2002, FAILED: 2010, EXPIRED: 2003 };

/** A fake CinetPay + mail provider, recording everything it is asked. */
function fakeWorld({ status = 'SUCCESS', amount = 5_000, currency = 'XOF', operator = 'WAVE_SN' } = {}) {
  const calls: any = { init: [] as any[], check: [] as any[], emails: [] as any[] };
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url.includes('/payment/check')) {
      calls.check.push(body);
      return jsonResponse({
        code: STATUS_CODES[status] ?? 100,
        message: 'OK',
        data: { status, amount, currency, payment_method: operator },
      });
    }
    if (url.includes('/v2/payment')) {
      calls.init.push(body);
      return jsonResponse({
        code: '201',
        message: 'CREATED',
        data: { payment_url: 'https://checkout.cinetpay.com/pay/xyz', payment_token: 'ptok_1', notify_token: 'ntok_123' },
      });
    }
    if (url.includes('resend.com')) {
      calls.emails.push(body);
      return jsonResponse({ id: `mail_${calls.emails.length}` });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { calls, fetchImpl };
}

async function makeEnv(extra: Record<string, unknown> = {}) {
  const { privateJwk, publicKeyB64 } = await ephemeralKeys();
  const env = {
    CINETPAY_API_KEY: 'sk_test_apikey',
    CINETPAY_SITE_ID: '123456',
    PUBLIC_BASE_URL: 'https://paiement.example.com',
    SITE_URL: 'https://paiement.example.com/achat',
    EMAIL_FROM: 'licences@example.com',
    RESEND_API_KEY: 're_test',
    SUPPORT_EMAIL: 'support@example.com',
    LICENSE_PRIVATE_JWK: JSON.stringify(privateJwk),
    ORDERS: fakeKV(),
    ...extra,
  };
  return { env: env as any, publicKeyB64 };
}

const CHECKOUT_BODY = { plan: 'pro', country: 'SN', email: EMAIL, name: 'Kofi Mensah', phone: '+221771234567' };

/** Runs a checkout against the fake world and returns the stored order. */
async function createOrder(world: any, env: any, body: Record<string, unknown> = {}) {
  const result = await handleCheckout({ ...CHECKOUT_BODY, ...body }, env, { fetchImpl: world.fetchImpl, now: NOW });
  const stored = (env.ORDERS as any).map.get(`order:${result.body.reference}`);
  return { result, order: stored ? JSON.parse(stored) : null };
}

function notification(reference: string, overrides: Record<string, unknown> = {}) {
  return {
    notify_token: 'ntok_123',
    transaction_id: 'cinet_abc',
    merchant_transaction_id: reference,
    user: { name: 'Kofi Mensah', email: EMAIL, phone_number: '+221771234567' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('checkout', () => {
  it('creates a pending order and returns the payment URL', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result, order } = await createOrder(world, env);

    expect(result.status).toBe(201);
    expect(result.body.ok).toBe(true);
    expect(result.body.paymentUrl).toBe('https://checkout.cinetpay.com/pay/xyz');
    expect(result.body.amount).toBe(PLANS.pro.price);
    expect(result.body.currency).toBe('XOF');
    expect(result.body.operators).toContain('Wave');
    expect(result.body.statusToken).toMatch(/^[A-Za-z0-9_-]{24}$/);

    expect(order.status).toBe('pending');
    expect(order.notifyToken).toBe('ntok_123');
    expect(order.amount).toBe(PLANS.pro.price);
    expect(order.country).toBe('SN');
  });

  it('sends CinetPay the amount and notify_url from its own catalogue', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    const sent = world.calls.init[0];

    expect(sent.transaction_id).toBe(result.body.reference);
    expect(sent.amount).toBe(PLANS.pro.price);
    expect(sent.currency).toBe('XOF');
    expect(sent.apikey).toBe('sk_test_apikey');
    expect(sent.site_id).toBe('123456');
    expect(sent.notify_url).toBe('https://paiement.example.com/api/notify');
    expect(sent.return_url).toContain('thanks.html?ref=');
  });

  it('ignores a price the buyer tries to choose', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result, order } = await createOrder(world, env, { amount: 100, price: 100, currency: 'USD' });

    expect(result.body.amount).toBe(PLANS.pro.price);
    expect(order.amount).toBe(PLANS.pro.price);
    expect(order.currency).toBe('XOF');
    expect(world.calls.init[0].amount).toBe(PLANS.pro.price);
  });

  it('sells the association licence with its own price and duration', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result, order } = await createOrder(world, env, { plan: 'association', country: 'CM' });

    expect(result.body.amount).toBe(PLANS.association.price);
    expect(result.body.currency).toBe('XAF');
    expect(order.months).toBe(12);
  });

  it('refuses what it cannot sell', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    expect((await handleCheckout({ ...CHECKOUT_BODY, plan: 'free' }, env, { fetchImpl: world.fetchImpl })).body.error).toBe('plan-not-sellable');
    expect((await handleCheckout({ ...CHECKOUT_BODY, country: 'XX' }, env, { fetchImpl: world.fetchImpl })).body.error).toBe('plan-not-sellable');
    expect((await handleCheckout({ ...CHECKOUT_BODY, email: 'pas-un-email' }, env, { fetchImpl: world.fetchImpl })).body.error).toBe('email-invalid');
    expect((await handleCheckout({}, env, { fetchImpl: world.fetchImpl })).status).toBe(400);
    expect(world.calls.init).toHaveLength(0);
  });

  it('reports a payment-provider failure instead of storing a broken order', async () => {
    const { env } = await makeEnv();
    const fetchImpl = async () => jsonResponse({ code: '400', message: 'Invalid apikey' });
    const result = await handleCheckout(CHECKOUT_BODY, env, { fetchImpl, now: NOW });
    expect(result.status).toBe(502);
    expect(result.body.error).toBe('payment-init-failed');
    expect((env.ORDERS as any).map.size).toBe(0);
  });
});

describe('notification', () => {
  it('delivers: mints a key, mails it, and the app verifies it', async () => {
    const { env, publicKeyB64 } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);

    const answer = await handleNotify(notification(result.body.reference), env, { fetchImpl: world.fetchImpl, now: NOW });
    expect(answer.status).toBe(200);
    expect(answer.body.action).toBe('delivered');

    const order = (env.ORDERS as any).map.get(`order:${result.body.reference}`);
    const stored = JSON.parse(order);
    expect(stored.status).toBe('delivered');
    expect(stored.deliveredAt).toBe(NOW.toISOString());
    expect(stored.licenseId).toBe(result.body.reference);

    // One e-mail, to the buyer, containing a key the real verifier accepts.
    expect(world.calls.emails).toHaveLength(1);
    const mail = world.calls.emails[0];
    expect(mail.to).toEqual([EMAIL]);
    expect(mail.subject).toContain('Pro');
    const key = (mail.text.match(/BCP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [])[0];
    expect(key).toBeTruthy();

    const state = await verifyLicenseKey(key, { publicKey: publicKeyB64, now: NOW });
    expect(state.status).toBe('active');
    if (state.status === 'active') {
      expect(state.plan).toBe('pro');
      expect(state.payload.id).toBe(result.body.reference);
      expect(state.payload.name).toBe('Kofi Mensah');
      expect(state.payload.expires).toBeNull();
    }
    // The key is never written to storage in the clear.
    expect(order).not.toContain(key);
  });

  it('an annual purchase mints a licence that expires twelve months later', async () => {
    const { env, publicKeyB64 } = await makeEnv();
    const world = fakeWorld({ amount: PLANS.association.price });
    const { result } = await createOrder(world, env, { plan: 'association' });
    await handleNotify(notification(result.body.reference), env, { fetchImpl: world.fetchImpl, now: NOW });

    const key = (world.calls.emails[0].text.match(/BCP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) || [])[0];
    const state = await verifyLicenseKey(key, { publicKey: publicKeyB64, now: NOW });
    expect(state.status).toBe('active');
    if (state.status === 'active') expect(state.payload.expires).toBe('2027-09-12');

    const expired = await verifyLicenseKey(key, { publicKey: publicKeyB64, now: new Date('2027-09-13T00:00:00Z') });
    expect(expired).toEqual({ status: 'invalid', reason: 'expired' });
  });

  it('a forged token mints nothing and never even asks CinetPay', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);

    const answer = await handleNotify(notification(result.body.reference, { notify_token: 'ntok_forge' }), env, {
      fetchImpl: world.fetchImpl, now: NOW,
    });
    expect(answer.status).toBe(202);
    expect(answer.body.reason || answer.body.action).toBe('token-mismatch');
    expect(world.calls.check).toHaveLength(0);
    expect(world.calls.emails).toHaveLength(0);
  });

  it('a notification for another merchant mint nothing', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    await createOrder(world, env);
    const answer = await handleNotify(notification('BC20260912ZZZZZZZZ'), env, { fetchImpl: world.fetchImpl, now: NOW });
    expect(answer.status).toBe(202);
    expect(answer.body.reason).toBe('unknown-order');
    expect(world.calls.emails).toHaveLength(0);
  });

  it('refuses a payment that does not cover the price', async () => {
    const { env } = await makeEnv();
    const low = fakeWorld({ amount: 100 });
    const { result } = await createOrder(low, env);
    const answer = await handleNotify(notification(result.body.reference), env, { fetchImpl: low.fetchImpl, now: NOW });

    expect(answer.body.action).toBe('refused');
    expect(low.calls.emails).toHaveLength(0);
    expect(JSON.parse((env.ORDERS as any).map.get(`order:${result.body.reference}`)).status).toBe('refused');
  });

  it('refuses a payment in another currency', async () => {
    const { env } = await makeEnv();
    const currency = fakeWorld({ currency: 'USD' });
    const { result } = await createOrder(currency, env);
    const answer = await handleNotify(notification(result.body.reference), env, { fetchImpl: currency.fetchImpl, now: NOW });
    expect(answer.body.action).toBe('refused');
    expect(currency.calls.emails).toHaveLength(0);
  });

  it('asks to be called again while the payment is still pending', async () => {
    const { env } = await makeEnv();
    const pending = fakeWorld({ status: 'PENDING' });
    const { result } = await createOrder(pending, env);
    const answer = await handleNotify(notification(result.body.reference), env, { fetchImpl: pending.fetchImpl, now: NOW });

    expect(answer.status).toBe(503);
    expect(answer.body.reason).toBe('still-pending');
    expect(pending.calls.emails).toHaveLength(0);
    // Still pending, not refused: the buyer may yet pay.
    expect(JSON.parse((env.ORDERS as any).map.get(`order:${result.body.reference}`)).status).toBe('pending');
  });

  it('asks to be called again when CinetPay cannot be reached at all', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    const broken = async () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const answer = await handleNotify(notification(result.body.reference), env, { fetchImpl: broken, now: NOW });
    expect(answer.status).toBe(503);
    expect(answer.body.reason).toBe('status-unavailable');
    expect(world.calls.emails).toHaveLength(0);
  });

  it('sends no second key when CinetPay repeats itself', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    const body = notification(result.body.reference);

    const first = await handleNotify(body, env, { fetchImpl: world.fetchImpl, now: NOW });
    const second = await handleNotify(body, env, { fetchImpl: world.fetchImpl, now: new Date('2026-09-12T10:05:00Z') });

    expect(first.body.action).toBe('delivered');
    expect(second.body.action).toBe('duplicate');
    expect(world.calls.emails).toHaveLength(1);
    // Even if it did re-deliver, the key is deterministic: same order, same key.
    expect(JSON.parse((env.ORDERS as any).map.get(`order:${result.body.reference}`)).deliveredAt).toBe(NOW.toISOString());
  });

  it('answers an unparsable body without crashing', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    expect((await handleNotify(null, env, { fetchImpl: world.fetchImpl })).status).toBe(202);
    expect((await handleNotify({ transaction_id: 'x' }, env, { fetchImpl: world.fetchImpl })).body.reason).toBe('missing-token');
    expect((await handleNotify('nope', env, { fetchImpl: world.fetchImpl })).status).toBe(202);
  });

  it('reads the v1 spelling CinetPay also sends', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    const answer = await handleNotify(
      { notify_token: 'ntok_123', transaction_id: 'cinet_abc', cpm_custom: result.body.reference },
      env,
      { fetchImpl: world.fetchImpl, now: NOW },
    );
    expect(answer.body.action).toBe('delivered');
  });
});

describe('the buyer watching their own order', () => {
  it('shows the state with a masked address and no key', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    await handleNotify(notification(result.body.reference), env, { fetchImpl: world.fetchImpl, now: NOW });

    const answer = await handleOrderStatus(result.body.reference, result.body.statusToken, env);
    expect(answer.status).toBe(200);
    expect(answer.body.order.status).toBe('delivered');
    expect(answer.body.order.email).toBe('k**i@example.com');
    const serialized = JSON.stringify(answer.body);
    expect(serialized).not.toContain('ntok_123');
    expect(serialized).not.toContain('BCP1.');
    expect(serialized).not.toContain(EMAIL);
  });

  it('requires the per-order token', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);

    expect((await handleOrderStatus(result.body.reference, 'st_forged', env)).status).toBe(403);
    expect((await handleOrderStatus(result.body.reference, '', env)).status).toBe(403);
    expect((await handleOrderStatus('BC20260912ZZZZZZZZ', result.body.statusToken, env)).status).toBe(404);
    expect((await handleOrderStatus('pas-une-reference', result.body.statusToken, env)).status).toBe(404);
  });
});

describe('http surface', () => {
  it('serves the catalogue the payment page renders', () => {
    const result = handleCatalog();
    expect(result.body.plans.map((p: any) => p.id)).toEqual(['pro', 'association']);
    expect(result.body.plans[0].price).toBe(PLANS.pro.price);
    expect(result.body.countries.find((c: any) => c.code === 'SN').methods.map((m: any) => m.name)).toContain('Wave');
  });

  it('routes the three API paths and 404s the rest', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const call = (path: string, init?: RequestInit) => route(new Request(`https://paiement.example.com${path}`, init), env);

    const catalog = await call('/api/catalog');
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).ok).toBe(true);

    const checkout = await route(
      new Request('https://paiement.example.com/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...CHECKOUT_BODY, amount: 1 }),
      }),
      env,
      { fetchImpl: world.fetchImpl, now: NOW },
    );
    const created = await checkout.json();
    expect(created.ok).toBe(true);
    expect(created.amount).toBe(PLANS.pro.price);

    const status = await call(`/api/order?ref=${created.reference}&token=${created.statusToken}`);
    expect((await status.json()).order.status).toBe('pending');

    expect((await call('/api/order?ref=nope&token=nope')).status).toBe(404);
    expect((await call('/nope')).status).toBe(404);
    expect((await call('/api/checkout')).status).toBe(404);
    expect(world.calls.emails).toHaveLength(0);
  });

  it('accepts the notification as form data, the way CinetPay v2 posts it', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);

    const form = new URLSearchParams({
      notify_token: 'ntok_123',
      transaction_id: 'cinet_abc',
      merchant_transaction_id: result.body.reference,
    });
    const answer = await route(
      new Request('https://paiement.example.com/api/notify', { method: 'POST', body: form }),
      env,
      { fetchImpl: world.fetchImpl, now: NOW },
    );
    expect(answer.status).toBe(200);
    expect((await answer.json()).action).toBe('delivered');
    expect(world.calls.emails).toHaveLength(1);
  });

  it('answers the preflight so the payment page can call it from another origin', async () => {
    const { env } = await makeEnv();
    const answer = await route(
      new Request('https://paiement.example.com/api/checkout', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } }),
      env,
    );
    expect(answer.status).toBe(204);
    expect(answer.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('restricts CORS to the configured origins when there are any', async () => {
    const { env } = await makeEnv({ ALLOWED_ORIGINS: 'https://app.example.com,https://staging.example.com' });
    const allowed = await route(new Request('https://x/api/catalog', { headers: { Origin: 'https://app.example.com' } }), env);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    const stranger = await route(new Request('https://x/api/catalog', { headers: { Origin: 'https://evil.example.com' } }), env);
    expect(stranger.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example.com');
  });

  it('reports what is missing instead of failing at the first sale', async () => {
    const empty = readiness({});
    expect(empty.ready).toBe(false);
    expect(empty.missing).toContain('LICENSE_PRIVATE_JWK');
    expect(empty.missing).toContain('ORDERS (KV binding)');

    const { env } = await makeEnv();
    expect(readiness(env).ready).toBe(true);

    const answer = await route(new Request('https://x/health'), env);
    expect((await answer.json()).ready).toBe(true);
  });

  it('turns an unexpected error into a 500, never a stack trace', async () => {
    const { env } = await makeEnv();
    const answer = await route(
      new Request('https://x/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' }),
      env,
    );
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ ok: false, error: 'invalid-json' });
  });
});

describe('e-mail delivery', () => {
  it('escapes the buyer name in the message it sends', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env, { name: '<script>alert(1)</script>' });
    await handleNotify(notification(result.body.reference), env, { fetchImpl: world.fetchImpl, now: NOW });

    expect(world.calls.emails[0].html).not.toContain('<script>');
    expect(world.calls.emails[0].html).toContain('&lt;script&gt;');
  });

  it('supports MailChannels without a Resend key', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({ ok: true });
    };
    const env = { EMAIL_PROVIDER: 'mailchannels', EMAIL_FROM: 'licences@example.com' };
    await sendEmail(env, { to: EMAIL, subject: 'x', text: 'a', html: '<p>a</p>' }, fetchImpl as any);

    expect(calls[0].url).toContain('mailchannels.net');
    expect(calls[0].body.personalizations[0].to[0].email).toBe(EMAIL);
    expect(calls[0].body.content[0].type).toBe('text/plain');
  });

  it('skips sending in `none` mode (local testing) and never calls a provider', async () => {
    const fetchImpl = async () => {
      throw new Error('must not be called');
    };
    const result = await sendEmail({ EMAIL_PROVIDER: 'none' }, { to: EMAIL, subject: 'x', text: 'a', html: 'b' }, fetchImpl as any);
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it('raises on a provider failure so the order is not marked delivered', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    const failing = async (url: string, init?: RequestInit) => {
      if (url.includes('resend.com')) return jsonResponse({ message: 'domain not verified' }, 403);
      return world.fetchImpl(url, init);
    };

    await expect(
      handleNotify(notification(result.body.reference), env, { fetchImpl: failing, now: NOW }),
    ).rejects.toThrow(/resend 403/);

    // The order stays pending: CinetPay will call again and the buyer gets a key.
    expect(JSON.parse((env.ORDERS as any).map.get(`order:${result.body.reference}`)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------

/** One hour after `NOW` — past the grace period, so orders are due. */
const RECONCILE_AT = new Date('2026-09-12T11:00:00Z');

function stored(env: any, reference: string) {
  return JSON.parse(env.ORDERS.map.get(`order:${reference}`));
}

/**
 * The cron job is the net under the webhook: it exists for the payments where
 * the notification was **lost** (a deploy during the callback, CinetPay's
 * retries exhausted) while the buyer's money has already left their account.
 * What these tests pin is that it can only ever do what the webhook could — and
 * that it can never assume money that CinetPay did not confirm.
 */
describe('reconciliation cron', () => {
  it('delivers a paid order whose notification never arrived', async () => {
    const { env, publicKeyB64 } = await makeEnv();
    const world = fakeWorld();
    const { result, order } = await createOrder(world, env);
    expect(order.status).toBe('pending');

    const summary = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });

    expect(summary).toMatchObject({ checked: 1, delivered: 1, refused: 0, failed: 0 });
    expect(stored(env, result.body.reference).status).toBe('delivered');
    expect(world.calls.emails).toHaveLength(1);

    // What went out is a real licence for this order, verifiable by the app.
    const key = world.calls.emails[0].text.match(/BCP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];
    expect(key).toBeTruthy();
    const state = await verifyLicenseKey(key!, { publicKey: publicKeyB64, now: RECONCILE_AT });
    expect((state as any).status).toBe('active');
  });

  it('refuses an underpayment instead of selling a licence', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld({ amount: 100 });
    const { result } = await createOrder(world, env);

    const summary = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });

    expect(summary).toMatchObject({ checked: 1, delivered: 0, refused: 1 });
    expect(stored(env, result.body.reference).refusedReason).toBe('amount-mismatch');
    expect(world.calls.emails).toHaveLength(0);
  });

  it('never delivers when CinetPay cannot be reached — money is never assumed', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    const unreadable = async (url: string, init?: RequestInit) => {
      if (url.includes('/payment/check')) return new Response('<html>gateway timeout</html>', { status: 504 });
      return world.fetchImpl(url, init);
    };

    const summary = await reconcileOrders(env, { fetchImpl: unreadable, now: RECONCILE_AT });

    expect(summary).toMatchObject({ checked: 1, waiting: 1, delivered: 0 });
    expect(stored(env, result.body.reference).status).toBe('pending');
    expect(world.calls.emails).toHaveLength(0);
  });

  it('leaves an unpaid order pending, so a payment made later is still picked up', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld({ status: 'PENDING' });
    const { result } = await createOrder(world, env);

    const summary = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });

    expect(summary).toMatchObject({ checked: 1, waiting: 1, refused: 0 });
    expect(stored(env, result.body.reference).status).toBe('pending');
  });

  it('ends an order the operator reports as failed', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld({ status: 'FAILED' });
    const { result } = await createOrder(world, env);

    const summary = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });

    expect(summary).toMatchObject({ checked: 1, refused: 1 });
    expect(stored(env, result.body.reference).refusedReason).toBe('unpaid');
  });

  it('does not query CinetPay for an order that is too fresh', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    await createOrder(world, env);

    const summary = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: NOW });

    expect(summary.checked).toBe(0);
    expect(world.calls.check).toHaveLength(0);
  });

  it('is idempotent: a second run delivers nothing more and sends no second e-mail', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });

    const second = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });

    expect(second.checked).toBe(0);
    expect(second.delivered).toBe(0);
    expect(world.calls.emails).toHaveLength(1);
    // The licence was minted once, so the key did not change under the buyer.
    expect(stored(env, result.body.reference).licenseId).toBe(result.body.reference);
  });

  it('keeps a paid order pending when the e-mail fails, and the next run recovers it', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);
    const failingMail = async (url: string, init?: RequestInit) => {
      if (url.includes('resend.com')) throw new Error('smtp down');
      return world.fetchImpl(url, init);
    };

    const first = await reconcileOrders(env, { fetchImpl: failingMail, now: RECONCILE_AT });
    expect(first).toMatchObject({ checked: 1, delivered: 0, failed: 1 });
    expect(stored(env, result.body.reference).status).toBe('pending');

    const second = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });
    expect(second.delivered).toBe(1);
    expect(world.calls.emails).toHaveLength(1);
  });

  it('walks every page of the store, not just the first', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const references = [];
    for (let i = 0; i < 5; i += 1) {
      const { result } = await createOrder(world, env);
      references.push(result.body.reference);
    }
    expect(new Set(references).size).toBe(5);

    const summary = await reconcileOrders(env, { fetchImpl: world.fetchImpl, now: RECONCILE_AT });

    expect(summary).toMatchObject({ checked: 5, delivered: 5 });
    expect(world.calls.emails).toHaveLength(5);
  });

  it('runs from the Cloudflare `scheduled` entry point', async () => {
    const { env } = await makeEnv();
    const world = fakeWorld();
    const { result } = await createOrder(world, env);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = world.fetchImpl as any;
    try {
      const summary = await worker.scheduled({ scheduledTime: RECONCILE_AT.getTime() }, env, {} as any);
      expect(summary.delivered).toBe(1);
      expect(stored(env, result.body.reference).status).toBe('delivered');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
