// Slice 7: server administration (ADR 0012, ADR 0017). Registration modes, the emergency
// freeze, server invite links, and the blast radius of a server ban. Every test goes through
// the same HTTP surface a client or an admin uses.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  PROTOCOL_VERSION,
  Role,
  Tag,
  decodeSyncResponse,
  encodeSyncRequest,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import { createApp, type ServerApp } from "../src/index.ts";

interface Account {
  token: string;
  username: string;
  recoveryCode: string;
}

interface Client {
  account: Account;
  wire: number;
  cursor: number;
}

interface SettingsPayload {
  mode: "open" | "invite" | "closed";
  frozen: boolean;
  admin: boolean;
  invite: { token: string; link: string; qr: string } | null;
}

let nextCid = 0;

function cid(): Uint8Array {
  nextCid += 1;
  return Uint8Array.from([13, 13, 13, 13, 13, 13, Math.floor(nextCid / 256) % 256, nextCid % 256]);
}

function profileOp(c: Uint8Array, username: string): Op {
  return { cid: c, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" };
}

function groupOp(c: Uint8Array, name: string): Op {
  return { cid: c, tag: Tag.GroupMeta, scope: 0, name, about: "", open: true };
}

function membershipOp(c: Uint8Array, group: number, user: number): Op {
  return { cid: c, tag: Tag.Membership, scope: group, user, role: Role.Member };
}

function postOp(c: Uint8Array, group: number, text: string): Op {
  return { cid: c, tag: Tag.Post, scope: group, text, media: null };
}

function dmOp(c: Uint8Array, peer: number, text: string): Op {
  return { cid: c, tag: Tag.Dm, scope: 0, peer, text, media: null };
}

async function signUpRequest(
  app: ServerApp,
  username: string,
  invite?: string,
): Promise<{ status: number; body: { token?: string; recoveryCode?: string; error?: string } }> {
  const res = await app.fetch(
    new Request("http://chat.local/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
      body: JSON.stringify(invite === undefined ? { username, password: "password1234" } : { username, password: "password1234", invite }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { token?: string; recoveryCode?: string; error?: string } };
}

async function signUp(app: ServerApp, username: string, invite?: string): Promise<Account> {
  const { status, body } = await signUpRequest(app, username, invite);
  expect(status).toBe(200);
  if (body.token === undefined || body.recoveryCode === undefined) throw new Error("signup returned no session");
  const confirm = await app.fetch(
    new Request("http://chat.local/api/recovery/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ group: body.recoveryCode.slice(-5) }),
    }),
  );
  expect(confirm.status).toBe(200);
  return { token: body.token, username, recoveryCode: body.recoveryCode };
}

function setAge(app: ServerApp, username: string, hours: number): void {
  app.db
    .query("UPDATE user SET createdAt = ? WHERE username = ?")
    .run(new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(), username);
}

async function sync(app: ServerApp, token: string, cursor: number, outbox: Op[] = []): Promise<SyncResponse> {
  const res = await app.fetch(
    new Request("http://chat.local/sync", {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: `Bearer ${token}` },
      body: encodeSyncRequest({ v: PROTOCOL_VERSION, cursor, outbox }),
    }),
  );
  expect(res.status).toBe(200);
  return decodeSyncResponse(new Uint8Array(brotliDecompressSync(new Uint8Array(await res.arrayBuffer()))));
}

async function syncStatus(app: ServerApp, token: string, cursor: number): Promise<number> {
  const res = await app.fetch(
    new Request("http://chat.local/sync", {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: `Bearer ${token}` },
      body: encodeSyncRequest({ v: PROTOCOL_VERSION, cursor, outbox: [] }),
    }),
  );
  return res.status;
}

/** A fresh session after a ban: the old token was revoked on purpose. */
async function signIn(app: ServerApp, username: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://chat.local/api/auth/sign-in/username", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
      body: JSON.stringify({ username, password: "password1234" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token?: string };
  if (body.token === undefined) throw new Error("sign in returned no token");
  return body.token;
}

function ack(response: SyncResponse, c: Uint8Array): { seq: number } | { error: number } {
  const row = response.acks.find((candidate) => candidate.cid.every((byte, i) => byte === c[i]));
  expect(row).toBeDefined();
  if (!row) throw new Error("no ack");
  return "seq" in row ? { seq: row.seq } : { error: row.error };
}

function seqOf(response: SyncResponse, c: Uint8Array): number {
  const result = ack(response, c);
  if (!("seq" in result)) throw new Error(`expected a seq, got error ${result.error}`);
  return result.seq;
}

async function identify(app: ServerApp, account: Account): Promise<{ wire: number; cursor: number }> {
  const response = await sync(app, account.token, 0, [profileOp(cid(), account.username)]);
  const profile = response.events.find((event) => event.tag === Tag.Profile && event.username === account.username);
  expect(profile).toBeDefined();
  if (!profile) throw new Error("profile missing from the state snapshot");
  return { wire: profile.author, cursor: response.cursor };
}

async function client(app: ServerApp, username: string, ageHours?: number): Promise<Client> {
  const account = await signUp(app, username);
  if (ageHours !== undefined) setAge(app, username, ageHours);
  const identity = await identify(app, account);
  return { account, wire: identity.wire, cursor: identity.cursor };
}

function bearer(token?: string): Record<string, string> {
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

async function serverSettings(app: ServerApp, token?: string): Promise<{ status: number; body: SettingsPayload }> {
  const res = await app.fetch(
    new Request("http://chat.local/api/server/settings", { headers: bearer(token) }),
  );
  return { status: res.status, body: (await res.json()) as SettingsPayload };
}

async function saveSettings(
  app: ServerApp,
  token: string,
  patch: { mode?: "open" | "invite" | "closed"; frozen?: boolean },
): Promise<{ status: number; body: SettingsPayload }> {
  const res = await app.fetch(
    new Request("http://chat.local/api/server/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(token) },
      body: JSON.stringify(patch),
    }),
  );
  return { status: res.status, body: (await res.json()) as SettingsPayload };
}

async function rotateServerInvite(app: ServerApp, token?: string): Promise<{ status: number; body: SettingsPayload }> {
  const res = await app.fetch(
    new Request("http://chat.local/api/server/invite/rotate", { method: "POST", headers: bearer(token) }),
  );
  return { status: res.status, body: (await res.json()) as SettingsPayload };
}

interface UserRow {
  user: number;
  username: string;
  banned: boolean;
  admin: boolean;
}

async function serverUsers(app: ServerApp, token: string): Promise<{ status: number; users: UserRow[] }> {
  const res = await app.fetch(new Request("http://chat.local/api/server/users", { headers: bearer(token) }));
  const body = (await res.json()) as { users?: UserRow[] };
  return { status: res.status, users: body.users ?? [] };
}

async function confirmSignup(app: ServerApp, token: string, recoveryCode: string): Promise<number> {
  const res = await app.fetch(
    new Request("http://chat.local/api/recovery/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ group: recoveryCode.slice(-5) }),
    }),
  );
  return res.status;
}

describe("Slice 7: server administration", () => {
  test("the first account becomes a server admin; only an admin can read or change registration", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // These scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");

      const aliceSettings = await serverSettings(app, alice.account.token);
      expect(aliceSettings.status).toBe(200);
      expect(aliceSettings.body).toMatchObject({ mode: "open", frozen: false, admin: true, invite: null });

      const bobRead = await serverSettings(app, bob.account.token);
      expect(bobRead.status).toBe(200);
      expect(bobRead.body).toMatchObject({ mode: "open", frozen: false, admin: false, invite: null });

      const bobUsers = await serverUsers(app, bob.account.token);
      expect(bobUsers.status).toBe(403);

      const denied = await saveSettings(app, bob.account.token, { mode: "closed" });
      expect(denied.status).toBe(403);
      expect((await serverSettings(app, bob.account.token)).body.mode).toBe("open");

      const changed = await saveSettings(app, alice.account.token, { mode: "invite" });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ mode: "invite", frozen: false, admin: true });

      const anonymous = await serverSettings(app);
      expect(anonymous.status).toBe(401);

      // The plugin's own user-management routes are not a second signup/ban path.
      const plugin = await app.fetch(
        new Request("http://chat.local/api/auth/admin/create-user", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.account.token}` },
          body: JSON.stringify({ email: "x@example.com", password: "password1234", name: "x" }),
        }),
      );
      expect(plugin.status).toBe(404);

      const publicState = await app.fetch(new Request("http://chat.local/api/server/registration"));
      expect(publicState.status).toBe(200);
      expect(await publicState.json()).toEqual({ mode: "invite", frozen: false });
    } finally {
      app.close();
    }
  });

  test("bootstrap waits for a finished signup, and an account that never synced can still be banned", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // These scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      // Alice starts signup but never types back her recovery code: she must not become admin.
      const half = await signUpRequest(app, "alice");
      expect(half.status).toBe(200);
      const aliceRole = app.db.query("SELECT role FROM user WHERE username = 'alice'").get() as { role: string | null };
      expect(aliceRole.role).not.toBe("admin");
      // An unfinished signup cannot use the admin surface even if it somehow got the role.
      expect((await serverSettings(app, half.body.token!)).status).toBe(403);

      // Bob finishes signup, so he is the bootstrap admin.
      const bob = await client(app, "bob");
      expect((await serverSettings(app, bob.account.token)).body.admin).toBe(true);

      // Alice confirms later; Bob already holds the role, so nothing changes.
      expect(await confirmSignup(app, half.body.token!, half.body.recoveryCode!)).toBe(200);
      const after = app.db.query("SELECT role FROM user WHERE username = 'alice'").get() as { role: string | null };
      expect(after.role).not.toBe("admin");

      // The account list covers accounts that never synced, so a raid account is ban-able.
      const listed = await serverUsers(app, bob.account.token);
      expect(listed.status).toBe(200);
      const aliceRow = listed.users.find((row) => row.username === "alice");
      expect(aliceRow).toBeDefined();
      expect(aliceRow?.user).toBeGreaterThan(0);

      const banCid = cid();
      const banned = await sync(app, bob.account.token, bob.cursor, [
        { cid: banCid, tag: Tag.Ban, scope: 0, user: aliceRow!.user, on: true },
      ]);
      seqOf(banned, banCid);
      const bannedRow = app.db.query("SELECT banned FROM user WHERE username = 'alice'").get() as { banned: number };
      expect(Number(bannedRow.banned)).toBe(1);
    } finally {
      app.close();
    }
  });

  test("open, invite, closed and frozen are enforced at signup immediately", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // These scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice");

      // Open needs nothing.
      const openSignup = await signUpRequest(app, "bob");
      expect(openSignup.status).toBe(200);

      // Invite mode rejects a missing or wrong token, and accepts the live one.
      const inviteMode = await saveSettings(app, alice.account.token, { mode: "invite" });
      expect(inviteMode.status).toBe(200);
      // Switching to invite mode hands out a working link instead of locking the server.
      expect(inviteMode.body.invite?.token).toBeTruthy();
      const missing = await signUpRequest(app, "carol");
      expect(missing.status).toBe(403);
      expect(missing.body.error).toContain("invite");
      const wrong = await signUpRequest(app, "carol", "not-the-token");
      expect(wrong.status).toBe(403);

      const firstInvite = await rotateServerInvite(app, alice.account.token);
      expect(firstInvite.status).toBe(200);
      const token = firstInvite.body.invite?.token;
      expect(token).toBeTruthy();
      expect(firstInvite.body.invite?.link).toBe(`http://chat.local/signup/${token}`);
      expect(firstInvite.body.invite?.qr).toBe(firstInvite.body.invite?.link);

      const carol = await signUp(app, "carol", token!);
      expect(carol.username).toBe("carol");

      // Rotating kills the old link before the response returns.
      const rotated = await rotateServerInvite(app, alice.account.token);
      expect(rotated.status).toBe(200);
      expect(rotated.body.invite?.token).not.toBe(token);
      const stale = await signUpRequest(app, "dave", token!);
      expect(stale.status).toBe(403);
      const dave = await signUp(app, "dave", rotated.body.invite!.token);
      expect(dave.username).toBe("dave");

      // Closed rejects even a live invite.
      expect((await saveSettings(app, alice.account.token, { mode: "closed" })).status).toBe(200);
      const closed = await signUpRequest(app, "erin", rotated.body.invite!.token);
      expect(closed.status).toBe(403);

      // Freeze overrides an open server and lifts on the same switch.
      expect((await saveSettings(app, alice.account.token, { mode: "open", frozen: true })).status).toBe(200);
      const frozen = await signUpRequest(app, "frank");
      expect(frozen.status).toBe(403);
      expect(frozen.body.error?.toLowerCase()).toContain("frozen");

      expect((await saveSettings(app, alice.account.token, { frozen: false })).status).toBe(200);
      const thawed = await signUpRequest(app, "frank");
      expect(thawed.status).toBe(200);

      // Only a server admin can rotate, and the token is a capability, never an event.
      const bobAccount = await signUp(app, "grace");
      const denied = await rotateServerInvite(app, bobAccount.token);
      expect(denied.status).toBe(403);
      const log = app.db.query("SELECT bytes FROM events").all() as { bytes: Uint8Array }[];
      const raw = log.map((row) => Buffer.from(row.bytes).toString("utf8")).join("");
      expect(raw).not.toContain(rotated.body.invite!.token);
    } finally {
      app.close();
    }
  });

  test("the signup deep link serves the shell and carries the invite token", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // These scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const res = await app.fetch(new Request("http://chat.local/signup/some-live-token"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('id="signup-invite"');
    } finally {
      app.close();
    }
  });

  test("a server ban revokes sessions and records a purge for every group and DM scope", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // These scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob", 25);
      const carol = await client(app, "carol");

      const groupCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(groupCid, "Habana")]);
      const group = seqOf(created, groupCid);

      const joinCid = cid();
      const joined = await sync(app, bob.account.token, bob.cursor, [membershipOp(joinCid, group, bob.wire)]);
      seqOf(joined, joinCid);
      const dmCid = cid();
      const dm = await sync(app, bob.account.token, joined.cursor, [dmOp(dmCid, carol.wire, "hola")]);
      const dmEvent = dm.events.find((event) => event.tag === Tag.Dm);
      expect(dmEvent).toBeDefined();
      if (!dmEvent) throw new Error("DM event missing");
      const dmScope = dmEvent.scope;
      const bobCursor = dm.cursor;

      // Bob's own session is alive before the ban.
      expect(await syncStatus(app, bob.account.token, bobCursor)).toBe(200);

      const banCid = cid();
      const banned = await sync(app, alice.account.token, created.cursor, [
        { cid: banCid, tag: Tag.Ban, scope: 0, user: bob.wire, on: true },
      ]);
      seqOf(banned, banCid);

      // Every BetterAuth session for the banned account is gone, not just rejected by /sync.
      const sessions = app.db.query("SELECT COUNT(*) AS n FROM session WHERE userId = (SELECT id FROM user WHERE username = 'bob')").get() as { n: number };
      expect(Number(sessions.n)).toBe(0);
      expect(await syncStatus(app, bob.account.token, bobCursor)).toBe(401);

      // Neither the password nor the recovery code can mint a new session while banned.
      const blockedSignIn = await app.fetch(
        new Request("http://chat.local/api/auth/sign-in/username", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
          body: JSON.stringify({ username: "bob", password: "password1234" }),
        }),
      );
      expect(blockedSignIn.status).toBe(403);
      const redeem = await app.fetch(
        new Request("http://chat.local/api/recovery/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "bob", code: bob.account.recoveryCode }),
        }),
      );
      expect(redeem.status).toBe(401);
      expect(Number((app.db.query("SELECT COUNT(*) AS n FROM session WHERE userId = (SELECT id FROM user WHERE username = 'bob')").get() as { n: number }).n)).toBe(0);

      // The ban removed group membership and queued a purge for both scopes bob was in.
      const bobWire = bob.wire;
      const membership = app.db
        .query("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
        .get(group, bobWire) as { role: number } | null;
      expect(membership).toBeNull();
      const lefts = app.db.query("SELECT scope FROM scope_lefts WHERE user_id = ? ORDER BY scope").all(bobWire) as {
        scope: number;
      }[];
      expect(lefts.map((row) => Number(row.scope)).sort((a, b) => a - b)).toEqual([group, dmScope].sort((a, b) => a - b));

      // Lifting the ban brings the queued group purge to the account, and restores the DM
      // scope: a DM has no join, so the pair row itself is the access.
      const liftCid = cid();
      const lifted = await sync(app, alice.account.token, banned.cursor, [
        { cid: liftCid, tag: Tag.Ban, scope: 0, user: bob.wire, on: false },
      ]);
      seqOf(lifted, liftCid);
      // Lifting a ban does not resurrect the revoked session: the account signs in again.
      expect(await syncStatus(app, bob.account.token, bobCursor)).toBe(401);
      const backToken = await signIn(app, "bob");
      const back = await sync(app, backToken, 0, []);
      const purges = back.events.filter((event) => event.tag === Tag.ScopeLeft && event.purge);
      expect(purges.map((event) => event.scope)).toEqual([group]);
      expect(back.events.some((event) => event.tag === Tag.DmScope && event.scope === dmScope)).toBe(true);
    } finally {
      app.close();
    }
  });
});
