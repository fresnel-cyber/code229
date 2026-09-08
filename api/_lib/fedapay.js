// Fine couche au-dessus du SDK officiel `fedapay` (npm) — on utilise le SDK
// plutôt que de ré-implémenter les appels REST à la main, en particulier
// pour la vérification de signature webhook (HMAC + tolérance anti-rejeu)
// que FedaPay documente peu publiquement mais que leur SDK gère correctement.
const { FedaPay, Transaction, Currency, Webhook } = require('fedapay');

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

// L'API FedaPay ne renvoie PAS un objet `currency` développé sur une
// transaction relue, mais un simple `currency_id` (confirmé par les fixtures
// du SDK). On résout donc l'ISO réel via l'API Currency plutôt que de lire un
// champ qui n'existe pas — sans quoi le contrôle de devise échoue toujours et
// aucun paiement légitime n'est jamais activé. On garde le chemin direct au
// cas où une version de l'API renvoie bien l'objet développé.
// Volontairement SANS try/catch : si la résolution échoue (réseau), l'erreur
// doit remonter pour que le webhook réponde 500 et que FedaPay retente,
// plutôt que de classer à tort un vrai paiement comme non conforme.
async function resolveCurrencyIso(transaction) {
  // Chemin direct si currency est déjà un objet avec iso (versions API qui le renvoient développé)
  if (transaction.currency && typeof transaction.currency === 'object' && transaction.currency.iso) {
    return transaction.currency.iso;
  }

  // Chemin principal : résoudre via currency_id (format standard du SDK ^1.2.5)
  if (!transaction.currency_id) {
    console.warn('[fedapay] aucun currency_id trouvé pour résoudre la devise');
    return null;
  }

  const currency = await Currency.retrieve(transaction.currency_id);
  const iso = currency && currency.iso ? currency.iso : null;
  
  if (!iso) {
    console.warn('[fedapay] Currency.retrieve(' + transaction.currency_id + ') n\'a pas retourné d\'ISO');
  }
  
  return iso;
}

// Vérifie l'authenticité d'un webhook (corps BRUT requis, pas le JSON
// re-sérialisé — la signature porte sur les octets exacts envoyés par
// FedaPay). Lève une erreur si la signature ou le timestamp est invalide.
function constructWebhookEvent(rawBody, signatureHeader, secret) {
  return Webhook.constructEvent(rawBody, signatureHeader, secret);
}

module.exports = { createTransactionWithCheckout, retrieveTransaction, resolveCurrencyIso, constructWebhookEvent };
