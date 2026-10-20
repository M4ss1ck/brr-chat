import type { Database } from "bun:sqlite";
import { SUPPORTED } from "@brr-chat/protocol";
import { initAuth } from "./auth.ts";
import { enforceDbFilePermissions, headCursor, openDb } from "./db.ts";
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

  const recovery = createRecoveryService(db, auth, { ...DEFAULT_RECOVERY_LIMITS, ...opts.recoveryLimits });

  return {
    db,
    auth,
    async fetch(req: Request, ip?: string): Promise<Response> {
      const url = new URL(req.url);
      const recovered = await recovery.handle(req, url.pathname, ip);
      if (recovered) return recovered;
      if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
        return auth.handler(req);
      }
      if (url.pathname === "/sync" && req.method === "POST") {
        return handleSync(req, db, auth);
      }
      const shell = serveShell(url.pathname, req.method, req.headers.get("accept-encoding"));
      if (shell) return shell;
      return new Response("Not Found", { status: 404 });
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
  const baseURL = firstValue(argv, ["--base-url"]) ?? env.BASE_URL ?? `http://${host}`;
  const secret = firstValue(argv, ["--secret"]) ?? env.BETTER_AUTH_SECRET;
  return { port, dbPath, host, baseURL, secret };
}

const USAGE = `brr-chat server

  bun apps/server/src/index.ts [--port 3000] [--db brr-chat.db] [--base-url http://host]
                            [--secret <32+ chars>]

  PORT, DB_PATH, BASE_URL and BETTER_AUTH_SECRET are read from the environment.
  Flags override the environment. The app shell, the auth routes and /sync are all served
  by this process.
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
  });
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch: (req, server) => app.fetch(req, server.requestIP(req)?.address),
    // Sync is a single CBOR body; no request should hog a connection.
    idleTimeout: 30,
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
