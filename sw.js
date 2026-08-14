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
