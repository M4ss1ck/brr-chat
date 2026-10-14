import { describe, expect, test } from "bun:test";
import { createApp } from "../src/index.ts";
import { shellPaths } from "../src/pwa.ts";

async function shellApp() {
  return createApp({ dbPath: ":memory:", host: "127.0.0.1" });
}

describe("embedded PWA shell", () => {
  test("serves the shell routes and 404s anything else", async () => {
    const app = await shellApp();
    try {
      const index = await app.fetch(new Request("http://127.0.0.1/"));
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await index.text();
      expect(html).toContain('<script type="module" src="/app.js"></script>');
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
      expect(html).toContain('id="sign-up"');
      expect(html).toContain('id="empty"');

      expect(await (await app.fetch(new Request("http://127.0.0.1/index.html"))).text()).toBe(html);

      const missing = await app.fetch(new Request("http://127.0.0.1/nope"));
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

      for (const [route, want] of Object.entries(expected)) {
        const res = await app.fetch(new Request(`http://127.0.0.1${route}`));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(want.contentType);
        expect(res.headers.get("cache-control")).toBe(want.cacheControl);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(await res.text(), "utf8")));
      }
    } finally {
      app.close();
    }
  });

  test("the app bundle is a module, the service worker precaches the shell", async () => {
    const app = await shellApp();
    try {
      const js = await (await app.fetch(new Request("http://127.0.0.1/app.js"))).text();
      expect(js.length).toBeGreaterThan(0);
      expect(js).not.toContain("from \"@brr-chat/protocol\"");
      const sw = await (await app.fetch(new Request("http://127.0.0.1/sw.js"))).text();
      expect(sw).toContain("/app.js");
      expect(sw).toContain("/manifest.webmanifest");
    } finally {
      app.close();
    }
  });

  test("HEAD returns headers without a body, POST is not allowed", async () => {
    const app = await shellApp();
    try {
      const head = await app.fetch(new Request("http://127.0.0.1/", { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(await (await app.fetch(new Request("http://127.0.0.1/"))).text(), "utf8")));

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

      const shell = await app.fetch(new Request("http://127.0.0.1/"));
      expect(shell.status).toBe(200);

      const tooOld = await app.fetch(
        new Request("http://127.0.0.1/api/auth/sign-in/username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
      );
      expect(tooOld.status).toBe(200);
    } finally {
      app.close();
    }
  });
});
