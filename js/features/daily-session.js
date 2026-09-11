/* CODE 229 — Session du jour.
 *
 * Module volontairement isolé : il ne touche NI au DOM, NI à l'état global de
 * l'application. Tout le reste de CODE 229 vit dans une IIFE qui n'expose rien
 * sur window, donc ce module reçoit ses dépendances par injection explicite
 * (voir configure) plutôt que d'aller les chercher.
 *
 * Sa seule responsabilité : décider QUELLES questions composent la session du
 * jour, et se souvenir qu'elle a été faite. Le déroulé du quiz, l'affichage et
 * l'enregistrement des réponses restent entièrement au moteur existant — il
 * n'y a pas de second moteur de quiz ici.
 */
(function () {
  'use strict';

  window.Code229 = window.Code229 || {};

  var STORAGE_KEY = 'code229_daily_session';
  var TARGET = 10;

  /* Répartition visée quand les données le permettent. Elle n'est jamais
     contraignante : toute catégorie vide est compensée par les suivantes, une
     session n'est donc jamais ni bloquée ni incomplète. */
  var MIX = { weak: 4, due: 4, fresh: 2 };

  var deps = null;

  /**
   * @param {Object} d
   *   getQuestions() -> tableau de questions ({num, ...})
   *   getProgress()  -> objet de progression (lu à chaque appel : il est
   *                     remplacé après le chargement et la synchronisation cloud)
   *   isWeak(rec)    -> true si l'historique d'une question la désigne comme faible
   *   shuffle(arr)   -> copie mélangée
   */
  function configure(d) { deps = d; }

  /* Clé de jour en heure LOCALE : la journée d'un élève commence à sa minuit,
     pas à celle d'UTC. Même format que le reste de l'app (dayStr). */
  function dayKey(date) {
    var d = date || new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function write(session) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); }
    catch (e) { /* stockage plein ou refusé : la session reste jouable en mémoire */ }
  }

  /* Sélection des questions du jour.
     Ordre de priorité : faibles -> dues -> jamais vues -> le reste.
     Chaque question est retenue au plus une fois (registre `taken`). */
  function select() {
    var questions = deps.getQuestions();
    var per = (deps.getProgress() || {}).perQuestion || {};
    var now = Date.now();
    var picked = [], reasons = {}, taken = {};

    function rec(q) { return per[String(q.num)]; }

    function take(list, limit, reason) {
      for (var i = 0; i < list.length && limit > 0; i++) {
        var q = list[i];
        if (taken[q.num]) continue;
        taken[q.num] = true;
        reasons[q.num] = reason;
        picked.push(q.num);
        limit--;
      }
    }

    var weak = deps.shuffle(questions.filter(function (q) { return deps.isWeak(rec(q)); }));
    // Déjà triées de la plus anciennement due à la plus récente : on révise
    // en priorité ce qui attend depuis le plus longtemps.
    var due = questions.filter(function (q) {
      var r = rec(q);
      return r && r.seen > 0 && (r.due || 0) <= now;
    }).sort(function (a, b) { return rec(a).due - rec(b).due; });
    var fresh = deps.shuffle(questions.filter(function (q) {
      var r = rec(q);
      return !r || r.seen === 0;
    }));

    take(weak, MIX.weak, 'weak');
    take(due, MIX.due, 'due');
    take(fresh, MIX.fresh, 'new');

    // Complément adaptatif : un débutant n'a ni faibles ni dues, un élève
    // avancé n'a plus de nouvelles. On puise dans ce qui reste, sans jamais
    // rendre une session plus courte que prévu.
    if (picked.length < TARGET) take(weak, TARGET - picked.length, 'weak');
    if (picked.length < TARGET) take(due, TARGET - picked.length, 'due');
    if (picked.length < TARGET) take(fresh, TARGET - picked.length, 'new');
    if (picked.length < TARGET) take(deps.shuffle(questions), TARGET - picked.length, 'review');

    var ids = deps.shuffle(picked).slice(0, TARGET);
    var kept = {};
    ids.forEach(function (n) { kept[n] = reasons[n]; });
    return { questionIds: ids, reasons: kept };
  }

  function create() {
    var chosen = select();
    var session = {
      dailySessionDate: dayKey(),
      questionIds: chosen.questionIds,
      reasons: chosen.reasons,
      currentIndex: 0,
      completed: false,
      score: null,
      total: chosen.questionIds.length,
      startedAt: Date.now(),
      completionDate: null
    };
    write(session);
    return session;
  }

  /* La session du jour est STABLE : fermer puis rouvrir l'app ne la régénère
     pas. Une nouvelle n'est composée qu'au changement de jour. */
  function getOrCreateToday() {
    var current = read();
    if (current &&
        current.dailySessionDate === dayKey() &&
        Array.isArray(current.questionIds) &&
        current.questionIds.length) {
      return current;
    }
    return create();
  }

  function isCompletedToday() {
    var current = read();
    return !!(current && current.dailySessionDate === dayKey() && current.completed);
  }

  /* Appelé à la fin d'une session du jour. `completionDate` est ce sur quoi
     s'appuiera une future mécanique d'objectif quotidien — la streak, elle,
     existe déjà côté application et n'est pas dupliquée ici. */
  function markCompleted(score, total) {
    var current = getOrCreateToday();
    current.completed = true;
    current.score = score;
    if (typeof total === 'number') current.total = total;
    current.currentIndex = current.questionIds.length;
    current.completionDate = new Date().toISOString();
    write(current);
    return current;
  }

  function getState() { return read(); }

  /* Régénère à la demande (données de questions modifiées, session corrompue). */
  function reset() { return create(); }

  window.Code229.DailySession = {
    configure: configure,
    getOrCreateToday: getOrCreateToday,
    isCompletedToday: isCompletedToday,
    markCompleted: markCompleted,
    getState: getState,
    reset: reset,
    TARGET: TARGET
  };
})();
