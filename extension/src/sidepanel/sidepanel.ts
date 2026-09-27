import {
  listPages,
  updateNote,
  setPinned,
  getPage,
  deletePage,
  createTabSession,
  getSettings,
  generateSummary,
  reclean,
  listFolders,
  setFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  folderPath,
  withDescendantIds,
  folderTree,
  ensureFolderPath,
  transformPage,
  extractUrlToMarkdown,
  chatMessage,
  testRoleModel,
  getAIConfig,
  updateAIConfig,
  listAIErrors,
  clearAIErrors,
  checkServerHealth,
  getServerHealth,
  updatePageTitle,
  updatePageContent,
  updateTranscript,
  createPageShare,
  getShareUrl,
  isLocalUrl,
  getQueuedSaves,
  retryQueuedSaves
} from "../lib/api-client";
import { exportEverything, reembedMissing } from "../lib/maintenance";
import { askText, askConfirm, askChoice } from "../lib/dialog";
import { renderPlain, groupTranscript, segmentsFromFlat, parseChaptersFromDescription } from "../../../shared/src/youtube-format";
import { polishTranscript, polishBlockCount } from "../lib/ai/transcript-polish";
import { settingsSync } from "../lib/ai/settings-sync";
import { isSyncEnabled, setSyncEnabled, getDeviceId, getDeviceName, setDeviceName, listDevices, listInbox, dismissInbox, sendTab, openUrls, pushTabs } from "../lib/device-sync";
import type { DeviceRow } from "../lib/device-sync";
import { readChromeBookmarks, parseBookmarksHtml, buildJob, runJob, retryFailed, loadJob, clearJob } from "../lib/bookmarks-import";
import type { BookmarkItem, ImportJob } from "../lib/bookmarks-import";
import type { Folder, SavedPageRecord, SavedPageSummary, ChatMessage, ChatSource, AIRole } from "../../../shared/src/types";
import { getCaptureType, captureTypeLabel, captureTypeBadgeClass } from "../lib/capture-type";
import { resolveEmbed } from "../lib/embeds";
import { icon } from "../lib/icons";
import { domainOf, matchSiteCapture } from "../lib/site-capture";
import { marked } from "marked";
import { getSupabase, getAuthToken } from "../lib/supabase";
import { sanitizeHtml } from "../lib/markdown";
import { getAllCredentials, setProviderCredentials, isProviderConfigured } from "../lib/ai/settings";
import type { Provider } from "../lib/ai/providers";

// Chat replies, summaries, and transform output are AI-generated from content
// captured off arbitrary web pages — a prompt-injection payload on a saved
// page could make its way back into a reply containing e.g. <img onerror=...>.
// marked doesn't sanitize embedded raw HTML on its own, so run its output
// through the same stripper used for captured-page markdown before it ever
// reaches innerHTML.
async function renderMarkdownSafe(markdown: string): Promise<string> {
  return sanitizeHtml(await marked.parse(markdown));
}

// --- auth ---
const signedOutView = document.getElementById("signed-out-view") as HTMLElement;
const accountEmailEl = document.getElementById("accountEmail") as HTMLElement;
const authForm = document.getElementById("authForm") as HTMLFormElement;
const authEmailInput = document.getElementById("authEmail") as HTMLInputElement;
const authPasswordInput = document.getElementById("authPassword") as HTMLInputElement;
const authMessageEl = document.getElementById("authMessage") as HTMLElement;
const authTitleEl = document.getElementById("authTitle") as HTMLElement;
const authSubmitBtn = document.getElementById("authSubmitBtn") as HTMLButtonElement;
const authToggleText = document.getElementById("authToggleText") as HTMLElement;
const authToggleBtn = document.getElementById("authToggleBtn") as HTMLButtonElement;

type AuthMode = "signin" | "signup";
let authMode: AuthMode = "signin";

function showAuthMessage(text: string, kind: "error" | "success") {
  authMessageEl.textContent = text;
  authMessageEl.classList.remove("view-hidden", "error", "success");
  authMessageEl.classList.add(kind);
}

function clearAuthMessage() {
  authMessageEl.textContent = "";
  authMessageEl.classList.add("view-hidden");
}

function setAuthMode(mode: AuthMode) {
  authMode = mode;
  clearAuthMessage();
  if (mode === "signin") {
    authTitleEl.textContent = "Sign in";
    authSubmitBtn.textContent = "Sign in";
    authPasswordInput.autocomplete = "current-password";
    authToggleText.textContent = "Don't have an account?";
    authToggleBtn.textContent = "Create one";
  } else {
    authTitleEl.textContent = "Create account";
    authSubmitBtn.textContent = "Create account";
    authPasswordInput.autocomplete = "new-password";
    authToggleText.textContent = "Already have an account?";
    authToggleBtn.textContent = "Sign in";
  }
}

authToggleBtn.addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));

function updateAuthUI(email: string | null) {
  const signedIn = !!email;
  signedOutView.classList.toggle("view-hidden", signedIn);
  document.body.classList.toggle("signed-out", !signedIn);
  if (signedIn) {
    accountEmailEl.textContent = email ?? "";
    refreshBrowse();
    refreshServerStatus();
  }
}

// --- server status ---
// Save/search/AI/tab-sessions all still go through the Express server (or,
// for search, route back through it from api-client.ts) — this can't launch
// that server for you, only tell you clearly when it's unreachable instead
// of letting every feature that touches it fail with a raw fetch error.
const serverStatusBanner = document.getElementById("serverStatusBanner") as HTMLElement;

// After a failed check, retry quickly a few times before declaring the server down, so a cold
// start on a sleeping host reads as "waking up" rather than "broken".
const WAKE_DELAYS_MS = [4000, 8000, 15000, 25000];
let wakeRetries = 0;

async function refreshServerStatus() {
  const healthy = await checkServerHealth();
  if (healthy) {
    wakeRetries = 0;
    serverStatusBanner.classList.add("view-hidden");
    // The server just came back — flush anything that queued locally while it was down.
    const { succeeded } = await retryQueuedSaves();
    if (succeeded > 0) {
      showToast(`Synced ${succeeded} save${succeeded === 1 ? "" : "s"} that were waiting for the server`);
      refreshBrowse();
    }
    return;
  }
  const { apiBase } = await getSettings();
  const queued = await getQueuedSaves();
  const queuedNote = queued.length > 0 ? ` ${queued.length} save${queued.length === 1 ? "" : "s"} waiting to sync.` : "";
  const waking = wakeRetries < WAKE_DELAYS_MS.length;
  serverStatusBanner.textContent = waking
    ? `Waking up the SaveItUp server (free hosts sleep when idle — this can take up to a minute)...${queuedNote}`
    : `Can't reach the SaveItUp server at ${apiBase}. Save, search, and AI features won't work until it's running.${queuedNote}`;
  serverStatusBanner.classList.remove("view-hidden");
  if (waking) setTimeout(refreshServerStatus, WAKE_DELAYS_MS[wakeRetries++]);
}

refreshServerStatus();
setInterval(refreshServerStatus, 30000);

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthMessage();
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value;

  authSubmitBtn.disabled = true;
  authSubmitBtn.textContent = authMode === "signin" ? "Signing in..." : "Creating account...";
  try {
    if (authMode === "signin") {
      const { error } = await getSupabase().auth.signInWithPassword({ email, password });
      if (error) showAuthMessage(error.message, "error");
    } else {
      const { error, data } = await getSupabase().auth.signUp({ email, password });
      if (error) {
        showAuthMessage(error.message, "error");
      } else if (!data.session) {
        showAuthMessage("Account created. Check your email to confirm it, then sign in.", "success");
        setAuthMode("signin");
      }
      // else: email confirmation is off, signUp already returned a session and
      // the onAuthStateChange listener below will switch to the signed-in view.
    }
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.textContent = authMode === "signin" ? "Sign in" : "Create account";
  }
});

const authForgotBtn = document.getElementById("authForgotBtn") as HTMLButtonElement;
authForgotBtn.addEventListener("click", async () => {
  const email = authEmailInput.value.trim();
  if (!email) {
    showAuthMessage("Enter your email above first, then click Forgot password.", "error");
    return;
  }
  clearAuthMessage();
  authForgotBtn.disabled = true;
  try {
    // Requires the extension's sidepanel URL to be added as an allowed Redirect URL
    // in the Supabase project's Auth settings, or the emailed link won't come back here.
    const { error } = await getSupabase().auth.resetPasswordForEmail(email, {
      redirectTo: chrome.runtime.getURL("sidepanel/sidepanel.html")
    });
    if (error) showAuthMessage(error.message, "error");
    else showAuthMessage("Check your email for a password reset link.", "success");
  } finally {
    authForgotBtn.disabled = false;
  }
});

// --- password recovery ---
// Supabase appends #access_token=...&type=recovery to the redirectTo URL above; since
// the client is created with detectSessionInUrl:false (no normal page-navigation model
// in a service worker), that fragment has to be parsed and applied by hand here.
const authRecoveryView = document.getElementById("auth-recovery-view") as HTMLElement;
const authRecoveryForm = document.getElementById("authRecoveryForm") as HTMLFormElement;
const authRecoveryPassword = document.getElementById("authRecoveryPassword") as HTMLInputElement;
const authRecoveryMessage = document.getElementById("authRecoveryMessage") as HTMLElement;
const authRecoverySubmitBtn = document.getElementById("authRecoverySubmitBtn") as HTMLButtonElement;

async function checkForRecoveryLink() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (hash.get("type") !== "recovery") return;
  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  if (!accessToken || !refreshToken) return;
  history.replaceState(null, "", location.pathname);
  const { error } = await getSupabase().auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error) return;
  signedOutView.classList.add("view-hidden");
  authRecoveryView.classList.remove("view-hidden");
}

authRecoveryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authRecoveryMessage.classList.add("view-hidden");
  authRecoverySubmitBtn.disabled = true;
  authRecoverySubmitBtn.textContent = "Updating...";
  try {
    const { error } = await getSupabase().auth.updateUser({ password: authRecoveryPassword.value });
    if (error) {
      authRecoveryMessage.textContent = error.message;
      authRecoveryMessage.classList.remove("view-hidden");
      return;
    }
    authRecoveryView.classList.add("view-hidden");
  } finally {
    authRecoverySubmitBtn.disabled = false;
    authRecoverySubmitBtn.textContent = "Update password";
  }
});

checkForRecoveryLink();

document.getElementById("signOutBtn")?.addEventListener("click", async () => {
  await getSupabase().auth.signOut();
});

getSupabase().auth.onAuthStateChange((_event, session) => updateAuthUI(session?.user.email ?? null));
getSupabase()
  .auth.getSession()
  .then(({ data }) => updateAuthUI(data.session?.user.email ?? null));

function renderIconSlots(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((slot) => {
    const name = slot.dataset.icon as Parameters<typeof icon>[0];
    slot.innerHTML = icon(name);
  });
}
renderIconSlots();

// --- tabs ---
document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    showListView();
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`${btn.dataset.tab}-tab`)?.classList.add("active");
    const sectionTitle = document.getElementById("sectionTitle");
    if (sectionTitle) sectionTitle.textContent = btn.title;
    if (btn.dataset.tab === "settings") {
      loadAISettings();
      loadAIErrors();
    }
  });
});

// --- element picker ---
document.getElementById("pickElement")?.addEventListener("click", async () => {
  document.getElementById("addMenu")?.classList.add("view-hidden");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const response = await chrome.runtime.sendMessage({ type: "saveitup-activate-picker", tabId: tab.id });
  if (!response?.ok) showToast(response?.error || "Couldn't start the picker on this page");
});

const toastEl = document.getElementById("toast") as HTMLDivElement;
let toastTimer: number | undefined;

function showToast(text: string, action?: { label: string; onClick: () => void; ms?: number }) {
  toastEl.textContent = text;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      toastEl.classList.add("view-hidden");
      clearTimeout(toastTimer);
      action.onClick();
    });
    toastEl.appendChild(btn);
  }
  toastEl.classList.remove("view-hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add("view-hidden"), action?.ms ?? Math.max(2600, text.length * 70));
}

interface PendingSave {
  tempId: string;
  title: string;
  domain: string;
}

const pendingSaves = new Map<string, PendingSave>();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "saveitup-page-saving") {
    pendingSaves.set(message.tempId, {
      tempId: message.tempId,
      title: message.title,
      domain: message.domain
    });
    refreshBrowse();
  }
  if (message?.type === "saveitup-page-saved") {
    pendingSaves.delete(message.tempId);
    refreshBrowse();
    const count = message.duplicateCount as number | undefined;
    const pageId = message.pageId as number | undefined;
    const dupNote = count && count > 0 ? ` (saved ${count + 1}×)` : "";
    if (pageId) {
      // The server files the page (AI categorize) before it responds, so the folder is known now.
      const id: number = pageId;
      Promise.all([getPage(id), listFolders()])
        .then(([page, folders]) => {
          folderCache = folders;
          const where = page.folderId != null ? folderPath(folders, page.folderId) : "Unfiled";
          showToast(`Saved to ${where}${dupNote}`, {
            label: "Undo",
            ms: 6000,
            onClick: () => deletePage(id).then(refreshBrowse)
          });
        })
        .catch(() => dupNote && showToast(`Saved${dupNote}`));
    } else if (dupNote) {
      showToast(`Saved${dupNote}`);
    }
  }
  if (message?.type === "saveitup-page-save-failed") {
    pendingSaves.delete(message.tempId);
    refreshBrowse();
    showToast(`Save failed: ${message.error}`);
  }
  if (message?.type === "saveitup-page-queued") {
    pendingSaves.delete(message.tempId);
    refreshBrowse();
    showToast("Server unreachable — saved locally, will sync automatically once it's back");
    refreshServerStatus();
  }
  if (message?.type === "saveitup-queue-synced") {
    const count = message.succeeded as number;
    showToast(`Synced ${count} save${count === 1 ? "" : "s"} that were waiting for the server`);
    refreshBrowse();
  }
});

// --- chat ---
const chatMessages = document.getElementById("chatMessages") as HTMLDivElement;
const chatInput = document.getElementById("chatInput") as HTMLTextAreaElement;
const chatSendBtn = document.getElementById("chatSendBtn") as HTMLButtonElement;
const chatIncludeCurrentTab = document.getElementById("chatIncludeCurrentTab") as HTMLInputElement;
const chatClearBtn = document.getElementById("chatClearBtn") as HTMLButtonElement;
const chatTabEl = document.getElementById("chat-tab") as HTMLElement;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  error?: string; // set on a failed assistant turn (content is empty)
}

const CHAT_STORE_KEY = "chatHistory";
const CHAT_SUGGESTIONS = ["Summarize this tab", "What did I save about...?", "Find pages related to this tab"];
let chatHistory: ChatTurn[] = [];
let chatAbort: AbortController | null = null;

const saveChatHistory = () => chrome.storage.session.set({ [CHAT_STORE_KEY]: chatHistory }).catch(() => {});

// The tab fills the viewport below the sticky header so the composer stays pinned at the bottom.
function layoutChat() {
  const header = document.querySelector(".app-header");
  const top = header ? header.getBoundingClientRect().bottom : 0;
  chatTabEl.style.setProperty("--chat-height", `${Math.max(window.innerHeight - top, 240)}px`);
}
window.addEventListener("resize", layoutChat);
document.querySelector('.tab-btn[data-tab="chat"]')?.addEventListener("click", () => {
  layoutChat();
  scrollChatToBottom(true);
});
layoutChat();

function scrollChatToBottom(force = false) {
  const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
  if (force || nearBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setChatBusy(busy: boolean) {
  chatSendBtn.classList.toggle("is-stop", busy);
  chatSendBtn.innerHTML = busy ? "&#9632;" : "&#10148;";
  chatSendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
}

// "[#12]" in an answer becomes a link to that saved page.
async function renderAssistantHtml(text: string): Promise<string> {
  const html = await renderMarkdownSafe(text);
  return html.replace(/\[#(\d+)\]/g, '<a href="#" class="chat-cite" data-page-id="$1">#$1</a>');
}

function buildSources(sources: ChatSource[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "chat-sources";
  const label = document.createElement("div");
  label.className = "chat-sources-label";
  label.textContent = `Sources (${sources.length})`;
  box.appendChild(label);
  for (const src of sources) {
    const card = document.createElement("div");
    card.className = "chat-source-card";
    const main = document.createElement("button");
    main.type = "button";
    main.className = "chat-source-main";
    const img = document.createElement("img");
    img.className = "site-favicon";
    img.alt = "";
    img.src = faviconUrl(src.domain);
    img.addEventListener("error", () => (img.style.display = "none"));
    const text = document.createElement("span");
    text.className = "chat-source-text";
    const title = document.createElement("span");
    title.className = "chat-source-title";
    title.textContent = src.title || src.url;
    const meta = document.createElement("span");
    meta.className = "chat-source-meta";
    meta.textContent = src.id === null ? `Current tab · ${src.domain}` : `#${src.id} · ${src.domain}`;
    text.append(title, meta);
    main.append(img, text);
    main.addEventListener("click", () => (src.id === null ? chrome.tabs.create({ url: src.url }) : showDetailView(src.id)));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "chat-source-open";
    open.title = "Open original page";
    open.setAttribute("aria-label", "Open original page");
    open.innerHTML = "&#8599;";
    open.addEventListener("click", () => chrome.tabs.create({ url: src.url }));
    card.append(main, open);
    box.appendChild(card);
  }
  return box;
}

function buildCopyButton(text: string): HTMLButtonElement {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "chat-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1200);
  });
  return copy;
}

function buildChatError(message: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-message chat-message-error";
  const msg = document.createElement("div");
  msg.textContent = message;
  const actions = document.createElement("div");
  actions.className = "chat-error-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary-btn";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    chatHistory.pop(); // drop the failed turn; the user's question is still last
    const last = chatHistory[chatHistory.length - 1];
    if (last?.role === "user") sendChatMessage(last.content, true);
  });
  const settings = document.createElement("button");
  settings.type = "button";
  settings.className = "secondary-btn";
  settings.textContent = "AI settings";
  settings.addEventListener("click", () => document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="settings"]')?.click());
  actions.append(retry, settings);
  row.append(msg, actions);
  return row;
}

function renderChatEmpty() {
  const box = document.createElement("div");
  box.className = "chat-empty";
  box.innerHTML = '<div class="chat-empty-title">Chat with your saved pages</div><div class="chat-empty-sub">Answers cite the pages they came from.</div>';
  for (const s of CHAT_SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-suggestion";
    b.textContent = s;
    b.addEventListener("click", () => {
      if (s.endsWith("...?")) {
        chatInput.value = s.replace("...?", " ");
        chatInput.focus();
      } else {
        sendChatMessage(s);
      }
    });
    box.appendChild(b);
  }
  chatMessages.appendChild(box);
}

async function renderChatMessages() {
  chatMessages.innerHTML = "";
  if (chatHistory.length === 0) renderChatEmpty();
  for (const [i, turn] of chatHistory.entries()) {
    if (turn.error) {
      chatMessages.appendChild(buildChatError(turn.error));
      continue;
    }
    const row = document.createElement("div");
    row.className = `chat-message chat-message-${turn.role}`;
    if (turn.role === "assistant") {
      row.innerHTML = await renderAssistantHtml(turn.content);
      row.querySelectorAll("pre").forEach((pre) => {
        const btn = buildCopyButton(pre.textContent ?? "");
        btn.classList.add("chat-code-copy");
        pre.appendChild(btn);
      });
      const tools = document.createElement("div");
      tools.className = "chat-message-tools";
      tools.appendChild(buildCopyButton(turn.content));
      if (i === chatHistory.length - 1) {
        const regen = document.createElement("button");
        regen.type = "button";
        regen.className = "chat-copy";
        regen.textContent = "Regenerate";
        regen.addEventListener("click", () => {
          chatHistory.pop();
          const last = chatHistory[chatHistory.length - 1];
          if (last?.role === "user") sendChatMessage(last.content, true);
        });
        tools.appendChild(regen);
      }
      row.appendChild(tools);
      chatMessages.appendChild(row);
      if (turn.sources?.length) chatMessages.appendChild(buildSources(turn.sources));
    } else {
      row.textContent = turn.content;
      chatMessages.appendChild(row);
    }
  }
  scrollChatToBottom(true);
}

chatMessages.addEventListener("click", (e) => {
  const cite = (e.target as HTMLElement).closest<HTMLElement>(".chat-cite");
  if (!cite) return;
  e.preventDefault();
  showDetailView(Number(cite.dataset.pageId));
});

chatClearBtn.addEventListener("click", () => {
  chatAbort?.abort();
  chatHistory = [];
  saveChatHistory();
  renderChatMessages();
});

async function captureCurrentTabContent(): Promise<{ title: string; url: string; content: string } | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/generic-capture.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window as any).__saveItUpCaptureGeneric()
    });
    if (!result) return null;

    let extra = "";
    let baseContent: string = result.pageContent ?? "";
    const siteCapture = matchSiteCapture(domainOf(tab.url));
    if (siteCapture) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [siteCapture.file] });
        const [{ result: siteResult }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: siteCapture.func
        });
        if (siteResult?.pageContent) baseContent = siteResult.pageContent; // YouTube: the clean structured page, not raw DOM text
        if (siteResult?.transcript) extra += `\n\nTranscript:\n${renderPlain(siteResult.transcript)}`;
        if (siteResult?.description) extra += `\n\nDescription:\n${siteResult.description}`;
      } catch {
        // site-specific capture is best-effort; fall back to generic content alone
      }
    }

    return {
      title: result.title ?? tab.title ?? "",
      url: result.url ?? tab.url,
      content: baseContent + extra
    };
  } catch {
    return null;
  }
}

function showChatTyping() {
  const row = document.createElement("div");
  row.className = "chat-message chat-message-assistant chat-message-typing";
  row.setAttribute("aria-live", "polite");
  row.innerHTML = `<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>`;
  chatMessages.appendChild(row);
  scrollChatToBottom(true);
  return row;
}

async function sendChatMessage(override?: string, isRetry = false) {
  if (chatAbort) {
    chatAbort.abort(); // the send button doubles as Stop while a reply is generating
    return;
  }
  const text = (override ?? chatInput.value).trim();
  if (!text) return;
  if (override === undefined) {
    chatInput.value = "";
    chatInput.style.height = "";
  }

  if (!isRetry) chatHistory.push({ role: "user", content: text });
  await renderChatMessages();
  const typingRow = showChatTyping();
  const abort = (chatAbort = new AbortController());
  setChatBusy(true);

  // Live bubble, created on the first token; markdown re-render throttled to one per frame.
  let liveRow: HTMLElement | null = null;
  let liveText = "";
  let frame = 0;
  const paint = async () => {
    frame = 0;
    if (liveRow) liveRow.innerHTML = await renderAssistantHtml(liveText);
    scrollChatToBottom();
  };
  const onToken = (delta: string) => {
    if (!liveRow) {
      typingRow.remove();
      liveRow = document.createElement("div");
      liveRow.className = "chat-message chat-message-assistant";
      chatMessages.appendChild(liveRow);
    }
    liveText += delta;
    if (!frame) frame = requestAnimationFrame(paint);
  };

  try {
    const currentPage = chatIncludeCurrentTab.checked ? await captureCurrentTabContent() : null;
    const history = chatHistory.slice(0, -1).filter((t) => !t.error).map(({ role, content }) => ({ role, content }));
    const { reply, sources } = await chatMessage(text, history, currentPage, { onToken, signal: abort.signal });
    chatHistory.push({ role: "assistant", content: reply, sources });
  } catch (err) {
    const stopped = abort.signal.aborted;
    if (stopped && liveText) chatHistory.push({ role: "assistant", content: liveText.trim() });
    else if (stopped) chatHistory.pop(); // stopped before any output: drop the unanswered question
    else {
      const msg = (err as Error).message || "Unknown error";
      chatHistory.push({ role: "assistant", content: "", error: msg.includes("abort") ? "The model took too long to respond." : msg });
    }
  } finally {
    if (frame) cancelAnimationFrame(frame);
    typingRow.remove();
    chatAbort = null;
    setChatBusy(false);
    saveChatHistory();
    await renderChatMessages();
  }
}

chatSendBtn.addEventListener("click", () => sendChatMessage());
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 110)}px`;
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
chrome.storage.session
  .get(CHAT_STORE_KEY)
  .then((got) => {
    chatHistory = (got[CHAT_STORE_KEY] as ChatTurn[] | undefined) ?? [];
  })
  .catch(() => {})
  .finally(() => renderChatMessages());

// --- take a note (from sidepanel, no page selection needed) ---
const takeNoteBtn = document.getElementById("takeNoteBtn") as HTMLButtonElement;
const noteComposer = document.getElementById("noteComposer") as HTMLDivElement;
const noteComposerInput = document.getElementById("noteComposerInput") as HTMLTextAreaElement;
const noteComposerSave = document.getElementById("noteComposerSave") as HTMLButtonElement;
const noteComposerCancel = document.getElementById("noteComposerCancel") as HTMLButtonElement;
const noteComposerStatus = document.getElementById("noteComposerStatus") as HTMLSpanElement;

function closeNoteComposer() {
  noteComposer.classList.add("view-hidden");
  noteComposerInput.value = "";
  noteComposerStatus.textContent = "";
  noteComposerStatus.classList.remove("note-status--error");
}

takeNoteBtn?.addEventListener("click", () => {
  document.getElementById("addMenu")?.classList.add("view-hidden");
  const opening = noteComposer.classList.contains("view-hidden");
  if (opening) {
    noteComposer.classList.remove("view-hidden");
    noteComposerInput.focus();
  } else {
    closeNoteComposer();
  }
});

noteComposerCancel.addEventListener("click", closeNoteComposer);

noteComposerInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    noteComposerSave.click();
  } else if (e.key === "Escape") {
    e.preventDefault();
    noteComposerCancel.click();
  }
});

noteComposerSave.addEventListener("click", async () => {
  const noteText = noteComposerInput.value.trim();
  if (!noteText) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    noteComposerStatus.classList.add("note-status--error");
    noteComposerStatus.textContent = "No active tab.";
    return;
  }
  noteComposerSave.disabled = true;
  noteComposerStatus.classList.remove("note-status--error");
  noteComposerStatus.textContent = "Saving...";
  chrome.runtime.sendMessage(
    { type: "saveitup-take-note-button", tabId: tab.id, noteText },
    (response) => {
      noteComposerSave.disabled = false;
      if (response?.ok) {
        closeNoteComposer();
      } else {
        noteComposerStatus.classList.add("note-status--error");
        noteComposerStatus.textContent = `Failed: ${response?.error ?? "unknown error"}`;
      }
    }
  );
});

// --- URL to markdown ---
const urlToMdBtn = document.getElementById("urlToMdBtn") as HTMLButtonElement;
const urlToMdBox = document.getElementById("urlToMdBox") as HTMLDivElement;
const urlToMdInput = document.getElementById("urlToMdInput") as HTMLInputElement;
const urlToMdExtract = document.getElementById("urlToMdExtract") as HTMLButtonElement;
const urlToMdCancel = document.getElementById("urlToMdCancel") as HTMLButtonElement;
const urlToMdStatus = document.getElementById("urlToMdStatus") as HTMLSpanElement;
const urlToMdResult = document.getElementById("urlToMdResult") as HTMLDivElement;
const urlToMdOutput = document.getElementById("urlToMdOutput") as HTMLPreElement;
const urlToMdCopy = document.getElementById("urlToMdCopy") as HTMLButtonElement;

function closeUrlToMdBox() {
  urlToMdBox.classList.add("view-hidden");
  urlToMdInput.value = "";
  urlToMdStatus.textContent = "";
  urlToMdStatus.classList.remove("note-status--error");
  urlToMdResult.classList.add("view-hidden");
  urlToMdOutput.textContent = "";
}

urlToMdBtn?.addEventListener("click", () => {
  document.getElementById("addMenu")?.classList.add("view-hidden");
  const opening = urlToMdBox.classList.contains("view-hidden");
  if (opening) {
    urlToMdBox.classList.remove("view-hidden");
    urlToMdInput.focus();
  } else {
    closeUrlToMdBox();
  }
});

urlToMdCancel.addEventListener("click", closeUrlToMdBox);

urlToMdExtract.addEventListener("click", async () => {
  const url = urlToMdInput.value.trim();
  if (!url) return;
  urlToMdExtract.disabled = true;
  urlToMdStatus.classList.remove("note-status--error");
  urlToMdStatus.textContent = "Extracting...";
  urlToMdResult.classList.add("view-hidden");
  try {
    const { markdown, duplicateCount } = await extractUrlToMarkdown(url);
    urlToMdOutput.textContent = markdown;
    urlToMdResult.classList.remove("view-hidden");
    urlToMdStatus.textContent = "Saved to your feed";
    refreshBrowse();
    if (duplicateCount > 0) {
      showToast(`Saved — you've now saved this page ${duplicateCount + 1}×`);
    }
  } catch (err) {
    urlToMdStatus.classList.add("note-status--error");
    urlToMdStatus.textContent = `Failed: ${(err as Error).message}`;
  } finally {
    urlToMdExtract.disabled = false;
  }
});

urlToMdCopy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(urlToMdOutput.textContent ?? "");
  const original = urlToMdCopy.innerHTML;
  urlToMdCopy.innerHTML = `${icon("checkCircle")} Copied`;
  setTimeout(() => (urlToMdCopy.innerHTML = original), 1400);
});

// --- tab sessions ---
const tabsList = document.getElementById("tabsList") as HTMLDivElement;
const tabsToggleAllBtn = document.getElementById("tabsToggleAllBtn") as HTMLButtonElement;
const tabsRefreshBtn = document.getElementById("tabsRefreshBtn") as HTMLButtonElement;
const saveTabsBtn = document.getElementById("saveTabsBtn") as HTMLButtonElement;
const tabsSaveStatus = document.getElementById("tabsSaveStatus") as HTMLSpanElement;
const tabsShareRow = document.getElementById("tabsShareRow") as HTMLDivElement;
const tabsShareLink = document.getElementById("tabsShareLink") as HTMLInputElement;
const tabsCopyLinkBtn = document.getElementById("tabsCopyLinkBtn") as HTMLButtonElement;

const openTabIds = new Set<number>();

async function refreshTabsList() {
  const openTabs = await chrome.tabs.query({ currentWindow: true });
  tabsList.innerHTML = "";
  openTabIds.clear();
  tabsShareRow.classList.add("view-hidden");
  tabsSaveStatus.textContent = "";

  for (const tab of openTabs) {
    if (!tab.id || !tab.url) continue;
    openTabIds.add(tab.id);

    const row = document.createElement("label");
    row.className = "tabs-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.tabId = String(tab.id);
    checkbox.addEventListener("change", updateToggleAllLabel);
    row.appendChild(checkbox);

    if (tab.favIconUrl) {
      const favicon = document.createElement("img");
      favicon.className = "site-favicon";
      favicon.alt = "";
      favicon.src = tab.favIconUrl;
      favicon.addEventListener("error", () => {
        favicon.style.display = "none";
      });
      row.appendChild(favicon);
    }

    const title = document.createElement("span");
    title.className = "tabs-row-title";
    title.textContent = tab.title || tab.url;
    row.appendChild(title);

    tabsList.appendChild(row);
  }

  updateToggleAllLabel();
}

function checkedTabCheckboxes(): HTMLInputElement[] {
  return Array.from(tabsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

function updateToggleAllLabel() {
  const boxes = checkedTabCheckboxes();
  const allChecked = boxes.length > 0 && boxes.every((cb) => cb.checked);
  tabsToggleAllBtn.textContent = allChecked ? "Deselect all" : "Select all";
}

tabsToggleAllBtn.addEventListener("click", () => {
  const boxes = checkedTabCheckboxes();
  const allChecked = boxes.length > 0 && boxes.every((cb) => cb.checked);
  boxes.forEach((cb) => (cb.checked = !allChecked));
  updateToggleAllLabel();
});

tabsRefreshBtn.addEventListener("click", refreshTabsList);

saveTabsBtn.addEventListener("click", async () => {
  const selectedIds = checkedTabCheckboxes()
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.dataset.tabId));
  if (selectedIds.length === 0) {
    tabsSaveStatus.textContent = "Select at least one tab.";
    return;
  }

  saveTabsBtn.disabled = true;
  tabsSaveStatus.textContent = "Saving...";
  try {
    const openTabs = await chrome.tabs.query({ currentWindow: true });
    const tabs = openTabs
      .filter((tab) => tab.id !== undefined && selectedIds.includes(tab.id) && tab.url)
      .map((tab) => ({ url: tab.url as string, title: tab.title ?? tab.url ?? "", favIconUrl: tab.favIconUrl ?? null }));

    const { id } = await createTabSession(tabs);
    const settings = await getSettings();
    const shareUrl = `${settings.publicBase}/open/${id}`;
    if (isLocalUrl(shareUrl)) showToast("This link only works on this computer. Set a Public link URL in Settings to share it.");
    tabsShareLink.value = shareUrl;
    tabsShareRow.classList.remove("view-hidden");
    tabsSaveStatus.textContent = `Saved ${tabs.length} tab${tabs.length === 1 ? "" : "s"}.`;
  } catch (err) {
    tabsSaveStatus.textContent = `Failed: ${(err as Error).message}`;
  } finally {
    saveTabsBtn.disabled = false;
  }
});

tabsCopyLinkBtn.addEventListener("click", async () => {
  if (!tabsShareLink.value) return;
  await navigator.clipboard.writeText(tabsShareLink.value);
  const original = tabsCopyLinkBtn.textContent;
  tabsCopyLinkBtn.textContent = "Copied";
  setTimeout(() => (tabsCopyLinkBtn.textContent = original), 1400);
});

document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="tabs"]')?.addEventListener("click", refreshTabsList);

// --- settings ---
const apiBaseInput = document.getElementById("apiBase") as HTMLInputElement;
const publicBaseInput = document.getElementById("publicBase") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const testConnectionBtn = document.getElementById("testConnection") as HTMLButtonElement;

async function loadSettings() {
  const stored = await chrome.storage.local.get(["apiBase", "publicBase", "groupMode"]);
  if (stored.apiBase) apiBaseInput.value = stored.apiBase;
  if (stored.publicBase) publicBaseInput.value = stored.publicBase;
  if (stored.groupMode) groupModeSelect.value = stored.groupMode;
}

function setStatus(text: string, kind: "success" | "error" | "" = "") {
  statusEl.textContent = text;
  statusEl.className = kind ? `status-${kind}` : "";
}

document.getElementById("saveSettings")?.addEventListener("click", async () => {
  const apiBase = apiBaseInput.value.trim();
  try {
    new URL(apiBase);
  } catch {
    setStatus("API base must be a valid URL.", "error");
    return;
  }
  const publicBase = publicBaseInput.value.trim();
  if (publicBase) {
    try {
      new URL(publicBase);
    } catch {
      setStatus("Public link URL must be a valid URL.", "error");
      return;
    }
  }
  await chrome.storage.local.set({ apiBase, publicBase });
  setStatus("Settings saved.", "success");
  setTimeout(() => setStatus(""), 1800);
  refreshBrowse();
});

testConnectionBtn?.addEventListener("click", async () => {
  setStatus("Testing...", "");
  try {
    const apiBase = apiBaseInput.value.trim();
    const origin = new URL(apiBase).origin;
    const granted =
      (await chrome.permissions.contains({ origins: [`${origin}/*`] })) ||
      (await chrome.permissions.request({ origins: [`${origin}/*`] }));
    if (!granted) throw new Error(`permission to reach ${origin} was not granted`);
    const token = await getAuthToken();
    const res = await fetch(`${apiBase}/folders`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    setStatus("Connected successfully.", "success");
  } catch (err) {
    setStatus(`Connection failed: ${(err as Error).message}`, "error");
  }
});

// Small shared helper for the button-triggered async actions added most recently
// (provider/role save) — disables the button and swaps its label for the duration,
// restoring it in a finally so a thrown error doesn't leave it stuck disabled.
async function withBusyLabel(button: HTMLButtonElement, busyText: string, fn: () => Promise<void>): Promise<void> {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// --- AI provider keys ---
const providerDisclosures = document.querySelectorAll<HTMLDetailsElement>("#aiProviderKeys .settings-disclosure[data-provider]");

async function loadProviderKeys() {
  const creds = await getAllCredentials();
  providerDisclosures.forEach((details) => {
    const provider = details.dataset.provider as string;
    const saved = creds[provider as keyof typeof creds];
    const keyInput = details.querySelector(".provider-key") as HTMLInputElement | null;
    const baseUrlInput = details.querySelector(".provider-baseurl") as HTMLInputElement | null;
    const modelInput = details.querySelector(".provider-model") as HTMLInputElement | null;
    if (keyInput) keyInput.value = saved?.apiKey ?? "";
    if (baseUrlInput) baseUrlInput.value = saved?.baseUrl ?? "";
    if (modelInput) modelInput.value = saved?.model ?? "";
    // "Ready" = something usable is saved (Ollama has no key, so a base URL or model counts).
    setPill(details, !!(saved?.apiKey || (provider === "ollama" && (saved?.baseUrl || saved?.model))), "Ready", "Not set");
  });
}

function setPill(row: Element, on: boolean, onText: string, offText: string) {
  const pill = row.querySelector<HTMLElement>("[data-pill]");
  if (!pill) return;
  pill.textContent = on ? onText : offText;
  pill.classList.toggle("on", on);
}

providerDisclosures.forEach((details) => {
  const provider = details.dataset.provider as Provider;
  const saveBtn = details.querySelector(".provider-save") as HTMLButtonElement;
  saveBtn.addEventListener("click", () =>
    withBusyLabel(saveBtn, "Saving...", async () => {
      const keyInput = details.querySelector(".provider-key") as HTMLInputElement | null;
      const baseUrlInput = details.querySelector(".provider-baseurl") as HTMLInputElement | null;
      const modelInput = details.querySelector(".provider-model") as HTMLInputElement | null;
      try {
        await setProviderCredentials(provider, {
          apiKey: keyInput?.value.trim() || undefined,
          baseUrl: baseUrlInput?.value.trim() || undefined,
          model: modelInput?.value.trim() || undefined
        });
        showToast(`Saved ${provider} key`);
        syncKeysAfterChange();
        await loadAISettings();
      } catch (err) {
        showToast(`Failed to save: ${(err as Error).message}`);
      }
    })
  );
});

// --- AI role settings ---
const roleDisclosures = document.querySelectorAll<HTMLDetailsElement>("#aiRoleSettings .settings-disclosure[data-role]");

const aiFeaturesEmptyHint = document.getElementById("aiFeaturesEmptyHint") as HTMLElement;

async function loadAISettings() {
  await loadProviderKeys();
  try {
    const config = await getAIConfig();
    const configuredProviders: string[] = [];
    for (const p of config.knownProviders) {
      if (await isProviderConfigured(p)) configuredProviders.push(p);
    }
    // "ollama" needs no key and is always reported configured (it just assumes a local
    // server) — only count something as "set up" if there's a provider beyond that.
    const hasRealProvider = configuredProviders.some((p) => p !== "ollama");
    aiFeaturesEmptyHint.classList.toggle("view-hidden", hasRealProvider);
    roleDisclosures.forEach((details) => {
      const role = details.dataset.role as AIRole;
      const providerSelect = details.querySelector(".role-provider") as HTMLSelectElement;
      const modelInput = details.querySelector(".role-model") as HTMLInputElement;

      providerSelect.innerHTML = "";
      const noneOption = document.createElement("option");
      noneOption.value = "";
      noneOption.textContent = "(none)";
      providerSelect.appendChild(noneOption);
      for (const p of configuredProviders) {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        providerSelect.appendChild(opt);
      }

      const saved = config.roles[role];
      const pair = saved?.chain[0];
      providerSelect.value = pair?.provider ?? "";
      modelInput.value = pair?.model ?? "";
      setPill(details, !!pair?.provider, "Active", "Off");
      const sub = details.querySelector<HTMLElement>("[data-role-sub]");
      if (sub) {
        sub.dataset.default ??= sub.textContent ?? "";
        sub.textContent = pair?.provider ? `${pair.provider} · ${pair.model || "provider default"}` : sub.dataset.default;
      }
    });
  } catch (err) {
    console.error("[saveitup] failed to load AI settings", err);
  }
}

roleDisclosures.forEach((details) => {
  const role = details.dataset.role as AIRole;
  const saveBtn = details.querySelector(".role-save") as HTMLButtonElement;
  const testBtn = details.querySelector(".role-test") as HTMLButtonElement;
  testBtn.addEventListener("click", () =>
    withBusyLabel(testBtn, "Testing...", async () => {
      try {
        showToast(await testRoleModel(role));
      } catch (err) {
        showToast(`Test failed: ${(err as Error).message}`);
      }
    })
  );
  saveBtn.addEventListener("click", () =>
    withBusyLabel(saveBtn, "Saving...", async () => {
      const providerSelect = details.querySelector(".role-provider") as HTMLSelectElement;
      const modelInput = details.querySelector(".role-model") as HTMLInputElement;
      const provider = providerSelect.value.trim();
      const model = modelInput.value.trim();
      try {
        const chain = provider ? [{ provider, model }] : [];
        await updateAIConfig(role, chain);
        showToast(`Saved ${role} AI settings`);
        syncKeysAfterChange();
        await loadAISettings();
      } catch (err) {
        showToast(`Failed to save: ${(err as Error).message}`);
      }
    })
  );
});

// --- AI error log ---
const aiErrorsList = document.getElementById("aiErrorsList") as HTMLDivElement;
const clearAiErrorsBtn = document.getElementById("clearAiErrors") as HTMLButtonElement;

async function loadAIErrors() {
  try {
    const errors = await listAIErrors();
    aiErrorsList.innerHTML = "";
    if (errors.length === 0) {
      aiErrorsList.innerHTML = `<p class="ai-error-empty">No errors recorded.</p>`;
      return;
    }
    for (const e of errors) {
      const row = document.createElement("div");
      row.className = "ai-error-row";
      const meta = document.createElement("div");
      meta.className = "ai-error-meta";
      meta.textContent = `${new Date(e.timestamp).toLocaleString()} · ${e.role} · ${e.provider}${e.model ? ` (${e.model})` : ""}`;
      const msg = document.createElement("div");
      msg.className = "ai-error-message";
      msg.textContent = e.message;
      row.append(meta, msg);
      aiErrorsList.appendChild(row);
    }
  } catch (err) {
    console.error("[saveitup] failed to load AI errors", err);
  }
}

clearAiErrorsBtn?.addEventListener("click", async () => {
  await clearAIErrors();
  await loadAIErrors();
});

// --- browse ---
const searchInput = document.getElementById("search") as HTMLInputElement;
const folderActionsSelect = document.getElementById("folderActions") as HTMLSelectElement;
const groupModeSelect = document.getElementById("groupMode") as HTMLSelectElement;
const listEl = document.getElementById("list") as HTMLDivElement;
const clearSearchBtn = document.getElementById("clearSearch") as HTMLButtonElement;
const resultsCountEl = document.getElementById("resultsCount") as HTMLDivElement;
const searchModeBadge = document.getElementById("searchModeBadge") as HTMLElement;

// null = not checked yet / server unreachable — badge just stays hidden then.
let semanticSearchAvailable: boolean | null = null;
getServerHealth().then((health) => {
  semanticSearchAvailable = health?.semanticSearch ?? null;
  updateSearchModeBadge();
});

function updateSearchModeBadge() {
  const hasQuery = !!searchInput.value.trim();
  if (!hasQuery || semanticSearchAvailable === null) {
    searchModeBadge.classList.add("view-hidden");
    return;
  }
  searchModeBadge.classList.remove("view-hidden");
  if (semanticSearchAvailable) {
    searchModeBadge.textContent = "smart";
    searchModeBadge.title = "Semantic search is on — results are ranked by meaning, not just keyword matches.";
  } else {
    searchModeBadge.textContent = "text";
    searchModeBadge.title = "Keyword search only — the server has no embedding provider configured for smarter ranking.";
  }
}

let searchDebounce: number | undefined;
searchInput.addEventListener("input", () => {
  clearSearchBtn.classList.toggle("view-hidden", !searchInput.value);
  updateSearchModeBadge();
  clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(refreshBrowse, 300);
});
clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.add("view-hidden");
  updateSearchModeBadge();
  refreshBrowse();
  searchInput.focus();
});
groupModeSelect.addEventListener("change", () => {
  chrome.storage.local.set({ groupMode: groupModeSelect.value });
  refreshBrowse();
});

// --- extra filters: folder, site, date, has-note/has-highlight ---
const folderFilterSelect = document.getElementById("folderFilter") as HTMLSelectElement;
const domainFilterInput = document.getElementById("domainFilter") as HTMLInputElement;
const dateFilterSelect = document.getElementById("dateFilter") as HTMLSelectElement;
const hasNoteFilterCheckbox = document.getElementById("hasNoteFilter") as HTMLInputElement;
const hasHighlightFilterCheckbox = document.getElementById("hasHighlightFilter") as HTMLInputElement;
const clearFiltersBtn = document.getElementById("clearFiltersBtn") as HTMLButtonElement;

loadFolderOptions(folderFilterSelect, "All folders");

function dateFilterCutoff(value: string): Date | null {
  const now = new Date();
  if (value === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === "week") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (value === "month") return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  return null;
}

function applyExtraFilters(pages: SavedPageSummary[]): SavedPageSummary[] {
  let result = pages;
  const domain = domainFilterInput.value.trim().toLowerCase();
  if (domain) result = result.filter((p) => p.domain.toLowerCase().includes(domain));
  if (hasNoteFilterCheckbox.checked) result = result.filter((p) => p.hasNote);
  if (hasHighlightFilterCheckbox.checked) result = result.filter((p) => p.hasHighlight);
  const cutoff = dateFilterCutoff(dateFilterSelect.value);
  if (cutoff) result = result.filter((p) => new Date(p.createdAt) >= cutoff);
  return result;
}

[folderFilterSelect, dateFilterSelect, hasNoteFilterCheckbox, hasHighlightFilterCheckbox].forEach((el) =>
  el.addEventListener("change", () => refreshBrowse())
);
let domainFilterDebounce: number | undefined;
domainFilterInput.addEventListener("input", () => {
  clearTimeout(domainFilterDebounce);
  domainFilterDebounce = window.setTimeout(refreshBrowse, 300);
});

clearFiltersBtn.addEventListener("click", () => {
  folderFilterSelect.value = "";
  domainFilterInput.value = "";
  dateFilterSelect.value = "";
  hasNoteFilterCheckbox.checked = false;
  hasHighlightFilterCheckbox.checked = false;
  refreshBrowse();
});

let folderCache: Folder[] = [];

async function loadFolderOptions(selectEl: HTMLSelectElement, placeholder: string) {
  try {
    const folders = await listFolders();
    const current = selectEl.value;
    selectEl.innerHTML = `<option value="">${placeholder}</option>`;
    folderCache = folders;
    for (const { folder, depth } of folderTree(folders)) {
      const opt = document.createElement("option");
      opt.value = String(folder.id);
      opt.textContent = "  ".repeat(depth) + folder.name;
      selectEl.appendChild(opt);
    }
    selectEl.value = current;
  } catch {
    // backend not reachable; leave folder filter as-is
  }
}

folderActionsSelect?.addEventListener("change", async () => {
  const action = folderActionsSelect.value;
  folderActionsSelect.value = "";
  if (!action) return;
  const filterId = folderFilterSelect.value ? Number(folderFilterSelect.value) : null;
  try {
    if (action === "__new__") {
      const path = await askText({ title: "New folder", label: "Name, or Work / Reading to nest", okText: "Create" });
      if (!path) return;
      await ensureFolderPath(path.split("/"));
      showToast(`Created folder "${path}"`);
    } else if (filterId === null) {
      showToast("Pick a folder in 'Filter by folder' first.");
      return;
    } else if (action === "__rename__") {
      const name = await askText({ title: "Rename folder", value: folderCache.find((f) => f.id === filterId)?.name, okText: "Rename" });
      if (!name) return;
      await renameFolder(filterId, name);
      showToast("Folder renamed");
    } else if (action === "__delete__") {
      if (!(await askConfirm({ title: "Delete folder?", message: "Its subfolders are deleted too. Pages inside are kept (unfiled).", okText: "Delete", danger: true }))) return;
      await deleteFolder(filterId);
      folderFilterSelect.value = "";
      showToast("Folder deleted");
    }
    await loadFolderOptions(folderFilterSelect, folderFilterSelect.options[0]?.textContent ?? "All folders");
    refreshBrowse();
  } catch (err) {
    showToast(`Folder action failed: ${(err as Error).message}`);
  }
});

// --- jump to live page (secondary action from the detail view) ---
async function openOriginalPage(full: SavedPageRecord): Promise<void> {
  let targetUrl = full.url;
  if (full.highlightText) {
    const snippet = full.highlightText.trim().slice(0, 200);
    const hashIndex = targetUrl.indexOf("#");
    const base = hashIndex === -1 ? targetUrl : targetUrl.slice(0, hashIndex);
    targetUrl = `${base}#:~:text=${encodeURIComponent(snippet)}`;
  }

  const tab = await chrome.tabs.create({ url: targetUrl });

  if (full.highlightText && tab.id) {
    const tabId = tab.id;
    const snippet = full.highlightText.trim().slice(0, 200);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.scripting
        .executeScript({ target: { tabId }, files: ["content/scroll-to-text.js"] })
        .then(() =>
          chrome.scripting.executeScript({
            target: { tabId },
            func: (text: string) => (window as any).__saveItUpScrollToText(text),
            args: [snippet]
          })
        )
        .catch(() => {
          // page may be a restricted URL (chrome://, web store, etc); nothing we can do
        });
    };
    chrome.tabs.onUpdated.addListener(listener);
  } else if (full.elementSelector && tab.id) {
    const tabId = tab.id;
    const selector = full.elementSelector;
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.scripting
        .executeScript({ target: { tabId }, files: ["content/scroll-to-element.js"] })
        .then(() =>
          chrome.scripting.executeScript({
            target: { tabId },
            func: (sel: string) => (window as any).__saveItUpScrollToSelector(sel),
            args: [selector]
          })
        )
        .catch(() => {
          // page may be a restricted URL (chrome://, web store, etc); nothing we can do
        });
    };
    chrome.tabs.onUpdated.addListener(listener);
  }
}

async function renderFolderPicker(
  folderId: number | null,
  onChange: (newFolderId: number | null) => void
): Promise<HTMLDivElement> {
  const wrap = document.createElement("div");
  wrap.className = "folder-picker";

  const label = document.createElement("label");
  label.className = "folder-picker-label";
  label.textContent = "Folder";
  wrap.appendChild(label);

  const select = document.createElement("select");
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "Unfiled";
  select.appendChild(noneOption);

  const folders = await listFolders();
  folderCache = folders;
  for (const { folder, depth } of folderTree(folders)) {
    const option = document.createElement("option");
    option.value = String(folder.id);
    option.textContent = "  ".repeat(depth) + folder.name;
    select.appendChild(option);
  }

  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "+ New folder...";
  select.appendChild(newOption);

  select.value = folderId !== null ? String(folderId) : "";

  select.addEventListener("change", async () => {
    if (select.value === "__new__") {
      const path = await askText({ title: "New folder", label: "Name, or Work / Reading to nest", okText: "Create" });
      select.value = folderId !== null ? String(folderId) : "";
      if (!path) return;
      const id = await ensureFolderPath(path.split("/"), folders);
      if (id !== null) onChange(id);
    } else if (select.value === "") {
      onChange(null);
    } else {
      onChange(Number(select.value));
    }
  });

  wrap.appendChild(select);
  return wrap;
}

// --- grouping ---
function groupByUrl(pages: SavedPageSummary[]): Map<string, SavedPageSummary[]> {
  const map = new Map<string, SavedPageSummary[]>();
  for (const page of pages) {
    map.set(page.url, [...(map.get(page.url) ?? []), page]);
  }
  return map;
}

function groupByDomain(pages: SavedPageSummary[]): Map<string, SavedPageSummary[]> {
  const map = new Map<string, SavedPageSummary[]>();
  for (const page of pages) {
    map.set(page.domain, [...(map.get(page.domain) ?? []), page]);
  }
  return map;
}

function groupByFolder(pages: SavedPageSummary[]): Map<string, SavedPageSummary[]> {
  const map = new Map<string, SavedPageSummary[]>();
  for (const page of pages) {
    const key = page.folderId !== null ? folderPath(folderCache, page.folderId) || page.folderName || "Unfiled" : "Unfiled";
    map.set(key, [...(map.get(key) ?? []), page]);
  }
  return map;
}

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(domain)}`;
}

function renderFavicon(domain: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "site-favicon";
  img.alt = "";
  img.src = faviconUrl(domain);
  img.addEventListener("error", () => {
    img.style.display = "none";
  });
  return img;
}

const expandedUrls = new Set<string>();

// --- bulk select mode ---
let selectMode = false;
const selectedIds = new Set<number>();
const selectModeBtn = document.getElementById("selectModeBtn") as HTMLButtonElement;
const bulkBar = document.getElementById("bulkBar") as HTMLDivElement;
const bulkCountEl = document.getElementById("bulkCount") as HTMLSpanElement;
const bulkDeleteBtn = document.getElementById("bulkDeleteBtn") as HTMLButtonElement;
const bulkCancelBtn = document.getElementById("bulkCancelBtn") as HTMLButtonElement;
const bulkFolderSelect = document.getElementById("bulkFolderSelect") as HTMLSelectElement;
const bulkMoveBtn = document.getElementById("bulkMoveBtn") as HTMLButtonElement;

function updateBulkBar() {
  bulkBar.classList.toggle("view-hidden", !selectMode || selectedIds.size === 0);
  bulkCountEl.textContent = `${selectedIds.size} selected`;
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  selectModeBtn.classList.remove("active");
  bulkBar.classList.add("view-hidden");
  refreshBrowse();
}

selectModeBtn?.addEventListener("click", () => {
  if (selectMode) {
    exitSelectMode();
  } else {
    selectMode = true;
    selectModeBtn.classList.add("active");
    updateBulkBar();
    loadFolderOptions(bulkFolderSelect, "Move to folder...");
    refreshBrowse();
  }
});

bulkCancelBtn?.addEventListener("click", exitSelectMode);

bulkMoveBtn?.addEventListener("click", async () => {
  const value = bulkFolderSelect.value;
  if (!value || selectedIds.size === 0) return;
  bulkMoveBtn.disabled = true;
  try {
    const folderId = Number(value);
    for (const id of selectedIds) {
      await setFolder(id, folderId);
    }
    bulkFolderSelect.value = "";
    exitSelectMode();
  } finally {
    bulkMoveBtn.disabled = false;
  }
});

bulkDeleteBtn?.addEventListener("click", async () => {
  if (selectedIds.size === 0) return;
  const ids = [...selectedIds];
  deleteWithUndo(ids, () => {
    exitSelectMode();
    refreshBrowse();
  });
});

function renderRow(page: SavedPageSummary, opts: { showTitle: boolean; compact?: boolean }): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "sub-row";
  row.dataset.pageId = String(page.id);
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", page.title || page.url);

  const top = document.createElement("div");
  top.className = "sub-row-top";

  const left = document.createElement("div");
  left.className = "sub-row-left";

  if (selectMode) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "sub-row-checkbox";
    checkbox.checked = selectedIds.has(page.id);
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(page.id);
      else selectedIds.delete(page.id);
      updateBulkBar();
    });
    left.appendChild(checkbox);
  }

  if (opts.showTitle) {
    left.appendChild(renderFavicon(page.domain));
    const titleEl = document.createElement("span");
    titleEl.className = "sub-row-flat-title";
    titleEl.textContent = page.title || page.url;
    left.appendChild(titleEl);
  }

  if (!selectMode) {
    const pinBtn = document.createElement("button");
    pinBtn.className = `icon-btn pin-btn${page.pinned ? " active" : ""}`;
    pinBtn.innerHTML = icon("star", 13);
    pinBtn.setAttribute("aria-label", page.pinned ? "Unpin" : "Pin");
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await setPinned(page.id, !page.pinned);
      refreshBrowse();
    });
    left.appendChild(pinBtn);
  }

  const type = getCaptureType(page);
  const badge = document.createElement("span");
  badge.className = `capture-badge ${captureTypeBadgeClass(type)}`;
  badge.textContent = captureTypeLabel(type);
  left.appendChild(badge);
  top.appendChild(left);

  const right = document.createElement("div");
  right.className = "sub-row-right";

  if (!selectMode) {
    const trashBtn = document.createElement("button");
    trashBtn.className = "icon-btn sub-row-trash";
    trashBtn.innerHTML = icon("trash", 13);
    trashBtn.setAttribute("aria-label", "Delete");
    trashBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      deleteWithUndo([page.id], refreshBrowse);
    });
    right.appendChild(trashBtn);
  }

  const chev = document.createElement("span");
  chev.className = "sub-row-chevron";
  chev.innerHTML = icon("chevronRight", 12);
  right.appendChild(chev);
  top.appendChild(right);

  row.appendChild(top);

  const rowMeta = document.createElement("div");
  rowMeta.className = "sub-row-meta";
  rowMeta.textContent = opts.showTitle
    ? `${page.domain} · ${new Date(page.createdAt).toLocaleString()}`
    : new Date(page.createdAt).toLocaleString();
  row.appendChild(rowMeta);

  function activateRow() {
    if (selectMode) {
      const checkbox = row.querySelector<HTMLInputElement>(".sub-row-checkbox");
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      }
    } else {
      showDetailView(page.id);
    }
  }
  row.addEventListener("click", activateRow);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateRow();
    }
  });

  return row;
}

function renderPendingRow(entry: PendingSave): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "sub-row pending-row";

  const top = document.createElement("div");
  top.className = "sub-row-top";

  const left = document.createElement("div");
  left.className = "sub-row-left";
  left.appendChild(renderFavicon(entry.domain));
  const titleEl = document.createElement("span");
  titleEl.className = "sub-row-flat-title";
  titleEl.textContent = entry.title || entry.domain;
  left.appendChild(titleEl);
  top.appendChild(left);

  const right = document.createElement("div");
  right.className = "sub-row-right";
  const spinner = document.createElement("span");
  spinner.className = "save-spinner";
  right.appendChild(spinner);
  top.appendChild(right);

  row.appendChild(top);

  const meta = document.createElement("div");
  meta.className = "sub-row-meta";
  meta.textContent = "Cleaning up with AI…";
  row.appendChild(meta);

  return row;
}

function renderGroup(
  key: string,
  pages: SavedPageSummary[],
  opts?: { label?: string; favicon?: string; variant?: "folder" | "domain" }
): HTMLDivElement {
  const isFolder = opts?.variant === "folder";
  // Folder and site groups can hold different pages, so each row needs its
  // own favicon/title to tell them apart. Page groups are all the same URL,
  // so the shared header above already identifies them.
  const rowsNeedTitle = opts?.variant === "folder" || opts?.variant === "domain";
  const group = document.createElement("div");
  group.className = isFolder ? "item fade-in folder-group" : "item fade-in";

  const header = document.createElement("div");
  header.className = "group-header";

  const chevron = document.createElement("button");
  chevron.className = "chevron-btn";
  chevron.innerHTML = icon("chevronRight", 13);
  chevron.setAttribute("aria-label", "Expand");

  const latest = pages.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));

  const title = document.createElement("div");
  title.className = "group-title";
  title.textContent = opts?.label ?? (pages[0].title || key);

  const count = document.createElement("div");
  count.className = "group-count";
  count.textContent = pages.length > 1 ? `×${pages.length}` : "";

  // Only a plain (URL) group is actually "the same page saved more than once" —
  // folder/domain groups intentionally cluster different pages, so merging
  // wouldn't make sense there.
  const isDuplicateGroup = !opts?.variant && pages.length > 1;
  let mergeBtn: HTMLButtonElement | null = null;
  if (isDuplicateGroup) {
    mergeBtn = document.createElement("button");
    mergeBtn.type = "button";
    mergeBtn.className = "icon-btn";
    mergeBtn.innerHTML = icon("trash", 12);
    mergeBtn.setAttribute("aria-label", "Keep newest, delete the rest");
    mergeBtn.title = "Keep newest, delete the rest";
    mergeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const toDelete = pages.filter((p) => p.id !== latest.id);
      deleteWithUndo(toDelete.map((p) => p.id), refreshBrowse);
    });
  }

  if (isFolder) {
    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(chevron);
  } else {
    const favicon = renderFavicon(opts?.favicon ?? latest.domain);
    header.appendChild(chevron);
    header.appendChild(favicon);
    header.appendChild(title);
    header.appendChild(count);
    if (mergeBtn) header.appendChild(mergeBtn);
  }
  group.appendChild(header);

  if (!isFolder) {
    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = `${latest.domain} · ${new Date(latest.createdAt).toLocaleDateString()}`;
    group.appendChild(meta);
  }

  const subList = document.createElement("div");
  subList.className = isFolder ? "sub-list folder-sub-list" : "sub-list";
  for (const page of pages) {
    subList.appendChild(renderRow(page, { showTitle: rowsNeedTitle }));
  }
  group.appendChild(subList);

  const expanded = expandedUrls.has(key);
  subList.style.display = expanded ? "flex" : "none";
  chevron.classList.toggle("expanded", expanded);

  chevron.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowExpanded = subList.style.display === "none";
    subList.style.display = nowExpanded ? "flex" : "none";
    chevron.classList.toggle("expanded", nowExpanded);
    if (nowExpanded) expandedUrls.add(key);
    else expandedUrls.delete(key);
    refreshFocusableRows();
  });

  return group;
}

function renderEmptyState(opts: { searching: boolean; errorMessage?: string }): HTMLDivElement {
  const empty = document.createElement("div");
  empty.className = "empty";
  if (opts.errorMessage) {
    empty.innerHTML = `${icon("alertCircle", 26)}<p>${opts.errorMessage}</p>`;
  } else if (opts.searching) {
    empty.innerHTML = `${icon("searchOff", 26)}<p>No saves match your search.</p>`;
  } else {
    empty.innerHTML = `${icon("inbox", 26)}<p>Nothing saved yet — pick an element or use the right-click menu on any page.</p>`;
  }
  return empty;
}

let listLoadToken = 0;

// Deletes are deferred a few seconds so the toast can offer Undo; until then the rows are just hidden.
const hiddenIds = new Set<number>();
const UNDO_MS = 7000;

function deleteWithUndo(ids: number[], afterHide: () => void) {
  ids.forEach((id) => hiddenIds.add(id));
  afterHide();
  let undone = false;
  const commit = async () => {
    if (undone) return;
    for (const id of ids) {
      try {
        await deletePage(id);
      } catch (err) {
        showToast(`Delete failed: ${(err as Error).message}`);
      }
      hiddenIds.delete(id);
    }
  };
  window.addEventListener("pagehide", commit, { once: true }); // best effort if the panel closes first
  const timer = window.setTimeout(commit, UNDO_MS);
  showToast(`Deleted ${ids.length} save${ids.length === 1 ? "" : "s"}`, {
    label: "Undo",
    ms: UNDO_MS,
    onClick: () => {
      undone = true;
      clearTimeout(timer);
      ids.forEach((id) => hiddenIds.delete(id));
      refreshBrowse();
    }
  });
}

const BROWSE_PAGE_SIZE = 50;
let browseLimit = BROWSE_PAGE_SIZE;
let browseSignature = "";

async function refreshBrowse() {
  const token = ++listLoadToken;
  // A new search/folder starts back at the first page; "Load more" just raises the limit.
  const signature = `${searchInput.value.trim()}|${folderFilterSelect.value}`;
  if (signature !== browseSignature) {
    browseSignature = signature;
    browseLimit = BROWSE_PAGE_SIZE;
  }
  if (!listEl.children.length) {
    for (let i = 0; i < 4; i++) {
      const sk = document.createElement("div");
      sk.className = "skeleton-row";
      listEl.appendChild(sk);
    }
  } else {
    listEl.classList.add("loading");
  }
  try {
    const folderFilterValue = folderFilterSelect.value;
    if (folderFilterValue && !folderCache.length) folderCache = await listFolders();
    const fetched = await listPages({
      q: searchInput.value.trim(),
      limit: browseLimit,
      folderIds: folderFilterValue ? withDescendantIds(folderCache, Number(folderFilterValue)) : undefined
    });
    const hasMore = fetched.length >= browseLimit;
    const pages = applyExtraFilters(fetched).filter((p) => !hiddenIds.has(p.id));
    if (token !== listLoadToken) return;
    listEl.classList.remove("loading");
    listEl.innerHTML = "";
    for (const pending of pendingSaves.values()) {
      listEl.appendChild(renderPendingRow(pending));
    }
    const isFiltering = !!searchInput.value.trim();
    if (pages.length === 0) {
      if (pendingSaves.size === 0) {
        resultsCountEl.textContent = "";
        listEl.appendChild(renderEmptyState({ searching: isFiltering }));
      }
      return;
    }
    const pinned = pages.filter((p) => p.pinned);
    const rest = pages.filter((p) => !p.pinned);
    if (pinned.length > 0) {
      const label = document.createElement("div");
      label.className = "pinned-section-label";
      label.textContent = "📌 Pinned";
      listEl.appendChild(label);
      const sortedPinned = [...pinned].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
      for (const page of sortedPinned) {
        listEl.appendChild(renderRow(page, { showTitle: true }));
      }
    }

    const mode = groupModeSelect.value;
    if (mode === "flat") {
      resultsCountEl.textContent = `${pages.length} save${pages.length === 1 ? "" : "s"}`;
      const sorted = [...rest].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
      for (const page of sorted) {
        listEl.appendChild(renderRow(page, { showTitle: true }));
      }
    } else if (mode === "domain") {
      const groups = groupByDomain(rest);
      resultsCountEl.textContent = `${pages.length} save${pages.length === 1 ? "" : "s"} · ${groups.size} site${groups.size === 1 ? "" : "s"}`;
      for (const [domain, groupPages] of groups) {
        listEl.appendChild(renderGroup(domain, groupPages, { label: domain, favicon: domain, variant: "domain" }));
      }
    } else if (mode === "folder") {
      const groups = groupByFolder(rest);
      resultsCountEl.textContent = `${pages.length} save${pages.length === 1 ? "" : "s"} · ${groups.size} folder${groups.size === 1 ? "" : "s"}`;
      for (const [folderName, groupPages] of groups) {
        listEl.appendChild(renderGroup(folderName, groupPages, { label: folderName, variant: "folder" }));
      }
    } else {
      const groups = groupByUrl(rest);
      resultsCountEl.textContent = `${pages.length} save${pages.length === 1 ? "" : "s"} · ${groups.size} page${groups.size === 1 ? "" : "s"}`;
      for (const [url, groupPages] of groups) {
        listEl.appendChild(renderGroup(url, groupPages));
      }
    }
    if (hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "secondary-btn load-more-btn";
      more.textContent = "Load more";
      more.addEventListener("click", () => {
        browseLimit += BROWSE_PAGE_SIZE;
        refreshBrowse();
      });
      listEl.appendChild(more);
    }
    refreshFocusableRows();
  } catch (err) {
    if (token !== listLoadToken) return;
    listEl.classList.remove("loading");
    listEl.innerHTML = "";
    for (const pending of pendingSaves.values()) {
      listEl.appendChild(renderPendingRow(pending));
    }
    resultsCountEl.textContent = "";
    listEl.appendChild(renderEmptyState({ searching: false, errorMessage: (err as Error).message }));
  }
}

// --- keyboard navigation ---
let focusedIndex = -1;

function visibleRows(): HTMLDivElement[] {
  return Array.from(listEl.querySelectorAll<HTMLDivElement>(".sub-row")).filter(
    (row) => row.offsetParent !== null
  );
}

function refreshFocusableRows() {
  focusedIndex = -1;
  visibleRows().forEach((row) => row.classList.remove("focused"));
}

function setFocusedIndex(index: number) {
  const rows = visibleRows();
  if (rows.length === 0) return;
  rows.forEach((row) => row.classList.remove("focused"));
  focusedIndex = Math.max(0, Math.min(index, rows.length - 1));
  const row = rows[focusedIndex];
  row.classList.add("focused");
  row.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (e) => {
  if (!browseTab.classList.contains("active")) return;
  const target = e.target as HTMLElement;
  const inField = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

  if (!inField && e.key === "/") {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (inField) return;

  if (e.key === "j" || e.key === "ArrowDown") {
    e.preventDefault();
    setFocusedIndex(focusedIndex + 1);
  } else if (e.key === "k" || e.key === "ArrowUp") {
    e.preventDefault();
    setFocusedIndex(focusedIndex - 1);
  } else if (e.key === "Enter" && focusedIndex >= 0) {
    e.preventDefault();
    const rows = visibleRows();
    const row = rows[focusedIndex];
    const id = row?.dataset.pageId;
    if (id) showDetailView(Number(id));
  }
});

// --- detail view ---
const detailView = document.getElementById("detail-view") as HTMLElement;
const browseTab = document.getElementById("browse-tab") as HTMLElement;
const settingsTab = document.getElementById("settings-tab") as HTMLElement;
const detailEmbed = document.getElementById("detail-embed") as HTMLDivElement;
const detailBadge = document.getElementById("detail-badge") as HTMLDivElement;
const detailTitle = document.getElementById("detail-title") as HTMLHeadingElement;
const editTitleBtn = document.getElementById("editTitleBtn") as HTMLButtonElement;
const detailTitleEdit = document.getElementById("detail-title-edit") as HTMLDivElement;
const detailTitleInput = document.getElementById("detail-title-input") as HTMLInputElement;
const saveTitleBtn = document.getElementById("saveTitleBtn") as HTMLButtonElement;
const cancelTitleBtn = document.getElementById("cancelTitleBtn") as HTMLButtonElement;
const titleStatusEl = document.getElementById("titleStatus") as HTMLSpanElement;
const detailFavicon = document.getElementById("detail-favicon") as HTMLImageElement;
const detailMeta = document.getElementById("detail-meta") as HTMLDivElement;
const detailFolder = document.getElementById("detail-folder") as HTMLDivElement;
const detailBody = document.getElementById("detail-body") as HTMLDivElement;
const openOriginalBtn = document.getElementById("openOriginalBtn") as HTMLButtonElement;
const copyMarkdownBtn = document.getElementById("copyMarkdownBtn") as HTMLButtonElement;
const contentToggleBtn = document.getElementById("contentToggleBtn") as HTMLButtonElement;
const transformBtn = document.getElementById("transformBtn") as HTMLButtonElement;
const recleanBtn = document.getElementById("recleanBtn") as HTMLButtonElement;
const recleanStatus = document.getElementById("recleanStatus") as HTMLDivElement;
const transformBox = document.getElementById("transformBox") as HTMLDivElement;
const transformInput = document.getElementById("transformInput") as HTMLTextAreaElement;
const transformRun = document.getElementById("transformRun") as HTMLButtonElement;
const transformCancel = document.getElementById("transformCancel") as HTMLButtonElement;
const transformStatus = document.getElementById("transformStatus") as HTMLSpanElement;
const transformResult = document.getElementById("transformResult") as HTMLDivElement;
const transformOutput = document.getElementById("transformOutput") as HTMLDivElement;
const transformCopy = document.getElementById("transformCopy") as HTMLButtonElement;
const transformDismiss = document.getElementById("transformDismiss") as HTMLButtonElement;
const pinBtn = document.getElementById("pinBtn") as HTMLButtonElement;
const detailNoteInput = document.getElementById("detail-note-input") as HTMLTextAreaElement;
const saveNoteBtn = document.getElementById("saveNoteBtn") as HTMLButtonElement;
const noteStatusEl = document.getElementById("noteStatus") as HTMLSpanElement;

let currentDetailId: number | null = null;
let currentDetailRecord: SavedPageRecord | null = null;
let showingOriginalContent = false;

function showListView() {
  detailView.classList.add("view-hidden");
  const activeTabBtn = document.querySelector<HTMLButtonElement>(".tab-btn.active");
  document.getElementById(`${activeTabBtn?.dataset.tab ?? "browse"}-tab`)?.classList.add("active");
  currentDetailId = null;
  currentDetailRecord = null;
  refreshBrowse();
}

function buildDetailMarkdown(full: SavedPageRecord): string {
  const parts = [`# ${full.title || full.url}`, full.url];
  if (full.summary) parts.push(`## Summary\n\n${full.summary}`);
  if (full.description) parts.push(`## Description\n\n${full.description}`);
  if (full.transcript) parts.push(`## Transcript\n\n${full.transcript}`);
  const highlight = full.highlightContext ?? full.highlightText;
  if (highlight) parts.push(`## Highlight\n\n${highlight}`);
  const content = full.cleanedContent ?? full.pageContent;
  if (content) parts.push(`## Page content\n\n${content}`);
  return parts.join("\n\n");
}

async function showDetailView(id: number) {
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  detailView.classList.remove("view-hidden");
  detailView.classList.add("loading");

  detailTitle.textContent = "Loading...";
  detailMeta.textContent = "";
  detailBadge.innerHTML = "";
  detailEmbed.innerHTML = "";
  detailBody.innerHTML = "";

  let full: SavedPageRecord;
  try {
    full = await getPage(id);
  } catch (err) {
    detailView.classList.remove("loading");
    detailTitle.textContent = "Failed to load";
    detailBody.textContent = (err as Error).message;
    return;
  }
  detailView.classList.remove("loading");

  currentDetailId = id;
  currentDetailRecord = full;
  showingOriginalContent = false;
  transformBox.classList.add("view-hidden");
  transformInput.value = "";
  transformStatus.textContent = "";
  transformResult.classList.add("view-hidden");
  transformOutput.textContent = "";
  recleanStatus.classList.add("view-hidden");
  recleanStatus.classList.remove("reclean-status--failed");
  recleanStatus.textContent = "";

  const embed = resolveEmbed(full.url);
  if (embed) {
    const wrapper = document.createElement("div");
    wrapper.className = "embed-wrapper";
    const iframe = document.createElement("iframe");
    if (embed.kind === "youtube" && embed.videoId) {
      const settings = await getSettings();
      iframe.src = `${settings?.apiBase ?? ""}/embed/youtube/${embed.videoId}`;
      wrapper.classList.add("embed-wrapper--video");
    } else if (embed.kind === "spotify" && embed.spotify) {
      const settings = await getSettings();
      iframe.src = `${settings?.apiBase ?? ""}/embed/spotify/${embed.spotify.type}/${embed.spotify.id}`;
      const compact = embed.spotify.type === "track" || embed.spotify.type === "episode";
      wrapper.classList.add(compact ? "embed-wrapper--audio-compact" : "embed-wrapper--audio-tall");
    } else if (embed.kind === "appleMusic") {
      const settings = await getSettings();
      iframe.src = `${settings?.apiBase ?? ""}/embed/apple-music?url=${encodeURIComponent(embed.src)}`;
      wrapper.classList.add("embed-wrapper--audio-tall");
    } else if (embed.kind === "instagram" && embed.instagram) {
      const settings = await getSettings();
      iframe.src = `${settings?.apiBase ?? ""}/embed/instagram/${embed.instagram.type}/${embed.instagram.shortcode}`;
      wrapper.classList.add("embed-wrapper--instagram");
    } else {
      iframe.src = embed.src;
      wrapper.classList.add("embed-wrapper--video");
    }
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    wrapper.appendChild(iframe);
    detailEmbed.appendChild(wrapper);
  }

  const type = getCaptureType({
    hasNote: !!full.noteText,
    hasHighlight: !!full.highlightText,
    hasElementSelector: !!full.elementSelector
  });
  detailBadge.className = `capture-badge ${captureTypeBadgeClass(type)}`;
  detailBadge.textContent = captureTypeLabel(type);

  pinBtn.classList.toggle("active", full.pinned);
  pinBtn.innerHTML = icon("star", 14);
  pinBtn.title = full.pinned ? "Unpin" : "Pin";
  pinBtn.setAttribute("aria-label", pinBtn.title);

  detailTitle.textContent = full.title || full.url;
  const legacyYouTube =
    /youtube\.com|youtu\.be/.test(full.url) && !/^# .*\n[\s\S]*\[Watch on YouTube\]\(/.test(full.cleanedContent ?? full.pageContent);
  detailMeta.textContent = `${full.domain} · ${new Date(full.createdAt).toLocaleString()}${
    legacyYouTube ? " · old capture: ⋯ → Re-clean reformats it" : ""
  }`;
  detailFavicon.style.display = "";
  detailFavicon.src = faviconUrl(full.domain);
  detailFavicon.onerror = () => {
    detailFavicon.style.display = "none";
  };


  detailFolder.innerHTML = "";
  detailFolder.appendChild(
    await renderFolderPicker(full.folderId ?? null, async (newFolderId) => {
      await setFolder(full.id, newFolderId);
      currentDetailRecord = { ...full, folderId: newFolderId };
      await showDetailView(id);
    })
  );

  detailNoteInput.value = full.noteText ?? "";
  noteStatusEl.textContent = "";

  await renderDetailBody(full);
}

async function renderDetailBody(full: SavedPageRecord) {
  detailBody.innerHTML = "";

  const summarySection = document.createElement("div");
  summarySection.className = "summary-section";

  const summaryHeader = document.createElement("div");
  summaryHeader.className = "summary-header";
  const summaryHeading = document.createElement("h3");
  summaryHeading.textContent = "Summary";
  summaryHeader.appendChild(summaryHeading);

  const summaryBtn = document.createElement("button");
  summaryBtn.type = "button";
  summaryBtn.className = "secondary-btn summary-btn";
  const summaryBtnLabel = () =>
    `<span class="icon-slot">${icon("sparkles", 14)}</span> ${full.summary ? "Regenerate" : "Generate summary"}`;
  summaryBtn.innerHTML = summaryBtnLabel();
  summaryBtn.addEventListener("click", async () => {
    summaryBtn.disabled = true;
    summaryBtn.textContent = "Generating...";
    try {
      const updated = await generateSummary(full.id);
      currentDetailRecord = updated;
      await renderDetailBody(updated);
    } catch (err) {
      summaryBtn.disabled = false;
      summaryBtn.innerHTML = summaryBtnLabel();
      const errEl = document.createElement("p");
      errEl.className = "note-status note-status--error";
      errEl.textContent = `Failed: ${(err as Error).message}`;
      summaryHeader.appendChild(errEl);
    }
  });
  summaryHeader.appendChild(summaryBtn);
  summarySection.appendChild(summaryHeader);

  if (full.summary) {
    const div = document.createElement("div");
    div.innerHTML = await renderMarkdownSafe(full.summary);
    summarySection.appendChild(div);
  } else {
    const p = document.createElement("p");
    p.className = "empty-hint";
    p.textContent = "No summary yet.";
    summarySection.appendChild(p);
  }
  detailBody.appendChild(summarySection);

  const hasCleaned = !!full.cleanedContent && full.cleanedContent !== full.pageContent;
  contentToggleBtn.style.display = hasCleaned ? "" : "none";
  contentToggleBtn.innerHTML = `<span class="icon-slot">${icon("note", 14)}</span> ${
    showingOriginalContent ? "Show cleaned" : "Show original"
  }`;

  const contentSection = document.createElement("div");
  contentSection.className = "content-section";
  const contentHeader = document.createElement("div");
  contentHeader.className = "summary-header";
  const contentHeading = document.createElement("h3");
  contentHeading.textContent = "Page content";
  contentHeader.appendChild(contentHeading);
  const shownContent = showingOriginalContent ? full.pageContent : full.cleanedContent ?? full.pageContent;

  if (!showingOriginalContent) {
    const editContentBtn = document.createElement("button");
    editContentBtn.type = "button";
    editContentBtn.className = "icon-btn";
    editContentBtn.innerHTML = icon("edit", 13);
    editContentBtn.setAttribute("aria-label", "Edit content");
    editContentBtn.title = "Edit content";
    editContentBtn.addEventListener("click", () => {
      contentDiv.classList.add("view-hidden");
      contentEditBox.classList.remove("view-hidden");
      contentEditInput.value = shownContent;
      contentEditInput.focus();
    });
    contentHeader.appendChild(editContentBtn);
  }
  contentSection.appendChild(contentHeader);

  const contentDiv = document.createElement("div");
  contentDiv.innerHTML = await renderMarkdownSafe(shownContent || "_No content captured._");
  contentSection.appendChild(contentDiv);

  const contentEditBox = document.createElement("div");
  contentEditBox.className = "note-box view-hidden";
  const contentEditInput = document.createElement("textarea");
  contentEditInput.rows = 10;
  contentEditInput.className = "content-edit-input";
  contentEditBox.appendChild(contentEditInput);
  const contentEditActions = document.createElement("div");
  contentEditActions.className = "note-actions";
  const contentEditSave = document.createElement("button");
  contentEditSave.type = "button";
  contentEditSave.className = "secondary-btn";
  contentEditSave.textContent = "Save";
  const contentEditCancel = document.createElement("button");
  contentEditCancel.type = "button";
  contentEditCancel.className = "secondary-btn";
  contentEditCancel.textContent = "Cancel";
  const contentEditStatus = document.createElement("span");
  contentEditStatus.className = "note-status";
  contentEditActions.append(contentEditSave, contentEditCancel, contentEditStatus);
  contentEditBox.appendChild(contentEditActions);
  contentEditCancel.addEventListener("click", () => {
    contentEditBox.classList.add("view-hidden");
    contentDiv.classList.remove("view-hidden");
  });
  contentEditSave.addEventListener("click", async () => {
    contentEditSave.disabled = true;
    try {
      const updated = await updatePageContent(full.id, contentEditInput.value);
      currentDetailRecord = updated;
      await renderDetailBody(updated);
    } catch (err) {
      setNoteStatus(contentEditStatus, `Failed: ${(err as Error).message}`, true);
    } finally {
      contentEditSave.disabled = false;
    }
  });
  contentSection.appendChild(contentEditBox);
  detailBody.appendChild(contentSection);

  const transcriptSection = await renderTranscriptSection(full);
  if (transcriptSection) detailBody.appendChild(transcriptSection);

  const rawSections: Array<{ heading: string; content: string | null | undefined }> = [
    { heading: "Description", content: full.description },
    { heading: "Highlighted text", content: full.highlightText },
    { heading: "Highlight context", content: full.highlightContext }
  ];
  if (rawSections.some((s) => s.content)) {
    const details = document.createElement("details");
    details.className = "raw-data";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = "Raw data";
    details.appendChild(summaryEl);
    for (const section of rawSections) {
      if (!section.content) continue;
      const h = document.createElement("h3");
      h.textContent = section.heading;
      details.appendChild(h);
      const div = document.createElement("div");
      div.innerHTML = await renderMarkdownSafe(section.content);
      details.appendChild(div);
    }
    detailBody.appendChild(details);
  }
}

document.getElementById("backBtn")?.addEventListener("click", showListView);

openOriginalBtn.addEventListener("click", () => {
  if (currentDetailRecord) openOriginalPage(currentDetailRecord);
});

const sharePageBtn = document.getElementById("sharePageBtn") as HTMLButtonElement;
sharePageBtn?.addEventListener("click", async () => {
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  if (!currentDetailRecord) return;
  const original = sharePageBtn.innerHTML;
  sharePageBtn.disabled = true;
  sharePageBtn.textContent = "Creating link...";
  try {
    const { id } = await createPageShare(currentDetailRecord.id);
    const url = await getShareUrl(id);
    await navigator.clipboard.writeText(url);
    showToast(isLocalUrl(url) ? "Link copied, but it only works on this computer. Set a Public link URL in Settings." : "Share link copied to clipboard");
  } catch (err) {
    showToast(`Failed to create share link: ${(err as Error).message}`);
  } finally {
    sharePageBtn.disabled = false;
    sharePageBtn.innerHTML = original;
  }
});

copyMarkdownBtn.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  await navigator.clipboard.writeText(buildDetailMarkdown(currentDetailRecord));
  const original = copyMarkdownBtn.innerHTML;
  copyMarkdownBtn.innerHTML = `${icon("checkCircle")} Copied`;
  setTimeout(() => (copyMarkdownBtn.innerHTML = original), 1400);
});

contentToggleBtn.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  showingOriginalContent = !showingOriginalContent;
  await renderDetailBody(currentDetailRecord);
});

transformBtn.addEventListener("click", () => {
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  const opening = transformBox.classList.contains("view-hidden");
  if (opening) {
    transformBox.classList.remove("view-hidden");
    transformInput.focus();
  } else {
    transformBox.classList.add("view-hidden");
  }
});

recleanBtn.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  const original = recleanBtn.innerHTML;
  recleanBtn.disabled = true;
  recleanBtn.textContent = "Re-cleaning...";
  recleanStatus.classList.remove("reclean-status--failed");
  recleanStatus.classList.remove("view-hidden");
  recleanStatus.innerHTML = `<span class="save-spinner"></span> Re-cleaning...`;
  try {
    const updated = await reclean(currentDetailRecord.id);
    currentDetailRecord = updated;
    await renderDetailBody(updated);
    recleanStatus.classList.add("view-hidden");
    recleanStatus.innerHTML = "";

    // Say exactly what happened — "success" with no visible change is what made this look broken.
    const r = updated.report;
    if (updated.message) {
      showToast(updated.message);
      if (!updated.unchanged) document.querySelector(".content-section")?.classList.add("flash-updated");
    } else if (!r) {
      showToast(updated.unchanged ? "Nothing needed changing" : "Re-formatted");
    } else if (!r.configured) {
      showToast("No Cleanup AI is set, so only spacing was tidied. Choose one in Settings → AI features → Cleanup.", { label: "Settings", ms: 9000, onClick: () => document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="settings"]')?.click() });
    } else if (r.cleanedChunks === 0) {
      showToast("The AI couldn't clean this page (its answers looked wrong), so nothing changed. Try another Cleanup model, and check Settings → AI errors.", { label: "Settings", ms: 9000, onClick: () => document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="settings"]')?.click() });
    } else if (r.sameText) {
      showToast("Already clean. The AI found nothing to remove.");
    } else {
      const removed = r.before - r.after;
      const pct = r.before > 0 ? Math.round((Math.abs(removed) / r.before) * 100) : 0;
      const part = r.cleanedChunks < r.chunks ? ` · ${r.chunks - r.cleanedChunks} of ${r.chunks} blocks kept as they were` : "";
      showToast(`Cleaned: ${removed >= 0 ? "removed" : "added"} ${Math.abs(removed).toLocaleString()} characters (${pct}%)${part}`);
      document.querySelector(".content-section")?.classList.add("flash-updated"); // brief highlight so the change is noticeable
    }
  } catch (err) {
    recleanStatus.classList.add("reclean-status--failed");
    recleanStatus.textContent = `Re-clean failed: ${(err as Error).message}`;
    showToast("Re-clean failed");
  } finally {
    recleanBtn.disabled = false;
    recleanBtn.innerHTML = original;
  }
});

transformCancel.addEventListener("click", () => {
  transformBox.classList.add("view-hidden");
  transformInput.value = "";
  transformStatus.textContent = "";
  transformResult.classList.add("view-hidden");
});

transformRun.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  const instruction = transformInput.value.trim();
  if (!instruction) return;
  transformRun.disabled = true;
  transformStatus.classList.remove("note-status--error");
  transformStatus.textContent = "Running...";
  transformResult.classList.add("view-hidden");
  try {
    const { result } = await transformPage(currentDetailRecord.id, instruction);
    transformOutput.innerHTML = await renderMarkdownSafe(result);
    transformResult.classList.remove("view-hidden");
    transformStatus.textContent = "";
  } catch (err) {
    transformStatus.classList.add("note-status--error");
    transformStatus.textContent = `Failed: ${(err as Error).message}`;
  } finally {
    transformRun.disabled = false;
  }
});

transformCopy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(transformOutput.textContent ?? "");
  const original = transformCopy.innerHTML;
  transformCopy.innerHTML = `${icon("checkCircle")} Copied`;
  setTimeout(() => (transformCopy.innerHTML = original), 1400);
});

transformDismiss.addEventListener("click", () => {
  transformResult.classList.add("view-hidden");
  transformOutput.textContent = "";
});

function setNoteStatus(el: HTMLElement, text: string, isError = false) {
  el.textContent = text;
  el.classList.toggle("note-status--error", isError);
}

saveNoteBtn.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  const noteText = detailNoteInput.value.trim();
  saveNoteBtn.disabled = true;
  try {
    const updated = await updateNote(currentDetailRecord.id, noteText);
    currentDetailRecord = updated;
    setNoteStatus(noteStatusEl, "Saved");
    setTimeout(() => setNoteStatus(noteStatusEl, ""), 1500);
  } catch (err) {
    setNoteStatus(noteStatusEl, `Failed: ${(err as Error).message}`, true);
  } finally {
    saveNoteBtn.disabled = false;
  }
});

editTitleBtn?.addEventListener("click", () => {
  if (!currentDetailRecord) return;
  detailTitleInput.value = currentDetailRecord.title;
  detailTitleEdit.classList.remove("view-hidden");
  titleStatusEl.textContent = "";
  titleStatusEl.classList.remove("note-status--error");
  detailTitleInput.focus();
  detailTitleInput.select();
});

cancelTitleBtn.addEventListener("click", () => {
  detailTitleEdit.classList.add("view-hidden");
});

saveTitleBtn.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  const title = detailTitleInput.value.trim();
  if (!title) {
    setNoteStatus(titleStatusEl, "Title can't be empty", true);
    return;
  }
  saveTitleBtn.disabled = true;
  try {
    const updated = await updatePageTitle(currentDetailRecord.id, title);
    currentDetailRecord = updated;
    detailTitle.textContent = updated.title || updated.url;
    detailTitleEdit.classList.add("view-hidden");
    refreshBrowse();
  } catch (err) {
    setNoteStatus(titleStatusEl, `Failed: ${(err as Error).message}`, true);
  } finally {
    saveTitleBtn.disabled = false;
  }
});

detailTitleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveTitleBtn.click();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelTitleBtn.click();
  }
});

pinBtn.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  const id = currentDetailRecord.id;
  await setPinned(id, !currentDetailRecord.pinned);
  await showDetailView(id);
});

document.getElementById("deleteBtn")?.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  deleteWithUndo([currentDetailRecord.id], () => {
    showListView();
    refreshBrowse();
  });
});

detailNoteInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    saveNoteBtn.click();
  } else if (e.key === "Escape") {
    e.preventDefault();
    detailNoteInput.blur();
  }
});

document.getElementById("openInNewTabBtn")?.addEventListener("click", () => {
  const base = chrome.runtime.getURL("sidepanel/sidepanel.html");
  const url = currentDetailId !== null ? `${base}?id=${currentDetailId}` : base;
  chrome.tabs.create({ url });
});

// --- export ---
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;
const exportMenu = document.getElementById("exportMenu") as HTMLDivElement;
const exportMarkdownBtn = document.getElementById("exportMarkdownBtn") as HTMLButtonElement;
const exportJsonBtn = document.getElementById("exportJsonBtn") as HTMLButtonElement;

// --- popovers (add menu, filter menu, detail overflow menu, export menu) ---
const addMenuBtn = document.getElementById("addMenuBtn") as HTMLButtonElement;
const addMenu = document.getElementById("addMenu") as HTMLDivElement;
const filterMenuBtn = document.getElementById("filterMenuBtn") as HTMLButtonElement;
const filterMenu = document.getElementById("filterMenu") as HTMLDivElement;
const detailMoreBtn = document.getElementById("detailMoreBtn") as HTMLButtonElement;
const detailMoreMenu = document.getElementById("detailMoreMenu") as HTMLDivElement;

const allPopoverMenus = [exportMenu, addMenu, filterMenu, detailMoreMenu];

function closeAllPopovers() {
  for (const menu of allPopoverMenus) menu?.classList.add("view-hidden");
}

function togglePopover(menu: HTMLDivElement) {
  const opening = menu.classList.contains("view-hidden");
  closeAllPopovers();
  if (opening) menu.classList.remove("view-hidden");
}

addMenuBtn?.addEventListener("click", () => togglePopover(addMenu));
filterMenuBtn?.addEventListener("click", () => togglePopover(filterMenu));
detailMoreBtn?.addEventListener("click", () => togglePopover(detailMoreMenu));

const allPopoverTriggers = [exportBtn, addMenuBtn, filterMenuBtn, detailMoreBtn];

document.addEventListener("click", (e) => {
  const target = e.target as Node;
  const clickedInsideMenu = allPopoverMenus.some((menu) => menu?.contains(target));
  const clickedTrigger = allPopoverTriggers.some((btn) => btn?.contains(target));
  if (!clickedInsideMenu && !clickedTrigger) closeAllPopovers();
});

exportBtn?.addEventListener("click", () => {
  togglePopover(exportMenu);
});

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportVisible(format: "markdown" | "text" | "json") {
  exportMenu.classList.add("view-hidden");
  const summaries = await listPages({ q: searchInput.value.trim() });
  const records: SavedPageRecord[] = [];
  for (const s of summaries) {
    records.push(await getPage(s.id));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    downloadBlob(JSON.stringify(records, null, 2), `saveitup-export-${stamp}.json`, "application/json");
  } else if (format === "text") {
    const text = records.map((r) => markdownToPlainText(buildDetailMarkdown(r))).join("\n\n" + "-".repeat(40) + "\n\n");
    downloadBlob(text, `saveitup-export-${stamp}.txt`, "text/plain");
  } else {
    const md = records.map(buildDetailMarkdown).join("\n\n---\n\n");
    downloadBlob(md, `saveitup-export-${stamp}.md`, "text/markdown");
  }
}

exportMarkdownBtn?.addEventListener("click", () => exportVisible("markdown"));
const exportTextBtn = document.getElementById("exportTextBtn") as HTMLButtonElement;
exportTextBtn?.addEventListener("click", () => exportVisible("text"));
exportJsonBtn?.addEventListener("click", () => exportVisible("json"));

// --- per-page download (Markdown / Text / Word / PDF) ---

// Markdown is the source of truth for these exports — Text/Word/PDF are all
// derived from it rather than re-fetching/re-rendering the page separately.
function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function downloadFilenameBase(record: SavedPageRecord): string {
  return (record.title || "saveitup-page")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "saveitup-page";
}

const downloadMdBtn = document.getElementById("downloadMdBtn") as HTMLButtonElement;
const downloadTextBtn = document.getElementById("downloadTextBtn") as HTMLButtonElement;
const downloadDocBtn = document.getElementById("downloadDocBtn") as HTMLButtonElement;
const downloadPdfBtn = document.getElementById("downloadPdfBtn") as HTMLButtonElement;

downloadMdBtn?.addEventListener("click", () => {
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  if (!currentDetailRecord) return;
  const md = buildDetailMarkdown(currentDetailRecord);
  downloadBlob(md, `${downloadFilenameBase(currentDetailRecord)}.md`, "text/markdown");
});

downloadTextBtn?.addEventListener("click", () => {
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  if (!currentDetailRecord) return;
  const text = markdownToPlainText(buildDetailMarkdown(currentDetailRecord));
  downloadBlob(text, `${downloadFilenameBase(currentDetailRecord)}.txt`, "text/plain");
});

// A real .docx needs a library (OOXML is a zip of XML parts, not something to hand-roll);
// wrapping rendered HTML in a .doc file is the lazy, dependency-free version — Word and
// LibreOffice both open HTML-as-.doc for content this simple (headings/paragraphs/lists).
downloadDocBtn?.addEventListener("click", async () => {
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  if (!currentDetailRecord) return;
  const bodyHtml = await renderMarkdownSafe(buildDetailMarkdown(currentDetailRecord));
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    currentDetailRecord.title
  )}</title></head><body>${bodyHtml}</body></html>`;
  downloadBlob(doc, `${downloadFilenameBase(currentDetailRecord)}.doc`, "application/msword");
});

// No client-side PDF library — this uses the platform's own Print to PDF instead of adding
// one: open a printable tab, trigger the print dialog, the user picks "Save as PDF" there.
downloadPdfBtn?.addEventListener("click", async () => {
  document.getElementById("detailMoreMenu")?.classList.add("view-hidden");
  if (!currentDetailRecord) return;
  const bodyHtml = await renderMarkdownSafe(buildDetailMarkdown(currentDetailRecord));
  const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    currentDetailRecord.title
  )}</title><style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.5; color: #222; }
    h1, h2, h3 { line-height: 1.25; }
    pre, code { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
    pre { padding: 10px; overflow-x: auto; }
    img { max-width: 100%; }
  </style></head><body>${bodyHtml}<script>window.onload = () => window.print();</script></body></html>`;
  const blob = new Blob([printHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  chrome.tabs.create({ url });
});

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- deep link handling ---
const deepLinkId = new URLSearchParams(location.search).get("id");

loadSettings();
if (deepLinkId) {
  showDetailView(Number(deepLinkId));
} else {
  refreshBrowse();
}

// --- bookmark import ---
const importBox = document.getElementById("importBox") as HTMLDivElement;
const importStatus = document.getElementById("importStatus") as HTMLDivElement;
const importFailures = document.getElementById("importFailures") as HTMLUListElement;
const importFileInput = document.getElementById("importFileInput") as HTMLInputElement;
const importBtn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const importStart = importBtn("importStartBtn");
const importCancel = importBtn("importCancelBtn");
const importRetry = importBtn("importRetryBtn");
const importDiscard = importBtn("importDiscardBtn");
let importJob: ImportJob | null = null;
let importCancelFlag = { stop: false };
let importRunning = false;

function renderImport() {
  const j = importJob;
  importStart.classList.toggle("view-hidden", !j || importRunning || j.next >= j.items.length);
  importStart.textContent = j && j.next > 0 ? "Resume" : "Start";
  importCancel.classList.toggle("view-hidden", !importRunning);
  importRetry.classList.toggle("view-hidden", !j || importRunning || j.failed.length === 0);
  importDiscard.classList.toggle("view-hidden", !j || importRunning);
  importFailures.innerHTML = "";
  if (!j) return;
  importStatus.textContent = `${j.done + j.failed.length} / ${j.items.length} processed · ${j.done} saved · ${j.failed.length} failed · ${j.skipped} skipped (already saved/duplicate)`;
  for (const f of j.failed) {
    const li = document.createElement("li");
    li.textContent = `${f.item.url} — ${f.error}`;
    importFailures.appendChild(li);
  }
}

// Step 1: choose which bookmark folders to bring in. Step 2 (beginImport) dedupes and builds the job.
const importPicker = document.getElementById("importPicker") as HTMLDivElement;
const importPickList = document.getElementById("importPickList") as HTMLDivElement;
let importCandidates: BookmarkItem[] = [];

function showImportPicker(items: BookmarkItem[]) {
  importCandidates = items;
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.path.join(" / "), (counts.get(i.path.join(" / ")) ?? 0) + 1);
  importPickList.innerHTML = "";
  for (const [path, n] of [...counts].sort((x, y) => x[0].localeCompare(y[0]))) {
    const label = document.createElement("label");
    label.className = "import-pick-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.path = path;
    const text = document.createElement("span");
    text.textContent = `${path || "(no folder)"} · ${n}`;
    label.append(cb, text);
    importPickList.appendChild(label);
  }
  importPicker.classList.remove("view-hidden");
  importStatus.textContent = `${items.length} bookmarks found. Choose folders to import.`;
}

document.getElementById("importPickAllBtn")?.addEventListener("click", () => {
  const boxes = Array.from(importPickList.querySelectorAll<HTMLInputElement>("input"));
  const allOn = boxes.every((b) => b.checked);
  boxes.forEach((b) => (b.checked = !allOn));
});
document.getElementById("importPickGoBtn")?.addEventListener("click", () => {
  const chosen = new Set(Array.from(importPickList.querySelectorAll<HTMLInputElement>("input:checked")).map((b) => b.dataset.path));
  importPicker.classList.add("view-hidden");
  beginImport(importCandidates.filter((i) => chosen.has(i.path.join(" / "))));
});

async function beginImport(items: BookmarkItem[]) {
  importStatus.textContent = "Checking for already-saved URLs...";
  try {
    importJob = await buildJob(items);
    if (importJob.items.length === 0) importStatus.textContent = `Nothing new to import (${importJob.skipped} already saved).`;
    else
      importStatus.textContent = `${importJob.items.length} new bookmarks ready (${importJob.skipped} skipped). Each is fetched and AI-cleaned, which takes seconds each and spends AI credits. Press Start.`;
    importStart.classList.toggle("view-hidden", importJob.items.length === 0);
    importStart.textContent = "Start";
  } catch (err) {
    importStatus.textContent = `Import failed: ${(err as Error).message}`;
  }
}

document.getElementById("importBookmarksBtn")?.addEventListener("click", async () => {
  addMenu.classList.add("view-hidden");
  importBox.classList.remove("view-hidden");
  importJob ??= await loadJob();
  if (importJob) {
    renderImport();
  }
});
document.getElementById("importCloseBtn")?.addEventListener("click", () => importBox.classList.add("view-hidden"));
document.getElementById("importChromeBtn")?.addEventListener("click", async () => {
  try {
    showImportPicker(await readChromeBookmarks());
  } catch (err) {
    importStatus.textContent = `Could not read bookmarks: ${(err as Error).message}`;
  }
});
document.getElementById("importFileBtn")?.addEventListener("click", () => importFileInput.click());
importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files?.[0];
  importFileInput.value = "";
  if (file) showImportPicker(parseBookmarksHtml(await file.text()));
});
importStart.addEventListener("click", async () => {
  if (!importJob || importRunning) return;
  if (
    importJob.next === 0 &&
    !(await askConfirm({
      title: `Import ${importJob.items.length} bookmarks?`,
      message: "Each page is fetched and cleaned with your AI provider, which takes time and uses credits.",
      okText: "Start import"
    }))
  )
    return;
  importRunning = true;
  importCancelFlag = { stop: false };
  renderImport();
  try {
    await runJob(importJob, importCancelFlag, renderImport);
  } catch (err) {
    importStatus.textContent = `Import error: ${(err as Error).message}`;
  }
  importRunning = false;
  renderImport();
  refreshBrowse();
});
importCancel.addEventListener("click", () => {
  importCancelFlag.stop = true;
});
importRetry.addEventListener("click", async () => {
  if (!importJob) return;
  await retryFailed(importJob);
  renderImport();
});
importDiscard.addEventListener("click", async () => {
  await clearJob();
  importJob = null;
  importStatus.textContent = "";
  renderImport();
});

// --- library tools (export everything / embed missing) ---
const libraryToolsStatus = document.getElementById("libraryToolsStatus") as HTMLElement;
const exportAllBtn = document.getElementById("exportAllBtn") as HTMLButtonElement;
const reembedBtn = document.getElementById("reembedBtn") as HTMLButtonElement;
let reembedCancel: { stop: boolean } | null = null;

exportAllBtn.addEventListener("click", () =>
  withBusyLabel(exportAllBtn, "Exporting...", async () => {
    try {
      const { json, count } = await exportEverything((n) => (libraryToolsStatus.textContent = `Reading ${n} saves...`));
      downloadBlob(json, `saveitup-export-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
      libraryToolsStatus.textContent = `Exported ${count} saves.`;
    } catch (err) {
      libraryToolsStatus.textContent = `Export failed: ${(err as Error).message}`;
    }
  })
);

reembedBtn.addEventListener("click", async () => {
  if (reembedCancel) {
    reembedCancel.stop = true; // second click = stop
    return;
  }
  reembedCancel = { stop: false };
  reembedBtn.textContent = "Stop";
  try {
    const { done, failed } = await reembedMissing((d, f) => (libraryToolsStatus.textContent = `Embedded ${d}${f ? ` · ${f} failed` : ""}...`), reembedCancel);
    libraryToolsStatus.textContent = `Done: ${done} embedded${failed ? `, ${failed} failed` : ""}${reembedCancel.stop ? " (stopped)" : ""}.`;
  } catch (err) {
    libraryToolsStatus.textContent = `Could not embed: ${(err as Error).message}`;
  }
  reembedCancel = null;
  reembedBtn.textContent = "Embed missing pages";
});

// --- devices: tab sync, inbox, open on this device (normal / incognito) ---
const deviceSyncToggle = document.getElementById("deviceSyncToggle") as HTMLInputElement;
const deviceNameInput = document.getElementById("deviceNameInput") as HTMLInputElement;
const deviceMsg = document.getElementById("deviceMsg") as HTMLElement;
const devicesBox = document.getElementById("devicesBox") as HTMLElement;
const devicesList = document.getElementById("devicesList") as HTMLElement;
const inboxBox = document.getElementById("inboxBox") as HTMLElement;
const inboxList = document.getElementById("inboxList") as HTMLElement;
let knownDevices: DeviceRow[] = [];

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Opens urls in a normal or incognito window, asking which when `mode` isn't given. */
async function openSynced(urls: string[], mode?: "normal" | "incognito") {
  if (urls.length === 0) return;
  let chosen = mode;
  if (!chosen) {
    chosen =
      (await askChoice<"normal" | "incognito">({
        title: urls.length === 1 ? "Open this tab" : `Open ${urls.length} tabs`,
        message: "In a new window of:",
        choices: [
          { value: "normal", label: "Normal window", primary: true },
          { value: "incognito", label: "Incognito window" }
        ]
      })) ?? undefined;
    if (!chosen) return;
  }
  if (urls.length > 10 && !(await askConfirm({ title: `Open ${urls.length} tabs at once?`, okText: "Open" }))) return;
  const r = await openUrls(urls, chosen);
  if (!r.ok) showToast(r.message ?? "Couldn't open the window.");
}

function tabRow(url: string, title: string, favicon: string | null | undefined, extra?: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "dev-tab";
  const img = document.createElement("img");
  img.className = "site-favicon";
  img.alt = "";
  img.src = favicon || faviconUrl(domainOf(url));
  img.addEventListener("error", () => (img.style.visibility = "hidden"));
  const text = document.createElement("div");
  text.className = "dev-tab-text";
  const t = document.createElement("span");
  t.className = "dev-tab-title";
  t.textContent = title || url;
  const u = document.createElement("span");
  u.className = "dev-tab-url";
  u.textContent = url;
  text.append(t, u);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "dev-btn";
  open.textContent = "Open";
  open.addEventListener("click", () => openSynced([url], "normal"));
  const inc = document.createElement("button");
  inc.type = "button";
  inc.className = "dev-btn";
  inc.textContent = "Incognito";
  inc.addEventListener("click", () => openSynced([url], "incognito"));
  row.append(img, text, open, inc);
  if (extra) row.appendChild(extra);
  return row;
}

async function renderDevices() {
  try {
    deviceSyncToggle.checked = await isSyncEnabled();
    if (document.activeElement !== deviceNameInput) deviceNameInput.value = await getDeviceName();
    const me = await getDeviceId();
    const all = await listDevices();
    knownDevices = all.filter((d) => d.deviceId !== me);

    devicesBox.classList.toggle("view-hidden", knownDevices.length === 0);
    devicesList.innerHTML = "";
    for (const d of knownDevices) {
      const card = document.createElement("div");
      card.className = "dev-card";
      const head = document.createElement("div");
      head.className = "dev-head";
      head.innerHTML = `<span class="s-tile">${d.kind === "mobile" ? "Ph" : "PC"}</span><span class="s-row-text"><span class="s-row-title"></span><span class="s-row-sub"></span></span>`;
      (head.querySelector(".s-row-title") as HTMLElement).textContent = d.deviceName;
      (head.querySelector(".s-row-sub") as HTMLElement).textContent =
        d.kind === "mobile" ? `Phone · ${timeAgo(d.updatedAt)}` : `${d.tabs.length} tab${d.tabs.length === 1 ? "" : "s"} · ${timeAgo(d.updatedAt)}`;
      const body = document.createElement("div");
      body.className = "dev-body view-hidden";
      for (const t of d.tabs) body.appendChild(tabRow(t.url, t.title, t.favIconUrl));
      if (d.tabs.length > 0) {
        const foot = document.createElement("div");
        foot.className = "dev-foot";
        const openAll = document.createElement("button");
        openAll.type = "button";
        openAll.className = "secondary-btn";
        openAll.textContent = `Open all ${d.tabs.length}…`;
        openAll.addEventListener("click", () => openSynced(d.tabs.map((t) => t.url)));
        foot.appendChild(openAll);
        body.appendChild(foot);
      } else {
        const empty = document.createElement("p");
        empty.className = "s-hint";
        empty.style.padding = "8px 10px";
        empty.textContent =
          d.kind === "mobile" ? "Phones don't share their tabs. Send links to it with “Send selected tabs to…”." : "No tabs synced yet.";
        body.appendChild(empty);
      }
      head.addEventListener("click", () => body.classList.toggle("view-hidden"));
      card.append(head, body);
      devicesList.appendChild(card);
    }

    const inbox = await listInbox(all);
    inboxBox.classList.toggle("view-hidden", inbox.length === 0);
    inboxList.innerHTML = "";
    if (inbox.length > 0) {
      const card = document.createElement("div");
      card.className = "dev-card";
      for (const item of inbox) {
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "dev-btn";
        dismiss.textContent = "Dismiss";
        dismiss.addEventListener("click", async () => {
          await dismissInbox(item.id);
          renderDevices();
        });
        card.appendChild(tabRow(item.url, item.title, null, dismiss));
      }
      inboxList.appendChild(card);
    }
    deviceMsg.textContent = "";
  } catch (err) {
    deviceMsg.textContent = `Devices unavailable: ${(err as Error).message}`;
  }
}

deviceSyncToggle.addEventListener("change", async () => {
  try {
    await setSyncEnabled(deviceSyncToggle.checked);
    showToast(deviceSyncToggle.checked ? "Tab sync is on for this device" : "Tab sync off. This device's tabs were removed.");
    renderDevices();
  } catch (err) {
    deviceSyncToggle.checked = !deviceSyncToggle.checked;
    showToast(`Couldn't change tab sync: ${(err as Error).message}`);
  }
});
document.getElementById("deviceNameSave")?.addEventListener("click", async () => {
  const name = deviceNameInput.value.trim();
  if (!name) return;
  await setDeviceName(name);
  if (await isSyncEnabled()) await pushTabs().catch(() => {});
  showToast("Device name saved");
});
document.getElementById("devicesRefreshBtn")?.addEventListener("click", renderDevices);
document.getElementById("sendTabsBtn")?.addEventListener("click", async () => {
  const ids = Array.from(tabsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
    .map((c) => Number(c.dataset.tabId))
    .filter(Boolean);
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter(
    (t) => t.id !== undefined && ids.includes(t.id) && t.url && /^https?:/.test(t.url)
  );
  if (tabs.length === 0) return showToast("Tick some tabs in the list above first.");
  if (knownDevices.length === 0) return showToast("No other devices yet. Sign in on another device first.");
  const target = await askChoice<string>({
    title: `Send ${tabs.length} tab${tabs.length === 1 ? "" : "s"} to`,
    choices: [...knownDevices.map((d) => ({ value: d.deviceId, label: d.deviceName })), { value: "__all__", label: "All my devices" }]
  });
  if (!target) return;
  try {
    for (const t of tabs) await sendTab(t.url as string, t.title ?? "", target === "__all__" ? null : target);
    showToast(`Sent ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`);
  } catch (err) {
    showToast(`Couldn't send: ${(err as Error).message}`);
  }
});
document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="tabs"]')?.addEventListener("click", renderDevices);
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "saveitup-device-sync-changed") renderDevices();
});
setInterval(() => {
  if (document.getElementById("tabs-tab")?.classList.contains("active")) renderDevices();
}, 30000);

// --- encrypted sync of keys + models across devices ---
const keySyncBody = document.getElementById("keySyncBody") as HTMLElement;
const keySyncPill = document.getElementById("keySyncPill") as HTMLElement;
const keySyncSub = document.getElementById("keySyncSub") as HTMLElement;

async function renderKeySync() {
  try {
    const st = await settingsSync.status();
    const on = st.state === "on";
    keySyncPill.textContent = on ? (st.inSync ? "Synced" : "On") : "Off";
    keySyncPill.classList.toggle("on", on);
    keySyncSub.textContent = on
      ? st.cloudUpdatedAt ? `Last upload ${timeAgo(st.cloudUpdatedAt)}` : "Waiting for first upload"
      : st.cloudCopy ? "A synced copy exists. Enter your passphrase to unlock it." : "Keep your keys and models on every device";
    keySyncBody.innerHTML = on
      ? `<p class="s-hint">Your keys are encrypted with your passphrase on this device before upload, so the database only holds ciphertext.</p>
         <div class="s-actions"><button class="secondary-btn" id="ksPush">Upload now</button><button class="secondary-btn" id="ksPull">Download now</button></div>
         <div class="s-actions" style="margin-top:8px"><button class="secondary-btn" id="ksOff">Turn off</button></div>`
      : `<p class="s-hint">${st.cloudCopy ? "Enter the passphrase you chose on your other device." : "Choose a passphrase (8+ characters). You'll enter it once per device. If you forget it you'll need to re-enter your keys."}</p>
         <label>Sync passphrase<input id="ksPass" type="password" autocomplete="off" /></label>
         <button class="picker-btn s-save" id="ksOn">${st.cloudCopy ? "Unlock and download" : "Turn on sync"}</button>`;
    const act = (id: string, fn: () => Promise<void>) =>
      document.getElementById(id)?.addEventListener("click", async () => {
        try { await fn(); } catch (err) { showToast((err as Error).message); }
        await renderKeySync();
      });
    act("ksOn", async () => {
      const r = await settingsSync.enable((document.getElementById("ksPass") as HTMLInputElement).value);
      showToast(r === "pulled" ? "Keys and models downloaded" : "Keys and models uploaded");
      await loadAISettings();
    });
    act("ksPush", async () => { await settingsSync.push(); showToast("Uploaded"); });
    act("ksPull", async () => { await settingsSync.pull(); showToast("Downloaded"); await loadAISettings(); });
    act("ksOff", async () => {
      const del = await askConfirm({ title: "Turn off sync on this device?", message: "Also delete the encrypted copy from your account?", okText: "Turn off and delete copy" });
      await settingsSync.disable(del);
    });
  } catch (err) {
    keySyncSub.textContent = `Unavailable: ${(err as Error).message}`;
  }
}

/** Called after a local key/model change, and when Settings opens. Errors are shown but never block. */
async function syncKeysAfterChange() {
  try { await settingsSync.pushIfOn(); } catch (err) { showToast(`Key sync failed: ${(err as Error).message}`); }
  renderKeySync();
}
async function syncKeysOnOpen() {
  try {
    if (await settingsSync.pullIfNewer()) {
      showToast("Keys and models updated from another device");
      await loadAISettings();
    }
  } catch { /* offline or wrong passphrase: leave local settings alone */ }
  renderKeySync();
}
document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="settings"]')?.addEventListener("click", syncKeysOnOpen);
setTimeout(syncKeysOnOpen, 2500);

// --- transcript section (grouped paragraphs, timestamps on/off, copy, optional AI verify) ---
const transcriptBackups = new Map<number, string>(); // pre-polish text, so a polish can be undone this session

function youTubeIdOf(url: string): string {
  try {
    const u = new URL(url);
    return u.searchParams.get("v") || u.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1] || u.pathname.replace("/", "");
  } catch {
    return "";
  }
}

/** Saved transcripts are already grouped; older saves stored one flat string, which is grouped on the fly. */
function displayTranscript(full: SavedPageRecord): string {
  const t = full.transcript ?? "";
  if (/\]\(https:\/\/youtu\.be\//.test(t) || /^### /m.test(t)) return t;
  return groupTranscript(segmentsFromFlat(t), parseChaptersFromDescription(full.description ?? ""), youTubeIdOf(full.url));
}

async function renderTranscriptSection(full: SavedPageRecord): Promise<HTMLElement | null> {
  if (!full.transcript) return null;
  const md = displayTranscript(full);
  const stored = await chrome.storage.local.get("transcriptTimestamps");
  let showTimes: boolean = stored.transcriptTimestamps !== false; // default: timestamps on

  const details = document.createElement("details");
  details.className = "raw-data transcript-section";
  const paragraphs = md.split("\n\n").filter((p) => !p.startsWith("### ")).length;
  const minutes = Math.max(1, Math.round(md.split(/\s+/).length / 220));
  const summaryEl = document.createElement("summary");
  summaryEl.textContent = `Transcript · ${paragraphs} paragraph${paragraphs === 1 ? "" : "s"} · ~${minutes} min read`;
  details.appendChild(summaryEl);

  const bar = document.createElement("div");
  bar.className = "transcript-bar";
  const toggle = document.createElement("label");
  toggle.className = "dev-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = showTimes;
  toggle.append(cb, " Timestamps");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "dev-btn";
  copy.textContent = "Copy";
  const verify = document.createElement("button");
  verify.type = "button";
  verify.className = "dev-btn";
  verify.textContent = "Verify with AI";
  bar.append(toggle, copy, verify);
  const backup = transcriptBackups.get(full.id);
  if (backup !== undefined) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "dev-btn";
    undo.textContent = "Undo AI polish";
    undo.addEventListener("click", async () => {
      const restored = await updateTranscript(full.id, backup);
      transcriptBackups.delete(full.id);
      currentDetailRecord = restored;
      await renderDetailBody(restored);
    });
    bar.appendChild(undo);
  }
  details.appendChild(bar);

  const body = document.createElement("div");
  body.className = "transcript-body";
  const paint = async () => {
    body.innerHTML = await renderMarkdownSafe(showTimes ? md : renderPlain(md));
    body.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
  };
  await paint();
  details.appendChild(body);

  cb.addEventListener("change", async () => {
    showTimes = cb.checked;
    await chrome.storage.local.set({ transcriptTimestamps: showTimes });
    paint();
  });
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(showTimes ? md : renderPlain(md));
    showToast(showTimes ? "Transcript copied" : "Transcript copied without timestamps");
  });
  verify.addEventListener("click", async () => {
    const n = polishBlockCount(md);
    const ok = await askConfirm({
      title: "Verify transcript with AI?",
      message: `Your Cleanup AI proofreads punctuation and capitalisation in ${n} block${n === 1 ? "" : "s"} (about ${n} AI call${n === 1 ? "" : "s"}). Any block where the AI changes too many words is kept as it was. You can undo afterwards.`,
      okText: "Run"
    });
    if (!ok) return;
    verify.disabled = true;
    try {
      const { text, accepted, kept } = await polishTranscript(md, (d, t) => (verify.textContent = `Verifying ${d}/${t}...`));
      transcriptBackups.set(full.id, full.transcript ?? "");
      const updated = await updateTranscript(full.id, text);
      currentDetailRecord = updated;
      showToast(`${accepted} block${accepted === 1 ? "" : "s"} tidied, ${kept} kept unchanged`);
      await renderDetailBody(updated);
    } catch (err) {
      verify.disabled = false;
      verify.textContent = "Verify with AI";
      showToast((err as Error).message);
    }
  });
  return details;
}
