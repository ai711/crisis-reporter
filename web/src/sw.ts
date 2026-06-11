/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst, CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

// ── Precaching ────────────────────────────────────────────────────────────────
// VitePWA injects the build manifest here at compile time.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── Runtime caching ───────────────────────────────────────────────────────────

// Map tiles — long-lived cache-first (same as previous generateSW config)
registerRoute(
  /^https:\/\/api\.maptiler\.com\/.*/i,
  new CacheFirst({
    cacheName: "map-tiles",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 500,
        maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
      }),
    ],
  })
);

// API GET responses — short-lived network-first (same as before)
registerRoute(
  ({ request }: { request: Request }) =>
    request.method === "GET" && /\/api\//.test(request.url),
  new NetworkFirst({
    cacheName: "crisis-reporter-api-cache",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 60 * 5, // 5 minutes
      }),
    ],
  })
);

// ── Background Sync — 'sync-reports' ─────────────────────────────────────────
//
// When the device comes online and the browser fires a background sync event:
//  1. If a window client is open  → message it to call syncQueue (it has access
//     to localStorage tokens and the full sync engine).
//  2. If no window is open        → we cannot access localStorage from the SW,
//     so we skip and let the next app open handle it via the online/visibility
//     triggers registered in registerSyncTriggers().
//
// This covers the most common case: app is backgrounded (not closed) and the
// device reconnects. Chrome fires the sync event in the SW even when the tab
// is hidden, and a hidden (not closed) tab counts as an open client.

// Background Sync API is not in the default TypeScript ServiceWorker lib.
// Use a typed cast so we don't lose the event shape.
(self as unknown as EventTarget).addEventListener("sync", (rawEvent: Event) => {
  const event = rawEvent as Event & { tag: string; waitUntil(p: Promise<void>): void };
  if (event.tag === "sync-reports") {
    event.waitUntil(handleBackgroundSync());
  }
});

async function handleBackgroundSync(): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window" });
  if (clients.length > 0) {
    // An open window exists — ask it to run the full sync engine which has
    // access to localStorage tokens and the complete retry/refresh logic.
    for (const client of clients) {
      client.postMessage({ type: "TRIGGER_SYNC" });
    }
  }
  // If no clients are open: no action — the next app open will trigger sync
  // via the proactive cold-start call in registerSyncTriggers().
}

// ── SW lifecycle ──────────────────────────────────────────────────────────────
// Skip waiting so the new SW takes over immediately after installation.
// The main thread's controllerchange listener reloads the page to pick up
// fresh JS bundles.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
