import type { Database } from "bun:sqlite";
import { SUPPORTED } from "@brr-chat/protocol";
import { initAuth } from "./auth.ts";
import { enforceDbFilePermissions, headCursor, openDb } from "./db.ts";
import { serveShell } from "./pwa.ts";
import { handleSync } from "./sync.ts";

export { SUPPORTED, headCursor, openDb };
export { shellAssets, shellPaths } from "./pwa.ts";
export const supported = SUPPORTED;

export interface AppOptions {
  dbPath?: string;
  host?: string;
  baseURL?: string;
  secret?: string;
}

export type AuthInstance = Awaited<ReturnType<typeof initAuth>>;

export interface ServerApp {
  fetch(req: Request): Promise<Response>;
  db: Database;
  auth: AuthInstance;
  close(): void;
}

const DEFAULT_DEV_SECRET = "brr-chat-dev-secret-0123456789abcdef0123456789abcdef";

export async function createApp(opts: AppOptions = {}): Promise<ServerApp> {
  const dbPath = opts.dbPath ?? ":memory:";
  const host = opts.host ?? "localhost";
  const baseURL = opts.baseURL ?? `http://${host.replace(/^https?:\/\//i, "")}`;
  const secret = opts.secret ?? process.env.BETTER_AUTH_SECRET ?? DEFAULT_DEV_SECRET;

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

  return {
    db,
    auth,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
        return auth.handler(req);
      }
      if (url.pathname === "/sync" && req.method === "POST") {
        return handleSync(req, db, auth);
      }
      const shell = serveShell(url.pathname, req.method);
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
  secret: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_DB_PATH = "brr-chat.db";

function firstValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (names.includes(arg)) {
      const next = argv[argv.indexOf(arg) + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    }
    const eq = arg.split("=");
    const value = eq[1];
    if (eq.length === 2 && value !== undefined && names.includes(eq[0] ?? "")) return value;
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
  const secret = firstValue(argv, ["--secret"]) ?? env.BETTER_AUTH_SECRET ?? DEFAULT_DEV_SECRET;
  return { port, dbPath, host, baseURL, secret };
}

const USAGE = `brr-chat server

  bun apps/server/src/index.ts [--port 3000] [--db brr-chat.db] [--base-url http://host]
                            [--secret <32+ chars>]

  PORT, DB_PATH, BASE_URL, BETTER_AUTH_SECRET and HOST are read from the environment.
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
    fetch: (req) => app.fetch(req),
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
