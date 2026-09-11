// Fine couche au-dessus de l'API KPay.
//
// Le mode TEST et le mode LIVE partagent exactement ce code : seules les
// clés changent (variables d'environnement). Rien ici ne doit dépendre de
// l'environnement, sous peine de tester un chemin différent de celui qui
// encaissera réellement.
// Pas de SDK officiel : deux appels HTTP suffisent, et `fetch` est natif sur
// le runtime Node de Vercel — inutile d'ajouter une dépendance.
const crypto = require('crypto');

/* ─────────────────────────────────────────────────────────────────────────
   CONTRAT KPAY — confirmé par un paiement de test réel qui a abouti.

   Base + chemin d'initiation, en-têtes X-API-Key / X-Secret-Key et noms des
   champs de réponse (gatewayUrl / paymentId) sont donc validés, pas déduits.

   KPAY_BASE_URL reste surchargeable par variable d'environnement : si KPay
   déplaçait un jour son API, la correction se fait sans redéployer de code.

   Contrainte structurante du mode GATEWAY : l'initiation n'accepte AUCUNE
   devise. KPay la déduit du numéro de téléphone que le client saisit sur la
   page hébergée, et ne convertit rien — `amount` vaut donc 1100 unités de SA
   devise. C'est la liste blanche d'opérateurs de l'application (tableau de
   bord KPay) qui restreint les pays autorisés, doublée du contrôle de devise
   du webhook. Voir PREMIUM_CURRENCIES dans _lib/premium.js.
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
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      returnUrl: params.returnUrl,
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
 * Relit un paiement directement chez KPay.
 *
 * La documentation KPay en fait sa « règle d'or » : ne marquer une commande
 * payée qu'après une signature valide ET un statut COMPLETED confirmé par
 * cet appel. On ne fait donc jamais confiance au seul corps du webhook pour
 * le statut ou le montant — c'est la même précaution que côté FedaPay.
 */
async function getPayment(paymentId) {
  const res = await fetch(KPAY_BASE_URL + '/api/v1/payments/' + encodeURIComponent(paymentId), {
    method: 'GET',
    headers: {
      'X-API-Key': process.env.KPAY_API_KEY,
      'X-Secret-Key': process.env.KPAY_SECRET_KEY
    }
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* réponse non JSON */ }
  if (!res.ok || !data) {
    throw new Error('KPay get: HTTP ' + res.status + ' — ' + String(text).slice(0, 200));
  }
  return data.data && typeof data.data === 'object' ? data.data : data;
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

module.exports = { initPayment, getPayment, verifyWebhookSignature };
