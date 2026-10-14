import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import { createApp } from "../src/index.ts";
import { SHELL_FILES, SHELL_ROUTES } from "../src/pwa-assets.generated.ts";
import { shellPaths } from "../src/pwa.ts";

const BR = { "Accept-Encoding": "br" };

/** app.fetch() is the app handler, not a network fetch: no automatic decompression. */
/** The exact bytes the shell serves for one built file. */
function shellBody(file: string): string {
  const asset = SHELL_FILES[file];
  if (!asset) throw new Error(`no embedded shell asset named ${file}`);
  return asset.body;
}

/** app.fetch() is the app handler, not a network fetch: no automatic decompression. */
async function bodyText(res: Response): Promise<string> {
  const body = new Uint8Array(await res.arrayBuffer());
  const decoded = res.headers.get("content-encoding") === "br" ? new Uint8Array(brotliDecompressSync(body)) : body;
  return Buffer.from(decoded).toString("utf8");
}

async function shellApp() {
  return createApp({ dbPath: ":memory:", host: "127.0.0.1" });
}

describe("embedded PWA shell", () => {
  test("serves the shell routes and 404s anything else", async () => {
    const app = await shellApp();
    try {
      const index = await app.fetch(new Request("http://127.0.0.1/", { headers: BR }));
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await bodyText(index);
      expect(html).toContain('<script type="module" src="/app.js"></script>');
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
      expect(html).toContain('id="sign-up"');
      expect(html).toContain('id="empty"');

      expect(await bodyText(await app.fetch(new Request("http://127.0.0.1/index.html", { headers: BR })))).toBe(html);

      const missing = await app.fetch(new Request("http://127.0.0.1/nope", { headers: BR }));
      expect(missing.status).toBe(404);
    } finally {
      app.close();
    }
  });

  test("serves every shell route with its own content type and cache policy", async () => {
    const app = await shellApp();
    try {
      const expected: Record<string, { contentType: string; cacheControl: string }> = {
        "/": { contentType: "text/html; charset=utf-8", cacheControl: "no-cache" },
        "/index.html": { contentType: "text/html; charset=utf-8", cacheControl: "no-cache" },
        "/app.js": { contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
        "/sw.js": { contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
        "/manifest.webmanifest": { contentType: "application/manifest+json", cacheControl: "max-age=3600" },
        "/icon.svg": { contentType: "image/svg+xml", cacheControl: "max-age=86400" },
      };

      expect(shellPaths()).toEqual(Object.keys(expected));
      expect(Object.keys(SHELL_ROUTES)).toEqual(Object.keys(expected));

      for (const [route, want] of Object.entries(expected)) {
        const res = await app.fetch(new Request(`http://127.0.0.1${route}`, { headers: BR }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(want.contentType);
        expect(res.headers.get("cache-control")).toBe(want.cacheControl);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("vary")).toBe("Accept-Encoding");
        expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
      }
    } finally {
      app.close();
    }
  });

  test("compresses the shell with brotli when the client accepts it, raw when it does not", async () => {
    const app = await shellApp();
    try {
      const compressed = await app.fetch(new Request("http://127.0.0.1/app.js", { headers: BR }));
      expect(compressed.headers.get("content-encoding")).toBe("br");
      const compressedBody = new Uint8Array(await compressed.arrayBuffer());

      const plain = await app.fetch(new Request("http://127.0.0.1/app.js"));
      expect(plain.headers.get("content-encoding")).toBeNull();
      const plainBody = new Uint8Array(await plain.arrayBuffer());
      expect(Buffer.from(plainBody).toString("utf8")).toBe(shellBody("app.js"));

      expect(compressedBody.byteLength).toBeLessThan(plainBody.byteLength);
      expect(new Uint8Array(brotliDecompressSync(compressedBody))).toEqual(plainBody);

      // The document on the wire is the same document the budget test gates.
      const document = await app.fetch(new Request("http://127.0.0.1/", { headers: BR }));
      const documentBody = new Uint8Array(await document.arrayBuffer());
      expect(documentBody.byteLength).toBeLessThan(Buffer.byteLength(shellBody("index.html"), "utf8"));
      console.log(
        `app shell on the wire (brotli): index.html ${documentBody.byteLength} B, app.js ${compressedBody.byteLength} B, app.js raw ${plainBody.byteLength} B`,
      );
    } finally {
      app.close();
    }
  });

  test("the app bundle is a module and the service worker precaches every shell route", async () => {
    const app = await shellApp();
    try {
      const bundle = (await bodyText(await app.fetch(new Request("http://127.0.0.1/app.js")))).trim();
      expect(bundle.length).toBeGreaterThan(0);
      // No module specifier survives the bundle: the protocol and the client are one file.
      expect(bundle).not.toContain('from "@brr-chat/protocol"');

      const sw = await bodyText(await app.fetch(new Request("http://127.0.0.1/sw.js")));
      for (const route of shellPaths()) {
        // "/" and "/app.js" are listed literally in the sw bundle; the rest must appear too.
        expect(sw).toContain(JSON.stringify(route));
      }
    } finally {
      app.close();
    }
  });

  test("HEAD returns headers without a body, POST is not allowed", async () => {
    const app = await shellApp();
    try {
      const head = await app.fetch(new Request("http://127.0.0.1/", { method: "HEAD", headers: BR }));
      expect(head.status).toBe(200);
      expect(head.headers.get("content-encoding")).toBe("br");
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      const get = await app.fetch(new Request("http://127.0.0.1/", { headers: BR }));
      expect(head.headers.get("content-length")).toBe(String((await get.arrayBuffer()).byteLength));

      const post = await app.fetch(new Request("http://127.0.0.1/app.js", { method: "POST" }));
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      app.close();
    }
  });

  test("the API routes keep working next to the shell", async () => {
    const app = await shellApp();
    try {
      const signUp = await app.fetch(
        new Request("http://127.0.0.1/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
      );
      expect(signUp.status).toBe(200);
      const { token } = (await signUp.json()) as { token: string };
      expect(token).toHaveLength(32);

      const shell = await app.fetch(new Request("http://127.0.0.1/", { headers: BR }));
      expect(shell.status).toBe(200);

      const signIn = await app.fetch(
        new Request("http://127.0.0.1/api/auth/sign-in/username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
      );
      expect(signIn.status).toBe(200);
    } finally {
      app.close();
    }
  });
});
