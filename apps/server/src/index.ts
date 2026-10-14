import type { Database } from "bun:sqlite";
import { SUPPORTED } from "@brr-chat/protocol";
import { initAuth } from "./auth.ts";
import { enforceDbFilePermissions, headCursor, openDb } from "./db.ts";

export { SUPPORTED, headCursor, openDb };
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
      return new Response("Not Found", { status: 404 });
    },
    close(): void {
      db.close();
    },
  };
}
