// Tests du webhook KPay — la seule route qui active Premium, donc la seule
// dont une régression se paie en argent réel (SECURITY.md §6, §14).
//
//     node --test tests/
//
// Aucun réseau, aucun Firestore : les deux modules qui sortent du processus
// (_lib/firebaseAdmin et _lib/kpay) sont remplacés dans le cache de require
// AVANT le chargement du handler. `_lib/premium` reste réel, on ne fait
// qu'observer activatePremium — c'est l'appel qui accorde l'accès, donc
// l'assertion qui compte : « Premium a-t-il été activé, oui ou non ».

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const SECRET = 'secret-de-test-kpay';
const RACINE = path.join(__dirname, '..');

/* ---------- Doublures des modules externes ---------- */

// État piloté par chaque test, relu à chaque appel.
const faux = {
  paiementChezKpay: null,   // ce que KPay répond quand on relit le paiement
  docPaiement: null,        // contenu de payments/kpay_<id>, ou null si absent
  appelsGetPayment: 0,
  activations: []           // un élément par activation de Premium
};

function injecterModule(relatif, exports) {
  const resolu = require.resolve(path.join(RACINE, relatif));
  require.cache[resolu] = { id: resolu, filename: resolu, loaded: true, exports: exports };
}

// Firestore : juste assez pour payments/kpay_<id>.
injecterModule('api/_lib/firebaseAdmin.js', {
  db: {
    collection: function () {
      return {
        doc: function () {
          return {
            get: async function () {
              return {
                exists: faux.docPaiement !== null,
                data: function () { return faux.docPaiement; }
              };
            }
          };
        }
      };
    }
  }
});

const kpayReel = require(path.join(RACINE, 'api/_lib/kpay.js'));
injecterModule('api/_lib/kpay.js', {
  // La vérification de signature est la protection testée : on garde la vraie.
  verifyWebhookSignature: kpayReel.verifyWebhookSignature,
  initPayment: function () { throw new Error('non utilisé dans ces tests'); },
  getPayment: async function () {
    faux.appelsGetPayment += 1;
    if (!faux.paiementChezKpay) throw new Error('KPay indisponible');
    return faux.paiementChezKpay;
  }
});

const premiumReel = require(path.join(RACINE, 'api/_lib/premium.js'));
injecterModule('api/_lib/premium.js', {
  PREMIUM_AMOUNT: premiumReel.PREMIUM_AMOUNT,
  PREMIUM_CURRENCIES: premiumReel.PREMIUM_CURRENCIES,
  activatePremium: async function (db, paymentRef, uid) {
    faux.activations.push(uid);
    return { newExpiry: Date.now() + 30 * 24 * 3600 * 1000, extended: false };
  }
});

process.env.KPAY_WEBHOOK_SECRET = SECRET;
const handler = require(path.join(RACINE, 'api/kpay-webhook.js'));

/* ---------- Utilitaires de requête / réponse ---------- */

function signer(corps) {
  return crypto.createHmac('sha256', SECRET).update(corps).digest('hex');
}

function requete(corpsObjet, options) {
  options = options || {};
  const corps = Buffer.from(JSON.stringify(corpsObjet), 'utf8');
  const req = new EventEmitter();
  req.method = options.method || 'POST';
  req.headers = {};
  if (options.signature !== null) {
    req.headers['x-kpay-signature'] = options.signature || signer(corps);
  }
  // Le handler branche ses écouteurs de façon synchrone au premier await ;
  // setImmediate laisse ce tour de boucle se terminer avant l'émission.
  setImmediate(function () {
    req.emit('data', corps);
    req.emit('end');
  });
  return req;
}

function reponse() {
  const res = { code: null, corps: null };
  res.status = function (c) { res.code = c; return res; };
  res.json = function (o) { res.corps = o; return res; };
  res.end = function () { return res; };
  return res;
}

const EVENEMENT = { event: 'payment.completed', paymentId: 'pay_123', externalId: 'cmd-1' };

function reinitialiser(surcharges) {
  faux.paiementChezKpay = { status: 'COMPLETED', amount: 1100, currency: 'XOF', externalId: 'cmd-1' };
  faux.docPaiement = { uid: 'utilisateur-1', status: 'pending', externalId: 'cmd-1' };
  faux.appelsGetPayment = 0;
  faux.activations = [];
  Object.assign(faux, surcharges || {});
}

// Les chemins refusés journalisent en console.error : on les tait pour garder
// une sortie de test lisible, sans masquer une vraie erreur de test.
const erreurReelle = console.error;
const logReel = console.log;
test.before(function () { console.error = function () {}; console.log = function () {}; });
test.after(function () { console.error = erreurReelle; console.log = logReel; });

/* ---------- Signature (SECURITY.md §6.2) ---------- */

test('signature absente → 400, aucune activation', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete(EVENEMENT, { signature: null }), res);

  assert.strictEqual(res.code, 400);
  assert.deepStrictEqual(faux.activations, []);
  assert.strictEqual(faux.appelsGetPayment, 0, 'KPay ne doit pas être interrogé sans signature valide');
});

test('signature invalide → 400, aucune activation', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete(EVENEMENT, { signature: 'a'.repeat(64) }), res);

  assert.strictEqual(res.code, 400);
  assert.deepStrictEqual(faux.activations, []);
  assert.strictEqual(faux.appelsGetPayment, 0);
});

test('signature d\'un AUTRE corps → 400 (le rejeu d\'une signature valide ne passe pas)', async function () {
  reinitialiser();
  const res = reponse();
  const signatureDUnAutreCorps = signer(Buffer.from(JSON.stringify({ event: 'autre' }), 'utf8'));
  await handler(requete(EVENEMENT, { signature: signatureDUnAutreCorps }), res);

  assert.strictEqual(res.code, 400);
  assert.deepStrictEqual(faux.activations, []);
});

test('méthode GET → 405 (Premium ne s\'active jamais par navigation, §6.5)', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete(EVENEMENT, { method: 'GET' }), res);

  assert.strictEqual(res.code, 405);
  assert.deepStrictEqual(faux.activations, []);
});

/* ---------- Idempotence (SECURITY.md §6.3) ---------- */

test('webhook rejoué sur un paiement déjà approuvé → aucune seconde activation', async function () {
  reinitialiser({ docPaiement: { uid: 'utilisateur-1', status: 'approved', externalId: 'cmd-1' } });
  const res = reponse();
  await handler(requete(EVENEMENT), res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.corps.already_processed, true);
  assert.deepStrictEqual(faux.activations, [], 'un paiement déjà approuvé ne doit jamais réactiver Premium');
});

test('deux livraisons successives du même évènement → une seule activation', async function () {
  reinitialiser();

  const premiere = reponse();
  await handler(requete(EVENEMENT), premiere);
  assert.deepStrictEqual(faux.activations, ['utilisateur-1']);

  // Ce que fait le vrai activatePremium : le paiement passe à 'approved'.
  faux.docPaiement = { uid: 'utilisateur-1', status: 'approved', externalId: 'cmd-1' };

  const seconde = reponse();
  await handler(requete(EVENEMENT), seconde);

  assert.strictEqual(seconde.corps.already_processed, true);
  assert.strictEqual(faux.activations.length, 1, 'KPay retente : la seconde livraison ne doit rien créditer');
});

/* ---------- Le corps du webhook ne fait pas foi (SECURITY.md §6.4) ---------- */

test('montant falsifié dans le webhook → le montant relu chez KPay fait foi', async function () {
  // Le webhook annonce 1100, KPay dit 100 : c'est KPay qui tranche.
  reinitialiser({ paiementChezKpay: { status: 'COMPLETED', amount: 100, currency: 'XOF', externalId: 'cmd-1' } });
  const res = reponse();
  await handler(Object.assign(requete(Object.assign({ amount: 1100 }, EVENEMENT))), res);

  assert.strictEqual(res.code, 200, 'acquitté pour ne pas provoquer de retries sans fin');
  assert.deepStrictEqual(faux.activations, [], 'un montant non conforme ne doit jamais activer Premium');
});

test('statut non complété chez KPay → aucune activation', async function () {
  reinitialiser({ paiementChezKpay: { status: 'PENDING', amount: 1100, currency: 'XOF', externalId: 'cmd-1' } });
  const res = reponse();
  await handler(requete(EVENEMENT), res);

  assert.deepStrictEqual(faux.activations, []);
});

test('devise hors liste blanche → aucune activation (1100 CDF ≠ 1100 XOF)', async function () {
  reinitialiser({ paiementChezKpay: { status: 'COMPLETED', amount: 1100, currency: 'CDF', externalId: 'cmd-1' } });
  const res = reponse();
  await handler(requete(EVENEMENT), res);

  assert.deepStrictEqual(faux.activations, []);
});

test('paiement inconnu de Firestore → aucune activation', async function () {
  reinitialiser({ docPaiement: null });
  const res = reponse();
  await handler(requete(EVENEMENT), res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(faux.activations, [], 'un paiement jamais initié par nous ne nous appartient pas');
});

test('externalId incohérent → aucune activation', async function () {
  reinitialiser({ docPaiement: { uid: 'utilisateur-1', status: 'pending', externalId: 'une-autre-commande' } });
  const res = reponse();
  await handler(requete(EVENEMENT), res);

  assert.deepStrictEqual(faux.activations, []);
});

test('évènement non pertinent → acquitté sans activation', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete({ event: 'payment.failed', paymentId: 'pay_123' }), res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(faux.activations, []);
});

/* ---------- Panne technique : KPay doit retenter ---------- */

test('KPay injoignable → 500 pour déclencher une nouvelle tentative', async function () {
  reinitialiser({ paiementChezKpay: null });   // getPayment lève
  const res = reponse();
  await handler(requete(EVENEMENT), res);

  assert.strictEqual(res.code, 500, 'un échec technique doit être retenté, pas acquitté');
  assert.deepStrictEqual(faux.activations, []);
});

/* ---------- Cas nominal ---------- */

test('paiement conforme → Premium activé une fois', async function () {
  reinitialiser();
  const res = reponse();
  await handler(requete(EVENEMENT), res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.corps.activated, true);
  assert.deepStrictEqual(faux.activations, ['utilisateur-1']);
});
