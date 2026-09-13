# CODE 229

App de révision du code de la route béninois. Une seule page (`index.html`),
841 questions embarquées, quelques fonctions serverless pour le paiement.

Ce fichier ne documente que **les commandes à lancer à la main**. Chaque script
détaille ses options dans son propre en-tête (`head -25 <fichier>`).

---

## Codes promo

Donner un accès Premium sans paiement (testeurs, proches, partenaires).

### Installation, une seule fois

```bash
npm install
```

Récupère la clé : Firebase Console → ⚙️ Paramètres du projet → Comptes de
service → **Générer une nouvelle clé privée**. Un `.json` se télécharge.

```bash
node scripts/promo_code.js setup ~/Téléchargements/code229-978a6-xxxxx.json
```

Le script écrit `.env.local` (ignoré par git, permissions 600) et préserve les
variables déjà présentes. Le `.json` téléchargé peut ensuite être supprimé.

### Créer un code

```bash
node scripts/promo_code.js create Fresnel --uses=10 --days=30
```

Crée le code `FRESNEL`, utilisable par **10 comptes différents**, chacun
recevant **30 jours** d'accès complet.

- Le code est mis en majuscules ; la saisie côté app aussi (`fresnel` marche).
- « 10 utilisations » = 10 comptes. Une personne qui ressaisit le code n'en
  consomme pas un second.
- Sans nom, un code lisible au téléphone est généré (`TEST-K7M3PQXR`).
- `--uses=illimite` retire le plafond — à écrire explicitement.
- `--expires=2026-12-31` ajoute une date butoir.
- `--label="Bêta testeurs"` sert uniquement à s'y retrouver dans `list`.

### Suivre et retirer

```bash
node scripts/promo_code.js list           # tous les codes et leur usage
node scripts/promo_code.js show FRESNEL   # qui l'a utilisé, jusqu'à quand
node scripts/promo_code.js disable FRESNEL
node scripts/promo_code.js enable FRESNEL
```

`disable` empêche toute **nouvelle** utilisation ; les accès déjà accordés
restent valides jusqu'à leur date d'expiration.

### À savoir

Les règles Firestore ne se déploient pas depuis ce dépôt : après toute
modification de `firestore.rules`, il faut le coller dans Firebase Console →
Firestore Database → Règles, **et publier**. Sans ça, `promo_codes` est
lisible côté client, c'est-à-dire que la liste des codes valides est publique.

Un testeur non connecté reçoit son accès sur un compte anonyme, lié à ce
navigateur : il le perd en changeant d'appareil. Leur dire de se connecter
avec Google **avant** de saisir le code.

---

## Images Instagram

### Générer une publication à partir d'une question

```bash
python3 tools/instagram-post.py 187        # la question n° 187
python3 tools/instagram-post.py --hasard   # une question au hasard
python3 tools/instagram-post.py --serie 9  # 9 questions d'un coup
```

Sortie dans `tools/posts/` : deux carrés 1080×1080 par question, destinés à un
carrousel — slide 1 la question seule, slide 2 la réponse. Les questions sont
lues dans `index.html`, jamais dans un fichier séparé qui divergerait de l'app.

### Normaliser des images au même format

Instagram impose un format unique à toutes les images d'un carrousel : si elles
diffèrent, il recadre lui-même et ampute les bords.

```bash
python3 tools/instagram-format.py a.png b.png c.png
python3 tools/instagram-format.py --format carre *.png
python3 tools/instagram-format.py --fond '#14161A' --marge 0.1 logo.png
```

Formats : `portrait` (1080×1350, défaut), `carre` (1080×1080), `story`
(1080×1920). L'image entière est conservée — jamais de recadrage : des bandes
sont ajoutées, de la couleur des bords de l'image, ce qui les rend invisibles.
`--sortie` change le dossier de destination (`tools/posts/` par défaut).

---

## Questions

### Vérifier l'intégrité des 841 questions

```bash
python3 scripts/validate_questions.py
```

Extrait le bloc `<script id="qdata">` d'`index.html` et contrôle les clés
d'options, les réponses, les doublons. Sortie non nulle en cas de problème.
Lancé automatiquement en CI (`.github/workflows/validate.yml`) — à lancer
aussi à la main après toute modification des questions.

---

## Développement local

L'app est un fichier statique : l'ouvrir directement dans un navigateur
fonctionne (un shim remplace `localStorage` quand le protocole est `file://`).
Pour un contexte plus proche de la production :

```bash
python3 -m http.server 8000
```

Les routes propres (`/entrainement`, `/fiches`, `/progression`) sont réécrites
par Vercel et renverront un 404 avec ce serveur : recharger sur `/index.html`.

Les fonctions `api/` demandent les variables de `.env.example` et ne tournent
pas avec un simple serveur statique.
