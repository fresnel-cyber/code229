# SECURITY.md

> **Document de référence obligatoire pour tout agent IA (Claude Code, Copilot, etc.) et tout contributeur humain.**
> Ce fichier définit les règles de sécurité et de qualité de code **non négociables** pour le projet **code229**
> (PWA vanilla JS + fonctions serverless Vercel + Firebase/Firestore + paiements KPay/FedaPay).
> Toute violation doit être signalée, jamais contournée.

---

## Sommaire

1. [Principes fondamentaux](#1-principes-fondamentaux)
2. [Validation et assainissement des entrées](#2-validation-et-assainissement-des-entrées)
3. [Authentification (Firebase Auth)](#3-authentification-firebase-auth)
4. [Secrets et credentials](#4-secrets-et-credentials)
5. [Firestore et Firebase Admin SDK](#5-firestore-et-firebase-admin-sdk)
6. [Paiements : KPay / FedaPay et webhooks](#6-paiements--kpay--fedapay-et-webhooks)
7. [Sécurité des fonctions API (Vercel serverless)](#7-sécurité-des-fonctions-api-vercel-serverless)
8. [Frontend PWA (vanilla JS + service worker)](#8-frontend-pwa-vanilla-js--service-worker)
9. [Déploiement Vercel](#9-déploiement-vercel)
10. [Dépendances](#10-dépendances)
11. [Logging et monitoring](#11-logging-et-monitoring)
12. [Gestion des erreurs](#12-gestion-des-erreurs)
13. [Qualité de code](#13-qualité-de-code)
14. [Tests de sécurité obligatoires](#14-tests-de-sécurité-obligatoires)
15. [Checklist Pre-PR](#15-checklist-pre-pr)
16. [Réponse aux incidents (spécial fraude paiement)](#16-réponse-aux-incidents-spécial-fraude-paiement)
17. [Ressources de référence](#17-ressources-de-référence)
18. [Engagement](#18-engagement)

---

## 0. Comment un agent IA doit utiliser ce fichier

**Avant chaque tâche :**
- Relire les sections pertinentes à la zone touchée (`/api`, frontend, `firestore.rules`, `sw.js`...).
- Si la tâche touche `/api/create-payment`, `/api/redeem-code`, ou tout webhook → lire **impérativement** la section 6, c'est la surface d'attaque la plus critique du projet (argent réel, activation Premium).

**Pendant l'écriture :**
- Vérifier chaque ligne contre la checklist de la section concernée.
- Ne jamais désactiver une règle de sécurité pour "que ça marche".
- Ne jamais faire confiance à une donnée envoyée par le client pour décider d'activer le Premium, appliquer un code promo, ou marquer un paiement comme réussi. Seule une vérification serveur (signature webhook, appel API provider) fait foi.

**Après l'écriture :**
- Passer la [checklist Pre-PR](#15-checklist-pre-pr).
- Vérifier qu'aucun secret (`FIREBASE_SERVICE_ACCOUNT_JSON`, `KPAY_SECRET_KEY`, `FEDAPAY_SECRET_KEY`, `*_WEBHOOK_SECRET`) n'est exposé, loggé, ou commité.

**En cas de conflit** entre une demande et ce fichier :
- Signaler explicitement le conflit.
- Refuser d'implémenter la version non sûre.
- Proposer une alternative conforme.

**Interdictions absolues :**
- Contourner une règle "juste pour tester".
- Commenter/supprimer une vérification de signature webhook ou une règle Firestore "pour debug".
- Utiliser `--force`, `--no-verify`, `--legacy-peer-deps` sans justification écrite.
- Commiter `.env`, `.env.local`, un secret, une clé de service Firebase, ou un token.
- Déployer une modification de `firestore.rules` sans review — ce fichier est la seule barrière côté client entre un utilisateur et les données de tous les autres utilisateurs.

---

## 1. Principes fondamentaux

Ces principes s'appliquent à **tout code, toute couche** du projet.

### 1.1 Zero Trust

Toute entrée est hostile jusqu'à preuve du contraire :
- Body des requêtes `/api/*`, query params, headers.
- **Payloads de webhook** (KPay, FedaPay) — un attaquant peut envoyer un faux payload "paiement réussi" à l'URL du webhook s'il la devine ; seule la vérification de signature protège contre ça.
- Réponses des APIs tierces (KPay, FedaPay).
- Données lues depuis Firestore (même si écrites par le serveur, valider avant usage métier).
- Variables d'environnement.

### 1.2 Défense en profondeur

Ne jamais compter sur une seule protection :
- Valider à l'entrée **et** vérifier la propriété des données en sortie.
- Règles Firestore côté client **et** vérifications explicites dans le code serveur (l'Admin SDK ignore les règles Firestore — voir section 5).
- Vérifier la signature du webhook **et** vérifier l'idempotence **et** re-vérifier le montant/statut auprès du provider si possible.

### 1.3 Moindre privilège

- Le service account Firebase (Admin SDK) ne doit être utilisé **que** dans `/api/*`, jamais exposé au client.
- Un utilisateur Firestore (via règles) ne peut lire/écrire que ses propres documents.
- Les collections `subscriptions`, `payments`, `promo_codes`, `promo_redemptions`, `promo_attempts` sont en écriture **serveur uniquement** (`allow write: if false` côté règles) — ne jamais affaiblir cela pour simplifier un développement.

### 1.4 Fail-safe

En cas d'erreur ou de doute, refuser :
- Signature webhook invalide ou manquante → rejeter (`401`/`400`), ne jamais traiter le paiement "au cas où".
- Code promo invalide, déjà utilisé, ou rate-limit dépassé → refuser, jamais de "best effort".
- Token Firebase invalide/expiré → `401`, pas de fallback permissif.

### 1.5 Secure by default

- Nouvel utilisateur : jamais Premium par défaut, `subscriptions/{userId}` créé uniquement par le serveur après paiement confirmé.
- CSP stricte, headers de sécurité systématiques (voir section 7.5).
- Un nouveau champ Firestore sensible est en lecture serveur uniquement sauf justification explicite.

### 1.6 Simplicité

- Préférer une solution lisible à une solution "astucieuse".
- Une fonction API = une responsabilité (`create-payment` ne fait pas aussi `redeem-code`).
- Pas de `eval`, pas de génération dynamique de code, pas de réflexion inutile.

### 1.7 Traçabilité

Chaque action sensible est loguée sans exposer de secret :
- Création de paiement, réception de webhook (statut, id transaction — jamais la signature/clé).
- Activation ou désactivation de Premium.
- Usage (ou tentative d'usage) d'un code promo.
- Échec de vérification de signature webhook (signal fort d'attaque potentielle).

---

## 2. Validation et assainissement des entrées

### 2.1 Règle absolue

**Toute entrée externe (body `/api/*`, query params, payload webhook) est validée explicitement avant usage.** Le projet n'a pas de dépendance de schéma (type Zod) installée à ce jour — la validation manuelle doit donc être rigoureuse et systématique. Si une route de validation devient complexe, ajouter `zod` en dépendance plutôt que d'empiler des `if` fragiles.

```js
// ✅ BON — validation manuelle stricte et explicite
function validateCreatePaymentBody(body) {
  if (typeof body !== "object" || body === null) throw new Error("invalid body");
  if (typeof body.planId !== "string" || !["monthly", "yearly"].includes(body.planId)) {
    throw new Error("invalid planId");
  }
  if (typeof body.uid !== "string" || body.uid.length < 1 || body.uid.length > 128) {
    throw new Error("invalid uid");
  }
  return { planId: body.planId, uid: body.uid };
}

// ❌ INTERDIT
const { planId, uid, amount } = req.body; // amount ne doit JAMAIS venir du client
await createPayment({ planId, uid, amount });
```

### 2.2 Règles de validation

- Toujours borner : longueur max des strings, `enum` explicite pour les champs à valeurs limitées (`planId`, `provider`...).
- **Le montant (`amount`) et le prix d'un plan ne viennent jamais du client.** Ils sont définis côté serveur (constante ou config), jamais lus depuis `req.body`.
- IDs Firebase (`uid`) : dérivés du token vérifié (`decodedToken.uid`), jamais lus tels quels depuis le body sans recoupement.
- URLs (callback, redirect) : valider le protocole `https://` et, si possible, whitelister l'origine (`APP_BASE_URL`).
- Rejeter les caractères Unicode de contrôle (`\u0000`-`\u001F`) dans tout champ texte libre (nom, code promo...).
- Taille des payloads JSON : limiter explicitement (ex. 100 KB suffit largement pour ce projet — un payload webhook anormalement gros est suspect).

### 2.3 Sanitization

- **Jamais** `eval`, `new Function`, exécution de commande shell avec entrée utilisateur.
- Les codes promo sont comparés en respectant la casse et sans transformation implicite qui élargirait leur portée (ex. ne pas normaliser accidentellement `CODE-2024` et `code2024` comme identiques sauf si voulu).

---

## 3. Authentification (Firebase Auth)

### 3.1 Vérification du token

Toute route `/api/*` qui agit pour le compte d'un utilisateur **doit** vérifier son ID token Firebase côté serveur avec l'Admin SDK — ne jamais faire confiance à un `uid` envoyé tel quel dans le body.

```js
// ✅ BON
const authHeader = req.headers.authorization || "";
const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
if (!idToken) return res.status(401).json({ error: "Unauthorized" });

let decodedToken;
try {
  decodedToken = await admin.auth().verifyIdToken(idToken);
} catch {
  return res.status(401).json({ error: "Unauthorized" });
}
const uid = decodedToken.uid; // ✅ uid de confiance, jamais celui du body

// ❌ INTERDIT
const { uid } = req.body; // un attaquant peut mettre n'importe quel uid
```

### 3.2 Règles

- `verifyIdToken` doit être appelé pour **toute** action qui lit ou modifie des données liées à un utilisateur (paiement, activation, code promo, progression).
- Ne jamais faire confiance à un `uid` transmis dans le body/query pour l'identité — seul le token vérifié fait foi.
- Token invalide ou expiré → `401`, sans détail sur la raison exacte de l'échec.
- Les routes purement webhook (KPay/FedaPay → serveur) n'ont pas de token Firebase : elles sont sécurisées par la **signature du webhook** (section 6), pas par Firebase Auth.

---

## 4. Secrets et credentials

### 4.1 Règles absolues

- Jamais de secret dans le code, même en commentaire.
- Jamais de secret commité. `.env`, `.env.local` dans `.gitignore`.
- Jamais de secret dans les logs, les réponses HTTP, les messages d'erreur, ou les URLs.
- En production, tous les secrets vivent **uniquement** dans Vercel → Project Settings → Environment Variables, jamais dans un fichier du repo.

### 4.2 Secrets du projet et leur portée

| Variable | Portée | Sensibilité |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Serveur uniquement (`/api`) | **Critique** — accès total à Firestore, bypass des règles |
| `KPAY_API_KEY`, `KPAY_SECRET_KEY` | Serveur uniquement | **Critique** — initiation de paiements |
| `KPAY_WEBHOOK_SECRET` | Serveur uniquement | **Critique** — vérification des webhooks entrants |
| `FEDAPAY_SECRET_KEY` | Serveur uniquement | **Critique** — initiation de paiements |
| `FEDAPAY_WEBHOOK_SECRET` | Serveur uniquement | **Critique** — vérification des webhooks entrants |
| `PAYMENT_PROVIDER` | Serveur uniquement | Config, non secret mais ne pas exposer côté client |
| `APP_BASE_URL` | Peut être publique | Basse |

- Toute variable destinée au client (aucune dans ce projet actuellement) devrait être préfixée explicitement et documentée — par défaut, **rien n'est exposé au client**.
- `FIREBASE_SERVICE_ACCOUNT_JSON` ne doit jamais transiter par le frontend, un log, ou un message d'erreur, même partiellement.

### 4.3 Validation au démarrage

Chaque fonction serverless qui a besoin d'un secret doit vérifier sa présence et échouer explicitement plutôt que de continuer silencieusement avec une valeur `undefined` :

```js
// lib/env.js
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

module.exports = { requireEnv };
```

### 4.4 Rotation

- En cas de doute sur une fuite : régénérer immédiatement la clé côté KPay/FedaPay/Firebase, puis mettre à jour Vercel.
- Documenter toute rotation de secret dans `docs/incidents/` si elle fait suite à un incident.

---

## 5. Firestore et Firebase Admin SDK

### 5.1 Principe clé

**`firestore.rules` protège uniquement le SDK client.** Le SDK Admin utilisé dans `/api/*` **ignore totalement** ces règles. Cela signifie que le code serveur est la **seule** barrière de sécurité pour toute écriture faite via l'Admin SDK — une erreur de logique côté serveur revient à désactiver les règles Firestore pour cette opération.

### 5.2 Règles actuelles (référence — ne pas affaiblir sans revue)

- `users/{userId}` : lecture/écriture par le propriétaire uniquement (`request.auth.uid == userId`).
- `subscriptions/{userId}` : lecture par le propriétaire, **écriture serveur uniquement** (`allow write: if false`). Un client ne peut jamais s'auto-déclarer Premium.
- `payments/{paymentId}` : lecture de ses propres transactions uniquement, écriture serveur uniquement.
- `promo_codes/{code}` : **totalement invisible au client** (lecture ET écriture interdites) — lisible, la liste des codes valides serait exposée.
- `promo_redemptions/{id}`, `promo_attempts/{userId}` : serveur uniquement (anti-répétition / anti-brute-force).
- `analytics_events/{eventId}` : le client peut uniquement **créer** son propre événement, jamais lire/modifier/supprimer.

### 5.3 Règles pour tout agent modifiant `firestore.rules`

- Toute nouvelle collection contenant des données sensibles (paiement, statut premium, code promo) est **serveur uniquement** par défaut.
- Ne jamais changer `allow write: if false` en `allow write: if request.auth != null` sur `subscriptions` ou `payments` sans justification écrite et review explicite — cela permettrait à un utilisateur de s'auto-attribuer le Premium.
- Toute modification de `firestore.rules` doit être testée (émulateur Firestore ou Firebase Rules Playground) avant déploiement manuel dans la console.
- Rappel : le déploiement des règles n'est **pas automatisé** depuis ce repo — après modification, il faut la coller manuellement dans Firebase Console. Signaler explicitement ce point dans la PR pour ne pas l'oublier.

### 5.4 Requêtes Admin SDK

- Toujours filtrer/vérifier l'`uid` issu du token vérifié avant toute lecture/écriture (section 3).
- Toujours utiliser des transactions Firestore (`db.runTransaction`) pour les opérations qui doivent être atomiques (ex. vérifier qu'un code promo n'a pas déjà été utilisé **et** l'enregistrer comme utilisé).

```js
// ✅ BON — évite une race condition (double usage du même code promo)
await db.runTransaction(async (tx) => {
  const codeRef = db.collection("promo_codes").doc(code);
  const codeSnap = await tx.get(codeRef);
  if (!codeSnap.exists || codeSnap.data().used) {
    throw new Error("invalid or already used code");
  }
  tx.update(codeRef, { used: true, usedBy: uid, usedAt: new Date() });
  tx.set(db.collection("promo_redemptions").doc(), { code, uid, at: new Date() });
});
```

---

## 6. Paiements : KPay / FedaPay et webhooks

> **C'est la surface la plus critique du projet.** Une faille ici = activation de Premium gratuite ou détournement de paiement. Tout code touchant à ce périmètre doit être traité avec le niveau d'exigence maximal.

### 6.1 Principe absolu

**Le statut Premium n'est jamais activé sur la base d'une redirection ou d'un appel client.** Il n'est activé que par le webhook serveur-à-serveur, après vérification de signature réussie. Une page de "succès" côté client (après redirection depuis KPay/FedaPay) affiche un état d'attente, jamais une confirmation définitive basée sur l'URL de retour.

```js
// ❌ INTERDIT — un attaquant peut appeler cette route ou visiter cette URL directement
app.get("/payment-success", async (req, res) => {
  await activatePremium(req.query.uid); // AUCUNE vérification réelle du paiement
});

// ✅ BON — seule cette route active le Premium, et uniquement après vérif de signature
app.post("/api/webhooks/kpay", async (req, res) => {
  if (!verifyKpaySignature(req)) return res.status(401).end();
  // ... traitement idempotent, voir 6.3
});
```

### 6.2 Vérification de signature

- **Chaque** webhook entrant (KPay et FedaPay) doit vérifier sa signature avec le secret dédié (`KPAY_WEBHOOK_SECRET` ou repli sur `KPAY_SECRET_KEY`, `FEDAPAY_WEBHOOK_SECRET`) avant tout traitement métier.
- Utiliser une comparaison à temps constant (`crypto.timingSafeEqual`), jamais `===` sur des chaînes issues de secrets/signatures.
- Le webhook doit être lu en **raw body** (pas de re-sérialisation JSON) si la signature du provider est calculée sur le corps brut — re-sérialiser un JSON avant vérification peut invalider une signature légitime ou, pire, masquer une signature invalide.
- Une signature absente ou invalide → `401`/`400` immédiat, log de l'échec (sans la signature elle-même), **aucun traitement**.

```js
// Exemple générique (adapter à la doc officielle du provider actif)
const crypto = require("crypto");

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = Buffer.from(signatureHeader, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}
```

### 6.3 Idempotence

- Un webhook peut être envoyé **plusieurs fois** par le provider (retry). Avant de traiter un événement, vérifier qu'il n'a pas déjà été traité (ex. `payments/{transactionId}` déjà existant avec statut `completed`).
- Ne jamais activer le Premium une seconde fois ou créditer deux fois une même transaction.

### 6.4 Cohérence provider actif

- `PAYMENT_PROVIDER` détermine quel provider `/api/create-payment` utilise, **mais les deux intégrations (KPay et FedaPay) restent présentes dans le code**. Un webhook FedaPay ne doit jamais pouvoir activer un paiement s'il n'a pas été initié comme tel (vérifier le provider associé à la transaction stockée, pas seulement la variable d'env courante).
- Ne jamais déduire le montant ou le plan à créditer depuis le payload du webhook sans le recouper avec l'enregistrement de paiement créé lors de l'initiation (`/api/create-payment`) — le webhook confirme un paiement déjà connu, il ne doit pas en créer un nouveau à partir de rien.

### 6.5 Ce qu'on ne fait jamais

- Ne jamais activer/modifier le statut Premium depuis une route accessible en `GET` ou déclenchable par simple navigation.
- Ne jamais faire confiance au montant envoyé par le client dans `/api/create-payment` — le prix du plan est défini côté serveur.
- Ne jamais logger `KPAY_SECRET_KEY`, `FEDAPAY_SECRET_KEY`, les secrets de webhook, ou le contenu brut d'un payload de paiement contenant des données de carte/compte.
- Ne jamais désactiver la vérification de signature "temporairement pour tester en prod".

---

## 7. Sécurité des fonctions API (Vercel serverless)

### 7.1 Méthodes HTTP

- `GET` : lecture uniquement, jamais de mutation ni d'activation de statut.
- `POST` : création (paiement, redemption de code), traitement de webhook.
- Toute route de mutation vérifie la méthode explicitement et rejette les autres (`405`).

### 7.2 Codes de statut

| Code | Usage |
|---|---|
| `200`/`201` | OK / créé |
| `400` | Body invalide, signature de webhook manquante/malformée |
| `401` | Token Firebase absent/invalide, signature de webhook incorrecte |
| `403` | Authentifié mais droits insuffisants (ex. déjà Premium et re-tente un code) |
| `404` | Ressource inexistante ou non possédée |
| `409` | Code promo déjà utilisé, paiement déjà traité (idempotence) |
| `429` | Trop de tentatives (codes promo, création de paiement) |
| `500` | Erreur serveur — **jamais** de détails internes dans la réponse |

### 7.3 Rate limiting

Le projet n'a pas de Redis. Le rate limiting peut s'appuyer sur Firestore (compteurs avec TTL applicatif, ex. `promo_attempts/{userId}`) ou sur Vercel KV/Upstash si ajouté. Dans tous les cas :

- `POST /api/redeem-code` : limiter fortement par utilisateur ET par IP (brute-force de codes promo = vol direct).
- `POST /api/create-payment` : limiter par utilisateur pour éviter la création massive de transactions.
- Les webhooks ne sont pas rate-limités côté logique métier (le provider peut légitimement en envoyer plusieurs) mais doivent rester protégés par la vérification de signature.

### 7.4 CORS

- Par défaut : n'autoriser que l'origine `APP_BASE_URL` sur les routes appelées depuis le frontend.
- Les routes webhook n'ont pas besoin de CORS (appelées serveur-à-serveur par KPay/FedaPay, pas par un navigateur).
- Jamais `Access-Control-Allow-Origin: *` sur une route qui traite des données utilisateur authentifiées.

### 7.5 Headers de sécurité

À définir dans `vercel.json` (section `headers`) pour toutes les routes servant du HTML :

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
        { "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains" }
      ]
    }
  ]
}
```

- CSP : à construire en whitelistant explicitement les domaines Firebase (`*.googleapis.com`, `*.firebaseio.com`) et les domaines KPay/FedaPay nécessaires au checkout, rien d'autre.

---

## 8. Frontend PWA (vanilla JS + service worker)

### 8.1 XSS

- Pas de framework qui échappe automatiquement (React/Vue) : toute insertion de contenu dynamique dans le DOM doit utiliser `textContent`, jamais `innerHTML`, sauf contenu strictement statique et contrôlé par le code lui-même.
- Si `innerHTML` est réellement nécessaire pour du contenu partiellement dynamique, passer par une fonction d'échappement explicite ou une bibliothèque de sanitization — jamais insérer une donnée utilisateur brute.
- Jamais de `javascript:` dans un `href`, jamais `eval`, jamais `setTimeout`/`setInterval` avec une string.

```js
// ❌ INTERDIT
el.innerHTML = `Bonjour ${userName}`;

// ✅ BON
el.textContent = `Bonjour ${userName}`;
```

### 8.2 Stockage côté client

- Ne jamais stocker un secret serveur (clé API, secret webhook) côté client — par construction ils ne doivent même jamais y arriver.
- Le token Firebase (ID token) géré par le SDK client Firebase peut être en mémoire/IndexedDB (comportement par défaut du SDK) ; ne pas le dupliquer manuellement dans `localStorage` sans raison.
- Données Premium/abonnement affichées côté client : toujours relues depuis Firestore (lecture protégée par les règles), jamais mises en cache de façon à pouvoir être falsifiées localement pour débloquer une fonctionnalité.

### 8.3 Service worker (`sw.js`)

- Ne jamais mettre en cache des réponses contenant des données utilisateur sensibles (statut Premium, historique de paiement) de façon persistante entre utilisateurs sur un même appareil partagé.
- Versionner explicitement le cache (`CACHE_NAME`) et invalider les anciens caches à l'activation, pour éviter de servir une version obsolète contenant une faille corrigée.
- Ne jamais intercepter et modifier les requêtes vers `/api/*` de façon à contourner l'authentification.

### 8.4 Manifest et permissions

- `manifest.json` : ne déclarer que les permissions strictement nécessaires à l'usage PWA.

---

## 9. Déploiement Vercel

- Tous les secrets vivent dans Vercel → Project Settings → Environment Variables, jamais dans le repo.
- Vérifier que les **Preview Deployments** n'utilisent pas les clés **live**/production de KPay/FedaPay — utiliser des clés `*_test_`/`sandbox` pour les environnements non-production.
- `vercel.json` : toute règle de routing/rewrite ajoutée doit être relue pour vérifier qu'elle n'expose pas accidentellement une route `/api/*` interne qui ne devrait pas être publique.
- Domaine de production (`APP_BASE_URL`) : vérifier qu'il est cohérent avec la configuration CORS et les callbacks configurés côté KPay/FedaPay.

---

## 10. Dépendances

- `npm audit` doit être vert avant chaque merge.
- Le projet a volontairement peu de dépendances (`firebase-admin`, `fedapay`, éventuellement un SDK KPay) — ne pas en ajouter pour une fonctionnalité triviale.
- Toute nouvelle dépendance touchant à l'auth, au paiement, ou à la cryptographie doit être justifiée explicitement dans la PR.
- Lockfile (`package-lock.json`) commité, `npm ci` en CI.
- Mises à jour de sécurité (surtout `firebase-admin`, `fedapay`) mergées rapidement.

---

## 11. Logging et monitoring

### 11.1 Ce qu'on logue

- Résultat de vérification de signature webhook (succès/échec), sans la signature elle-même.
- Activation/désactivation de Premium (uid, transactionId, provider, timestamp).
- Tentative de code promo (succès/échec), sans le code en clair dans les logs persistants au-delà du nécessaire.
- Erreurs serveur (stack côté serveur uniquement, jamais renvoyée au client).

### 11.2 Ce qu'on ne logue JAMAIS

- `FIREBASE_SERVICE_ACCOUNT_JSON`, `KPAY_SECRET_KEY`, `FEDAPAY_SECRET_KEY`, tout `*_WEBHOOK_SECRET`.
- Le contenu brut complet d'un payload de paiement (peut contenir des données sensibles selon le provider).
- Les ID tokens Firebase.

---

## 12. Gestion des erreurs

- Jamais exposer : stack trace, détail Firestore interne, chemin de fichier, nom de variable d'environnement manquante précise.
- Réponse client générique + logging détaillé côté serveur :

```js
try {
  // ...
} catch (err) {
  console.error({ action: "webhook.kpay", error: err.message }); // pas err complet si contient des secrets
  return res.status(500).json({ error: "Une erreur est survenue" });
}
```

---

## 13. Qualité de code

- Une fonction = une responsabilité (ex. `verifySignature`, `activatePremium`, `recordPayment` séparées, pas une seule fonction géante par webhook).
- Nommage : `camelCase` pour variables/fonctions, `SCREAMING_SNAKE_CASE` pour constantes, `kebab-case.js` pour fichiers utilitaires.
- Toujours `await`/`.catch()` — jamais de promesse non gérée, en particulier sur les appels à Firestore ou aux APIs de paiement.
- Commenter le **pourquoi**, surtout sur toute logique liée à la sécurité (signature, idempotence) — ces commentaires sont ce qui empêche un futur contributeur (humain ou IA) de "simplifier" par erreur une vérification critique.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`...).

---

## 14. Tests de sécurité obligatoires

Avant tout merge touchant à l'auth, aux paiements, ou à Firestore :

- **Signature webhook invalide** → route webhook doit rejeter (`401`/`400`), aucune écriture Firestore.
- **Webhook rejoué (même transactionId)** → pas de double activation Premium, pas de double crédit.
- **Token Firebase absent/invalide** sur route protégée → `401`.
- **IDOR** : lire/modifier le paiement ou l'abonnement d'un autre utilisateur → refusé par les règles Firestore ET par le code serveur.
- **Code promo** : réutilisation d'un code déjà consommé → refusé ; brute-force de codes → rate-limité.
- **XSS** : toute valeur utilisateur affichée (nom, etc.) → correctement échappée dans le DOM.
- **Montant falsifié** : `create-payment` avec un montant/plan manipulé dans le body → ignoré, le serveur utilise son propre référentiel de prix.

---

## 15. Checklist Pre-PR

### Sécurité
- [ ] Toute entrée externe (`/api/*`, webhook) validée explicitement.
- [ ] Token Firebase vérifié sur toute route agissant pour un utilisateur.
- [ ] Signature webhook vérifiée (comparaison à temps constant) avant tout traitement.
- [ ] Traitement de webhook idempotent (pas de double activation/crédit).
- [ ] Aucun secret dans code, logs, réponses API.
- [ ] Montant/prix jamais lu depuis le client.
- [ ] `firestore.rules` non affaibli sans justification et review explicite.
- [ ] Headers de sécurité en place (`vercel.json`).
- [ ] `npm audit` vert.

### Qualité
- [ ] Pas de `console.log` de données sensibles.
- [ ] Pas de `TODO` sans ticket.
- [ ] Fonctions courtes, responsabilité unique.
- [ ] Commentaires utiles, surtout sur la logique de sécurité.

### Tests
- [ ] Tests couvrant signature invalide / rejouée sur les webhooks concernés.
- [ ] Tests IDOR sur les routes de paiement/abonnement modifiées.
- [ ] Tous les tests passent.

### Git
- [ ] Conventional Commit.
- [ ] `.env` / `.env.local` non commité.
- [ ] Pas de fichier temporaire ou de clé de service Firebase commité.

---

## 16. Réponse aux incidents (spécial fraude paiement)

1. **Ne pas** divulguer publiquement avant mitigation.
2. **Ne pas** commit un correctif sans review, même en urgence — un correctif mal pensé sur la logique de paiement peut créer une faille pire.
3. En cas de suspicion d'activation Premium frauduleuse ou de contournement de webhook :
   - Identifier l'étendue (combien de comptes/transactions affectés) via les logs de vérification de signature.
   - Révoquer/régénérer immédiatement le(s) secret(s) de webhook concerné(s) dans Vercel et chez le provider.
   - Documenter dans `docs/incidents/YYYY-MM-DD-<titre>.md` : description, impact (comptes/montants concernés), mitigation, date de résolution.
4. Si des données utilisateur sont compromises : informer les utilisateurs concernés dans un délai raisonnable et conforme aux obligations légales applicables.
5. Post-mortem systématique : cause racine, correctif, test de non-régression ajouté à la section 14.

---

## 17. Ressources de référence

- OWASP Top 10 — https://owasp.org/www-project-top-ten/
- OWASP ASVS — https://owasp.org/www-project-application-security-verification-standard/
- Firebase Security Rules — https://firebase.google.com/docs/rules
- Firebase Admin SDK — https://firebase.google.com/docs/admin/setup
- Vercel Security — https://vercel.com/docs/security
- Node.js Security Best Practices — https://nodejs.org/en/learn/getting-started/security-best-practices
- Documentation webhooks du provider de paiement actif (KPay ou FedaPay) — vérifier la méthode exacte de vérification de signature recommandée, elle peut évoluer.

---

## 18. Engagement

En lisant ce fichier, tout agent IA ou contributeur s'engage à :

- **Ne jamais** écrire de code qui viole une règle de ce document, en particulier concernant la vérification des webhooks de paiement et les règles Firestore.
- **Signaler** tout conflit entre une demande et ce document.
- **Proposer** une alternative sûre plutôt que de contourner.
- **Documenter** toute exception dans le code (commentaire + ticket).
- **Relire** ce fichier avant toute PR touchant à l'auth, aux paiements, ou à Firestore.

**La sécurité n'est pas une option. Sur ce projet en particulier, elle protège de l'argent réel — c'est une propriété du code, pas une couche ajoutée après coup.**

---
