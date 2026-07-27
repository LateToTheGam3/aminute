// aminute service worker — offline-first shell, last-known-good news.
// Bump CACHE_VERSION to force clients onto new assets.
const CACHE_VERSION = 'aminute-v2';
const SHELL = ['/', '/index.html', '/glossary.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Cross-origin (fonts, article images): cache-first, refresh in background.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => hit)
      )
    );
    return;
  }

  // News + explainers: network-first, fall back to the last good copy offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => {
            if (!hit) {
              return new Response(JSON.stringify({ error: 'offline' }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
              });
            }
            // Tag cache fallbacks so the app can say the news is stale rather
            // than silently showing old cards as if they were current.
            return hit.blob().then((body) => new Response(body, {
              status: 200,
              headers: { 'content-type': 'application/json', 'x-from-cache': '1' },
            }));
          })
        )
    );
    return;
  }

  // App shell: stale-while-revalidate. Serve the cached copy instantly, but
  // always refresh it in the background — a pure cache-first shell would pin
  // users to an old index.html and no code change would ever reach them.
  event.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || caches.match('/index.html'));
      return hit || fresh;
    })
  );
});
