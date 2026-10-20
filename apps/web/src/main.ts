// The PWA shell: auth, recovery, open groups, posts and /sync. Vanilla DOM only, so the app
// shell stays inside its byte budget (ADR 0014). Every element lookup is optional, so the
// module also loads in a test or in a worker without a DOM.
import { EMOJI_PALETTE, ResponseError, Role, Tag, type SyncResponse } from "@brr-chat/protocol";
import { confirmRecovery, redeemRecovery, regenerateRecovery, signIn, signOut, signUp } from "./auth.ts";
import { identicon } from "./identicon.ts";
import { getInvite, resolveInvite, rotateInvite, type InviteLink } from "./invites.ts";
import { qrSvg } from "./qr.ts";
import { syncAndPersist, SyncHttpError } from "./sync.ts";
import {
  enqueueOp,
  getCursor,
  getDmScopes,
  getGroups,
  getMembers,
  getOutbox,
  getPosts,
  getProfiles,
  getRange,
  getReactions,
  getSelf,
  getSession,
  nextReactionOn,
  removeOutbox,
  setSelf,
  tallyReactions,
  toWireOp,
  type ReactionTally,
  type StoredDm,
  type StoredGroup,
  type StoredPost,
  type StoredProfile,
} from "./store.ts";

type Mode = "up" | "in";

let currentGroup: number | null = null;
let currentDm: number | null = null;
/** Set while composing the first message to a peer; the scope does not exist until it is sent. */
let pendingDmPeer: number | null = null;
/** Post being replied to in the composer, or null for a top-level post. */
let replyingTo: number | null = null;
/** Taps are serialized, so the second tap sees the first one's new state. */
let reactionQueue: Promise<void> = Promise.resolve();
/** The invite link currently shown for this group, if any. */
let currentInvite: InviteLink | null = null;
/** Group whose invite request is in flight, so two renders do not fetch twice. */
let loadingInviteGroup: number | null = null;
/** A link token from /join/<token>, kept until the account can join. */
let pendingInvite: string | null = inviteTokenFromLocation();

function inviteTokenFromLocation(): string | null {
  if (typeof location === "undefined") return null;
  return /^\/join\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1] ?? null;
}

interface ViewContext {
  profiles: Map<number, StoredProfile>;
  reactions: Map<number, ReactionTally[]>;
}

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
  await refreshDms();
  await renderGroup();
  await renderDm();
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
      currentDm = null;
      pendingDmPeer = null;
      cancelReply();
      void renderGroup();
      void renderDm();
      void refreshGroups();
      void refreshDms();
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

function dmItem(
  dm: StoredDm,
  self: number | null,
  profiles: Map<number, StoredProfile>,
  last: StoredPost | undefined,
): HTMLLIElement {
  const other = self !== null && dm.a === self ? dm.b : dm.a;
  const profile = profiles.get(other);
  const name = profile?.displayName || profile?.username || `user #${other}`;

  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = name;
  button.setAttribute("aria-current", currentDm === dm.id ? "true" : "false");
  button.addEventListener("click", () => {
    currentDm = dm.id;
    currentGroup = null;
    pendingDmPeer = null;
    cancelReply();
    void renderGroup();
    void renderDm();
    void refreshDms();
  });
  item.append(button);

  const note = document.createElement("span");
  note.className = "note";
  note.textContent = last ? last.text : "No messages yet";
  item.append(note);
  return item;
}

async function refreshDms(): Promise<void> {
  const session = await getSession();
  const list = el("dm-list");
  if (!session || !list) return;

  const self = await getSelf(session.username);
  const profiles = await getProfiles(session.username);
  const rows: { dm: StoredDm; last: StoredPost | undefined }[] = [];
  for (const dm of await getDmScopes(session.username)) {
    const messages = await getPosts(session.username, dm.id);
    rows.push({ dm, last: messages.at(-1) });
  }
  rows.sort((a, b) => (b.last?.seq ?? b.dm.seq) - (a.last?.seq ?? a.dm.seq));

  list.replaceChildren(...rows.map(({ dm, last }) => dmItem(dm, self, profiles, last)));
  show("no-dms", rows.length === 0);
}

function reactionBar(target: number, context: ViewContext): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "reactions";
  const tallies = new Map((context.reactions.get(target) ?? []).map((tally) => [tally.emoji, tally]));
  EMOJI_PALETTE.forEach((glyph, emoji) => {
    const tally = tallies.get(emoji);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reaction";
    button.textContent = tally && tally.count > 0 ? `${glyph} ${tally.count}` : glyph;
    button.setAttribute("aria-label", tally && tally.count > 0 ? `${glyph} ${tally.count}` : `React ${glyph}`);
    if (tally?.mine) button.setAttribute("aria-pressed", "true");
    button.addEventListener("click", () => {
      reactionQueue = reactionQueue.then(() => toggleReaction(target, emoji)).catch(() => {});
    });
    bar.append(button);
  });
  return bar;
}

function postItem(post: StoredPost, context: ViewContext, replies: StoredPost[] = [], interactive = true): HTMLLIElement {
  const item = document.createElement("li");
  item.className = post.parent === 0 ? "post" : "post reply";

  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = identicon(post.author);
  avatar.alt = "";
  avatar.width = 32;
  avatar.height = 32;

  const body = document.createElement("div");
  const meta = document.createElement("p");
  meta.className = "meta";
  const profile = context.profiles.get(post.author);
  const name = profile?.displayName || profile?.username || `user #${post.author}`;
  const when = new Date(post.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = post.parent === 0 ? `${name} · ${when}` : `${name} · ${when} · reply`;
  const text = document.createElement("p");
  text.className = "text";
  text.textContent = post.text;

  body.append(meta, text);
  // DMs are a flat thread: no reactions or reply affordance on a message.
  if (interactive) {
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(reactionBar(post.seq, context));
    if (post.parent === 0) {
      const reply = document.createElement("button");
      reply.type = "button";
      reply.className = "reply";
      reply.textContent = "Reply";
      reply.setAttribute("aria-pressed", replyingTo === post.seq ? "true" : "false");
      reply.addEventListener("click", () => {
        setReply(post.seq, name);
        void renderGroup();
      });
      actions.append(reply);
    }
    body.append(actions);
  }
  if (replies.length > 0) {
    const list = document.createElement("ul");
    list.className = "replies";
    list.append(...replies.map((replyPost) => postItem(replyPost, context)));
    body.append(list);
  }
  item.append(avatar, body);
  return item;
}

function setReply(postSeq: number, authorName: string): void {
  if (replyingTo === postSeq) {
    replyingTo = null;
  } else {
    replyingTo = postSeq;
    setText("reply-label", `Replying to ${authorName}`);
  }
  show("reply-note", replyingTo !== null);
  if (replyingTo === null) setText("reply-label", "");
}

function cancelReply(): void {
  replyingTo = null;
  show("reply-note", false);
  setText("reply-label", "");
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

  const self = await getSelf(session.username);
  const context: ViewContext = {
    profiles: await getProfiles(session.username),
    reactions: tallyReactions(await getReactions(session.username, group.id), self),
  };
  const posts = await getPosts(session.username, group.id);
  const roots = posts.filter((post) => post.parent === 0);
  const knownParents = new Set(roots.map((post) => post.seq));
  const replies = new Map<number, StoredPost[]>();
  for (const post of posts) {
    if (post.parent !== 0 && knownParents.has(post.parent)) {
      const thread = replies.get(post.parent) ?? [];
      thread.push(post);
      replies.set(post.parent, thread);
    }
  }
  // A reply to a post older than the join has no cached parent. Show it flat rather than
  // hiding it: history (#14) will fill the parent in later.
  const orphans = posts.filter((post) => post.parent !== 0 && !knownParents.has(post.parent));
  const list = el("posts");
  if (list) {
    list.replaceChildren(
      ...roots.map((post) => postItem(post, context, replies.get(post.seq) ?? [])),
      ...orphans.map((post) => postItem(post, context)),
    );
  }

  if (currentGroup !== null) {
    const input = el<HTMLInputElement>("post-text");
    if (input) input.placeholder = replyingTo === null ? `Message ${group.name}` : "Write a reply";
  }

  // Invite-only groups are managed from their link. Open groups have nothing to share, so
  // the panel stays out of the way (ADR 0010).
  const mine = self === null ? undefined : members.find((member) => member.user === self);
  const canManage = !group.open && mine !== undefined && mine.role >= Role.Admin;
  show("invite-panel", canManage);
  if (!canManage) {
    currentInvite = null;
    return;
  }
  if (currentInvite?.group === group.id) {
    paintInvite(currentInvite);
  } else if (loadingInviteGroup !== group.id) {
    // Never leave the previous group's link on screen while the new one loads.
    currentInvite = null;
    setText("invite-link", "Loading…");
    const qr = el("invite-qr");
    if (qr) qr.replaceChildren();
    await loadInvite(group.id);
  }
}

function paintInvite(invite: InviteLink): void {
  setText("invite-link", invite.link);
  const qr = el("invite-qr");
  if (qr) qr.innerHTML = qrSvg(invite.qr);
}

async function loadInvite(group: number): Promise<void> {
  const session = await getSession();
  if (!session) return;
  loadingInviteGroup = group;
  try {
    const invite = await getInvite(location.origin, session.token, group);
    // The user may have switched groups while this was in flight.
    if (currentGroup !== group) return;
    currentInvite = invite;
    paintInvite(invite);
  } catch (err) {
    if (currentGroup === group) message(err instanceof Error ? err.message : "Could not load the invite link.");
  } finally {
    if (loadingInviteGroup === group) loadingInviteGroup = null;
  }
}

async function rotateCurrentInvite(): Promise<void> {
  const session = await getSession();
  const group = currentGroup;
  if (!session || group === null) {
    message("Open an invite-only group first.");
    return;
  }
  try {
    const invite = await rotateInvite(location.origin, session.token, group);
    if (currentGroup !== group) return;
    currentInvite = invite;
    paintInvite(invite);
    message("New invite link ready. The old link no longer works.");
  } catch (err) {
    message(err instanceof Error ? err.message : "Could not rotate the invite link.");
  }
}

async function copyInvite(): Promise<void> {
  if (currentInvite === null) {
    message("The invite link is still loading.");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentInvite.link);
    message("Invite link copied.");
  } catch {
    message("Copying is not available here. Select the link instead.");
  }
}

/** Resolves /join/<token> after sign-in, then joins through the normal outbox. */
async function completeInvite(): Promise<void> {
  const invite = pendingInvite;
  if (invite === null) return;
  const session = await getSession();
  if (!session || session.recoveryPending === true) return;

  try {
    const resolved = await resolveInvite(location.origin, session.token, invite);
    const self = await getSelf(session.username);
    if (self === null) return;
    if (!resolved.joined) {
      await enqueueOp(session.username, {
        tag: Tag.Membership,
        scope: resolved.group,
        user: self,
        role: Role.Member,
        invite,
      });
      message(`Joining ${resolved.name}…`);
    }
    pendingInvite = null;
    cancelReply();
    currentGroup = resolved.group;
    if (location.pathname.startsWith("/join/")) history.replaceState({}, "", "/");
    const response = await syncNow();
    const refused = response?.acks.find((row) => "error" in row);
    if (refused && "error" in refused) message(explainAck(refused.error));
    else message(resolved.joined ? `You are already in ${resolved.name}.` : `Joined ${resolved.name}.`);
  } catch (err) {
    // A rotated or mistyped link is a dead end; say so instead of retrying forever.
    pendingInvite = null;
    message(err instanceof Error ? err.message : "That invite link is no longer valid.");
  }
}

/** Renders the DM thread from cache only, so it opens offline exactly like a group. */
async function renderDm(): Promise<void> {
  const view = el("dm-view");
  if (!view) return;
  const session = await getSession();
  if (!session) {
    show("dm-view", false);
    return;
  }

  let peer = pendingDmPeer;
  const scope = currentDm;
  if (scope !== null) {
    const dm = (await getDmScopes(session.username)).find((row) => row.id === scope);
    if (!dm) {
      show("dm-view", false);
      return;
    }
    const self = await getSelf(session.username);
    peer = self !== null && dm.a === self ? dm.b : dm.a;
  }
  if (peer === null) {
    show("dm-view", false);
    return;
  }

  const profiles = await getProfiles(session.username);
  const profile = profiles.get(peer);
  const name = profile?.displayName || profile?.username || `user #${peer}`;
  show("dm-view", true);
  setText("dm-title", `Direct message · ${name}`);

  const context: ViewContext = { profiles, reactions: new Map() };
  const messages = scope === null ? [] : await getPosts(session.username, scope);
  const list = el("dm-messages");
  if (list) list.replaceChildren(...messages.map((message) => postItem(message, context, [], false)));
  show("dm-empty", messages.length === 0);

  const input = el<HTMLInputElement>("dm-text");
  if (input) input.placeholder = `Message ${name}`;
}

/** Everything that follows a successful sign-up/in/recovery, including a pending link. */
async function afterAuth(): Promise<void> {
  await refresh();
  await syncNow();
  await completeInvite();
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
      return "That group, account, post or message no longer exists.";
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
  await afterAuth();
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
  await afterAuth();
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
  await afterAuth();
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
  const privateGroup = el<HTMLInputElement>("create-private")?.checked === true;
  const queued = await enqueueOp(session.username, {
    tag: Tag.GroupMeta,
    scope: 0,
    name,
    about: value("create-about"),
    open: !privateGroup,
  });
  clear("create-name");
  clear("create-about");
  const privateBox = el<HTMLInputElement>("create-private");
  if (privateBox) privateBox.checked = false;
  currentInvite = null;
  const response = await syncNow();
  const ack = response?.acks.find((row) => row.cid.every((byte, i) => byte === queued.cid[i]));
  if (ack && "seq" in ack) {
    cancelReply();
    currentGroup = ack.seq;
    currentDm = null;
    pendingDmPeer = null;
  }
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
  cancelReply();
  currentGroup = group.id;
  currentDm = null;
  pendingDmPeer = null;
  await syncNow();
}

/** Resolves a username from the cached profile list, then opens its thread or starts one. */
async function openDm(): Promise<void> {
  const session = await getSession();
  if (!session) {
    message("Sign in first.");
    return;
  }
  // Usernames are stored lowercased on the server; match what the user typed.
  const username = value("dm-username").toLowerCase();
  if (username.length === 0) {
    message("Type the username of the person to message.");
    return;
  }
  const self = await getSelf(session.username);
  const profile = [...(await getProfiles(session.username)).values()].find((row) => row.username === username);
  if (!profile) {
    message("This device has not seen that account yet. Sync after they join the server.");
    return;
  }
  if (profile.user === self) {
    message("That is you.");
    return;
  }

  const existing = (await getDmScopes(session.username)).find(
    (dm) => dm.a === profile.user || dm.b === profile.user,
  );
  currentGroup = null;
  pendingDmPeer = existing ? null : profile.user;
  currentDm = existing ? existing.id : null;
  cancelReply();
  clear("dm-username");
  await renderGroup();
  await renderDm();
  await refreshDms();
}

async function sendDm(): Promise<void> {
  const session = await getSession();
  if (!session) {
    message("Sign in first.");
    return;
  }
  const text = value("dm-text");
  if (text.length === 0) {
    message("Write something first.");
    return;
  }

  let scope = currentDm;
  let peer = pendingDmPeer;
  if (scope !== null) {
    const dm = (await getDmScopes(session.username)).find((row) => row.id === scope);
    if (!dm) {
      message("That conversation is gone. Open it again.");
      return;
    }
    const self = await getSelf(session.username);
    peer = self !== null && dm.a === self ? dm.b : dm.a;
  }
  if (scope === null && peer === null) {
    message("Choose someone to message first.");
    return;
  }

  // scope 0 lets the server open (or reuse) the single scope for this pair; a retry reuses
  // the same cid through the outbox, so it can never create a second conversation.
  const queued = await enqueueOp(session.username, { tag: Tag.Dm, scope: scope ?? 0, peer: peer ?? 0, text });
  clear("dm-text");
  const response = await syncNow();
  const ack = response?.acks.find((row) => row.cid.every((byte, i) => byte === queued.cid[i]));
  if (ack && "seq" in ack) {
    // The cache now holds the dm_scope event, so the conversation can be selected by peer.
    const dm = (await getDmScopes(session.username)).find((row) => row.a === peer || row.b === peer);
    if (dm) {
      currentDm = dm.id;
      pendingDmPeer = null;
    }
  }
  await refresh();
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
  const scope = currentGroup;
  const parent = replyingTo;
  await enqueueOp(
    session.username,
    parent === null
      ? { tag: Tag.Post, scope, text }
      : { tag: Tag.Reply, scope, parent, text },
  );
  clear("post-text");
  cancelReply();
  await syncNow();
}

/** Toggles one palette emoji for this account: on when it was not on, off otherwise. */
async function toggleReaction(target: number, emoji: number): Promise<void> {
  const session = await getSession();
  const scope = currentGroup;
  if (!session) {
    message("Sign in first.");
    return;
  }
  if (scope === null) {
    message("Open a group first.");
    return;
  }
  const self = await getSelf(session.username);
  if (self === null) {
    message("Still syncing this account. Try again in a moment.");
    return;
  }
  const on = await nextReactionOn(session.username, scope, target, emoji, self);
  await enqueueOp(session.username, { tag: Tag.Reaction, scope, target, emoji, on });
  await syncNow();
}

async function leave(): Promise<void> {
  try {
    await signOut(location.origin);
    cancelReply();
    currentGroup = null;
    currentDm = null;
    pendingDmPeer = null;
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
  el<HTMLButtonElement>("copy-invite")?.addEventListener("click", () => void copyInvite());
  el<HTMLButtonElement>("rotate-invite")?.addEventListener("click", () => void rotateCurrentInvite());
  el<HTMLButtonElement>("cancel-reply")?.addEventListener("click", () => {
    cancelReply();
    void renderGroup();
  });
  el<HTMLButtonElement>("dm-start")?.addEventListener("click", () => void openDm());
  el<HTMLButtonElement>("dm-send")?.addEventListener("click", () => void sendDm());
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
    const session = await getSession();
    if (session && session.recoveryPending !== true) await afterAuth();
    else await refresh();
  })();
}

boot();
