// The PWA shell, embedded at compile time from apps/web/dist via the generated module, so a
// single binary serves the app with no files beside it (issue #5, ADR 0014).
import { SHELL_ROUTES, type ShellAsset } from "./pwa-assets.generated.ts";

export const shellAssets: Readonly<Record<string, ShellAsset>> = SHELL_ROUTES;

/** Paths this server answers with a shell asset. */
export function shellPaths(): string[] {
  return Object.keys(shellAssets);
}

/**
 * Serves one shell asset. Returns null when the path is not part of the shell, so the
 * caller can fall through to the API routes.
 */
export function serveShell(pathname: string, method: string): Response | null {
  const asset = shellAssets[pathname];
  if (!asset) return null;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  const headers: Record<string, string> = {
    "Content-Type": asset.contentType,
    "Cache-Control": asset.cacheControl,
    // The shell is served to any origin a browser can reach; no sniffing, ever.
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(Buffer.byteLength(asset.body, "utf8")),
  };
  return new Response(method === "HEAD" ? null : asset.body, { status: 200, headers });
}
