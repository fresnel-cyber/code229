// Initialisation partagée du SDK Firebase Admin, réutilisée par toutes les
// fonctions serverless. Séparé dans son propre module pour n'appeler
// admin.initializeApp() qu'une seule fois même si Vercel réutilise
// l'instance de la fonction entre plusieurs invocations (warm start).
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON manquant dans les variables d\'environnement.');
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
