// Service worker for the PWA shell. Data saving is the point (docs/PROTOCOL.md): the shell is
// precached once and served from cache afterwards, while auth and /sync always hit the network.
// Only the DOM lib is declared for the shell (ADR 0014), so the service worker scope is
// narrowed by hand instead of pulling in the WebWorker lib.

const CACHE = "brr-shell-v1";
const SHELL: readonly string[] = ["/", "/index.html", "/app.js", "/sw.js", "/manifest.webmanifest", "/icon.svg"];
/** Never cached: credentials, sync payloads and media are always fresh from the server. */
const NEVER_CACHE: readonly string[] = ["/api/auth/", "/sync", "/m/"];

interface ServiceWorkerScope {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}

interface FetchHandled {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

/** The lifecycle events of a service worker; not in the DOM lib, so declared by hand. */
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

const scope = self as unknown as ServiceWorkerScope;

function isShellPath(pathname: string): boolean {
  return SHELL.includes(pathname);
}

function isNeverCached(pathname: string): boolean {
  return NEVER_CACHE.some((prefix) => pathname.startsWith(prefix));
}

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

self.addEventListener("install", (event: Event) => {
  (event as ExtendableEvent).waitUntil(precache().then(() => scope.skipWaiting()));
});

self.addEventListener("activate", (event: Event) => {
  (event as ExtendableEvent).waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => scope.clients.claim()),
  );
});

self.addEventListener("fetch", (raw: Event) => {
  const event = raw as unknown as FetchHandled;
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isNeverCached(url.pathname)) return;

  // Navigations: network first, so a new shell shows up as soon as it is deployed.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/index.html")) ?? Response.error()),
    );
    return;
  }

  // Shell assets: cache first, refresh in the background. Never re-downloaded on every load.
  if (isShellPath(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const fresh = fetch(request)
          .then(async (response) => {
            if (response.ok) await cache.put(request, response.clone());
            return response;
          })
          .catch(() => null);
        if (cached) {
          void fresh;
          return cached;
        }
        return (await fresh) ?? Response.error();
      })(),
    );
  }
});
