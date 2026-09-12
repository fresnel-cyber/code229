#!/usr/bin/env node
// Outil d'administration des codes promo — à lancer depuis TA machine, jamais
// exposé en ligne. Il utilise l'Admin SDK, donc il ignore les règles Firestore
// et peut tout faire : garde FIREBASE_SERVICE_ACCOUNT_JSON hors du dépôt.
//
// Prérequis : la variable d'environnement FIREBASE_SERVICE_ACCOUNT_JSON doit
// contenir le JSON du compte de service (la même que sur Vercel).
//
// Usage :
//   node scripts/promo_code.js create [CODE] [--days=30] [--uses=10] [--label="Testeurs"] [--expires=2026-12-31]
//   node scripts/promo_code.js list
//   node scripts/promo_code.js show CODE
//   node scripts/promo_code.js disable CODE
//   node scripts/promo_code.js enable CODE
//
// `create` sans CODE en génère un lisible au téléphone (pas de O/0/I/1).
const { db } = require('../api/_lib/firebaseAdmin');

const DAY_MS = 24 * 60 * 60 * 1000;
// Alphabet sans caractères ambigus : un code se dicte souvent à l'oral ou se
// recopie depuis un écran de téléphone, et « 0 » lu « O » est un ticket de
// support pour rien.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(prefix) {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return (prefix ? prefix + '-' : '') + out;
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  args.forEach(function (a) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m) flags[m[1]] = m[2];
    else rest.push(a);
  });
  return { flags: flags, rest: rest };
}

function fmtDate(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : '—';
}

async function create(rest, flags) {
  const code = (rest[0] || randomCode(flags.prefix || 'TEST')).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{3,31}$/.test(code)) {
    throw new Error('Code invalide : 4 à 32 caractères, lettres/chiffres/tirets, ne commence pas par un tiret.');
  }

  const ref = db.collection('promo_codes').doc(code);
  if ((await ref.get()).exists) throw new Error('Le code ' + code + ' existe déjà.');

  const days = flags.days ? parseInt(flags.days, 10) : 30;
  // `uses` absent => illimité, mais il faut l'écrire explicitement pour ne pas
  // distribuer un code infini par simple oubli d'option.
  const uses = flags.uses === 'illimite' ? null : parseInt(flags.uses || '10', 10);
  if (!(days > 0)) throw new Error('--days doit être un nombre de jours positif.');
  if (uses !== null && !(uses > 0)) throw new Error('--uses doit être positif, ou "illimite".');

  const doc = {
    active: true,
    duration_days: days,
    used_count: 0,
    label: flags.label || 'Testeurs',
    created_at: Date.now()
  };
  if (uses !== null) doc.max_uses = uses;
  if (flags.expires) {
    const t = Date.parse(flags.expires + 'T23:59:59Z');
    if (isNaN(t)) throw new Error('--expires attend une date AAAA-MM-JJ.');
    doc.expires_at = t;
  }

  await ref.set(doc);
  console.log('Code créé : ' + code);
  console.log('  ' + days + ' jours de Premium par compte');
  console.log('  ' + (uses === null ? 'utilisations illimitées' : uses + ' utilisation(s) au total'));
  console.log('  valable jusqu\'au ' + (doc.expires_at ? fmtDate(doc.expires_at) : 'retrait manuel'));
  console.log('  libellé : ' + doc.label);
}

async function list() {
  const snap = await db.collection('promo_codes').orderBy('created_at', 'desc').get();
  if (snap.empty) { console.log('Aucun code promo.'); return; }
  console.log('CODE'.padEnd(20) + 'ÉTAT'.padEnd(10) + 'JOURS'.padEnd(7) + 'UTIL.'.padEnd(10) + 'EXPIRE'.padEnd(12) + 'LIBELLÉ');
  snap.forEach(function (d) {
    const c = d.data();
    const expired = c.expires_at && c.expires_at < Date.now();
    const state = c.active === false ? 'désactivé' : (expired ? 'expiré' : 'actif');
    const uses = (c.used_count || 0) + '/' + (typeof c.max_uses === 'number' ? c.max_uses : '∞');
    console.log(
      d.id.padEnd(20) + state.padEnd(10) + String(c.duration_days || 30).padEnd(7) +
      uses.padEnd(10) + fmtDate(c.expires_at).padEnd(12) + (c.label || '')
    );
  });
}

async function show(rest) {
  const code = (rest[0] || '').trim().toUpperCase();
  if (!code) throw new Error('Usage : node scripts/promo_code.js show CODE');
  const snap = await db.collection('promo_codes').doc(code).get();
  if (!snap.exists) throw new Error('Code inconnu : ' + code);
  console.log(JSON.stringify(snap.data(), null, 2));

  const reds = await db.collection('promo_redemptions').where('code', '==', code).get();
  console.log('\n' + reds.size + ' utilisation(s) :');
  reds.forEach(function (d) {
    const r = d.data();
    console.log('  ' + r.uid + '  le ' + fmtDate(r.redeemed_at) + '  → Premium jusqu\'au ' + fmtDate(r.premium_expires_at));
  });
}

async function setActive(rest, active) {
  const code = (rest[0] || '').trim().toUpperCase();
  if (!code) throw new Error('Usage : node scripts/promo_code.js ' + (active ? 'enable' : 'disable') + ' CODE');
  const ref = db.collection('promo_codes').doc(code);
  if (!(await ref.get()).exists) throw new Error('Code inconnu : ' + code);
  await ref.update({ active: active, updated_at: Date.now() });
  // Désactiver ne retire l'accès à personne : les abonnements déjà accordés
  // vivent dans subscriptions/{uid} et gardent leur date d'expiration.
  console.log('Code ' + code + (active ? ' réactivé.' : ' désactivé (les accès déjà accordés restent valides).'));
}

(async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, rest } = parseFlags(argv.slice(1));
  try {
    if (cmd === 'create') await create(rest, flags);
    else if (cmd === 'list') await list();
    else if (cmd === 'show') await show(rest);
    else if (cmd === 'disable') await setActive(rest, false);
    else if (cmd === 'enable') await setActive(rest, true);
    else {
      console.log('Commandes : create | list | show | disable | enable');
      console.log('Exemple   : node scripts/promo_code.js create --days=60 --uses=15 --label="Bêta testeurs"');
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error('Erreur : ' + (e && e.message));
    process.exit(1);
  }
})();
