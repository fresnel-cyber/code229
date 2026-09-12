#!/usr/bin/env python3
"""
Met des images à un format Instagram commun, sans rien couper.

Instagram impose un format UNIQUE à toutes les images d'un même carrousel :
si elles diffèrent, il recadre lui-même et ampute les bords — typiquement le
texte d'une capture ou une annotation. On normalise donc en amont.

La méthode est volontairement « contenir » et jamais « remplir » : l'image
entière est conservée, et les bandes ajoutées prennent la couleur des bords
de l'image elle-même, ce qui les rend invisibles. Recadrer irait plus vite
mais couperait précisément ce qu'on veut montrer.

    python3 tools/instagram-format.py a.png b.png c.png
    python3 tools/instagram-format.py --format carre *.png
    python3 tools/instagram-format.py --fond '#14161A' logo.png
"""
import argparse, os, sys
from collections import Counter

from PIL import Image

FORMATS = {
    'portrait': (1080, 1350),   # 4:5 — occupe le plus d'écran dans le fil
    'carre':    (1080, 1080),   # 1:1
    'story':    (1080, 1920),   # 9:16
}


def couleur_de_bord(im):
    """Couleur dominante sur le pourtour, pour des bandes invisibles."""
    px = im.load()
    w, h = im.size
    pas = max(1, w // 120)
    echantillons = []
    for x in range(0, w, pas):
        echantillons += [px[x, 0], px[x, h - 1]]
    for y in range(0, h, max(1, h // 120)):
        echantillons += [px[0, y], px[w - 1, y]]
    # Arrondi pour regrouper les micro-variations d'un dégradé ou d'un JPEG.
    grossier = [(r // 8 * 8, g // 8 * 8, b // 8 * 8) for r, g, b in echantillons]
    return Counter(grossier).most_common(1)[0][0]


def normaliser(chemin, taille, fond_force=None, marge=0.0):
    im = Image.open(chemin).convert('RGB')
    L, H = taille
    fond = fond_force or couleur_de_bord(im)

    utile = (int(L * (1 - marge)), int(H * (1 - marge)))
    ratio = min(utile[0] / im.size[0], utile[1] / im.size[1])
    redim = im.resize((max(1, int(im.size[0] * ratio)),
                       max(1, int(im.size[1] * ratio))), Image.LANCZOS)

    canevas = Image.new('RGB', (L, H), fond)
    canevas.paste(redim, ((L - redim.size[0]) // 2, (H - redim.size[1]) // 2))
    return canevas, fond


def hexa(c):
    return '#%02X%02X%02X' % c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('images', nargs='+')
    ap.add_argument('--format', choices=FORMATS, default='portrait')
    ap.add_argument('--fond', help="couleur des bandes, ex. '#14161A' (sinon déduite des bords)")
    ap.add_argument('--marge', type=float, default=0.0,
                    help="marge autour de l'image, 0.1 = 10 %% (utile pour un logo)")
    ap.add_argument('--sortie', default=os.path.join('tools', 'posts'))
    a = ap.parse_args()

    fond = None
    if a.fond:
        s = a.fond.lstrip('#')
        if len(s) != 6:
            sys.exit("Couleur attendue au format #RRGGBB")
        fond = tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))

    taille = FORMATS[a.format]
    os.makedirs(a.sortie, exist_ok=True)

    for chemin in a.images:
        if not os.path.exists(chemin):
            print("introuvable, ignoré : %s" % chemin, file=sys.stderr)
            continue
        img, utilise = normaliser(chemin, taille, fond, a.marge)
        base = os.path.splitext(os.path.basename(chemin))[0]
        dest = os.path.join(a.sortie, "%s-%dx%d.png" % (base, taille[0], taille[1]))
        img.save(dest)
        print("%s   bandes %s" % (dest, hexa(utilise)))


if __name__ == '__main__':
    main()
