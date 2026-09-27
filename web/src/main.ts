import "./style.css";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import { app, toast } from "./ui";
import { flushQueue, getApiBase } from "./api";
import { renderAuth } from "./screens/auth";
import { renderLibrary } from "./screens/library";
import { renderPage } from "./screens/reader";
import { renderSave } from "./screens/save";
import { renderChat } from "./screens/chat";
import { renderFolders } from "./screens/folders";
import { renderSettings } from "./screens/settings";
import { renderDevices } from "./screens/devices";
import { registerDevice } from "./devices";
import { settingsSync } from "./settings-sync";

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  app.innerHTML = `<div class="auth"><h1>Not configured</h1><p class="hint">Copy <code>web/.env.example</code> to <code>web/.env</code> and fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then rebuild.</p></div>`;
  throw new Error("Supabase env missing");
}

let session: Session | null = null;

function route() {
  if (!session) return renderAuth();
  const hash = location.hash || "#/";
  const page = hash.match(/^#\/page\/(\d+)$/);
  if (page) return void renderPage(Number(page[1]));
  if (hash === "#/save") return void renderSave();
  if (hash === "#/chat") return void renderChat();
  if (hash === "#/devices") return void renderDevices();
  if (hash === "#/folders") return void renderFolders();
  if (hash === "#/settings") return void renderSettings(session);
  return void renderLibrary();
}

const firstUrl = (text: string) => text.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? "";

// Web Share Target: the phone's Share sheet opens "/?url=…&text=…&title=…"
function consumeShareParams() {
  const params = new URLSearchParams(location.search);
  const shared = params.get("url") || firstUrl(params.get("text") ?? "") || firstUrl(params.get("title") ?? "");
  if (shared) {
    sessionStorage.setItem("sharedUrl", shared);
    history.replaceState(null, "", "/#/save");
  } else if (location.search) {
    history.replaceState(null, "", "/" + location.hash);
  }
}

async function syncQueued() {
  if (!session || !getApiBase()) return;
  const n = await flushQueue();
  if (n > 0) toast(`Synced ${n} save${n === 1 ? "" : "s"} made while offline`);
}

consumeShareParams();
const auth = getSupabase().auth;
auth.onAuthStateChange((_event, s) => {
  const changed = s?.user.id !== session?.user.id; // ignore token refreshes
  session = s;
  if (changed) {
    route();
    syncQueued();
    if (s) {
      registerDevice().catch(() => {}); // lets your laptop send links to this phone
      settingsSync.pullIfNewer().then((changed) => changed && toast("Keys and models updated from another device")).catch(() => {});
    }
  }
});
auth.getSession().then(({ data }) => {
  session = data.session;
  route();
  syncQueued();
});
window.addEventListener("hashchange", route);
window.addEventListener("online", syncQueued);

// Android app (Capacitor): a link shared from another app arrives either as a start-up hand-off
// (SaveItUpNative.takeShared) or, if the app is already open, as a "saveitup-share" event.
function handleShared(text: string) {
  const url = firstUrl(text) || text.trim();
  if (!url) return;
  sessionStorage.setItem("sharedUrl", url);
  location.hash = "#/save";
  route();
}
window.addEventListener("saveitup-share", (e) => handleShared((e as CustomEvent<string>).detail));
const nativeShared = (window as unknown as { SaveItUpNative?: { takeShared(): string } }).SaveItUpNative?.takeShared();
if (nativeShared) {
  sessionStorage.setItem("sharedUrl", firstUrl(nativeShared) || nativeShared.trim());
  location.hash = "#/save";
}

if ("serviceWorker" in navigator && import.meta.env.PROD && location.protocol.startsWith("http") && !(window as any).Capacitor) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
