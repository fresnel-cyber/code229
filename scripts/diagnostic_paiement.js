#!/usr/bin/env node
// Diagnostic d'un paiement : à qui appartient-il, l'abonnement a-t-il bien été
// activé, et le même acheteur a-t-il payé plusieurs fois ?
//
// Lecture seule — ce script n'écrit jamais rien.
//
// Usage :
//   node scripts/diagnostic_paiement.js                 les 30 derniers paiements
//   node scripts/diagnostic_paiement.js --jours=10      ceux des 10 derniers jours
//   node scripts/diagnostic_paiement.js --uid=abc123    l'historique d'un compte
//   node scripts/diagnostic_paiement.js --ref=KPAY-MU29 une transaction précise

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

const { db, auth } = require('../api/_lib/firebaseAdmin');

const DAY_MS = 24 * 60 * 60 * 1000;

function flags() {
  const f = {};
  process.argv.slice(2).forEach(function (a) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m) f[m[1]] = m[2];
  });
  return f;
}

function dt(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return isNaN(d) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ');
}

function champ(o, noms) {
  for (const n of noms) if (o[n] !== undefined && o[n] !== null) return o[n];
  return null;
}

async function main() {
  const f = flags();

  let q = db.collection('payments');
  // Le nom du champ de date a pu varier selon le prestataire : on trie côté
  // Node plutôt que dans la requête, pour ne dépendre d'aucun index.
  const snap = await q.limit(500).get();
  let rows = [];
  snap.forEach(function (d) {
    const p = d.data();
    rows.push({
      id: d.id,
      uid: champ(p, ['uid']),
      statut: champ(p, ['status', 'statut']) || '—',
      montant: champ(p, ['amount', 'montant']),
      quand: champ(p, ['created_at', 'createdAt', 'date']),
      ref: champ(p, ['provider_reference', 'reference', 'transaction_id']) || d.id,
      fournisseur: champ(p, ['provider']) || '—'
    });
  });

  if (f.uid) rows = rows.filter(function (r) { return r.uid === f.uid; });
  if (f.ref) rows = rows.filter(function (r) { return String(r.ref).indexOf(f.ref) !== -1; });
  if (f.jours) {
    const limite = Date.now() - parseInt(f.jours, 10) * DAY_MS;
    rows = rows.filter(function (r) {
      const t = r.quand && (r.quand.toDate ? r.quand.toDate().getTime() : new Date(r.quand).getTime());
      return t && t >= limite;
    });
  }

  rows.sort(function (a, b) {
    const ta = a.quand ? (a.quand.toDate ? a.quand.toDate().getTime() : new Date(a.quand).getTime()) : 0;
    const tb = b.quand ? (b.quand.toDate ? b.quand.toDate().getTime() : new Date(b.quand).getTime()) : 0;
    return tb - ta;
  });
  if (!f.uid && !f.ref && !f.jours) rows = rows.slice(0, 30);

  if (!rows.length) { console.log('Aucun paiement ne correspond.'); return; }

  // Regroupé par compte : c'est la seule lecture qui répond à « le même
  // acheteur a-t-il payé deux fois, et pourquoi ».
  const parUid = {};
  rows.forEach(function (r) { (parUid[r.uid] = parUid[r.uid] || []).push(r); });

  console.log(rows.length + ' paiement(s), ' + Object.keys(parUid).length + ' compte(s).\n');

  for (const uid of Object.keys(parUid)) {
    const list = parUid[uid];
    console.log('─'.repeat(72));
    console.log('COMPTE ' + uid + '  —  ' + list.length + ' paiement(s)');

    list.forEach(function (r) {
      console.log('   ' + dt(r.quand).padEnd(18) + String(r.statut).padEnd(12) +
        String(r.montant || '—').padEnd(9) + r.ref);
    });

    const sub = await db.collection('subscriptions').doc(String(uid)).get();
    if (!sub.exists) {
      console.log('   ABONNEMENT : AUCUN  ← le paiement n\'a pas activé Premium');
    } else {
      const s = sub.data();
      const exp = champ(s, ['premium_expires_at', 'expires_at']);
      const actif = exp && (exp.toDate ? exp.toDate().getTime() : exp) > Date.now();
      console.log('   ABONNEMENT : expire le ' + dt(exp) + (actif ? '  (actif)' : '  (EXPIRÉ)'));
    }

    // Un compte Firebase anonyme vit dans le stockage d'UN navigateur : c'est
    // l'explication la plus fréquente d'un rachat quelques jours plus tard.
    try {
      const u = await auth.getUser(String(uid));
      const providers = (u.providerData || []).map(function (p) { return p.providerId; });
      console.log('   COMPTE     : ' + (providers.length ? providers.join(', ') : 'ANONYME (lié à un seul navigateur)') +
        ' | créé le ' + dt(u.metadata.creationTime) +
        ' | dernière connexion ' + dt(u.metadata.lastSignInTime));
    } catch (e) {
      console.log('   COMPTE     : introuvable dans Authentication (' + e.code + ')');
    }
  }
  console.log('─'.repeat(72));
}

main().then(function () { process.exit(0); })
  .catch(function (e) { console.error('Erreur : ' + e.message); process.exit(1); });
