/*
 * CODE 229 — service worker.
 *
 * Stratégies volontairement différentes selon le type de ressource :
 * - App shell (/ et /index.html) : réseau d'abord, cache en secours.
 *   Ça évite le piège classique des PWA où un utilisateur reste bloqué
 *   sur une vieille version en cache après qu'on ait déployé une mise à
 *   jour — s'il a du réseau, il obtient toujours la dernière version ;
 *   hors-ligne, il retombe sur la dernière copie connue.
 * - Images (/img/*) : cache d'abord. Elles ne changent presque jamais une
 *   fois publiées, et c'est justement ce qui rend l'app utilisable pour
 *   réviser sans connexion (panneaux, scènes, icônes).
 *
 * CACHE_NAME est volontairement versionné à la main : incrémenter la
 * valeur force le nettoyage de l'ancien cache au prochain déploiement
 * si la structure des assets change (ex: renommage d'images).
 */
const CACHE_NAME = 'code229-v1';
const APP_SHELL = ['/', '/index.html'];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(APP_SHELL); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  var url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== self.location.origin) return;

  var isAppShell = url.pathname === '/' || url.pathname === '/index.html';
  var isStaticAsset = url.pathname.indexOf('/img/') === 0 || url.pathname === '/manifest.json';

  if(isAppShell){
    event.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
        return res;
      }).catch(function(){
        return caches.match(req).then(function(cached){ return cached || caches.match('/index.html'); });
      })
    );
    return;
  }

  if(isStaticAsset){
    event.respondWith(
      caches.match(req).then(function(cached){
        if(cached) return cached;
        return fetch(req).then(function(res){
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
          return res;
        });
      })
    );
  }
});

/*
 * Rappel de streak en arrière-plan (best-effort, Chrome/Android
 * uniquement) : quand le navigateur juge l'app assez engageante et
 * qu'elle est installée, il déclenche périodiquement 'periodicsync' même
 * app fermée. Le service worker n'a pas accès à localStorage, donc
 * l'app principale dépose ici un petit instantané du streak (via Cache
 * Storage, pas de backend) à chaque sauvegarde de progression — voir
 * saveStreakSnapshot() dans index.html. Aucune garantie de fréquence
 * (le navigateur décide), donc on reste silencieux si l'API n'existe
 * pas ou que rien n'est dû : ce n'est qu'un bonus, jamais une dépendance.
 */
const STREAK_CACHE = 'code229-streak-v1';
const STREAK_URL = '/__streak-state';

function dayStr(d){ return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }

function checkStreakAndNotify(){
  return caches.open(STREAK_CACHE).then(function(cache){
    return cache.match(STREAK_URL);
  }).then(function(res){
    return res ? res.json() : null;
  }).then(function(data){
    if(!data || !data.streak || data.lastActiveDate === dayStr(new Date())) return;
    return self.registration.showNotification('CODE 229', {
      body: 'Ton streak de ' + data.streak + ' jour' + (data.streak > 1 ? 's' : '') + ' est en jeu — une session rapide et c\'est sauvé.',
      icon: '/img/icon-192.png',
      badge: '/img/icon-192.png',
      tag: 'streak-reminder'
    });
  }).catch(function(){});
}

self.addEventListener('periodicsync', function(event){
  if(event.tag === 'streak-check') event.waitUntil(checkStreakAndNotify());
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type:'window'}).then(function(list){
      for(var i=0;i<list.length;i++){ if('focus' in list[i]) return list[i].focus(); }
      if(self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
