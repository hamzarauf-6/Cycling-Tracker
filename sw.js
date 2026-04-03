// ─── Service Worker ────────────────────────────────────────────
// Caches the app shell (HTML, CSS, JS) so it loads instantly.
// Mapbox tiles and Leaflet CDN are always fetched fresh from network.

const CACHE = 'ride-tracker-v1';

const CORE_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './icon.svg',
  './manifest.json',
];

// On install: cache all core files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE_FILES))
      .then(() => self.skipWaiting())
  );
});

// On activate: delete any old caches from previous versions
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// On fetch: serve from cache if available, otherwise go to network.
// External requests (Mapbox, Leaflet) always go straight to network.
self.addEventListener('fetch', event => {
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});
