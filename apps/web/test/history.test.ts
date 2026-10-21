// The client half of /history: one explicit tap fetches older events into the same cache,
// without moving the sync cursor.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  Tag,
  decodeHistoryRequest,
  encodeHistoryResponse,
  type Event,
  type HistoryResponse,
} from "@brr-chat/protocol";
import { applyEvents, closeStore, getCursor, getGaps, getPosts, setCursor } from "../src/store.ts";
import { HistoryHttpError, advanceGaps, loadHistory } from "../src/history.ts";

const originalFetch = globalThis.fetch;
const account = { server: "http://chat.local", token: "token", username: "alice" };

function post(seq: number, text: string): Event {
  return { tag: Tag.Post, seq, ts: seq, author: 9, scope: 3, text, media: null };
}

function historyResponse(page: Partial<HistoryResponse> & Pick<HistoryResponse, "events" | "more">): Response {
  return new Response(
    encodeHistoryResponse({ range: { min: 1, max: 1 }, skipped: 0, ...page }) as unknown as BodyInit,
    { status: 200, headers: { "Content-Type": "application/cbor" } },
  );
}

/** History now goes through the data meter, which hands the mock a Request, not raw init. */
async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Uint8Array> {
  if (input instanceof Request) return new Uint8Array(await input.clone().arrayBuffer());
  return new Uint8Array((init?.body as Uint8Array | undefined) ?? new Uint8Array());
}

describe("loadHistory", () => {
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

  test("asks for one page before the oldest cached event and caches it", async () => {
    await applyEvents(account, [post(50, "newer")]);
    await setCursor(account, 100);

    const requests: ReturnType<typeof decodeHistoryRequest>[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(decodeHistoryRequest(await requestBody(input, init)));
      return historyResponse({ events: [post(40, "older")], more: true });
    }) as unknown as typeof fetch;

    const outcome = await loadHistory(account, 3, 50);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected an in-range response");

    expect(requests).toEqual([{ v: 1, scope: 3, before: 50, limit: 100 }]);
    expect(outcome.response.more).toBe(true);
    expect((await getPosts(account, 3)).map((row) => row.text)).toEqual(["older", "newer"]);
    // History is reading, not catch-up: the sync cursor must not move.
    expect(await getCursor(account)).toBe(100);
  });

  test("a page fetched into a full cache is shown, not evicted by its own write", async () => {
    const full: Event[] = Array.from({ length: 2000 }, (_, index) => post(5_001 + index, `cached ${index + 1}`));
    await applyEvents(account, full);

    globalThis.fetch = (async () =>
      historyResponse({ events: [post(4_901, "older 1"), post(4_902, "older 2")], more: false })) as unknown as typeof fetch;
    await loadHistory(account, 3, 5_001);

    const rows = await getPosts(account, 3);
    expect(rows).toHaveLength(2000);
    expect(rows.map((row) => row.text)).toContain("older 1");
    expect(rows.map((row) => row.text)).toContain("older 2");
    expect(rows.map((row) => row.text)).not.toContain("cached 1");
  });

  test("a refused request surfaces the HTTP status", async () => {
    globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(loadHistory(account, 3, 50)).rejects.toBeInstanceOf(HistoryHttpError);
  });

  test("a gap marker is cached and a retried sync cannot duplicate the hole", async () => {
    const gap: Event = { tag: Tag.Gap, seq: 50, ts: 1, author: 0, scope: 3, after: 10, before: 50, count: 39 };
    await applyEvents(account, [gap]);
    await applyEvents(account, [gap]);
    expect(await getGaps(account, 3)).toEqual([{ scope: 3, after: 10, before: 50, count: 39, seq: 50 }]);
  });

  test("a page shrinks the hole it filled and closes it at the hole's bottom", async () => {
    const hole = { scope: 3, after: 100, before: 200, count: 50, seq: 150 };

    // Two content events off the top: the next tap starts at the oldest returned seq.
    const partial = advanceGaps([hole], {
      range: { min: 1, max: 1 },
      events: [post(180, "a"), post(160, "b")],
      more: true,
      skipped: 0,
    });
    expect(partial).toMatchObject([{ after: 100, before: 160, count: 48 }]);

    // Reaching or passing `after` closes it; no older events closes it too.
    const reached = advanceGaps([hole], {
      range: { min: 1, max: 1 },
      events: [post(95, "c")],
      more: true,
      skipped: 0,
    });
    expect(reached).toEqual([]);
    const exhausted = advanceGaps([hole], { range: { min: 1, max: 1 }, events: [], more: false, skipped: 0 });
    expect(exhausted).toEqual([]);
  });
});
