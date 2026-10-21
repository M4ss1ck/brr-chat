// Service worker for the PWA shell. Data saving is the point (docs/PROTOCOL.md): the shell is
// precached once and served from cache afterwards, while auth and /sync always hit the network.
// This file is checked with its own tsconfig (lib: WebWorker), so the DOM lib of the shell does
// not need the service worker types hand-declared.
const CACHE = "brr-shell-v1";
const SHELL: readonly string[] = ["/", "/index.html", "/app.js", "/sw.js", "/manifest.webmanifest", "/icon.svg"];
/** Fetched only on the screen that needs it; cached after the first use, not at install. */
const LAZY: readonly string[] = ["/qr-scan.js", "/passkey.js"];
/** Never cached: credentials, sync payloads and media are always fresh from the server. */
const NEVER_CACHE: readonly string[] = ["/api/auth/", "/sync", "/m/"];

const scope: ServiceWorkerGlobalScope = self as unknown as ServiceWorkerGlobalScope;

async function precache(): Promise<void> {
  const cache = await caches.open(CACHE);
  await Promise.all(
    SHELL.map(async (path) => {
      try {
        await cache.add(path);
      } catch {
        // One missing asset must not fail the install; the shell also caches it later.
      }
    }),
  );
}

scope.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => scope.skipWaiting()));
});

scope.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => scope.clients.claim()),
  );
});

scope.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== scope.location.origin) return;
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return;

  // Navigations: network first, so a new shell shows up as soon as it is deployed.
  if (request.mode === "navigate") {
    // Both "/" and "/index.html" are in the precache list; either one is the same document.
    const offlineFallback = async () => (await caches.match("/index.html")) ?? (await caches.match("/")) ?? Response.error();
    event.respondWith(fetch(request).catch(offlineFallback));
    return;
  }

  // The QR scanner is not part of the first load. The first tap pays for it once, then it is
  // served from cache like the rest of the shell.
  if (LAZY.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })(),
    );
    return;
  }

  // Shell assets: cache first, refresh in the background. An offline revalidation would be a
  // request the user pays for and that cannot succeed, so it is skipped.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const refresh = () =>
          fetch(request)
            .then(async (response) => {
              if (response.ok) await cache.put(request, response.clone());
              return response;
            })
            .catch(() => null);
        if (cached) {
          if (scope.navigator.onLine) void refresh();
          return cached;
        }
        return (await refresh()) ?? Response.error();
      })(),
    );
  }
});
