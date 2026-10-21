// Issue #15: client-encoded WebP variants, server validation without re-encoding, quota,
// and tap-only delivery through GET /m/{id}?w=.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  AckError,
  MEDIA_FULL_EDGE,
  MEDIA_PREVIEW_EDGE,
  PROTOCOL_VERSION,
  Role,
  Tag,
  decodeSyncResponse,
  encodeSyncRequest,
  encodeSyncResponse,
  type Event,
  type Media,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import { createApp, type ServerApp } from "../src/index.ts";
import { inspectWebp } from "../src/media-store.ts";

// ---- WebP headers. The server never decodes pixels, so a valid container is enough. ----

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function container(fourcc: string, payload: Uint8Array, pad = 0): Uint8Array {
  const body = new Uint8Array(4 + 8 + payload.byteLength + pad);
  body.set(ascii("WEBP"), 0);
  body.set(ascii(fourcc), 4);
  body.set(u32le(payload.byteLength), 8);
  body.set(payload, 12);
  const file = new Uint8Array(8 + body.byteLength);
  file.set(ascii("RIFF"), 0);
  file.set(u32le(body.byteLength), 4);
  file.set(body, 8);
  return file;
}

function vp8l(width: number, height: number, pad = 0): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return container("VP8L", Uint8Array.from([0x2f, ...u32le(bits)]), pad);
}

function vp8(width: number, height: number): Uint8Array {
  return container(
    "VP8 ",
    Uint8Array.from([0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f]),
  );
}

function vp8x(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return container(
    "VP8X",
    Uint8Array.from([0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]),
  );
}

// ---- server and account harness ----

let nextCid = 0;
function cid(): Uint8Array {
  nextCid += 1;
  return Uint8Array.from([9, 9, 9, 9, 9, 9, Math.floor(nextCid / 256) % 256, nextCid % 256]);
}

interface Account {
  token: string;
  username: string;
}

interface Client {
  account: Account;
  wire: number;
  cursor: number;
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

function seqOf(response: SyncResponse, c: Uint8Array): number {
  const row = response.acks.find((candidate) => candidate.cid.every((byte, i) => byte === c[i]));
  expect(row).toBeDefined();
  if (!row || !("seq" in row)) throw new Error(`expected a seq, got ${JSON.stringify(row)}`);
  return row.seq;
}

function errorOf(response: SyncResponse, c: Uint8Array): number {
  const row = response.acks.find((candidate) => candidate.cid.every((byte, i) => byte === c[i]));
  expect(row).toBeDefined();
  if (!row || !("error" in row)) throw new Error(`expected an error, got ${JSON.stringify(row)}`);
  return row.error;
}

async function client(app: ServerApp, username: string, ageHours = 25): Promise<Client> {
  const account = await signUp(app, username);
  setAge(app, username, ageHours);
  const profileCid = cid();
  const response = await sync(app, account.token, 0, [
    { cid: profileCid, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" },
  ]);
  const profile = response.events.find(
    (event): event is Extract<Event, { tag: typeof Tag.Profile }> =>
      event.tag === Tag.Profile && event.username === username,
  );
  if (!profile) throw new Error("profile event missing");
  return { account, wire: profile.author, cursor: response.cursor };
}

interface Uploaded {
  status: number;
  body: Record<string, unknown>;
}

async function upload(
  app: ServerApp,
  token: string,
  preview: Uint8Array,
  full: Uint8Array,
): Promise<Uploaded> {
  const form = new FormData();
  form.set("preview", new Blob([preview], { type: "image/webp" }), "preview.webp");
  form.set("full", new Blob([full], { type: "image/webp" }), "full.webp");
  const res = await app.fetch(
    new Request("http://chat.local/m", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function uploadOk(app: ServerApp, token: string, preview = vp8l(320, 200), full = vp8l(1280, 800)): Promise<number> {
  const result = await upload(app, token, preview, full);
  expect(result.status).toBe(201);
  return Number(result.body.id);
}

async function image(app: ServerApp, token: string, path: string): Promise<Response> {
  return app.fetch(
    new Request(`http://chat.local${path}`, { headers: { Authorization: `Bearer ${token}` } }),
  );
}

function bytesOf(response: Response): Promise<Uint8Array> {
  return response.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect([...actual]).toEqual([...expected]);
}

function mediaFor(id: number, thumbhash = new Uint8Array(21).fill(7)): Media {
  return { id, w: MEDIA_FULL_EDGE, h: 800, thumbhash };
}

function postOp(c: Uint8Array, scope: number, text: string, media: Media | null): Op {
  return { cid: c, tag: Tag.Post, scope, text, media };
}

async function makeGroup(app: ServerApp, alice: Client, open = true): Promise<number> {
  const c = cid();
  const response = await sync(app, alice.account.token, alice.cursor, [
    { cid: c, tag: Tag.GroupMeta, scope: 0, name: `group-${nextCid}`, about: "", open },
  ]);
  alice.cursor = response.cursor;
  return seqOf(response, c);
}

async function join(app: ServerApp, member: Client, group: number): Promise<number> {
  const c = cid();
  const response = await sync(app, member.account.token, member.cursor, [
    { cid: c, tag: Tag.Membership, scope: group, user: member.wire, role: Role.Member },
  ]);
  // A join answers with current state and the head cursor: never back history (ADR 0009).
  member.cursor = response.cursor;
  return seqOf(response, c);
}

const PNG_LIKE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0)]);

describe("WebP container inspection", () => {
  test("reads the dimensions from lossy, lossless and extended WebP", () => {
    expect(inspectWebp(vp8(320, 200))).toEqual({ width: 320, height: 200, format: "VP8" });
    expect(inspectWebp(vp8l(1280, 800))).toEqual({ width: 1280, height: 800, format: "VP8L" });
    expect(inspectWebp(vp8x(1600, 900))).toEqual({ width: 1600, height: 900, format: "VP8X" });
  });

  test("rejects a wrong type, a truncated file and an unknown chunk", () => {
    expect(inspectWebp(PNG_LIKE)).toBeNull();
    expect(inspectWebp(vp8l(320, 200).slice(0, 20))).toBeNull();
    expect(inspectWebp(container("XXXX", Uint8Array.from([1, 2, 3, 4])))).toBeNull();
  });
});

describe("media upload and fetch", () => {
  test("an upload returns an id and the full dimensions; ?w= snaps to a variant", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", mediaQuotaBytes: 10_000_000 });
    try {
      const alice = await client(app, "alice");
      const preview = vp8l(MEDIA_PREVIEW_EDGE, 200);
      const full = vp8l(MEDIA_FULL_EDGE, 800);
      const result = await upload(app, alice.account.token, preview, full);
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ w: MEDIA_FULL_EDGE, h: 800 });
      const id = Number(result.body.id);
      expect(id).toBeGreaterThan(0);

      const fallback = await image(app, alice.account.token, `/m/${id}`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toBe("image/webp");
      expect(fallback.headers.get("cache-control")).toContain("private");
      expect(fallback.headers.get("x-content-type-options")).toBe("nosniff");
      expectBytes(await bytesOf(fallback), preview);

      expectBytes(await bytesOf(await image(app, alice.account.token, `/m/${id}?w=64`)), preview);
      expectBytes(await bytesOf(await image(app, alice.account.token, `/m/${id}?w=800`)), preview);
      expectBytes(await bytesOf(await image(app, alice.account.token, `/m/${id}?w=801`)), full);
      expectBytes(await bytesOf(await image(app, alice.account.token, `/m/${id}?w=4096`)), full);
      expect((await image(app, alice.account.token, `/m/${id}?w=nope`)).status).toBe(200);
    } finally {
      app.close();
    }
  });

  test("oversized, wrong-type, wrong-dimension and incomplete uploads are rejected clearly", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", mediaQuotaBytes: 10_000_000 });
    try {
      const alice = await client(app, "alice");
      const tooBig = vp8l(MEDIA_PREVIEW_EDGE, 200, 400 * 1024);
      const oversized = await upload(app, alice.account.token, tooBig, vp8l(1280, 800));
      expect(oversized.status).toBe(413);
      expect(oversized.body).toMatchObject({ code: "too_large", variant: "preview", limit: 400 * 1024 });

      const wrongType = await upload(app, alice.account.token, PNG_LIKE, PNG_LIKE);
      expect(wrongType.status).toBe(415);
      expect(wrongType.body).toMatchObject({ code: "not_webp" });

      const previewTooWide = await upload(app, alice.account.token, vp8l(400, 200), vp8l(1280, 800));
      expect(previewTooWide.status).toBe(422);
      expect(previewTooWide.body).toMatchObject({
        code: "dimensions",
        variant: "preview",
        width: 400,
        maxEdge: MEDIA_PREVIEW_EDGE,
      });

      const fullTooWide = await upload(app, alice.account.token, vp8l(320, 200), vp8l(1600, 900));
      expect(fullTooWide.status).toBe(422);
      expect(fullTooWide.body).toMatchObject({ code: "dimensions", variant: "full", maxEdge: MEDIA_FULL_EDGE });

      const squashed = await upload(app, alice.account.token, vp8l(320, 200), vp8l(1280, 200));
      expect(squashed.status).toBe(422);
      expect(squashed.body).toMatchObject({ code: "dimensions" });

      const form = new FormData();
      form.set("preview", new Blob([vp8l(320, 200)], { type: "image/webp" }), "preview.webp");
      const missing = await app.fetch(
        new Request("http://chat.local/m", {
          method: "POST",
          headers: { Authorization: `Bearer ${alice.account.token}` },
          body: form,
        }),
      );
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as Record<string, unknown>).code).toBe("missing_variant");

      const notMultipart = await app.fetch(
        new Request("http://chat.local/m", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${alice.account.token}` },
          body: vp8l(320, 200),
        }),
      );
      expect(notMultipart.status).toBe(415);
      expect(((await notMultipart.json()) as Record<string, unknown>).code).toBe("bad_body");

      const count = app.db.query("SELECT COUNT(*) AS n FROM media").get() as { n: number };
      expect(Number(count.n)).toBe(0);
    } finally {
      app.close();
    }
  });

  test("the server quota rejects with 507 and a deleted post gives the bytes back", async () => {
    const preview = vp8l(320, 200);
    const full = vp8l(1280, 800);
    const oneImage = preview.byteLength + full.byteLength;
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", mediaQuotaBytes: oneImage });
    try {
      const alice = await client(app, "alice");
      const group = await makeGroup(app, alice);
      const first = await uploadOk(app, alice.account.token, preview, full);

      const over = await upload(app, alice.account.token, preview, full);
      expect(over.status).toBe(507);
      expect(over.body).toMatchObject({ code: "quota", limit: oneImage, used: oneImage });

      const c = cid();
      const posted = await sync(app, alice.account.token, alice.cursor, [
        postOp(c, group, "photo", mediaFor(first)),
      ]);
      seqOf(posted, c);

      const removed = cid();
      await sync(app, alice.account.token, posted.cursor, [
        { cid: removed, tag: Tag.Delete, scope: group, target: seqOf(posted, c) },
      ]);
      expect((await image(app, alice.account.token, `/m/${first}`)).status).toBe(404);
      await uploadOk(app, alice.account.token, preview, full);
    } finally {
      app.close();
    }
  });

  test("uploading and fetching require a signed-in, finished account", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const anonUpload = await app.fetch(new Request("http://chat.local/m", { method: "POST" }));
      expect(anonUpload.status).toBe(401);
      expect((await app.fetch(new Request("http://chat.local/m/1"))).status).toBe(401);

      const alice = await client(app, "alice");
      const id = await uploadOk(app, alice.account.token);
      expect((await image(app, alice.account.token, `/m/${id + 999}`)).status).toBe(404);
    } finally {
      app.close();
    }
  });

  test("an upload that is never posted expires and gives its quota back", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", mediaQuotaBytes: 10_000_000 });
    try {
      const alice = await client(app, "alice");
      const stale = await uploadOk(app, alice.account.token);
      app.db
        .query("UPDATE media SET created_at = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000) - 2 * 60 * 60, stale);

      // The hour is up, even before another upload happens to prune the row.
      expect((await image(app, alice.account.token, `/m/${stale}`)).status).toBe(404);

      const fresh = await uploadOk(app, alice.account.token);
      expect((await image(app, alice.account.token, `/m/${fresh}`)).status).toBe(200);
      const count = app.db.query("SELECT COUNT(*) AS n FROM media").get() as { n: number };
      expect(Number(count.n)).toBe(1);
    } finally {
      app.close();
    }
  });
});

describe("media in posts, replies and DMs", () => {
  test("a post carries only the placeholder; a non-member and a blocked viewer cannot fetch the bytes", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", mediaQuotaBytes: 10_000_000 });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const group = await makeGroup(app, alice);
      const preview = vp8l(320, 200, 2_000);
      const full = vp8l(1280, 800, 3_000);
      const id = await uploadOk(app, alice.account.token, preview, full);

      const thumbhash = new Uint8Array(25).fill(3);
      const media: Media = { id, w: 1280, h: 800, thumbhash };
      const c = cid();
      const posted = await sync(app, alice.account.token, alice.cursor, [postOp(c, group, "", media)]);
      const postSeq = seqOf(posted, c);

      // The bytes never travel inline: the whole sync response is smaller than the image.
      const wire = encodeSyncResponse(posted);
      expect(wire.byteLength).toBeLessThan(preview.byteLength + full.byteLength);
      const event = posted.events.find((row) => row.seq === postSeq);
      expect(event).toMatchObject({ tag: Tag.Post, text: "", media: { id, w: 1280, h: 800 } });
      if (!event || event.tag !== Tag.Post || !event.media) throw new Error("post event missing media");
      expect([...event.media.thumbhash]).toEqual([...thumbhash]);

      // A non-member cannot fetch what it was never sent.
      expect((await image(app, bob.account.token, `/m/${id}`)).status).toBe(404);

      await join(app, bob, group);
      const joined = await sync(app, bob.account.token, bob.cursor);
      expectBytes(await bytesOf(await image(app, bob.account.token, `/m/${id}?w=1280`)), full);
      expect(joined.events.some((row) => row.seq === postSeq)).toBe(false); // no back history

      const block = cid();
      await sync(app, bob.account.token, joined.cursor, [
        { cid: block, tag: Tag.Block, scope: 0, user: alice.wire, on: true },
      ]);
      expect((await image(app, bob.account.token, `/m/${id}`)).status).toBe(404);
    } finally {
      app.close();
    }
  });

  test("an upload can only be attached once, by its owner, with the measured dimensions", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", mediaQuotaBytes: 10_000_000 });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const group = await makeGroup(app, alice);
      await join(app, bob, group);
      const id = await uploadOk(app, alice.account.token);

      const foreign = cid();
      const stolen = await sync(app, bob.account.token, bob.cursor, [postOp(foreign, group, "mine now", mediaFor(id))]);
      expect(errorOf(stolen, foreign)).toBe(AckError.NotFound);

      const wrongDims = cid();
      const dims = await sync(app, alice.account.token, alice.cursor, [
        postOp(wrongDims, group, "lying", { ...mediaFor(id), w: 640, h: 480 }),
      ]);
      expect(errorOf(dims, wrongDims)).toBe(AckError.Invalid);

      const first = cid();
      const posted = await sync(app, alice.account.token, alice.cursor, [postOp(first, group, "once", mediaFor(id))]);
      seqOf(posted, first);

      const again = cid();
      const reused = await sync(app, alice.account.token, posted.cursor, [postOp(again, group, "twice", mediaFor(id))]);
      expect(errorOf(reused, again)).toBe(AckError.NotFound);
      expect((await image(app, bob.account.token, `/m/${id}`)).status).toBe(200);

      // The product placeholder budget is 25 bytes, even though the v1 decoder accepts 32.
      const fatId = await uploadOk(app, alice.account.token);
      const fat = cid();
      const fatHash = await sync(app, alice.account.token, reused.cursor, [
        postOp(fat, group, "fat hash", { ...mediaFor(fatId), thumbhash: new Uint8Array(26).fill(1) }),
      ]);
      expect(errorOf(fatHash, fat)).toBe(AckError.Invalid);
    } finally {
      app.close();
    }
  });

  test("image-only posts, replies and DMs are accepted; empty both is still Invalid", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", mediaQuotaBytes: 10_000_000 });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const group = await makeGroup(app, alice);
      await join(app, bob, group);

      const postId = await uploadOk(app, alice.account.token);
      const postCid = cid();
      const posted = await sync(app, alice.account.token, alice.cursor, [
        postOp(postCid, group, "", mediaFor(postId)),
      ]);
      const postSeq = seqOf(posted, postCid);

      const replyId = await uploadOk(app, alice.account.token);
      const replyCid = cid();
      const replied = await sync(app, alice.account.token, posted.cursor, [
        { cid: replyCid, tag: Tag.Reply, scope: group, parent: postSeq, text: "", media: mediaFor(replyId) },
      ]);
      seqOf(replied, replyCid);

      const emptyCid = cid();
      const empty = await sync(app, alice.account.token, replied.cursor, [postOp(emptyCid, group, "", null)]);
      expect(errorOf(empty, emptyCid)).toBe(AckError.Invalid);

      const dmId = await uploadOk(app, alice.account.token);
      const dmCid = cid();
      const dm = await sync(app, alice.account.token, empty.cursor, [
        { cid: dmCid, tag: Tag.Dm, scope: 0, peer: bob.wire, text: "", media: mediaFor(dmId) },
      ]);
      const dmSeq = seqOf(dm, dmCid);
      const scope = dm.events.find((row) => row.seq === dmSeq)?.scope;
      expect(scope).toBeDefined();
      if (scope === undefined) throw new Error("DM scope missing");

      const bobSync = await sync(app, bob.account.token, bob.cursor);
      const dmEvent = bobSync.events.find((row): row is Extract<Event, { tag: typeof Tag.Dm }> => row.tag === Tag.Dm);
      expect(dmEvent?.media?.id).toBe(dmId);
      expect((await image(app, bob.account.token, `/m/${dmId}`)).status).toBe(200);
      const carol = await client(app, "carol");
      expect((await image(app, carol.account.token, `/m/${dmId}`)).status).toBe(404);
    } finally {
      app.close();
    }
  });
});
