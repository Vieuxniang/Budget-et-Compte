# Manual sales — the no-merchant-account path

Selling Pro without any payment platform: buyers pay your **personal mobile money**,
you mint a signed licence locally and send it to them. The app verifies the key on
the buyer's device, offline — the same cryptographic guarantee as a shop-bought key.

**When to use this:** your default while CinetPay onboarding (KYC, payout setup)
is pending or undesired. The automated shop (`worker.js` + CinetPay) stays in the
repo and comes back the day the merchant account exists — nothing in the app
changes: the buy button appears only when a shop URL is configured, and the
paste-key form is always there.

## The announcement (post where your buyers are)

Ready-to-post template. Fill the two placeholders — the payment number and the
contact — and nothing else; the prices and feature gates below are the app's real
ones, so the post never promises more than the build delivers. Re-post the same
text everywhere and update it in this file first, so every channel says the same
thing.

> *Budget et Compte* — gérez l'argent de votre famille en toute confidentialité 📱
>
> 100% local : vos données restent chiffrées sur votre téléphone (AES-256).
> Sans compte, sans publicité, fonctionne hors ligne. La synchronisation
> multi-appareils est optionnelle et chiffrée de bout en bout.
>
> ✅ Comptes bancaires, espèces, Mobile Money (Wave, Orange Money, MTN MoMo)
> ✅ Budget mensuel par catégorie, alertes de dépassement, export CSV
> ✅ Épargne par objectifs · tontines & associations · packs pays (SN, CI, CM, BF, ML)
> ✅ Français / English / Español — FCFA, Dollar, Euro…
>
> 📲 *Installation gratuite* : ouvrez https://vieuxniang.github.io/Budget-et-Compte/
> puis « Ajouter à l'écran d'accueil ».
>
> ⭐ *PRO — 5 000 F, un seul paiement (à vie)*
> • 25 objectifs d'épargne (1 en version gratuite)
> • Tous les packs pays (1 offert)
> • 1 tontine
>
> 🤝 *ASSOCIATION — 50 000 F / an*
> • 25 tontines (jusqu'à 200 membres chacune) + tous les packs pays
>
> *Comment obtenir Pro :*
> 1️⃣ Payez par Wave / Orange Money / MTN MoMo au *+221 XX XXX XX XX*
> 2️⃣ Envoyez la capture + votre e-mail + votre nom à *vieuxn33@gmail.com*
> 3️⃣ Recevez votre clé de licence par e-mail, dès confirmation du paiement
> 4️⃣ Dans l'app : Réglages → Offre & licence → collez la clé → Activer
>
> La clé s'active sur votre appareil, sans compte ni serveur. Gardez l'e-mail :
> elle réactive Pro après une réinstallation. Questions ? *vieuxn33@gmail.com*

English one-liner for mixed-language groups:

> *Budget et Compte* — 100% local family finance (encrypted on your phone, no
> account, works offline). Pro: 5,000 F once — 25 savings goals, all country
> packs, tontine. Pay Wave/Orange Money to *+221 XX XXX XX XX*, e-mail your
> receipt to *vieuxn33@gmail.com*, get your licence key by e-mail, paste it in
> the app. https://vieuxniang.github.io/Budget-et-Compte/

The install URL is the github.io one until `budgetetcompte.ci` delegates — when
the domain lands, update this template, the WhatsApp post and the store listing
together (one release, per the listing consistency rule).

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

## 5. Revoking a key (refund, dispute, leaked demo key)

Licences never expire on their own, so the only way to stop a key from
unlocking Pro is to revoke it by id. The id lands in an embedded list
(`src/services/revocations.json`) that ships with the next app build — every
device re-checks its licence against the list on every boot, so revocation
takes effect at each buyer's next app update, still fully offline.

```bash
node scripts/revoke-license.mjs lic_aymeric      # add to the list
node scripts/revoke-license.mjs --undo lic_aymeric   # only for a genuine mistake
```

- `mint-license.mjs` refuses a revoked id — a refunded licence cannot be
  re-sold by re-minting the same id (issue the replacement under a fresh id).
- The buyer's app shows « Cette clé a été résiliée par l’éditeur » and drops
  back to the free limits; their data is untouched.
- **Never revoke an id to "test"** — the demo dry run uses a throwaway id
  instead (`lic_dryrun_demo` was revoked for exactly that reason: its key text
  was published during the sale rehearsal).

### When the buyer contests (one-tap support link)

A wrongly-revoked buyer sees a **« Contacter le support »** button right under
the revoked message: a `mailto:` to the support inbox (default
`vieuxn33@gmail.com`, build-time override `VITE_SUPPORT_EMAIL`; an empty
override disables the contact) with the subject
« Clé résiliée (<id>) — contestation » — the id makes the exchange unambiguous.
On your side: check the ledger, `--undo` the id if the revocation was a genuine
mistake, and ship the next build — the key re-verifies at the buyer's next app
update.

## Rules that keep this safe

- The private key file never leaves `.freebuff/`; nothing in this flow ever
  requires sending it to anyone.
- Never mint "on promise" — key goes out **after** the money arrives.
- `--plan pro` keys have no expiry; only association keys take `--expires`.
- The local shop rehearsal (`node purchase/dev-shop.mjs --port 8790`, see the
  main run doc) still exists for testing the automated path end to end without
  real keys.
