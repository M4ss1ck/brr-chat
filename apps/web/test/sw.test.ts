// The service worker is the one part of the shell that lives in no request: install precaches,
// shell assets are served from cache with a background refresh, and /api/auth, /sync and /m/
// never touch the cache. Run against the real src/sw.ts with a fake service worker scope,
// so the strategy is covered without a browser.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

interface Handled {
  request: { url: string; method: string; mode: string };
  served: Promise<unknown> | null;
  respondWith(response: unknown): void;
  waitUntil(promise: Promise<unknown>): void;
}

/** What the service worker passes around: a path or a request object. */
type MaybeRequest = string | { url: string };

interface FakeResponse {
  ok: boolean;
  clone(): FakeResponse;
  text(): Promise<string>;
}

function keyOf(request: MaybeRequest): string {
  const url = typeof request === "string" ? request : request.url;
  // CacheStorage resolves a relative path against the service worker's own origin.
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${scope.location.origin}${url}`;
}

class FakeCache {
  store = new Map<string, FakeResponse>();

  async add(request: MaybeRequest): Promise<void> {
    this.store.set(keyOf(request), await network(keyOf(request)));
  }

  async match(request: MaybeRequest): Promise<FakeResponse | undefined> {
    return this.store.get(keyOf(request));
  }

  async put(request: MaybeRequest, response: FakeResponse): Promise<void> {
    this.store.set(keyOf(request), response.clone());
  }
}

const listeners = new Map<string, ((event: unknown) => void)[]>();
const cacheStore = new Map<string, FakeCache>();
let requested: string[] = [];
/** Paths the fake network can reach; anything else fails like a dropped connection. */
let online: string[] = [];
/** Bumped to simulate a new shell being deployed. */
let generation = 1;

function fakeResponse(body: string): FakeResponse {
  return {
    ok: true,
    clone: () => fakeResponse(body),
    text: async () => body,
  };
}

async function network(request: MaybeRequest): Promise<FakeResponse> {
  const url = keyOf(request);
  requested.push(url);
  if (!online.includes(url)) throw new Error(`offline: ${url}`);
  return fakeResponse(`${url}:net?v${generation}`);
}

const scope = {
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = listeners.get(type) ?? [];
    list.push(listener);
    listeners.set(type, list);
  },
  skipWaiting: async () => undefined,
  clients: { claim: async () => undefined },
  location: { origin: "http://chat.local" },
  navigator: { onLine: true },
};

function emit(type: string, event: unknown): void {
  for (const listener of listeners.get(type) ?? []) listener(event);
}

function lifecycleEvent(type: "install" | "activate"): { waited: Promise<unknown> | null; waitUntil(p: Promise<unknown>): void } {
  return {
    waited: null,
    waitUntil(p: Promise<unknown>) {
      this.waited = p;
    },
  };
}

function fetchEvent(url: string, mode = "no-cors"): Handled {
  const event: Handled = {
    request: { url, method: "GET", mode },
    served: null,
    respondWith(response: unknown) {
      event.served = Promise.resolve(response);
    },
    waitUntil() {},
  };
  return event;
}

const SHELL = ["/", "/index.html", "/app.js", "/sw.js", "/manifest.webmanifest", "/icon.svg"];
/** The built worker, not the source: what ships is what is covered here. */
const SW_BUNDLE = resolve(import.meta.dir, "..", "dist", "sw.js");

async function openShellCache(): Promise<FakeCache> {
  const cache = cacheStore.get("brr-shell-v1");
  if (!cache) throw new Error("the service worker never opened its cache");
  return cache;
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("service worker (the built shell worker)", () => {
  beforeAll(async () => {
    globalThis.self = scope as unknown as Window & typeof globalThis;
    globalThis.caches = {
      async open(name: string) {
        if (!cacheStore.has(name)) cacheStore.set(name, new FakeCache());
        return cacheStore.get(name) as FakeCache;
      },
      // CacheStorage has a top-level match too; sw.ts uses it for the navigation fallback.
      async match(request: MaybeRequest) {
        for (const cache of cacheStore.values()) {
          const hit = await cache.match(request);
          if (hit) return hit;
        }
        return undefined;
      },
      async keys() {
        return [...cacheStore.keys()];
      },
      async delete(name: string) {
        return cacheStore.delete(name);
      },
    } as unknown as CacheStorage;
    (globalThis as unknown as { fetch: unknown }).fetch = network;
    const built = Bun.spawnSync({ cmd: [process.execPath, "scripts/build.ts"], cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`apps/web build failed:\n${built.stderr.toString()}`);
    await import(SW_BUNDLE);
    online = SHELL.map((path) => `http://chat.local${path}`);
  });

  beforeEach(async () => {
    cacheStore.clear();
    requested = [];
    online = SHELL.map((path) => `http://chat.local${path}`);
    await reinstalled();
  });

  /** Fresh cache: install and activate again on the new store. */
  async function reinstalled(): Promise<void> {
    const install = lifecycleEvent("install");
    emit("install", install);
    await install.waited;
    const activate = lifecycleEvent("activate");
    emit("activate", activate);
    await activate.waited;
    await settled();
  }

  test("install precaches the whole shell", async () => {
    const cache = await openShellCache();
    for (const path of SHELL) {
      expect(cache.store.has(`http://chat.local${path}`)).toBe(true);
    }
    expect(requested).toEqual(SHELL.map((path) => `http://chat.local${path}`));
  });

  test("a shell asset is served from cache first, then refreshed behind the user", async () => {
    const cachedBody = await (await openShellCache()).store.get("http://chat.local/app.js")!.text();
    expect(cachedBody).toBe("http://chat.local/app.js:net?v1");

    // A new shell is deployed: the request is answered from cache, so nothing waits.
    generation = 2;
    requested = [];
    const event = fetchEvent("http://chat.local/app.js");
    emit("fetch", event);
    const served = (await event.served) as FakeResponse;
    expect(await served.text()).toBe("http://chat.local/app.js:net?v1");

    // The background refresh pulls the new bundle and writes it through.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const refreshed = (await openShellCache()).store.get("http://chat.local/app.js");
    await expect(refreshed?.text()).resolves.toBe("http://chat.local/app.js:net?v2");
  });

  test("offline: the cached copy answers and nothing is requested", async () => {
    // The device is known to be offline, so a revalidation attempt must not be made.
    scope.navigator.onLine = false;
    online = [];
    requested = [];
    try {
      const event = fetchEvent("http://chat.local/app.js");
      emit("fetch", event);
      const served = (await event.served) as FakeResponse;
      expect(await served.text()).toBe(`http://chat.local/app.js:net?v${generation}`);
      expect(requested).toEqual([]);
    } finally {
      scope.navigator.onLine = true;
    }
  });

  test("auth, sync and media never touch the cache", async () => {
    for (const path of ["/api/auth/sign-in/username", "/sync", "/m/42?w=64"]) {
      const event = fetchEvent(`http://chat.local${path}`);
      emit("fetch", event);
      expect(event.served).toBeNull();
      expect(requested).not.toContain(`http://chat.local${path}`);
    }
    const cache = await openShellCache();
    for (const path of ["/sync", "/api/auth/sign-in/username", "/m/42?w=64"]) {
      expect(cache.store.has(`http://chat.local${path}`)).toBe(false);
    }
  });

  test("a navigation goes to the network first and falls back to the cached document", async () => {
    online = [];
    const event = fetchEvent("http://chat.local/", "navigate");
    emit("fetch", event);
    const fallback = (await event.served) as FakeResponse;
    expect(await fallback.text()).toBe(`http://chat.local/index.html:net?v${generation}`);
    expect((await openShellCache()).store.has("http://chat.local/index.html")).toBe(true);
  });
});
