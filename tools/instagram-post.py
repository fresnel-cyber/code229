#!/usr/bin/env python3
"""
Génère les images Instagram d'une question du code, à partir des 841
questions réellement embarquées dans index.html — jamais d'un fichier
séparé, qui divergerait de l'app au premier ajout de question.

Sortie : deux carrés 1080x1080 destinés à un carrousel.
  slide 1 -> la question seule (l'audience répond en commentaire)
  slide 2 -> la ou les bonnes réponses

    python3 tools/instagram-post.py 187
    python3 tools/instagram-post.py --hasard
    python3 tools/instagram-post.py --serie 9      # une grille d'un coup
"""
import argparse, json, os, random, re, sys, textwrap

from PIL import Image, ImageDraw, ImageFont

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SORTIE = os.path.join(RACINE, 'tools', 'posts')

# Couleurs reprises telles quelles du thème sombre de l'app (index.html).
ASPHALTE = (20, 22, 26)
SURFACE  = (28, 31, 36)
CRAIE    = (244, 240, 228)
CRAIE_ATTENUEE = (150, 150, 145)
JAUNE    = (240, 186, 31)
VERT     = (44, 170, 107)

TAILLE = 1080
MARGE  = 84

POLICES = '/usr/share/fonts/opentype/inter/Inter-%s.otf'


def police(variante, taille):
    return ImageFont.truetype(POLICES % variante, taille)


def charger_questions():
    """Lit le bloc qdata de index.html — source unique de vérité."""
    with open(os.path.join(RACINE, 'index.html'), encoding='utf-8') as f:
        html = f.read()
    bloc = re.search(r'id="qdata"[^>]*>(.*?)</script>', html, re.S)
    if not bloc:
        sys.exit("Bloc qdata introuvable dans index.html")
    return json.loads(bloc.group(1))


def hauteur_texte(d, texte, fnt, largeur, interligne):
    """Hauteur qu'occupera le texte une fois replié, sans le dessiner."""
    return len(replier(d, texte, fnt, largeur)) * interligne


def replier(d, texte, fnt, largeur_max):
    mots, lignes, courante = texte.split(), [], ''
    for mot in mots:
        essai = (courante + ' ' + mot).strip()
        if d.textlength(essai, font=fnt) <= largeur_max:
            courante = essai
        else:
            if courante:
                lignes.append(courante)
            courante = mot
    if courante:
        lignes.append(courante)
    return lignes


def ecrire(d, xy, texte, fnt, couleur, largeur_max, interligne):
    x, y = xy
    for ligne in replier(d, texte, fnt, largeur_max):
        d.text((x, y), ligne, font=fnt, fill=couleur)
        y += interligne
    return y


def dessiner(q, reponse_visible):
    img = Image.new('RGB', (TAILLE, TAILLE), ASPHALTE)
    d = ImageDraw.Draw(img)
    largeur = TAILLE - 2 * MARGE

    # En-tête : barre jaune + intitulé + chapitre
    d.rounded_rectangle((MARGE, MARGE, MARGE + 56, MARGE + 8), radius=4, fill=JAUNE)
    d.text((MARGE, MARGE + 26), "QUESTION DU JOUR" if not reponse_visible else "LA RÉPONSE",
           font=police('Black', 26), fill=JAUNE)
    d.text((MARGE, MARGE + 64), q['chapter_title'].upper(),
           font=police('Bold', 22), fill=CRAIE_ATTENUEE)

    options = q['options']
    cles = sorted(options.keys())
    multiple = len(q['answers']) > 1

    # L'énoncé long rétrécit pour que les options tiennent toujours.
    taille_q = 52
    while taille_q > 32:
        fq = police('Black', taille_q)
        h = hauteur_texte(d, q['question'], fq, largeur, int(taille_q * 1.22))
        if h <= 300:
            break
        taille_q -= 3
    fq = police('Black', taille_q)
    y = ecrire(d, (MARGE, MARGE + 128), q['question'], fq, CRAIE, largeur, int(taille_q * 1.22))

    if multiple and not reponse_visible:
        y += 12
        d.text((MARGE, y), "Plusieurs réponses possibles", font=police('Bold', 24),
               fill=CRAIE_ATTENUEE)
        y += 44

    y += 30
    # Les options se partagent l'espace restant au-dessus du pied de page, puis
    # le bloc est recentré verticalement : sans ça, une question courte laissait
    # un grand vide sous les options et le visuel paraissait inachevé.
    bas = TAILLE - MARGE - 108
    dispo = bas - y
    haut_opt = max(72, min(112, int(dispo / len(cles)) - 14))
    taille_o = 32 if haut_opt >= 88 else 27
    fo = police('Bold', taille_o)
    hauteur_bloc = len(cles) * (haut_opt + 14) - 14
    y += max(0, (dispo - hauteur_bloc) // 2)

    for cle in cles:
        juste = cle in q['answers']
        montrer = reponse_visible and juste
        fond = (30, 62, 48) if montrer else SURFACE
        bord = VERT if montrer else (48, 52, 58)
        texte_couleur = CRAIE if (montrer or not reponse_visible) else (110, 112, 116)

        d.rounded_rectangle((MARGE, y, TAILLE - MARGE, y + haut_opt),
                            radius=18, fill=fond, outline=bord, width=3)
        # Pastille de la lettre
        cy = y + haut_opt // 2
        d.ellipse((MARGE + 20, cy - 24, MARGE + 68, cy + 24),
                  fill=VERT if montrer else (44, 48, 54))
        d.text((MARGE + 44, cy), cle.upper(), font=police('Black', 26),
               fill=ASPHALTE if montrer else CRAIE, anchor='mm')

        lignes = replier(d, options[cle], fo, largeur - 130)
        ty = cy - (len(lignes) * int(taille_o * 1.2)) // 2
        for ligne in lignes:
            d.text((MARGE + 92, ty), ligne, font=fo, fill=texte_couleur)
            ty += int(taille_o * 1.2)

        if montrer:
            d.text((TAILLE - MARGE - 34, cy), "✓", font=police('Black', 34),
                   fill=VERT, anchor='mm')
        y += haut_opt + 14

    # Pied de page
    py = TAILLE - MARGE - 46
    if reponse_visible:
        d.text((MARGE, py), "841 questions du Manuel du candidat",
               font=police('Bold', 26), fill=CRAIE_ATTENUEE)
        d.text((MARGE, py + 36), "code229.online", font=police('Black', 30), fill=JAUNE)
    else:
        # Flèche dessinée, pas un emoji : Inter n'embarque aucun glyphe emoji
        # et le caractère sortait en carré vide (tofu).
        libelle = "Ta réponse en commentaire"
        d.text((MARGE, py), libelle, font=police('Black', 30), fill=CRAIE)
        fx = MARGE + d.textlength(libelle, font=police('Black', 30)) + 18
        fy = py + 16
        d.polygon([(fx, fy - 10), (fx + 22, fy - 10), (fx + 11, fy + 10)], fill=JAUNE)
        d.text((MARGE, py + 40), "Solution dans l'image suivante", font=police('Bold', 24),
               fill=CRAIE_ATTENUEE)
    d.text((TAILLE - MARGE, TAILLE - MARGE - 10), "CODE 229", font=police('Black', 26),
           fill=JAUNE, anchor='rs')
    return img


def produire(q):
    os.makedirs(SORTIE, exist_ok=True)
    chemins = []
    for i, reponse in enumerate((False, True), start=1):
        p = os.path.join(SORTIE, "q%s-%d.png" % (q['num'], i))
        dessiner(q, reponse).save(p)
        chemins.append(p)
    return chemins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('num', nargs='?', type=int, help="numéro de question")
    ap.add_argument('--hasard', action='store_true')
    ap.add_argument('--serie', type=int, metavar='N', help="N questions au hasard")
    a = ap.parse_args()

    questions = charger_questions()
    par_num = {q['num']: q for q in questions}

    if a.serie:
        choix = random.sample(questions, min(a.serie, len(questions)))
    elif a.hasard or a.num is None:
        choix = [random.choice(questions)]
    else:
        if a.num not in par_num:
            sys.exit("Question %d introuvable." % a.num)
        choix = [par_num[a.num]]

    for q in choix:
        for p in produire(q):
            print(p)


if __name__ == '__main__':
    main()
