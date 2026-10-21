// The browser's online event is the only signal that a queued outbox can drain again.
// Kept tiny and injectable so the behavior is testable without a window or a DOM.

/** The part of an event target this module needs. */
export type OnlineSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Calls `listener` whenever `source` reports that the network is back. Returns an
 * unsubscribe function. A missing source (a test, a worker without a window) is a no-op.
 */
export function watchOnline(source: OnlineSource | null | undefined, listener: () => void): () => void {
  if (!source) return () => {};
  source.addEventListener("online", listener);
  return () => {
    source.removeEventListener("online", listener);
  };
}
