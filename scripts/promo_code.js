#!/usr/bin/env node
// Outil d'administration des codes promo — à lancer depuis TA machine, jamais
// exposé en ligne. Il utilise l'Admin SDK, donc il ignore les règles Firestore
// et peut tout faire : garde FIREBASE_SERVICE_ACCOUNT_JSON hors du dépôt.
//
// Prérequis : FIREBASE_SERVICE_ACCOUNT_JSON, dans .env.local (lu
// automatiquement ci-dessous) ou dans l'environnement.
//
// Usage :
//   node scripts/promo_code.js setup <chemin-cle.json>
//   node scripts/promo_code.js create [CODE] [--days=30] [--uses=10] [--label="Testeurs"] [--expires=2026-12-31]
//   node scripts/promo_code.js list
//   node scripts/promo_code.js show CODE
//   node scripts/promo_code.js disable CODE
//   node scripts/promo_code.js enable CODE
//
// `create` sans CODE en génère un lisible au téléphone (pas de O/0/I/1).

// Charge .env.local sans dépendance externe, pour que la commande se lance
// telle quelle : sans ça il faut sourcer le fichier à la main avant chaque
// appel, ce qui est la partie du processus qui se retient le moins.
(function loadEnvLocal() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;                       // commentaire ou ligne vide
    if (process.env[m[1]]) return;        // l'environnement réel gagne toujours
    let v = m[2].trim();
    // Une valeur peut être entourée de guillemets ; le JSON du compte de
    // service, lui, commence par { et ne doit surtout pas être déquoté.
    if (v.length > 1 && ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  });
})();

// Chargé à la demande, jamais à l'import : firebaseAdmin lève une exception
// s'il n'y a pas de clé, or la commande `setup` sert justement à la poser.
let _db = null;
function getDb() {
  if (!_db) _db = require('../api/_lib/firebaseAdmin').db;
  return _db;
}

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

  const ref = getDb().collection('promo_codes').doc(code);
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

/* Écrit .env.local à partir du fichier de clé téléchargé depuis Firebase.
   Aplatir ce JSON à la main est l'étape où tout le monde se trompe (retours à
   la ligne dans la clé privée, guillemets mangés par le shell) : autant que ce
   soit le programme qui le fasse. */
function setup(rest) {
  const fs = require('fs');
  const path = require('path');
  const src = rest[0];
  if (!src) {
    throw new Error('Usage : node scripts/promo_code.js setup <chemin-du-fichier-cle.json>');
  }
  if (!fs.existsSync(src)) throw new Error('Fichier introuvable : ' + src);

  const raw = fs.readFileSync(src, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error('Ce fichier n\'est pas du JSON valide. Prends bien la clé téléchargée depuis Firebase Console → Comptes de service.');
  }
  if (parsed.type !== 'service_account' || !parsed.private_key) {
    throw new Error('Ce JSON n\'est pas une clé de compte de service Firebase.');
  }

  // JSON.stringify(objet) : une seule ligne, retours à la ligne de la clé
  // privée déjà échappés en \n. C'est exactement ce que JSON.parse attend en
  // face, côté api/_lib/firebaseAdmin.js.
  const line = 'FIREBASE_SERVICE_ACCOUNT_JSON=' + JSON.stringify(parsed);
  const dest = path.join(__dirname, '..', '.env.local');

  let content = '';
  if (fs.existsSync(dest)) {
    // On préserve les autres variables déjà présentes (clés KPay, etc.).
    content = fs.readFileSync(dest, 'utf8')
      .split('\n')
      .filter(function (l) { return !/^\s*FIREBASE_SERVICE_ACCOUNT_JSON\s*=/.test(l); })
      .join('\n')
      .replace(/\n+$/, '');
    if (content) content += '\n';
  }
  fs.writeFileSync(dest, content + line + '\n', { mode: 0o600 });
  // `mode` n'agit qu'à la création : sur un .env.local préexistant, il faut le
  // resserrer explicitement. Ce fichier contient une clé qui donne tous les
  // droits sur la base.
  try { fs.chmodSync(dest, 0o600); } catch (e) { /* systèmes sans chmod */ }

  console.log('Clé enregistrée dans .env.local (projet ' + parsed.project_id + ').');
  console.log('Ce fichier est ignoré par git, il ne partira jamais sur GitHub.');
  console.log('Tu peux maintenant supprimer ' + src + '.');
  console.log('\nEssaie : node scripts/promo_code.js create Essai --uses=1 --days=7');
}

async function list() {
  const snap = await getDb().collection('promo_codes').orderBy('created_at', 'desc').get();
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
  const snap = await getDb().collection('promo_codes').doc(code).get();
  if (!snap.exists) throw new Error('Code inconnu : ' + code);
  console.log(JSON.stringify(snap.data(), null, 2));

  const reds = await getDb().collection('promo_redemptions').where('code', '==', code).get();
  console.log('\n' + reds.size + ' utilisation(s) :');
  reds.forEach(function (d) {
    const r = d.data();
    console.log('  ' + r.uid + '  le ' + fmtDate(r.redeemed_at) + '  → Premium jusqu\'au ' + fmtDate(r.premium_expires_at));
  });
}

async function setActive(rest, active) {
  const code = (rest[0] || '').trim().toUpperCase();
  if (!code) throw new Error('Usage : node scripts/promo_code.js ' + (active ? 'enable' : 'disable') + ' CODE');
  const ref = getDb().collection('promo_codes').doc(code);
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
    if (cmd === 'setup') setup(rest);
    else if (cmd === 'create') await create(rest, flags);
    else if (cmd === 'list') await list();
    else if (cmd === 'show') await show(rest);
    else if (cmd === 'disable') await setActive(rest, false);
    else if (cmd === 'enable') await setActive(rest, true);
    else {
      console.log('Commandes : setup | create | list | show | disable | enable');
      console.log('');
      console.log('  setup <cle.json>   enregistre la clé Firebase (une seule fois)');
      console.log('  create NOM --uses=10 --days=30   crée un code');
      console.log('  list               liste les codes et leur usage');
      console.log('  show NOM           détaille qui a utilisé un code');
      console.log('  disable NOM        empêche toute nouvelle utilisation');
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error('Erreur : ' + (e && e.message));
    process.exit(1);
  }
})();
