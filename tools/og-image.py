#!/usr/bin/env python3
"""Régénère img/og-image.jpg — l'aperçu affiché quand on partage un lien CODE 229
sur WhatsApp, Facebook ou X.

    python3 tools/og-image.py

Reconstruit l'image à partir de img/brand/logo-source.jpeg, pour qu'un changement
de logo ne laisse pas l'aperçu social en arrière.

Police : Inter, celle du corps de texte de l'app. Le titre de l'app utilise
Oswald, qui n'est pas installé localement ; Inter Display Black est le repli le
plus proche et reste dans la charte.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Charte de l'app (voir les variables CSS d'index.html).
ASPHALT = (0x14, 0x16, 0x1A)
CHALK = (0xF2, 0xEF, 0xE6)
CHALK_DIM = (0x9A, 0x9E, 0xA8)
YELLOW = (0xF0, 0xBA, 0x1F)

LARGEUR, HAUTEUR = 1200, 630
INTER = '/usr/share/fonts/opentype/inter/%s.otf'


def police(nom, taille):
    chemin = INTER % nom
    if not os.path.exists(chemin):
        sys.exit('Police introuvable : %s\nInstalle Inter (paquet fonts-inter).' % chemin)
    return ImageFont.truetype(chemin, taille)


def mark_propre():
    """Découpe le logo de son fond et le rend en aplats nets.

    Le JPEG source a semé des halos autour des aplats : on rabat chaque pixel
    sur la couleur de marque la plus proche avant de recadrer, sinon les bords
    ressortent sales une fois l'image agrandie.
    """
    import numpy as np

    src = os.path.join(RACINE, 'img', 'brand', 'logo-source.jpeg')
    if not os.path.exists(src):
        sys.exit('Logo source introuvable : %s' % src)

    # int32 obligatoire : en int16 les carrés de différences débordent et la
    # classification renvoie n'importe quoi.
    im = np.array(Image.open(src).convert('RGB')).astype(np.int32)
    reference = np.array([(11, 12, 14), (251, 251, 249), (247, 190, 20)], dtype=np.int32)
    sortie = np.array([ASPHALT, CHALK, YELLOW], dtype=np.uint8)

    distances = ((im[:, :, None, :] - reference[None, None, :, :]) ** 2).sum(axis=3)
    index = distances.argmin(axis=2)
    plat = sortie[index]

    ys, xs = np.where(index != 0)          # tout ce qui n'est pas le fond
    haut, bas, gauche, droite = ys.min(), ys.max(), xs.min(), xs.max()

    mark = Image.fromarray(plat[haut:bas + 1, gauche:droite + 1])
    # Le fond du mark est déjà ASPHALT, donc il se fond dans la toile : pas
    # besoin de masque de transparence.
    return mark


def main():
    img = Image.new('RGB', (LARGEUR, HAUTEUR), ASPHALT)
    d = ImageDraw.Draw(img)

    # Bande jaune en haut : rappel de la couleur d'accent, visible même quand
    # l'aperçu est réduit à une vignette dans une conversation.
    d.rectangle([0, 0, LARGEUR, 8], fill=YELLOW)

    mark = mark_propre()
    cible = 300
    echelle = cible / max(mark.size)
    mark = mark.resize((round(mark.size[0] * echelle), round(mark.size[1] * echelle)), Image.LANCZOS)
    marge = 90
    img.paste(mark, (marge, (HAUTEUR - mark.size[1]) // 2))

    x = marge + cible + 70
    d.text((x, 178), 'CODE 229', font=police('InterDisplay-Black', 82), fill=CHALK)
    d.text((x, 278), 'Révise le code de la route', font=police('Inter-SemiBold', 34), fill=CHALK)
    d.text((x, 322), 'béninois', font=police('Inter-SemiBold', 34), fill=YELLOW)

    d.text((x, 400), '841 questions du Manuel du candidat DGTT',
           font=police('Inter-Regular', 22), fill=CHALK_DIM)
    d.text((x, 432), 'Diagnostic gratuit · Répétition espacée · Examen blanc',
           font=police('Inter-Regular', 22), fill=CHALK_DIM)

    dest = os.path.join(RACINE, 'img', 'og-image.jpg')
    # quality=90 : le fichier reste sous les 150 Ko que les aperçus tolèrent
    # sans broncher, sans laisser d'artefacts visibles sur les aplats.
    img.save(dest, 'JPEG', quality=90, optimize=True)
    print('Écrit : %s (%d x %d, %.0f Ko)'
          % (dest, LARGEUR, HAUTEUR, os.path.getsize(dest) / 1024))


if __name__ == '__main__':
    main()
