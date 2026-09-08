# Tests de validation — Connexion Google + Premium

## ⚠️ Cause racine du bug (identifiée et corrigée)

**Problème dans le commit 5fac744:**

Le commit précédent appelait `render()` dans `onAuthStateChanged` uniquement si `!wasSignedIn`:

```javascript
if(user && !user.isAnonymous){
  state.user = {...};
  if(!wasSignedIn){  // ← Condition problématique
    reconcileCloudProgress(state.user);
    toast('✓ Parcours sauvegardé...');
    render();  // ← render() seulement ici
  }
  // ← PAS de render() si wasSignedIn déjà true
}
```

**Scénarios d'échec:**

1. **onAuthStateChanged se déclenche plusieurs fois rapidement** après `linkWithRedirect`:
   - 1er appel: utilisateur anonyme → `state.user = null`
   - 2e appel: utilisateur Google → **`wasSignedIn = false`** → render() ✓
   - 3e appel: même utilisateur (confirmation) → **`wasSignedIn = true`** → **PAS de render()** ✗

2. **Timing de navigation:**
   - Utilisateur clique "Sécuriser mon accès"
   - Redirection Google
   - Retour sur l'app
   - `init()` appelle `render()` avec `state.user` potentiellement obsolète
   - `onAuthStateChanged` se déclenche après avec `wasSignedIn = true` → pas de re-render

3. **`getRedirectResult()` n'avait aucun handler `.then()`:**
   - Seulement un `.catch()` pour les erreurs
   - En cas de succès, aucun log/diagnostic
   - Impossible de tracer le flux

**Correction appliquée:**

✅ `render()` est maintenant appelé **TOUJOURS** quand `state.user` est mis à jour pour un utilisateur Google  
✅ Ajout d'un `.then()` handler sur `getRedirectResult()` pour tracer le succès  
✅ Ajout de logs console pour diagnostiquer le flux d'authentification  

---

## 📋 Logs de diagnostic (temporaires)

Après connexion Google réussie, la console doit afficher:

```
[auth] redirect success: anonymous user linked to Google, uid=ABC123
[auth] onAuthStateChanged: Google uid=ABC123
[auth] updating state.user, wasSignedIn=false
[auth] calling render() to sync UI with connected state
```

**UID doit rester identique** entre avant et après la connexion Google (linkWithRedirect conserve le UID anonyme).

---

## Scénarios à tester manuellement

### ✅ Scénario 1: Utilisateur anonyme Premium → Connexion Google

**Setup:**
1. Ouvrir l'app en navigation privée / vider le cache
2. Faire le diagnostic gratuit
3. Acheter Premium (1000 FCFA via FedaPay sandbox)
4. Attendre la confirmation webhook
5. Vérifier que Premium est actif

**Action:**
- Cliquer sur "Sécuriser mon accès" dans l'écran Progression
- Terminer la connexion Google

**Résultat attendu:**
- ✅ Toast de confirmation: "✓ Parcours sauvegardé — Bienvenue, [Prénom] !"
- ✅ Le bouton "Sécuriser mon accès" disparaît IMMÉDIATEMENT
- ✅ Le bouton "Sauvegarder mon parcours" disparaît IMMÉDIATEMENT
- ✅ La carte compte affiche maintenant: photo Google, nom, email, "Parcours synchronisé"
- ✅ Premium reste actif (même date d'expiration)
- ✅ Le badge "Premium actif" reste visible
- ✅ Rafraîchir la page: Premium toujours actif, utilisateur toujours connecté

---

### ✅ Scénario 2: Utilisateur anonyme avec progression → Connexion Google

**Setup:**
1. Ouvrir l'app en navigation privée
2. Faire plusieurs sessions (sans payer Premium)
3. Accumuler un streak de 3+ jours (ou simuler via localStorage)

**Action:**
- En fin de série, cliquer sur "Sauvegarder mon parcours"
- Terminer la connexion Google

**Résultat attendu:**
- ✅ Toast de confirmation: "✓ Parcours sauvegardé — Bienvenue, [Prénom] !"
- ✅ Tous les CTA de connexion disparaissent immédiatement
- ✅ La progression locale est conservée
- ✅ Rafraîchir: progression conservée, utilisateur connecté

---

### ✅ Scénario 3: Utilisateur anonyme → Paywall → Connexion avant paiement

**Setup:**
1. Ouvrir l'app en navigation privée
2. Faire le diagnostic gratuit
3. Accéder au paywall

**Action:**
- Cliquer sur "Continuer avec Google" (avant de payer)
- Terminer la connexion Google
- Retourner au paywall

**Résultat attendu:**
- ✅ Le CTA "Continuer avec Google" a disparu du paywall
- ✅ Le message "Connecte-toi avant de payer..." a disparu
- ✅ Seul le bouton "Débloquer pendant 30 jours" reste visible

---

### ✅ Scénario 4: Utilisateur déjà connecté n'a jamais les CTA

**Setup:**
1. Se connecter avec Google (sans Premium)
2. Naviguer dans l'app

**Résultat attendu:**
- ✅ Écran Progression: carte compte affichée, AUCUN CTA de connexion
- ✅ Fin de série: AUCUN "Sauvegarder mon parcours"
- ✅ Paywall: AUCUN "Continuer avec Google"
- ✅ Aucune proposition de connexion nulle part

---

### ✅ Scénario 5: Premium anonyme + Connexion existante sur autre appareil

**Setup:**
1. Appareil A: créer un compte Google, acheter Premium
2. Appareil B (navigation privée): acheter Premium en anonyme
3. Sur appareil B: cliquer "Sécuriser mon accès" et se connecter avec le MÊME compte Google

**Action:**
- Accepter ou refuser le switch de compte dans la modal

**Résultat attendu si switch accepté:**
- ✅ Modal d'avertissement explicite: "Ce compte Google est déjà utilisé..."
- ✅ Premium de l'appareil A est récupéré
- ✅ Premium de l'appareil B est abandonné (utilisateur averti)

**Résultat attendu si switch refusé:**
- ✅ Connexion annulée
- ✅ Premium anonyme local conservé
- ✅ Utilisateur reste anonyme

---

### ✅ Scénario 6: Déconnexion puis reconnexion

**Setup:**
1. Utilisateur Premium connecté

**Action:**
- Se déconnecter
- Se reconnecter avec le même compte Google

**Résultat attendu:**
- ✅ Modal de confirmation avant déconnexion: "Tu retrouveras ton accès Premium..."
- ✅ Après reconnexion: Premium immédiatement restauré
- ✅ Aucune perte de données

---

### ✅ Scénario 7: Rafraîchissement de page pendant/après connexion

**Setup:**
1. Utilisateur anonyme Premium
2. Cliquer "Sécuriser mon accès"
3. PENDANT la redirection Google, ouvrir un nouvel onglet de l'app

**Résultat attendu:**
- ✅ Dans le nouvel onglet: onAuthStateChanged détecte la connexion
- ✅ UI se synchronise automatiquement
- ✅ Aucun CTA de connexion visible
- ✅ Premium toujours actif

---

## Code review checklist

- ✅ `renderPremiumUnsecuredBanner()` retourne `''` si `state.user` existe
- ✅ `renderSaveProgressCard()` retourne `''` si `state.user` existe
- ✅ `onAuthStateChanged` appelle `render()` après connexion réussie
- ✅ `watchPremiumStatus` appelle `render()` quand Premium change
- ✅ `syncUserFromAuth()` appelé dans `renderTopbar()` (à chaque render)
- ✅ `linkWithRedirect` utilisé pour lier compte Google au UID anonyme (conserve Premium)
- ✅ Gestion du conflit `credential-already-in-use` avec modal explicite
- ✅ Cache Premium local préserve l'accès si Firestore injoignable
- ✅ Aucune modification du webhook FedaPay (sécurité préservée)

---

## Commits

**Correction finale (ce commit):**
```
À venir - fix: reliably sync auth state after Google redirect
```

**Problème:** Le commit 5fac744 n'appelait `render()` que si `!wasSignedIn`, ce qui échouait si `onAuthStateChanged` se déclenchait plusieurs fois ou avec un mauvais timing.

**Solution:** `render()` est maintenant appelé TOUJOURS après mise à jour de `state.user` pour un utilisateur Google connecté.

---

**Commits précédents:**
```
5fac744 - fix: synchronisation immédiate de l'UI après connexion Google (Premium + compte) [INCOMPLET]
fb4d40c - diagnostic devise: inspection du format réel de transaction.currency du SDK FedaPay ^1.2.5
```

