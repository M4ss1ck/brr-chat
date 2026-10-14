import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, headCursor } from "../src/index.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "brr-chat-auth-db-"));
}

describe("Slice 1: SQLite DB + BetterAuth", () => {
  test("creates new SQLite DB file with mode 0600 (ADR 0007)", async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, "nested", "chat.db");
      const app = await createApp({ dbPath, host: "chat.local" });
      try {
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      } finally {
        app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enforces mode 0600 even if DB file was pre-created with 0644 (ADR 0007)", async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, "precreated.db");
      writeFileSync(dbPath, "");
      chmodSync(dbPath, 0o644);
      expect(statSync(dbPath).mode & 0o777).toBe(0o644);

      const app = await createApp({ dbPath, host: "chat.local" });
      try {
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      } finally {
        app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the events table with the expected schema", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const cols = app.db
        .query("PRAGMA table_info(events)")
        .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

      expect(cols.map((c) => ({ name: c.name, type: c.type.toUpperCase(), notnull: c.notnull, pk: c.pk }))).toEqual([
        { name: "seq", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "tag", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "ts", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "author", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "scope", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "bytes", type: "BLOB", notnull: 1, pk: 0 },
      ]);

      const master = app.db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .get() as { sql: string } | null;
      expect(master?.sql).toMatch(/seq\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i);
      expect(headCursor(app.db)).toBe(0);
    } finally {
      app.close();
    }
  });

  test("does not log a false schema mismatch on first boot (ADR 0002)", async () => {
    const dir = makeTempDir();
    const captured: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };

    try {
      const dbPath = join(dir, "first-boot.db");
      const app = await createApp({ dbPath, host: "chat.local" });
      try {
        // Trigger a request to ensure any lazy schema check also resolves cleanly
        const res = await app.fetch(new Request("http://chat.local/api/auth/get-session"));
        expect(res.status).toBe(200);
        // Wait a microtask turn for any background promise catch handlers
        await new Promise((r) => setTimeout(r, 10));
      } finally {
        app.close();
      }
    } finally {
      console.error = origError;
      console.warn = origWarn;
      rmSync(dir, { recursive: true, force: true });
    }

    for (const line of captured) {
      expect(line).not.toMatch(/schema mismatch/i);
    }
  });

  test("sign up with username only populates placeholder email <username>@<host>.invalid and returns bare 32-char token (ADR 0002 & ADR 0007)", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const res = await app.fetch(
        new Request("http://chat.local/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://chat.local",
          },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        token: string;
        user: { username: string; email: string; name: string };
      };
      expect(body.user.username).toBe("alice");
      expect(body.user.email).toBe("alice@chat.local.invalid");
      expect(typeof body.token).toBe("string");
      expect(body.token).toHaveLength(32);
      expect(body.token.includes(".")).toBe(false);
    } finally {
      app.close();
    }
  });

  test("sign in with username, get-session with bare bearer token, and sign-out revokes session (ADR 0002 & ADR 0007)", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      // First sign up alice
      const signUpRes = await app.fetch(
        new Request("http://chat.local/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
      );
      expect(signUpRes.status).toBe(200);

      // Sign in with username
      const signInRes = await app.fetch(
        new Request("http://chat.local/api/auth/sign-in/username", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://chat.local",
          },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
      );
      expect(signInRes.status).toBe(200);
      const signInBody = (await signInRes.json()) as {
        token: string;
        user: { username: string; email: string };
      };
      expect(typeof signInBody.token).toBe("string");
      expect(signInBody.token).toHaveLength(32);
      expect(signInBody.token.includes(".")).toBe(false);
      expect(signInBody.user.username).toBe("alice");

      const token = signInBody.token;

      // GET /api/auth/get-session with Authorization: Bearer <token>
      const sessionRes = await app.fetch(
        new Request("http://chat.local/api/auth/get-session", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
      expect(sessionRes.status).toBe(200);
      const sessionBody = (await sessionRes.json()) as {
        user: { username: string; email: string };
        session: { token: string };
      } | null;
      expect(sessionBody).not.toBeNull();
      expect(sessionBody?.user.username).toBe("alice");

      // POST /api/auth/sign-out with Authorization: Bearer <token> and Origin: http://chat.local
      const signOutRes = await app.fetch(
        new Request("http://chat.local/api/auth/sign-out", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "http://chat.local",
          },
        }),
      );
      expect(signOutRes.status).toBe(200);

      // Subsequent GET /api/auth/get-session with that same token returns null
      const afterSignOutRes = await app.fetch(
        new Request("http://chat.local/api/auth/get-session", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
      expect(afterSignOutRes.status).toBe(200);
      const afterSignOutBody = await afterSignOutRes.json();
      expect(afterSignOutBody).toBeNull();
    } finally {
      app.close();
    }
  });
});
