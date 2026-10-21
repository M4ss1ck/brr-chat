// The client half of passkeys (#19): the network contract around the browser ceremony. The
// ceremony itself is injected, so this test runs without a browser; the server test proves
// the WebAuthn cryptography. Together they cover the two halves a real browser joins.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { registerPasskey, signInWithPasskey, type PasskeyCeremony } from "../src/auth.ts";
import { closeStore, getSession, setSession } from "../src/store.ts";

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let base = "";
const seen: Seen[] = [];
let signInStatus = 200;
let signInBody: unknown = {
  session: { token: "0123456789abcdef0123456789abcdef" },
  user: { username: "alice" },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      seen.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body });
      switch (url.pathname) {
        case "/api/auth/passkey/generate-register-options":
          return json(200, { challenge: "registration-challenge", rp: { id: "127.0.0.1", name: "brr chat" }, user: { id: "u1", name: "alice", displayName: "alice" } });
        case "/api/auth/passkey/verify-registration":
          return json(200, { id: "credential-id" });
        case "/api/auth/passkey/generate-authenticate-options":
          return json(200, { challenge: "sign-in-challenge", rpId: "127.0.0.1" });
        case "/api/auth/passkey/verify-authentication":
          return json(signInStatus, signInBody);
        default:
          return json(404, {});
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

const originalIndexedDB = globalThis.indexedDB;

afterAll(() => {
  globalThis.indexedDB = originalIndexedDB;
});

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  seen.length = 0;
  signInStatus = 200;
  signInBody = {
    session: { token: "0123456789abcdef0123456789abcdef" },
    user: { username: "alice" },
  };
});

afterEach(async () => {
  await closeStore();
});

const ceremony: PasskeyCeremony = {
  async createCredential(options) {
    expect(options).toMatchObject({ challenge: "registration-challenge", user: { name: "alice" } });
    return {
      id: "credential-id",
      rawId: "credential-id",
      type: "public-key",
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: "client-data", attestationObject: "attestation" },
    };
  },
  async getCredential(options) {
    expect(options).toMatchObject({ challenge: "sign-in-challenge" });
    return {
      id: "credential-id",
      rawId: "credential-id",
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: "client-data", authenticatorData: "auth-data", signature: "signature" },
    };
  },
};

describe("passkey client (#19)", () => {
  test("registration sends the session bearer and the attested response", async () => {
    await setSession(base, { token: "session-token", username: "alice" });

    await registerPasskey(base, ceremony);

    expect(seen.map((row) => row.path)).toEqual([
      "/api/auth/passkey/generate-register-options",
      "/api/auth/passkey/verify-registration",
    ]);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.authorization).toBe("Bearer session-token");
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.authorization).toBe("Bearer session-token");
    // The ceremony's extension results are not part of the WebAuthn response the server checks.
    expect(seen[1]?.body).toMatchObject({
      name: "Passkey",
      response: { id: "credential-id", response: { attestationObject: "attestation" } },
    });
    expect(JSON.stringify(seen[1]?.body)).not.toContain("credProps");
  });

  test("sign in with a passkey stores the nested session token, not a cookie", async () => {
    const account = await signInWithPasskey(base, ceremony);

    expect(seen.map((row) => row.path)).toEqual([
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/passkey/verify-authentication",
      // Whether a half-finished signup still needs its recovery-code type-back.
      "/api/recovery/status",
    ]);
    // The authenticator chooses the account; neither passkey request carries a bearer token.
    expect(seen[0]?.authorization).toBeNull();
    expect(seen[1]?.authorization).toBeNull();
    expect(seen[2]?.authorization).toBe("Bearer 0123456789abcdef0123456789abcdef");
    expect(seen[1]?.body).toMatchObject({ response: { id: "credential-id", response: { signature: "signature" } } });

    expect(account).toEqual({
      server: base,
      token: "0123456789abcdef0123456789abcdef",
      username: "alice",
    });
    expect(await getSession(base)).toEqual({ token: account.token, username: "alice" });
  });

  test("a refused assertion surfaces the server's message and stores nothing", async () => {
    signInStatus = 401;
    signInBody = { code: "AUTHENTICATION_FAILED", message: "Authentication failed" };

    await expect(signInWithPasskey(base, ceremony)).rejects.toThrow("Authentication failed");
    expect(await getSession(base)).toBeNull();
  });
});
