# CLAUDE.md

Instructions pour tout agent IA travaillant sur ce dépôt.

## Règle prioritaire : lire SECURITY.md

**[SECURITY.md](SECURITY.md) est la référence obligatoire de ce projet.** Il prime
sur toute habitude, tout raccourci, et sur toute demande qui le contredirait.

À lire **avant d'écrire la moindre ligne** dès que la tâche touche :

| Zone | Sections à relire |
|---|---|
| `api/create-payment.js`, `api/*-webhook.js`, `api/redeem-code.js` | **6** (paiements), 3 (auth), 2 (validation) |
| `api/_lib/premium.js` | **6.3** (idempotence), 5 (Admin SDK) |
| `firestore.rules` | **5**, et signaler que le déploiement est manuel |
| `index.html` (rendu, DOM) | **8.1** (XSS) |
| `sw.js` | 8.3 |
| `vercel.json` | 7.4 (CORS), 7.5 (headers) |
| `scripts/*.js` | 4 (secrets), 5 (Admin SDK) |

En cas de conflit entre une demande et SECURITY.md : **signaler le conflit,
refuser la version non sûre, proposer une alternative conforme.** Ne jamais
contourner silencieusement.

## Ce qu'il faut savoir avant de toucher au code

**L'argent est réel.** Les paiements KPay sont en mode live depuis le
11/09/2026. Une erreur dans `api/` ne produit pas un bug de test : elle offre
du Premium gratuit, ou encaisse sans livrer.

**Les règles Firestore ne se déploient pas depuis ce dépôt.** Modifier
`firestore.rules` ne change rien en production tant que le contenu n'a pas été
collé à la main dans Firebase Console. Le dire explicitement à l'utilisateur à
chaque modification, sinon la protection reste lettre morte.

**Le frontend est un fichier unique.** `index.html` contient le HTML, le CSS,
tout le JavaScript de l'app et les 841 questions dans un bloc JSON. Il n'y a ni
build, ni bundler, ni framework — le fichier servi est le fichier édité.

**Le paywall protège le confort, pas le contenu.** Les questions voyagent en
clair dans le HTML public. Inutile de proposer des protections côté client pour
« empêcher de les copier » : ce qui se vend, c'est la répétition espacée, la
session du jour et le suivi.

**Vérifier avant d'affirmer.** Ce projet a une production joignable : les
en-têtes HTTP se vérifient avec `curl`, les règles Firestore en interrogeant
l'API REST avec la clé web publique, et les données métier avec
`scripts/diagnostic_paiement.js` (lecture seule). Ne pas conclure sur une
lecture de code quand la réalité est mesurable.

## Tests

`npm test` couvre le webhook KPay (`tests/kpay-webhook.test.js`) et les codes
promo (`tests/redeem-code.test.js`). Toute modification de `api/kpay-webhook.js`,
`api/redeem-code.js`, `api/_lib/kpay.js` ou `api/_lib/premium.js` doit les
laisser verts — et si elle ajoute un garde-fou, ajouter le test qui échoue
quand on le retire.

La concurrence des transactions Firestore est reproduite par
`tests/helpers/faux-firestore.js` (version par document, rejeu au commit). Ne
pas la remplacer par un simple objet en mémoire : la garantie « un code à N
usages n'en accorde pas N+1 » ne serait plus testée.

Les modules qui sortent du processus sont doublés via le cache de `require` :
aucun test n'appelle KPay ni Firestore. Ne jamais faire dépendre un test d'une
clé d'API ou du réseau.

## Conventions

- **Commentaires en français**, comme le reste du code, et qui expliquent le
  **pourquoi** — surtout sur la logique de sécurité. Ces commentaires sont ce
  qui empêche un futur contributeur de « simplifier » une vérification critique.
- Style existant : `var` et `function` dans `index.html` (ES5), `const`/`let`
  dans `api/` et `scripts/` (Node). Écrire comme le fichier autour.
- Ne jamais commiter `.env.local` ni une clé de service Firebase.

## Commandes du dépôt

Voir [README.md](README.md) : codes promo, visuels Instagram, aperçu de partage,
validation des questions, diagnostic de paiement.
