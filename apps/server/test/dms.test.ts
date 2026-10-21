// Slice 5: any account can open a 1:1 DM with any other account (ADR 0008, ADR 0015). The
// server is the only place the pair rule and the visibility rule can be proven end to end.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  AckError,
  PROTOCOL_VERSION,
  Tag,
  decodeSyncResponse,
  encodeSyncRequest,
  type Event,
  type Media,
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

function profileOp(c: Uint8Array, username: string): Op {
  return { cid: c, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" };
}

function dmOp(c: Uint8Array, scope: number, peer: number, text: string, media: Media | null = null): Op {
  return { cid: c, tag: Tag.Dm, scope, peer, text, media };
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

/** Publishes a profile, then reads the wire id the server assigned to this account. */
async function identify(app: ServerApp, account: Account): Promise<{ wire: number; cursor: number }> {
  const response = await sync(app, account.token, 0, [profileOp(cid(), account.username)]);
  const profile = response.events.find(
    (event) => event.tag === Tag.Profile && "username" in event && event.username === account.username,
  );
  expect(profile).toBeDefined();
  if (!profile) throw new Error("profile event missing from the state snapshot");
  return { wire: profile.author, cursor: response.cursor };
}

function setAge(app: ServerApp, username: string, hours: number): void {
  app.db
    .query("UPDATE user SET createdAt = ? WHERE username = ?")
    .run(new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(), username);
}

/** Default age 25h: past the 24h new-account DM cooldown (ADR 0012). */
async function client(app: ServerApp, username: string, ageHours = 25): Promise<Client> {
  const account = await signUp(app, username);
  setAge(app, username, ageHours);
  const identity = await identify(app, account);
  return { account, wire: identity.wire, cursor: identity.cursor };
}

function dmScopeEvents(events: Event[]): Extract<Event, { tag: typeof Tag.DmScope }>[] {
  return events.filter((event): event is Extract<Event, { tag: typeof Tag.DmScope }> => event.tag === Tag.DmScope);
}

function dmMessages(events: Event[]): Extract<Event, { tag: typeof Tag.Dm }>[] {
  return events.filter((event): event is Extract<Event, { tag: typeof Tag.Dm }> => event.tag === Tag.Dm);
}

function tableCount(app: ServerApp, table: string): number {
  const row = app.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

describe("Slice 5: direct messages", () => {
  test("the first DM creates one scope, and both participants see it", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");

      const c = cid();
      const sent = await sync(app, alice.account.token, alice.cursor, [dmOp(c, 0, bob.wire, "hola bob")]);
      const messageSeq = seqOf(sent, c);

      const scopes = dmScopeEvents(sent.events);
      expect(scopes).toHaveLength(1);
      const scope = scopes[0]!;
      expect(scope.scope).toBe(scope.seq);
      expect(scope.author).toBe(alice.wire);
      expect(scope.peer).toBe(bob.wire);

      const message = dmMessages(sent.events).find((event) => event.seq === messageSeq);
      expect(message).toMatchObject({ scope: scope.seq, author: alice.wire, peer: bob.wire, text: "hola bob" });

      expect(tableCount(app, "dm_scopes")).toBe(1);

      // Bob learns the conversation from his own cursor, without a full state snapshot.
      const received = await sync(app, bob.account.token, bob.cursor, []);
      expect(dmScopeEvents(received.events).map((event) => event.scope)).toEqual([scope.seq]);
      expect(dmMessages(received.events).map((event) => event.text)).toEqual(["hola bob"]);

      // A reply uses the scope id, and the peer stays the other participant.
      const replyCid = cid();
      const replied = await sync(app, bob.account.token, received.cursor, [
        dmOp(replyCid, scope.seq, alice.wire, "te oigo"),
      ]);
      const reply = dmMessages(replied.events).find((event) => event.seq === seqOf(replied, replyCid));
      expect(reply).toMatchObject({ scope: scope.seq, author: bob.wire, peer: alice.wire, text: "te oigo" });
      const delivered = await sync(app, alice.account.token, sent.cursor, []);
      expect(dmMessages(delivered.events).map((event) => event.text)).toEqual(["te oigo"]);
      expect(tableCount(app, "dm_scopes")).toBe(1);
    } finally {
      app.close();
    }
  });

  test("concurrent first messages create exactly one scope for the pair", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");

      const aliceCid = cid();
      const bobCid = cid();
      const [fromAlice, fromBob] = await Promise.all([
        sync(app, alice.account.token, alice.cursor, [dmOp(aliceCid, 0, bob.wire, "hola")]),
        sync(app, bob.account.token, bob.cursor, [dmOp(bobCid, 0, alice.wire, "hey")]),
      ]);
      expect(seqOf(fromAlice, aliceCid)).toBeGreaterThan(0);
      expect(seqOf(fromBob, bobCid)).toBeGreaterThan(0);

      expect(tableCount(app, "dm_scopes")).toBe(1);

      // Both responses can carry the same scope event; it is one row in the log.
      const scopes = new Map(
        dmScopeEvents([...fromAlice.events, ...fromBob.events]).map((event) => [event.seq, event]),
      );
      expect(scopes.size).toBe(1);
      const scopeId = [...scopes.values()][0]!.scope;

      const rows = app.db.query("SELECT scope, author FROM events WHERE tag = ? ORDER BY seq ASC").all(Tag.Dm) as {
        scope: number;
        author: number;
      }[];
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.scope))).toEqual(new Set([scopeId]));

      // A later scope-0 message from either side still lands in the same conversation.
      const laterCid = cid();
      const later = await sync(app, alice.account.token, fromAlice.cursor, [dmOp(laterCid, 0, bob.wire, "otra vez")]);
      const laterMessage = dmMessages(later.events).find((event) => event.seq === seqOf(later, laterCid));
      expect(laterMessage?.scope).toBe(scopeId);
      expect(tableCount(app, "dm_scopes")).toBe(1);
      expect(tableCount(app, "events WHERE tag = 13")).toBe(1);
    } finally {
      app.close();
    }
  });

  test("a third account never receives a DM scope or a DM message", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");

      const c = cid();
      const sent = await sync(app, alice.account.token, alice.cursor, [dmOp(c, 0, bob.wire, "just us")]);
      const scopeId = dmScopeEvents(sent.events)[0]!.scope;

      const incremental = await sync(app, carol.account.token, carol.cursor, []);
      expect(dmScopeEvents(incremental.events)).toEqual([]);
      expect(dmMessages(incremental.events)).toEqual([]);

      // Even a fresh device gets no trace of a conversation it is not part of.
      const fresh = await sync(app, carol.account.token, 0, []);
      expect(dmScopeEvents(fresh.events)).toEqual([]);
      expect(dmMessages(fresh.events)).toEqual([]);

      // And Carol cannot write into a scope she is not in.
      const intrude = cid();
      const refused = await sync(app, carol.account.token, incremental.cursor, [
        dmOp(intrude, scopeId, bob.wire, "let me in"),
      ]);
      expect(ack(refused, intrude)).toEqual({ error: AckError.Forbidden });
      expect(tableCount(app, "events WHERE tag = 3")).toBe(1);
    } finally {
      app.close();
    }
  });

  test("a fresh device gets the DM list from state with zero messages", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");

      const c = cid();
      const sent = await sync(app, alice.account.token, alice.cursor, [dmOp(c, 0, bob.wire, "history")]);
      const scopeId = dmScopeEvents(sent.events)[0]!.scope;

      // A reinstall starts at cursor 0: current state names the conversation, no messages.
      const fresh = await sync(app, bob.account.token, 0, []);
      expect(dmScopeEvents(fresh.events).map((event) => event.scope)).toEqual([scopeId]);
      expect(dmMessages(fresh.events)).toEqual([]);
    } finally {
      app.close();
    }
  });

  test("retrying the same cid never duplicates a DM or a second scope", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");

      const c = cid();
      const first = await sync(app, alice.account.token, alice.cursor, [dmOp(c, 0, bob.wire, "once")]);
      const messageSeq = seqOf(first, c);
      const second = await sync(app, alice.account.token, first.cursor, [dmOp(c, 0, bob.wire, "once")]);
      expect(seqOf(second, c)).toBe(messageSeq);

      expect(tableCount(app, "events WHERE tag = 3")).toBe(1);
      expect(tableCount(app, "events WHERE tag = 13")).toBe(1);
      expect(tableCount(app, "dm_scopes")).toBe(1);
    } finally {
      app.close();
    }
  });

  test("DM ops are validated: self, unknown peer, media and a mismatched peer", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");

      const selfCid = cid();
      const self = await sync(app, alice.account.token, alice.cursor, [dmOp(selfCid, 0, alice.wire, "me")]);
      expect(ack(self, selfCid)).toEqual({ error: AckError.Invalid });

      const unknownCid = cid();
      const unknown = await sync(app, alice.account.token, self.cursor, [dmOp(unknownCid, 0, 9_999, "ghost")]);
      expect(ack(unknown, unknownCid)).toEqual({ error: AckError.NotFound });

      const mediaCid = cid();
      const media = await sync(app, alice.account.token, unknown.cursor, [
        dmOp(mediaCid, 0, bob.wire, "photo", { id: 1, w: 10, h: 10, thumbhash: new Uint8Array(4) }),
      ]);
      // Media uploads are real now: an id the server never stored is NotFound, not Unsupported.
      expect(ack(media, mediaCid)).toEqual({ error: AckError.NotFound });

      const openCid = cid();
      const opened = await sync(app, alice.account.token, media.cursor, [dmOp(openCid, 0, bob.wire, "hi")]);
      const scopeId = dmScopeEvents(opened.events)[0]!.scope;

      const wrongPeerCid = cid();
      const wrongPeer = await sync(app, alice.account.token, opened.cursor, [
        dmOp(wrongPeerCid, scopeId, carol.wire, "wrong person"),
      ]);
      expect(ack(wrongPeer, wrongPeerCid)).toEqual({ error: AckError.Invalid });

      const missingScopeCid = cid();
      const missingScope = await sync(app, alice.account.token, wrongPeer.cursor, [
        dmOp(missingScopeCid, 9_999, bob.wire, "nowhere"),
      ]);
      expect(ack(missingScope, missingScopeCid)).toEqual({ error: AckError.NotFound });
    } finally {
      app.close();
    }
  });
});
