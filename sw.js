// Service Worker mínimo para DRIVX — necesario para que Chrome/Edge
// consideren la app instalable de forma fiable.
const CACHE_NAME = 'drivx-cache-v1';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

// Fetch handler mínimo (pass-through). No cachea nada para no
// interferir con Firebase ni con datos en vivo de la app.
self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request).catch(function() {
    return new Response('Sin conexión', { status: 503, statusText: 'Offline' });
  }));
});
