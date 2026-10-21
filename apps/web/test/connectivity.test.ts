// The browser tells the app when the link comes back. This is the seam between that event
// and the sync loop, tested without a DOM or a real browser.
import { describe, expect, test } from "bun:test";
import { watchOnline } from "../src/connectivity.ts";

describe("connectivity", () => {
  test("an online event runs the queued handler until it is unsubscribed", () => {
    const target = new EventTarget();
    let runs = 0;
    const stop = watchOnline(target, () => {
      runs += 1;
    });

    target.dispatchEvent(new Event("online"));
    expect(runs).toBe(1);
    target.dispatchEvent(new Event("online"));
    expect(runs).toBe(2);

    stop();
    target.dispatchEvent(new Event("online"));
    expect(runs).toBe(2);
  });

  test("a target without addEventListener is a safe no-op", () => {
    const stop = watchOnline(undefined, () => {
      throw new Error("must not run without a source");
    });
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
