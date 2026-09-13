/**
 * Local rehearsal of the whole shop — no wrangler, no Cloudflare account, no
 * network. It serves `site/`, routes `/api/*` through the **real** worker, and
 * simulates the two outside parties the worker talks to:
 *
 *   - **CinetPay**, including the payment page the buyer is redirected to
 *     (`/payer`), which posts the notification back exactly as the operator
 *     would — same field names, same form encoding;
 *   - **the mail provider**, writing each receipt (key included) to
 *     `.freebuff/shop-mailbox.json` and exposing it at `/dev/mail` so the minted
 *     key can be read from a browser and pasted into Réglages → Offre.
 *
 * Three outcomes are available on the payment page, because they are the three
 * paths that matter: success (delivers), failure (refuses, no key) and pending
 * (the notification must ask to be called again, and the confirmation page keeps
 * polling). Pending can be settled afterwards by paying again on the same page.
 *
 * Usage:
 *   node purchase/dev-shop.mjs [--port 8790]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileOrders, route } from './worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, 'site');
const PROJECT_ROOT = path.resolve(HERE, '..');
const MAILBOX = path.join(PROJECT_ROOT, '.freebuff', 'shop-mailbox.json');
const PRIVATE_JWK = path.join(PROJECT_ROOT, '.freebuff', 'license-private.jwk.json');

const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT || 8790);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// The two fake outside parties
// ---------------------------------------------------------------------------

/** Order records, exactly the JSON the worker stores in KV. */
const orders = new Map();

const orderMeta = new Map();

const kv = {
  async get(key, type) {
    const value = orders.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  },
  async put(key, value, options = {}) {
    orders.set(key, value);
    if (options.metadata) orderMeta.set(key, options.metadata);
  },
  /** KV's `list`: keys with their metadata, which is what the cron filters on. */
  async list({ prefix = '', cursor } = {}) {
    const names = [...orders.keys()].filter((name) => name.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = names.slice(start, start + 100);
    const next = start + 100;
    return {
      keys: page.map((name) => ({ name, metadata: orderMeta.get(name) })),
      list_complete: next >= names.length,
      cursor: String(next),
    };
  },
};

/** What the simulated operator will answer for a reference. */
const outcomes = new Map();

const receipts = [];

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Stands in for `fetch` inside the worker. Everything it returns mirrors
 * CinetPay's documented shapes, **including the v1 quirk** that `code: 100` means
 * the request succeeded rather than the payment.
 */
const fakeFetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : null;

  if (url.includes('/payment/check')) {
    const stored = orders.get(`order:${body.transaction_id}`);
    const order = stored ? JSON.parse(stored) : null;
    const outcome = outcomes.get(body.transaction_id) || 'success';
    const codes = { success: 100, pending: 2002, fail: 2010 };
    return jsonResponse({
      code: codes[outcome],
      message: outcome === 'success' ? 'OK' : 'NOT PAID',
      data: {
        status: outcome === 'success' ? 'SUCCESS' : outcome === 'pending' ? 'PENDING' : 'FAILED',
        amount: order?.amount ?? 0,
        currency: order?.currency ?? 'XOF',
        payment_method: 'WAVE_SN',
      },
    });
  }

  if (url.includes('/v2/payment')) {
    // The buyer is sent to our own simulated operator page.
    const destination = `${ORIGIN}/payer?ref=${encodeURIComponent(body.transaction_id)}`;
    console.log(`[fake-cinetpay] init ${body.transaction_id} → ${body.amount} ${body.currency}`);
    return jsonResponse({
      code: '201',
      message: 'CREATED',
      data: { payment_url: destination, payment_token: `ptok_${Date.now()}`, notify_token: 'ntok_dev_1' },
    });
  }

  if (url.includes('resend.com')) {
    receipts.push({ at: new Date().toISOString(), to: body.to?.[0], subject: body.subject, text: body.text });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(MAILBOX, JSON.stringify(receipts, null, 2));
    const key = (body.text || '').match(/BCP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] || '';
    console.log(`\n[mail] → ${body.to?.[0]}\n${key}\n`);
    return jsonResponse({ id: `mail_${receipts.length}` });
  }

  throw new Error(`unexpected fetch: ${url}`);
};

const env = {
  CINETPAY_API_KEY: process.env.CINETPAY_API_KEY || 'sk_test_local',
  CINETPAY_SITE_ID: process.env.CINETPAY_SITE_ID || '123456',
  PUBLIC_BASE_URL: ORIGIN,
  SITE_URL: `${ORIGIN}/index.html`,
  EMAIL_FROM: process.env.EMAIL_FROM || 'licences@example.test',
  RESEND_API_KEY: 're_test_local',
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || 'aide@example.test',
  EMAIL_PROVIDER: 'resend',
  ALLOWED_ORIGINS: '',
  ORDERS: kv,
};

async function loadPrivateKey() {
  try {
    env.LICENSE_PRIVATE_JWK = await readFile(PRIVATE_JWK, 'utf8');
    console.log(`[key] signing with ${PRIVATE_JWK}`);
  } catch {
    console.error(
      '[key] no private key found — run `node scripts/license-keygen.mjs` first.\n' +
        '      The shop cannot mint a licence without it.',
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function html(body, status = 200) {
  return { status, type: 'text/html; charset=utf-8', body };
}

function page(title, inner) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/styles.css"></head>
<body><main>${inner}</main></body></html>`;
}

/** The simulated operator page — where a real buyer would land on CinetPay. */
function payerPage(reference, message = '') {
  const stored = orders.get(`order:${reference}`);
  const order = stored ? JSON.parse(stored) : null;
  if (!order) {
    return page('Commande inconnue', `<div class="card"><h1>Commande inconnue</h1>
      <p class="lead">Aucune commande ${reference}.</p>
      <p><a href="/index.html">Retour</a></p></div>`);
  }
  return page(`Simulation CinetPay — ${reference}`, `
    <header class="brand"><p class="brand-name">Simulation CinetPay</p>
    <h1>Payer ${order.amount} ${order.currency}</h1>
    <p class="lead">Commande <span class="mono">${reference}</span> · ${order.planLabel}</p></header>
    ${message ? `<div class="alert">${message}</div>` : ''}
    <section class="card"><h2>Choisissez le résultat</h2>
      <form method="post" action="/payer">
        <input type="hidden" name="ref" value="${reference}">
        <div class="choices">
          <label class="choice"><input type="radio" name="outcome" value="success" checked>
            <span><strong>Wave — paiement accepté</strong><span class="meta">La clé doit partir par e-mail.</span></span></label>
          <label class="choice"><input type="radio" name="outcome" value="pending">
            <span><strong>Paiement en attente</strong><span class="meta">L'opérateur ne confirme pas encore : la notification doit demander à être rappelée.</span></span></label>
          <label class="choice"><input type="radio" name="outcome" value="fail">
            <span><strong>Paiement refusé</strong><span class="meta">Aucune clé ne doit être émise.</span></span></label>
        </div>
        <button class="primary" type="submit">Envoyer la notification</button>
      </form>
    </section>
    <footer class="legal"><p><a href="/dev/mail">Boîte aux lettres de test</a> · <a href="/index.html">Accueil</a></p></footer>`);
}

async function handlePayerPost(form) {
  const reference = form.get('ref') || '';
  const outcome = form.get('outcome') || 'success';
  const stored = orders.get(`order:${reference}`);
  if (!stored) return html(page('Commande inconnue', '<div class="card"><h1>Commande inconnue</h1></div>'));

  const order = JSON.parse(stored);
  outcomes.set(reference, outcome);

  // This is the operator calling our webhook: same fields, form-encoded, exactly
  // as CinetPay v2 posts it. The worker must not trust it for anything but the
  // transaction identity.
  const notification = new URLSearchParams({
    notify_token: order.notifyToken || '',
    transaction_id: `cinet_${reference}`,
    merchant_transaction_id: reference,
    cpm_amount: String(order.amount),
    cpm_currency: order.currency,
  });
  const answer = await route(
    new Request(`${ORIGIN}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: notification,
    }),
    env,
    { fetchImpl: fakeFetch, now: new Date() },
  );
  const payload = await answer.json().catch(() => ({}));
  console.log(`[notify ${outcome}] ${reference} → ${answer.status} ${JSON.stringify(payload)}`);

  // A real CinetPay page then returns the buyer to `return_url`.
  return { redirect: `${ORIGIN}/thanks.html?ref=${encodeURIComponent(reference)}` };
}

function mailboxPage() {
  const items = receipts.length
    ? receipts.map((receipt) => {
        const key = (receipt.text || '').match(/BCP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] || '';
        return `<section class="card"><h2>${receipt.subject}</h2>
          <p class="lead">${receipt.to} · ${receipt.at}</p>
          <p class="mono" id="key-${receipts.indexOf(receipt)}">${key}</p></section>`;
      }).join('')
    : '<div class="card"><p class="lead">Aucun e-mail émis pour le moment.</p></div>';
  return page('Boîte aux lettres de test', `
    <header class="brand"><p class="brand-name">Boîte aux lettres de test</p>
    <h1>Clés émises</h1>
    <p class="lead">Copiez une clé et collez-la dans l'application : Réglages → Offre &amp; licence → Activer.</p></header>
    ${items}
    <footer class="legal"><p><a href="/index.html">Accueil</a></p></footer>`);
}

async function serveStatic(url) {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(SITE, relative);
  if (!file.startsWith(SITE)) return { status: 403, type: 'text/plain', body: 'forbidden' };
  try {
    const body = await readFile(file);
    return { status: 200, type: MIME[path.extname(file)] || 'application/octet-stream', body };
  } catch {
    return { status: 404, type: 'text/plain; charset=utf-8', body: 'introuvable' };
  }
}

async function handle(request) {
  const url = new URL(request.url, ORIGIN);

  if (url.pathname.startsWith('/api/')) {
    // The real worker, with only its outside world swapped for fakes.
    return route(request, env, { fetchImpl: fakeFetch, now: new Date() });
  }
  if (url.pathname === '/health') return route(request, env, {});

  if (url.pathname === '/payer') {
    if (request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      const result = await handlePayerPost(form);
      return result;
    }
    return html(payerPage(url.searchParams.get('ref') || ''));
  }
  if (url.pathname === '/dev/mail') return html(mailboxPage());

  // Development-only controls, and two of the three things they exist for are
  // rehearsals of real failures: a payment the operator took while our webhook
  // was never delivered, and the cron tick that is supposed to catch it.
  if (url.pathname === '/dev/paid') {
    // The operator has the money; the notification is the part that goes
    // missing (a deploy during the callback, retries exhausted).
    const reference = url.searchParams.get('ref') || '';
    const outcome = url.searchParams.get('outcome') || 'success';
    if (!orders.has(`order:${reference}`)) return jsonResponse({ ok: false, error: 'order-not-found' }, 404);
    outcomes.set(reference, outcome);
    console.log(`[dev] ${reference} paid at the operator (${outcome}) — the notification was NOT sent`);
    return jsonResponse({ ok: true, reference, outcome, notified: false });
  }
  if (url.pathname === '/dev/reconcile') {
    const summary = await reconcileOrders(env, {
      fetchImpl: fakeFetch,
      now: new Date(),
      // The real job waits out the payment; a rehearsal should not.
      graceMs: Number(url.searchParams.get('grace') ?? 0),
    });
    console.log('[dev:cron]', JSON.stringify(summary));
    return jsonResponse({ ok: true, summary });
  }

  return serveStatic(url);
}

// ---------------------------------------------------------------------------

await loadPrivateKey();

const server = createServer(async (req, res) => {
  let result;
  try {
    result = await handle(new Request(`${ORIGIN}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? await readBody(req) : undefined }));
  } catch (error) {
    console.error('[dev-shop:error]', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('dev-shop error');
    return;
  }

  if (result?.redirect) {
    res.writeHead(303, { Location: result.redirect });
    res.end();
    return;
  }
  // `/api/*` is served by the real worker, which answers with a `Response`;
  // the harness's own pages answer with a plain object. Normalize both.
  if (result instanceof Response) {
    result = {
      status: result.status,
      type: result.headers.get('content-type') || 'application/octet-stream',
      body: Buffer.from(await result.arrayBuffer()),
    };
  }
  res.writeHead(result.status, { 'Content-Type': result.type });
  res.end(result.body);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Boutique locale sur ${ORIGIN}/`);
  console.log(`  Clés émises      : ${ORIGIN}/dev/mail`);
  console.log(`  Boîte aux lettres: ${MAILBOX}\n`);
});
