// Fausse base Firestore pour les tests — reproduit ce qui compte vraiment :
// la CONCURRENCE OPTIMISTE des transactions.
//
// Un simple objet en mémoire ne prouverait rien sur `redeem-code` : toute la
// garantie « un code à 10 usages n'en accorde pas 11 » repose sur le fait que
// Firestore rejoue une transaction dont un document lu a changé entre-temps.
// On modélise donc une version par document, vérifiée au commit.

class FauxFirestore {
  constructor() {
    this.docs = new Map();        // "collection/id" → { data, version }
    this.rejeux = 0;              // transactions rejouées pour cause de conflit
    this.hookAvantCommit = null;  // permet d'entrelacer deux transactions
  }

  /** Pose un document sans passer par une transaction (préparation de test). */
  poser(chemin, data) {
    this.docs.set(chemin, { data: data, version: 1 });
  }

  lire(chemin) {
    const e = this.docs.get(chemin);
    return e ? e.data : null;
  }

  collection(nom) {
    const base = this;
    return {
      doc: function (id) {
        return { chemin: nom + '/' + id, id: id, _db: base, get: function () { return base._get(this.chemin); } };
      }
    };
  }

  async _get(chemin) {
    const e = this.docs.get(chemin);
    return {
      exists: !!e,
      data: function () { return e ? e.data : undefined; }
    };
  }

  async runTransaction(fn) {
    for (let essai = 0; essai < 5; essai++) {
      const lus = new Map();      // chemin → version au moment de la lecture
      const ecritures = [];

      const t = {
        get: async (ref) => {
          const e = this.docs.get(ref.chemin);
          lus.set(ref.chemin, e ? e.version : 0);
          return {
            exists: !!e,
            data: function () { return e ? JSON.parse(JSON.stringify(e.data)) : undefined; }
          };
        },
        set: (ref, data, options) => {
          ecritures.push({ chemin: ref.chemin, data: data, merge: !!(options && options.merge) });
        },
        update: (ref, data) => {
          ecritures.push({ chemin: ref.chemin, data: data, merge: true });
        }
      };

      // L'erreur métier du handler (`throw { code: 'invalid' }`) doit ressortir
      // telle quelle, sans être confondue avec un conflit.
      const resultat = await fn(t);

      // Point d'entrelacement : un test peut laisser une AUTRE transaction
      // s'exécuter complètement ici, entre les lectures et le commit.
      if (this.hookAvantCommit) {
        const hook = this.hookAvantCommit;
        this.hookAvantCommit = null;   // une seule fois, sinon blocage
        await hook();
      }

      // Un document lu a-t-il changé depuis sa lecture ?
      let conflit = false;
      for (const [chemin, version] of lus) {
        const e = this.docs.get(chemin);
        const actuelle = e ? e.version : 0;
        if (actuelle !== version) { conflit = true; break; }
      }
      if (conflit) { this.rejeux++; continue; }   // Firestore rejoue la fonction

      for (const w of ecritures) {
        const e = this.docs.get(w.chemin);
        const data = w.merge && e ? Object.assign({}, e.data, w.data) : w.data;
        this.docs.set(w.chemin, { data: data, version: (e ? e.version : 0) + 1 });
      }
      return resultat;
    }
    throw new Error('transaction abandonnée après 5 tentatives');
  }
}

module.exports = { FauxFirestore };
