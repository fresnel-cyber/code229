#!/usr/bin/env node
// Fusionne l'abonnement d'un compte vers un autre — le cas du client qui a
// changé de téléphone, n'a pas retrouvé son accès et a repayé.
//
// Les jours restants de la SOURCE sont ajoutés à la CIBLE, puis la source est
// désactivée. La règle de prolongation est celle de computeNewExpiry(), pour
// qu'une fusion n'accorde jamais autre chose que ce qu'un paiement accorde.
//
// Simulation par défaut : rien n'est écrit tant que --appliquer n'est pas passé.
//
// Usage :
//   node scripts/fusionner_abonnements.js --de=UID_ANONYME --vers=UID_GOOGLE
//   node scripts/fusionner_abonnements.js --de=… --vers=… --appliquer

(function loadEnvLocal() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || process.env[m[1]]) return;
    let v = m[2].trim();
    if (v.length > 1 && ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  });
})();

const { db } = require('../api/_lib/firebaseAdmin');
const { computeNewExpiry } = require('../api/_lib/premium');

const DAY_MS = 24 * 60 * 60 * 1000;

function flags() {
  const f = {};
  process.argv.slice(2).forEach(function (a) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (m) f[m[1]] = m[2] === undefined ? true : m[2];
  });
  return f;
}

function dt(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

async function main() {
  const f = flags();
  if (!f.de || !f.vers) {
    throw new Error('Usage : node scripts/fusionner_abonnements.js --de=UID --vers=UID [--appliquer]');
  }
  if (f.de === f.vers) throw new Error('La source et la cible sont le même compte.');

  const now = Date.now();
  const refSource = db.collection('subscriptions').doc(f.de);
  const refCible = db.collection('subscriptions').doc(f.vers);
  const [snapSource, snapCible] = await Promise.all([refSource.get(), refCible.get()]);

  if (!snapSource.exists) throw new Error('Aucun abonnement sur le compte source ' + f.de);
  const source = snapSource.data();
  const cible = snapCible.exists ? snapCible.data() : null;

  const restantMs = Math.max(0, (source.premium_expires_at || 0) - now);
  if (restantMs <= 0) throw new Error('L\'abonnement source est déjà expiré : rien à transférer.');

  const calcul = computeNewExpiry(cible, now, restantMs);

  console.log('SOURCE ' + f.de);
  console.log('   expire le ' + dt(source.premium_expires_at) +
    '  (' + (restantMs / DAY_MS).toFixed(1) + ' jours restants)');
  console.log('CIBLE  ' + f.vers);
  console.log('   avant : ' + (cible ? dt(cible.premium_expires_at) : 'aucun abonnement'));
  console.log('   après : ' + dt(calcul.newExpiry) +
    (calcul.extended ? '  (prolongé)' : '  (nouvel abonnement)'));

  if (!f.appliquer) {
    console.log('\nSimulation — rien n\'a été écrit. Ajoute --appliquer pour exécuter.');
    return;
  }

  // Un seul batch : on ne veut pas d'un état où la source est désactivée sans
  // que la cible ait été créditée.
  const batch = db.batch();
  batch.set(refCible, {
    status: 'active',
    premium_expires_at: calcul.newExpiry,
    updated_at: now,
    merged_from: f.de,
    merged_at: now
  }, { merge: true });
  // La source est neutralisée, pas supprimée : la trace de ce qui a été payé
  // doit rester lisible si le client revient poser la question.
  batch.set(refSource, {
    status: 'merged',
    merged_into: f.vers,
    merged_at: now,
    premium_expires_at_before_merge: source.premium_expires_at,
    premium_expires_at: now
  }, { merge: true });
  await batch.commit();

  console.log('\nFusion appliquée. ' + f.vers + ' est Premium jusqu\'au ' + dt(calcul.newExpiry) + '.');
}

main().then(function () { process.exit(0); })
  .catch(function (e) { console.error('Erreur : ' + e.message); process.exit(1); });
