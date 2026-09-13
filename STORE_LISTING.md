# Budget et Compte — Store Listing (Play Store / App Store)

Deploy-ready copy for the app **Budget et Compte** (local-first family finance app).
The brand is a French proper name: it is **not translated**, so the fr/en/es
listings below all ship it unchanged.
Facts in this listing are verified against the app: 100% local storage, AES-GCM-256
encrypted vault, Wave / Orange Money / MTN MoMo support, monthly budget, CSV export,
encrypted backups, trilingual UI, multi-currency.

---

## Identity

- **App name:** Budget et Compte
- **Tagline (FR):** Gestion financière familiale — comptes, budget & épargne
- **Category:** Finance
- **Default language:** Français (EN/ES built-in)
- **Free, no account, no ads, no cloud**

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
> compte, aucun serveur, aucune publicité. Vos données ne quittent jamais votre
> appareil.
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
> **Sécurité maximale**
> - Chiffrement AES-GCM 256 — illisible sans votre mot de passe
> - Verrouillage automatique de la session
> - Sauvegardes exportables (JSON, ou chiffrées avec votre propre phrase secrète)
>
> **Pratique au quotidien**
> - Français, English, Español — changement de langue instantané
> - Devises : FCFA (XOF, XAF), Dollar, Euro et 17 autres, détectées selon votre région
> - Thème sombre ou clair
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
> phone, no account, no server. Track bank accounts and Mobile Money wallets
> (Wave, Orange Money, MTN MoMo), log expenses, income and transfers, and manage a
> monthly budget per category with overspend alerts. AES-GCM-256 encryption,
> auto-lock, plain or encrypted backups, works offline, dark/light themes,
> multi-currency, and Français / English / Español.

### Español

> **Budget et Compte** mantiene las finanzas familiares 100% locales — cifradas en
> su teléfono, sin cuenta ni servidor. Controle cuentas bancarias y billeteras
> Mobile Money (Wave, Orange Money, MTN MoMo), registre gastos, ingresos y
> transferencias, y gestione un presupuesto mensual por categoría con alertas de
> exceso. Cifrado AES-GCM-256, bloqueo automático, copias de seguridad cifradas,
> funciona sin conexión, temas claro/oscuro y multi-moneda.

---

## Deploy notes

- Keep the listing honest: if features change (e.g. a savings-goals screen ships),
  update the description in the same release.
- Play short description and App Store subtitle both fit under their limits —
  re-verify after any wording change.
- The built-in PWA description (`vite.config.ts` manifest + `index.html` meta) is
  already aligned with this copy.