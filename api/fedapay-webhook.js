// POST /api/fedapay-webhook
// Seul point d'activation de Premium. Ne fait JAMAIS confiance au payload du
// webhook pour l'argent : après vérification de signature, on relit la
// transaction directement chez FedaPay (montant, devise, statut réels) avant
// de toucher à quoi que ce soit. Idempotent par construction : la clé du doc
// `payments/{id}` est l'ID de transaction FedaPay lui-même.
const { db } = require('./_lib/firebaseAdmin');
const { retrieveTransaction, resolveCurrencyIso, constructWebhookEvent } = require('./_lib/fedapay');

const PREMIUM_AMOUNT = 1000;
const PREMIUM_CURRENCY = 'XOF';
const PREMIUM_DURATION_MS = 30 * 24 * 60 * 60 * 1000;


function readRawBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    // On renvoie les OCTETS BRUTS, sans toString() : la signature porte sur
    // les octets exacts reçus. Le SDK FedaPay accepte un Buffer et fait
    // lui-même la conversion utf8 (WebhookSignature.verifyHeader).
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/* L'ID de la transaction ne se trouve pas au même endroit selon le format
   d'événement : `object_id` (format ressource Event du SDK) ou `entity.id`
   (format des webhooks FedaPay, qui utilisent `name` + `entity`). On couvre
   les deux plutôt que de parier sur un seul. */
function extractTransactionId(event) {
  if (!event) return null;
  if (event.object_id) return event.object_id;
  if (event.entity && !Array.isArray(event.entity) && event.entity.id) return event.entity.id;
  if (event.entity_id) return event.entity_id;
  if (event.data && event.data.id) return event.data.id;
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-fedapay-signature'];
  console.log('[webhook] reçu — octets:', rawBody.length, '| signature présente:', !!signature);

  let event;
  try {
    event = constructWebhookEvent(rawBody, signature, process.env.FEDAPAY_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[webhook] signature invalide:', e.message);
    res.status(400).json({ error: 'Signature invalide.' });
    return;
  }

  // Le SDK expose `type` sur la ressource Event, mais les webhooks FedaPay
  // envoient `name` : on accepte les deux plutôt que de parier sur un seul
  // format et de rater silencieusement tous les paiements.
  const eventName = event.name || event.type;
  console.log('[webhook] signature valide — évènement:', eventName);

  // On ne traite que les paiements confirmés ; tout autre événement (créé,
  // décliné, annulé...) est simplement acquitté sans action.
  if (eventName !== 'transaction.approved') {
    console.log('[webhook] ignoré (évènement non pertinent):', eventName);
    res.status(200).json({ received: true, ignored: eventName });
    return;
  }

  const transactionId = extractTransactionId(event);
  if (!transactionId) {
    console.error('[webhook] transaction.approved sans ID exploitable — clés reçues:', Object.keys(event).join(','));
    res.status(200).json({ received: true, error: 'ID de transaction introuvable dans l\'événement.' });
    return;
  }
  console.log('[webhook] transaction détectée:', transactionId);

  try {
    // Re-vérification indépendante auprès de FedaPay — jamais confiance au
    // seul évènement webhook pour le statut/montant/devise.
    const transaction = await retrieveTransaction(transactionId);
    // Number() : l'API peut renvoyer le montant en chaîne selon les versions.
    // La comparaison reste stricte sur la valeur (Number('100') !== 1000).
    const amountOk = Number(transaction.amount) === PREMIUM_AMOUNT;
    const currencyIso = await resolveCurrencyIso(transaction);
    const currencyOk = currencyIso === PREMIUM_CURRENCY;
    const paidOk = typeof transaction.wasPaid === 'function' ? transaction.wasPaid() : transaction.status === 'approved';

    console.log('[webhook] transaction relue chez FedaPay:', transactionId,
      '| statut:', transaction.status, '| montant:', transaction.amount,
      '| devise:', currencyIso, '(currency_id:', transaction.currency_id + ')');

    if (!paidOk || !amountOk || !currencyOk) {
      console.error('[webhook] transaction NON CONFORME, aucune activation:', transactionId,
        JSON.stringify({
          payee: paidOk,
          montant_attendu: PREMIUM_AMOUNT,
          montant_recu: transaction.amount,
          devise_attendue: PREMIUM_CURRENCY,
          devise_recue: currencyIso,
          currency_field_raw: transaction.currency,
          currency_id: transaction.currency_id
        }));
      res.status(200).json({ received: true, error: 'Transaction non conforme, ignorée.' });
      return;
    }

    const paymentRef = db.collection('payments').doc(String(transactionId));
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      // Transaction inconnue de nous (jamais créée via /api/create-payment) :
      // on n'active rien, mais on répond 2xx pour ne pas déclencher de retries
      // infinis côté FedaPay.
      console.error('[webhook] aucun doc payments/' + transactionId + ' — transaction jamais créée via /api/create-payment, aucune activation.');
      res.status(200).json({ received: true, error: 'Paiement inconnu.' });
      return;
    }

    if (paymentSnap.data().status === 'approved') {
      // Déjà traité (webhook reçu plusieurs fois) : idempotent, on s'arrête là.
      console.log('[webhook] déjà traité, aucune double activation:', transactionId);
      res.status(200).json({ received: true, already_processed: true });
      return;
    }

    const uid = paymentSnap.data().uid;
    const now = Date.now();
    const subRef = db.collection('subscriptions').doc(uid);
    const subSnap = await subRef.get();
    const current = subSnap.exists ? subSnap.data() : null;
    const isCurrentlyActive = current && current.status === 'active' && current.premium_expires_at > now;

    // Un abonnement déjà actif se prolonge à partir de sa date d'expiration
    // existante plutôt que d'être écrasé depuis maintenant (évite de perdre
    // des jours si le webhook arrive après un renouvellement anticipé).
    const startBase = isCurrentlyActive ? current.premium_expires_at : now;
    const newExpiry = startBase + PREMIUM_DURATION_MS;

    await db.runTransaction(async function (t) {
      t.update(paymentRef, { status: 'approved', confirmed_at: now });
      t.set(subRef, {
        status: 'active',
        premium_started_at: (current && current.premium_started_at) || now,
        premium_expires_at: newExpiry,
        updated_at: now
      }, { merge: true });
    });

    console.log('[webhook] Premium activé — uid:', uid, '| expire le:', new Date(newExpiry).toISOString(),
      '| prolongation d\'un abonnement en cours:', isCurrentlyActive);
    res.status(200).json({ received: true, activated: true, uid: uid, premium_expires_at: newExpiry });
  } catch (e) {
    console.error('[webhook] erreur technique (FedaPay retentera):', e && e.message, e && e.stack);
    // 500 : on VEUT que FedaPay retente si notre vérification a échoué pour
    // une raison technique (Firestore indisponible, etc.), contrairement aux
    // cas métier ci-dessus qu'on acquitte volontairement en 200.
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};

/* Vercel doit nous laisser le corps BRUT : la signature porte sur les octets
   exacts envoyés par FedaPay, pas sur un JSON.parse puis re-sérialisé.
   ATTENTION à l'ordre : `module.exports = handler` remplace entièrement
   l'objet exports, donc la config doit être attachée APRÈS, sinon elle est
   silencieusement perdue — et sans corps brut, aucune signature ne peut
   être validée, donc aucun paiement ne serait jamais activé. */
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
