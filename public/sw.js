/**
 * County Finder — Service Worker
 *
 * Strategy:
 *   /api/*        → Network only (never cache location responses)
 *   /_next/static → Cache first (hashed filenames, safe to cache forever)
 *   /             → Network first, fall back to cache
 *   /offline      → Served from cache as fallback
 */

const CACHE_VERSION = "county-finder-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;

// App shell URLs to cache on install
const APP_SHELL = ["/", "/privacy", "/manifest.json", "/icons/icon.svg"];

// ── Install ───────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGE_CACHE)
      .then((cache) =>
        // Cache what we can; ignore failures for missing icons etc.
        Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("county-finder-") && k !== STATIC_CACHE && k !== PAGE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests (POST /api/lookup goes straight to network)
  if (request.method !== "GET") return;

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) return;

  // API routes: network only — never cache coordinate lookups
  if (url.pathname.startsWith("/api/")) return;

  // Next.js static assets (content-hashed filenames): cache first
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Everything else (HTML, icons, manifest): network first
  event.respondWith(networkFirst(request, PAGE_CACHE));
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Return a minimal offline response
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>County Finder — Offline</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;color:#0f172a;margin:0;padding:1rem}div{text-align:center;max-width:360px}h1{font-size:1.5rem;margin-bottom:1rem}p{color:#64748b;font-size:.9rem}</style></head><body><div><h1>📡 You're offline</h1><p>County Finder couldn't load. Open the app when you have a connection to cache it for offline use.</p></div></body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }
}
