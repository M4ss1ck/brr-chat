// Slice 5: invite-only groups. A closed group is invisible to the open list, its single
// link is the only way in, and rotating the link kills the old one without touching members.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  AckError,
  PROTOCOL_VERSION,
  Role,
  Tag,
  decodeSyncResponse,
  encodeSyncRequest,
  type Event,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import { createApp, type ServerApp } from "../src/index.ts";

interface Account {
  token: string;
  username: string;
}

interface Client {
  account: Account;
  wire: number;
  cursor: number;
}

let nextCid = 0;

function cid(): Uint8Array {
  nextCid += 1;
  return Uint8Array.from([9, 9, 9, 9, 9, 9, Math.floor(nextCid / 256) % 256, nextCid % 256]);
}

function groupOp(c: Uint8Array, name: string, open: boolean): Op {
  return { cid: c, tag: Tag.GroupMeta, scope: 0, name, about: "", open };
}

function profileOp(c: Uint8Array, username: string): Op {
  return { cid: c, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" };
}

function joinOp(c: Uint8Array, group: number, user: number, invite?: string): Op {
  const op: Op = { cid: c, tag: Tag.Membership, scope: group, user, role: Role.Member };
  return invite === undefined ? op : { ...op, invite };
}

function postOp(c: Uint8Array, group: number, text: string): Op {
  return { cid: c, tag: Tag.Post, scope: group, text, media: null };
}

async function signUp(app: ServerApp, username: string): Promise<Account> {
  const res = await app.fetch(
    new Request("http://chat.local/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
      body: JSON.stringify({ username, password: "password1234" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; recoveryCode: string };
  const confirm = await app.fetch(
    new Request("http://chat.local/api/recovery/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ group: body.recoveryCode.slice(-5) }),
    }),
  );
  expect(confirm.status).toBe(200);
  return { token: body.token, username };
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
  const profile = response.events.find(
    (event) => event.tag === Tag.Profile && "username" in event && event.username === account.username,
  );
  expect(profile).toBeDefined();
  if (!profile) throw new Error("profile missing");
  return { wire: profile.author, cursor: response.cursor };
}

async function client(app: ServerApp, username: string, ageHours?: number): Promise<Client> {
  const account = await signUp(app, username);
  if (ageHours !== undefined) setAge(app, username, ageHours);
  const identity = await identify(app, account);
  return { account, wire: identity.wire, cursor: identity.cursor };
}

interface InvitePayload {
  group: number;
  token: string;
  link: string;
  qr: string;
}

async function inviteRequest(
  app: ServerApp,
  token: string,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  return app.fetch(
    new Request(`http://chat.local${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

async function inviteOf(app: ServerApp, token: string, group: number): Promise<InvitePayload> {
  const res = await inviteRequest(app, token, `/api/groups/${group}/invite`);
  expect(res.status).toBe(200);
  return (await res.json()) as InvitePayload;
}

async function rotate(app: ServerApp, token: string, group: number): Promise<InvitePayload> {
  const res = await inviteRequest(app, token, `/api/groups/${group}/invite/rotate`, "POST");
  expect(res.status).toBe(200);
  return (await res.json()) as InvitePayload;
}

function groupMeta(response: SyncResponse, group: number): Event | undefined {
  return response.events.find((event) => event.tag === Tag.GroupMeta && event.scope === group);
}

function posts(events: Event[]): string[] {
  return events.flatMap((event) => (event.tag === Tag.Post && "text" in event ? [event.text] : []));
}

describe("Slice 5: invite-only groups", () => {
  test("a closed group never appears in the open list; an open one still does", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");

      const openCid = cid();
      const openCreated = await sync(app, alice.account.token, alice.cursor, [groupOp(openCid, "Open", true)]);
      const openGroup = seqOf(openCreated, openCid);
      const closedCid = cid();
      const closedCreated = await sync(app, alice.account.token, openCreated.cursor, [
        groupOp(closedCid, "Closed", false),
      ]);
      const closedGroup = seqOf(closedCreated, closedCid);

      const listing = await sync(app, bob.account.token, bob.cursor, []);
      expect(groupMeta(listing, openGroup)).toBeDefined();
      expect(groupMeta(listing, closedGroup)).toBeUndefined();
      expect(listing.events.some((event) => event.scope === closedGroup)).toBe(false);
    } finally {
      app.close();
    }
  });

  test("the link carries the group token and its QR code is the same URL", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Privado", false)]);
      const group = seqOf(created, createCid);

      const invite = await inviteOf(app, alice.account.token, group);
      expect(invite.group).toBe(group);
      expect(invite.token.length).toBeGreaterThan(20);
      expect(invite.link).toBe(`http://chat.local/join/${invite.token}`);
      expect(invite.qr).toBe(invite.link);

      // The shell answers the deep link, not a 404.
      const shell = await app.fetch(new Request(`http://chat.local/join/${invite.token}`));
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toContain("text/html");
    } finally {
      app.close();
    }
  });

  test("only group admins can read or rotate the link, and outsiders cannot see the group", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");

      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Staff", false)]);
      const group = seqOf(created, createCid);
      const invite = await inviteOf(app, alice.account.token, group);

      // Bob joins as a plain member and still cannot hand out links.
      const joinCid = cid();
      const joined = await sync(app, bob.account.token, bob.cursor, [joinOp(joinCid, group, bob.wire, invite.token)]);
      expect(ack(joined, joinCid)).toEqual({ seq: expect.any(Number) });
      const memberRead = await inviteRequest(app, bob.account.token, `/api/groups/${group}/invite`);
      expect(memberRead.status).toBe(403);
      const memberRotate = await inviteRequest(app, bob.account.token, `/api/groups/${group}/invite/rotate`, "POST");
      expect(memberRotate.status).toBe(403);

      // Carol is not a member: the server does not confirm that the group exists.
      const outsider = await inviteRequest(app, carol.account.token, `/api/groups/${group}/invite`);
      expect(outsider.status).toBe(404);
      const unknownInvite = await inviteRequest(app, carol.account.token, `/api/invites/${invite.token}`);
      expect(unknownInvite.status).toBe(200);
    } finally {
      app.close();
    }
  });

  test("joining with the live link works and delivers group state with zero old posts", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");

      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Habana", false)]);
      const group = seqOf(created, createCid);
      const invite = await inviteOf(app, alice.account.token, group);

      const beforeCid = cid();
      const beforeJoin = await sync(app, alice.account.token, created.cursor, [postOp(beforeCid, group, "before bob")]);
      expect(seqOf(beforeJoin, beforeCid)).toBeGreaterThan(group);

      // The link resolves before joining, so the client can show the group name.
      const resolved = await inviteRequest(app, bob.account.token, `/api/invites/${invite.token}`);
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({ group, name: "Habana", joined: false });

      const joinCid = cid();
      const joined = await sync(app, bob.account.token, beforeJoin.cursor, [
        joinOp(joinCid, group, bob.wire, invite.token),
      ]);
      expect(seqOf(joined, joinCid)).toBeGreaterThan(beforeJoin.cursor);
      expect(groupMeta(joined, group)).toMatchObject({ name: "Habana", open: false });
      expect(
        joined.events.some(
          (event) => event.tag === Tag.Membership && event.scope === group && event.user === bob.wire,
        ),
      ).toBe(true);
      expect(posts(joined.events)).toEqual([]);

      // New posts arrive, the pre-join one never does.
      const afterCid = cid();
      const after = await sync(app, alice.account.token, beforeJoin.cursor, [postOp(afterCid, group, "after bob")]);
      expect(seqOf(after, afterCid)).toBeGreaterThan(joined.cursor);
      const delivered = await sync(app, bob.account.token, joined.cursor, []);
      expect(posts(delivered.events)).toEqual(["after bob"]);

      const member = app.db
        .query("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
        .get(group, bob.wire) as { role: number } | null;
      expect(member?.role).toBe(Role.Member);

      // The link is a capability, not an event: neither the log nor a sync response may
      // carry its token to the members (ADR 0016).
      const rows = app.db.query("SELECT bytes FROM events WHERE scope = ?").all(group) as { bytes: Uint8Array }[];
      const log = rows.map((row) => Buffer.from(row.bytes).toString("utf8")).join("");
      expect(log).not.toContain(invite.token);
      expect(JSON.stringify(delivered.events)).not.toContain(invite.token);
    } finally {
      app.close();
    }
  });

  test("a rotated link fails while the old members stay in the group", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");

      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Rotating", false)]);
      const group = seqOf(created, createCid);
      const oldInvite = await inviteOf(app, alice.account.token, group);

      const bobCid = cid();
      const bobJoined = await sync(app, bob.account.token, bob.cursor, [
        joinOp(bobCid, group, bob.wire, oldInvite.token),
      ]);
      expect(ack(bobJoined, bobCid)).toEqual({ seq: expect.any(Number) });

      const newInvite = await rotate(app, alice.account.token, group);
      expect(newInvite.token).not.toBe(oldInvite.token);
      expect(newInvite.link).not.toBe(oldInvite.link);

      // The old link is dead, in both the op and the link resolver.
      const staleResolve = await inviteRequest(app, carol.account.token, `/api/invites/${oldInvite.token}`);
      expect(staleResolve.status).toBe(404);
      const staleCid = cid();
      const staleJoin = await sync(app, carol.account.token, carol.cursor, [
        joinOp(staleCid, group, carol.wire, oldInvite.token),
      ]);
      expect(ack(staleJoin, staleCid)).toEqual({ error: AckError.Forbidden });

      // The new one works.
      const freshResolve = await inviteRequest(app, carol.account.token, `/api/invites/${newInvite.token}`);
      expect(freshResolve.status).toBe(200);
      const freshCid = cid();
      const freshJoin = await sync(app, carol.account.token, staleJoin.cursor, [
        joinOp(freshCid, group, carol.wire, newInvite.token),
      ]);
      expect(ack(freshJoin, freshCid)).toEqual({ seq: expect.any(Number) });

      // Rotating did not kick Bob out.
      const bobPostCid = cid();
      const bobPost = await sync(app, bob.account.token, bobJoined.cursor, [postOp(bobPostCid, group, "still here")]);
      expect(ack(bobPost, bobPostCid)).toEqual({ seq: expect.any(Number) });
      const member = app.db
        .query("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
        .get(group, bob.wire) as { role: number } | null;
      expect(member?.role).toBe(Role.Member);
    } finally {
      app.close();
    }
  });

  test("the one-call join endpoint accepts the live link and rejects the rotated one", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");

      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "One call", false)]);
      const group = seqOf(created, createCid);
      const oldInvite = await inviteOf(app, alice.account.token, group);

      const joined = await inviteRequest(app, bob.account.token, `/api/invites/${oldInvite.token}/join`, "POST");
      expect(joined.status).toBe(200);
      expect(await joined.json()).toMatchObject({ group, joined: true });

      const newInvite = await rotate(app, alice.account.token, group);
      const carol = await client(app, "carol");
      const stale = await inviteRequest(app, carol.account.token, `/api/invites/${oldInvite.token}/join`, "POST");
      expect(stale.status).toBe(404);
      const live = await inviteRequest(app, carol.account.token, `/api/invites/${newInvite.token}/join`, "POST");
      expect(live.status).toBe(200);
    } finally {
      app.close();
    }
  });
});
