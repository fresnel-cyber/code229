// POST /api/kpay-webhook
// Seul point d'activation de Premium pour KPay — l'URL de retour du navigateur
// n'active JAMAIS rien. Idempotent par construction : la clé du document
// payments/{kpay_<paymentId>} est l'identifiant KPay lui-même.
const { db } = require('./_lib/firebaseAdmin');
const { getPayment, verifyWebhookSignature } = require('./_lib/kpay');
const { PREMIUM_AMOUNT, activatePremium } = require('./_lib/premium');

function readRawBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    // Octets BRUTS : la signature porte sur ce que KPay a réellement envoyé.
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-kpay-signature'];
  console.log('[kpay] webhook reçu — octets:', rawBody.length, '| signature présente:', !!signature);

  // Le secret de signature peut être distinct de la clé secrète d'API selon la
  // configuration du tableau de bord : on accepte les deux noms de variable.
  const secret = process.env.KPAY_WEBHOOK_SECRET || process.env.KPAY_SECRET_KEY;
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    console.error('[kpay] signature invalide, rien activé');
    res.status(400).json({ error: 'Signature invalide.' });
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    console.error('[kpay] corps illisible malgré une signature valide');
    res.status(400).json({ error: 'Charge utile invalide.' });
    return;
  }

  console.log('[kpay] signature valide — évènement:', event.event, '| paymentId:', event.paymentId);

  // Seul un paiement effectivement complété nous intéresse ; tout le reste est
  // acquitté sans action (sinon KPay retenterait indéfiniment).
  if (event.event !== 'payment.completed') {
    console.log('[kpay] ignoré (évènement non pertinent):', event.event);
    res.status(200).json({ received: true, ignored: event.event });
    return;
  }

  try {
    if (!event.paymentId) {
      console.error('[kpay] évènement sans paymentId, impossible de rattacher');
      res.status(200).json({ received: true, error: 'paymentId manquant.' });
      return;
    }

    // Règle d'or KPay : on ne se fie JAMAIS au statut ni au montant annoncés
    // dans le corps du webhook. On relit le paiement à la source avant toute
    // activation. Si cet appel échoue pour une raison technique, l'exception
    // remonte au catch et renvoie 500 — KPay retentera, plutôt que de
    // considérer à tort un vrai paiement comme non conforme.
    const authoritative = await getPayment(event.paymentId);
    const statusOk = String(authoritative.status).toUpperCase() === 'COMPLETED';
    const amountOk = Number(authoritative.amount) === PREMIUM_AMOUNT;
    console.log('[kpay] paiement relu chez KPay:', event.paymentId,
      '| statut:', authoritative.status, '| montant:', authoritative.amount);

    if (!statusOk || !amountOk) {
      console.error('[kpay] paiement NON CONFORME, aucune activation:', event.paymentId,
        JSON.stringify({ statut: authoritative.status, montant_attendu: PREMIUM_AMOUNT, montant_recu: authoritative.amount }));
      res.status(200).json({ received: true, error: 'Paiement non conforme, ignoré.' });
      return;
    }

    // Préfixe volontaire : les identifiants FedaPay sont numériques et
    // vivent dans la même collection. Le préfixe garantit qu'aucun paiement
    // d'un prestataire ne peut jamais écraser celui d'un autre.
    const paymentRef = db.collection('payments').doc('kpay_' + event.paymentId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      // Paiement jamais créé via /api/create-payment : il ne nous appartient
      // pas. On acquitte quand même pour ne pas provoquer de retries sans fin.
      console.error('[kpay] aucun doc payments/kpay_' + event.paymentId + ' — paiement inconnu, aucune activation');
      res.status(200).json({ received: true, error: 'Paiement inconnu.' });
      return;
    }

    const payment = paymentSnap.data();

    if (payment.status === 'approved') {
      console.log('[kpay] déjà traité, aucune double activation:', event.paymentId);
      res.status(200).json({ received: true, already_processed: true });
      return;
    }

    // Le lien avec NOTRE commande : l'externalId que nous avons généré.
    const externalId = authoritative.externalId || event.externalId;
    if (externalId && payment.externalId && externalId !== payment.externalId) {
      console.error('[kpay] externalId incohérent, aucune activation:', event.paymentId);
      res.status(200).json({ received: true, error: 'Paiement non rattachable.' });
      return;
    }

    const result = await activatePremium(db, paymentRef, payment.uid);
    console.log('[kpay] Premium activé — uid:', payment.uid,
      '| expire le:', new Date(result.newExpiry).toISOString(),
      '| prolongation d\'un abonnement en cours:', result.extended);

    res.status(200).json({ received: true, activated: true, premium_expires_at: result.newExpiry });
  } catch (e) {
    console.error('[kpay] erreur technique (KPay retentera):', e && e.message, e && e.stack);
    // 500 volontaire : on VEUT une nouvelle tentative si l'échec est
    // technique (Firestore indisponible...), contrairement aux cas métier
    // ci-dessus qu'on acquitte délibérément en 200.
    res.status(500).json({ error: 'Erreur serveur.' });
  }
}

// ATTENTION à l'ordre : `module.exports = handler` remplace tout l'objet
// exports, la config doit donc être attachée APRÈS — sinon elle est perdue
// en silence, Vercel parse le corps, et plus aucune signature n'est vérifiable.
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
