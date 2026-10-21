// Uploaded images (ADR 0011, ADR 0019). `POST /m` takes both client-encoded WebP variants
// in one multipart request; `GET /m/{id}?w=` serves the nearest one to a signed-in viewer
// who may already see the post that carries it.
import type { Database } from "bun:sqlite";
import {
  MEDIA_FULL_EDGE,
  MEDIA_PREVIEW_EDGE,
  MEDIA_VARIANT_MAX_BYTES,
  snapMediaWidth,
} from "@brr-chat/protocol";
import { actorFor, eventVisibleTo } from "./events.ts";
import type { AuthInstance } from "./index.ts";
import {
  insertMedia,
  inspectWebp,
  liveMediaFor,
  type MediaRow,
} from "./media-store.ts";
import { isRecoveryConfirmed } from "./recovery.ts";

/** The two variants arrive in one body; allow for multipart framing around the byte caps. */
export const MAX_UPLOAD_BODY_BYTES = MEDIA_VARIANT_MAX_BYTES * 2 + 64 * 1024;

export interface MediaConfig {
  /** Total bytes of stored media this server keeps. */
  quotaBytes: number;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function fail(status: number, code: string, error: string, details: Record<string, unknown> = {}): Response {
  return json(status, { code, error, ...details });
}

function isBlob(value: unknown): value is Blob {
  return typeof value === "object" && value !== null && typeof (value as Blob).arrayBuffer === "function";
}

interface Account {
  wireId: number;
}

export interface MediaService {
  /** Handles /m and /m/{id}. Null means "not mine". */
  handle(req: Request, url: URL): Promise<Response | null>;
}

export function createMediaService(db: Database, auth: AuthInstance, config: MediaConfig): MediaService {
  async function sessionAccount(req: Request): Promise<Account | Response> {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session || session.user.banned) return json(401, { code: "unauthorized", error: "sign in first" });
    if (!isRecoveryConfirmed(db, session.user.id)) {
      return json(403, { code: "signup_incomplete", error: "finish signup first" });
    }
    return { wireId: actorFor(db, session.user.id).wireId };
  }

  async function upload(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return fail(405, "method", "upload needs POST", { allow: "POST" });
    }
    const account = await sessionAccount(req);
    if (account instanceof Response) return account;

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return fail(415, "bad_body", "send multipart/form-data with preview and full WebP files");
    }
    const length = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_UPLOAD_BODY_BYTES) {
      return fail(413, "too_large", "that upload is too large", { limit: MAX_UPLOAD_BODY_BYTES });
    }

    const form = await req.formData().catch(() => null);
    if (!form) {
      return fail(400, "bad_body", "could not read the upload");
    }

    const preview = form.get("preview");
    const full = form.get("full");
    if (!isBlob(preview) || !isBlob(full)) {
      return fail(400, "missing_variant", "both a preview and a full WebP are required");
    }

    const previewBytes = new Uint8Array(await preview.arrayBuffer());
    const fullBytes = new Uint8Array(await full.arrayBuffer());
    const variants = [
      { name: "preview", bytes: previewBytes, edge: MEDIA_PREVIEW_EDGE },
      { name: "full", bytes: fullBytes, edge: MEDIA_FULL_EDGE },
    ] as const;

    const dimensions: { width: number; height: number }[] = [];
    for (const variant of variants) {
      if (variant.bytes.byteLength === 0) {
        return fail(400, "missing_variant", `the ${variant.name} image is empty`, { variant: variant.name });
      }
      if (variant.bytes.byteLength > MEDIA_VARIANT_MAX_BYTES) {
        return fail(413, "too_large", `the ${variant.name} image is larger than 400 KB`, {
          variant: variant.name,
          limit: MEDIA_VARIANT_MAX_BYTES,
          bytes: variant.bytes.byteLength,
        });
      }
      const info = inspectWebp(variant.bytes);
      if (!info || info.width <= 0 || info.height <= 0) {
        return fail(415, "not_webp", `the ${variant.name} image is not a WebP file`, { variant: variant.name });
      }
      if (Math.max(info.width, info.height) > variant.edge) {
        return fail(422, "dimensions", `the ${variant.name} image is larger than ${variant.edge} px`, {
          variant: variant.name,
          width: info.width,
          height: info.height,
          maxEdge: variant.edge,
        });
      }
      dimensions.push(info);
    }

    const previewInfo = dimensions[0]!;
    const fullInfo = dimensions[1]!;
    if (Math.max(fullInfo.width, fullInfo.height) < Math.max(previewInfo.width, previewInfo.height)) {
      return fail(422, "dimensions", "the full image must be at least as large as the preview");
    }
    // The placeholder reserves the full image's aspect ratio, so the preview must match it;
    // otherwise the timeline jumps when the preview arrives.
    const previewAspect = previewInfo.width / previewInfo.height;
    const fullAspect = fullInfo.width / fullInfo.height;
    if (Math.abs(previewAspect - fullAspect) > 0.02) {
      return fail(422, "dimensions", "the preview and full images must have the same aspect ratio");
    }

    const result = insertMedia(
      db,
      {
        owner: account.wireId,
        preview: previewBytes,
        previewWidth: previewInfo.width,
        previewHeight: previewInfo.height,
        full: fullBytes,
        fullWidth: fullInfo.width,
        fullHeight: fullInfo.height,
      },
      config.quotaBytes,
      Math.floor(Date.now() / 1000),
    );
    if (!result.ok) {
      return fail(507, "quota", "this server's media storage is full", {
        limit: result.limit,
        used: result.used,
      });
    }
    return json(201, {
      id: result.media.id,
      w: result.media.full_width,
      h: result.media.full_height,
      bytes: result.media.bytes,
    });
  }

  function canView(account: Account, media: MediaRow): boolean {
    if (media.event_seq === null) return Number(media.owner) === account.wireId;
    return eventVisibleTo(db, account.wireId, Number(media.event_seq));
  }

  async function fetchImage(req: Request, url: URL, id: number): Promise<Response> {
    if (req.method !== "GET") {
      return fail(405, "method", "images are read-only", { allow: "GET" });
    }
    const account = await sessionAccount(req);
    if (account instanceof Response) return account;

    const media = Number.isSafeInteger(id) && id > 0 ? liveMediaFor(db, id, Math.floor(Date.now() / 1000)) : null;
    // A non-member and a missing image answer the same way: the placeholder is the only
    // clue that an id existed.
    if (!media || !canView(account, media)) {
      return fail(404, "not_found", "image not found");
    }

    const raw = url.searchParams.get("w");
    const requested = raw === null || raw.trim().length === 0 ? null : Number(raw);
    const width = snapMediaWidth(requested);
    const bytes = width === MEDIA_PREVIEW_EDGE ? media.preview : media.full;

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(bytes.byteLength),
        // Ids never change their bytes. A private cache keeps the browser from re-fetching
        // on every scroll without letting a shared proxy keep someone's image.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  }

  return {
    async handle(req, url): Promise<Response | null> {
      if (url.pathname === "/m") return upload(req);
      const match = /^\/m\/(\d+)$/.exec(url.pathname);
      if (!match) return null;
      return fetchImage(req, url, Number(match[1]));
    },
  };
}
