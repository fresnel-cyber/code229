// POST /api/redeem-code
// Échange un code promo contre un accès Premium, sans paiement.
//
// Pensé d'abord pour les testeurs : on veut pouvoir ouvrir l'app à quelqu'un
// en lui envoyant une chaîne de caractères, sans passer par Mobile Money.
//
// Tout est vérifié ICI, jamais côté client : un code promo validé dans le
// navigateur ne vaudrait pas plus que le paywall lui-même (qu'on sait
// contournable). Le client n'apprend jamais rien d'un code qui n'existe pas —
// même message, même délai — et ne peut pas lire la collection promo_codes
// (voir firestore.rules).
//
// Garanties, toutes assurées par UNE transaction Firestore :
//   - un compte ne peut consommer un code qu'une seule fois ;
//   - `max_uses` ne peut pas être dépassé, même sur deux appels simultanés ;
//   - l'abonnement en cours est PROLONGÉ, jamais écrasé (computeNewExpiry).
const { db, auth } = require('./_lib/firebaseAdmin');
const { computeNewExpiry } = require('./_lib/premium');

// Un code trop court se devine ; on refuse en amont ce qui ne peut pas être
// un de nos codes, pour ne même pas payer la lecture Firestore.
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,31}$/;

// Anti-force brute. Sans ça, un script pourrait balayer l'espace des codes
// courts depuis un seul compte anonyme (ils sont gratuits à créer).
const MAX_FAILED_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Message unique pour « n'existe pas », « désactivé » et « expiré » : les
// distinguer confirmerait à un attaquant qu'un code existe.
const INVALID_MSG = 'Code invalide ou expiré.';

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

/** Compte les échecs récents et renvoie true si l'utilisateur est bloqué. */
async function isRateLimited(uid, now) {
  const snap = await db.collection('promo_attempts').doc(uid).get();
  if (!snap.exists) return false;
  const d = snap.data();
  if (now - (d.window_started_at || 0) > ATTEMPT_WINDOW_MS) return false;
  return (d.failed_count || 0) >= MAX_FAILED_ATTEMPTS;
}

async function recordFailure(uid, now) {
  const ref = db.collection('promo_attempts').doc(uid);
  try {
    await db.runTransaction(async function (t) {
      const snap = await t.get(ref);
      const d = snap.exists ? snap.data() : null;
      const fresh = !d || now - (d.window_started_at || 0) > ATTEMPT_WINDOW_MS;
      t.set(ref, {
        window_started_at: fresh ? now : d.window_started_at,
        failed_count: fresh ? 1 : (d.failed_count || 0) + 1,
        last_attempt_at: now
      });
    });
  } catch (e) {
    // Le compteur anti-abus ne doit jamais faire échouer la réponse.
    console.error('[promo] compteur d\'échecs indisponible:', e && e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }

  let uid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    res.status(401).json({ error: 'Session invalide, recharge la page.' });
    return;
  }

  // req.body est déjà parsé par Vercel quand le Content-Type est JSON, mais
  // pas si le corps arrive en texte brut : on couvre les deux.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const code = normalizeCode(body && body.code);

  const now = Date.now();

  if (!CODE_RE.test(code)) {
    res.status(400).json({ error: INVALID_MSG });
    return;
  }

  try {
    if (await isRateLimited(uid, now)) {
      res.status(429).json({ error: 'Trop de tentatives. Réessaie dans une heure.' });
      return;
    }

    const codeRef = db.collection('promo_codes').doc(code);
    const redemptionRef = db.collection('promo_redemptions').doc(code + '__' + uid);
    const subRef = db.collection('subscriptions').doc(uid);

    let outcome;
    try {
      outcome = await db.runTransaction(async function (t) {
        // Firestore impose TOUTES les lectures avant la première écriture.
        const codeSnap = await t.get(codeRef);
        const redemptionSnap = await t.get(redemptionRef);
        const subSnap = await t.get(subRef);

        if (!codeSnap.exists) throw { code: 'invalid' };
        const promo = codeSnap.data();

        if (promo.active === false) throw { code: 'invalid' };
        if (promo.expires_at && promo.expires_at < now) throw { code: 'invalid' };
        if (redemptionSnap.exists) throw { code: 'already_used' };

        const used = promo.used_count || 0;
        const max = promo.max_uses;
        // max_uses absent = code sans limite de volume (utile pour un code
        // interne réservé à l'équipe) ; c'est un choix explicite à la
        // création, jamais un défaut silencieux.
        if (typeof max === 'number' && used >= max) throw { code: 'exhausted' };

        const durationMs = (promo.duration_days || 30) * DAY_MS;
        const current = subSnap.exists ? subSnap.data() : null;
        const expiry = computeNewExpiry(current, now, durationMs);

        t.update(codeRef, { used_count: used + 1, last_used_at: now });
        t.set(redemptionRef, {
          code: code,
          uid: uid,
          duration_days: promo.duration_days || 30,
          redeemed_at: now,
          premium_expires_at: expiry.newExpiry
        });
        t.set(subRef, {
          status: 'active',
          source: 'promo',
          promo_code: code,
          premium_started_at: (current && current.premium_started_at) || now,
          premium_expires_at: expiry.newExpiry,
          updated_at: now
        }, { merge: true });

        return {
          newExpiry: expiry.newExpiry,
          extended: expiry.extended,
          durationDays: promo.duration_days || 30
        };
      });
    } catch (e) {
      if (e && e.code === 'invalid') {
        await recordFailure(uid, now);
        res.status(404).json({ error: INVALID_MSG });
        return;
      }
      if (e && e.code === 'already_used') {
        res.status(409).json({ error: 'Tu as déjà utilisé ce code.' });
        return;
      }
      if (e && e.code === 'exhausted') {
        res.status(409).json({ error: 'Ce code a atteint sa limite d\'utilisation.' });
        return;
      }
      throw e;
    }

    console.log('[promo] code utilisé —', code, '| uid:', uid,
      '| expire le:', new Date(outcome.newExpiry).toISOString(),
      '| prolongation:', outcome.extended);

    res.status(200).json({
      activated: true,
      premium_expires_at: outcome.newExpiry,
      duration_days: outcome.durationDays,
      extended: outcome.extended
    });
  } catch (e) {
    console.error('[promo] erreur:', e && (e.stack || e.message));
    res.status(500).json({ error: 'Impossible de valider le code, réessaie dans un instant.' });
  }
};
