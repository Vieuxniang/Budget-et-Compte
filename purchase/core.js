/**
 * Offline purchase path — the pure core.
 *
 * What "offline purchase" means here, precisely: the buyer pays with mobile
 * money (which obviously needs a network), and in exchange receives a **signed
 * licence key by e-mail**. The app itself never talks to a server: it verifies
 * that key on the device, and every feature keeps working with no connection.
 * There is no account, no activation call, no phone-home.
 *
 * This module holds **policy and format, never I/O**: no fetch, no storage, no
 * environment. The Cloudflare Worker (`worker.js`) is the thin shell around it;
 * the tests (`tests/purchase.test.ts`) exercise it directly, which is where the
 * money rules belong — a bug here either gives the product away or refuses a
 * paying customer.
 *
 * The single rule everything else exists to protect:
 *
 *   **The signing private key never leaves the server.** A licence is minted
 *   exactly once, on the server, after the payment has been confirmed by
 *   CinetPay itself. Nothing in this file can be reached from the browser.
 *
 * Verification is deliberately two-layered, because a webhook is an unauthenticated
 * HTTP request until proven otherwise:
 *
 * 1. **Notify token** — the token CinetPay returned when the payment was created
 *    is stored with the order and compared in constant time against the one in
 *    the notification. This is CinetPay's own scheme (their Go SDK compares
 *    `notify_token` the same way).
 * 2. **Authoritative status re-query** — before minting, the server asks
 *    CinetPay for the transaction status and only trusts *that* answer for the
 *    money (amount, currency, paid-or-not). The notification body is never used
 *    to decide how much was paid.
 *
 * Layer 2 is what makes the flow safe even if field names shift between API
 * versions: a spoofed notification cannot fake the operator's own answer.
 */

export const BRAND = 'Budget et Compte';
export const LICENSE_PREFIX = 'BCP1';

/** Currencies CinetPay settles (their SDK's supported set). */
export const CURRENCIES = ['XOF', 'XAF', 'GNF', 'CDF', 'USD'];

/**
 * Countries we sell in, with the operators CinetPay exposes there. The codes are
 * CinetPay's `payment_method` values, and the page turns them into names.
 */
export const COUNTRIES = {
  SN: {
    label: 'Sénégal',
    currency: 'XOF',
    phonePrefix: '+221',
    methods: ['WAVE_SN', 'OM_SN', 'FREE_SN', 'EXPRESSO_SN'],
  },
  CI: {
    label: "Côte d'Ivoire",
    currency: 'XOF',
    phonePrefix: '+225',
    methods: ['WAVE_CI', 'OM_CI', 'MTN_CI', 'MOOV_CI'],
  },
  BF: {
    label: 'Burkina Faso',
    currency: 'XOF',
    phonePrefix: '+226',
    methods: ['WAVE_BF', 'OM_BF', 'MOOV_BF'],
  },
  ML: {
    label: 'Mali',
    currency: 'XOF',
    phonePrefix: '+223',
    methods: ['OM_ML', 'MOOV_ML'],
  },
  CM: {
    label: 'Cameroun',
    currency: 'XAF',
    phonePrefix: '+237',
    methods: ['OM_CM', 'MTN_CM'],
  },
};

/** Display names for the operator codes (shown on the payment page). */
export const OPERATOR_NAMES = {
  WAVE_SN: 'Wave', WAVE_CI: 'Wave', WAVE_BF: 'Wave',
  OM_SN: 'Orange Money', OM_CI: 'Orange Money', OM_BF: 'Orange Money',
  OM_ML: 'Orange Money', OM_CM: 'Orange Money',
  MTN_CI: 'MTN MoMo', MTN_CM: 'MTN MoMo',
  MOOV_CI: 'Moov Money', MOOV_BF: 'Moov Money', MOOV_ML: 'Moov Money',
  FREE_SN: 'Free Money', EXPRESSO_SN: 'Expresso',
};

/**
 * Prices. `pro` is a one-off purchase (the licence never expires — it is the
 * household licence), `association` is annual because a group keeps getting new
 * members and expects the seller to still be there next year.
 */
export const PLANS = {
  pro: { id: 'pro', label: 'Pro', price: 5_000, months: null, blurb: 'Licence personnelle, à vie' },
  association: { id: 'association', label: 'Association', price: 50_000, months: 12, blurb: 'Tontines, coopératives — 12 mois' },
};

export const PLAN_IDS = Object.keys(PLANS);

// ---------------------------------------------------------------------------
// CinetPay vocabulary (mirrors their published constants)
// ---------------------------------------------------------------------------

/** The only status that means "the money is in". */
export const PAID_STATUS = 'SUCCESS';
/** The matching numeric API code. */
export const PAID_API_CODE = 100;
/** The v2 checkout's success marker. */
export const PAID_RESULT_FLAG = '00';
/** Terminal-but-not-paid statuses: the order is over, nothing to deliver. */
export const FINAL_UNPAID_STATUSES = ['FAILED', 'TRANSACTION_EXIST', 'INSUFFICIENT_BALANCE', 'EXPIRED', 'NOT_ALLOWED'];

// ---------------------------------------------------------------------------
// Base64url — duplicated from src/services/crypto.ts on purpose: this module
// must run in a Worker without importing the app bundle.
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64_ALPHABET[c & 0x3f];
  }
  return out;
}

export function fromBase64Url(value) {
  const clean = String(value).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = B64_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base64url');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Order references
// ---------------------------------------------------------------------------

/** Crockford base32 without I/L/O/U: readable aloud over the phone, no 0/O mixups. */
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function defaultRandom(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes);
}

/**
 * A reference the buyer can read out to support: `BC` + date + 8 random chars,
 * **alphanumeric only** so it can be used as-is as CinetPay's `transaction_id`
 * whatever that field validates. 32^8 ≈ 1.1e12 per day, so guessing one is not
 * a path to anything (and it would not help anyway: the notify token does not
 * derive from it).
 */
export function orderReference(now = new Date(), random = defaultRandom) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const picks = random(8).map((byte) => REF_ALPHABET[byte % REF_ALPHABET.length]);
  return `BC${day}${picks.join('')}`;
}

/** True when a reference has the exact shape we mint (rejects anything else early). */
export function isOrderReference(value) {
  return typeof value === 'string' && /^BC\d{8}[0-9A-HJKMNP-TV-Z]{8}$/.test(value);
}

export function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()) && value.trim().length <= 160;
}

/** `kofi@example.com` → `k***i@example.com` — what a status page may show. */
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : '';
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length - tail.length))}${tail}@${domain}`;
}

export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 4) return '';
  return `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Resolves the plan for a country, or null when the request is not sellable
 * (unknown plan, unknown country, currency we cannot settle).
 */
export function resolvePlan(planId, countryCode) {
  const plan = PLANS[planId];
  const country = COUNTRIES[countryCode];
  if (!plan || !country || !CURRENCIES.includes(country.currency)) return null;
  return { ...plan, country: countryCode, currency: country.currency };
}

/**
 * The order record we store **before** sending the buyer to the payment page.
 * `notifyToken` is filled in once CinetPay has answered, and `statusToken` is
 * what lets the buyer watch their own order (and nothing else) afterwards.
 */
export function newOrder({ reference, plan, country, email, name, phone, statusToken, now = new Date() }) {
  return {
    reference,
    plan: plan.id,
    planLabel: plan.label,
    country,
    currency: plan.currency,
    amount: plan.price,
    months: plan.months,
    email: email.trim(),
    name: (name || '').trim(),
    phone: (phone || '').trim(),
    createdAt: now.toISOString(),
    status: 'created',
    statusToken,
  };
}

/**
 * The body CinetPay expects for a new checkout. Built here (and tested) so the
 * worker stays a shell, and so a field renaming shows up in one place.
 *
 * `channels`/`payment_method` are intentionally left open: the buyer picks the
 * operator on CinetPay's own page, which also handles the OTP/push flows the
 * operators require. We list them up front so the buyer knows what to expect.
 */
export function buildCheckoutRequest(order, config) {
  return {
    apikey: config.apiKey,
    site_id: config.siteId,
    transaction_id: order.reference,
    amount: order.amount,
    currency: order.currency,
    description: `${BRAND} — licence ${order.planLabel}`,
    lang: config.lang || 'fr',
    notify_url: `${config.publicBaseUrl}/api/notify`,
    return_url: `${config.siteUrl}/thanks.html?ref=${encodeURIComponent(order.reference)}`,
    customer_email: order.email,
    customer_name: order.name,
    ...(order.phone ? { customer_phone_number: order.phone } : {}),
    metadata: JSON.stringify({ plan: order.plan, reference: order.reference }).slice(0, 512),
  };
}

/** Reads the payment URL/token out of CinetPay's answer, whatever the nesting. */
export function readCheckoutResponse(payload) {
  const data = (payload && (payload.data || payload)) || {};
  const url = data.payment_url || data.paymentUrl || data.url || null;
  const token = data.payment_token || data.paymentToken || data.token || null;
  const notifyToken = data.notify_token || data.notifyToken || null;
  return {
    ok: Boolean(url) && Boolean(token),
    paymentUrl: url,
    paymentToken: token,
    notifyToken,
    code: payload?.code ?? null,
    message: payload?.message ?? payload?.description ?? null,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison. Length is not a secret here, but the
 * comparison itself never short-circuits — the token is what stands between a
 * random POST and a free licence.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * Parses a notification. Mirrors CinetPay's own SDK: `notify_token` and
 * `transaction_id` are required; `merchant_transaction_id` and the buyer block
 * are optional. Returns `{ ok: false, reason }` rather than throwing, so the
 * worker can answer a 400 with a log line instead of a stack trace.
 */
export function parseNotification(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'not-object' };
  const body = payload.data && typeof payload.data === 'object' ? { ...payload, ...payload.data } : payload;
  const notifyToken = body.notify_token ?? body.notifyToken;
  const transactionId = body.transaction_id ?? body.transactionId ?? body.cpm_trans_id;
  if (typeof notifyToken !== 'string' || !notifyToken) return { ok: false, reason: 'missing-token' };
  if (typeof transactionId !== 'string' || !transactionId) return { ok: false, reason: 'missing-transaction' };
  const merchantTransactionId =
    body.merchant_transaction_id ?? body.merchantTransactionId ?? body.cpm_custom ?? null;
  const user = body.user && typeof body.user === 'object' ? body.user : {};
  return {
    ok: true,
    notification: {
      notifyToken,
      transactionId,
      merchantTransactionId: typeof merchantTransactionId === 'string' ? merchantTransactionId : null,
      buyer: {
        name: typeof user.name === 'string' ? user.name : typeof body.customer_name === 'string' ? body.customer_name : null,
        email: typeof user.email === 'string' ? user.email : typeof body.customer_email === 'string' ? body.customer_email : null,
        phone: typeof user.phone_number === 'string' ? user.phone_number : null,
      },
    },
  };
}

/**
 * Normalizes an **authoritative** status answer (from `payment/check`) into the
 * few facts we act on. Several spellings are accepted because the v1 and v2
 * answers differ; this function is only ever fed CinetPay's own response, never
 * the notification body — a spoofed notification must not be able to name its
 * own amount.
 */
export function readStatusPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data && typeof payload.data === 'object' ? { ...payload, ...payload.data } : payload;
  const status = data.status ?? data.cpm_result_text ?? null;
  const rawAmount = data.amount ?? data.cpm_amount ?? null;
  const currency = data.currency ?? data.cpm_currency ?? null;
  const apiCode = Number(data.code ?? data.api_code ?? NaN);
  const resultFlag = data.cpm_result ?? (typeof status === 'string' && status === PAID_STATUS ? PAID_RESULT_FLAG : null);
  return {
    status: typeof status === 'string' ? status.toUpperCase() : null,
    apiCode: Number.isFinite(apiCode) ? apiCode : null,
    resultFlag: typeof resultFlag === 'string' ? resultFlag : null,
    amount: rawAmount === null ? null : Math.round(Number(String(rawAmount).replace(/[^\d.-]/g, ''))),
    currency: typeof currency === 'string' ? currency.toUpperCase() : null,
    operator: data.payment_method ?? data.operator ?? null,
    phone: data.customer_phone_number ?? data.phone_number ?? null,
  };
}

/**
 * Was the money received? Only ever called with a status payload we fetched
 * ourselves. The webhook may arrive twice, and CinetPay's two API generations
 * spell success differently, so the rule is:
 *
 * - **A textual status is authoritative.** `SUCCESS` means paid; anything else
 *   (`PENDING`, `FAILED`, `EXPIRED`, …) means not paid, whatever the numeric
 *   fields say. This ordering is the security-relevant part: in the v1 answer
 *   the API-level `code` is `100` for a *request* that succeeded, on a
 *   transaction that may well have failed — so a `cpm_result` of `'01'` with
 *   `code: 100` must not be read as paid.
 * - **Without a textual status** (v1), both the API code and the result flag
 *   have to agree: code `100` *and* `cpm_result: '00'`.
 */
export function isPaidStatus(status) {
  if (!status) return false;
  if (status.status) return status.status === PAID_STATUS;
  if (status.resultFlag) return status.resultFlag === PAID_RESULT_FLAG && status.apiCode === PAID_API_CODE;
  return false;
}

/**
 * The whole security policy, in one pure function: what should the worker do
 * with this notification? The worker's only job afterwards is to obey.
 *
 * `order` is the stored record (or null), `parsed` the output of
 * `parseNotification`, `status` the output of `readStatusPayload` (or null when
 * the status could not be fetched — a transient failure, which must be retried
 * rather than turned into a refusal).
 */
export function decideDelivery({ order, parsed, status }) {
  if (!order) return { action: 'ignore', reason: 'unknown-order' };
  if (!parsed?.ok) return { action: 'ignore', reason: parsed?.reason || 'unparsable' };
  const { notification } = parsed;

  // A notification for a different order must never credit this one.
  if (notification.merchantTransactionId && notification.merchantTransactionId !== order.reference) {
    return { action: 'ignore', reason: 'not-ours' };
  }
  if (!order.notifyToken || !timingSafeEqual(order.notifyToken, notification.notifyToken)) {
    return { action: 'ignore', reason: 'token-mismatch' };
  }
  if (order.status === 'delivered') return { action: 'duplicate', reason: 'already-delivered' };
  if (order.status === 'refused') return { action: 'ignore', reason: 'already-refused' };

  return moneyVerdict(order, status);
}

/**
 * **The money rule, in one place.** Given a stored order and an *authoritative*
 * CinetPay status answer, may we hand over a licence, and why not if we may not?
 *
 * It is shared deliberately: the webhook (`decideDelivery`) and the
 * reconciliation job (`decideReconciliation`) must never be able to disagree
 * about the same payment, or one path would sell what the other refuses. The
 * rules, in order:
 *
 * - **no status → retry.** A status we could not fetch is a network hiccup, not
 *   a refusal; refusing there would take money and give nothing.
 * - **a textual status is authoritative.** `SUCCESS` is paid; a status in
 *   `FINAL_UNPAID_STATUSES` ends the order, anything else is still coming.
 * - **amount must match exactly.** This is the check that stops a 100 FCFA
 *   payment from buying a 50 000 FCFA licence.
 * - **currency must match** when the operator reports one.
 */
export function moneyVerdict(order, status) {
  // No authoritative answer: ask again rather than decide.
  if (!status) return { action: 'retry', reason: 'status-unavailable' };

  if (!isPaidStatus(status)) {
    const final = status.status && FINAL_UNPAID_STATUSES.includes(status.status);
    return { action: final ? 'reject' : 'retry', reason: final ? 'unpaid' : 'still-pending' };
  }
  if (status.amount === null || Math.round(status.amount) !== Math.round(order.amount)) {
    return { action: 'reject', reason: 'amount-mismatch' };
  }
  if (status.currency && status.currency !== order.currency) {
    return { action: 'reject', reason: 'currency-mismatch' };
  }
  return { action: 'deliver', reason: 'paid' };
}

// ---------------------------------------------------------------------------
// Reconciliation — the safety net under the webhook
// ---------------------------------------------------------------------------

/**
 * How long after creation an order is worth re-asking CinetPay about. A buyer
 * needs minutes to complete a mobile-money payment, so querying sooner only
 * burns API calls on payments that have not happened yet.
 */
export const RECONCILE_GRACE_MS = 10 * 60 * 1000;

/**
 * Should this stored order be re-queried? Only orders that are **still waiting
 * for money** and old enough that the buyer has plausibly finished paying.
 * Everything terminal (`delivered`, `refused`) is left alone — that is what
 * makes the job idempotent and cheap: a finished order is never looked at twice.
 */
export function isReconcilable(order, now, { graceMs = RECONCILE_GRACE_MS } = {}) {
  if (!order || !isOrderReference(order.reference)) return false;
  if (order.status !== 'pending' && order.status !== 'created') return false;
  const created = Date.parse(order.createdAt || '');
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created >= graceMs;
}

/**
 * The reconciliation decision. This path has **no untrusted input at all** — no
 * webhook body, no notify token, nothing the buyer or an attacker can send — so
 * it is strictly safer than the webhook: it starts from an order only *we*
 * stored and asks CinetPay directly what happened.
 *
 * Actions are the webhook's, renamed for a pull: `retry` becomes `wait` (leave
 * the order pending for the next run) and `reject` becomes `refuse` (stamp the
 * order terminal so it is never re-queried).
 */
export function decideReconciliation({ order, status, now = new Date(), graceMs = RECONCILE_GRACE_MS }) {
  if (!order) return { action: 'skip', reason: 'unknown-order' };
  if (order.status === 'delivered') return { action: 'skip', reason: 'already-delivered' };
  if (order.status === 'refused') return { action: 'skip', reason: 'already-refused' };
  if (!isReconcilable(order, now, { graceMs })) return { action: 'skip', reason: 'too-soon' };

  const verdict = moneyVerdict(order, status);
  if (verdict.action === 'deliver') return { action: 'deliver', reason: verdict.reason };
  if (verdict.action === 'reject') return { action: 'refuse', reason: verdict.reason };
  return { action: 'wait', reason: verdict.reason };
}

/**
 * The batch a run should actually query: due orders, oldest first, capped. The
 * cap is what keeps a backlog from blowing through the Worker's CPU budget in
 * one tick — leftovers are simply picked up by the next run.
 */
export function selectReconcilable(orders, now, { graceMs = RECONCILE_GRACE_MS, limit = 50 } = {}) {
  return (orders || [])
    .filter((order) => isReconcilable(order, now, { graceMs }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * When a licence is issued. Defaults to the moment the order was **paid** (the
 * worker stamps `issuedAt` at delivery), falling back to when it was created.
 * Deriving it from the order rather than from the clock is what makes minting
 * and the e-mail agree: the receipt can be regenerated a year later and still
 * state the same expiry date.
 */
export function issueDateOf(order, now) {
  if (now) return now;
  const stamp = order.issuedAt || order.deliveredAt || order.createdAt;
  return stamp ? new Date(stamp) : new Date();
}

/**
 * The licence payload. Same shape the app parses (`src/services/license.ts`):
 * a version, a stable id, the plan, the licensee, the issue date and an optional
 * expiry. `months: null` (the Pro plan) means a licence that never expires.
 *
 * The expiry is the **anniversary rule**: adding 12 months to 2024-02-29 gives
 * 2025-02-28, not 2025-03-01. Naive month arithmetic overflows into the next
 * month (and 31 January + 1 month would land on 3 March), which would silently
 * sell a term shorter than the buyer paid for — so the day is clamped to the
 * last day of the target month.
 */
export function licensePayloadFor(order, now) {
  const issued = issueDateOf(order, now).toISOString().slice(0, 10);
  let expires = null;
  if (order.months) {
    const end = new Date(`${issued}T00:00:00Z`);
    const day = end.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + order.months);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
    expires = end.toISOString().slice(0, 10);
  }
  return {
    v: 1,
    id: order.reference,
    plan: order.plan,
    ...(order.name ? { name: order.name } : {}),
    issued,
    expires,
  };
}

/**
 * Signs a licence key: `BCP1.<base64url payload>.<base64url signature>`, with
 * the raw r||s 64-byte ECDSA P-256 signature WebCrypto produces (not DER —
 * `subtle.verify` in the customer's browser expects exactly this).
 *
 * The private JWK comes from the environment. It is imported once per worker
 * instance and never exported again.
 */
export async function encodeLicenseKey(payload, privateJwk) {
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(payloadB64))
  );
  return `${LICENSE_PREFIX}.${payloadB64}.${toBase64Url(signature)}`;
}

// ---------------------------------------------------------------------------
// The e-mail
// ---------------------------------------------------------------------------

function money(amount, currency) {
  const grouped = String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const label = currency === 'XOF' || currency === 'XAF' ? 'F CFA' : currency;
  return `${grouped} ${label}`;
}

/**
 * The delivery e-mail. It is the **only** place the key is handed over, so it
 * carries everything the buyer needs and nothing else: no tracking pixel, no
 * link that expires, no account to create.
 */
export function receiptEmail(order, licenseKey, config = {}) {
  const brand = config.brand || BRAND;
  const support = config.supportEmail || 'support@example.com';
  const subject = `${brand} — votre clé de licence ${order.planLabel}`;
  // Prefer the expiry stamped at mint time; recomputing is only a fallback, so
  // a re-sent receipt can never invent a different end date.
  const expires = order.expires ?? licensePayloadFor(order).expires;
  const validity = order.months
    ? `Valable ${order.months} mois, jusqu'au ${expires}`
    : 'Licence à vie — sans expiration';

  const lines = [
    ...(order.name ? [`Bonjour ${order.name},`, ''] : []),
    `Merci pour votre achat (${order.reference}).`,
    '',
    `Formule : ${order.planLabel}`,
    `Montant : ${money(order.amount, order.currency)}`,
    validity,
    '',
    'Votre clé de licence :',
    '',
    licenseKey,
    '',
    'Pour l’activer :',
    '1. Ouvrez l’application Budget et Compte.',
    '2. Allez dans Réglages → Offre & licence.',
    '3. Collez la clé, puis appuyez sur « Activer ».',
    '',
    'La clé est vérifiée sur votre téléphone : elle ne quitte jamais l’appareil,',
    'et aucune connexion n’est nécessaire pour l’activer. Conservez ce message :',
    'il est votre seule copie.',
    '',
    `Une question, un problème ? Répondez à ce message ou écrivez à ${support}.`,
    '',
    `— ${brand}`,
  ];

  return {
    subject,
    text: lines.join('\n'),
    html: [
      order.name ? `<p>Bonjour ${escapeHtml(order.name)},</p>` : null,
      `<p>Merci pour votre achat (<strong>${escapeHtml(order.reference)}</strong>).</p>`,
      `<p>Formule : <strong>${escapeHtml(order.planLabel)}</strong><br>`,
      `Montant : <strong>${escapeHtml(money(order.amount, order.currency))}</strong><br>`,
      `${escapeHtml(validity)}</p>`,
      `<p>Votre clé de licence :</p>`,
      `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;padding:12px">${escapeHtml(licenseKey)}</pre>`,
      `<p><strong>Pour l’activer</strong> : ouvrez l’application, puis Réglages → Offre &amp; licence, collez la clé et appuyez sur « Activer ».</p>`,
      `<p style="color:#475569">La clé est vérifiée sur votre téléphone : elle ne quitte jamais l’appareil, et aucune connexion n’est nécessaire pour l’activer. Conservez ce message : il est votre seule copie.</p>`,
      `<p style="color:#475569">Une question ? Écrivez à <a href="mailto:${escapeHtml(support)}">${escapeHtml(support)}</a>.</p>`,
      `<p>— ${escapeHtml(brand)}</p>`,
    ].filter(Boolean).join('\n'),
  };
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * What the buyer's browser is told about an order. Never the key, never the
 * notify token, never the full e-mail address.
 */
export function publicOrderView(order) {
  return {
    reference: order.reference,
    plan: order.plan,
    planLabel: order.planLabel,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    email: maskEmail(order.email),
    deliveredAt: order.deliveredAt ?? null,
  };
}
