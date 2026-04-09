const CACHE = 'pokemat-v1';
const ASSETS = ['/dashboard.html', '/grafy.html', '/prodeje.html', '/stav.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
