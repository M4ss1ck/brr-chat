import type { Database } from "bun:sqlite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { admin, bearer, username } from "better-auth/plugins";
import { enforceDbFilePermissions } from "./db.ts";

export interface AuthInitOptions {
  secret: string;
  baseURL: string;
  host: string;
  dbPath?: string;
}

function sanitizeHost(host: string): string {
  const withoutScheme = host.replace(/^https?:\/\//i, "");
  const hostOnly = withoutScheme.split("/")[0]?.split(":")[0]?.trim().toLowerCase();
  return hostOnly && hostOnly.length > 0 ? hostOnly : "localhost";
}

export async function initAuth(db: Database, opts: AuthInitOptions) {
  const safeHost = sanitizeHost(opts.host);

  // A client is served by one server and talks to the others directly (#18, ADR 0020), so
  // the origin it calls from cannot be known in advance. `*` is safe here because sessions
  // are bearer tokens, not cookies, and the server strips the cookie it would set: there is
  // no ambient authority for a foreign origin to borrow.
  const trustedOrigins = ["*"];

  const authOptions = {
    database: db,
    secret: opts.secret,
    baseURL: opts.baseURL,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: true },
    trustedOrigins,
    // ADR 0007 mitigation: bare tokens, so a token in an old backup must stop working.
    // Touching the app extends the session; 30 quiet days drop it.
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    plugins: [username(), bearer(), admin()],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const body = ctx.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== "object") return;
        const rawUsername =
          typeof body.username === "string" && body.username.trim().length > 0
            ? body.username.trim().toLowerCase()
            : typeof body.displayUsername === "string" && body.displayUsername.trim().length > 0
              ? body.displayUsername.trim().toLowerCase()
              : undefined;
        if (!rawUsername) return;
        const placeholderEmail = `${rawUsername}@${safeHost}.invalid`;
        const nextBody = {
          ...body,
          username: typeof body.username === "string" ? body.username : rawUsername,
          name: typeof body.name === "string" && body.name.length > 0 ? body.name : rawUsername,
          email: placeholderEmail,
        };
        ctx.body = nextBody;
        return {
          context: {
            body: nextBody,
          },
        };
      }),
    },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            const u = user as Record<string, unknown>;
            const uname =
              typeof u.username === "string" && u.username.trim().length > 0
                ? u.username.trim().toLowerCase()
                : typeof u.name === "string" && u.name.trim().length > 0
                  ? u.name.trim().toLowerCase()
                  : "user";
            return {
              data: {
                ...user,
                name: typeof user.name === "string" && user.name.length > 0 ? user.name : uname,
                email: `${uname}@${safeHost}.invalid`,
              },
            };
          },
        },
      },
    },
  } satisfies BetterAuthOptions;

  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();

  if (opts.dbPath && opts.dbPath !== ":memory:") {
    enforceDbFilePermissions(opts.dbPath);
  }

  const auth = betterAuth(authOptions);
  const ctx = await auth.$context;
  const pendingSchemaCheck = ctx.checkSchema?.();
  if (pendingSchemaCheck) {
    await pendingSchemaCheck.catch(() => {});
  }

  if (opts.dbPath && opts.dbPath !== ":memory:") {
    enforceDbFilePermissions(opts.dbPath);
  }

  return auth;
}
