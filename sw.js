/**
 * sw.js – Service worker providing offline support for the Fluid PWA.
 *
 * Strategy
 * --------
 *   • App shell (HTML, CSS, all ES-module sources, manifest, icon) is
 *     pre-cached on `install` so the simulation works fully offline after
 *     the first successful load.
 *   • Same-origin GET requests use a stale-while-revalidate strategy:
 *       1. Serve from cache immediately if present.
 *       2. In parallel, fetch the network copy and update the cache so the
 *          next load is fresh.
 *   • Navigation requests (e.g. the user reloads while offline) fall back
 *     to the cached `index.html`.
 *   • Cross-origin and non-GET requests bypass the cache entirely.
 *   • A versioned cache name (`CACHE_VERSION`) guarantees that bumping
 *     the version invalidates the previous shell on `activate`.
 *
 * All asset paths are relative to the SW's scope, so the worker behaves
 * correctly whether the site is hosted at `/` or at `/Fluid/` (e.g.
 * GitHub Pages project sites).
 */

const CACHE_VERSION = 'fluid-v1';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './styles/main.css',
  './src/main.js',
  './src/config.js',
  './src/webgl/GLUtils.js',
  './src/fluid/FluidSimulation.js',
  './src/fluid/Shaders.js',
  './src/particles/ParticleSystem.js',
  './src/input/InputHandler.js',
  './src/ui/UI.js',
  './src/audio/AudioReactivity.js',
];

/* ──────────────────────────────────────────────────────────────────────
   Install – pre-cache the app shell
   ────────────────────────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Use {cache: 'reload'} so the install never picks up a stale HTTP cache.
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if (res && res.ok) await cache.put(url, res);
      } catch (_) {
        // Skip individual asset failures so install never aborts wholesale.
      }
    }));
    self.skipWaiting();
  })());
});

/* ──────────────────────────────────────────────────────────────────────
   Activate – drop old caches
   ────────────────────────────────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ──────────────────────────────────────────────────────────────────────
   Fetch – stale-while-revalidate for same-origin GETs
   ────────────────────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Bypass anything that isn't a same-origin GET.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache    = await caches.open(CACHE_VERSION);
    const cached   = await cache.match(req, { ignoreSearch: false });
    const networkP = fetch(req).then((res) => {
      // Only cache successful, basic responses (skip opaque/range/etc).
      if (res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) return cached;

    const network = await networkP;
    if (network) return network;

    // Offline navigation fallback.
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }

    return new Response('', { status: 504, statusText: 'Offline' });
  })());
});
