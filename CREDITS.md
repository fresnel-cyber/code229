# Crédits — images des panneaux

## `img/sign_*.png` et `img/scene_*.jpg`
Extraites du manuel du candidat au permis de conduire édité par la DGTT
(Direction Générale des Transports Terrestres) du Bénin, pour un usage
pédagogique dans cette application de préparation à l'examen.

## `img/fr/*.png` (base élargie « aller plus loin »)
146 pictogrammes officiels des panneaux de signalisation routière français,
issus de Wikimedia Commons (catégories *Category:SVG road signs of France*),
convertis en PNG et détourés (fond transparent) pour l'intégration dans
l'application.

Ces panneaux reproduisent les pictogrammes réglementaires définis par
l'arrêté du 24 novembre 1967 relatif à la signalisation des routes et
autoroutes (et ses mises à jour) : en tant que pictogrammes officiels et
normalisés, ils sont considérés comme relevant du domaine public ou d'une
licence libre sur Commons (la quasi-totalité des fichiers de ces catégories
sont taggés Domaine public / PD-shape / CC0 par leurs auteurs, en tant que
reproductions fidèles d'un document administratif non protégeable). Cette
vérification a été faite catégorie par catégorie et par échantillonnage —
pas fichier par fichier un par un — donc si un cas particulier venait à
poser problème, il faudra le traiter isolément.

Signification et statut « confirmé Bénin » : voir le champ `benin` dans le
jeu de données `PANNEAUX_FR` (intégré dans `index.html`, bloc
`<script id="panneauxfr">`). `benin:true` = formulation vérifiée mot pour
mot dans le manuel DGTT ; `benin:false` = référentiel France / convention de
Vienne, pertinent pour qui vise aussi le permis international, mais non
recopié du manuel béninois — clairement étiqueté dans l'interface.

Panneaux volontairement exclus de cette base élargie :
- **Signaux obsolètes / historiques** (dossier `Z_historiques` du pack
  source, 38 fichiers) : plus en usage, aucun intérêt pour un examen actuel.
- **Panneaux de direction/localisation (types D/E)** : leur contenu texte
  est propre à chaque lieu, pas de pictogramme générique représentable.
- **Signaux lumineux et de passage à niveau (hors panneaux)** : pas
  d'image statique pertinente dans le pack source.
- Quelques doublons de valeur numérique (ex. plusieurs fichiers B14 pour
  chaque limite de vitesse) : un seul exemplaire représentatif par code a
  été retenu.
