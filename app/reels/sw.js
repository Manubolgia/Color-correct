/* Offline support for UW Reels. BUILD is stamped with the commit on deploy, so each release gets a fresh cache.
   The shared engine (../js, ../vendor) and base styles are cached here too: this app works without UW Color installed. */
var BUILD = '__BUILD__';
var CACHE = 'uw-reels-' + BUILD;
var SHARE = 'uw-reels-share';
var ASSETS = [
  './',
  'index.html',
  'reels.css',
  'manifest.webmanifest',
  'js/reels.js',
  'js/path.js',
  'js/track.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  '../app.css',
  '../js/ios.js',
  '../js/media.js',
  '../js/opfs-worker.js',
  '../js/store.js',
  '../vendor/mediabunny.js'
];

self.addEventListener('install', function (e) {
  // A new version waits until the page says it's safe to switch (no export running).
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('uw-reels-') === 0 && k !== CACHE && k !== SHARE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (e) { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Android share sheet → stash the file, then open the app, which picks it up.
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async function () {
      try {
        var data = await req.formData(), files = data.getAll('media'), c = await caches.open(SHARE);
        var old = await c.keys(); await Promise.all(old.map(function (k) { return c.delete(k); }));
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (!f || typeof f === 'string') continue;
          await c.put(new Request(new URL('shared/' + i, self.registration.scope)), new Response(f, {
            headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'shared-' + i) }
          }));
        }
      } catch (err) {}
      return Response.redirect(new URL('./?share-target=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
    e.respondWith(caches.match('index.html', { cacheName: CACHE }).then(function (hit) {
      return hit || fetch(req);
    }).catch(function () { return fetch(req); }));
    return;
  }
  e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then(function (hit) {
    return hit || fetch(req);
  }));
});
