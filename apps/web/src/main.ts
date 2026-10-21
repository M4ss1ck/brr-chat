// The PWA shell: auth, recovery, open groups, posts and /sync. Vanilla DOM only, so the app
// shell stays inside its byte budget (ADR 0014). Every element lookup is optional, so the
// module also loads in a test or in a worker without a DOM.
import { EMOJI_PALETTE, ResponseError, Role, Tag, isGapCoveredTag, type SyncResponse } from "@brr-chat/protocol";
import {
  getRegistration,
  getServerSettings,
  getServerUsers,
  rotateServerInvite,
  saveServerSettings,
  type RegistrationMode,
  type ServerInvite,
  type ServerSettings,
  type ServerUser,
} from "./admin.ts";
import { confirmRecovery, redeemRecovery, regenerateRecovery, signIn, signOut, signUp } from "./auth.ts";
import { advanceGaps, loadHistory } from "./history.ts";
import { identicon } from "./identicon.ts";
import { getInvite, resolveInvite, rotateInvite, type InviteLink } from "./invites.ts";
import { formatBytes, meter, type MeterTotals } from "./meter.ts";
import { qrSvg } from "./qr.ts";
import { syncAndPersist, SyncHttpError } from "./sync.ts";
import {
  enqueueOp,
  getBans,
  getCursor,
  getDmScopes,
  getGaps,
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
  setGaps,
  setSelf,
  tallyReactions,
  toWireOp,
  type ReactionTally,
  type StoredBan,
  type StoredDm,
  type StoredGroup,
  type StoredMember,
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
/** A server invite from /signup/<token>, used for the next account created here. */
let pendingServerInvite: string | null = serverInviteTokenFromLocation();
/** Last admin view loaded, so a re-render does not flash the wrong switch positions. */
let serverSettings: ServerSettings | null = null;
/** Account whose admin view is cached; the panel is not refetched on every sync. */
let adminLoadedFor: string | null = null;
/** Scopes where /history returned no older page, so "load older" stays hidden. */
const historyExhausted = new Set<string>();

function historyKey(username: string, scope: number): string {
  return `${username}:${scope}`;
}

function inviteTokenFromLocation(): string | null {
  if (typeof location === "undefined") return null;
  return /^\/join\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1] ?? null;
}

function serverInviteTokenFromLocation(): string | null {
  if (typeof location === "undefined") return null;
  return /^\/signup\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1] ?? null;
}

interface ViewContext {
  profiles: Map<number, StoredProfile>;
  reactions: Map<number, ReactionTally[]>;
  /** This account's wire id, so it can delete its own posts without being an admin. */
  self: number | null;
  /** This account's role in the open group; Role.None in a DM. */
  role: number;
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

/** The always-visible meter: this page session and this device's calendar month. */
function paintMeter(totals: MeterTotals): void {
  setText("meter-session", formatBytes(totals.sessionBytes));
  setText("meter-month", formatBytes(totals.monthBytes));
}

/** Re-reads storage and rolls the local month; never blocks a request or a paint. */
function refreshMeter(): void {
  void meter.load().catch(() => {
    // A meter that cannot read storage still counts this session in memory.
  });
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
  if (session === null) await paintRegistration();
  else show("registration-note", false);
  await renderAdmin();
}

/** Sign-in screen state: whether accounts are welcome, and whether a link is required. */
async function paintRegistration(): Promise<void> {
  const input = el<HTMLInputElement>("signup-invite");
  if (pendingServerInvite !== null && input && input.value.length === 0) input.value = pendingServerInvite;

  const state = await getRegistration(location.origin);
  if (state === null) {
    show("registration-note", false);
    show("signup-invite-label", pendingServerInvite !== null);
    const button = el<HTMLButtonElement>("sign-up");
    if (button) button.disabled = false;
    return;
  }

  const blocked = state.frozen || state.mode === "closed";
  const button = el<HTMLButtonElement>("sign-up");
  if (button) button.disabled = blocked;
  show("signup-invite-label", state.mode === "invite");
  const note = state.frozen
    ? "Signups are frozen right now."
    : state.mode === "closed"
      ? "This server is closed to new accounts."
      : state.mode === "invite"
        ? "This server is invite-only. Open a server invite link or paste its code."
        : "";
  setText("registration-note", note);
  show("registration-note", note.length > 0);
}

function paintServerInvite(invite: ServerInvite | null): void {
  setText("server-invite-link", invite === null ? "No server invite link yet. Generate one." : invite.link);
  const qr = el("server-invite-qr");
  if (qr) {
    if (invite === null) qr.replaceChildren();
    else qr.innerHTML = qrSvg(invite.qr);
  }
  show("copy-server-invite", invite !== null);
}

function paintServerUsers(users: ServerUser[], self: number | null): void {
  const list = el("server-users");
  if (!list) return;
  list.replaceChildren(
    ...users.map((user) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      const badges = [
        user.username,
        user.admin ? "server admin" : "",
        user.banned ? "banned" : "",
        self !== null && user.user === self ? "you" : "",
      ].filter((part) => part.length > 0);
      label.textContent = badges.join(" · ");
      item.append(label);
      // Banning yourself is already refused by the server; do not offer it.
      if (self === null || user.user !== self) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = user.banned ? "Unban" : "Ban";
        button.addEventListener("click", () => void setServerBan(user.user, !user.banned));
        item.append(button);
      }
      return item;
    }),
  );
  show("no-server-users", users.length === 0);
}

async function renderAdmin(force = false): Promise<void> {
  const session = await getSession();
  if (!session) {
    show("server-admin", false);
    serverSettings = null;
    adminLoadedFor = null;
    return;
  }
  // The panel does not change on its own: one fetch per account per page load keeps sync
  // traffic free of admin reads on a metered connection.
  if (!force && adminLoadedFor === session.username) {
    show("server-admin", serverSettings?.admin === true);
    return;
  }
  try {
    const settings = await getServerSettings(location.origin, session.token);
    serverSettings = settings;
    adminLoadedFor = session.username;
    show("server-admin", settings.admin);
    if (!settings.admin) return;

    const select = el<HTMLSelectElement>("registration-mode");
    if (select) select.value = settings.mode;
    const frozen = el<HTMLInputElement>("registration-frozen");
    if (frozen) frozen.checked = settings.frozen;
    paintServerInvite(settings.invite);
    paintServerUsers(await getServerUsers(location.origin, session.token), await getSelf(session.username));
  } catch {
    // A server that predates administration, or a dropped connection: keep the panel hidden
    // rather than showing stale switches the admin cannot trust.
    show("server-admin", false);
  }
}

async function saveAdminSettings(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  const select = el<HTMLSelectElement>("registration-mode");
  const frozen = el<HTMLInputElement>("registration-frozen");
  if (!select) return;
  const mode = select.value as RegistrationMode;
  if (mode !== "open" && mode !== "invite" && mode !== "closed") return;
  try {
    const next = await saveServerSettings(location.origin, session.token, {
      mode,
      frozen: frozen?.checked === true,
    });
    serverSettings = next;
    show("server-admin", next.admin);
    paintServerInvite(next.invite);
    message(next.frozen ? "Signups are frozen." : `Registration is ${next.mode}.`);
    await paintRegistration();
  } catch (err) {
    message(err instanceof Error ? err.message : "Could not save server settings.");
  }
}

async function rotateAdminInvite(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  try {
    const next = await rotateServerInvite(location.origin, session.token);
    serverSettings = next;
    paintServerInvite(next.invite);
    message("New server invite link ready. The old link no longer works.");
  } catch (err) {
    message(err instanceof Error ? err.message : "Could not rotate the server invite link.");
  }
}

async function copyServerInvite(): Promise<void> {
  const invite = serverSettings?.invite ?? null;
  if (invite === null) {
    message("Generate a server invite link first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(invite.link);
    message("Server invite link copied.");
  } catch {
    message("Copying is not available here. Select the link instead.");
  }
}

async function setServerBan(user: number, on: boolean): Promise<void> {
  const session = await getSession();
  if (!session) return;
  const queued = await enqueueOp(session.username, { tag: Tag.Ban, scope: 0, user, on });
  const response = await syncNow();
  const ack = response?.acks.find((row) => row.cid.every((byte, i) => byte === queued.cid[i]));
  if (ack && "error" in ack) message(explainAck(ack.error));
  else message(on ? "Account banned server-wide. Its sessions are revoked." : "Account unbanned.");
  await renderAdmin(true);
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
    // The author can always delete; in a group, a group admin or the owner can too.
    if (context.role >= Role.Admin || (context.self !== null && context.self === post.author)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => void deletePost(post));
      actions.append(remove);
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

async function setMemberRole(user: number, role: number): Promise<void> {
  const session = await getSession();
  const scope = currentGroup;
  if (!session || scope === null) return;
  await enqueueOp(session.username, { tag: Tag.Membership, scope, user, role });
  await syncNow();
}

async function setMemberBan(user: number, on: boolean): Promise<void> {
  const session = await getSession();
  const scope = currentGroup;
  if (!session || scope === null) return;
  await enqueueOp(session.username, { tag: Tag.Ban, scope, user, on });
  await syncNow();
}

async function deletePost(post: StoredPost): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await enqueueOp(session.username, { tag: Tag.Delete, scope: post.scope, target: post.seq });
  await syncNow();
}

function memberItem(
  member: StoredMember,
  name: string,
  myRole: number,
  self: number | null,
): HTMLLIElement {
  const item = document.createElement("li");
  const label = document.createElement("span");
  const roleName = member.role === Role.Owner ? "owner" : member.role === Role.Admin ? "group admin" : "member";
  label.textContent = `${name} · ${roleName}`;
  item.append(label);

  // The owner changes roles; admins moderate plain members. Nobody changes the owner here.
  if (self !== null && member.user !== self && member.role !== Role.Owner) {
    if (myRole === Role.Owner) {
      const toggleRole = document.createElement("button");
      toggleRole.type = "button";
      toggleRole.textContent = member.role === Role.Admin ? "Demote" : "Make admin";
      toggleRole.addEventListener("click", () =>
        void setMemberRole(member.user, member.role === Role.Admin ? Role.Member : Role.Admin),
      );
      const transfer = document.createElement("button");
      transfer.type = "button";
      transfer.textContent = "Make owner";
      transfer.addEventListener("click", () => void setMemberRole(member.user, Role.Owner));
      item.append(toggleRole, transfer);
    }
    if (myRole >= Role.Admin && (myRole === Role.Owner || member.role === Role.Member)) {
      const ban = document.createElement("button");
      ban.type = "button";
      ban.textContent = "Ban";
      ban.addEventListener("click", () => void setMemberBan(member.user, true));
      item.append(ban);
    }
  }
  return item;
}

function banItem(ban: StoredBan, name: string, myRole: number): HTMLLIElement {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = `${name} · banned`;
  item.append(label);
  if (myRole >= Role.Admin) {
    const unban = document.createElement("button");
    unban.type = "button";
    unban.textContent = "Unban";
    unban.addEventListener("click", () => void setMemberBan(ban.user, false));
    item.append(unban);
  }
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

  const self = await getSelf(session.username);
  const profiles = await getProfiles(session.username);
  const myRole = members.find((member) => member.user === self)?.role ?? Role.None;
  const memberList = el("member-list");
  if (memberList) {
    memberList.replaceChildren(
      ...members.map((member) =>
        memberItem(
          member,
          profiles.get(member.user)?.displayName || profiles.get(member.user)?.username || `user #${member.user}`,
          myRole,
          self,
        ),
      ),
    );
  }
  const bans = await getBans(session.username, group.id);
  const bannedList = el("banned-list");
  if (bannedList) {
    bannedList.replaceChildren(
      ...bans.map((ban) =>
        banItem(
          ban,
          profiles.get(ban.user)?.displayName || profiles.get(ban.user)?.username || `user #${ban.user}`,
          myRole,
        ),
      ),
    );
  }
  show("banned-label", bans.length > 0);

  const context: ViewContext = {
    profiles,
    reactions: tallyReactions(await getReactions(session.username, group.id), self),
    self,
    role: myRole,
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
  // A gap only says older events exist; the button is how the user pays for them (ADR 0009).
  const gaps = await getGaps(session.username, group.id);
  const gap = gaps[0];
  show(
    "load-older",
    (posts.length > 0 || gap !== undefined) && !historyExhausted.has(historyKey(session.username, group.id)),
  );
  setText(
    "load-older",
    gap ? `Load ${gap.count} missed ${gap.count === 1 ? "message" : "messages"}` : "Load older posts",
  );

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

  const self = await getSelf(session.username);
  const context: ViewContext = { profiles, reactions: new Map(), self, role: Role.None };
  const messages = scope === null ? [] : await getPosts(session.username, scope);
  const list = el("dm-messages");
  if (list) list.replaceChildren(...messages.map((message) => postItem(message, context, [], false)));
  show("dm-empty", messages.length === 0);
  const gaps = scope === null ? [] : await getGaps(session.username, scope);
  const gap = gaps[0];
  show(
    "dm-load-older",
    (messages.length > 0 || gap !== undefined) &&
      (scope === null || !historyExhausted.has(historyKey(session.username, scope))),
  );
  setText(
    "dm-load-older",
    gap ? `Load ${gap.count} missed ${gap.count === 1 ? "message" : "messages"}` : "Load older messages",
  );

  const input = el<HTMLInputElement>("dm-text");
  if (input) input.placeholder = `Message ${name}`;
}

/**
 * One tap, one /history page, older than the oldest message already cached. The page joins
 * the same cache, so a gap and the normal sync view become one continuous thread.
 */
async function loadOlder(kind: "group" | "dm"): Promise<void> {
  const session = await getSession();
  const scope = kind === "group" ? currentGroup : currentDm;
  if (!session || scope === null) return;

  const cached = await getPosts(session.username, scope);
  const gaps = await getGaps(session.username, scope);
  const gap = gaps[0];
  // A hole sits above the old cache: fill it from its top edge, not below the oldest post.
  const before = gap?.before ?? cached[0]?.seq;
  if (before === undefined) return;

  const button = el<HTMLButtonElement>(kind === "group" ? "load-older" : "dm-load-older");
  if (button) button.disabled = true;
  try {
    const outcome = await loadHistory(location.origin, session.token, session.username, scope, before);
    if (outcome.kind === "upgrade") {
      message(upgradeMessage(outcome.error, outcome.range));
      return;
    }
    const { response } = outcome;
    if (gap) await setGaps(session.username, scope, advanceGaps(gaps, response));
    else if (!response.more) historyExhausted.add(historyKey(session.username, scope));
    const older = response.events.filter((event) => isGapCoveredTag(event.tag)).length;
    message(older === 0 ? "No older messages." : `Loaded ${older} older ${older === 1 ? "message" : "messages"}.`);
  } catch (err) {
    message(err instanceof Error ? err.message : "Could not load older messages.");
  } finally {
    if (button) button.disabled = false;
    await renderGroup();
    await renderDm();
  }
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
      return "Not allowed. Creating a group needs an account at least 24 hours old; posting and moderation need the right role in the group.";
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

function upgradeMessage(error: number, range: { min: number; max: number }): string {
  return error === ResponseError.ClientTooOld
    ? `This server is too old: it speaks up to v${range.max}. Update the app.`
    : `This server moved on: it wants at least v${range.min}. An update is on the way.`;
}

async function syncNow(): Promise<SyncResponse | null> {
  const session = await getSession();
  if (!session) {
    message("Sign in first.");
    return null;
  }

  // The wire id is learned from the profile event this account publishes; no extra endpoint.
  const knownSelf = await getSelf(session.username);
  if (knownSelf === null && !(await getOutbox(session.username)).some((op) => op.tag === Tag.Profile)) {
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
      message(upgradeMessage(error, range));
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
    // The admin panel first rendered before this account had a wire id, so its account list
    // was legitimately empty. Refetch once, now that the profile exists.
    if (knownSelf === null && adminLoadedFor !== null && (await getSelf(session.username)) !== null) {
      await renderAdmin(true);
    }
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
      const invite = value("signup-invite");
      const { session, recoveryCode } = await signUp(
        location.origin,
        username,
        password,
        invite.length === 0 ? undefined : invite,
      );
      setText("recovery-code", recoveryCode);
      // The invite did its one job; do not leave a capability in the address bar.
      if (pendingServerInvite !== null || location.pathname.startsWith("/signup/")) {
        pendingServerInvite = null;
        history.replaceState({}, "", "/");
        clear("signup-invite");
      }
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
  el<HTMLButtonElement>("load-older")?.addEventListener("click", () => void loadOlder("group"));
  el<HTMLButtonElement>("dm-load-older")?.addEventListener("click", () => void loadOlder("dm"));
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
  el<HTMLButtonElement>("save-server-settings")?.addEventListener("click", () => void saveAdminSettings());
  el<HTMLButtonElement>("rotate-server-invite")?.addEventListener("click", () => void rotateAdminInvite());
  el<HTMLButtonElement>("copy-server-invite")?.addEventListener("click", () => void copyServerInvite());
}

/** Rolls the meter at the local month boundary even when the app sits open with no traffic. */
function watchMeterRollover(): void {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  // At most a day at a time: 31 days overflow a browser timer.
  const delay = Math.min(nextMonth.getTime() - now.getTime() + 1000, 24 * 60 * 60 * 1000);
  setTimeout(() => {
    refreshMeter();
    watchMeterRollover();
  }, Math.max(delay, 1000));
}

function boot(): void {
  if (typeof document === "undefined") return;
  wire();
  // Painted before any request so the meter is on screen signed-in or signed-out, and read
  // before the first sync so the month's stored total is already counted.
  meter.subscribe(paintMeter);
  refreshMeter();
  watchMeterRollover();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshMeter();
  });
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
