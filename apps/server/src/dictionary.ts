// dcz shared-dictionary compression for /sync (issue #21, ADR 0021).
//
// The dictionary is RFC 9842's "common content" case (§1.1.2): a synthetic sample of the
// traffic every /sync carries (event framing, chat text, a group state snapshot), so phrases
// the community repeats cost a short offset instead of literal bytes.
//
// It is generated from the same deterministic Spanish/English corpus the protocol's 100-post
// byte fixture uses, with indices that do not overlap the fixture. No user content is ever
// put into it: the file is public and every client that asks gets the same bytes.
import { createHash } from "node:crypto";
import { brotliCompressSync, constants, zstdCompressSync } from "node:zlib";
import { Role, SUPPORTED, Tag, encodeSyncResponse, type Event } from "@brr-chat/protocol";
import { samplePosts } from "@brr-chat/protocol/sample-corpus";

export const SYNC_DICTIONARY_ID = "brr-sync-v1";
/**
 * The id is in the path because the cache headers are immutable for a year: changing the
 * dictionary bytes means a new id and a new URL, so no client can keep a stale dictionary
 * under a URL the server is still advertising.
 */
export const SYNC_DICTIONARY_PATH = `/sync-dict/${SYNC_DICTIONARY_ID}`;

/** RFC 9842 §5: 8-byte magic (a zstd skippable frame) then the SHA-256 of the dictionary. */
export const DCZ_MAGIC = Uint8Array.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]);
export const DCZ_HEADER_BYTES = 40;

/**
 * The response header pair a dictionary-compressed body needs. `Vary` is part of the
 * negotiation cost, so the size comparison in sync.ts counts these bytes.
 */
export const DICTIONARY_VARY = "Accept-Encoding, Available-Dictionary";
export const DICTIONARY_VARY_BYTES = Buffer.byteLength(`Vary: ${DICTIONARY_VARY}\r\n`);

/** zstd level 15: the same bytes as 19 on these payloads at a fraction of the time. */
const ZSTD_LEVEL = 15;

/** A sample of the state a fresh device receives, then 100 posts. */
function dictionaryBytes(): Uint8Array {
  const state: Event[] = [
    { seq: 500, ts: 1_790_000_000, author: 3, scope: 5, tag: Tag.GroupMeta, name: "La Habana", about: "Grupo abierto", open: true },
    { seq: 501, ts: 1_790_000_001, author: 3, scope: 5, tag: Tag.Membership, user: 42, role: Role.Member },
    { seq: 502, ts: 1_790_000_002, author: 0, scope: 42, tag: Tag.Profile, username: "ana", displayName: "Ana", bio: "hola" },
    { seq: 503, ts: 1_790_000_003, author: 0, scope: 504, tag: Tag.DmScope, peer: 43 },
  ];
  // Indices 1000..1099 do not overlap the byte fixture's 0..99, so the benchmark measures
  // the dictionary generalizing, not memorizing the fixture.
  const posts = samplePosts(100, 1000);
  return encodeSyncResponse({
    range: SUPPORTED,
    cursor: 1_000_000 + 1000 + 99,
    more: false,
    events: [...state, ...posts],
    acks: [],
    skipped: 0,
  });
}

/** The bytes every client fetches from /sync-dict and hashes. */
export const SYNC_DICTIONARY = dictionaryBytes() as Uint8Array<ArrayBuffer>;

const dictionaryCompressed = new Uint8Array(brotliCompressSync(SYNC_DICTIONARY)) as Uint8Array<ArrayBuffer>;

/** SHA-256 of the dictionary contents, the value the client sends in Available-Dictionary. */
const SYNC_DICTIONARY_HASH = new Uint8Array(createHash("sha256").update(SYNC_DICTIONARY).digest());
export const SYNC_DICTIONARY_HASH_B64 = Buffer.from(SYNC_DICTIONARY_HASH).toString("base64");

/** The URL pattern the dictionary covers: /sync, not the dictionary's own path. */
const SYNC_DICTIONARY_MATCH = "/sync";

/** What Chrome shows in DevTools, and what the server matches requests against. */
const USE_AS_DICTIONARY = `match="${SYNC_DICTIONARY_MATCH}", id="${SYNC_DICTIONARY_ID}"`;

function acceptsEncoding(header: string | null, name: string): boolean {
  if (header === null) return false;
  for (const part of header.split(",")) {
    const [token, ...params] = part.split(";").map((p) => p.trim().toLowerCase());
    if (token !== name) continue;
    const q = params.find((p) => p.startsWith("q="));
    if (q === undefined) return true;
    const weight = Number(q.slice(2));
    return Number.isFinite(weight) && weight > 0;
  }
  return false;
}

/** `Available-Dictionary` is a structured-field byte sequence: `:base64:`. */
function availableDictionary(header: string | null): string | null {
  if (header === null) return null;
  const match = /^:([A-Za-z0-9+/]+={0,2}):$/.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * True only when the client says it has *this* dictionary: `dcz` in Accept-Encoding, the
 * matching SHA-256, and (when it sends one) the matching opaque id. Anything else keeps
 * brotli, so an unknown, stale or stripped dictionary can never corrupt a response.
 */
export function wantsDictionary(req: Request): boolean {
  if (!acceptsEncoding(req.headers.get("accept-encoding"), "dcz")) return false;
  if (availableDictionary(req.headers.get("available-dictionary")) !== SYNC_DICTIONARY_HASH_B64) return false;
  const id = req.headers.get("dictionary-id");
  if (id !== null && id.trim().replace(/^"|"$/g, "") !== SYNC_DICTIONARY_ID) return false;
  return true;
}

/** RFC 9842 §5: magic + SHA-256 header, then a zstd stream primed with the raw dictionary. */
export function dczCompress(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const zstd = zstdCompressSync(bytes, {
    // The dictionary is raw content, not a trained ZSTD dictionary (RFC 9842 §5).
    dictionary: SYNC_DICTIONARY,
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });
  const out = new Uint8Array(DCZ_HEADER_BYTES + zstd.byteLength);
  out.set(DCZ_MAGIC, 0);
  out.set(SYNC_DICTIONARY_HASH, DCZ_MAGIC.byteLength);
  out.set(new Uint8Array(zstd.buffer, zstd.byteOffset, zstd.byteLength), DCZ_HEADER_BYTES);
  return out;
}

/**
 * GET/HEAD /sync-dict/<id>. Public on purpose: the browser fetches it on its own, at low
 * priority, and without a session. Fresh for a year and immutable; the id in the path is
 * what lets a new dictionary be a new URL (see SYNC_DICTIONARY_PATH).
 */
export function serveSyncDictionary(req: Request, pathname: string): Response | null {
  if (pathname !== SYNC_DICTIONARY_PATH) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const brotli = acceptsEncoding(req.headers.get("accept-encoding"), "br");
  const body = brotli ? dictionaryCompressed : SYNC_DICTIONARY;
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    // RFC 9842 §2.1: the response that defines a dictionary must declare what it is for.
    "Use-As-Dictionary": USE_AS_DICTIONARY,
    // Fresh for a year (RFC 9842 §2.2.1 requires freshness for a dictionary to match).
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
    "Content-Length": String(body.byteLength),
  };
  if (brotli) headers["Content-Encoding"] = "br";
  return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
}
