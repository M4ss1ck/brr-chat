// The acceptance criterion for the tracer: one compiled binary, started in a clean
// directory, with no db file, no dist directory and no environment beyond what the test
// sets. It creates its DB at mode 0600 with no schema-mismatch log, serves the embedded
// PWA shell, and runs the whole sign-up -> /sync -> sign-out path.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { APP_SHELL_BUDGET, EMPTY_SYNC_BUDGET, decodeSyncResponse, encodeSyncRequest } from "@brr-chat/protocol";

const SERVER_ROOT = resolve(import.meta.dir, "..");
const KB = 1024;
const SECRET = "compile-test-secret-0123456789abcdef0123456789abcdef";

interface Binary {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  base: string;
  log(): string;
  stop(): Promise<void>;
}

/** Waits until the compiled server prints its listening line, or gives up. */
function waitForListening(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve_, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) {
        resolve_();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for the compiled server"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Compiles apps/server and runs it in an empty directory, returning its base URL. */
async function startCompiled(dir: string, cwd: string): Promise<Binary> {
  const binary = join(dir, "brr-chat");
  const build = Bun.spawnSync({
    cmd: ["bun", "build", "--compile", "src/index.ts", "--outfile", binary],
    cwd: SERVER_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode).toBe(0);

  const output: string[] = [];
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) output.push(decoder.decode(value, { stream: true }));
    }
  };

  const proc = Bun.spawn({
    cmd: [binary, "--port", "0", "--host", "127.0.0.1", "--db", "brr-chat.db"],
    cwd,
    env: { ...process.env, BETTER_AUTH_SECRET: SECRET },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void drain(proc.stdout);
  void drain(proc.stderr);

  await waitForListening(() => output.join("\n").includes("listening on"));
  const port = Number(/listening on http:\/\/[^:]+:(\d+)/.exec(output.join("\n"))?.[1]);
  expect(Number.isInteger(port)).toBe(true);

  return {
    proc,
    base: `http://127.0.0.1:${port}`,
    log: () => output.join("\n"),
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
}

/** One /sync over plain HTTP, so the bytes on the wire are the bytes we measure. */
async function rawSync(
  base: string,
  token: string,
  body: Uint8Array,
): Promise<{ status: number; headers: Record<string, string>; wireBytes: number; cbor: Uint8Array }> {
  const url = new URL("/sync", base);
  const res = await new Promise<{ status: number; statusText: string; headers: Record<string, string>; raw: Buffer }>((resolve_, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          Host: url.host,
          "Content-Type": "application/cbor",
          "Content-Length": String(body.byteLength),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (let i = 0; i < res.rawHeaders.length; i += 2) headers[(res.rawHeaders[i] ?? "").toLowerCase()] = res.rawHeaders[i + 1] ?? "";
          resolve_({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers, raw: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });

  let headerBytes = Buffer.byteLength(`POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n`);
  headerBytes += Buffer.byteLength(
    `Content-Type: application/cbor\r\nContent-Length: ${body.byteLength}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
  );
  let responseHeaderBytes = Buffer.byteLength(`HTTP/1.1 ${res.status} ${res.statusText ?? ""}\r\n`);
  for (const [name, value] of Object.entries(res.headers)) responseHeaderBytes += Buffer.byteLength(`${name}: ${value}\r\n`);

  const wireBytes = headerBytes + body.byteLength + responseHeaderBytes + res.raw.byteLength;
  return { status: res.status, headers: res.headers, wireBytes, cbor: new Uint8Array(res.raw) };
}

/** One GET over plain HTTP, so the bytes on the wire are the bytes measured. */
async function rawGet(base: string, path: string): Promise<{ status: number; headers: Record<string, string>; raw: Buffer }> {
  const url = new URL(path, base);
  return new Promise((resolve_, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { Host: url.host, "Accept-Encoding": "br" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (let i = 0; i < res.rawHeaders.length; i += 2) headers[(res.rawHeaders[i] ?? "").toLowerCase()] = res.rawHeaders[i + 1] ?? "";
          resolve_({ status: res.statusCode ?? 0, headers, raw: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** `bun build --compile` is far too slow for the 2s commit gate: CI runs this lane, the
 *  pre-commit hook and a bare `bun test` skip it, and ci.test.ts keeps that wiring honest. */
const slow = describe.skipIf(process.env.BRR_SLOW !== "1");

if (process.env.BRR_SLOW !== "1") {
  console.log("compiled binary gate skipped on this lane (bun run check:all runs it)");
}

slow("compiled single binary", () => {
  test("starts in an empty directory and serves the whole tracer path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brr-chat-compile-"));
    const cwd = join(dir, "run");
    mkdirSync(cwd, { recursive: true });
    let server: Binary | null = null;
    try {
      server = await startCompiled(dir, cwd);
      const dbPath = join(cwd, "brr-chat.db");

      // No schema-mismatch log on first boot (ADR 0002).
      expect(server.log()).not.toMatch(/schema mismatch/i);
      expect(existsSync(dbPath)).toBe(true);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);

      // The embedded PWA shell, with no apps/web/dist beside the binary.
      const index = await fetch(`${server.base}/`);
      expect(index.status).toBe(200);
      const html = await index.text();
      expect(html).toContain('<script type="module" src="/app.js"></script>');
      expect(html).toContain('id="empty"');
      // The shell goes out brotli-compressed: the 150 KB budget in docs/PROTOCOL.md is
      // measured on these bytes, not on the raw bundle.
      const document = await rawGet(server.base, "/");
      expect(document.status).toBe(200);
      expect(document.headers["content-encoding"]).toBe("br");
      expect(document.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(document.headers["vary"]).toBe("Accept-Encoding");
      const bundle = await rawGet(server.base, "/app.js");
      expect(bundle.status).toBe(200);
      expect(bundle.headers["content-encoding"]).toBe("br");
      const shellBytes = document.raw.byteLength + bundle.raw.byteLength;
      console.log(`compiled binary shell on the wire (brotli): index ${document.raw.byteLength} B + app.js ${bundle.raw.byteLength} B = ${shellBytes} B of ${APP_SHELL_BUDGET} B budget`);
      expect(shellBytes).toBeLessThanOrEqual(APP_SHELL_BUDGET);

      // Sign up with a username only: no email, bare 32-char token.
      const signUp = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "password1234" }),
      });
      expect(signUp.status).toBe(200);
      const signedUp = (await signUp.json()) as { token: string; recoveryCode: string; user: { username: string; email: string } };
      expect(signedUp.user.username).toBe("alice");
      expect(signedUp.user.email).toBe("alice@127.0.0.1.invalid");
      expect(signedUp.token).toHaveLength(32);
      // Finish signup by typing the last group back (ADR 0006).
      const confirm = await fetch(`${server.base}/api/recovery/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${signedUp.token}` },
        body: JSON.stringify({ group: signedUp.recoveryCode.slice(-5) }),
      });
      expect(confirm.status).toBe(200);

      // Sign back in, then /sync the empty server: brotli on the wire, cursor 0.
      const signIn = await fetch(`${server.base}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "password1234" }),
      });
      expect(signIn.status).toBe(200);
      const { token } = (await signIn.json()) as { token: string };

      const body = encodeSyncRequest({ v: 1, cursor: 0, outbox: [] });
      const synced = await rawSync(server.base, token, body);
      expect(synced.status).toBe(200);
      expect(synced.headers["content-encoding"]).toBe("br");
      expect(synced.headers["content-type"]).toBe("application/cbor");
      const decoded = decodeSyncResponse(new Uint8Array(brotliDecompressSync(synced.cbor)));
      expect(decoded.cursor).toBe(0);
      expect(decoded.events).toEqual([]);
      expect(decoded.error).toBeUndefined();
      console.log(`compiled binary empty /sync wire bytes: ${synced.wireBytes} B of ${KB} B budget`);
      expect(synced.wireBytes).toBeLessThanOrEqual(EMPTY_SYNC_BUDGET);

      // An out-of-range version is answered instead of being parsed: trailing fields no
      // longer known to the client (ADR 0004).
      const futureBody = Uint8Array.from([
        0x83, 0x18, 0x63, 0x6a, ...Buffer.from("not-a-uint"), 0xa1, 0x66, ...Buffer.from("future"), 0x63, ...Buffer.from("map"),
      ]);
      const tooNew = await rawSync(server.base, token, futureBody);
      expect(tooNew.status).toBe(200);
      const upgrade = decodeSyncResponse(new Uint8Array(brotliDecompressSync(tooNew.cbor)));
      expect(upgrade.error).toBe(2);

      // Sign out revokes the session.
      const signOut = await fetch(`${server.base}/api/auth/sign-out`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(signOut.status).toBe(200);
      const revoked = await rawSync(server.base, token, body);
      expect(revoked.status).toBe(401);

      // The DB file stays private after a full session of writes.
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      await server?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
