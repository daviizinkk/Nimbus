/* Nimbus static shell service worker.
 * Never caches API responses, public share pages or private media.
 */
const CACHE = 'nimbus-shell-v1.3.0';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/nimbus-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isPrivatePath(pathname) {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/s/') ||
    pathname === '/share-target'
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isPrivatePath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('/', response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match('/');
          return cached || new Response('Nimbus is offline.', { status: 503, headers: { 'content-type': 'text/plain' } });
        }
      })(),
    );
    return;
  }

  if (!url.pathname.startsWith('/assets/')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return new Response('', { status: 504 });
      }
    })(),
  );
});
