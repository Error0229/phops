// Offline shell. Files are refreshed in the background when online; bump VERSION to force a clean re-download.
const VERSION = 'phops-v2';
const SHELL = [
  './',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'vendor/mediabunny.min.mjs',
  'vendor/mediabunny-aac-encoder.min.mjs',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION && key !== 'phops-share') await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // Android share sheet -> "phops": stash the video locally and open the app with it.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('video');
        if (file) {
          const cache = await caches.open('phops-share');
          await cache.put('shared-file', new Response(file, {
            headers: { 'content-type': file.type || 'video/mp4', 'x-file-name': encodeURIComponent(file.name || 'shared-video') },
          }));
        }
      } catch {}
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET') return;
  // Serve from cache instantly (works offline); refresh the cached copy in the background when online,
  // so an updated app shows up on the next launch.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const refresh = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.status === 200) cache.put(e.request, res.clone());
      return res;
    });
    if (!cached) return refresh;
    e.waitUntil(refresh.catch(() => {}));
    return cached;
  })());
});
