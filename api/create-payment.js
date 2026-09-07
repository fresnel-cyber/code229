// POST /api/create-payment
// Crée une transaction FedaPay pour l'abonnement Premium (1000 FCFA / 30 jours)
// et renvoie l'URL de paiement sécurisée. Ne débloque jamais Premium ici —
// seul le webhook (api/fedapay-webhook.js), après re-vérification côté
// serveur, a le droit d'activer un abonnement.
const { db, auth } = require('./_lib/firebaseAdmin');
const { createTransactionWithCheckout } = require('./_lib/fedapay');

const PREMIUM_AMOUNT = 1000;
const PREMIUM_CURRENCY = 'XOF';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }

  let uid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    res.status(401).json({ error: 'Session invalide, recharge la page.' });
    return;
  }

  try {
    const appBaseUrl = process.env.APP_BASE_URL || 'https://code229.vercel.app';
    const { transactionId, checkoutUrl } = await createTransactionWithCheckout({
      amount: PREMIUM_AMOUNT,
      currency: PREMIUM_CURRENCY,
      description: 'CODE 229 Premium — 30 jours',
      callbackUrl: appBaseUrl + '/?payment=return'
    });

    // Trace locale de la transaction, clé = ID FedaPay : c'est ce qui rend le
    // traitement du webhook idempotent par construction (voir fedapay-webhook.js).
    await db.collection('payments').doc(String(transactionId)).set({
      uid: uid,
      amount: PREMIUM_AMOUNT,
      currency: PREMIUM_CURRENCY,
      status: 'pending',
      created_at: Date.now()
    });

    res.status(200).json({ checkoutUrl: checkoutUrl, transactionId: String(transactionId) });
  } catch (e) {
    console.error('create-payment error:', e);
    res.status(500).json({ error: 'Impossible de créer le paiement, réessaie dans un instant.' });
  }
};
