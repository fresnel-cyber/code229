// Tests de /api/redeem-code — un code promo accorde le même accès qu'un
// paiement, sans paiement (SECURITY.md §14).
//
//     npm test
//
// Deux propriétés portent tout le reste :
//   - un code à N usages n'en accorde jamais N+1, même sur deux appels
//     simultanés (la transaction Firestore) ;
//   - le client n'apprend jamais si un code existe (même message pour
//     « inexistant », « désactivé » et « expiré »).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { FauxFirestore } = require('./helpers/faux-firestore');

const RACINE = path.join(__dirname, '..');
const JOUR_MS = 24 * 60 * 60 * 1000;

const bdd = new FauxFirestore();
let tokenValide = 'jeton-ok';
let uidDuToken = 'utilisateur-1';

function injecterModule(relatif, exports) {
  const resolu = require.resolve(path.join(RACINE, relatif));
  require.cache[resolu] = { id: resolu, filename: resolu, loaded: true, exports: exports };
}

injecterModule('api/_lib/firebaseAdmin.js', {
  db: bdd,
  auth: {
    verifyIdToken: async function (jeton) {
      if (jeton !== tokenValide) throw new Error('jeton invalide');
      return { uid: uidDuToken };
    }
  }
});

const handler = require(path.join(RACINE, 'api/redeem-code.js'));

/* ---------- Utilitaires ---------- */

function requete(code, options) {
  options = options || {};
  const req = { method: options.method || 'POST', headers: {}, body: { code: code } };
  if (options.authorization !== null) {
    req.headers.authorization = 'Bearer ' + (options.token || tokenValide);
  }
  if (options.body !== undefined) req.body = options.body;
  return req;
}

function reponse() {
  const res = { code: null, corps: null };
  res.status = function (c) { res.code = c; return res; };
  res.json = function (o) { res.corps = o; return res; };
  return res;
}

function reinitialiser() {
  bdd.docs.clear();
  bdd.rejeux = 0;
  bdd.hookAvantCommit = null;
  uidDuToken = 'utilisateur-1';
}

function poserCode(id, champs) {
  bdd.poser('promo_codes/' + id, Object.assign({
    active: true, duration_days: 30, max_uses: 10, used_count: 0, label: 'Test'
  }, champs || {}));
}

const logReel = console.log;
const erreurReelle = console.error;
test.before(function () { console.log = function () {}; console.error = function () {}; });
test.after(function () { console.log = logReel; console.error = erreurReelle; });

/* ---------- Authentification (SECURITY.md §3) ---------- */

test('méthode GET → 405', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete('FRESNEL', { method: 'GET' }), res);
  assert.strictEqual(res.code, 405);
});

test('sans en-tête Authorization → 401', async function () {
  reinitialiser();
  poserCode('FRESNEL');
  const res = reponse();
  await handler(requete('FRESNEL', { authorization: null }), res);

  assert.strictEqual(res.code, 401);
  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 0);
});

test('jeton invalide → 401, le code n\'est pas consommé', async function () {
  reinitialiser();
  poserCode('FRESNEL');
  const res = reponse();
  await handler(requete('FRESNEL', { token: 'jeton-bidon' }), res);

  assert.strictEqual(res.code, 401);
  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 0);
});

/* ---------- Validation d'entrée (SECURITY.md §2) ---------- */

test('code trop court → 400 sans aucune lecture Firestore', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete('AB'), res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(bdd.docs.size, 0, 'un code impossible ne doit même pas coûter une lecture');
});

test('code absent du corps → 400', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete(undefined, { body: {} }), res);
  assert.strictEqual(res.code, 400);
});

test('corps en texte brut JSON → accepté (Vercel ne parse pas toujours)', async function () {
  reinitialiser();
  poserCode('FRESNEL');
  const res = reponse();
  await handler(requete(null, { body: JSON.stringify({ code: 'FRESNEL' }) }), res);

  assert.strictEqual(res.code, 200);
});

test('la casse est ignorée — « fresnel » vaut « FRESNEL »', async function () {
  // Écart assumé avec SECURITY.md §2.3 : les codes se dictent au téléphone,
  // exiger la casse exacte produirait des échecs de saisie pour rien.
  reinitialiser();
  poserCode('FRESNEL');
  const res = reponse();
  await handler(requete('  fresnel  '), res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 1);
});

/* ---------- Non-divulgation (SECURITY.md §1.4) ---------- */

test('code inexistant, désactivé ou expiré → message STRICTEMENT identique', async function () {
  const messages = [];

  reinitialiser();
  let res = reponse();
  await handler(requete('INEXISTANT'), res);
  messages.push([res.code, res.corps.error]);

  reinitialiser();
  poserCode('DESACTIVE', { active: false });
  res = reponse();
  await handler(requete('DESACTIVE'), res);
  messages.push([res.code, res.corps.error]);

  reinitialiser();
  poserCode('EXPIRE', { expires_at: Date.now() - JOUR_MS });
  res = reponse();
  await handler(requete('EXPIRE'), res);
  messages.push([res.code, res.corps.error]);

  assert.deepStrictEqual(messages[0], messages[1],
    'distinguer « inexistant » de « désactivé » confirme à un attaquant qu\'un code existe');
  assert.deepStrictEqual(messages[1], messages[2]);
  assert.strictEqual(messages[0][0], 404);
});

test('un code désactivé n\'accorde aucun accès', async function () {
  reinitialiser();
  poserCode('DESACTIVE', { active: false });
  const res = reponse();
  await handler(requete('DESACTIVE'), res);

  assert.strictEqual(bdd.lire('subscriptions/utilisateur-1'), null);
  assert.strictEqual(bdd.lire('promo_codes/DESACTIVE').used_count, 0);
});

/* ---------- Anti-force brute (SECURITY.md §7.3) ---------- */

test('un échec incrémente le compteur de tentatives', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete('INEXISTANT'), res);

  assert.strictEqual(bdd.lire('promo_attempts/utilisateur-1').failed_count, 1);
});

test('au-delà de 10 échecs dans l\'heure → 429, plus aucune lecture de code', async function () {
  reinitialiser();
  poserCode('FRESNEL');
  bdd.poser('promo_attempts/utilisateur-1', {
    window_started_at: Date.now(), failed_count: 10, last_attempt_at: Date.now()
  });

  const res = reponse();
  await handler(requete('FRESNEL'), res);   // code pourtant VALIDE

  assert.strictEqual(res.code, 429);
  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 0);
});

test('les échecs de plus d\'une heure ne bloquent plus', async function () {
  reinitialiser();
  poserCode('FRESNEL');
  bdd.poser('promo_attempts/utilisateur-1', {
    window_started_at: Date.now() - 2 * 60 * 60 * 1000, failed_count: 50, last_attempt_at: 0
  });

  const res = reponse();
  await handler(requete('FRESNEL'), res);
  assert.strictEqual(res.code, 200);
});

/* ---------- Unicité par compte ---------- */

test('le même compte ne peut pas consommer deux fois le même code', async function () {
  reinitialiser();
  poserCode('FRESNEL');

  const premiere = reponse();
  await handler(requete('FRESNEL'), premiere);
  assert.strictEqual(premiere.code, 200);

  const seconde = reponse();
  await handler(requete('FRESNEL'), seconde);

  assert.strictEqual(seconde.code, 409);
  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 1,
    'une seconde tentative ne doit pas consommer un usage supplémentaire');
});

/* ---------- Plafond d'utilisations ---------- */

test('code épuisé → 409, aucun accès accordé', async function () {
  reinitialiser();
  poserCode('FRESNEL', { max_uses: 3, used_count: 3 });
  const res = reponse();
  await handler(requete('FRESNEL'), res);

  assert.strictEqual(res.code, 409);
  assert.strictEqual(bdd.lire('subscriptions/utilisateur-1'), null);
});

test('un code à 2 usages sert exactement 2 comptes, le 3e est refusé', async function () {
  reinitialiser();
  poserCode('FRESNEL', { max_uses: 2, used_count: 0 });

  const codes = [];
  for (const uid of ['a', 'b', 'c']) {
    uidDuToken = uid;
    const res = reponse();
    await handler(requete('FRESNEL'), res);
    codes.push(res.code);
  }

  assert.deepStrictEqual(codes, [200, 200, 409]);
  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 2);
  assert.strictEqual(bdd.lire('subscriptions/c'), null);
});

test('max_uses absent → code sans limite de volume', async function () {
  reinitialiser();
  poserCode('EQUIPE', { max_uses: undefined, used_count: 99 });

  uidDuToken = 'nouveau';
  const res = reponse();
  await handler(requete('EQUIPE'), res);
  assert.strictEqual(res.code, 200);
});

/* ---------- Concurrence : la garantie centrale ---------- */

test('deux comptes simultanés sur le DERNIER usage → un seul passe', async function () {
  reinitialiser();
  poserCode('FRESNEL', { max_uses: 1, used_count: 0 });

  // A lit (used_count = 0, un usage disponible) puis se fige avant d'écrire.
  // B se déroule entièrement pendant ce temps et consomme l'unique usage.
  // Au réveil, A doit constater que le document a changé, rejouer sa
  // transaction, relire used_count = 1 et refuser. Sans cette relecture, le
  // code à 1 usage en accorderait 2.
  bdd.hookAvantCommit = async function () {
    uidDuToken = 'compte-B';
    const resB = reponse();
    await handler(requete('FRESNEL'), resB);
    assert.strictEqual(resB.code, 200, 'B doit passer : il commit le premier');
    uidDuToken = 'compte-A';
  };

  uidDuToken = 'compte-A';
  const resA = reponse();
  await handler(requete('FRESNEL'), resA);

  assert.strictEqual(resA.code, 409, 'A doit être refusé après rejeu');
  assert.ok(bdd.rejeux >= 1, 'la transaction de A doit avoir été rejouée');
  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 1,
    'un code à 1 usage ne doit jamais en accorder 2');
  assert.strictEqual(bdd.lire('subscriptions/compte-A'), null);
  assert.ok(bdd.lire('subscriptions/compte-B'), 'B garde son accès');
});

/* ---------- Effet sur l'abonnement (SECURITY.md §6.3) ---------- */

test('code valide → abonnement actif et usage décompté', async function () {
  reinitialiser();
  poserCode('FRESNEL', { duration_days: 30, max_uses: 10, used_count: 4 });

  const res = reponse();
  await handler(requete('FRESNEL'), res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.corps.activated, true);
  assert.strictEqual(res.corps.duration_days, 30);

  const sub = bdd.lire('subscriptions/utilisateur-1');
  assert.strictEqual(sub.status, 'active');
  assert.strictEqual(sub.source, 'promo');
  assert.ok(sub.premium_expires_at > Date.now() + 29 * JOUR_MS);

  assert.strictEqual(bdd.lire('promo_codes/FRESNEL').used_count, 5);
  assert.ok(bdd.lire('promo_redemptions/FRESNEL__utilisateur-1'), 'la consommation doit être tracée');
});

test('abonnement en cours → PROLONGÉ, jamais écrasé', async function () {
  reinitialiser();
  poserCode('FRESNEL', { duration_days: 30 });
  const finActuelle = Date.now() + 20 * JOUR_MS;
  bdd.poser('subscriptions/utilisateur-1', {
    status: 'active', premium_started_at: Date.now() - JOUR_MS, premium_expires_at: finActuelle
  });

  const res = reponse();
  await handler(requete('FRESNEL'), res);

  assert.strictEqual(res.corps.extended, true);
  const attendu = finActuelle + 30 * JOUR_MS;
  assert.ok(Math.abs(res.corps.premium_expires_at - attendu) < 1000,
    'les 30 jours doivent s\'ajouter aux 20 restants, pas les remplacer');
});

test('abonnement expiré → reparti de maintenant, pas de la date passée', async function () {
  reinitialiser();
  poserCode('FRESNEL', { duration_days: 30 });
  bdd.poser('subscriptions/utilisateur-1', {
    status: 'active', premium_expires_at: Date.now() - 10 * JOUR_MS
  });

  const res = reponse();
  await handler(requete('FRESNEL'), res);

  assert.strictEqual(res.corps.extended, false);
  assert.ok(res.corps.premium_expires_at > Date.now() + 29 * JOUR_MS);
});

test('durée personnalisée respectée (60 jours)', async function () {
  reinitialiser();
  poserCode('BETA', { duration_days: 60 });

  const res = reponse();
  await handler(requete('BETA'), res);

  assert.strictEqual(res.corps.duration_days, 60);
  assert.ok(res.corps.premium_expires_at > Date.now() + 59 * JOUR_MS);
});
