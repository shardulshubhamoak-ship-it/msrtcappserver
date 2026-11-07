/* MSRTC ST Bus Portal - service worker: the app opens even with no internet.
   Pages: network first (always the newest version when online), cached copy when offline or slow (5 s).
   /sync, /otp and /health are never cached. Bump CACHE to force a refresh of the stored files. */
const CACHE = 'msrtc-shell-v1';
const SHELL = ['/', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function pageNetFirst(req) {
  return new Promise(resolve => {
    let done = false;
    const fromCache = () => caches.match('/').then(c => { if (!done && c) { done = true; resolve(c); } return !!c; });
    const timer = setTimeout(fromCache, 5000);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then(has => { if (!done && !has) { done = true; resolve(Response.error()); } });
    });
  });
}

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || /^\/(sync|otp|health)/.test(u.pathname)) return;
  if (r.mode === 'navigate') { e.respondWith(pageNetFirst(r)); return; }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
    return res;
  })));
});
