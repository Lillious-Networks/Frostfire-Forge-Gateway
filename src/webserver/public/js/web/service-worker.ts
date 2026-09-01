/// <reference lib="webworker" />
// Service Worker: HTTP-level cache for large, rarely-changing asset-server
// binaries (sprites, tilesets, icons). Transpiled to service-worker.js by
// src/utility/transpiler.ts and served at /service-worker.js (root scope) by
// the webserver.

declare const self: ServiceWorkerGlobalScope;

const ASSET_CACHE = 'asset-cache-v2';

// Asset-server GET endpoints whose responses are safe to cache indefinitely.
// Matched by exact pathname so e.g. "/sprite" doesn't also swallow
// "/sprite-sheet-image".
const CACHEABLE_PATHS: ReadonlySet<string> = new Set([
  '/sprite',
  '/sprite-sheet-image',
  '/sprite-sheet-template',
  '/sprite-sheets',
  '/sprite-template',
  '/icon',
  '/tileset',
]);

// Soft cap on total cached bytes; oldest entries are evicted past this.
const MAX_CACHE_SIZE = 100 * 1024 * 1024;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (name === ASSET_CACHE ? undefined : caches.delete(name))),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event: FetchEvent) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (!CACHEABLE_PATHS.has(url.pathname)) return;

  event.respondWith(handleCacheStrategy(event.request));
});

// Cache-first: serve from Cache Storage when present, otherwise fetch and store.
async function handleCacheStrategy(request: Request): Promise<Response> {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;

    const response = await fetch(request);

    // Cache real assets only. NOT the "missing" fallback: Cache Storage has no
    // TTL, so a cached fallback would mask a real asset added later until the
    // whole cache is bumped. The asset server sends the fallback with a short
    // max-age, so the browser's HTTP cache handles placeholder de-duplication
    // and self-expires.
    if (
      response.status === 200 &&
      !response.headers.get('X-Asset-Fallback')
    ) {
      const cache = await caches.open(ASSET_CACHE);
      await cache.put(request, response.clone());
      await evictIfOverBudget(cache);
    }

    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline - asset not cached', { status: 503 });
  }
}

async function evictIfOverBudget(cache: Cache): Promise<void> {
  try {
    const keys = await cache.keys();

    let total = 0;
    const entries: Array<{ request: Request; size: number; url: string }> = [];
    for (const request of keys) {
      const response = await cache.match(request);
      if (!response) continue;
      const size = await responseSize(response);
      entries.push({ request, size, url: request.url });
      total += size;
    }

    if (total <= MAX_CACHE_SIZE) return;

    // Deterministic order (by URL) for a stable eviction set.
    entries.sort((a, b) => a.url.localeCompare(b.url));

    let freed = 0;
    const need = total - MAX_CACHE_SIZE;
    for (const entry of entries) {
      if (freed >= need) break;
      await cache.delete(entry.request);
      freed += entry.size;
    }
  } catch {
    // Eviction is best-effort.
  }
}

async function responseSize(response: Response): Promise<number> {
  try {
    return (await response.clone().blob()).size;
  } catch {
    return 0;
  }
}
