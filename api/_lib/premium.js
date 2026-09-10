// Activation de l'abonnement Premium — logique partagée par TOUS les
// prestataires de paiement (FedaPay, KPay...).
//
// Extrait du webhook FedaPay pour qu'un second prestataire n'en crée pas une
// copie : deux implémentations de la durée d'abonnement finiraient
// immanquablement par diverger, et un écart ici se paie en jours d'accès
// offerts ou volés à des clients.

const PREMIUM_AMOUNT = 1100;
const PREMIUM_CURRENCY = 'XOF';
const PREMIUM_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Marque le paiement comme approuvé et (pro)longe l'abonnement de 30 jours.
 *
 * Un abonnement déjà actif est PROLONGÉ à partir de sa date d'expiration
 * existante, jamais écrasé depuis maintenant : sans ça, un client qui
 * renouvelle en avance perdrait ses jours restants.
 *
 * L'appelant doit avoir vérifié AVANT d'appeler : signature du webhook,
 * statut réellement payé, montant, et que le paiement nous appartient.
 */
async function activatePremium(db, paymentRef, uid) {
  const now = Date.now();
  const subRef = db.collection('subscriptions').doc(uid);
  const subSnap = await subRef.get();
  const current = subSnap.exists ? subSnap.data() : null;
  const isCurrentlyActive = current && current.status === 'active' && current.premium_expires_at > now;

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

  return { newExpiry: newExpiry, extended: !!isCurrentlyActive };
}

module.exports = { PREMIUM_AMOUNT, PREMIUM_CURRENCY, PREMIUM_DURATION_MS, activatePremium };
