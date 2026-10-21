// Builds the PWA shell with esbuild and hands it to the server as a generated module, so a
// compiled binary serves the same shell with no files on disk (issue #5, ADR 0014).
// Run from apps/web: `bun run build`.
import { APP_SHELL_BUDGET } from "@brr-chat/protocol";
import { brotliCompressSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const webRoot = join(import.meta.dir, "..");
const distDir = join(webRoot, "dist");
const generatedFile = join(webRoot, "..", "server", "src", "pwa-assets.generated.ts");

interface ShellFile {
  name: string;
  contentType: string;
  cacheControl: string;
}

/** One entry per built file. Routes alias a file, so a path change is one edit here. */
const SHELL: readonly ShellFile[] = [
  { name: "index.html", contentType: "text/html; charset=utf-8", cacheControl: "no-cache" },
  { name: "app.js", contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
  { name: "sw.js", contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
  { name: "manifest.webmanifest", contentType: "application/manifest+json", cacheControl: "max-age=3600" },
  { name: "icon.svg", contentType: "image/svg+xml", cacheControl: "max-age=86400" },
  // Loaded on demand by the Add-server panel, not part of the first load (ADR 0020).
  { name: "qr-scan.js", contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
  // Loaded on demand by the passkey buttons, so the WebAuthn library is not in the first
  // load (ADR 0014, ADR 0021).
  { name: "passkey.js", contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache" },
];

/** Paths the server answers. "/" and "/index.html" are the same document. */
const ROUTES: readonly { route: string; file: string }[] = [
  { route: "/", file: "index.html" },
  { route: "/index.html", file: "index.html" },
  { route: "/app.js", file: "app.js" },
  { route: "/sw.js", file: "sw.js" },
  { route: "/manifest.webmanifest", file: "manifest.webmanifest" },
  { route: "/icon.svg", file: "icon.svg" },
  { route: "/qr-scan.js", file: "qr-scan.js" },
  { route: "/passkey.js", file: "passkey.js" },
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
/* A hidden panel must stay hidden even when its element has a display rule (labels,
   sections); every show()/hide() in the app relies on the hidden attribute alone. */
[hidden] { display: none !important; }
body {
  margin: 0 auto;
  max-width: 34rem;
  padding: 1rem 1rem 3rem;
  background: #10100e;
  color: #f2efe6;
  font: 1rem/1.45 system-ui, sans-serif;
}
/* The data meter is always on screen: sticky, above the content, never inside a signed-in
   panel, so a signed-out visitor still sees what this device has spent. */
#meter {
  position: sticky; top: 0; z-index: 1;
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: .25rem .75rem;
  margin: -.35rem 0 .9rem; padding: .45rem .15rem;
  background: #10100e; border-bottom: 1px solid #2f2e25;
  font-size: .78rem; color: #a9a49a;
}
#meter span { display: flex; align-items: baseline; gap: .3rem; }
#meter strong { color: #d8c56a; font: 600 .82rem/1.2 ui-monospace, monospace; }
/* Once there is more than one server, the same two scopes are shown per server, because
   "which community cost me this" is the question the meter has to answer (#18). Three
   aligned columns keep the numbers readable without repeating a label per row. */
#meter-servers { flex-basis: 100%; margin-top: .15rem; font-size: .72rem; color: #a9a49a; }
#meter-servers p, #meter-servers li {
  display: grid; grid-template-columns: 1fr auto auto; gap: .1rem .9rem; margin: 0;
}
#meter-servers ul { list-style: none; margin: .1rem 0 0; padding: 0; }
#meter-servers span:first-child { color: #f2efe6; overflow-wrap: anywhere; }
#meter-servers li[aria-current="true"] span:first-child { color: #d8c56a; }
#meter-servers span:not(:first-child) {
  text-align: right; font: 600 .72rem/1.35 ui-monospace, monospace; color: #d8c56a;
}
/* The server list is device state, so it sits outside both auth panels like the meter. */
#server-bar {
  display: flex; flex-wrap: wrap; align-items: end; gap: .4rem;
  margin: 0 0 .8rem; padding: 0 0 .6rem; border-bottom: 1px solid #2f2e25;
}
#server-bar label { flex: 1 1 12rem; margin: 0; }
#server-bar button { margin: 0; padding: .45rem .7rem; font-size: .82rem; }
#add-server { margin: 0 0 1rem; padding: .7rem; border: 1px solid #4a4740; border-radius: .4rem; }
#server-link { font: .82rem/1.4 ui-monospace, monospace; }
#qr-video { display: block; width: 100%; max-width: 18rem; margin: .5rem 0; border-radius: .4rem; background: #000; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 1.25rem 0 .25rem; }
p { margin: .25rem 0; }
label { display: block; margin: .6rem 0; font-size: .9rem; }
input, select {
  display: block; width: 100%; margin-top: .2rem; padding: .55rem;
  border: 1px solid #4a4740; border-radius: .4rem;
  background: #17170f; color: inherit; font: inherit;
}
button {
  margin: .2rem .4rem .2rem 0; padding: .55rem .9rem;
  border: 1px solid #6d6a5e; border-radius: .4rem;
  background: #22211a; color: inherit; font: inherit;
}
input[type="checkbox"] { display: inline; width: auto; margin: 0 .4rem 0 0; }
#sign-up { background: #f2efe6; color: #10100e; font-weight: 600; }
#status { min-height: 1.4rem; margin: .75rem 0; font-size: .9rem; }
dl { display: grid; grid-template-columns: auto 1fr; gap: .1rem .75rem; margin: .5rem 0; font-size: .9rem; }
dt { color: #a9a49a; }
dd { margin: 0; overflow-wrap: anywhere; }
#empty { color: #d8c56a; }
.note { color: #a9a49a; font-size: .85rem; }
#outbox-list li {
  display: grid; gap: .25rem; padding: .55rem;
  border: 1px solid #6d6a5e; border-radius: .4rem;
}
#outbox-list .outbox-label { overflow-wrap: anywhere; user-select: text; }
#outbox-list button { justify-self: start; margin: 0; padding: .25rem .55rem; font-size: .8rem; }
output {
  display: block; margin: .6rem 0; padding: .6rem;
  border: 1px dashed #6d6a5e; border-radius: .4rem;
  font: 600 1.15rem/1.4 ui-monospace, monospace; letter-spacing: .08em;
  overflow-wrap: anywhere; color: #d8c56a;
}
#recover-code { letter-spacing: .08em; }
ul { list-style: none; padding: 0; margin: .4rem 0; }
.list li { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .3rem 0; }
.list li button { margin: 0; }
#groups-list button[aria-current="true"], #dm-list button[aria-current="true"] { border-color: #f2efe6; background: #2b2a20; }
#group-view { margin: .5rem 0 1rem; }
#group-title { margin: .5rem 0 .1rem; }
#invite-panel { margin: .6rem 0; padding: .6rem; border: 1px solid #4a4740; border-radius: .4rem; }
#invite-link { font: .78rem/1.4 ui-monospace, monospace; }
#invite-qr svg, #server-invite-qr svg { width: 8rem; height: 8rem; background: #f2efe6; padding: .2rem; border-radius: .3rem; }
.posts { display: grid; gap: .6rem; margin: .8rem 0; }
.post { display: grid; grid-template-columns: 32px 1fr; gap: .55rem; align-items: start; }
.avatar { border-radius: .35rem; background: #17170f; }
.post .meta { margin: 0; font-size: .78rem; color: #a9a49a; }
.post .text { margin: .1rem 0 0; overflow-wrap: anywhere; }
.post .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem; margin: .35rem 0 0; }
.post .reactions { display: flex; flex-wrap: wrap; gap: .15rem; }
.post .reaction {
  min-width: 2rem; margin: 0; padding: .2rem .35rem;
  font-size: .85rem; line-height: 1.2;
}
.post .reaction[aria-pressed="true"] { border-color: #d8c56a; background: #2b2a20; }
.post .reply { margin: 0 0 0 .2rem; padding: .2rem .5rem; font-size: .8rem; }
.post .reply[aria-pressed="true"] { border-color: #d8c56a; }
.post .delete { padding: .2rem .5rem; font-size: .8rem; color: #e0a090; }
.post .media {
  display: block; width: 100%; max-width: 22rem; margin: .45rem 0 0; padding: 0;
  border: 1px solid #2f2e25; border-radius: .4rem; overflow: hidden;
  background: #17170f; cursor: zoom-in;
}
.post .media img { display: block; width: 100%; height: auto; }
.post .media.loading img { opacity: .55; }
.post .media.failed::after { content: "Tap to retry"; display: block; padding: .4rem; color: #e0a090; font-size: .8rem; }
input[type="file"] { padding: .35rem; }
#member-list li, #banned-list li, #server-users li { font-size: .85rem; }
#member-list button, #banned-list button, #server-users button { margin: 0; padding: .2rem .5rem; font-size: .78rem; }
#server-invite-panel { margin: .6rem 0; padding: .6rem; border: 1px solid #4a4740; border-radius: .4rem; }
#server-invite-link { font: .78rem/1.4 ui-monospace, monospace; }
#server-admin { margin: 1rem 0; padding: .75rem; border: 1px solid #6d6a5e; border-radius: .4rem; }
.post.reply { margin-left: 1.1rem; padding-left: .55rem; border-left: 2px solid #2f2e25; }
.post .replies { display: grid; gap: .5rem; margin: .5rem 0 0; }
#reply-note { display: flex; align-items: center; gap: .4rem; }
#reply-note button { margin: 0; padding: .2rem .5rem; font-size: .8rem; }
</style>
</head>
<body>
<main>
  <section id="meter" aria-label="Data usage">
    <span>This session <strong id="meter-session">0 B</strong></span>
    <span>This month <strong id="meter-month">0 B</strong></span>
    <div id="meter-servers" hidden>
      <p aria-hidden="true"><span>server</span><span>session</span><span>month</span></p>
      <ul id="meter-servers-list" aria-label="Data usage per server"></ul>
    </div>
  </section>

  <section id="server-bar" aria-label="Server">
    <label>Server
      <select id="server-select"></select>
    </label>
    <button type="button" id="add-server-show">Add server</button>
    <button type="button" id="server-remove" aria-label="Remove this server from this device" hidden>Remove</button>
  </section>

  <section id="add-server" hidden>
    <h2>Add a server</h2>
    <p class="note">Like a network in an IRC client. Each server keeps its own account, cursor and cached messages. Add one by its address or by an invite link or QR code from that server.</p>
    <label>Server address or invite link
      <input id="server-link" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://chat.example or https://chat.example/signup/…">
    </label>
    <button type="button" id="add-server-link">Add from link</button>
    <label>QR code image
      <input id="server-qr-file" type="file" accept="image/*">
    </label>
    <button type="button" id="add-server-camera">Scan with camera</button>
    <button type="button" id="add-server-cancel">Cancel</button>
    <video id="qr-video" hidden playsinline muted></video>
    <button type="button" id="qr-stop" hidden>Stop camera</button>
    <p class="note">The camera image is decoded on this device and never uploaded. A screenshot or photo of the code works too.</p>
  </section>

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
      <label id="signup-invite-label" hidden>Server invite code
        <input id="signup-invite" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="From your invite link">
      </label>
      <p id="registration-note" class="note" hidden></p>
      <button type="button" id="sign-up">Create account</button>
      <button type="button" id="sign-in">Sign in</button>
    </form>
    <button type="button" id="passkey-sign-in" hidden>Sign in with a passkey</button>
    <button type="button" id="show-recovery">Use a recovery code</button>
    <form id="recover-panel" hidden autocomplete="off">
      <h2>Recovery code</h2>
      <label>Username
        <input id="recover-username" autocapitalize="none" spellcheck="false">
      </label>
      <label>Recovery code
        <input id="recover-code" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX">
      </label>
      <button type="button" id="recover">Sign in with code</button>
    </form>
    <p class="note">No email recovery, no admin reset. If you lose your recovery code and cannot sign in on any device, the account is gone.</p>
  </section>

  <section id="confirm-panel" hidden>
    <h1>Save your recovery code</h1>
    <p>This is the only time it is shown. Write it down somewhere safe.</p>
    <output id="recovery-code"></output>
    <label>Type the last group to finish
      <input id="recovery-group" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX">
    </label>
    <button type="button" id="confirm">Finish sign-up</button>
    <button type="button" id="refresh-code">Show a new code</button>
    <p class="note">Losing this code and every way to sign in means losing the account. There is no email recovery and no admin reset.</p>
  </section>

  <section id="signed-in" hidden>
    <h1>brr chat</h1>
    <h2 id="account"></h2>
    <p id="empty" hidden>No messages yet. This server is empty.</p>

    <section id="outbox" hidden>
      <h2>Unsent</h2>
      <p class="note">These queued messages were not sent because something they answer was deleted. The text stays here: copy it before discarding.</p>
      <ul id="outbox-list" class="list"></ul>
    </section>

    <h2>Groups</h2>
    <ul id="groups-list" class="list"></ul>
    <p id="no-groups" class="note" hidden>No groups yet. Create one, or join an open group below.</p>

    <section id="group-view" hidden>
      <h3 id="group-title"></h3>
      <p id="group-about" class="note"></p>
      <p id="group-members" class="note"></p>
      <section id="invite-panel" hidden>
        <h4>Invite link</h4>
        <output id="invite-link"></output>
        <div id="invite-qr"></div>
        <button type="button" id="copy-invite">Copy link</button>
        <button type="button" id="rotate-invite">Rotate link</button>
        <p class="note">Anyone with this link or its QR code can join. Rotating it stops the old link from working.</p>
      </section>
      <ul id="member-list" class="list"></ul>
      <p id="banned-label" class="note" hidden>Banned</p>
      <ul id="banned-list" class="list"></ul>
      <button type="button" id="load-older" hidden>Load older posts</button>
      <ul id="posts" class="posts"></ul>
      <p id="reply-note" class="note" hidden><span id="reply-label"></span> <button type="button" id="cancel-reply">Cancel</button></p>
      <label>Message
        <input id="post-text" autocomplete="off" autocapitalize="sentences">
      </label>
      <label>Photo
        <input id="post-image" type="file" accept="image/*">
      </label>
      <p id="post-image-note" class="note" hidden></p>
      <button type="button" id="post-image-clear" hidden>Remove photo</button>
      <button type="button" id="post">Post</button>
    </section>

    <h2>Direct messages</h2>
    <ul id="dm-list" class="list"></ul>
    <p id="no-dms" class="note" hidden>No direct messages yet. Start one below.</p>

    <section id="dm-view" hidden>
      <h3 id="dm-title"></h3>
      <button type="button" id="dm-load-older" hidden>Load older messages</button>
      <ul id="dm-messages" class="posts"></ul>
      <p id="dm-empty" class="note" hidden>No messages yet. Say hi.</p>
      <label>Message
        <input id="dm-text" autocomplete="off" autocapitalize="sentences">
      </label>
      <label>Photo
        <input id="dm-image" type="file" accept="image/*">
      </label>
      <p id="dm-image-note" class="note" hidden></p>
      <button type="button" id="dm-image-clear" hidden>Remove photo</button>
      <button type="button" id="dm-send">Send</button>
    </section>

    <h2>New direct message</h2>
    <label>Username
      <input id="dm-username" autocomplete="off" autocapitalize="none" spellcheck="false">
    </label>
    <button type="button" id="dm-start">Message</button>

    <h2>Open groups</h2>
    <ul id="open-list" class="list"></ul>
    <p id="no-open-groups" class="note" hidden>No open groups to join right now.</p>

    <h2>New group</h2>
    <label>Name
      <input id="create-name" autocomplete="off">
    </label>
    <label>About
      <input id="create-about" autocomplete="off">
    </label>
    <label><input type="checkbox" id="create-private"> Invite-only (join by link or QR code)</label>
    <button type="button" id="create">Create group</button>

    <section id="server-admin" hidden>
      <h2>Server administration</h2>
      <p class="note">This account administers the server. Changes apply to the next signup.</p>
      <label>Registration
        <select id="registration-mode">
          <option value="open">Open: anyone can sign up</option>
          <option value="invite">Invite: a server link is required</option>
          <option value="closed">Closed: no new accounts</option>
        </select>
      </label>
      <label><input type="checkbox" id="registration-frozen"> Freeze signups</label>
      <button type="button" id="save-server-settings">Save registration</button>
      <section id="server-invite-panel">
        <h3>Server invite link</h3>
        <output id="server-invite-link"></output>
        <div id="server-invite-qr"></div>
        <button type="button" id="copy-server-invite">Copy link</button>
        <button type="button" id="rotate-server-invite">New link</button>
        <p class="note">Needed only in invite mode. Anyone with this link can sign up while it is the live link. Rotating it stops the old link from working.</p>
      </section>
      <h3>Accounts</h3>
      <ul id="server-users" class="list"></ul>
      <p id="no-server-users" class="note" hidden>No synced accounts yet.</p>
      <p class="note">A server ban revokes every session and removes the account from every group and DM.</p>
    </section>

    <dl>
      <dt>you are</dt><dd id="self">unknown</dd>
      <dt>session</dt><dd id="session"></dd>
      <dt>last synced seq</dt><dd id="cursor">0</dd>
      <dt>server speaks</dt><dd id="range">unknown</dd>
    </dl>
    <button type="button" id="sync">Sync</button>
    <button type="button" id="sign-out">Sign out</button>
    <section id="passkey-panel" hidden>
      <h2>Passkeys</h2>
      <p class="note">A passkey signs you in with this device's screen lock, fingerprint or a security key. It never leaves the device; only its public half reaches the server.</p>
      <button type="button" id="passkey-add">Add a passkey</button>
    </section>
    <h2>Recovery code</h2>
    <p class="note">This code is the only way back in if you also lose your password and every signed-in device. Lose all of them and the account is gone: there is no email recovery and no admin reset.</p>
    <button type="button" id="regenerate">New recovery code</button>
    <div id="code-panel" hidden><output id="new-code"></output></div>
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
  // The QR scanner is its own bundle so jsQR never rides in the app shell.
  await build({ ...shared, entryPoints: [join(webRoot, "src", "qr-scan.ts")], outfile: join(distDir, "qr-scan.js") });
  // Same for the WebAuthn browser library: a password user never downloads it.
  await build({ ...shared, entryPoints: [join(webRoot, "src", "passkey.ts")], outfile: join(distDir, "passkey.js") });
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);
  writeFileSync(join(distDir, "manifest.webmanifest"), MANIFEST);
  writeFileSync(join(distDir, "icon.svg"), ICON);
}

/** Writes the module the server imports, so `bun build --compile` embeds the shell. */
function generateServerModule(): void {
  const files = SHELL.map((file) => {
    const body = readFileSync(join(distDir, file.name), "utf8");
    return `  ${JSON.stringify(file.name)}: {
    contentType: ${JSON.stringify(file.contentType)},
    cacheControl: ${JSON.stringify(file.cacheControl)},
    body: ${JSON.stringify(body)},
  },`;
  });
  writeFileSync(
    generatedFile,
    `// GENERATED by apps/web/scripts/build.ts -- do not edit by hand.
// The app shell the server embeds, so a compiled binary serves the PWA with no files on disk.
// One entry per built file, plus the routes that alias them.

export interface ShellAsset {
  contentType: string;
  cacheControl: string;
  body: string;
}

export const SHELL_FILES: Record<string, ShellAsset> = {
${files.join("\n")}
};

export const SHELL_ROUTES: Record<string, string> = {
${ROUTES.map(({ route, file }) => `  ${JSON.stringify(route)}: ${JSON.stringify(file)},`).join("\n")}
};
`,
  );
}

function report(): void {
  let compressed = 0;
  for (const file of SHELL) {
    const body = readFileSync(join(distDir, file.name));
    const size = brotliCompressSync(body).length;
    compressed += size;
    console.log(`  shell ${file.name}: ${body.byteLength} B raw, ${size} B brotli`);
  }
  console.log(`app shell compressed: ${compressed} B of ${APP_SHELL_BUDGET} B budget`);
}

await bundle();
generateServerModule();
report();
