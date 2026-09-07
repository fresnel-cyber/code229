// Fine couche au-dessus du SDK officiel `fedapay` (npm) — on utilise le SDK
// plutôt que de ré-implémenter les appels REST à la main, en particulier
// pour la vérification de signature webhook (HMAC + tolérance anti-rejeu)
// que FedaPay documente peu publiquement mais que leur SDK gère correctement.
const { FedaPay, Transaction, Webhook } = require('fedapay');

FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment(process.env.FEDAPAY_ENV === 'live' ? 'live' : 'sandbox');

// Crée une transaction FedaPay (montant entier, devise ISO) puis génère son
// lien de paiement sécurisé. Ne PAS pré-sélectionner `mode` : on laisse le
// client choisir son moyen de paiement (Mobile Money, carte...) sur la page
// FedaPay elle-même, conformément au flow demandé.
async function createTransactionWithCheckout({ amount, currency, description, callbackUrl }) {
  const transaction = await Transaction.create({
    description: description,
    amount: amount,
    currency: { iso: currency },
    callback_url: callbackUrl
  });
  const tokenResult = await transaction.generateToken();
  return { transactionId: transaction.id, checkoutUrl: tokenResult.url };
}

// Relit une transaction directement chez FedaPay — jamais confiance au seul
// payload du webhook pour le statut/montant/devise.
async function retrieveTransaction(transactionId) {
  return Transaction.retrieve(transactionId);
}

// Vérifie l'authenticité d'un webhook (corps BRUT requis, pas le JSON
// re-sérialisé — la signature porte sur les octets exacts envoyés par
// FedaPay). Lève une erreur si la signature ou le timestamp est invalide.
function constructWebhookEvent(rawBody, signatureHeader, secret) {
  return Webhook.constructEvent(rawBody, signatureHeader, secret);
}

module.exports = { createTransactionWithCheckout, retrieveTransaction, constructWebhookEvent };
