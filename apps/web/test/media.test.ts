// Issue #15 client half: the placeholder is inline, uploads are one multipart request, and
// the image bytes are fetched only after a tap.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { rgbaToThumbHash } from "thumbhash";
import { closeStore, getMediaBytes, putMediaBytes } from "../src/store.ts";
import {
  MediaUploadError,
  clearMediaCache,
  fitWithin,
  mediaView,
  placeholderDataUrl,
  uploadImage,
  type PreparedImage,
} from "../src/media.ts";

function thumbhash(): Uint8Array {
  const width = 4;
  const height = 2;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = i * 17;
    rgba[i * 4 + 1] = 255 - i * 11;
    rgba[i * 4 + 2] = i * 7;
    rgba[i * 4 + 3] = 255;
  }
  return rgbaToThumbHash(width, height, rgba);
}

function prepared(): PreparedImage {
  return {
    preview: { blob: new Blob([new Uint8Array(100)], { type: "image/webp" }), width: 320, height: 200 },
    full: { blob: new Blob([new Uint8Array(200)], { type: "image/webp" }), width: 1280, height: 800 },
    thumbhash: thumbhash(),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for the image view");
}

describe("resizing math", () => {
  test("fits inside the longest edge without enlarging", () => {
    expect(fitWithin(1600, 900, 1280)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(900, 1600, 320)).toEqual({ width: 180, height: 320 });
    expect(fitWithin(200, 100, 320)).toEqual({ width: 200, height: 100 });
    expect(fitWithin(1, 4000, 320)).toEqual({ width: 1, height: 320 });
    expect(() => fitWithin(0, 10, 320)).toThrow(RangeError);
  });
});

describe("ThumbHash placeholder", () => {
  test("decodes to an inline data URL, never a network path", () => {
    const hash = thumbhash();
    expect(hash.byteLength).toBeGreaterThanOrEqual(19);
    expect(hash.byteLength).toBeLessThanOrEqual(32);

    const url = placeholderDataUrl({ thumbhash: hash });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url).not.toContain("/m/");
  });

  test("an absent or corrupt placeholder is empty, not an exception", () => {
    expect(placeholderDataUrl({ thumbhash: new Uint8Array() })).toBe("");
    expect(placeholderDataUrl({ thumbhash: new Uint8Array([1, 2, 3]) })).toBe("");
  });
});

describe("upload", () => {
  test("sends both variants in one multipart request and returns the media id", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return Response.json({ id: 42, w: 1280, h: 800, bytes: 300 }, { status: 201 });
    }) as unknown as typeof fetch;

    const result = await uploadImage("http://chat.local", "t".repeat(32), prepared(), fakeFetch);
    expect(result).toEqual({ id: 42, w: 1280, h: 800, bytes: 300 });
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe("http://chat.local/m");
    expect(seen!.init.method).toBe("POST");
    const headers = new Headers(seen!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${"t".repeat(32)}`);
    expect(headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const body = seen!.init.body as Blob;
    expect(body).toBeInstanceOf(Blob);
    expect(body.size).toBeGreaterThan(300);
    const text = await body.text();
    expect(text).toContain('name="preview"; filename="preview.webp"');
    expect(text).toContain('name="full"; filename="full.webp"');
    expect(text).toContain("Content-Type: image/webp");
  });

  test("a server refusal becomes a clear MediaUploadError", async () => {
    const quota = (async () =>
      Response.json({ code: "quota", error: "this server's media storage is full" }, { status: 507 })) as unknown as typeof fetch;
    const error = await uploadImage("http://chat.local", "t".repeat(32), prepared(), quota).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MediaUploadError);
    expect(error).toMatchObject({ status: 507, code: "quota" });
    expect((error as Error).message).toBe("This server has no room for more images right now.");

    const junk = (async () => Response.json({ id: "nope" }, { status: 201 })) as unknown as typeof fetch;
    const bad = await uploadImage("http://chat.local", "t".repeat(32), prepared(), junk).catch((err: unknown) => err);
    expect(bad).toMatchObject({ code: "bad_response" });
  });

  test.each([
    ["too_large", 413, "too large to send"],
    ["not_webp", 415, "not an image this app can send"],
    ["bad_body", 415, "not an image this app can send"],
    ["dimensions", 422, "too large in pixels"],
    ["missing_variant", 400, "could not be prepared"],
    ["unauthorized", 401, "Sign in first"],
  ])("the %s refusal explains itself", async (code, status, message) => {
    const fake = (async () => Response.json({ code, error: "server text" }, { status })) as unknown as typeof fetch;
    const error = await uploadImage("http://chat.local", "t".repeat(32), prepared(), fake).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MediaUploadError);
    expect((error as Error).message).toContain(message);
  });
});

// ---- small DOM shim, only what mediaView touches ----

interface FakeElement {
  tagName: string;
  children: FakeElement[];
  className: string;
  type: string;
  src: string;
  alt: string;
  width: number;
  height: number;
  clientWidth: number;
  hidden: boolean;
  style: Record<string, string>;
  attrs: Record<string, string>;
  listeners: Record<string, (() => void)[]>;
  classList: { add(...names: string[]): void; remove(...names: string[]): void; contains(name: string): boolean };
  append(...nodes: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
}

function fakeElement(tagName: string): FakeElement {
  const classes = new Set<string>();
  const element: FakeElement = {
    tagName,
    children: [],
    className: "",
    type: "",
    src: "",
    alt: "",
    width: 0,
    height: 0,
    clientWidth: 0,
    hidden: false,
    style: {},
    attrs: {},
    listeners: {},
    classList: {
      add(...names) {
        for (const name of names) classes.add(name);
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    append(...nodes) {
      element.children.push(...nodes);
    },
    setAttribute(name, value) {
      element.attrs[name] = value;
    },
    getAttribute(name) {
      return element.attrs[name] ?? null;
    },
    addEventListener(type, listener) {
      (element.listeners[type] ??= []).push(listener);
    },
  };
  return element;
}

describe("tap to load", () => {
  const originalDocument = globalThis.document;

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  afterAll(() => {
    globalThis.document = originalDocument;
  });

  function withFakeDocument(): void {
    globalThis.document = { createElement: fakeElement } as unknown as Document;
  }

  test("nothing is fetched until the tap, then the full variant arrives with the token", async () => {
    withFakeDocument();
    const calls: { url: string; headers: Headers }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/webp" } });
    }) as unknown as typeof fetch;

    const created: Blob[] = [];
    const view = mediaView(
      { id: 9, w: 1280, h: 800, thumbhash: thumbhash() },
      {
        base: "http://chat.local",
        token: "s".repeat(32),
        fetchImpl: fakeFetch,
        createObjectUrl: (blob) => {
          created.push(blob);
          return "blob:preview";
        },
        revokeObjectUrl: () => {},
      },
    );
    const fakeView = view as unknown as FakeElement;
    const image = fakeView.children[0]!;
    fakeView.clientWidth = 340;

    expect(calls).toHaveLength(0);
    expect(image.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(fakeView.style.aspectRatio).toBe("1280 / 800");

    fakeView.listeners.click![0]!();
    await until(() => image.src === "blob:preview");

    expect(calls).toHaveLength(1);
    // The feed asks for its rendered width; the server snaps 340 to the 320 preview.
    expect(calls[0]!.url).toBe("http://chat.local/m/9?w=340");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${"s".repeat(32)}`);
    expect(created).toHaveLength(1);
    expect(fakeView.classList.contains("loaded")).toBe(true);

    // A loaded image never fetches again.
    fakeView.listeners.click![0]!();
    expect(calls).toHaveLength(1);
  });

  test("a failed tap says so and a second tap retries", async () => {
    withFakeDocument();
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;

    const view = mediaView(
      { id: 10, w: 320, h: 200, thumbhash: new Uint8Array() },
      { base: "http://chat.local", token: "s".repeat(32), fetchImpl: fakeFetch },
    );
    const fakeView = view as unknown as FakeElement;
    const image = fakeView.children[0]!;
    expect(image.hidden).toBe(true); // no placeholder bytes, and no src to fetch

    fakeView.listeners.click![0]!();
    await until(() => fakeView.classList.contains("failed"));
    expect(calls).toBe(1);
    expect(fakeView.getAttribute("aria-label")).toContain("retry");

    fakeView.listeners.click![0]!();
    await until(() => calls === 2);
  });

  test("a loaded image survives a re-render without a second download", async () => {
    withFakeDocument();
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    }) as unknown as typeof fetch;
    const options = {
      base: "http://chat.local",
      token: "s".repeat(32),
      fetchImpl: fakeFetch,
      createObjectUrl: () => "blob:cached-11",
      revokeObjectUrl: () => {},
    };
    const media = { id: 11, w: 1280, h: 800, thumbhash: thumbhash() };

    const first = mediaView(media, options) as unknown as FakeElement;
    first.listeners.click![0]!();
    await until(() => first.classList.contains("loaded"));
    expect(calls).toBe(1);

    // The next sync replaces the whole list. The cached image is on screen at once.
    const second = mediaView(media, options) as unknown as FakeElement;
    expect(second.children[0]!.src).toBe("blob:cached-11");
    expect(second.classList.contains("loaded")).toBe(true);
    second.listeners.click![0]!();
    expect(calls).toBe(1);

    // Signing out drops it, so a new view starts from the placeholder again.
    clearMediaCache();
    const third = mediaView(media, options) as unknown as FakeElement;
    expect(third.children[0]!.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(third.classList.contains("loaded")).toBe(false);
  });

  test("a durable hit loads without a request, and a network tap leaves bytes for next time", async () => {
    withFakeDocument();
    const originalIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
    const owner = "alice\u0000http://chat.local";
    try {
      await putMediaBytes(owner, 12, new Uint8Array([7, 8, 9]), 1);
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as unknown as typeof fetch;

      const cachedView = mediaView(
        { id: 12, w: 320, h: 200, thumbhash: thumbhash() },
        {
          base: "http://chat.local",
          token: "s".repeat(32),
          cacheKey: owner,
          fetchImpl,
          createObjectUrl: () => "blob:durable",
          revokeObjectUrl: () => {},
        },
      ) as unknown as FakeElement;
      cachedView.listeners.click![0]!();
      await until(() => cachedView.classList.contains("loaded"));
      expect(calls).toBe(0);
      expect(cachedView.children[0]!.src).toBe("blob:durable");

      const networkView = mediaView(
        { id: 13, w: 320, h: 200, thumbhash: thumbhash() },
        {
          base: "http://chat.local",
          token: "s".repeat(32),
          cacheKey: owner,
          fetchImpl,
          createObjectUrl: () => "blob:network",
          revokeObjectUrl: () => {},
        },
      ) as unknown as FakeElement;
      networkView.listeners.click![0]!();
      await until(() => networkView.classList.contains("loaded"));
      expect(calls).toBe(1);

      // The write is best effort and follows the paint; give it a moment to land.
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await getMediaBytes(owner, 13)) !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(Array.from((await getMediaBytes(owner, 13)) ?? [])).toEqual([1, 2, 3]);
    } finally {
      await closeStore();
      globalThis.indexedDB = originalIndexedDB;
    }
  });
});
