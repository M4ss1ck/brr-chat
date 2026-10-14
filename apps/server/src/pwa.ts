// The PWA shell, embedded at compile time from apps/web/dist via the generated module, so a
// single binary serves the app with no files beside it (issue #5, ADR 0014).
// Bytes are money (docs/PROTOCOL.md), so assets go out brotli-compressed whenever the client
// says it can take them; the 150 KB app shell budget is measured on exactly these bytes.
import { brotliCompressSync } from "node:zlib";
import { SHELL_FILES, SHELL_ROUTES, type ShellAsset } from "./pwa-assets.generated.ts";

interface ShellVariant {
  contentType: string;
  cacheControl: string;
  encoding: string;
  /** Copied out of the embedded string, so the type is a plain Uint8Array the Response wants. */
  body: Uint8Array<ArrayBuffer>;
}

const VARIANTS = new Map<string, ShellVariant>();

for (const [file, asset] of Object.entries(SHELL_FILES)) {
  const identity = new Uint8Array(Buffer.from(asset.body, "utf8"));
  VARIANTS.set(`${file}|identity`, { contentType: asset.contentType, cacheControl: asset.cacheControl, encoding: "identity", body: identity });
  VARIANTS.set(`${file}|br`, {
    contentType: asset.contentType,
    cacheControl: asset.cacheControl,
    encoding: "br",
    body: new Uint8Array(brotliCompressSync(identity)),
  });
}

/** Paths this server answers with a shell asset. */
export function shellPaths(): string[] {
  return Object.keys(SHELL_ROUTES);
}

function acceptsBrotli(acceptEncoding: string | null): boolean {
  if (acceptEncoding === null) return false;
  return acceptEncoding
    .toLowerCase()
    .split(",")
    .some((token) => token.trim().startsWith("br"));
}

/**
 * Serves one shell asset. Returns null when the path is not part of the shell, so the
 * caller can fall through to the API routes.
 */
export function serveShell(pathname: string, method: string, acceptEncoding: string | null = null): Response | null {
  const file = SHELL_ROUTES[pathname];
  if (!file) return null;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  const encoding = acceptsBrotli(acceptEncoding) ? "br" : "identity";
  const variant = VARIANTS.get(`${file}|${encoding}`);
  if (!variant) return null;
  const headers: Record<string, string> = {
    "Content-Type": variant.contentType,
    "Cache-Control": variant.cacheControl,
    // The shell is served to any origin a browser can reach; no sniffing, ever.
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
    "Content-Length": String(variant.body.byteLength),
  };
  if (encoding === "br") headers["Content-Encoding"] = "br";
  return new Response(method === "HEAD" ? null : variant.body, { status: 200, headers });
}
