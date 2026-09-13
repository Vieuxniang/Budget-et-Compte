/**
 * The shop — a single Cloudflare Worker. It is the only component in the whole
 * product that holds the signing key, and the only one that ever sees a
 * customer's e-mail address.
 *
 * It runs the purchase in three steps, and each step is a different origin of
 * trust:
 *
 *   1. `POST /api/checkout` — the buyer's own request. It is treated as
 *      **untrusted input**: prices come from `core.js`, never from the body, so
 *      nobody can buy the 50 000 F licence for 100 F. The response is a URL to
 *      CinetPay's page; the worker never handles a card or a PIN.
 *   2. `POST /api/notify` — CinetPay's webhook. Unauthenticated HTTP until
 *      proven otherwise, so the stored notify token is compared in constant
 *      time, and the amount/currency are taken from an **authoritative
 *      re-query** of CinetPay, never from the notification body. Only then is a
 *      licence minted.
 *   3. `GET /api/order` — the buyer watching their own order. Authenticated by
 *      the per-order status token, and answered with `publicOrderView` (masked
 *      e-mail, never the key, never the notify token).
 *
 * Everything decidable lives in `core.js` and is unit-tested; this file is the
 * shell: HTTP, KV, fetch, e-mail. Anything that looks like policy here is a bug.
 */

import {
  COUNTRIES,
  OPERATOR_NAMES,
  PLANS,
  buildCheckoutRequest,
  decideDelivery,
  encodeLicenseKey,
  isOrderReference,
  isValidEmail,
  licensePayloadFor,
  newOrder,
  orderReference,
  parseNotification,
  publicOrderView,
  readCheckoutResponse,
  readStatusPayload,
  receiptEmail,
  resolvePlan,
  selectReconcilable,
  decideReconciliation,
  timingSafeEqual,
  toBase64Url,
} from './core.js';

/** CinetPay v2 endpoints (overridable for their sandbox or a v3 migration). */
const DEFAULT_BASE_URL = 'https://api-checkout.cinetpay.com';
const INIT_PATH = '/v2/payment';
const CHECK_PATH = '/v2/payment/check';

const ORDER_PREFIX = 'order:';
/** A created order that never gets paid expires after a week. */
const ORDER_TTL_SECONDS = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readConfig(env, request) {
  const origin = request?.url ? new URL(request.url).origin : 'http://localhost';
  return {
    apiKey: env.CINETPAY_API_KEY || '',
    siteId: env.CINETPAY_SITE_ID || '',
    baseUrl: (env.CINETPAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    publicBaseUrl: (env.PUBLIC_BASE_URL || origin).replace(/\/$/, ''),
    siteUrl: (env.SITE_URL || origin).replace(/\/$/, ''),
    supportEmail: env.SUPPORT_EMAIL || '',
    lang: env.CHECKOUT_LANG || 'fr',
    provider: env.EMAIL_PROVIDER || 'resend',
    emailFrom: env.EMAIL_FROM || '',
    resendKey: env.RESEND_API_KEY || '',
  };
}

/** True when the deployment is actually able to sell (used by `/health`). */
export function readiness(env) {
  const missing = [];
  if (!env.CINETPAY_API_KEY) missing.push('CINETPAY_API_KEY');
  if (!env.CINETPAY_SITE_ID) missing.push('CINETPAY_SITE_ID');
  if (!env.LICENSE_PRIVATE_JWK) missing.push('LICENSE_PRIVATE_JWK');
  if (!env.ORDERS) missing.push('ORDERS (KV binding)');
  if (!env.EMAIL_FROM) missing.push('EMAIL_FROM');
  if ((env.EMAIL_PROVIDER || 'resend') === 'resend' && !env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Order store (KV). Values are JSON; keys are namespaced so a KV browser shows
// exactly what it holds.
// ---------------------------------------------------------------------------

async function loadOrder(env, reference) {
  if (!isOrderReference(reference)) return null;
  return (await env.ORDERS.get(`${ORDER_PREFIX}${reference}`, 'json')) || null;
}

async function saveOrder(env, order, ttlSeconds = ORDER_TTL_SECONDS) {
  await env.ORDERS.put(`${ORDER_PREFIX}${order.reference}`, JSON.stringify(order), {
    expirationTtl: ttlSeconds,
    // A monotonic-ish guard for KV's eventual consistency: metadata is available
    // from `list()` without reading values, which is what the daily bookkeeping
    // script reads to count sales.
    metadata: { status: order.status, plan: order.plan, amount: order.amount, currency: order.currency },
  });
  return order;
}

// ---------------------------------------------------------------------------
// Outbound HTTP
// ---------------------------------------------------------------------------

async function cinetpayInit(config, body, fetchImpl) {
  const response = await fetchImpl(`${config.baseUrl}${INIT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`cinetpay init returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * The authoritative answer. Everything the money decision depends on comes from
 * here — the webhook body only tells us *which* transaction to ask about.
 */
async function cinetpayCheck(config, reference, fetchImpl) {
  const response = await fetchImpl(`${config.baseUrl}${CHECK_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apikey: config.apiKey, site_id: config.siteId, transaction_id: reference }),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // An unreadable answer is "unavailable", not "unpaid": `decideDelivery`
    // turns a null status into a retry, which is exactly right here.
    return null;
  }
}

/**
 * Sends the receipt. Two providers are supported so the shop is not tied to one
 * vendor: Resend (simple HTTPS API) and MailChannels (free from Workers). A
 * failure is loud — `deliverOrder` calls it before marking the order delivered,
 * so a mail outage means CinetPay retries, not a customer who paid and got
 * nothing.
 */
export async function sendEmail(env, message, fetchImpl = fetch) {
  const provider = env.EMAIL_PROVIDER || 'resend';
  if (provider === 'none') {
    console.log('[email:skipped]', message.to, message.subject);
    return { ok: true, skipped: true };
  }

  if (provider === 'mailchannels') {
    const response = await fetchImpl('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: env.EMAIL_FROM, name: message.fromName || 'Budget et Compte' },
        reply_to: message.replyTo ? { email: message.replyTo } : undefined,
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
    });
    if (!response.ok) throw new Error(`mailchannels ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return { ok: true };
  }

  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
  });
  if (!response.ok) throw new Error(`resend ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Handlers (exported for tests — each takes its dependencies explicitly)
// ---------------------------------------------------------------------------

function badRequest(reason, status = 400) {
  return { status, body: { ok: false, error: reason } };
}

/**
 * Creates an order and returns the URL to send the buyer to.
 *
 * The body is deliberately over-read (several spellings for each field) so the
 * static page can post whatever it has, but every *decision* comes from
 * `resolvePlan` — plan price, plan duration and currency are never taken from
 * the client.
 */
export async function handleCheckout(body, env, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || new Date();
  const config = readConfig(env, deps.request);

  const country = typeof body?.country === 'string' ? body.country.toUpperCase() : '';
  const planId = typeof body?.plan === 'string' ? body.plan.toLowerCase() : '';
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const phone = typeof body?.phone === 'string' ? body.phone.trim().slice(0, 24) : '';

  const plan = resolvePlan(planId, country);
  if (!plan) return badRequest('plan-not-sellable');
  if (!isValidEmail(email)) return badRequest('email-invalid');

  const reference = orderReference(now);
  const statusToken = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const order = newOrder({ reference, plan, country, email, name, phone, statusToken, now });

  const answer = await cinetpayInit(config, buildCheckoutRequest(order, config), fetchImpl);
  const parsed = readCheckoutResponse(answer);
  if (!parsed.ok) {
    console.error('[checkout:refused]', JSON.stringify(answer).slice(0, 300));
    return badRequest('payment-init-failed', 502);
  }

  // The notify token is what lets us recognise CinetPay's later call: without
  // it, a random POST could ask for a licence.
  order.notifyToken = parsed.notifyToken;
  order.paymentToken = parsed.paymentToken;
  order.status = 'pending';
  await saveOrder(env, order);

  return {
    status: 201,
    body: {
      ok: true,
      reference: order.reference,
      statusToken: order.statusToken,
      amount: order.amount,
      currency: order.currency,
      plan: order.plan,
      planLabel: order.planLabel,
      paymentUrl: parsed.paymentUrl,
      country,
      operators: (COUNTRIES[country]?.methods || []).map((code) => OPERATOR_NAMES[code] || code),
    },
  };
}

/**
 * Mints the licence and hands it to the buyer by e-mail. Called from a decision
 * of `decideDelivery` — never before.
 *
 * Minting is **deterministic**: the payload is derived from the stored order
 * (reference, plan, name) and the issue date stamped on it, so a second delivery
 * of the same order would produce a byte-identical key. That is what makes a
 * repeated webhook harmless even before the `delivered` flag is read.
 */
export async function deliverOrder(env, order, { fetchImpl = fetch, now = new Date() } = {}) {
  const config = readConfig(env);
  const privateJwk = typeof env.LICENSE_PRIVATE_JWK === 'string' ? JSON.parse(env.LICENSE_PRIVATE_JWK) : env.LICENSE_PRIVATE_JWK;

  // Freeze the issue date on the order *before* minting, so the e-mail and the
  // key can never disagree about the expiry (and a re-send states the same date).
  order.issuedAt = order.issuedAt || now.toISOString();
  const payload = licensePayloadFor(order, new Date(order.issuedAt));
  order.expires = payload.expires;
  const licenseKey = await encodeLicenseKey(payload, privateJwk);

  const mail = receiptEmail(order, licenseKey, {
    brand: undefined,
    supportEmail: config.supportEmail,
  });
  await sendEmail(env, { ...mail, to: order.email, replyTo: config.supportEmail, fromName: 'Budget et Compte' }, fetchImpl);

  order.status = 'delivered';
  order.deliveredAt = now.toISOString();
  order.licenseId = payload.id;
  await saveOrder(env, order, Math.max(ORDER_TTL_SECONDS, 400 * 24 * 60 * 60));
  return { order, licenseKey };
}

/**
 * CinetPay's webhook. Answers with 200 as soon as the notification is genuine —
 * including for a duplicate or a "still pending", because a non-200 makes
 * CinetPay call again and again. It never mints a key before the operator's own
 * status answer confirms the exact amount.
 */
export async function handleNotify(body, env, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || new Date();
  const config = readConfig(env);

  const parsed = parseNotification(body);
  if (!parsed.ok) {
    console.warn('[notify:unparsable]', parsed.reason);
    return { status: 202, body: { ok: false, reason: parsed.reason } };
  }

  const { notification } = parsed;
  const order = await loadOrder(env, notification.merchantTransactionId || notification.transactionId);
  if (!order) {
    // Could be another merchant's transaction_id on a shared endpoint, or an
    // order whose TTL expired. Either way: nothing to deliver.
    console.warn('[notify:unknown-order]', notification.transactionId);
    return { status: 202, body: { ok: false, reason: 'unknown-order' } };
  }

  // Only pay the price of a status re-query once the token has proven itself.
  const tokenOk =
    Boolean(order.notifyToken) && timingSafeEqual(order.notifyToken, notification.notifyToken);
  const status = tokenOk ? readStatusPayload(await cinetpayCheck(config, order.reference, fetchImpl)) : null;

  const decision = decideDelivery({ order, parsed, status });
  switch (decision.action) {
    case 'deliver': {
      const { licenseKey } = await deliverOrder(env, order, { fetchImpl, now });
      console.log('[notify:delivered]', order.reference, `licence ${order.licenseId}`, `key ${licenseKey.slice(0, 12)}…`);
      return { status: 200, body: { ok: true, action: 'delivered' } };
    }
    case 'duplicate':
      return { status: 200, body: { ok: true, action: 'duplicate' } };
    case 'reject':
      order.status = 'refused';
      order.refusedAt = now.toISOString();
      order.refusedReason = decision.reason;
      await saveOrder(env, order);
      console.warn('[notify:refused]', order.reference, decision.reason);
      return { status: 200, body: { ok: true, action: 'refused' } };
    case 'retry':
      // Ask to be called again: no state change, the next notification is
      // evaluated afresh.
      console.warn('[notify:retry]', order.reference, decision.reason);
      return { status: 503, body: { ok: false, action: 'retry', reason: decision.reason } };
    default:
      return { status: 202, body: { ok: false, action: 'ignored', reason: decision.reason } };
  }
}

/**
 * The buyer watching their own order. Requires the per-order status token, and
 * answers with `publicOrderView` only — no key, no notify token, no plain
 * e-mail. The support address rides along so a stuck buyer has a way out without
 * going back to the shop page.
 */
export async function handleOrderStatus(reference, token, env) {
  const order = await loadOrder(env, reference);
  if (!order) return badRequest('order-not-found', 404);
  if (!order.statusToken || !timingSafeEqual(order.statusToken, String(token || ''))) {
    return badRequest('token-mismatch', 403);
  }
  return {
    status: 200,
    body: { ok: true, order: publicOrderView(order), support: readConfig(env).supportEmail || '' },
  };
}

// ---------------------------------------------------------------------------
// Reconciliation — the safety net under the webhook
// ---------------------------------------------------------------------------

/**
 * Every stored order still worth a second look. `list()` gives keys only, and
 * the metadata written by `saveOrder` carries the status, so delivered and
 * refused orders are skipped without a value read — a busy shop lists thousands
 * of keys but loads a handful.
 *
 * Metadata is a *filter*, never the decision: `decideReconciliation` re-reads
 * the record it is about to act on, so a stale list entry cannot make the job
 * re-deliver or re-refuse something that is already finished.
 */
async function listWaitingOrders(env, { max = 500 } = {}) {
  const names = [];
  let cursor;
  do {
    const page = await env.ORDERS.list({ prefix: ORDER_PREFIX, cursor });
    for (const key of page.keys || []) {
      const status = key.metadata?.status;
      if (status === 'delivered' || status === 'refused') continue;
      names.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < max);

  const orders = [];
  for (const name of names) {
    const order = await env.ORDERS.get(name, 'json');
    if (order) orders.push(order);
  }
  return orders;
}

/**
 * Asks CinetPay about the orders that are still waiting for money, and delivers
 * or refuses them on the operator's own answer.
 *
 * This is the net under the webhook, and it exists because a webhook can be
 * **lost**: CinetPay's retries stop after a while, and if our Worker is down for
 * a deploy the notification is simply gone — meanwhile the buyer's money has
 * left their account. The job is deliberately idempotent (`deliverOrder` mints
 * deterministically, and every terminal order is skipped), so running it twice,
 * early, or after a webhook already delivered changes nothing.
 *
 * One order failing never aborts the run: each is isolated, counted, and left
 * for the next tick.
 */
export async function reconcileOrders(env, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || new Date();
  const config = readConfig(env, deps.request);
  const summary = { checked: 0, delivered: 0, refused: 0, waiting: 0, skipped: 0, failed: 0 };

  let orders;
  try {
    orders = deps.orders || (await listWaitingOrders(env, { max: deps.max }));
  } catch (error) {
    console.error('[reconcile:list-failed]', error?.message || error);
    return { ...summary, failed: 1 };
  }

  for (const order of selectReconcilable(orders, now, { graceMs: deps.graceMs, limit: deps.limit })) {
    summary.checked += 1;
    // Only the transaction identity goes out; the answer is the operator's.
    const status = readStatusPayload(await cinetpayCheck(config, order.reference, fetchImpl));
    const decision = decideReconciliation({ order, status, now, graceMs: deps.graceMs });

    try {
      switch (decision.action) {
        case 'deliver': {
          const { licenseKey } = await deliverOrder(env, order, { fetchImpl, now });
          summary.delivered += 1;
          console.log('[reconcile:delivered]', order.reference, `licence ${order.licenseId}`, `key ${licenseKey.slice(0, 12)}…`, `(${decision.reason})`);
          break;
        }
        case 'refuse':
          order.status = 'refused';
          order.refusedAt = now.toISOString();
          order.refusedReason = decision.reason;
          await saveOrder(env, order);
          summary.refused += 1;
          console.warn('[reconcile:refused]', order.reference, decision.reason);
          break;
        case 'wait':
          summary.waiting += 1;
          break;
        default:
          summary.skipped += 1;
          break;
      }
    } catch (error) {
      // A mail failure lands here: the order stays pending, so the next run
      // retries it. Never a customer who paid and got nothing.
      summary.failed += 1;
      console.error('[reconcile:failed]', order.reference, error?.message || error);
    }
  }

  return summary;
}

/** The catalogue the payment page renders, so prices live in one place only. */
export function handleCatalog() {
  return {
    status: 200,
    body: {
      ok: true,
      plans: Object.values(PLANS).map((plan) => ({
        id: plan.id,
        label: plan.label,
        price: plan.price,
        months: plan.months,
        blurb: plan.blurb,
      })),
      countries: Object.entries(COUNTRIES).map(([code, country]) => ({
        code,
        label: country.label,
        currency: country.currency,
        phonePrefix: country.phonePrefix,
        methods: country.methods.map((method) => ({ code: method, name: OPERATOR_NAMES[method] || method })),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function corsHeaders(request, env) {
  const origin = request?.headers?.get?.('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 ? origin || '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function route(request, env, deps = {}) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (url.pathname === '/health') {
    return json({ ok: true, ...readiness(env) }, 200, cors);
  }
  if (url.pathname === '/api/catalog') {
    const result = handleCatalog();
    return json(result.body, result.status, cors);
  }

  let result;
  try {
    if (url.pathname === '/api/checkout' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body) return json({ ok: false, error: 'invalid-json' }, 400, cors);
      result = await handleCheckout(body, env, { request, ...deps });
    } else if (url.pathname === '/api/notify' && request.method === 'POST') {
      // CinetPay posts either JSON or form-encoded; accept both.
      const type = request.headers.get('content-type') || '';
      let body;
      if (type.includes('application/json')) {
        body = await readJson(request);
      } else {
        const form = await request.formData();
        body = Object.fromEntries(form.entries());
      }
      result = await handleNotify(body, env, deps);
    } else if (url.pathname === '/api/order' && request.method === 'GET') {
      result = await handleOrderStatus(url.searchParams.get('ref'), url.searchParams.get('token'), env);
    } else {
      return json({ ok: false, error: 'not-found' }, 404, cors);
    }
  } catch (error) {
    // Never leak a stack trace to the buyer; the log is where it belongs.
    console.error('[error]', url.pathname, error?.stack || error);
    return json({ ok: false, error: 'server-error' }, 500, cors);
  }

  return json(result.body, result.status, cors);
}

export default {
  async fetch(request, env) {
    return route(request, env);
  },

  /**
   * The cron entry point (`[triggers]` in `wrangler.toml`). Named `scheduled`
   * because that is what Cloudflare calls it; the work is `reconcileOrders`.
   */
  async scheduled(event, env, ctx) {
    const summary = await reconcileOrders(env, { now: event?.scheduledTime ? new Date(event.scheduledTime) : undefined });
    console.log('[cron]', JSON.stringify(summary));
    return summary;
  },
};
