import type { Database } from "bun:sqlite";
import { SUPPORTED } from "@brr-chat/protocol";
import { initAuth } from "./auth.ts";
import { createServerAdminService } from "./admin.ts";
import { isPreflight, preflightResponse, withCors } from "./cors.ts";
import { enforceDbFilePermissions, headCursor, openDb } from "./db.ts";
import { handleHistory } from "./history.ts";
import { createInviteService } from "./invites.ts";
import { AbuseLimiters, DEFAULT_ABUSE_LIMITS, type AbuseLimitConfig } from "./limits.ts";
import { createMediaService } from "./media.ts";
import { DEFAULT_MEDIA_QUOTA_BYTES } from "./media-store.ts";
import { serveShell } from "./pwa.ts";
import { DEFAULT_RECOVERY_LIMITS, createRecoveryService, type RecoveryLimits } from "./recovery.ts";
import { handleSync } from "./sync.ts";

export { SUPPORTED, headCursor, openDb };
export const supported = SUPPORTED;

export interface AppOptions {
  dbPath?: string;
  host?: string;
  baseURL?: string;
  /** Absent means the environment, then a fail-fast for anything but an in-memory DB. */
  secret?: string | undefined;
  /** Recovery redeem limits; tests use it to reach the gate without a hundred requests. */
  recoveryLimits?: Partial<RecoveryLimits>;
  /** Abuse budgets from ADR 0012; tests use it to shrink a window instead of waiting a day. */
  limits?: Partial<AbuseLimitConfig>;
  /** Total media bytes the server stores; tests shrink it to reach the quota gate. */
  mediaQuotaBytes?: number;
}

export type AuthInstance = Awaited<ReturnType<typeof initAuth>>;

export interface ServerApp {
  fetch(req: Request, ip?: string): Promise<Response>;
  db: Database;
  auth: AuthInstance;
  close(): void;
}

/**
 * Signing key for sessions. A real DB never falls back to a default: a shipped binary must
 * not sign sessions with a key that is in the source (ADR 0007). An in-memory DB is a test
 * or a one-off, so it gets a random key instead.
 */
/** BetterAuth needs a key it considers long enough; 32 characters is its own floor. */
const MIN_SECRET_LENGTH = 32;

function resolveSecret(secret: string | undefined, dbPath: string): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET;
  const candidate = secret ?? fromEnv;
  if (candidate !== undefined && candidate.length >= MIN_SECRET_LENGTH) return candidate;
  if (candidate !== undefined && candidate.length > 0) {
    throw new Error(`BETTER_AUTH_SECRET is too short: expected at least ${MIN_SECRET_LENGTH} characters, got ${candidate.length}`);
  }
  if (dbPath === ":memory:") return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  throw new Error(
    `BETTER_AUTH_SECRET is required: the session signing key must not come from a default. ` +
      `Set it to at least ${MIN_SECRET_LENGTH} random characters (e.g. BETTER_AUTH_SECRET=$(openssl rand -hex 32)).`,
  );
}

export async function createApp(opts: AppOptions = {}): Promise<ServerApp> {
  const dbPath = opts.dbPath ?? ":memory:";
  const host = opts.host ?? "localhost";
  const baseURL = opts.baseURL ?? `http://${host.replace(/^https?:\/\//i, "")}`;
  const secret = resolveSecret(opts.secret, dbPath);

  const db = openDb(dbPath);
  const auth = await initAuth(db, {
    secret,
    baseURL,
    host,
    dbPath,
  });

  if (dbPath !== ":memory:") {
    enforceDbFilePermissions(dbPath);
  }

  const limits = new AbuseLimiters({ ...DEFAULT_ABUSE_LIMITS, ...opts.limits });
  const recovery = createRecoveryService(
    db,
    auth,
    { ...DEFAULT_RECOVERY_LIMITS, ...opts.recoveryLimits },
    limits.signups,
  );
  const invites = createInviteService(db, auth, baseURL, limits);
  const admin = createServerAdminService(db, auth, baseURL);
  const media = createMediaService(db, auth, {
    quotaBytes: opts.mediaQuotaBytes ?? DEFAULT_MEDIA_QUOTA_BYTES,
  });

  /** The app's routing table. One exit, so CORS and the cookie rule cannot be skipped. */
  async function route(req: Request, ip?: string): Promise<Response> {
    const url = new URL(req.url);
    const recovered = await recovery.handle(req, url.pathname, ip);
    if (recovered) return recovered;
    const administered = await admin.handle(req, url.pathname);
    if (administered) return administered;
    const invited = await invites.handle(req, url.pathname);
    if (invited) return invited;
    const image = await media.handle(req, url);
    if (image) return image;
    if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
      // The BetterAuth admin plugin mounts its own user-management routes under this base.
      // They would be a second signup and ban path around registration policy and the purge
      // transaction, so this server does not expose them; administration is /api/server.
      if (url.pathname === "/api/auth/admin" || url.pathname.startsWith("/api/auth/admin/")) {
        return new Response("Not Found", { status: 404 });
      }
      return auth.handler(req);
    }
    if (url.pathname === "/sync" && req.method === "POST") {
      return handleSync(req, db, auth, limits);
    }
    if (url.pathname === "/history" && req.method === "POST") {
      return handleHistory(req, db, auth);
    }
    const shell = serveShell(url.pathname, req.method, req.headers.get("accept-encoding"));
    if (shell) return shell;
    return new Response("Not Found", { status: 404 });
  }

  return {
    db,
    auth,
    async fetch(req: Request, ip?: string): Promise<Response> {
      if (isPreflight(req)) return preflightResponse();
      return withCors(req, await route(req, ip));
    },
    close(): void {
      db.close();
    },
  };
}

// ---- single binary entrypoint ----

export interface CliOptions {
  port: number;
  dbPath: string;
  host: string;
  baseURL: string;
  /** Absent when nothing set it: createApp then refuses to serve a real DB. */
  secret: string | undefined;
  /** Total media bytes the server stores (ADR 0011). */
  mediaQuotaBytes: number;
}

const DEFAULT_PORT = 3000;
const DEFAULT_DB_PATH = "brr-chat.db";

function firstValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (names.includes(arg)) {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    }
    const eq = arg.indexOf("=");
    if (eq > 0 && names.includes(arg.slice(0, eq))) {
      const value = arg.slice(eq + 1);
      if (value.length === 0) throw new Error(`${arg.slice(0, eq)} needs a value`);
      return value;
    }
  }
  return undefined;
}

/** Env and flags. Flags win, so a flag can override what the environment set. */
export function parseCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const port = Number(firstValue(argv, ["--port", "-p"]) ?? env.PORT ?? DEFAULT_PORT);
  // 0 is allowed on purpose: the OS picks a free port, and the server prints the one it got.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`port: expected an integer 0..65535, got ${port}`);
  const host = firstValue(argv, ["--host"]) ?? "localhost";
  const dbPath = firstValue(argv, ["--db", "--db-path"]) ?? env.DB_PATH ?? DEFAULT_DB_PATH;
  // The browser's Origin includes the port, and BetterAuth compares it exactly, so the
  // default must be the URL the server is actually reachable at.
  const baseURL = firstValue(argv, ["--base-url"]) ?? env.BASE_URL ?? `http://${host}:${port}`;
  const secret = firstValue(argv, ["--secret"]) ?? env.BETTER_AUTH_SECRET;
  const mediaQuotaBytes = Number(
    firstValue(argv, ["--media-quota"]) ?? env.MEDIA_QUOTA_BYTES ?? DEFAULT_MEDIA_QUOTA_BYTES,
  );
  if (!Number.isSafeInteger(mediaQuotaBytes) || mediaQuotaBytes < 0) {
    throw new Error(`media quota: expected a whole number of bytes, got ${mediaQuotaBytes}`);
  }
  return { port, dbPath, host, baseURL, secret, mediaQuotaBytes };
}

const USAGE = `brr-chat server

  bun apps/server/src/index.ts [--port 3000] [--db brr-chat.db] [--base-url http://host]
                            [--secret <32+ chars>] [--media-quota <bytes>]

  PORT, DB_PATH, BASE_URL, BETTER_AUTH_SECRET and MEDIA_QUOTA_BYTES are read from the
  environment. Flags override the environment. The app shell, the auth routes, /sync and
  the image routes (/m) are all served by this process.
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const opts = parseCliOptions(argv);
  const app = await createApp({
    dbPath: opts.dbPath,
    host: opts.host,
    baseURL: opts.baseURL,
    secret: opts.secret,
    mediaQuotaBytes: opts.mediaQuotaBytes,
  });
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch: (req, server) => app.fetch(req, server.requestIP(req)?.address),
    // A photo upload is capped at ~864 KB by the route itself; this is the HTTP-level
    // backstop, kept large enough for a long offline outbox to drain in one /sync.
    idleTimeout: 30,
    maxRequestBodySize: 8 * 1024 * 1024,
  });

  const stop = () => {
    void server.stop(true);
    app.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`brr-chat listening on http://${opts.host}:${server.port} (db ${opts.dbPath}, protocol v${SUPPORTED.max})`);
  if (opts.baseURL !== `http://${opts.host}:${server.port}`) console.log(`brr-chat base url ${opts.baseURL}`);
}

if (import.meta.main) {
  await main();
}
