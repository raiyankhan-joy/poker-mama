// Ultra-lightweight Network-First Service Worker for POKER MAMA PWA Installability
// Never caches API/WebSocket or serves stale game code.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Always go straight to network so live updates & WebSockets stay 100% fresh
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
