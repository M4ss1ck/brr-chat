// The PWA shell: sign up, sign in, land on a synced (empty) server. Vanilla DOM only, so the
// app shell stays inside its byte budget (ADR 0014). Every element lookup is optional, so the
// module also loads in a test or in a worker without a DOM.
import { ResponseError } from "@brr-chat/protocol";
import { authorizationHeader, signIn, signOut, signUp } from "./auth.ts";
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

async function refresh(): Promise<void> {
  const session = await getSession();
  show("signed-out", session === null);
  show("signed-in", session !== null);
  setText("account", session?.username ?? "");
  setText("token", session ? ((await authorizationHeader()) ?? "") : "");
  setText("cursor", String(await getCursor()));
  const range = await getRange();
  setText("range", range ? `v${range.min}..v${range.max}` : "unknown");
}

async function submit(mode: Mode): Promise<void> {
  const username = el<HTMLInputElement>("username")?.value.trim() ?? "";
  const password = el<HTMLInputElement>("password")?.value ?? "";
  if (username.length === 0 || password.length === 0) {
    message("Username and password are both required.");
    return;
  }
  try {
    const session = mode === "up" ? await signUp(location.origin, username, password) : await signIn(location.origin, username, password);
    message(mode === "up" ? `Account created. Signed in as ${session.username}.` : `Signed in as ${session.username}.`);
  } catch (err) {
    message(err instanceof Error ? err.message : "Sign in failed.");
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
    message(err instanceof Error ? err.message : "Sync failed.");
  }
}

async function leave(): Promise<void> {
  try {
    await signOut(location.origin);
    message("Signed out.");
  } catch (err) {
    message(err instanceof Error ? err.message : "Sign out failed.");
  }
  await refresh();
}

function wire(): void {
  el<HTMLButtonElement>("sign-up")?.addEventListener("click", () => void submit("up"));
  el<HTMLButtonElement>("sign-in")?.addEventListener("click", () => void submit("in"));
  el<HTMLButtonElement>("sign-out")?.addEventListener("click", () => void leave());
  el<HTMLButtonElement>("sync")?.addEventListener("click", () => void syncNow());
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
