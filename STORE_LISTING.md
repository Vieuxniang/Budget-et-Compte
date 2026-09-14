# Budget et Compte — Store Listing (Play Store / App Store)

Deploy-ready copy for the app **Budget et Compte** (local-first family finance app).
The brand is a French proper name: it is **not translated**, so the fr/en/es
listings below all ship it unchanged.
Facts in this listing are verified against the app: 100% local storage, AES-GCM-256
encrypted vault, Wave / Orange Money / MTN MoMo support, monthly budget, CSV export,
encrypted backups, trilingual UI, multi-currency.
Honesty rule (applies to every variant below): the **optional** multi-device sync is
the one feature that touches a server, and it is end-to-end encrypted — the relay
only ever stores ciphertext. Never write "no server" / "nothing leaves your device"
without that exception (same rule as the in-app About screen and the decision log).

---

## Identity

- **App name:** Budget et Compte
- **Tagline (FR):** Gestion financière familiale — comptes, budget & épargne
- **Category:** Finance
- **Default language:** Français (EN/ES built-in)
- **Free (Pro is a one-time upgrade), no account required, no ads**

### Pro & Association (in-app upgrade)

The app is fully usable free; Pro is a **one-time** 5 000 F CFA purchase and
Association an annual 50 000 F CFA plan, unlocked by a licence key that the app
verifies **on the device** (no account, no server):

| Offer | Price | Unlocks |
|---|---|---|
| **Pro** | 5 000 F CFA, once | 25 savings goals (1 free), all country packs (1 free), 1 tontine |
| **Association** | 50 000 F CFA / year | 25 tontines (up to 200 members each) + all country packs |

Sales are currently **manual**: pay by Wave / Orange Money / MTN MoMo to the
publisher's number, e-mail the receipt to `vieuxn33@gmail.com`, and the licence
key comes back by e-mail (runbook: `purchase/MANUAL-SALES.md`). The paste-key
form lives in Réglages → Offre & licence and works offline. The automated
mobile-money checkout returns when the merchant account is live; store copy
about the *purchase channel* changes then — the gates and prices above are the
app's real ones and only change with a release.

---

## Web app (PWA)

- **Canonical URL (target):** `https://budgetetcompte.ci` — the apex is canonical, `www` 301s to it. This is the intended listing URL and the domain the PWA manifest `id` is pinned to (see `vite.config.ts`). **Until the .ci registration clears registry validation** (registry state verified 2026-09-13: NXDOMAIN at `any.nic.ci`, whois "No Object Found" — re-check with `scripts/domain-status.sh`), **the PWA actually serves at `https://vieuxniang.github.io/Budget-et-Compte/`**; the listing URL goes live with the domain wiring pass (`scripts/custom-domain.sh`).
- **Install:** open the URL on a phone or desktop browser → « Ajouter à l'écran d'accueil » / « Installer ».
- **Listing consistency rule:** the web listing must carry the same brand, tagline and honesty rules as the store listings; feature claims change in the same release everywhere.

---

## Play Store

### Short description (≤ 80 chars — 73 used)

```
Budget et Compte — gestion 100% locale : dépenses, épargne, Mobile Money.
```

### Full description (FR)

> **Budget et Compte — Gestion financière familiale 100% locale**
>
> Vos finances familiales, en toute confidentialité. Budget et Compte gère vos
> comptes et votre budget **entièrement sur votre téléphone** : aucune création de
> compte obligatoire, aucune publicité. Vos données restent chiffrées sur votre
> appareil — et si vous activez la synchronisation multi-appareils (optionnelle),
> elles voyagent chiffrées de bout en bout : le serveur ne voit que du chiffré.
>
> **Comptes & portefeuilles**
> - Comptes bancaires, épargne, espèces et crédit
> - Portefeuilles Mobile Money : **Wave, Orange Money, MTN MoMo**
> - Soldes recalculés automatiquement à chaque opération
>
> **Suivi des dépenses**
> - Enregistrez revenus, dépenses et virements en quelques secondes
> - Filtres par compte, membre, catégorie et mois
> - Export CSV de vos opérations
>
> **Budget familial**
> - Budget mensuel par catégorie : logement, alimentation, scolarité, transport…
> - Détection des dépassements et des dépenses hors budget
> - Graphiques clairs : alloué vs dépensé
>
> **Épargne & tontine**
> - Objectifs d'épargne avec suivi de progression
> - Module tontine / association : membres, parts, tours de versement, reçus
>   (1 groupe avec Pro, 25 avec l'offre Association)
>
> **Packs pays**
> - Fiscalité salariale, frais de scolarité et modèles de budget par pays
>   (Sénégal, Côte d'Ivoire, Cameroun, Burkina, Mali) — 1 pack offert, tous avec Pro
>
> **Sécurité maximale**
> - Chiffrement AES-GCM 256 — illisible sans votre mot de passe
> - Verrouillage automatique de la session
> - Sauvegardes exportables (JSON, ou chiffrées avec votre propre phrase secrète)
>
> **Pratique au quotidien**
> - Français, English, Español — changement de langue instantané
> - Devises : FCFA (XOF, XAF), Dollar, Euro et 16 autres, détectées selon votre région
> - Thème sombre ou clair
> - Synchronisation multi-appareils optionnelle, chiffrée de bout en bout
> - Fonctionne hors ligne — installez-la comme une application
>
> Gérez l'argent de votre famille sans le confier à personne.

**Keywords to weave into the body** (Play indexes the description text; the FR
description above already contains them): budget familial, gestion financière,
suivi des dépenses, épargne, comptes, Mobile Money, Wave, Orange Money, MTN MoMo,
famille, FCFA, hors ligne, confidentialité.

---

## App Store

- **Subtitle (≤ 30 chars — 26 used):** `Budget familial 100% local`
- **Keywords field (≤ 100 chars — 96 used):**
  ```
  budget, comptes, épargne, dépenses, Mobile Money, Wave, Orange Money, MTN MoMo, famille, finance
  ```

### Description (FR — App Store style)

> **Budget et Compte** garde vos finances familiales 100% locales : chiffrées sur
> votre téléphone, sans compte ni serveur. Suivez vos comptes bancaires et vos
> portefeuilles Mobile Money (Wave, Orange Money, MTN MoMo), enregistrez dépenses,
> revenus et virements, et pilotez un budget mensuel par catégorie avec alertes de
> dépassement.
>
> Vos données sont protégées par chiffrement AES-GCM 256 et un verrouillage
> automatique ; vous pouvez exporter des sauvegardes, en clair ou chiffrées.
> L'application fonctionne hors ligne, passe du sombre au clair, parle Français,
> English et Español, et s'adapte à votre devise (FCFA, Dollar, Euro…).

---

## Localized variants (short, for stores without full-FR listing)

### English

> **Budget et Compte** keeps your family finances 100% local — encrypted on your
> phone, no account required, no ads. Track bank accounts and Mobile Money wallets
> (Wave, Orange Money, MTN MoMo), log expenses, income and transfers, manage a
> monthly budget per category with overspend alerts, save towards goals, run a
> tontine, and install country packs (payroll, school fees, budget templates).
> AES-GCM-256 encryption, auto-lock, plain or encrypted backups, works offline,
> dark/light themes, multi-currency, and Français / English / Español. Optional
> multi-device sync is end-to-end encrypted — the server only ever sees ciphertext.

### Español

> **Budget et Compte** mantiene las finanzas familiares 100% locales — cifradas en
> su teléfono, sin cuenta obligatoria ni anuncios. Controle cuentas bancarias y
> billeteras Mobile Money (Wave, Orange Money, MTN MoMo), registre gastos, ingresos
> y transferencias, y gestione un presupuesto mensual por categoría con alertas de
> exceso. Cifrado AES-GCM-256, bloqueo automático, copias de seguridad cifradas,
> funciona sin conexión, temas claro/oscuro y multi-moneda. La sincronización
> opcional entre dispositivos está cifrada de punta a punta: el servidor solo ve
> datos cifrados.

---

## Deploy notes

- Keep the listing honest: if features change (e.g. a savings-goals screen ships),
  update the description in the same release. The one-server-touch rule is fixed:
  optional E2E-encrypted sync is always named as the exception (see the honesty
  rule at the top).
- Play short description and App Store subtitle both fit under their limits —
  re-verify after any wording change.
- The built-in PWA description (`vite.config.ts` manifest + `index.html` meta) is
  already aligned with this copy.
- The web URL is wired to GitHub Pages by `scripts/custom-domain.sh` (DNS records,
  HTTPS enforcement, CNAME through the protected PR flow) — see the run doc's
  custom-domain paragraph for the procedure and its prerequisites.