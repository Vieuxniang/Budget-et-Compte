# The shop — selling Pro licences by mobile money

One Cloudflare Worker (`worker.js`, logic in `core.js`, pages in `site/`) that
sells the licence and **e-mails the key**. The app itself never talks to it: the
buyer activates the key on their phone, offline, exactly as before.

```
buyer                 worker (this folder)                 CinetPay
  │  POST /api/checkout │                                     │
  ├────────────────────►│  POST /v2/payment ─────────────────►│
  │                     │◄─ payment_url + notify_token        │
  │◄─ payment URL ──────┤  (order stored, status: pending)    │
  │  pays on CinetPay's page ──────────────────────────────►  │
  │                     │◄─ POST /api/notify (notify_token) ──┤
  │                     │  POST /v2/payment/check ──────────► │  ← authoritative
  │                     │◄─ SUCCESS, 5 000 XOF ───────────────┤
  │◄─ e-mail: BCP1.… ───┤  (order stored, status: delivered)  │
```

## The one rule

**`LICENSE_PRIVATE_JWK` never leaves this Worker.** A licence is minted exactly
once, here, after CinetPay itself has confirmed the exact amount. The app ships
only the public key, which verifies but cannot sign. If that secret leaks, the
only fix is to generate a new keypair — which invalidates every licence already
sold (`README` in the project root, section “Rotating the signing key”).

## Policy, in one place

Everything decidable is pure and unit-tested in `core.js`:

- prices and durations come from `PLANS`, never from the request body;
- the webhook must carry the `notify_token` stored with the order (constant-time
  compare) *and* name our order;
- the amount and currency are read from an **authoritative re-query**
  (`/v2/payment/check`) — never from the webhook body;
- an explicit textual status overrules numeric codes: in the v1 API `code: 100`
  means the *request* succeeded, and a `cpm_result` of `'01'` on such a response
  must not be read as paid (pinned by a test);
- a repeated notification sends **no second e-mail**, and minting is
  deterministic anyway (same order ⇒ same key), so a retry cannot produce two
  different licences;
- an unreachable CinetPay means *retry* (503), never *refuse*: a paying customer
  must not lose their licence to a transient failure.

## The safety net under the webhook

A webhook can be **lost**: CinetPay's retries stop after a while, and a deploy
that happens to land on the callback means the notification is simply gone —
while the buyer's money has already left their account. So the Worker also runs
on a schedule (`[triggers]` in `wrangler.toml`, every 15 minutes):

```
buyer          worker (cron)                        CinetPay
  │  pays ────────────────────────────────────────────►│
  │                     │  POST /v2/payment/check ───►│  ← asks, does not wait
  │                     │◄─ SUCCESS, 5 000 XOF ───────┤
  │◄─ e-mail: BCP1.… ───┤  (same delivery path: mint, mail, then stamp)
```

The job is deliberately dull, because it guards the money:

- it only looks at orders **still waiting for money** and older than a 10-minute
  grace period — that is what makes it cheap and idempotent, and why a finished
  order is never queried twice;
- it **cannot** read the notify token, and needs none: it starts from an order
  only we stored and asks CinetPay directly, so this path has *no untrusted input
  at all* — it is strictly safer than the webhook;
- it shares **one** money rule with the webhook (`moneyVerdict`): paid, exact
  amount, right currency — or no licence. The two paths can never disagree;
- a status it could not fetch (or a payment still in flight) means *wait*, never
  *deliver*: money is never assumed;
- a terminal status ends the order, so a failed or expired payment is not
  re-queried forever;
- one order failing (a mail outage, say) never aborts the run; it is counted and
  left pending for the next tick.

The Worker itself sends nothing to the buyer, so the app's “100 % local” promise
is untouched: this is server-to-server.

## Setup

```bash
cd purchase
npx wrangler kv namespace create ORDERS     # paste the id into wrangler.toml
```

Then, in the CinetPay dashboard, set the notification URL to
`https://<your-host>/api/notify` (it must equal `PUBLIC_BASE_URL` in
`wrangler.toml` — CinetPay retries any non-2xx, which is what makes a mail outage
self-heal). Secrets are set once and never written to a file:

```bash
npx wrangler secret put CINETPAY_API_KEY
npx wrangler secret put CINETPAY_SITE_ID
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put LICENSE_PRIVATE_JWK      # paste .freebuff/license-private.jwk.json as ONE line
npx wrangler deploy
```

Verify the deployment before selling anything:

```bash
curl -s https://<your-host>/health
# {"ok":true,"ready":true,"missing":[]}
```

`ready:false` lists what is missing — fix that before announcing the price to
anyone.

**Current sandbox deployment (Phase 3, 2026-09-13):** live at
`https://budget-et-compte-shop.vieuxn33.workers.dev` with placeholder
`*.example` URLs and the sandbox sender (`onboarding@resend.dev`, see the
toml); `/health` reports `ready:false` pending the three operator keys
(CINETPAY_API_KEY, CINETPAY_SITE_ID, RESEND_API_KEY) — `LICENSE_PRIVATE_JWK`
and the KV namespace (`c701156ba0784da9838433d38e184224`) are already in.
`wrangler` is a devDependency of the repo, so run these commands from
`purchase/` with the project's own copy (`npx wrangler …`).

## Local dry run

```bash
cd purchase
npx wrangler dev            # http://127.0.0.1:8787 — pages and API on one origin
npx wrangler dev --test-scheduled   # then: curl 'http://127.0.0.1:8787/__scheduled'
```

Set `EMAIL_PROVIDER = "none"` (in `wrangler.toml`) to print the receipt to the
console instead of sending it: the whole flow — including the minted key — is then
observable without a mail account. Use CinetPay's sandbox keys and their test
numbers for the payment step.

The pages accept `?api=https://…` to point at another origin, which is how they
are checked against a local worker while served by Vite.

## Tests

```bash
npx vitest run tests/purchase.test.ts tests/purchaseWorker.test.ts
```

The suites run the whole shop against a fake CinetPay, a fake KV and a fake mail
API — no network, no real key material (a throwaway P-256 pair per test, verified
against the app's own `verifyLicenseKey`). Spoofed tokens, underpaid amounts,
wrong currency, repeated notifications, an unreachable operator, a failing mail
provider and an XSS attempt in the buyer's name all have a case.

The reconciliation job has its own: a paid order the webhook never reported is
delivered, an underpayment is refused, an unreachable operator leaves the order
untouched, a second run delivers nothing more, a mail outage keeps the order
pending so the next run rescues it, the KV cursor is walked across pages, and one
test feeds a key minted *by the cron* to the app's own verifier.

## Operations

```bash
# Orders, with status (metadata): no value reads
npx wrangler kv key list --namespace-id <id> --prefix order:

# The cron's own log lines are the audit trail of the safety net:
#   [cron] {"checked":2,"delivered":1,"refused":0,"waiting":1,"skipped":0,"failed":0}
#   [reconcile:delivered] BC2026… licence BC2026… key BCP1.eyJ2Ijo… (paid)
#   [reconcile:failed]    BC2026… smtp down        ← stays pending, retried next tick

# Resend a key by hand (the buyer lost the e-mail). This is the *same* command
# used for manual sales — it signs with the private key on your machine.
node ../scripts/mint-license.mjs --id BC20260912K7F3Q9M2 --name "Kofi Mensah" --plan pro
```

A licence issued by hand and one issued by the Worker are byte-compatible: both
are `BCP1.<base64url payload>.<raw r||s ECDSA P-256 signature>`.

## Getting paid

The buyer's Wave/Orange Money payment never lands directly in a personal
wallet. The flow has two hops:

1. **Buyer → CinetPay balance.** Every checkout (Wave, Orange Money,
   MTN/Moov, card) credits the *merchant* CinetPay account the keys in this
   repo are bound to. This hop is what makes licence delivery automatic:
   the notification webhook and the 15-minute cron both key off CinetPay's
   own record of the payment. Taking payments outside the gateway (a
   personal Wave number, cash) produces money but no webhook — the order
   stays pending and no key is minted.
2. **CinetPay balance → you.** Withdraw from the merchant dashboard to a
   Mobile Money wallet or a bank account. Fees, minimum amounts and
   settlement delays vary by country and method — confirm the current
   numbers in the dashboard before pricing decisions.

**Register the payout destination during KYC** (the same merchant
validation that unlocks production `CINETPAY_API_KEY`/`SITE_ID`): add the
wallet number and/or bank details then, so the first withdrawal is one
click instead of a support ticket.

Sandbox tests move no real money in either direction — the balance only
exists once production keys are live and a real checkout completes.

Refunds are the mirror image and are deliberately manual — see below.

## CinetPay signup & KYC — one-pass checklist

Sequence the four phases in order; each clears the rejection cause of the one
after it.

**Phase 0 — documents before the form** (clean color scans, name-matched):

- [ ] Registre de commerce (sole trader: CNI + activity description via the
      E-Shop track — confirm which track fits at signup)
- [ ] Pièce d'identité du responsable légal (CNI/passport, matching the account)
- [ ] RIB / wallet details **in the same name** — the #1 silent KYC mismatch
- [ ] Useful extras: proof of address, live site URL (see Phase 1)

**Phase 1 — account creation** (`panel.cinetpay.net/demande-compte`, 3–4 steps):

- [ ] Real legal identity; e-mail you monitor (validation lands there)
- [ ] Activity: "vente de licences logicielles (application Budget et Compte)"
- [ ] Declare the site URL — **register the domain first**: a live
      `https://budgetetcompte.ci` passes review; github.io invites rejection
      (domain steps: the run doc's domain go-live checklist)
- [ ] Sandbox `API_KEY`/`SITE_ID` issued immediately (Intégration) — grab them

**Phase 2 — KYC + payout + production in ONE request:**

- [ ] Upload the Phase 0 documents
- [ ] Register the payout destination (wallet and/or bank) in the same pass —
      see "Getting paid" above; first withdrawal becomes one click
- [ ] Ask the onboarding contact explicitly for production activation, webhook
      capability, and written payout fees/minimums/delays for your country
- [ ] Validation typically 1–3 business days → run Phase 3 while waiting

**Phase 3 — sandbox rehearsal while validation waits** (see Setup above):

- [ ] Sandbox keys set as secrets (`wrangler secret put`, never the toml), KV
      namespace wired, deploy
- [ ] `curl /health` → `ready:true`
- [ ] Full rehearsal from the app UI: buy → checkout → simulated payment →
      mailbox → key → Pro unlocked. Validation day is then a key-swap, not a
      debugging session

**Phase 4 — validation lands (go live):**

- [ ] Swap the two CinetPay secrets for production values — the API host is
      identical, nothing else changes
- [ ] Dashboard: notification URL = `https://licence.budgetetcompte.ci/api/notify`
      (= `PUBLIC_BASE_URL`; CinetPay retries non-2xx, which self-heals mail
      outages)
- [ ] `curl /health`, then the run doc's go-live sequence: `SHOP_URL` variable →
      buy button on the live PWA → one real test purchase

**Rejection causes to preempt:** (1) name mismatch across CNI / wallet / RIB /
account; (2) declared site dead or under construction — domain before KYC;
(3) activity description not matching what buyers are charged for.

## Not covered, deliberately

- **No account, no password**: the e-mail address is the only identifier, so a
  shared mailbox means a shared licence. The key can be removed from a device at
  any time in Réglages → Offre & licence.
- **No refund flow**: a refund is handled in the CinetPay dashboard plus a manual
  licence revocation (replace the keypair, or accept the key until it expires).
  Automating it needs a revocation list, which would need the app to phone home —
  against the product's promise.
- **KV is eventually consistent**: two simultaneous notifications for one order
  could both deliver. Harmless here, because minting is deterministic (same key,
  at most one extra e-mail). If that ever stops being true, move the order record
  to a Durable Object for a real compare-and-set.
