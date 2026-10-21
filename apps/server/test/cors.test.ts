// One client, several servers (#18, ADR 0020): the app is served by one origin and calls the
// others directly, so every API response must be usable cross-origin. Auth is a bare bearer
// token, not a cookie, and the server never hands out a session cookie, so `*` grants no
// ambient authority.
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, encodeSyncRequest } from "@brr-chat/protocol";
import { createApp, type ServerApp } from "../src/index.ts";

const CLIENT_ORIGIN = "http://client.example";

async function newApp(): Promise<ServerApp> {
  return createApp({ dbPath: ":memory:", host: "chat.local", limits: { signupsPerHour: 100 } });
}

function crossOrigin(url: string, init: RequestInit): Request {
  return new Request(`http://chat.local${url}`, {
    ...init,
    headers: { Origin: CLIENT_ORIGIN, ...(init.headers as Record<string, string> | undefined) },
  });
}

describe("cross-origin client", () => {
  test("a preflight for /sync is answered without a session", async () => {
    const app = await newApp();
    try {
      const res = await app.fetch(
        new Request("http://chat.local/sync", {
          method: "OPTIONS",
          headers: {
            Origin: CLIENT_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
          },
        }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
      expect(res.headers.get("access-control-max-age")).toBe("86400");
    } finally {
      app.close();
    }
  });

  test("sign-up from another origin works, carries CORS, and sets no cookie", async () => {
    const app = await newApp();
    try {
      const res = await app.fetch(
        crossOrigin("/api/recovery/sign-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      // A cookie would give a foreign origin ambient authority; the client uses the token.
      expect(res.headers.get("set-cookie")).toBeNull();
      const body = (await res.json()) as { token?: string; recoveryCode?: string };
      expect(body.token).toBeString();
      expect(body.recoveryCode).toBeString();
    } finally {
      app.close();
    }
  });

  test("sign-in from another origin is not refused as an untrusted origin", async () => {
    const app = await newApp();
    try {
      const signup = await app.fetch(
        crossOrigin("/api/recovery/sign-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "bob", password: "password1234" }),
        }),
      );
      expect(signup.status).toBe(200);

      const res = await app.fetch(
        crossOrigin("/api/auth/sign-in/username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "bob", password: "password1234" }),
        }),
      );
      // 401 would mean the credentials were wrong; 403 here used to mean "Invalid origin".
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("set-cookie")).toBeNull();
      const body = (await res.json()) as { token?: string };
      expect(body.token).toBeString();
    } finally {
      app.close();
    }
  });

  test("a cross-origin /sync without a token is a 401 the browser can read", async () => {
    const app = await newApp();
    try {
      const res = await app.fetch(
        crossOrigin("/sync", {
          method: "POST",
          headers: { "Content-Type": "application/cbor" },
          body: encodeSyncRequest({ v: PROTOCOL_VERSION, cursor: 0, outbox: [] }),
        }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      app.close();
    }
  });

  test("a same-origin response carries no CORS bytes, because they would be pure cost", async () => {
    const app = await newApp();
    try {
      const res = await app.fetch(new Request("http://chat.local/api/server/registration"));
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      app.close();
    }
  });

  test("the public registration state is readable cross-origin before any sign-in", async () => {
    const app = await newApp();
    try {
      const res = await app.fetch(
        new Request("http://chat.local/api/server/registration", { headers: { Origin: CLIENT_ORIGIN } }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      app.close();
    }
  });
});
