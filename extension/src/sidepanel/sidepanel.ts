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
  transformPage,
  extractUrlToMarkdown,
  chatMessage,
  getAIConfig,
  updateAIConfig,
  listAIErrors,
  clearAIErrors
} from "../lib/api-client";
import type { SavedPageRecord, SavedPageSummary, ChatMessage, AIRole } from "../../../shared/src/types";
import { getCaptureType, captureTypeLabel, captureTypeBadgeClass } from "../lib/capture-type";
import { resolveEmbed } from "../lib/embeds";
import { icon } from "../lib/icons";
import { domainOf, matchSiteCapture } from "../lib/site-capture";
import { marked } from "marked";
import { createClerkClient } from "@clerk/chrome-extension/client";
import { getAuthToken } from "../lib/auth";
import { sanitizeHtml } from "../lib/markdown";

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
const clerk = createClerkClient({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY as string });

const signedOutView = document.getElementById("signed-out-view") as HTMLElement;
const accountEmailEl = document.getElementById("accountEmail") as HTMLElement;

function updateAuthUI() {
  const signedIn = !!clerk.session;
  signedOutView.classList.toggle("view-hidden", signedIn);
  document.body.classList.toggle("signed-out", !signedIn);
  if (signedIn) {
    accountEmailEl.textContent = clerk.user?.primaryEmailAddress?.emailAddress ?? "";
    refreshBrowse();
  }
}

document.getElementById("signInBtn")?.addEventListener("click", () => {
  clerk.openSignIn({});
});

document.getElementById("signOutBtn")?.addEventListener("click", async () => {
  await clerk.signOut();
});

clerk.addListener(() => updateAuthUI());
clerk.load().then(() => updateAuthUI());

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
  chrome.runtime.sendMessage({ type: "saveitup-activate-picker", tabId: tab.id });
});

const toastEl = document.getElementById("toast") as HTMLDivElement;
let toastTimer: number | undefined;

function showToast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.remove("view-hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add("view-hidden"), 2600);
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
    if (count && count > 0) {
      showToast(`Saved — you've now saved this page ${count + 1}×`);
    }
  }
  if (message?.type === "saveitup-page-save-failed") {
    pendingSaves.delete(message.tempId);
    refreshBrowse();
    showToast(`Save failed: ${message.error}`);
  }
});

// --- chat ---
const chatMessages = document.getElementById("chatMessages") as HTMLDivElement;
const chatInput = document.getElementById("chatInput") as HTMLTextAreaElement;
const chatSendBtn = document.getElementById("chatSendBtn") as HTMLButtonElement;
const chatIncludeCurrentTab = document.getElementById("chatIncludeCurrentTab") as HTMLInputElement;

const chatHistory: ChatMessage[] = [];

async function renderChatMessages() {
  chatMessages.innerHTML = "";
  for (const msg of chatHistory) {
    const row = document.createElement("div");
    row.className = `chat-message chat-message-${msg.role}`;
    if (msg.role === "assistant") {
      row.innerHTML = await renderMarkdownSafe(msg.content);
    } else {
      row.textContent = msg.content;
    }
    chatMessages.appendChild(row);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendChatSources(sourceIds: number[]) {
  if (sourceIds.length === 0) return;
  const row = document.createElement("div");
  row.className = "chat-sources-row";
  for (const id of sourceIds) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chat-source-chip";
    chip.textContent = `#${id}`;
    chip.addEventListener("click", () => showDetailView(id));
    row.appendChild(chip);
  }
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
    const siteCapture = matchSiteCapture(domainOf(tab.url));
    if (siteCapture) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [siteCapture.file] });
        const [{ result: siteResult }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: siteCapture.func
        });
        if (siteResult?.transcript) extra += `\n\nTranscript:\n${siteResult.transcript}`;
        if (siteResult?.description) extra += `\n\nDescription:\n${siteResult.description}`;
      } catch {
        // site-specific capture is best-effort; fall back to generic content alone
      }
    }

    return {
      title: result.title ?? tab.title ?? "",
      url: result.url ?? tab.url,
      content: (result.pageContent ?? "") + extra
    };
  } catch {
    return null;
  }
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  chatSendBtn.disabled = true;

  chatHistory.push({ role: "user", content: text });
  await renderChatMessages();

  try {
    const currentPage = chatIncludeCurrentTab.checked ? await captureCurrentTabContent() : null;
    const { reply, sourceIds } = await chatMessage(text, chatHistory.slice(0, -1), currentPage);
    chatHistory.push({ role: "assistant", content: reply });
    await renderChatMessages();
    appendChatSources(sourceIds);
  } catch (err) {
    showToast(`Chat failed: ${(err as Error).message}`);
  } finally {
    chatSendBtn.disabled = false;
  }
}

chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

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
    noteComposerStatus.textContent = "No active tab.";
    return;
  }
  noteComposerSave.disabled = true;
  noteComposerStatus.textContent = "Saving...";
  chrome.runtime.sendMessage(
    { type: "saveitup-take-note-button", tabId: tab.id, noteText },
    (response) => {
      noteComposerSave.disabled = false;
      if (response?.ok) {
        closeNoteComposer();
      } else {
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
    const shareUrl = `${settings?.apiBase ?? ""}/open/${id}`;
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
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const testConnectionBtn = document.getElementById("testConnection") as HTMLButtonElement;

async function loadSettings() {
  const stored = await chrome.storage.local.get(["apiBase", "groupMode"]);
  if (stored.apiBase) apiBaseInput.value = stored.apiBase;
  if (stored.groupMode) groupModeSelect.value = stored.groupMode;
}

function setStatus(text: string, kind: "success" | "error" | "" = "") {
  statusEl.textContent = text;
  statusEl.className = kind ? `status-${kind}` : "";
}

document.getElementById("saveSettings")?.addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiBase: apiBaseInput.value.trim()
  });
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

// --- AI role settings ---
const roleDisclosures = document.querySelectorAll<HTMLDetailsElement>("#aiRoleSettings .settings-disclosure[data-role]");

async function loadAISettings() {
  try {
    const config = await getAIConfig();
    roleDisclosures.forEach((details) => {
      const role = details.dataset.role as AIRole;
      const providerSelect = details.querySelector(".role-provider") as HTMLSelectElement;
      const modelInput = details.querySelector(".role-model") as HTMLInputElement;
      const hint = details.querySelector(".role-hint") as HTMLParagraphElement;

      providerSelect.innerHTML = "";
      const noneOption = document.createElement("option");
      noneOption.value = "";
      noneOption.textContent = "(use env default)";
      providerSelect.appendChild(noneOption);
      for (const p of config.knownProviders) {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        providerSelect.appendChild(opt);
      }

      const saved = config.roles[role];
      const pair = saved?.chain[0];
      providerSelect.value = pair?.provider ?? "";
      modelInput.value = pair?.model ?? "";
      hint.textContent = `Currently using env default: ${config.envDefaults[role]}`;
    });
  } catch (err) {
    console.error("[saveitup] failed to load AI settings", err);
  }
}

roleDisclosures.forEach((details) => {
  const role = details.dataset.role as AIRole;
  const saveBtn = details.querySelector(".role-save") as HTMLButtonElement;
  saveBtn.addEventListener("click", async () => {
    const providerSelect = details.querySelector(".role-provider") as HTMLSelectElement;
    const modelInput = details.querySelector(".role-model") as HTMLInputElement;
    const provider = providerSelect.value.trim();
    const model = modelInput.value.trim();
    try {
      const chain = provider ? [{ provider, model }] : [];
      await updateAIConfig(role, chain);
      showToast(`Saved ${role} AI settings`);
      await loadAISettings();
    } catch (err) {
      showToast(`Failed to save: ${(err as Error).message}`);
    }
  });
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

let searchDebounce: number | undefined;
searchInput.addEventListener("input", () => {
  clearSearchBtn.classList.toggle("view-hidden", !searchInput.value);
  clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(refreshBrowse, 300);
});
clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.add("view-hidden");
  refreshBrowse();
  searchInput.focus();
});
groupModeSelect.addEventListener("change", () => {
  chrome.storage.local.set({ groupMode: groupModeSelect.value });
  refreshBrowse();
});

async function loadFolderOptions(selectEl: HTMLSelectElement, placeholder: string) {
  try {
    const folders = await listFolders();
    const current = selectEl.value;
    selectEl.innerHTML = `<option value="">${placeholder}</option>`;
    for (const folder of folders) {
      const opt = document.createElement("option");
      opt.value = String(folder.id);
      opt.textContent = folder.name;
      selectEl.appendChild(opt);
    }
    selectEl.value = current;
  } catch {
    // backend not reachable; leave folder filter as-is
  }
}

folderActionsSelect?.addEventListener("change", async () => {
  if (folderActionsSelect.value !== "__new__") return;
  folderActionsSelect.value = "";
  const name = prompt("New folder name:")?.trim();
  if (!name) return;
  try {
    await createFolder(name);
    showToast(`Created folder "${name}"`);
    refreshBrowse();
  } catch (err) {
    showToast(`Failed to create folder: ${(err as Error).message}`);
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
  for (const folder of folders) {
    const option = document.createElement("option");
    option.value = String(folder.id);
    option.textContent = folder.name;
    select.appendChild(option);
  }

  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "+ New folder...";
  select.appendChild(newOption);

  select.value = folderId !== null ? String(folderId) : "";

  select.addEventListener("change", async () => {
    if (select.value === "__new__") {
      const name = prompt("New folder name:")?.trim();
      select.value = folderId !== null ? String(folderId) : "";
      if (!name) return;
      const folder = await createFolder(name);
      onChange(folder.id);
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
    const key = page.folderName ?? "Unfiled";
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
  if (!confirm(`Delete ${selectedIds.size} save(s)? This can't be undone.`)) return;
  bulkDeleteBtn.disabled = true;
  try {
    for (const id of selectedIds) {
      await deletePage(id);
    }
    exitSelectMode();
  } finally {
    bulkDeleteBtn.disabled = false;
  }
});

function renderRow(page: SavedPageSummary, opts: { showTitle: boolean; compact?: boolean }): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "sub-row";
  row.dataset.pageId = String(page.id);

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
      if (!confirm("Delete this save? This can't be undone.")) return;
      await deletePage(page.id);
      refreshBrowse();
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

  row.addEventListener("click", () => {
    if (selectMode) {
      const checkbox = row.querySelector<HTMLInputElement>(".sub-row-checkbox");
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      }
    } else {
      showDetailView(page.id);
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

async function refreshBrowse() {
  const token = ++listLoadToken;
  listEl.classList.add("loading");
  try {
    const pages = await listPages({
      q: searchInput.value.trim()
    });
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
const tabBar = document.querySelector(".tabs") as HTMLDivElement;

let currentDetailId: number | null = null;
let currentDetailRecord: SavedPageRecord | null = null;
let showingOriginalContent = false;

function showListView() {
  detailView.classList.add("view-hidden");
  tabBar.classList.remove("view-hidden");
  const activeTabBtn = document.querySelector<HTMLButtonElement>(".tab-btn.active");
  const targetId = activeTabBtn?.dataset.tab === "settings" ? "settings-tab" : "browse-tab";
  if (targetId === "settings-tab") settingsTab.classList.add("active");
  else browseTab.classList.add("active");
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
  tabBar.classList.add("view-hidden");
  browseTab.classList.remove("active");
  settingsTab.classList.remove("active");
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
  pinBtn.innerHTML = `<span class="icon-slot">${icon("star", 14)}</span> ${full.pinned ? "Pinned" : "Pin"}`;

  detailTitle.textContent = full.title || full.url;
  detailMeta.textContent = `${full.domain} · ${new Date(full.createdAt).toLocaleString()}`;
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
      errEl.className = "note-status";
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
    p.className = "note-status";
    p.textContent = "No summary yet.";
    summarySection.appendChild(p);
  }
  detailBody.appendChild(summarySection);

  const hasCleaned = !!full.cleanedContent && full.cleanedContent !== full.pageContent;
  contentToggleBtn.style.display = hasCleaned ? "" : "none";
  contentToggleBtn.innerHTML = `<span class="icon-slot">${icon("note", 14)}</span> ${
    showingOriginalContent ? "Cleaned" : "Original"
  }`;

  const contentSection = document.createElement("div");
  contentSection.className = "content-section";
  const contentHeading = document.createElement("h3");
  contentHeading.textContent = "Page content";
  contentSection.appendChild(contentHeading);
  const contentDiv = document.createElement("div");
  const shownContent = showingOriginalContent ? full.pageContent : full.cleanedContent ?? full.pageContent;
  contentDiv.innerHTML = await renderMarkdownSafe(shownContent || "_No content captured._");
  contentSection.appendChild(contentDiv);
  detailBody.appendChild(contentSection);

  const rawSections: Array<{ heading: string; content: string | null | undefined }> = [
    { heading: "Description", content: full.description },
    { heading: "Transcript", content: full.transcript },
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
    if (updated.unchanged) {
      showToast("Re-clean ran but the AI result looked off, so the original content was kept");
    } else {
      showToast("Re-cleaned successfully");
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
  transformStatus.textContent = "Running...";
  transformResult.classList.add("view-hidden");
  try {
    const { result } = await transformPage(currentDetailRecord.id, instruction);
    transformOutput.innerHTML = await renderMarkdownSafe(result);
    transformResult.classList.remove("view-hidden");
    transformStatus.textContent = "";
  } catch (err) {
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

saveNoteBtn.addEventListener("click", async () => {
  if (!currentDetailRecord) return;
  const noteText = detailNoteInput.value.trim();
  saveNoteBtn.disabled = true;
  try {
    const updated = await updateNote(currentDetailRecord.id, noteText);
    currentDetailRecord = updated;
    noteStatusEl.textContent = "Saved";
    setTimeout(() => (noteStatusEl.textContent = ""), 1500);
  } catch (err) {
    noteStatusEl.textContent = `Failed: ${(err as Error).message}`;
  } finally {
    saveNoteBtn.disabled = false;
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
  if (!confirm("Delete this save? This can't be undone.")) return;
  await deletePage(currentDetailRecord.id);
  showListView();
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

async function exportVisible(format: "markdown" | "json") {
  exportMenu.classList.add("view-hidden");
  const summaries = await listPages({ q: searchInput.value.trim() });
  const records: SavedPageRecord[] = [];
  for (const s of summaries) {
    records.push(await getPage(s.id));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    downloadBlob(JSON.stringify(records, null, 2), `saveitup-export-${stamp}.json`, "application/json");
  } else {
    const md = records.map(buildDetailMarkdown).join("\n\n---\n\n");
    downloadBlob(md, `saveitup-export-${stamp}.md`, "text/markdown");
  }
}

exportMarkdownBtn?.addEventListener("click", () => exportVisible("markdown"));
exportJsonBtn?.addEventListener("click", () => exportVisible("json"));

// --- deep link handling ---
const deepLinkId = new URLSearchParams(location.search).get("id");

loadSettings();
if (deepLinkId) {
  showDetailView(Number(deepLinkId));
} else {
  refreshBrowse();
}
