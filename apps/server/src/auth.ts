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
  let baseOrigin = `http://${safeHost}`;
  try {
    baseOrigin = new URL(opts.baseURL).origin;
  } catch {
    // fallback to http://${safeHost}
  }

  const trustedOrigins = Array.from(
    new Set([
      baseOrigin,
      `http://${safeHost}`,
      `https://${safeHost}`,
      `http://${opts.host.replace(/^https?:\/\//i, "")}`,
      `https://${opts.host.replace(/^https?:\/\//i, "")}`,
    ]),
  );

  const authOptions = {
    database: db,
    secret: opts.secret,
    baseURL: opts.baseURL,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: true },
    trustedOrigins,
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
