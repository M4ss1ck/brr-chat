// Synthetic chat corpus shared by the protocol's byte-budget fixture and the server's
// /sync compression dictionary (issue #21, ADR 0021). This is fixture data, not wire code:
// it never ships to a client, and both users must stay on the same generator so the
// dictionary benchmark keeps measuring the fixture the project calls representative.
import { Tag, type Event } from "./events.ts";

export const SAMPLE_WORDS =
  "hola que tal mañana vamos al malecón la guagua no llega otra vez se fue la luz alguien tiene datos the meeting moved to friday bring water photos later ok jaja dale nos vemos".split(
    " ",
  );

/** Deterministic, realistic-ish Spanish/English chat text, 20..220 chars. */
export function sampleText(i: number): string {
  let s = "";
  let x = (i * 2654435761) >>> 0;
  const len = 20 + (x % 200);
  while (s.length < len) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += (s ? " " : "") + SAMPLE_WORDS[x % SAMPLE_WORDS.length];
  }
  return s;
}

/** `count` posts starting at `offset`, with the framing a real /sync response carries. */
export function samplePosts(count: number, offset = 0): Event[] {
  return Array.from({ length: count }, (_, i) => ({
    tag: Tag.Post,
    seq: 1_000_000 + offset + i,
    ts: 1_791_000_000 + i * 37,
    author: 100 + (i % 12),
    scope: 5 + (i % 4),
    text: sampleText(offset + i),
    media: null,
  }));
}

/** The byte-budget fixture from docs/PROTOCOL.md. */
export function hundredPosts(): Event[] {
  return samplePosts(100);
}
