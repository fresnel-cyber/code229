// POST /api/kpay-webhook
// Seul point d'activation de Premium pour KPay — l'URL de retour du navigateur
// n'active JAMAIS rien. Idempotent par construction : la clé du document
// payments/{kpay_<paymentId>} est l'identifiant KPay lui-même.
const { db } = require('./_lib/firebaseAdmin');
const { getPayment, verifyWebhookSignature } = require('./_lib/kpay');
const { PREMIUM_AMOUNT, PREMIUM_CURRENCIES, activatePremium } = require('./_lib/premium');

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
  // KPay génère un SECRET DE WEBHOOK distinct de la clé secrète d'API : c'est
  // lui qui signe les notifications. On retombe sur KPAY_SECRET_KEY seulement
  // s'il n'est pas configuré, mais ce repli ne produira pas une signature
  // valide — d'où le diagnostic ci-dessous en cas d'échec.
  const secret = process.env.KPAY_WEBHOOK_SECRET || process.env.KPAY_SECRET_KEY;
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    // Diagnostic sans fuite : on ne journalise ni le secret, ni la signature,
    // uniquement de quoi distinguer « mauvais secret » de « format inattendu ».
    const sig = String(signature || '');
    console.error('[kpay] signature invalide, rien activé —',
      'secret dédié configuré:', !!process.env.KPAY_WEBHOOK_SECRET,
      '| longueur signature:', sig.length, '(64 attendu pour du HMAC-SHA256 hex)',
      '| hexadécimal pur:', /^[0-9a-f]+$/i.test(sig));
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

    // Contrôle de devise, indispensable parce que KPay ne convertit rien :
    // le montant vaut 1100 unités de la devise du payeur, déduite du numéro
    // qu'il saisit. 1100 CDF ne sont pas 1100 XOF. La liste blanche
    // d'opérateurs de l'application est la première protection ; celle-ci est
    // la seconde, au cas où un pays serait rouvert sans y repenser.
    //
    // Le champ s'appelle bien `currency` : confirmé en production le
    // 11/09/2026 par un paiement live (MTN MoMo Bénin), qui a renvoyé XOF.
    //
    // Devise absente de la réponse : on ACCEPTE malgré tout, en le signalant
    // bruyamment. Bloquer un client qui a réellement payé est un échec pire
    // que le risque couvert ici, lequel est déjà tenu par la liste blanche
    // d'opérateurs de l'application. Si ce message apparaît, c'est que KPay a
    // changé sa réponse : il faut alors corriger le nom du champ, pas
    // supprimer le garde-fou.
    const currency = authoritative.currency || authoritative.currencyCode || authoritative.currency_code;
    const currencyOk = currency ? PREMIUM_CURRENCIES.indexOf(String(currency).toUpperCase()) !== -1 : true;
    if (!currency) {
      console.error('[kpay] ATTENTION : aucune devise dans la réponse KPay, contrôle impossible. Champs reçus =',
        Object.keys(authoritative).join(','));
    }

    console.log('[kpay] paiement relu chez KPay:', event.paymentId,
      '| statut:', authoritative.status, '| montant:', authoritative.amount, '| devise:', currency || '(absente)');

    if (!statusOk || !amountOk || !currencyOk) {
      console.error('[kpay] paiement NON CONFORME, aucune activation:', event.paymentId,
        JSON.stringify({
          statut: authoritative.status,
          montant_attendu: PREMIUM_AMOUNT, montant_recu: authoritative.amount,
          devises_acceptees: PREMIUM_CURRENCIES, devise_recue: currency || null
        }));
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
