// Syncs are serialized: an op queued while a request is already on the wire was not in that
// request, so the caller needs its own run afterwards. Coalescing calls into the in-flight
// promise would lose that op. This also keeps the online event from overlapping a tap.

/** Wraps a sync function so calls run one at a time, in call order. */
export function createSyncQueue<T>(run: () => Promise<T>): () => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return () => {
    // Run whether the previous sync succeeded or failed: one bad request must not wedge
    // every later drain.
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}
