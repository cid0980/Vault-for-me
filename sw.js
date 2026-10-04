/* RepoVault service worker — makes the app installable and usable offline.
 *
 * Rules it follows, deliberately:
 *   • ONLY same-origin GETs are touched. Uploads (POST/PUT/PATCH/DELETE) and
 *     every api.github.com / raw.githubusercontent.com call go straight to the
 *     network — a stale cached API response would be a data-integrity bug, and
 *     a cached upload would be worse.
 *   • Navigations are network-first (so a new deploy lands immediately) with a
 *     cache fallback (so the app still opens with no signal).
 *   • Static shell assets are cache-first with background refresh.
 *   • The cache name carries a version; the old one is deleted on activate.
 *
 * Bump CACHE_VERSION whenever you ship changes you want evicted immediately.
 * (The browser revalidates on its own within 24h regardless.)
 */

const CACHE_VERSION = 'repovault-v1';
const SHELL = [
  './',
  './index.html',
  './repovault.html',
  './manifest.webmanifest',
  './app/core/util.js',
  './app/core/crypto.js',
  './app/core/vault.js',
  './app/core/lock.js',
  './app/adapters/github.js',
  './app/adapters/memory.js',
  './app/ui/app.js',
  './icons/favicon-32.png',
  './icons/favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const isSameOrigin = (url) => url.origin === self.location.origin;
const isStaticAsset = (request) => request.method === 'GET' && isSameOrigin(new URL(request.url));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll is atomic: one 404 would abort the whole install, so add
      // individually and tolerate misses (e.g. an icon you deleted).
      .then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION') event.source && event.source.postMessage({ version: CACHE_VERSION });
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Never touch anything that isn't a same-origin GET.
  if (!isStaticAsset(request)) return;

  // Navigations: fresh HTML when online, cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  // Static assets: serve from cache instantly, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          // only cache clean, complete, same-origin responses
          if (response && response.ok && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
