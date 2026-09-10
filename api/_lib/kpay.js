// Fine couche au-dessus de l'API KPay (mode TEST uniquement pour l'instant).
// Pas de SDK officiel : deux appels HTTP suffisent, et `fetch` est natif sur
// le runtime Node de Vercel — inutile d'ajouter une dépendance.
const crypto = require('crypto');

/* ─────────────────────────────────────────────────────────────────────────
   POINTS À CONFIRMER SUR LE TABLEAU DE BORD KPAY

   Le contrat d'initiation n'a pas pu être vérifié dans la documentation
   publique (le site documente aussi une base api.k-pay.app avec un en-tête
   Authorization: Bearer). Ces trois éléments sont donc regroupés ici pour
   être corrigés en un seul endroit si le premier test réel les dément :

     1. KPAY_BASE_URL + INIT_PATH  → l'URL exacte d'initiation
     2. les en-têtes d'authentification ci-dessous
     3. les noms des champs de réponse (gatewayUrl / paymentId)

   La base est surchargeable par variable d'environnement pour permettre de
   corriger sans redéployer de code.
   ───────────────────────────────────────────────────────────────────────── */
const KPAY_BASE_URL = process.env.KPAY_BASE_URL || 'https://admin.kpay.site';
const INIT_PATH = '/api/v1/payments/init';

/**
 * Crée un paiement en mode « Hosted Gateway » et renvoie l'URL de redirection.
 * Ne renvoie JAMAIS les clés ni la réponse brute à l'appelant : en cas de
 * réponse inattendue on ne remonte que les NOMS des champs reçus, jamais
 * leurs valeurs, pour ne rien fuiter dans les journaux.
 */
async function initPayment(params) {
  const res = await fetch(KPAY_BASE_URL + INIT_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.KPAY_API_KEY,
      'X-Secret-Key': process.env.KPAY_SECRET_KEY
    },
    body: JSON.stringify({
      amount: params.amount,
      externalId: params.externalId,
      returnUrl: params.returnUrl,
      cancelUrl: params.cancelUrl,
      description: params.description,
      metadata: params.metadata
    })
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* réponse non JSON */ }

  if (!res.ok || !data) {
    throw new Error('KPay init: HTTP ' + res.status + ' — ' + String(text).slice(0, 200));
  }

  // Tolérance sur la forme de la réponse (camelCase, snake_case, ou objet
  // `data` englobant) : le premier test réel tranchera, et l'erreur ci-dessous
  // dira exactement quels champs KPay a renvoyés.
  const body = data.data && typeof data.data === 'object' ? data.data : data;
  const gatewayUrl = body.gatewayUrl || body.gateway_url || body.paymentUrl || body.url;
  const paymentId = body.paymentId || body.payment_id || body.id;

  if (!gatewayUrl || !paymentId) {
    throw new Error('KPay init: réponse inattendue, champs reçus = ' + Object.keys(body).join(','));
  }
  return { gatewayUrl: gatewayUrl, paymentId: String(paymentId) };
}

/**
 * Vérifie la signature d'un webhook KPay.
 * Documentation officielle : en-tête `X-KPAY-Signature`, HMAC-SHA256 en
 * hexadécimal calculé sur le CORPS BRUT reçu (surtout pas re-sérialisé),
 * comparé en temps constant.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(String(signatureHeader).trim().toLowerCase(), 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  // timingSafeEqual exige des longueurs identiques : on compare d'abord.
  if (received.length !== computed.length) return false;
  return crypto.timingSafeEqual(received, computed);
}

module.exports = { initPayment, verifyWebhookSignature };
