// App-shell cache only. API data is never cached, so nothing stale is ever shown as live.
const V = 'phq-v8';
const SHELL = ['/', '/app.js', '/app.css', '/manifest.webmanifest', '/icons/icon.svg?v=geass2', '/icons/icon-192.png?v=geass2', '/favicon.ico?v=geass2', '/favicon.svg?v=geass2', '/board-bg.jpg?v=geass2', '/board-bg.webp?v=geass2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  const isNav = e.request.mode === 'navigate';
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(V).then((c) => c.put(isNav ? '/' : e.request, copy)); }
    return r;
  }).catch(() => caches.match(isNav ? '/' : e.request)));
});
