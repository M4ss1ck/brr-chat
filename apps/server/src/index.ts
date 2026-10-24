import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { SUPPORTED } from "@brr-chat/protocol";
import { initAuth } from "./auth.ts";
import { createServerAdminService } from "./admin.ts";
import { isPreflight, preflightResponse, withCors } from "./cors.ts";
import { enforceDbFilePermissions, headCursor, openDb } from "./db.ts";
import { serveSyncDictionary } from "./dictionary.ts";
import { handleHistory } from "./history.ts";
import { createInviteService } from "./invites.ts";
import { DEFAULT_BACKUP_INTERVAL_HOURS, DEFAULT_BACKUP_KEEP, scheduleSnapshots } from "./backup.ts";
import { clientIp } from "./client-ip.ts";
import { AbuseLimiters, DEFAULT_ABUSE_LIMITS, type AbuseLimitConfig } from "./limits.ts";
import { createMediaService } from "./media.ts";
import { DEFAULT_MEDIA_QUOTA_BYTES } from "./media-store.ts";
import { serveShell } from "./pwa.ts";
import { restoreSnapshot } from "./restore.ts";
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
  /**
   * Reverse proxies we run in front of the server. 0 keys the abuse limits on the socket
   * peer; N takes the Nth X-Forwarded-For entry from the right (client-ip.ts, ADR 0022).
   */
  trustedProxyHops?: number;
  /** Periodic SQLite snapshots (ADR 0023). Absent means none are taken. */
  backup?: { dir: string; intervalMs: number; keep: number };
}

export type AuthInstance = Awaited<ReturnType<typeof initAuth>>;

export interface ServerApp {
  /** `ip` is the socket peer; the client address is resolved from it per `trustedProxyHops`. */
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
  // The origin a browser sees, which is what WebAuthn is bound to. The listener address can
  // differ behind a TLS proxy, so CORS uses this instead of the request URL (ADR 0021).
  const appOrigin = (() => {
    try {
      return new URL(baseURL).origin;
    } catch {
      return `http://${host.replace(/^https?:\/\//i, "")}`;
    }
  })();

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
  const trustedProxyHops = opts.trustedProxyHops ?? 0;
  const stopSnapshots = opts.backup && dbPath !== ":memory:" ? scheduleSnapshots(db, opts.backup) : () => {};

  /**
   * Liveness for the container healthcheck: the process answers and the DB file still
   * reads. Public, uncompressed and never cached, so a proxy or a probe never sees a stale
   * "ok" (ADR 0022).
   */
  function health(req: Request): Response {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
    try {
      db.query("SELECT 1").get();
      return new Response(req.method === "HEAD" ? null : "ok\n", { status: 200, headers });
    } catch {
      return new Response(req.method === "HEAD" ? null : "db unavailable\n", { status: 503, headers });
    }
  }

  /** The app's routing table. One exit, so CORS and the cookie rule cannot be skipped. */
  async function route(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return health(req);
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
    // Before the shell: this path is public, cacheable for a year, and never a route the
    // app shell should answer (issue #21).
    const dictionary = serveSyncDictionary(req, url.pathname);
    if (dictionary) return dictionary;
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
      return withCors(req, await route(req, clientIp(req, ip, trustedProxyHops)), appOrigin);
    },
    close(): void {
      stopSnapshots();
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
  /** Reverse proxies in front of the server whose X-Forwarded-For entries are trusted. */
  trustedProxyHops: number;
  /** Snapshot directory (ADR 0023); undefined means no snapshots. */
  backupDir: string | undefined;
  backupIntervalHours: number;
  backupKeep: number;
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
  // A container must listen on 0.0.0.0 to be reachable from its proxy; a bare binary on a
  // laptop should not be reachable from the network by default.
  const host = firstValue(argv, ["--host"]) ?? env.HOST ?? "localhost";
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
  const trustedProxyHops = Number(firstValue(argv, ["--trusted-proxy-hops"]) ?? env.TRUSTED_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 8) {
    throw new Error(`trusted proxy hops: expected an integer 0..8, got ${trustedProxyHops}`);
  }
  const backupDir = firstValue(argv, ["--backup-dir"]) ?? (env.BACKUP_DIR || undefined);
  // Hours, fractional allowed so a smoke test can ask for a snapshot within seconds.
  const backupIntervalHours = Number(
    firstValue(argv, ["--backup-interval-hours"]) ?? env.BACKUP_INTERVAL_HOURS ?? DEFAULT_BACKUP_INTERVAL_HOURS,
  );
  if (!Number.isFinite(backupIntervalHours) || backupIntervalHours <= 0) {
    throw new Error(`backup interval: expected a positive number of hours, got ${backupIntervalHours}`);
  }
  const backupKeep = Number(firstValue(argv, ["--backup-keep"]) ?? env.BACKUP_KEEP ?? DEFAULT_BACKUP_KEEP);
  if (!Number.isInteger(backupKeep) || backupKeep < 1) {
    throw new Error(`backup keep: expected an integer of at least 1, got ${backupKeep}`);
  }
  return {
    port,
    dbPath,
    host,
    baseURL,
    secret,
    mediaQuotaBytes,
    trustedProxyHops,
    backupDir,
    backupIntervalHours,
    backupKeep,
  };
}

const USAGE = `brr-chat server

  brr-chat [--port 3000] [--host localhost] [--db brr-chat.db] [--base-url http://host]
           [--secret <32+ chars>] [--media-quota <bytes>] [--trusted-proxy-hops 0]
           [--backup-dir <dir>] [--backup-interval-hours 6] [--backup-keep 8]
  brr-chat healthcheck [--port 3000]
  brr-chat restore <snapshot.db | -> [--db brr-chat.db]

  PORT, HOST, DB_PATH, BASE_URL, BETTER_AUTH_SECRET, MEDIA_QUOTA_BYTES, TRUSTED_PROXY_HOPS,
  BACKUP_DIR, BACKUP_INTERVAL_HOURS and BACKUP_KEEP are read from the environment. Flags
  override the environment. The app shell, the auth routes, /sync and the image routes (/m)
  are all served by this process. \`healthcheck\` asks a running server on this host for
  /healthz and exits 0 when it answers 200, for container images with no shell or curl.
  \`restore\` replaces the database with a snapshot (\`-\` reads it from stdin); stop the
  server first. scripts/restore.sh drives it from the Docker host (ADR 0023).
`;

/** `brr-chat restore`: the snapshot is a path, or `-` for stdin (no shared file needed). */
async function restoreCommand(argv: readonly string[]): Promise<void> {
  const source = argv[0];
  if (source === undefined || source.startsWith("--")) throw new Error("restore needs a snapshot path or - for stdin");
  const { dbPath } = parseCliOptions(argv.slice(1));
  let snapshot = source;
  if (source === "-") {
    // Lands beside the DB, on the same volume, and is removed whatever happens. Drained
    // chunk by chunk: Bun.write(path, new Response(Bun.stdin.stream())) never settles.
    snapshot = `${dbPath}.incoming`;
    const sink = Bun.file(snapshot).writer();
    const reader = Bun.stdin.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.write(value);
    }
    await sink.end();
  }
  try {
    const result = restoreSnapshot(dbPath, snapshot);
    console.log(
      `brr-chat restored ${dbPath}: head seq ${result.head}, new events continue after ${result.eventsFloor}, ` +
        `media after ${result.mediaFloor}` +
        (result.previous ? `; previous database kept in ${result.previous}` : ""),
    );
  } finally {
    if (source === "-") rmSync(snapshot, { force: true });
  }
}

/** Time the healthcheck waits for an answer; a wedged server must fail the probe, not hang it. */
const HEALTHCHECK_TIMEOUT_MS = 3_000;

/** How long shutdown waits for in-flight requests: inside compose's 30 s stop_grace_period. */
const DRAIN_TIMEOUT_MS = 20_000;

/** Exit code for `brr-chat healthcheck`: 0 healthy, 1 anything else. */
export async function healthcheck(opts: Pick<CliOptions, "port" | "host">): Promise<number> {
  // A wildcard listen address is not something to connect to; loopback reaches it.
  const host = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  const target = `http://${host.includes(":") ? `[${host}]` : host}:${opts.port}/healthz`;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS) });
    if (res.status === 200) return 0;
    console.error(`healthcheck: ${target} answered ${res.status}`);
  } catch (err) {
    console.error(`healthcheck: ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 1;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (argv[0] === "healthcheck") {
    process.exit(await healthcheck(parseCliOptions(argv.slice(1))));
  }
  if (argv[0] === "restore") {
    await restoreCommand(argv.slice(1));
    return;
  }
  const opts = parseCliOptions(argv);
  const app = await createApp({
    dbPath: opts.dbPath,
    host: opts.host,
    baseURL: opts.baseURL,
    secret: opts.secret,
    mediaQuotaBytes: opts.mediaQuotaBytes,
    trustedProxyHops: opts.trustedProxyHops,
    ...(opts.backupDir
      ? {
          backup: {
            dir: opts.backupDir,
            intervalMs: Math.round(opts.backupIntervalHours * 3_600_000),
            keep: opts.backupKeep,
          },
        }
      : {}),
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

  // Drain in-flight requests, then close the DB so the WAL is checkpointed, then exit.
  // As PID 1 in a container there is no default SIGTERM handler, so exiting is on us.
  let stopping = false;
  const stop = async () => {
    if (stopping) {
      // A second signal while draining: the pending request is not worth waiting for.
      server.stop(true);
      app.close();
      process.exit(0);
    }
    stopping = true;
    // A pending request can hold server.stop() until idleTimeout, longer than the grace
    // period allows, so force the remaining connections shut once the drain budget is gone.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drainTimeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        server.stop(true);
        resolve();
      }, DRAIN_TIMEOUT_MS);
    });
    await Promise.race([server.stop(), drainTimeout]);
    if (timer !== undefined) clearTimeout(timer);
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  console.log(`brr-chat listening on http://${opts.host}:${server.port} (db ${opts.dbPath}, protocol v${SUPPORTED.max})`);
  if (opts.baseURL !== `http://${opts.host}:${server.port}`) console.log(`brr-chat base url ${opts.baseURL}`);
  if (opts.trustedProxyHops > 0) console.log(`brr-chat trusting ${opts.trustedProxyHops} proxy hop(s) for client IPs`);
  if (opts.backupDir) {
    console.log(`brr-chat snapshots every ${opts.backupIntervalHours} h to ${opts.backupDir}, keeping ${opts.backupKeep}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    // A config error (missing secret, bad flag) is the operator's to fix: one line in the
    // container log, not a stack trace through the compiled bundle.
    console.error(`brr-chat: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
