// Offline support: solo play works with no connection. Online tables still need the server.
const CACHE = 'grand-squeeze-v8';
const SHELL = ['./', 'index.html', 'baccarat.html', 'holdem.html', 'holdem-core.js', 'tcp.html', 'tcp-core.js', 'bj.html', 'bj-core.js', 'pg.html', 'pg-core.js', 'table-core.js', 'privacy.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // each page: the newest version when online, the saved copy of that same page when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
    return;
  }
  // game files too: always the newest when online (so a page and its dealer file never get out of step), the saved copy offline
  e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })
    .catch(() => caches.match(req)));
});
