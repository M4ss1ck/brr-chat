// The client half of /sync paging: one press of "Sync" catches up through every page the
// server says `more` for, without resending the outbox on the later requests.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  Tag,
  decodeSyncRequest,
  encodeSyncResponse,
  type Event,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import {
  closeStore,
  enqueueOp,
  getCursor,
  getFailedOps,
  getOutbox,
  getPendingOps,
  setCursor,
} from "../src/store.ts";
import { drainOutbox, syncAndPersist } from "../src/sync.ts";

const originalFetch = globalThis.fetch;

function profile(seq: number, author: number): Event {
  return { tag: Tag.Profile, seq, ts: 1, author, scope: 0, username: `u${author}`, displayName: `u${author}`, bio: "" };
}

function response(page: Partial<SyncResponse> & Pick<SyncResponse, "cursor" | "more" | "events">): Response {
  const body: SyncResponse = {
    range: { min: 1, max: 1 },
    acks: [],
    skipped: 0,
    ...page,
  };
  return new Response(encodeSyncResponse(body) as unknown as BodyInit, {
    status: 200,
    headers: { "Content-Type": "application/cbor" },
  });
}

/** Sync now goes through the data meter, which hands the mock a Request, not raw init. */
async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Uint8Array> {
  if (input instanceof Request) return new Uint8Array(await input.clone().arrayBuffer());
  return new Uint8Array((init?.body as Uint8Array | undefined) ?? new Uint8Array());
}

describe("syncAndPersist paging", () => {
  const originalIndexedDB = globalThis.indexedDB;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await closeStore();
  });

  afterAll(() => {
    globalThis.indexedDB = originalIndexedDB;
  });

  test("loops until more is false, applying every page, and sends the outbox only once", async () => {
    const cursors: number[] = [];
    const outboxSizes: number[] = [];
    const op: Op = {
      cid: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      tag: Tag.Profile,
      scope: 0,
      username: "alice",
      displayName: "alice",
      bio: "",
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = decodeSyncRequest(await requestBody(input, init));
      cursors.push(request.cursor);
      outboxSizes.push(request.outbox.length);
      return request.cursor === 0
        ? response({ cursor: 2, more: true, events: [profile(2, 7)], acks: [{ cid: op.cid, seq: 2 }] })
        : response({ cursor: 5, more: false, events: [profile(5, 8)] });
    }) as unknown as typeof fetch;

    await setCursor("alice", 0);
    const outcome = await syncAndPersist("http://chat.local", "token", "alice", [op]);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected an in-range response");

    expect(cursors).toEqual([0, 2]);
    expect(outboxSizes).toEqual([1, 0]);
    expect(outcome.response.more).toBe(false);
    expect(outcome.response.cursor).toBe(5);
    expect(outcome.response.events.map((event) => event.seq)).toEqual([2, 5]);
    expect(outcome.response.acks).toEqual([{ cid: op.cid, seq: 2 }]);
    expect(await getCursor("alice")).toBe(5);
  });

  test("an out-of-range answer stops the loop and reports the server range", async () => {
    let calls = 0;
    // A response with an error is the upgrade signal; the loop must not call again.
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        encodeSyncResponse({
          range: { min: 2, max: 3 },
          cursor: 0,
          more: false,
          events: [],
          acks: [],
          skipped: 0,
          error: 1,
        }) as unknown as BodyInit,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const outcome = await syncAndPersist("http://chat.local", "token", "alice");
    expect(outcome).toEqual({ kind: "upgrade", error: 1, range: { min: 2, max: 3 } });
    expect(calls).toBe(1);
  });

  test("a server that says more without moving the cursor fails instead of looping", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return response({ cursor: 0, more: true, events: [] });
    }) as unknown as typeof fetch;

    await setCursor("alice", 0);
    await expect(syncAndPersist("http://chat.local", "token", "alice")).rejects.toThrow(/sync stalled/);
    expect(calls).toBe(1);
  });

  test("queued ops survive an offline restart and drain once the network returns", async () => {
    await setCursor("alice", 0);
    const queued = await enqueueOp("alice", { tag: Tag.Post, scope: 7, text: "written offline" });

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    await expect(drainOutbox("http://chat.local", "token", "alice")).rejects.toThrow(/offline/);
    expect((await getPendingOps("alice")).map((op) => op.cid)).toEqual([queued.cid]);

    // A closed IndexedDB handle is what a browser restart looks like to the store.
    await closeStore();
    expect((await getPendingOps("alice")).map((op) => op.text)).toEqual(["written offline"]);

    const outboxSizes: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = decodeSyncRequest(await requestBody(input, init));
      outboxSizes.push(request.outbox.length);
      return response({
        cursor: 9,
        more: false,
        events: [profile(9, 7)],
        acks: [{ cid: new Uint8Array(queued.cid), seq: 9 }],
      });
    }) as unknown as typeof fetch;

    const drained = await drainOutbox("http://chat.local", "token", "alice");
    expect(drained.outcome.kind).toBe("ok");
    expect(drained.failed).toEqual([]);
    expect(outboxSizes).toEqual([1]);
    expect(await getOutbox("alice")).toEqual([]);
    expect(await getCursor("alice")).toBe(9);
  });

  test("a NotFound ack marks the draft failed and never puts it back on the wire", async () => {
    await setCursor("alice", 0);
    const reply = await enqueueOp("alice", { tag: Tag.Reply, scope: 7, parent: 4, text: "parent is gone" });
    const outboxSizes: number[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = decodeSyncRequest(await requestBody(input, init));
      outboxSizes.push(request.outbox.length);
      return response({
        cursor: 12,
        more: false,
        events: [],
        acks: [{ cid: new Uint8Array(reply.cid), error: 4 }],
      });
    }) as unknown as typeof fetch;

    const first = await drainOutbox("http://chat.local", "token", "alice");
    expect(first.failed.map((op) => op.text)).toEqual(["parent is gone"]);
    expect((await getFailedOps("alice")).map((op) => op.text)).toEqual(["parent is gone"]);

    // The next sync still asks for events, but carries no ops: the dead reply cannot block
    // newer posts, and it cannot be sent again either.
    await drainOutbox("http://chat.local", "token", "alice");
    expect(outboxSizes).toEqual([1, 0]);
    expect(await getPendingOps("alice")).toEqual([]);
  });
});
