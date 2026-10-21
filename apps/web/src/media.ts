// Client side of the media pipeline (ADR 0011, ADR 0019). A chosen photo is decoded once,
// resized and re-encoded as two WebP variants (metadata gone), reduced to a ThumbHash, and
// uploaded in one request. Rendering never fetches: the placeholder is a data URL until the
// user taps, then the full variant is fetched with the session token.
import { MEDIA_FULL_EDGE, MEDIA_PREVIEW_EDGE, MEDIA_VARIANT_MAX_BYTES, type Media } from "@brr-chat/protocol";
import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash";
import { bearerHeader } from "./auth.ts";
import { meteredFetch } from "./meter.ts";

export const MEDIA_PATH = "/m";
/** The largest square ThumbHash encoder input: bigger is slower with no visible gain. */
export const THUMBHASH_EDGE = 100;
/** First try quality, then step down only if a variant would break the server's 400 KB cap. */
const WEBP_QUALITIES = [0.82, 0.65, 0.5, 0.35] as const;

export interface ImageVariant {
  blob: Blob;
  width: number;
  height: number;
}

export interface PreparedImage {
  preview: ImageVariant;
  full: ImageVariant;
  thumbhash: Uint8Array;
}

export interface UploadedImage {
  id: number;
  w: number;
  h: number;
  bytes: number;
}

/** `fetch` with the meter's signature; the global also carries `preconnect`, which we do not use. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A server refusal with a stable code, so the UI can say what to do next. */
export class MediaUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaUploadError";
  }
}

/** Fits an image inside a square edge without ever enlarging it. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError("image dimensions must be positive");
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

interface DrawSurface {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  toBlob(quality: number): Promise<Blob>;
}

function surface(width: number, height: number): DrawSurface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("this browser cannot draw images");
    return {
      context,
      toBlob: (quality) => canvas.convertToBlob({ type: "image/webp", quality }),
    };
  }
  if (typeof document === "undefined") throw new Error("this browser cannot draw images");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("this browser cannot draw images");
  return {
    context,
    toBlob: (quality) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("this browser cannot encode the image"))),
          "image/webp",
          quality,
        );
      }),
  };
}

async function encodeVariant(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<ImageVariant> {
  const canvas = surface(width, height);
  canvas.context.drawImage(bitmap, 0, 0, width, height);
  let blob: Blob | null = null;
  for (const quality of WEBP_QUALITIES) {
    blob = await canvas.toBlob(quality);
    if (blob.size <= MEDIA_VARIANT_MAX_BYTES) break;
  }
  if (!blob) throw new Error("this browser cannot encode the image");
  // A browser without a WebP encoder silently falls back to PNG; the server would refuse it.
  if (blob.type !== "image/webp") throw new Error("this browser cannot encode WebP images");
  if (blob.size > MEDIA_VARIANT_MAX_BYTES) {
    throw new Error("This photo is too detailed to send. Try a smaller one.");
  }
  return { blob, width, height };
}

function thumbhashOf(bitmap: ImageBitmap): Uint8Array {
  const size = fitWithin(bitmap.width, bitmap.height, THUMBHASH_EDGE);
  const canvas = surface(size.width, size.height);
  canvas.context.drawImage(bitmap, 0, 0, size.width, size.height);
  const pixels = canvas.context.getImageData(0, 0, size.width, size.height).data;
  return rgbaToThumbHash(size.width, size.height, pixels);
}

/** Decodes, strips metadata by re-encoding, and returns both variants plus the placeholder. */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    // Phones store rotation in EXIF; "from-image" applies it before the pixels are read.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // An older engine that rejects the option can still decode the image.
    bitmap = await createImageBitmap(file);
  }
  try {
    const fullSize = fitWithin(bitmap.width, bitmap.height, MEDIA_FULL_EDGE);
    const previewSize = fitWithin(bitmap.width, bitmap.height, MEDIA_PREVIEW_EDGE);
    // Full first, then preview: some encoders reuse browser caches, and this keeps the
    // thumbbnail pass independent of whichever blob is handed back.
    const full = await encodeVariant(bitmap, fullSize.width, fullSize.height);
    const preview = await encodeVariant(bitmap, previewSize.width, previewSize.height);
    return { preview, full, thumbhash: thumbhashOf(bitmap) };
  } finally {
    bitmap.close();
  }
}

function imageError(code: string, fallback: string): string {
  switch (code) {
    case "too_large":
      return "That image is too large to send. Try a smaller photo.";
    case "not_webp":
    case "bad_body":
      return "That file is not an image this app can send.";
    case "dimensions":
      return "That image is too large in pixels. Try a smaller photo.";
    case "quota":
      return "This server has no room for more images right now.";
    case "missing_variant":
      return "The image could not be prepared. Try another photo.";
    case "unauthorized":
      return "Sign in first.";
    default:
      return fallback;
  }
}

/**
 * Builds the one multipart body by hand. The standard FormData shortcut hides its length
 * from the data meter, and an upload is the most expensive request this app makes.
 */
function multipartBody(prepared: PreparedImage): { body: Blob; contentType: string } {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const boundary = `----brr${[...random].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const head = (name: string, filename: string): string =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    `Content-Type: image/webp\r\n\r\n`;
  const body = new Blob(
    [
      head("preview", "preview.webp"),
      prepared.preview.blob,
      "\r\n",
      head("full", "full.webp"),
      prepared.full.blob,
      `\r\n--${boundary}--\r\n`,
    ],
    { type: `multipart/form-data; boundary=${boundary}` },
  );
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** One multipart request for both variants; resolves to the id a post references. */
export async function uploadImage(
  base: string,
  token: string,
  prepared: PreparedImage,
  fetchImpl: FetchLike = meteredFetch,
): Promise<UploadedImage> {
  const { body, contentType } = multipartBody(prepared);
  const res = await fetchImpl(`${base}${MEDIA_PATH}`, {
    method: "POST",
    headers: {
      Authorization: bearerHeader(token),
      Accept: "application/json",
      "Content-Type": contentType,
    },
    body,
  });
  const payload = (await res.json().catch(() => null)) as
    | { id?: unknown; w?: unknown; h?: unknown; bytes?: unknown; error?: unknown; code?: unknown }
    | null;
  if (!res.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "";
    const serverText = typeof payload?.error === "string" ? payload.error : `upload failed with status ${res.status}`;
    throw new MediaUploadError(res.status, code, imageError(code, serverText));
  }
  const id = payload?.id;
  const w = payload?.w;
  const h = payload?.h;
  const bytes = payload?.bytes;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof w !== "number" ||
    !Number.isSafeInteger(w) ||
    w <= 0 ||
    typeof h !== "number" ||
    !Number.isSafeInteger(h) ||
    h <= 0
  ) {
    throw new MediaUploadError(res.status, "bad_response", "The server did not return a usable image id.");
  }
  return { id, w, h, bytes: typeof bytes === "number" && Number.isSafeInteger(bytes) ? bytes : 0 };
}

/** The inline blurred preview: a data URL, never a network request. Empty means unavailable. */
export function placeholderDataUrl(media: Pick<Media, "thumbhash">): string {
  // The smallest useful ThumbHash is 5 bytes (a 1×1 image); anything shorter is corrupt.
  if (media.thumbhash.byteLength < 5) return "";
  try {
    return thumbHashToDataURL(media.thumbhash);
  } catch {
    // A corrupt placeholder must not hide the fact that there is a photo.
    return "";
  }
}

export interface MediaViewOptions {
  base: string;
  token: string;
  /** Test seams; production uses the metered fetch. */
  fetchImpl?: FetchLike;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

// Loaded images survive a re-render. Without this, every sync would replace the post list
// and put the placeholder back, making the user pay for the same tap again. The cap is the
// ADR 0013 bound: 50 MB of downloaded images across the app.
const MEDIA_CACHE_BYTES = 50 * 1024 * 1024;
const loadedMedia = new Map<string, { url: string; bytes: number; revoke: (url: string) => void }>();
let loadedBytes = 0;

/** Ids are only unique per server: keying by id alone would collide across servers. */
function mediaKey(base: string, id: number): string {
  return `${base}\u0000${id}`;
}

function cachedMedia(key: string): string | null {
  const hit = loadedMedia.get(key);
  if (!hit) return null;
  // Refresh recency, so the oldest image is the one evicted.
  loadedMedia.delete(key);
  loadedMedia.set(key, hit);
  return hit.url;
}

function rememberMedia(
  key: string,
  url: string,
  bytes: number,
  revoke: (url: string) => void,
): void {
  loadedMedia.set(key, { url, bytes, revoke });
  loadedBytes += bytes;
  for (const [candidate, entry] of loadedMedia) {
    if (loadedBytes <= MEDIA_CACHE_BYTES) break;
    loadedMedia.delete(candidate);
    loadedBytes -= entry.bytes;
    entry.revoke(entry.url);
  }
}

/** Signing out drops every downloaded image, so another account never inherits them. */
export function clearMediaCache(): void {
  for (const entry of loadedMedia.values()) entry.revoke(entry.url);
  loadedMedia.clear();
  loadedBytes = 0;
}

/**
 * A tap-to-load image. Until the click, the only `src` is the ThumbHash data URL, so a
 * timeline of photos costs placeholders and nothing else.
 */
export function mediaView(media: Media, options: MediaViewOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "media";
  button.setAttribute("aria-label", "Load image");
  button.style.aspectRatio = `${media.w} / ${media.h}`;

  const image = document.createElement("img");
  image.alt = "";
  image.width = media.w;
  image.height = media.h;
  const placeholder = placeholderDataUrl(media);
  if (placeholder.length > 0) image.src = placeholder;
  else image.hidden = true;
  button.append(image);

  let loaded = false;
  let loading = false;
  const key = mediaKey(options.base, media.id);
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));

  const applyLoaded = (url: string): void => {
    image.src = url;
    image.hidden = false;
    loaded = true;
    loading = false;
    button.classList.remove("loading", "failed");
    button.classList.add("loaded");
    button.setAttribute("aria-label", "Image loaded");
  };

  const showCached = (): boolean => {
    const url = cachedMedia(key);
    if (url === null) return false;
    applyLoaded(url);
    return true;
  };

  showCached();

  button.addEventListener("click", () => {
    if (loaded || loading) return;
    if (showCached()) return;
    loading = true;
    button.classList.add("loading");
    button.setAttribute("aria-label", "Loading image");
    const doFetch = options.fetchImpl ?? meteredFetch;
    // Ask for the width this image is actually displayed at; the server snaps it to 320 or
    // 1280, so a phone feed pays for the preview, not the full variant.
    const requested = Math.max(1, Math.round(button.clientWidth || MEDIA_PREVIEW_EDGE));
    void (async () => {
      try {
        const res = await doFetch(`${options.base}${MEDIA_PATH}/${media.id}?w=${requested}`, {
          headers: { Authorization: bearerHeader(options.token) },
        });
        if (!res.ok) throw new Error(`image: status ${res.status}`);
        const blob = await res.blob();
        let url = cachedMedia(key);
        if (url === null) {
          url = createObjectUrl(blob);
          rememberMedia(key, url, blob.size, revokeObjectUrl);
        }
        applyLoaded(url);
      } catch {
        loading = false;
        button.classList.remove("loading");
        button.classList.add("failed");
        button.setAttribute("aria-label", "Could not load the image. Tap to retry.");
      }
    })();
  });
  return button;
}
