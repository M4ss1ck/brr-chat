import { describe, expect, test } from "bun:test";
import { createApp, type ServerApp } from "../src/index.ts";
import {
  RECOVERY_CODE_LENGTH,
  RECOVERY_GROUP_LENGTH,
  formatRecoveryCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from "../src/recovery.ts";

const ORIGIN = "http://chat.local";
const PASSWORD = "password1234";

interface SignUpPayload {
  token: string;
  recoveryCode: string;
  recoveryConfirmed: boolean;
  user: { id: string; username: string };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function signUp(app: ServerApp, username: string, path = "/api/recovery/sign-up"): Promise<SignUpPayload> {
  const res = await app.fetch(
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SignUpPayload;
}

function lastGroup(code: string): string {
  return code.replace(/-/g, "").slice(-RECOVERY_GROUP_LENGTH);
}

async function confirm(app: ServerApp, token: string, code: string): Promise<Response> {
  return app.fetch(
    request("/api/recovery/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ group: lastGroup(code) }),
    }),
  );
}

async function signUpAndConfirm(app: ServerApp, username = "alice"): Promise<SignUpPayload> {
  const body = await signUp(app, username);
  expect((await confirm(app, body.token, body.recoveryCode)).status).toBe(200);
  return body;
}

async function redeem(app: ServerApp, username: string, code: string, ip?: string): Promise<Response> {
  return app.fetch(
    request("/api/recovery/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip ?? "203.0.113.1" },
      body: JSON.stringify({ username, code }),
    }),
    ip,
  );
}

async function syncStatus(app: ServerApp, token: string): Promise<number> {
  const res = await app.fetch(
    request("/sync", {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: `Bearer ${token}` },
      body: new Uint8Array([0x83, 0x01, 0x00, 0x80]),
    }),
  );
  return res.status;
}

async function session(app: ServerApp, token: string): Promise<unknown> {
  const res = await app.fetch(request("/api/auth/get-session", { headers: { Authorization: `Bearer ${token}` } }));
  return res.json();
}

describe("recovery codes (ADR 0006)", () => {
  test("codes are 4×5 Crockford base32, and the parser accepts what a person types", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRecoveryCode();
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
      expect(code).not.toMatch(/[ILOU]/);
      expect(formatRecoveryCode(code)).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    }
    // Lower case, spaces, hyphens and Crockford lookalikes all normalize to the same code.
    expect(normalizeRecoveryCode("abcde-fghij klmno pqrst")).toBe("ABCDEFGH1JK1MN0PQRST");
    expect(normalizeRecoveryCode("o0il1")).toBe("00111");
  });

  test("signup shows the code once, stores only hashes, and does not finish until the last group is typed back", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const body = await signUp(app, "alice");
      expect(body.recoveryConfirmed).toBe(false);
      expect(body.token).toHaveLength(32);

      // The code is shown, in the shape the signup screen displays.
      expect(body.recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);

      // Only hashes of the full code and of its last group reach the disk.
      const row = app.db
        .query("SELECT code_hash, tail_hash, confirmed FROM recovery_codes WHERE user_id = ?")
        .get(body.user.id) as { code_hash: Uint8Array; tail_hash: Uint8Array; confirmed: number } | null;
      expect(row).not.toBeNull();
      expect(row?.confirmed).toBe(0);
      expect(row?.code_hash).toBeInstanceOf(Uint8Array);
      expect(row?.code_hash).toHaveLength(32);
      expect(row?.tail_hash).toHaveLength(32);
      const normalized = normalizeRecoveryCode(body.recoveryCode);
      expect(Buffer.from(row?.code_hash ?? new Uint8Array()).toString("utf8")).not.toContain(normalized);
      expect(Buffer.from(row?.tail_hash ?? new Uint8Array()).toString("utf8")).not.toContain(lastGroup(body.recoveryCode));

      // An unconfirmed account is created but cannot use the app.
      expect(await syncStatus(app, body.token)).toBe(403);

      // If the wrong group comes back, signup still is not finished.
      const wrong = await app.fetch(
        request("/api/recovery/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
          body: JSON.stringify({ group: "00000" }),
        }),
      );
      expect(wrong.status).toBe(400);
      expect(await syncStatus(app, body.token)).toBe(403);

      expect((await confirm(app, body.token, body.recoveryCode)).status).toBe(200);
      expect(await syncStatus(app, body.token)).toBe(200);

      // Nothing hands the code back. Status only says whether it is confirmed.
      const status = await app.fetch(request("/api/recovery/status", { headers: { Authorization: `Bearer ${body.token}` } }));
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as Record<string, unknown>;
      expect(statusBody).toEqual({ confirmed: true });
      expect(JSON.stringify(statusBody)).not.toContain(normalized);
    } finally {
      app.close();
    }
  });

  test("the BetterAuth sign-up route cannot bypass the type-back", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const body = await signUp(app, "alice", "/api/auth/sign-up/email");
      expect(body.recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
      expect(await syncStatus(app, body.token)).toBe(403);
    } finally {
      app.close();
    }
  });

  test("redeem signs in, rotates the code, and revokes every other session", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const signedUp = await signUpAndConfirm(app);

      // Two more sessions from ordinary sign-ins; both must die on redeem.
      const signIn = async (): Promise<string> => {
        const res = await app.fetch(
          request("/api/auth/sign-in/username", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: ORIGIN },
            body: JSON.stringify({ username: "alice", password: PASSWORD }),
          }),
        );
        expect(res.status).toBe(200);
        return ((await res.json()) as { token: string }).token;
      };
      const second = await signIn();
      const third = await signIn();

      const res = await redeem(app, "alice", signedUp.recoveryCode);
      expect(res.status).toBe(200);
      const redeemed = (await res.json()) as SignUpPayload;
      expect(redeemed.token).toHaveLength(32);
      expect(redeemed.token).not.toBe(signedUp.token);
      expect(redeemed.recoveryCode).not.toBe(signedUp.recoveryCode);
      expect(redeemed.user.username).toBe("alice");

      expect(await session(app, signedUp.token)).toBeNull();
      expect(await session(app, second)).toBeNull();
      expect(await session(app, third)).toBeNull();
      expect(await session(app, redeemed.token)).toMatchObject({ user: { username: "alice" } });
      expect(await syncStatus(app, redeemed.token)).toBe(200);

      // The code that was just spent is dead; the rotated one works.
      expect((await redeem(app, "alice", signedUp.recoveryCode)).status).toBe(401);
      expect((await redeem(app, "alice", redeemed.recoveryCode)).status).toBe(200);
    } finally {
      app.close();
    }
  });

  test("regenerate invalidates the old code and needs a session", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const signedUp = await signUpAndConfirm(app);

      const anonymous = await app.fetch(request("/api/recovery/regenerate", { method: "POST" }));
      expect(anonymous.status).toBe(401);

      const res = await app.fetch(
        request("/api/recovery/regenerate", {
          method: "POST",
          headers: { Authorization: `Bearer ${signedUp.token}` },
        }),
      );
      expect(res.status).toBe(200);
      const rotated = (await res.json()) as { recoveryCode: string; recoveryConfirmed: boolean };
      expect(rotated.recoveryCode).not.toBe(signedUp.recoveryCode);
      expect(rotated.recoveryConfirmed).toBe(true);

      expect((await redeem(app, "alice", signedUp.recoveryCode)).status).toBe(401);
      expect((await redeem(app, "alice", rotated.recoveryCode)).status).toBe(200);
    } finally {
      app.close();
    }
  });

  test("a wrong code and an unknown username answer the same way", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const signedUp = await signUpAndConfirm(app);
      const wrong = await redeem(app, "alice", "0000Z-0000Z-0000Z-0000Z", "198.51.100.1");
      const unknown = await redeem(app, "nobody", signedUp.recoveryCode, "198.51.100.2");
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(await wrong.text()).toBe(await unknown.text());
    } finally {
      app.close();
    }
  });

  test("redeem is rate-limited per username", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      recoveryLimits: { windowMs: 60_000, perIp: 100, perUsername: 2 },
    });
    try {
      const signedUp = await signUpAndConfirm(app);
      expect((await redeem(app, "alice", "0000Z-0000Z-0000Z-0000Z", "198.51.100.10")).status).toBe(401);
      expect((await redeem(app, "alice", "0000Z-0000Z-0000Z-0000Z", "198.51.100.11")).status).toBe(401);

      const limited = await redeem(app, "alice", "0000Z-0000Z-0000Z-0000Z", "198.51.100.12");
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

      // A correct code does not get past the gate either.
      expect((await redeem(app, "alice", signedUp.recoveryCode, "198.51.100.13")).status).toBe(429);
    } finally {
      app.close();
    }
  });

  test("redeem is rate-limited per IP, across usernames", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      recoveryLimits: { windowMs: 60_000, perIp: 2, perUsername: 100 },
    });
    try {
      for (const username of ["alice", "bob"]) {
        expect((await redeem(app, username, "0000Z-0000Z-0000Z-0000Z", "203.0.113.50")).status).toBe(401);
      }
      const limited = await redeem(app, "carol", "0000Z-0000Z-0000Z-0000Z", "203.0.113.50");
      expect(limited.status).toBe(429);

      // Another address has its own budget.
      expect((await redeem(app, "dave", "0000Z-0000Z-0000Z-0000Z", "203.0.113.51")).status).toBe(401);
    } finally {
      app.close();
    }
  });
});
