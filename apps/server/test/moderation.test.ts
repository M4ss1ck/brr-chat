// Slice 6: group moderation (ADR 0010). Deleting posts, banning members, changing roles, and
// what happens to a group when its owner leaves or is banned. The server is the only place
// these rules can be proven: one log, several accounts, one transaction per outbox.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  AckError,
  PROTOCOL_VERSION,
  Role,
  Tag,
  decodeEventBytes,
  decodeSyncResponse,
  encodeEventBytes,
  encodeSyncRequest,
  type Event,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import { moderationDeltas } from "../src/events.ts";
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
  return Uint8Array.from([11, 11, 11, 11, 11, 11, Math.floor(nextCid / 256) % 256, nextCid % 256]);
}

function groupOp(c: Uint8Array, name: string, open = true): Op {
  return { cid: c, tag: Tag.GroupMeta, scope: 0, name, about: "", open };
}

function profileOp(c: Uint8Array, username: string): Op {
  return { cid: c, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" };
}

function membershipOp(c: Uint8Array, group: number, user: number, role: number): Op {
  return { cid: c, tag: Tag.Membership, scope: group, user, role };
}

function postOp(c: Uint8Array, group: number, text: string): Op {
  return { cid: c, tag: Tag.Post, scope: group, text, media: null };
}

function replyOp(c: Uint8Array, group: number, parent: number, text: string): Op {
  return { cid: c, tag: Tag.Reply, scope: group, parent, text, media: null };
}

function reactionOp(c: Uint8Array, group: number, target: number, emoji: number, on: boolean): Op {
  return { cid: c, tag: Tag.Reaction, scope: group, target, emoji, on };
}

function deleteOp(c: Uint8Array, group: number, target: number): Op {
  return { cid: c, tag: Tag.Delete, scope: group, target };
}

function banOp(c: Uint8Array, scope: number, user: number, on: boolean): Op {
  return { cid: c, tag: Tag.Ban, scope, user, on };
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

function setServerAdmin(app: ServerApp, username: string): void {
  app.db.query("UPDATE user SET role = 'admin' WHERE username = ?").run(username);
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
  const decompressed = new Uint8Array(brotliDecompressSync(new Uint8Array(await res.arrayBuffer())));
  return decodeSyncResponse(decompressed);
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

function posts(events: Event[]): string[] {
  return events.flatMap((event) => (event.tag === Tag.Post ? [event.text] : []));
}

async function identify(app: ServerApp, account: Account): Promise<{ wire: number; cursor: number }> {
  const response = await sync(app, account.token, 0, [profileOp(cid(), account.username)]);
  const profile = response.events.find(
    (event) => event.tag === Tag.Profile && event.username === account.username,
  );
  expect(profile).toBeDefined();
  if (!profile) throw new Error("profile event missing from the state snapshot");
  return { wire: profile.author, cursor: response.cursor };
}

async function client(app: ServerApp, username: string, ageHours?: number): Promise<Client> {
  const account = await signUp(app, username);
  if (ageHours !== undefined) setAge(app, username, ageHours);
  const identity = await identify(app, account);
  return { account, wire: identity.wire, cursor: identity.cursor };
}

/** Alice owns an open group; the named members have joined and are at the current cursor. */
async function groupWithMembers(
  app: ServerApp,
  owner: Client,
  members: { client: Client; role?: number }[] = [],
): Promise<{ groupId: number; cursor: number }> {
  const createCid = cid();
  const created = await sync(app, owner.account.token, owner.cursor, [groupOp(createCid, "Habana")]);
  const groupId = seqOf(created, createCid);
  let cursor = created.cursor;

  for (const { client: member, role = Role.Member } of members) {
    const listing = await sync(app, member.account.token, member.cursor, []);
    const joinCid = cid();
    const joined = await sync(app, member.account.token, listing.cursor, [
      membershipOp(joinCid, groupId, member.wire, role),
    ]);
    expect(ack(joined, joinCid)).toEqual({ seq: expect.any(Number) });
    member.cursor = joined.cursor;
    const refreshed = await sync(app, owner.account.token, cursor, []);
    cursor = refreshed.cursor;
  }
  return { groupId, cursor };
}

function memberRole(app: ServerApp, group: number, wire: number): number | null {
  const row = app.db.query("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?").get(group, wire) as
    | { role: number }
    | null;
  return row ? Number(row.role) : null;
}

function ownerCount(app: ServerApp, group: number): number {
  const row = app.db
    .query("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = ?")
    .get(group, Role.Owner) as { n: number };
  return Number(row.n);
}

function banRow(app: ServerApp, group: number, wire: number): { banned: number } | null {
  return app.db.query("SELECT banned FROM group_bans WHERE group_id = ? AND user_id = ?").get(group, wire) as
    | { banned: number }
    | null;
}

describe("Slice 6: group moderation", () => {
  test("members cannot moderate; a group admin can delete and ban, but not touch the owner", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");
      const dave = await client(app, "dave");
      const { groupId, cursor } = await groupWithMembers(app, alice, [
        { client: bob },
        { client: carol },
        { client: dave },
      ]);
      alice.cursor = cursor;

      const postCid = cid();
      const posted = await sync(app, alice.account.token, alice.cursor, [postOp(postCid, groupId, "hello")]);
      const postSeq = seqOf(posted, postCid);

      // A member deletes their own post without being an admin.
      const ownCid = cid();
      const own = await sync(app, bob.account.token, bob.cursor, [postOp(ownCid, groupId, "mine")]);
      const ownSeq = seqOf(own, ownCid);
      const deleteOwnCid = cid();
      const deleteOwn = await sync(app, bob.account.token, own.cursor, [
        deleteOp(deleteOwnCid, groupId, ownSeq),
      ]);
      expect(ack(deleteOwn, deleteOwnCid)).toEqual({ seq: expect.any(Number) });

      const memberDelete = cid();
      const deniedDelete = await sync(app, bob.account.token, deleteOwn.cursor, [
        deleteOp(memberDelete, groupId, postSeq),
      ]);
      expect(ack(deniedDelete, memberDelete)).toEqual({ error: AckError.Forbidden });

      const memberBan = cid();
      const deniedBan = await sync(app, bob.account.token, deniedDelete.cursor, [
        banOp(memberBan, groupId, carol.wire, true),
      ]);
      expect(ack(deniedBan, memberBan)).toEqual({ error: AckError.Forbidden });

      const memberPromote = cid();
      const deniedPromote = await sync(app, bob.account.token, deniedBan.cursor, [
        membershipOp(memberPromote, groupId, carol.wire, Role.Admin),
      ]);
      expect(ack(deniedPromote, memberPromote)).toEqual({ error: AckError.Forbidden });

      const promoteCid = cid();
      const promoted = await sync(app, alice.account.token, posted.cursor, [
        membershipOp(promoteCid, groupId, bob.wire, Role.Admin),
      ]);
      seqOf(promoted, promoteCid);
      expect(memberRole(app, groupId, bob.wire)).toBe(Role.Admin);

      const adminDelete = cid();
      const deleted = await sync(app, bob.account.token, deniedPromote.cursor, [deleteOp(adminDelete, groupId, postSeq)]);
      const deleteSeq = seqOf(deleted, adminDelete);
      expect(deleted.events.find((event) => event.seq === deleteSeq)).toMatchObject({
        tag: Tag.Delete,
        scope: groupId,
        author: bob.wire,
        target: postSeq,
      });

      // A deleted post accepts no new replies or reactions.
      const lateReply = cid();
      const replied = await sync(app, bob.account.token, deleted.cursor, [
        replyOp(lateReply, groupId, postSeq, "too late"),
      ]);
      expect(ack(replied, lateReply)).toEqual({ error: AckError.NotFound });
      const lateReaction = cid();
      const reacted = await sync(app, bob.account.token, replied.cursor, [
        reactionOp(lateReaction, groupId, postSeq, 0, true),
      ]);
      expect(ack(reacted, lateReaction)).toEqual({ error: AckError.NotFound });

      // Deleting again with a fresh cid is idempotent, not a second delete event.
      const again = cid();
      const deletedAgain = await sync(app, bob.account.token, reacted.cursor, [deleteOp(again, groupId, postSeq)]);
      expect(ack(deletedAgain, again)).toEqual({ seq: deleteSeq });

      const adminBan = cid();
      const banned = await sync(app, bob.account.token, deletedAgain.cursor, [
        banOp(adminBan, groupId, carol.wire, true),
      ]);
      seqOf(banned, adminBan);
      expect(memberRole(app, groupId, carol.wire)).toBeNull();
      expect(banRow(app, groupId, carol.wire)?.banned).toBe(1);

      const ownerBan = cid();
      const deniedOwner = await sync(app, bob.account.token, banned.cursor, [
        banOp(ownerBan, groupId, alice.wire, true),
      ]);
      expect(ack(deniedOwner, ownerBan)).toEqual({ error: AckError.Forbidden });

      // A group admin moderates members, not peers. The owner can promote and demote.
      const daveAdmin = cid();
      const madeDaveAdmin = await sync(app, alice.account.token, deniedOwner.cursor, [
        membershipOp(daveAdmin, groupId, dave.wire, Role.Admin),
      ]);
      seqOf(madeDaveAdmin, daveAdmin);
      const peerBan = cid();
      const deniedPeer = await sync(app, bob.account.token, madeDaveAdmin.cursor, [
        banOp(peerBan, groupId, dave.wire, true),
      ]);
      expect(ack(deniedPeer, peerBan)).toEqual({ error: AckError.Forbidden });
      const daveDemote = cid();
      const demoted = await sync(app, alice.account.token, deniedPeer.cursor, [
        membershipOp(daveDemote, groupId, dave.wire, Role.Member),
      ]);
      seqOf(demoted, daveDemote);
      expect(memberRole(app, groupId, dave.wire)).toBe(Role.Member);

      const kickedPost = cid();
      const refused = await sync(app, carol.account.token, carol.cursor, [postOp(kickedPost, groupId, "still here?")]);
      expect(ack(refused, kickedPost)).toEqual({ error: AckError.Forbidden });

      const transfer = cid();
      const deniedTransfer = await sync(app, bob.account.token, demoted.cursor, [
        membershipOp(transfer, groupId, carol.wire, Role.Owner),
      ]);
      expect(ack(deniedTransfer, transfer)).toEqual({ error: AckError.Forbidden });
      expect(ownerCount(app, groupId)).toBe(1);
    } finally {
      app.close();
    }
  });

  test("a ban kicks with scope_left purge and blocks rejoin until the ban is lifted", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");
      const { groupId } = await groupWithMembers(app, alice, [{ client: bob }, { client: carol }]);

      const postCid = cid();
      const posted = await sync(app, bob.account.token, bob.cursor, [postOp(postCid, groupId, "bye")]);
      seqOf(posted, postCid);

      const banCid = cid();
      const banned = await sync(app, alice.account.token, posted.cursor, [banOp(banCid, groupId, bob.wire, true)]);
      seqOf(banned, banCid);

      // The banned client is no longer a member, yet still receives exactly the purge event.
      const kicked = await sync(app, bob.account.token, posted.cursor, []);
      expect(kicked.events).toHaveLength(1);
      expect(kicked.events[0]).toMatchObject({
        tag: Tag.ScopeLeft,
        scope: groupId,
        purge: true,
      });
      expect(posts(kicked.events)).toEqual([]);

      // Another member sees who left and who was banned, but never someone else's purge.
      const carolSees = await sync(app, carol.account.token, carol.cursor, []);
      expect(carolSees.events.some((event) => event.tag === Tag.ScopeLeft)).toBe(false);
      expect(
        carolSees.events.some((event) => event.tag === Tag.Ban && event.scope === groupId && event.user === bob.wire),
      ).toBe(true);

      // A reinstall gets the current banned list from state, with no posts.
      const reinstall = await sync(app, carol.account.token, 0, []);
      expect(
        reinstall.events.some((event) => event.tag === Tag.Ban && event.scope === groupId && event.user === bob.wire),
      ).toBe(true);
      expect(reinstall.events.some((event) => event.tag === Tag.Post)).toBe(false);

      // A state-triggering op (joining another group) still carries the pending purge.
      const secondCid = cid();
      const second = await sync(app, alice.account.token, banned.cursor, [groupOp(secondCid, "Other")]);
      const secondGroup = seqOf(second, secondCid);
      const elsewhere = cid();
      const joinedElsewhere = await sync(app, bob.account.token, kicked.cursor, [
        membershipOp(elsewhere, secondGroup, bob.wire, Role.Member),
      ]);
      seqOf(joinedElsewhere, elsewhere);
      expect(
        joinedElsewhere.events.some((event) => event.tag === Tag.ScopeLeft && event.scope === groupId && event.purge),
      ).toBe(true);

      const rejoin = cid();
      const refused = await sync(app, bob.account.token, joinedElsewhere.cursor, [
        membershipOp(rejoin, groupId, bob.wire, Role.Member),
      ]);
      expect(ack(refused, rejoin)).toEqual({ error: AckError.Forbidden });

      const unbanCid = cid();
      const unbanned = await sync(app, alice.account.token, banned.cursor, [banOp(unbanCid, groupId, bob.wire, false)]);
      seqOf(unbanned, unbanCid);
      expect(banRow(app, groupId, bob.wire)?.banned).toBe(0);

      const joinCid = cid();
      const joined = await sync(app, bob.account.token, refused.cursor, [
        membershipOp(joinCid, groupId, bob.wire, Role.Member),
      ]);
      seqOf(joined, joinCid);
      expect(memberRole(app, groupId, bob.wire)).toBe(Role.Member);
      // Joining again clears the old purge mark, so a replayed purge cannot wipe the group.
      const marks = app.db.query("SELECT COUNT(*) AS n FROM scope_lefts WHERE user_id = ? AND scope = ?").get(
        bob.wire,
        groupId,
      ) as { n: number };
      expect(Number(marks.n)).toBe(0);
    } finally {
      app.close();
    }
  });

  test("ownership transfer leaves exactly one owner: target owner, old owner admin", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");
      const { groupId } = await groupWithMembers(app, alice, [{ client: bob }, { client: carol }]);

      const adminCid = cid();
      const promoted = await sync(app, alice.account.token, alice.cursor, [
        membershipOp(adminCid, groupId, bob.wire, Role.Admin),
      ]);
      seqOf(promoted, adminCid);

      const transferCid = cid();
      const transferred = await sync(app, alice.account.token, promoted.cursor, [
        membershipOp(transferCid, groupId, bob.wire, Role.Owner),
      ]);
      seqOf(transferred, transferCid);

      expect(memberRole(app, groupId, bob.wire)).toBe(Role.Owner);
      expect(memberRole(app, groupId, alice.wire)).toBe(Role.Admin);
      expect(ownerCount(app, groupId)).toBe(1);

      // The two role events are adjacent: the old owner is demoted in the same transaction.
      const rows = app.db
        .query("SELECT seq, bytes FROM events WHERE tag = ? AND scope = ? ORDER BY seq DESC LIMIT 2")
        .all(Tag.Membership, groupId) as { seq: number; bytes: Uint8Array }[];
      const latest = decodeEventBytes(rows[0]!.bytes);
      const previous = decodeEventBytes(rows[1]!.bytes);
      expect(latest).toMatchObject({ tag: Tag.Membership, user: alice.wire, role: Role.Admin });
      expect(previous).toMatchObject({ tag: Tag.Membership, user: bob.wire, role: Role.Owner });
      expect(Number(rows[0]!.seq) - Number(rows[1]!.seq)).toBe(1);

      // The former owner is now a group admin and cannot transfer ownership again.
      const again = cid();
      const refused = await sync(app, alice.account.token, transferred.cursor, [
        membershipOp(again, groupId, carol.wire, Role.Owner),
      ]);
      expect(ack(refused, again)).toEqual({ error: AckError.Forbidden });
      expect(ownerCount(app, groupId)).toBe(1);
    } finally {
      app.close();
    }
  });

  test("a server ban of the owner passes the group to the longest-serving admin", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");
      const dave = await client(app, "dave");
      setServerAdmin(app, "dave");
      const { groupId } = await groupWithMembers(app, alice, [{ client: bob }, { client: carol }]);

      const bobAdmin = cid();
      const afterBob = await sync(app, alice.account.token, alice.cursor, [
        membershipOp(bobAdmin, groupId, bob.wire, Role.Admin),
      ]);
      seqOf(afterBob, bobAdmin);
      const carolAdmin = cid();
      const afterCarol = await sync(app, alice.account.token, afterBob.cursor, [
        membershipOp(carolAdmin, groupId, carol.wire, Role.Admin),
      ]);
      seqOf(afterCarol, carolAdmin);

      const banCid = cid();
      const banned = await sync(app, dave.account.token, dave.cursor, [banOp(banCid, 0, alice.wire, true)]);
      seqOf(banned, banCid);

      const aliceRow = app.db.query("SELECT banned FROM user WHERE username = 'alice'").get() as { banned: number };
      expect(Number(aliceRow.banned)).toBe(1);
      expect(memberRole(app, groupId, bob.wire)).toBe(Role.Owner);
      expect(memberRole(app, groupId, alice.wire)).toBeNull();
      expect(memberRole(app, groupId, carol.wire)).toBe(Role.Admin);
      expect(ownerCount(app, groupId)).toBe(1);

      // A server-banned account cannot sync at all until the ban is lifted.
      expect(await syncStatus(app, alice.account.token, afterCarol.cursor)).toBe(401);

      const liftCid = cid();
      const lifted = await sync(app, dave.account.token, banned.cursor, [banOp(liftCid, 0, alice.wire, false)]);
      seqOf(lifted, liftCid);
      expect(await syncStatus(app, alice.account.token, afterCarol.cursor)).toBe(200);
      // The ban removed access: an unban does not quietly restore group powers.
      expect(memberRole(app, groupId, alice.wire)).toBeNull();
    } finally {
      app.close();
    }
  });

  test("a server ban with no group admin falls back to a server admin", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const carol = await client(app, "carol");
      const dave = await client(app, "dave");
      setServerAdmin(app, "dave");
      const { groupId } = await groupWithMembers(app, alice, [{ client: carol }]);

      const banCid = cid();
      const banned = await sync(app, dave.account.token, dave.cursor, [banOp(banCid, 0, alice.wire, true)]);
      seqOf(banned, banCid);

      expect(memberRole(app, groupId, dave.wire)).toBe(Role.Owner);
      expect(memberRole(app, groupId, alice.wire)).toBeNull();
      expect(ownerCount(app, groupId)).toBe(1);
    } finally {
      app.close();
    }
  });

  test("a server ban removes group memberships, including group admin roles", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const carol = await client(app, "carol", 25);
      const alice = await client(app, "alice");
      const dave = await client(app, "dave");
      setServerAdmin(app, "dave");
      const { groupId } = await groupWithMembers(app, carol, [{ client: alice }]);

      const adminCid = cid();
      const promoted = await sync(app, carol.account.token, alice.cursor, [
        membershipOp(adminCid, groupId, alice.wire, Role.Admin),
      ]);
      seqOf(promoted, adminCid);

      const banCid = cid();
      const banned = await sync(app, dave.account.token, dave.cursor, [banOp(banCid, 0, alice.wire, true)]);
      seqOf(banned, banCid);
      expect(memberRole(app, groupId, alice.wire)).toBeNull();

      const liftCid = cid();
      const lifted = await sync(app, dave.account.token, banned.cursor, [banOp(liftCid, 0, alice.wire, false)]);
      seqOf(lifted, liftCid);
      const back = await sync(app, alice.account.token, 0, []);
      expect(
        back.events.some((event) => event.tag === Tag.ScopeLeft && event.scope === groupId && event.purge),
      ).toBe(true);
      expect(memberRole(app, groupId, alice.wire)).toBeNull();
    } finally {
      app.close();
    }
  });

  test("the last server admin can take a group even when that admin is group-banned", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const carol = await client(app, "carol");
      // BetterAuth stores several roles as a comma-separated list.
      app.db.query("UPDATE user SET role = 'user,admin' WHERE username = 'carol'").run();
      const { groupId } = await groupWithMembers(app, alice, [{ client: carol }]);

      const kickCid = cid();
      const kicked = await sync(app, alice.account.token, alice.cursor, [banOp(kickCid, groupId, carol.wire, true)]);
      seqOf(kicked, kickCid);
      expect(banRow(app, groupId, carol.wire)?.banned).toBe(1);

      const banCid = cid();
      const banned = await sync(app, carol.account.token, carol.cursor, [banOp(banCid, 0, alice.wire, true)]);
      seqOf(banned, banCid);

      // Taking over is what lifts the group ban: an owner who cannot enter is not an owner.
      expect(memberRole(app, groupId, carol.wire)).toBe(Role.Owner);
      expect(memberRole(app, groupId, alice.wire)).toBeNull();
      expect(banRow(app, groupId, carol.wire)?.banned).toBe(0);
      expect(ownerCount(app, groupId)).toBe(1);

      const postCid = cid();
      const posted = await sync(app, carol.account.token, banned.cursor, [postOp(postCid, groupId, "still here")]);
      expect(ack(posted, postCid)).toEqual({ seq: expect.any(Number) });
    } finally {
      app.close();
    }
  });

  test("a state snapshot still carries deletes and removals from before the cursor jump", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const dave = await client(app, "dave");
      const { groupId } = await groupWithMembers(app, alice, [{ client: bob }, { client: dave }]);

      const postCid = cid();
      const posted = await sync(app, bob.account.token, bob.cursor, [postOp(postCid, groupId, "gone soon")]);
      const postSeq = seqOf(posted, postCid);
      bob.cursor = posted.cursor;

      const deleteCid = cid();
      const deleted = await sync(app, alice.account.token, alice.cursor, [deleteOp(deleteCid, groupId, postSeq)]);
      seqOf(deleted, deleteCid);
      const leaveCid = cid();
      const left = await sync(app, dave.account.token, dave.cursor, [
        membershipOp(leaveCid, groupId, dave.wire, Role.None),
      ]);
      seqOf(left, leaveCid);

      const secondCid = cid();
      const second = await sync(app, alice.account.token, deleted.cursor, [groupOp(secondCid, "Other")]);
      const secondGroup = seqOf(second, secondCid);

      // Bob was offline for the delete and the leave, then joins a group: the response is a
      // state snapshot whose cursor jumps to head. The tombstones must still be in it.
      const elsewhere = cid();
      const joined = await sync(app, bob.account.token, bob.cursor, [
        membershipOp(elsewhere, secondGroup, bob.wire, Role.Member),
      ]);
      seqOf(joined, elsewhere);
      expect(joined.events.some((event) => event.tag === Tag.Delete && event.target === postSeq)).toBe(true);
      expect(
        joined.events.some(
          (event) => event.tag === Tag.Membership && event.user === dave.wire && event.role === Role.None,
        ),
      ).toBe(true);
      expect(joined.cursor).toBeGreaterThan(postSeq);
    } finally {
      app.close();
    }
  });

  test("only a server admin can ban server-wide", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");
      const { groupId } = await groupWithMembers(app, alice, [{ client: bob }]);

      const deniedCid = cid();
      const denied = await sync(app, alice.account.token, alice.cursor, [banOp(deniedCid, 0, bob.wire, true)]);
      expect(ack(denied, deniedCid)).toEqual({ error: AckError.Forbidden });

      const selfCid = cid();
      const selfish = await sync(app, alice.account.token, denied.cursor, [banOp(selfCid, groupId, alice.wire, true)]);
      expect(ack(selfish, selfCid)).toEqual({ error: AckError.Forbidden });

      const unknownCid = cid();
      const unknown = await sync(app, alice.account.token, selfish.cursor, [
        banOp(unknownCid, groupId, carol.wire, true),
      ]);
      expect(ack(unknown, unknownCid)).toEqual({ error: AckError.NotFound });
    } finally {
      app.close();
    }
  });

  test("an owner who leaves hands the group to the longest-serving admin", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const { groupId } = await groupWithMembers(app, alice, [{ client: bob }]);
      const before = await sync(app, alice.account.token, alice.cursor, []);

      const adminCid = cid();
      const promoted = await sync(app, alice.account.token, before.cursor, [
        membershipOp(adminCid, groupId, bob.wire, Role.Admin),
      ]);
      seqOf(promoted, adminCid);

      const leaveCid = cid();
      const left = await sync(app, alice.account.token, promoted.cursor, [
        membershipOp(leaveCid, groupId, alice.wire, Role.None),
      ]);
      seqOf(left, leaveCid);

      expect(memberRole(app, groupId, alice.wire)).toBeNull();
      expect(memberRole(app, groupId, bob.wire)).toBe(Role.Owner);
      expect(ownerCount(app, groupId)).toBe(1);

      // The leaving client learns it lost the scope in the same response, and purges.
      expect(left.events.some((event) => event.tag === Tag.ScopeLeft && event.scope === groupId && event.purge)).toBe(
        true,
      );

      // Retrying the leave after a lost response returns a state snapshot, and that snapshot
      // must still carry the purge rather than silently moving the cursor past it.
      const retried = await sync(app, alice.account.token, left.cursor, [
        membershipOp(leaveCid, groupId, alice.wire, Role.None),
      ]);
      expect(seqOf(retried, leaveCid)).toBe(seqOf(left, leaveCid));
      expect(retried.events.some((event) => event.tag === Tag.ScopeLeft && event.scope === groupId && event.purge)).toBe(
        true,
      );
    } finally {
      app.close();
    }
  });

  test("moderation deltas page past a corrupt row instead of jumping the cursor", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      // Moderation scenarios need several accounts; signup budgets are tested in abuse.test.ts.
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice", 25);
      const { groupId } = await groupWithMembers(app, alice);

      // 501 valid membership tombstones plus one corrupt row at the front of the page.
      const start = (
        app.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events").get() as { seq: number }
      ).seq;
      const insert = app.db.query("INSERT INTO events (seq, tag, ts, author, scope, bytes) VALUES (?, ?, ?, ?, ?, ?)");
      insert.run(start, Tag.Membership, 1, 1, groupId, new Uint8Array([0xff, 0xff]));
      const total = 501;
      for (let i = 0; i < total; i++) {
        const seq = start + 1 + i;
        const event: Event = {
          tag: Tag.Membership,
          seq,
          ts: 1,
          author: 1,
          scope: groupId,
          user: 999,
          role: Role.None,
        };
        insert.run(seq, event.tag, event.ts, event.author, event.scope, encodeEventBytes(event));
      }

      let page = moderationDeltas(app.db, alice.wire, start - 1);
      expect(page.more).toBe(true);
      let seen = page.events.length;
      let calls = 0;
      while (page.more && calls < 5) {
        page = moderationDeltas(app.db, alice.wire, page.cursor);
        seen += page.events.length;
        calls += 1;
      }
      // The corrupt row is dropped, every tombstone after it still arrives, and paging ends.
      expect(seen).toBe(total);
      expect(page.more).toBe(false);
      expect(calls).toBe(1);
    } finally {
      app.close();
    }
  });
});
