// Fixture sources for the CURRENT protocol version. freeze-fixtures.ts writes each one to
// fixtures/v<N>/<name>.hex + <name>.json once and never overwrites. Old versions' files are
// the compatibility contract: test/fixtures.test.ts decodes all of them forever.
import { AckError, ResponseError, SUPPORTED, Tag, type Event } from "../src/index.ts";
import {
  encodeHistoryRequest,
  encodeHistoryResponse,
  encodeSyncRequest,
  encodeSyncResponse,
} from "../src/index.ts";

const th = Uint8Array.from([0x1b, 0x08, 0x0e, 0x0d, 0x82, 0x78, 0x77, 0x87, 0x78, 0x87, 0x77, 0x88, 0x77, 0x88, 0x07, 0x78, 0x08, 0x87, 0x87, 0x88, 0x88]);
const cidA = Uint8Array.from([0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8]);
const cidB = Uint8Array.from([0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8]);
const h = (seq: number) => ({ seq, ts: 1_791_000_000 + seq, author: 42, scope: 7 });

const everyEvent: Event[] = [
  { ...h(1), tag: Tag.GroupMeta, name: "La Habana", about: "Grupo abierto", open: true },
  { ...h(2), tag: Tag.Membership, user: 42, role: 3 },
  { ...h(3), scope: 0, tag: Tag.Profile, username: "ana", displayName: "Ana 🌴", bio: "hola" },
  { ...h(4), tag: Tag.Post, text: "¿Alguien tiene luz?", media: null },
  { ...h(5), tag: Tag.Post, text: "foto del malecón", media: { id: 31, w: 1280, h: 960, thumbhash: th } },
  { ...h(6), tag: Tag.Reply, parent: 4, text: "aquí sí", media: null },
  { ...h(7), tag: Tag.Reaction, target: 4, emoji: 2, on: true },
  { ...h(8), scope: 9, tag: Tag.Dm, peer: 43, text: "psst", media: null },
  { ...h(9), tag: Tag.Delete, target: 6 },
  { ...h(10), tag: Tag.Ban, user: 66, on: true },
  { ...h(11), author: 1, tag: Tag.ScopeLeft, purge: true },
  { ...h(12), author: 0, tag: Tag.Gap, after: 12, before: 900, count: 340 },
];

export const fixtures: Record<string, Uint8Array> = {
  "sync-request-empty": encodeSyncRequest({ v: 1, cursor: 0, outbox: [] }),
  "sync-request-outbox": encodeSyncRequest({
    v: 1,
    cursor: 12,
    outbox: [
      { cid: cidA, scope: 7, tag: Tag.Post, text: "nuevo post", media: null },
      { cid: cidB, scope: 0, tag: Tag.Dm, peer: 43, text: "primer dm", media: null },
    ],
  }),
  "sync-response-empty": encodeSyncResponse({ range: SUPPORTED, cursor: 12, more: false, events: [], acks: [], skipped: 0 }),
  "sync-response-every-event": encodeSyncResponse({
    range: SUPPORTED,
    cursor: 12,
    more: true,
    events: everyEvent,
    acks: [{ cid: cidA, seq: 4 }, { cid: cidB, error: AckError.Forbidden }],
    skipped: 0,
  }),
  "sync-response-upgrade": encodeSyncResponse({
    range: SUPPORTED, cursor: 0, more: false, events: [], acks: [], skipped: 0, error: ResponseError.ClientTooOld,
  }),
  "history-request": encodeHistoryRequest({ v: 1, scope: 7, before: 500, limit: 30 }),
  "history-response": encodeHistoryResponse({ range: SUPPORTED, events: everyEvent.slice(3, 6), more: true, skipped: 0 }),
};
