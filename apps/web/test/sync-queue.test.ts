// The queue in front of every sync. Its job is ordering, not timing: a call made while a
// request is in flight must get a later run, because the earlier request predates its op.
import { describe, expect, test } from "bun:test";
import { createSyncQueue } from "../src/sync-queue.ts";

describe("sync queue", () => {
  test("calls run one at a time, in call order, even when they arrive together", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const sync = createSyncQueue(async () => {
      const mine = ++calls;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return mine;
    });

    const results = await Promise.all([sync(), sync(), sync()]);
    expect(maxActive).toBe(1);
    expect(results).toEqual([1, 2, 3]);
  });

  test("a failed sync does not wedge the calls queued behind it", async () => {
    let calls = 0;
    const sync = createSyncQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error("dropped");
      return calls;
    });

    const first = sync();
    const second = sync();
    await expect(first).rejects.toThrow(/dropped/);
    expect(await second).toBe(2);
  });
});
