// Fast Versioned-Asset Service Worker for POKER MAMA
// - Cache-first for immutable ?v= versioned JS/CSS & /icons/ (~5ms instant load!)
// - Always network-first for HTML & /api/ so every deploy updates immediately.
const CACHE_NAME = 'poker-mama-static-v32';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isImmutableAsset =
    (url.searchParams.has('v') && /\.(css|js)$/.test(url.pathname)) ||
    url.pathname.startsWith('/icons/');

  if (isImmutableAsset) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((resp) => {
            if (resp && resp.ok) cache.put(event.request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  event.respondWith(fetch(event.request));
});
