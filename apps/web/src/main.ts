// The PWA shell: auth, recovery, open groups, posts and /sync. Vanilla DOM only, so the app
// shell stays inside its byte budget (ADR 0014). Every element lookup is optional, so the
// module also loads in a test or in a worker without a DOM.
import { ResponseError, Role, Tag, type SyncResponse } from "@brr-chat/protocol";
import { confirmRecovery, redeemRecovery, regenerateRecovery, signIn, signOut, signUp } from "./auth.ts";
import { identicon } from "./identicon.ts";
import { syncAndPersist, SyncHttpError } from "./sync.ts";
import {
  enqueueOp,
  getCursor,
  getGroups,
  getMembers,
  getOutbox,
  getPosts,
  getProfiles,
  getRange,
  getSelf,
  getSession,
  removeOutbox,
  setSelf,
  toWireOp,
  type StoredGroup,
  type StoredPost,
  type StoredProfile,
} from "./store.ts";

type Mode = "up" | "in";

let currentGroup: number | null = null;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

function show(id: string, visible: boolean): void {
  const node = el(id);
  if (node) node.hidden = !visible;
}

function message(text: string): void {
  setText("status", text);
}

function value(id: string): string {
  return el<HTMLInputElement>(id)?.value.trim() ?? "";
}

function clear(id: string): void {
  const node = el<HTMLInputElement>(id);
  if (node) node.value = "";
}

async function refresh(): Promise<void> {
  const session = await getSession();
  const pending = session?.recoveryPending === true;
  show("signed-out", session === null);
  show("signed-in", session !== null && !pending);
  show("confirm-panel", pending);
  setText("account", session?.username ?? "");
  setText("session", session ? "32-char bearer token, held on this device only" : "");
  setText("cursor", String(session ? await getCursor(session.username) : 0));
  const range = await getRange();
  setText("range", range ? `v${range.min}..v${range.max}` : "unknown");
  await refreshGroups();
  await renderGroup();
}

function groupItem(group: StoredGroup, joining: boolean): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = joining ? `Join ${group.name}` : group.name;
  if (joining) {
    button.addEventListener("click", () => void joinGroup(group));
  } else {
    button.setAttribute("aria-current", currentGroup === group.id ? "true" : "false");
    button.addEventListener("click", () => {
      currentGroup = group.id;
      void renderGroup();
      void refreshGroups();
    });
  }
  item.append(button);
  if (group.about.length > 0) {
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = group.about;
    item.append(note);
  }
  return item;
}

async function refreshGroups(): Promise<void> {
  const session = await getSession();
  const joinedList = el("groups-list");
  const openList = el("open-list");
  if (!session || !joinedList || !openList) return;

  const self = await getSelf(session.username);
  setText("self", self === null ? "not known yet" : `#${self}`);

  const joined: StoredGroup[] = [];
  const open: StoredGroup[] = [];
  for (const group of await getGroups(session.username)) {
    const members = await getMembers(session.username, group.id);
    if (self !== null && members.some((member) => member.user === self)) joined.push(group);
    else if (group.open) open.push(group);
  }

  joinedList.replaceChildren(...joined.map((group) => groupItem(group, false)));
  openList.replaceChildren(...open.map((group) => groupItem(group, true)));
  show("no-groups", joined.length === 0);
  show("no-open-groups", open.length === 0);
}

function postItem(post: StoredPost, profile: StoredProfile | undefined): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "post";

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = identicon(post.author);
  avatar.alt = "";
  avatar.width = 32;
  avatar.height = 32;

  const body = document.createElement("div");
  const meta = document.createElement("p");
  meta.className = "meta";
  const name = profile?.displayName || profile?.username || `user #${post.author}`;
  const when = new Date(post.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = `${name} · ${when}`;
  const text = document.createElement("p");
  text.className = "text";
  text.textContent = post.text;
  body.append(meta, text);
  item.append(avatar, body);
  return item;
}

async function renderGroup(): Promise<void> {
  const view = el("group-view");
  if (!view) return;
  const session = await getSession();
  if (!session) {
    show("group-view", false);
    return;
  }
  const group = currentGroup === null ? undefined : (await getGroups(session.username)).find((row) => row.id === currentGroup);
  show("group-view", group !== undefined);
  if (!group) return;

  setText("group-title", group.name);
  setText("group-about", group.about.length > 0 ? group.about : group.open ? "Open group" : "Invite-only group");
  const members = await getMembers(session.username, group.id);
  setText("group-members", `${members.length} ${members.length === 1 ? "member" : "members"}`);

  const profiles = await getProfiles(session.username);
  const posts = await getPosts(session.username, group.id);
  const list = el("posts");
  if (list) list.replaceChildren(...posts.map((post) => postItem(post, profiles.get(post.author))));

  if (currentGroup !== null) {
    const input = el<HTMLInputElement>("post-text");
    if (input) input.placeholder = `Message ${group.name}`;
  }
}

async function identifySelf(username: string): Promise<void> {
  if ((await getSelf(username)) !== null) return;
  for (const profile of (await getProfiles(username)).values()) {
    if (profile.username === username) {
      await setSelf(username, profile.user);
      return;
    }
  }
}

function explainAck(error: number): string {
  switch (error) {
    case 1:
      return "This server does not support that action yet.";
    case 2:
      return "Not allowed. Creating a group needs an account at least 24 hours old; posting needs membership.";
    case 3:
      return "The server rejected that request as invalid.";
    case 4:
      return "That group no longer exists.";
    case 5:
      return "Too many requests. Try again in a moment.";
    default:
      return "The server rejected that request.";
  }
}

async function syncNow(): Promise<SyncResponse | null> {
  const session = await getSession();
  if (!session) {
    message("Sign in first.");
    return null;
  }

  // The wire id is learned from the profile event this account publishes; no extra endpoint.
  if ((await getSelf(session.username)) === null && !(await getOutbox(session.username)).some((op) => op.tag === Tag.Profile)) {
    await enqueueOp(session.username, {
      tag: Tag.Profile,
      scope: 0,
      username: session.username,
      displayName: session.username,
      bio: "",
    });
  }

  try {
    const outbox = (await getOutbox(session.username)).map(toWireOp);
    const outcome = await syncAndPersist(location.origin, session.token, session.username, outbox);
    if (outcome.kind === "upgrade") {
      const { range, error } = outcome;
      message(
        error === ResponseError.ClientTooOld
          ? `This server is too old: it speaks up to v${range.max}. Update the app.`
          : `This server moved on: it wants at least v${range.min}. An update is on the way.`,
      );
      await refresh();
      return null;
    }

    const { response } = outcome;
    await removeOutbox(session.username, response.acks.map((ack) => ack.cid));
    await identifySelf(session.username);

    const failure = response.acks.find((ack) => "error" in ack);
    if (failure && "error" in failure) message(explainAck(failure.error));
    else message(`In sync at ${response.cursor}.`);

    setText("cursor", String(response.cursor));
    show("empty", response.events.length === 0 && response.cursor === 0 && (await getGroups(session.username)).length === 0);
    await refresh();
    return response;
  } catch (err) {
    const text =
      err instanceof SyncHttpError && err.status === 403
        ? "Save your recovery code and type its last group to finish signup."
        : err instanceof Error
          ? err.message
          : "Sync failed.";
    message(text);
    return null;
  }
}

async function submit(mode: Mode): Promise<void> {
  const username = value("username");
  const password = el<HTMLInputElement>("password")?.value ?? "";
  if (username.length === 0 || password.length === 0) {
    message("Username and password are both required.");
    return;
  }
  try {
    if (mode === "up") {
      const { session, recoveryCode } = await signUp(location.origin, username, password);
      setText("recovery-code", recoveryCode);
      message(`Account created for ${session.username}. Save the code, then type its last group.`);
      await refresh();
      return;
    }
    const session = await signIn(location.origin, username, password);
    message(`Signed in as ${session.username}.`);
  } catch (err) {
    message(err instanceof Error ? err.message : "Sign in failed.");
    return;
  }
  await refresh();
  await syncNow();
}

async function finishSignup(): Promise<void> {
  const group = value("recovery-group");
  if (group.length === 0) {
    message("Type the last group of your recovery code to finish.");
    return;
  }
  try {
    await confirmRecovery(location.origin, group);
    setText("recovery-code", "");
    message("Recovery code confirmed. Signup is finished.");
  } catch (err) {
    message(err instanceof Error ? err.message : "That code did not match.");
    return;
  }
  await refresh();
  await syncNow();
}

async function newCode(): Promise<void> {
  try {
    const code = await regenerateRecovery(location.origin);
    const session = await getSession();
    if (session?.recoveryPending === true) {
      setText("recovery-code", code);
      message("New code shown once. Type its last group to finish signup.");
    } else {
      setText("new-code", code);
      show("code-panel", true);
      message("New recovery code shown once. The old one no longer works.");
    }
  } catch (err) {
    message(err instanceof Error ? err.message : "Could not make a new code.");
  }
}

async function recover(): Promise<void> {
  const username = value("recover-username");
  const code = value("recover-code");
  if (username.length === 0 || code.length === 0) {
    message("Your username and recovery code are both required.");
    return;
  }
  try {
    const { session, recoveryCode } = await redeemRecovery(location.origin, username, code);
    setText("new-code", recoveryCode);
    show("code-panel", true);
    show("recover-panel", false);
    message(`Signed in as ${session.username}. Save the new code: it is shown once.`);
  } catch (err) {
    message(err instanceof Error ? err.message : "Recovery failed.");
    return;
  }
  await refresh();
  await syncNow();
}

async function createGroup(): Promise<void> {
  const session = await getSession();
  if (!session) {
    message("Sign in first.");
    return;
  }
  const name = value("create-name");
  if (name.length === 0) {
    message("Give the group a name.");
    return;
  }
  const queued = await enqueueOp(session.username, {
    tag: Tag.GroupMeta,
    scope: 0,
    name,
    about: value("create-about"),
    // This slice creates open groups; invite-only groups arrive with their join link (#10).
    open: true,
  });
  clear("create-name");
  clear("create-about");
  const response = await syncNow();
  const ack = response?.acks.find((row) => row.cid.every((byte, i) => byte === queued.cid[i]));
  if (ack && "seq" in ack) currentGroup = ack.seq;
  await refresh();
}

async function joinGroup(group: StoredGroup): Promise<void> {
  const session = await getSession();
  const self = session ? await getSelf(session.username) : null;
  if (!session || self === null) {
    message("Still syncing this account. Try again in a moment.");
    return;
  }
  await enqueueOp(session.username, {
    tag: Tag.Membership,
    scope: group.id,
    user: self,
    role: Role.Member,
  });
  currentGroup = group.id;
  await syncNow();
}

async function postMessage(): Promise<void> {
  const session = await getSession();
  const text = value("post-text");
  if (!session) {
    message("Sign in first.");
    return;
  }
  if (text.length === 0) {
    message("Write something first.");
    return;
  }
  if (currentGroup === null) {
    message("Open a group first.");
    return;
  }
  await enqueueOp(session.username, { tag: Tag.Post, scope: currentGroup, text });
  clear("post-text");
  await syncNow();
}

async function leave(): Promise<void> {
  try {
    await signOut(location.origin);
    currentGroup = null;
    setText("new-code", "");
    show("code-panel", false);
    message("Signed out.");
  } catch (err) {
    message(err instanceof Error ? err.message : "Sign out failed.");
  }
  await refresh();
}

function toggleRecovery(): void {
  const panel = el("recover-panel");
  if (panel) panel.hidden = !panel.hidden;
}

function wire(): void {
  el<HTMLButtonElement>("sign-up")?.addEventListener("click", () => void submit("up"));
  el<HTMLButtonElement>("sign-in")?.addEventListener("click", () => void submit("in"));
  el<HTMLButtonElement>("sign-out")?.addEventListener("click", () => void leave());
  el<HTMLButtonElement>("sync")?.addEventListener("click", () => void syncNow());
  el<HTMLButtonElement>("confirm")?.addEventListener("click", () => void finishSignup());
  el<HTMLButtonElement>("regenerate")?.addEventListener("click", () => void newCode());
  el<HTMLButtonElement>("refresh-code")?.addEventListener("click", () => void newCode());
  el<HTMLButtonElement>("show-recovery")?.addEventListener("click", toggleRecovery);
  el<HTMLButtonElement>("recover")?.addEventListener("click", () => void recover());
  el<HTMLButtonElement>("create")?.addEventListener("click", () => void createGroup());
  el<HTMLButtonElement>("post")?.addEventListener("click", () => void postMessage());
}

function boot(): void {
  if (typeof document === "undefined") return;
  wire();
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Without a service worker the app still works, it just refetches the shell.
    });
  }
  void (async () => {
    await refresh();
    const session = await getSession();
    if (session && session.recoveryPending !== true) await syncNow();
  })();
}

boot();
