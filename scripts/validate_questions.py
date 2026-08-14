#!/usr/bin/env python3
"""
Garde-fou de données pour CODE 229.

Extrait le bloc <script id="qdata"> de index.html et vérifie l'intégrité
des questions : c'est ce script qui aurait attrapé le bug Q414 (clés
d'options décalées 'a,c,d' au lieu de 'a,b,c', réponse pointant sur la
mauvaise option) avant qu'il n'atteigne un utilisateur.

Usage : python3 scripts/validate_questions.py
Sortie non nulle si un problème est trouvé (utilisable en CI / pre-commit).
"""
import re
import sys
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")


def load_questions():
    html = open(INDEX, encoding="utf-8").read()
    m = re.search(r'<script id="qdata"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        print("ERREUR: bloc <script id=\"qdata\"> introuvable dans index.html")
        sys.exit(1)
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as e:
        print(f"ERREUR: qdata n'est pas un JSON valide : {e}")
        sys.exit(1)


def check_images(html, errors):
    """Vérifie que chaque image référencée par le JS (panneaux/scènes) existe
    bien sur disque, et que SIGNID_CODE ne pointe que vers des codes connus."""
    def block(varname):
        m = re.search(r"var " + varname + r"\s*=\s*\{(.*?)\n  \};", html, re.S)
        return m.group(1) if m else ""

    # QSCENE = {288:'img/scene_288.jpg', ...}
    for num, path in re.findall(r"(\d+)\s*:\s*'([^']+)'", block("QSCENE")):
        if not os.path.exists(os.path.join(ROOT, path)):
            errors.append(f"QSCENE[{num}] pointe vers '{path}' qui n'existe pas")

    # SIGN_IMG construit depuis une liste de codes espacés : ('A B C ...').split(' ')
    m = re.search(r"\(('(?:[^'\\]|\\.)*'(?:\s*\+\s*'(?:[^'\\]|\\.)*')*)\)\.split\(' '\)\.forEach", html, re.S)
    sign_img_codes = []
    if m:
        parts = re.findall(r"'([^']*)'", m.group(1))
        sign_img_codes = "".join(parts).split()
    for code in sign_img_codes:
        p = os.path.join(ROOT, "img", f"sign_{code}.png")
        if not os.path.exists(p):
            errors.append(f"SIGN_IMG déclare le code '{code}' mais img/sign_{code}.png est absent")

    # SIGNID_CODE = {stop:'AB4', ...} doit pointer vers des codes présents dans SIGN_IMG
    for signid, code in re.findall(r"(\w+)\s*:\s*'([^']+)'", block("SIGNID_CODE")):
        if sign_img_codes and code not in sign_img_codes:
            errors.append(f"SIGNID_CODE['{signid}'] = '{code}' absent de SIGN_IMG")


def main():
    html = open(INDEX, encoding="utf-8").read()
    data = load_questions()
    errors = []
    seen_nums = {}

    for i, q in enumerate(data):
        where = f"index {i} (num={q.get('num', '?')})"

        num = q.get("num")
        if not isinstance(num, int):
            errors.append(f"{where}: 'num' manquant ou non entier")
        elif num in seen_nums:
            errors.append(f"{where}: 'num' {num} en double (déjà vu à l'index {seen_nums[num]})")
        else:
            seen_nums[num] = i

        question = q.get("question", "")
        if not isinstance(question, str) or not question.strip():
            errors.append(f"{where}: question vide ou manquante")

        chapter = q.get("chapter", "")
        if not isinstance(chapter, str) or not chapter.strip():
            errors.append(f"{where}: 'chapter' vide ou manquant")

        options = q.get("options")
        if not isinstance(options, dict) or not options:
            errors.append(f"{where}: 'options' vide ou manquant")
            continue

        keys = list(options.keys())
        expected = [chr(ord("a") + k) for k in range(len(keys))]
        if keys != expected:
            errors.append(
                f"{where}: clés d'options non séquentielles {keys} "
                f"(attendu {expected}) — probable erreur d'extraction"
            )

        for k, v in options.items():
            if not isinstance(v, str) or not v.strip():
                errors.append(f"{where}: option '{k}' vide")

        answers = q.get("answers")
        if not isinstance(answers, list) or not answers:
            errors.append(f"{where}: 'answers' vide ou manquant")
            continue

        for a in answers:
            if a not in options:
                errors.append(
                    f"{where}: réponse '{a}' ne correspond à aucune clé d'options {keys}"
                )

        if len(set(answers)) != len(answers):
            errors.append(f"{where}: 'answers' contient un doublon {answers}")

    check_images(html, errors)

    print(f"{len(data)} questions analysées.")
    if errors:
        print(f"\n{len(errors)} PROBLÈME(S) TROUVÉ(S) :\n")
        for e in errors:
            print(" -", e)
        sys.exit(1)

    print("OK — aucune anomalie structurelle détectée.")


if __name__ == "__main__":
    main()
