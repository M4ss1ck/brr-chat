// The PWA shell: sign up, confirm the recovery code, sign in, land on a synced (empty) server.
// Vanilla DOM only, so the app shell stays inside its byte budget (ADR 0014). Every element
// lookup is optional, so the module also loads in a test or in a worker without a DOM.
import { ResponseError } from "@brr-chat/protocol";
import { confirmRecovery, redeemRecovery, regenerateRecovery, signIn, signOut, signUp } from "./auth.ts";
import { syncAndPersist } from "./sync.ts";
import { getCursor, getRange, getSession } from "./store.ts";

type Mode = "up" | "in";

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

async function refresh(): Promise<void> {
  const session = await getSession();
  const pending = session?.recoveryPending === true;
  show("signed-out", session === null);
  show("signed-in", session !== null && !pending);
  show("confirm-panel", pending);
  setText("account", session?.username ?? "");
  setText("session", session ? "32-char bearer token, held on this device only" : "");
  setText("cursor", String(await getCursor()));
  const range = await getRange();
  setText("range", range ? `v${range.min}..v${range.max}` : "unknown");
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

async function syncNow(): Promise<void> {
  const session = await getSession();
  if (!session) {
    message("Sign in first.");
    return;
  }
  try {
    const outcome = await syncAndPersist(location.origin, session.token);
    if (outcome.kind === "upgrade") {
      const { range, error } = outcome;
      message(
        error === ResponseError.ClientTooOld
          ? `This server is too old: it speaks up to v${range.max}. Update the app.`
          : `This server moved on: it wants at least v${range.min}. An update is on the way.`,
      );
      await refresh();
      return;
    }
    const { response } = outcome;
    setText("cursor", String(response.cursor));
    show("empty", response.events.length === 0 && response.cursor === 0);
    message(response.events.length === 0 && response.cursor === 0 ? "In sync. This server is empty." : `In sync at ${response.cursor}.`);
    await refresh();
  } catch (err) {
    const text = err instanceof Error ? err.message : "Sync failed.";
    message(text.includes("403") ? "Save your recovery code and type its last group to finish signup." : text);
  }
}

async function leave(): Promise<void> {
  try {
    await signOut(location.origin);
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
}

function boot(): void {
  if (typeof document === "undefined") return;
  wire();
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Without a service worker the app still works, it just refetches the shell.
    });
  }
  void refresh();
}

boot();
