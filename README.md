# Budget et Compte

[![CI](https://github.com/Vieuxniang/Budget-et-Compte/actions/workflows/ci.yml/badge.svg)](https://github.com/Vieuxniang/Budget-et-Compte/actions/workflows/ci.yml)
[![Uptime](https://github.com/Vieuxniang/Budget-et-Compte/actions/workflows/uptime.yml/badge.svg)](https://github.com/Vieuxniang/Budget-et-Compte/actions/workflows/uptime.yml)

**Gestion financière familiale, 100 % locale** — comptes, budget, objectifs,
tontines et packs pays. Application web installable (PWA) qui fonctionne
hors-ligne : les données restent chiffrées dans le navigateur, aucun serveur
n'en détient la clé.

🌐 **[Ouvrir l'application](https://vieuxniang.github.io/Budget-et-Compte/)** —
puis « Ajouter à l'écran d'accueil » depuis le navigateur du téléphone pour
l'installer comme une application.

## Ce qu'elle fait

- 🔒 **100 % locale par défaut** : coffre chiffré (AES-GCM, clé dérivée PBKDF2)
  dans le navigateur, déverrouillage par mot de passe, verrouillage automatique.
  Mot de passe oublié = données irrécupérables, par conception.
- 🔄 **Synchronisation multi-appareils optionnelle**, chiffrée de bout en bout —
  le relais ne voit que du chiffré, les conflits restent archivés et
  restaurables.
- 💼 **Comptes & budget** : opérations, catégories, objectifs d'épargne,
  portefeuilles Mobile Money (Wave, Orange Money, MTN MoMo), export CSV.
- 🤝 **Tontines / associations** : membres, parts, tours de versement, suivi des
  paiements et reçus.
- 🌍 **Packs pays** : estimateur de salaire net, frais scolaires, modèles de
  budget (indicatifs, pour la planification d'un ménage).
- 🗣️ **Français, English, Español** — thème clair ou sombre.
- 🔑 **Offre Pro** : licences hors-ligne, clés signées vérifiées sur l'appareil
  (paiement Mobile Money via une boutique séparée, ou clé vendue à la main).

## Qualité

- 478 tests unitaires (Vitest) · typecheck strict · i18n complet fr/en/es.
- Chaque poussée sur `main` : vérifications → build → déploiement du même
  artefact testé sur GitHub Pages → test de fumée du site en ligne
  (coquille, bundle d'entrée, manifeste, service worker).
- **Surveillance** : le même test de fumée est rejoué toutes les 6 heures ; un
  échec ouvre automatiquement une issue « Uptime failure », la reprise la
  referme (historique dans [Issues](https://github.com/Vieuxniang/Budget-et-Compte/issues?q=is%3Aissue+in%3Atitle+%22Uptime+failure%22)).

## Développement

```bash
npm install
npm run dev        # serveur de développement
npm test           # suite Vitest
npm run build      # build de production (tsc + vite, artefact PWA)
```

Les détails d'exploitation (artefacts, déploiement, surveillance, décision
log) sont consignés dans [`.freebuff/run.md`](.freebuff/run.md).

## Licence

Code source **propriétaire, tous droits réservés** — visible publiquement à
titre de transparence, mais aucune réutilisation, modification ou diffusion
n'est autorisée sans accord écrit. Voir [LICENSE](LICENSE). L'application
restera gratuite pour son usage normal ; la réserve porte sur la réutilisation
du *code* par des tiers, pas sur l'usage de l'app.

> Langue des documents : le README est en français (langue du produit) ; la
> licence est en anglais (langue du droit).
