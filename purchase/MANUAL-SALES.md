# Manual sales — the no-merchant-account path

Selling Pro without any payment platform: buyers pay your **personal mobile money**,
you mint a signed licence locally and send it to them. The app verifies the key on
the buyer's device, offline — the same cryptographic guarantee as a shop-bought key.

**When to use this:** your default while CinetPay onboarding (KYC, payout setup)
is pending or undesired. The automated shop (`worker.js` + CinetPay) stays in the
repo and comes back the day the merchant account exists — nothing in the app
changes: the buy button appears only when a shop URL is configured, and the
paste-key form is always there.

## 1. Receive the payment

Announce your numbers wherever you sell (WhatsApp, store listing notes, README):

- **Pro** — 5 000 F CFA (XOF), personal licence, lifetime updates
- **Association** — 50 000 F CFA (XOF), tontines/cooperatives, 12 months

Payment channels: your Wave / Orange Money / MTN MoMo number. What you must
collect **with** the payment, before minting anything:

1. The payer's **e-mail** (where the key goes)
2. A **name** to license (« licensed to » line shown in the app)
3. The **plan** they chose

Confirm the received amount matches the plan price **before** step 2 — you are
the payment check now. (The shop's code enforces this; by hand it is discipline.)

## 2. Mint the key (your machine, offline)

The signing key lives at `.freebuff/license-private.jwk.json` (mode 600,
gitignored — **never** copy it anywhere, never commit it; regenerating it
invalidates every licence already sold).

```bash
node scripts/mint-license.mjs --id lic_<handle> --name "Name they gave" --plan pro
# Association plan: add --expires 2027-09-14  (12 months from payment day)
```

- `--id`: stable and unique per buyer (it appears in their app and in your
  ledger); prefix with the month if you sell volume: `lic_202609_amina`.
- Keep the printed `BCP1.…` key (a single line, ~200 chars) — that is the product.

## 3. Deliver

Send the buyer **only the key text** by e-mail (SMS mangles it — too long).
Template:

> Merci pour votre achat de Budget et Compte (Pro) !
> 1. Ouvrez l'app → Réglages → Offre & licence
> 2. Collez la clé ci-dessous dans « Clé de licence » → Activer
>
> <the BCP1.… key>
>
> La clé est vérifiée sur votre appareil, sans compte ni serveur. Gardez ce
> message : la clé réactive Pro après une réinstallation.

## 4. Keep a ledger

One line per sale, in a file you back up **outside** the repo (it links buyers
to identities — private data, and the repo is public):

`date | --id | name | e-mail | plan | amount | channel | transaction ref`

The ledger is your only way to re-issue a key for a reinstated buyer: the app
accepts the same key again at any time, so re-minting with the same `--id`,
name and plan produces a working replacement even if you never stored the key.

## Rules that keep this safe

- The private key file never leaves `.freebuff/`; nothing in this flow ever
  requires sending it to anyone.
- Never mint "on promise" — key goes out **after** the money arrives.
- `--plan pro` keys have no expiry; only association keys take `--expires`.
- The local shop rehearsal (`node purchase/dev-shop.mjs --port 8790`, see the
  main run doc) still exists for testing the automated path end to end without
  real keys.
