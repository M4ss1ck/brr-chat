// Media storage and validation without re-encoding (ADR 0011). The server trusts the
// client's WebP bytes, so it checks the container header, the dimensions and the byte cap
// exactly once on upload; the image itself is never decoded here.
import type { Database } from "bun:sqlite";

export type AttachResult = "ok" | "notfound" | "invalid";

export interface WebpInfo {
  width: number;
  height: number;
  format: "VP8" | "VP8L" | "VP8X";
}

/** Default total media bytes one server keeps. A single binary must not fill the disk. */
export const DEFAULT_MEDIA_QUOTA_BYTES = 256 * 1024 * 1024;
/** An upload that is never posted is garbage after this long, and its quota goes back. */
export const UNATTACHED_MEDIA_TTL_SECONDS = 60 * 60;

export interface MediaRow {
  id: number;
  owner: number;
  preview: Uint8Array;
  preview_width: number;
  preview_height: number;
  full: Uint8Array;
  full_width: number;
  full_height: number;
  bytes: number;
  created_at: number;
  event_seq: number | null;
}

export interface NewMedia {
  owner: number;
  preview: Uint8Array;
  previewWidth: number;
  previewHeight: number;
  full: Uint8Array;
  fullWidth: number;
  fullHeight: number;
}

export type InsertMediaResult =
  | { ok: true; media: MediaRow }
  | { ok: false; used: number; limit: number };

function ascii(bytes: Uint8Array, offset: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Reads the dimensions out of a WebP container. Handles the three bitstreams a browser
 * encoder emits: `VP8 ` (lossy), `VP8L` (lossless) and `VP8X` (extended). Null means this
 * is not a WebP file we can validate, so the upload is rejected.
 */
export function inspectWebp(bytes: Uint8Array): WebpInfo | null {
  // RIFF header, "WEBP", one chunk header, then at least the smallest chunk payload.
  if (bytes.length < 25) return null;
  if (ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WEBP") return null;
  const riffSize = u32le(bytes, 4);
  // The RIFF size counts everything after byte 8. A truncated file is not a valid upload.
  if (riffSize + 8 > bytes.length) return null;

  const fourcc = ascii(bytes, 12);
  const chunkSize = u32le(bytes, 16);
  if (chunkSize > bytes.length - 20) return null;

  if (fourcc === "VP8 ") {
    // Key-frame header: 3-byte frame tag, the 3-byte sync code 9d 01 2a, then 14-bit dims.
    if (chunkSize < 10) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
      format: "VP8",
    };
  }

  if (fourcc === "VP8L") {
    if (chunkSize < 5 || bytes[20] !== 0x2f) return null;
    const bits = u32le(bytes, 21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      format: "VP8L",
    };
  }

  if (fourcc === "VP8X") {
    if (chunkSize < 10) return null;
    return {
      width: u24le(bytes, 24) + 1,
      height: u24le(bytes, 27) + 1,
      format: "VP8X",
    };
  }

  return null;
}

export function mediaUsage(db: Database): number {
  const row = db.query("SELECT COALESCE(SUM(bytes), 0) AS used FROM media").get() as { used: number } | null;
  return Number(row?.used ?? 0);
}

export function mediaFor(db: Database, id: number): MediaRow | null {
  return db
    .query(
      `SELECT id, owner, preview, preview_width, preview_height,
              full, full_width, full_height, bytes, created_at, event_seq
       FROM media WHERE id = ?`,
    )
    .get(id) as MediaRow | null;
}

/** Deletes never-posted uploads once they are old enough, so a crash cannot leak quota. */
export function pruneUnattachedMedia(db: Database, now: number): void {
  db.query("DELETE FROM media WHERE event_seq IS NULL AND created_at < ?").run(now - UNATTACHED_MEDIA_TTL_SECONDS);
}

/**
 * A row that may still be used: attached images never expire; an upload that was never
 * posted is gone once its hour is up, whether or not another upload has pruned it yet.
 */
export function liveMediaFor(db: Database, id: number, now: number): MediaRow | null {
  const media = mediaFor(db, id);
  if (!media) return null;
  if (media.event_seq === null && Number(media.created_at) < now - UNATTACHED_MEDIA_TTL_SECONDS) return null;
  return media;
}

/** Stores both variants and their dimensions in one row. Quota check and insert are atomic. */
export function insertMedia(
  db: Database,
  upload: NewMedia,
  quotaBytes: number,
  now: number,
): InsertMediaResult {
  return db.transaction((): InsertMediaResult => {
    pruneUnattachedMedia(db, now);
    const used = mediaUsage(db);
    const bytes = upload.preview.byteLength + upload.full.byteLength;
    if (used + bytes > quotaBytes) {
      return { ok: false, used, limit: quotaBytes };
    }
    const result = db
      .query(
        `INSERT INTO media (owner, preview, preview_width, preview_height,
                            full, full_width, full_height, bytes, created_at, event_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        upload.owner,
        upload.preview,
        upload.previewWidth,
        upload.previewHeight,
        upload.full,
        upload.fullWidth,
        upload.fullHeight,
        bytes,
        now,
      );
    const id = Number(result.lastInsertRowid);
    const media = mediaFor(db, id);
    if (!media) throw new Error(`media ${id} vanished inside its own insert`);
    return { ok: true, media };
  })();
}

/**
 * Binds an uploaded media id to the event that shows it. Only the uploader may attach it,
 * only once, and only with the dimensions the server measured on upload.
 */
export function attachMedia(
  db: Database,
  id: number,
  owner: number,
  eventSeq: number,
  width: number,
  height: number,
  now: number,
): AttachResult {
  const media = liveMediaFor(db, id, now);
  if (!media || Number(media.owner) !== owner || media.event_seq !== null) return "notfound";
  if (Number(media.full_width) !== width || Number(media.full_height) !== height) return "invalid";
  const result = db.query("UPDATE media SET event_seq = ? WHERE id = ? AND event_seq IS NULL").run(eventSeq, id);
  return Number(result.changes) === 1 ? "ok" : "notfound";
}

/** Frees the bytes of a deleted post or reply. The log keeps the delete event, not the image. */
export function removeMediaForEvent(db: Database, eventSeq: number): void {
  db.query("DELETE FROM media WHERE event_seq = ?").run(eventSeq);
}
