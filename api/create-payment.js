// POST /api/create-payment
// Crée une transaction d'abonnement Premium chez le prestataire actif et
// renvoie l'URL de paiement sécurisée. Ne débloque JAMAIS Premium ici : seuls
// les webhooks (api/fedapay-webhook.js, api/kpay-webhook.js), après
// re-vérification côté serveur, ont le droit d'activer un abonnement.
const { db, auth } = require('./_lib/firebaseAdmin');
const { PREMIUM_AMOUNT, PREMIUM_CURRENCY } = require('./_lib/premium');
const { createTransactionWithCheckout } = require('./_lib/fedapay');
const { initPayment } = require('./_lib/kpay');

const DESCRIPTION = 'CODE 229 Premium — 30 jours';

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

  const provider = (process.env.PAYMENT_PROVIDER || 'kpay').toLowerCase();
  const appBaseUrl = process.env.APP_BASE_URL || 'https://www.code229.online';

  try {
    if (provider === 'kpay') {
      // externalId : NOTRE référence de commande, que le webhook recroisera
      // avec le document Firestore pour confirmer que le paiement est bien
      // le nôtre.
      const externalId = 'c229_' + uid + '_' + Date.now();
      const result = await initPayment({
        amount: PREMIUM_AMOUNT,
        externalId: externalId,
        returnUrl: appBaseUrl + '/?payment=return',
        cancelUrl: appBaseUrl + '/?payment=cancel',
        description: DESCRIPTION,
        metadata: { uid: uid, product: 'premium_30_days' }
      });

      await db.collection('payments').doc('kpay_' + result.paymentId).set({
        uid: uid,
        provider: 'kpay',
        amount: PREMIUM_AMOUNT,
        currency: PREMIUM_CURRENCY,
        status: 'pending',
        externalId: externalId,
        paymentId: result.paymentId,
        created_at: Date.now()
      });

      console.log('[kpay] paiement initié — uid:', uid, '| paymentId:', result.paymentId);
      res.status(200).json({ checkoutUrl: result.gatewayUrl, paymentId: result.paymentId });
      return;
    }

    if (provider === 'fedapay') {
      const { transactionId, checkoutUrl } = await createTransactionWithCheckout({
        amount: PREMIUM_AMOUNT,
        currency: PREMIUM_CURRENCY,
        description: DESCRIPTION,
        callbackUrl: appBaseUrl + '/?payment=return'
      });

      // Clé = ID FedaPay : c'est ce qui rend le traitement du webhook
      // idempotent par construction (voir fedapay-webhook.js).
      await db.collection('payments').doc(String(transactionId)).set({
        uid: uid,
        provider: 'fedapay',
        amount: PREMIUM_AMOUNT,
        currency: PREMIUM_CURRENCY,
        status: 'pending',
        created_at: Date.now()
      });

      res.status(200).json({ checkoutUrl: checkoutUrl, transactionId: String(transactionId) });
      return;
    }

    console.error('create-payment: PAYMENT_PROVIDER inconnu:', provider);
    res.status(500).json({ error: 'Paiement indisponible pour le moment.' });
  } catch (e) {
    console.error('create-payment error (' + provider + '):', e && e.message);
    res.status(500).json({ error: 'Impossible de créer le paiement, réessaie dans un instant.' });
  }
};
