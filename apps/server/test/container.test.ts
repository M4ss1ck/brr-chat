// The deploy files agree with each other and keep the guarantees ADR 0022 relies on. A
// Dependabot bump to one Bun pin, or a hand edit to compose.yaml, fails here in the gate
// lane instead of in production.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

interface ComposeService {
  image?: string;
  environment?: string[] | Record<string, string>;
  ports?: unknown[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  volumes?: string[];
}
const compose = (path: string) => Bun.YAML.parse(read(path)) as { services: Record<string, ComposeService> };

const bunVersion = read(".bun-version").trim();
const dockerfile = read("Dockerfile");
const prod = compose("compose.yaml").services.brr!;

function envNames(service: ComposeService): string[] {
  const env = service.environment ?? [];
  return Array.isArray(env) ? env.map((entry) => entry.split("=")[0]!) : Object.keys(env);
}

describe("one Bun version everywhere", () => {
  test("the Dockerfile build stage uses .bun-version, pinned by digest", () => {
    const from = /^FROM oven\/bun:([^@\s]+)@sha256:[0-9a-f]{64} AS build$/m.exec(dockerfile);
    expect(from?.[1]).toBe(bunVersion);
  });

  test("the dev compose runs the same Bun image as the Dockerfile", () => {
    const buildImage = /^FROM (oven\/bun:\S+) AS build$/m.exec(dockerfile)?.[1];
    const dev = compose("compose.dev.yaml").services;
    for (const name of ["deps", "web", "server"]) expect(dev[name]?.image).toBe(buildImage);
  });

  test("the runtime base is distroless, non-root, pinned by digest", () => {
    expect(dockerfile).toMatch(/^FROM gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/^USER 65532:65532$/m);
  });
});

describe("production compose", () => {
  test("is reachable only through the proxy, with a read-only root", () => {
    expect(prod.ports).toBeUndefined();
    expect(prod.read_only).toBe(true);
    expect(prod.cap_drop).toEqual(["ALL"]);
    expect(prod.security_opt).toContain("no-new-privileges:true");
  });

  test("keeps the database and the snapshots on separate volumes", () => {
    expect(prod.volumes).toEqual(["brr-data:/data", "brr-backups:/backups"]);
    expect(dockerfile).toContain("DB_PATH=/data/brr-chat.db");
    expect(dockerfile).toContain("BACKUP_DIR=/backups");
  });

  test("takes its secret and origin from Coolify and trusts exactly one proxy by default", () => {
    const env = prod.environment as string[];
    expect(env).toContain("SERVICE_URL_BRR_3000");
    expect(env).toContain("BASE_URL=${SERVICE_URL_BRR}");
    expect(env).toContain("BETTER_AUTH_SECRET=${SERVICE_HEX_64_AUTHSECRET}");
    expect(env).toContain("TRUSTED_PROXY_HOPS=${TRUSTED_PROXY_HOPS:-1}");
  });

  test("every setting it passes is one the server reads", () => {
    const usage = read("apps/server/src/index.ts");
    for (const name of envNames(prod).filter((n) => !n.startsWith("SERVICE_"))) {
      expect(usage).toContain(`env.${name}`);
    }
  });
});
