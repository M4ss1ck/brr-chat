// Builds the PWA shell with esbuild and hands it to the server as a generated module, so a
// compiled binary serves the same shell with no files on disk (issue #5, ADR 0014).
// Run from apps/web: `bun run build`.
import { brotliCompressSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const KB = 1024;
/** Matches the app shell budget in docs/PROTOCOL.md; the gate lives in test/budget.test.ts. */
const APP_SHELL_BUDGET = 150 * KB;

const webRoot = join(import.meta.dir, "..");
const distDir = join(webRoot, "dist");
const generatedFile = join(webRoot, "..", "server", "src", "pwa-assets.generated.ts");

interface ShellEntry {
  /** Path the server answers on. "/" and "/index.html" are the same document. */
  route: string;
  file: string;
  contentType: string;
  cacheControl: string;
}

const SHELL: readonly ShellEntry[] = [
  { route: "/", file: "index.html", contentType: "text/html; charset=utf-8", cacheControl: "no-cache" },
  { route: "/index.html", file: "index.html", contentType: "text/html; charset=utf-8", cacheControl: "no-cache" },
  { route: "/app.js", file: "app.js", contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
  { route: "/sw.js", file: "sw.js", contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
  { route: "/manifest.webmanifest", file: "manifest.webmanifest", contentType: "application/manifest+json", cacheControl: "max-age=3600" },
  { route: "/icon.svg", file: "icon.svg", contentType: "image/svg+xml", cacheControl: "max-age=86400" },
];

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#10100e">
<meta name="color-scheme" content="dark light">
<title>brr chat</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root { color-scheme: dark light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 34rem;
  padding: 1rem 1rem 3rem;
  background: #10100e;
  color: #f2efe6;
  font: 1rem/1.45 system-ui, sans-serif;
}
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 1.25rem 0 .25rem; }
p { margin: .25rem 0; }
label { display: block; margin: .6rem 0; font-size: .9rem; }
input {
  display: block; width: 100%; margin-top: .2rem; padding: .55rem;
  border: 1px solid #4a4740; border-radius: .4rem;
  background: #17170f; color: inherit; font: inherit;
}
button {
  margin: .2rem .4rem .2rem 0; padding: .55rem .9rem;
  border: 1px solid #6d6a5e; border-radius: .4rem;
  background: #22211a; color: inherit; font: inherit;
}
#sign-up { background: #f2efe6; color: #10100e; font-weight: 600; }
#status { min-height: 1.4rem; margin: .75rem 0; font-size: .9rem; }
dl { display: grid; grid-template-columns: auto 1fr; gap: .1rem .75rem; margin: .5rem 0; font-size: .9rem; }
dt { color: #a9a49a; }
dd { margin: 0; overflow-wrap: anywhere; }
#empty { color: #d8c56a; }
</style>
</head>
<body>
<main>
  <section id="signed-out" hidden>
    <h1>brr chat</h1>
    <p>One username, no email. Groups and DMs only.</p>
    <form id="auth" autocomplete="off">
      <label>Username
        <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      </label>
      <label>Password
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </label>
      <button type="button" id="sign-up">Create account</button>
      <button type="button" id="sign-in">Sign in</button>
    </form>
  </section>

  <section id="signed-in" hidden>
    <h1>brr chat</h1>
    <h2 id="account"></h2>
    <p id="empty" hidden>No messages yet. This server is empty.</p>
    <dl>
      <dt>token</dt><dd id="token"></dd>
      <dt>last synced seq</dt><dd id="cursor">0</dd>
      <dt>server speaks</dt><dd id="range">unknown</dd>
    </dl>
    <button type="button" id="sync">Sync</button>
    <button type="button" id="sign-out">Sign out</button>
  </section>

  <p id="status" role="status" aria-live="polite"></p>
</main>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

const MANIFEST = `{
  "name": "brr chat",
  "short_name": "brr",
  "description": "Data-saving chat for groups and DMs.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#10100e",
  "theme_color": "#10100e",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
  ]
}
`;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="brr chat">
<rect width="64" height="64" rx="14" fill="#10100e"/>
<circle cx="24" cy="26" r="6" fill="#f2efe6"/>
<circle cx="41" cy="26" r="6" fill="#f2efe6"/>
<ellipse cx="32.5" cy="44" rx="13" ry="9" fill="#f2efe6"/>
<circle cx="32.5" cy="41" r="4" fill="#10100e"/>
</svg>
`;

async function bundle(): Promise<void> {
  mkdirSync(distDir, { recursive: true });
  const shared = {
    bundle: true,
    format: "esm" as const,
    target: "es2022" as const,
    minify: true,
    charset: "utf8" as const,
    legalComments: "none" as const,
  };
  await build({ ...shared, entryPoints: [join(webRoot, "src", "main.ts")], outfile: join(distDir, "app.js") });
  await build({ ...shared, entryPoints: [join(webRoot, "src", "sw.ts")], outfile: join(distDir, "sw.js") });
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);
  writeFileSync(join(distDir, "manifest.webmanifest"), MANIFEST);
  writeFileSync(join(distDir, "icon.svg"), ICON);
}

/** Writes the module the server imports, so `bun build --compile` embeds the shell. */
function generateServerModule(): void {
  const bodies = new Map<string, string>();
  for (const entry of SHELL) {
    if (!bodies.has(entry.file)) bodies.set(entry.file, readFileSync(join(distDir, entry.file), "utf8"));
  }
  const routes = SHELL.map(
    (entry) =>
      `  ${JSON.stringify(entry.route)}: {\n    contentType: ${JSON.stringify(entry.contentType)},\n    cacheControl: ${JSON.stringify(entry.cacheControl)},\n    body: ${JSON.stringify(bodies.get(entry.file) ?? "")},\n  },`,
  );
  writeFileSync(
    generatedFile,
    `// GENERATED by apps/web/scripts/build.ts -- do not edit by hand.
// The app shell the server embeds, so a compiled binary serves the PWA with no files on disk.

export interface ShellAsset {
  contentType: string;
  cacheControl: string;
  body: string;
}

export const SHELL_ROUTES: Record<string, ShellAsset> = {
${routes.join("\n")}
};
`,
  );
}

function report(): void {
  const seen = new Set<string>();
  let compressed = 0;
  for (const entry of SHELL) {
    const body = readFileSync(join(distDir, entry.file));
    const size = brotliCompressSync(body).length;
    if (!seen.has(entry.file)) {
      seen.add(entry.file);
      compressed += size;
      console.log(`  shell ${entry.file}: ${body.byteLength} B raw, ${size} B brotli`);
    }
  }
  console.log(`app shell compressed: ${compressed} B of ${APP_SHELL_BUDGET} B budget`);
}

await bundle();
generateServerModule();
report();
