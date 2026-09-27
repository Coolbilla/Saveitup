import { saveOrQueue, listPagesByUrl, explainSelection, translateSelection, retryQueuedSaves } from "./lib/api-client";
import { domainOf, matchSiteCapture, mergeSiteCapture, type SiteCaptureResult } from "./lib/site-capture";
import { isSyncEnabled, pushTabs } from "./lib/device-sync";

const RETRY_QUEUE_ALARM = "saveitup-retry-queue";
chrome.alarms.create(RETRY_QUEUE_ALARM, { periodInMinutes: 2 });
// Tab sync (opt-in per device): push this device's open tabs every minute, and shortly after any tab change.
const DEVICE_SYNC_ALARM = "saveitup-device-sync";
chrome.alarms.create(DEVICE_SYNC_ALARM, { periodInMinutes: 1 });
let syncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleTabPush() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      if (await isSyncEnabled()) await pushTabs();
    } catch (err) {
      console.warn("[SaveItUp] tab sync failed", err);
    }
  }, 5000);
}
chrome.tabs.onCreated.addListener(scheduleTabPush);
chrome.tabs.onRemoved.addListener(scheduleTabPush);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.title || info.status === "complete") scheduleTabPush();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DEVICE_SYNC_ALARM) {
    isSyncEnabled().then((on) => (on ? pushTabs() : 0)).catch((err) => console.warn("[SaveItUp] tab sync failed", err));
    return;
  }
  if (alarm.name !== RETRY_QUEUE_ALARM) return;
  retryQueuedSaves()
    .then(({ succeeded }) => {
      if (succeeded > 0) {
        chrome.runtime.sendMessage({ type: "saveitup-queue-synced", succeeded }).catch(() => {});
      }
    })
    .catch((err) => console.error("[SaveItUp] queue retry failed", err));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "saveitup-save-page",
    title: "Save this page",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "saveitup-save-highlight",
    title: "Save with highlight",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "saveitup-pick-element",
    title: "Pick element to save",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "saveitup-take-note",
    title: "Take a note",
    contexts: ["selection"]
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-sidepanel" && tab?.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
  if (command === "save-current-page" && tab?.id && tab.url) {
    saveCurrentPage(tab.id, tab.url).catch((err) => console.error("[SaveItUp] save failed", err));
  }
});

// Plain "save this page" path (no highlight, no note) — shared by the keyboard
// shortcut and the "Save this page" context-menu item.
async function saveCurrentPage(tabId: number, url: string): Promise<void> {
  const domain = domainOf(url);
  let tempId: string | undefined;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/generic-capture.js"] });
    const [{ result: generic }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window as any).__saveItUpCaptureGeneric()
    });

    tempId = crypto.randomUUID();
    notifySaving(tempId, { title: generic.title, domain });

    let site: SiteCaptureResult | null = null;
    const siteCapture = matchSiteCapture(domain);
    if (siteCapture) {
      await chrome.scripting.executeScript({ target: { tabId }, files: [siteCapture.file] });
      const [{ result: siteResult }] = await chrome.scripting.executeScript({ target: { tabId }, func: siteCapture.func });
      site = (siteResult as SiteCaptureResult) ?? null;
    }
    const merged = mergeSiteCapture(generic, site);

    const result = await saveOrQueue({
      url: generic.url,
      title: merged.title,
      domain,
      pageContent: merged.pageContent,
      description: merged.description,
      transcript: merged.transcript,
      format: merged.format
    });
    if (result.queued) {
      notifyQueued(tempId);
    } else {
      console.log("[SaveItUp] saved", generic.url);
      notifySidepanel(result.duplicateCount, tempId, result.id);
    }
  } catch (err) {
    console.error("[SaveItUp] save failed", err);
    if (tempId) notifySaveFailed(tempId, (err as Error).message);
  }
}

function notifySidepanel(duplicateCount = 0, tempId?: string, pageId?: number) {
  chrome.runtime.sendMessage({ type: "saveitup-page-saved", duplicateCount, tempId, pageId }).catch(() => {
    // sidepanel not open; nothing to notify
  });
}

function notifySaving(tempId: string, info: { title: string; domain: string }) {
  chrome.runtime.sendMessage({ type: "saveitup-page-saving", tempId, ...info }).catch(() => {
    // sidepanel not open; nothing to notify
  });
}

function notifySaveFailed(tempId: string, error: string) {
  chrome.runtime.sendMessage({ type: "saveitup-page-save-failed", tempId, error }).catch(() => {
    // sidepanel not open; nothing to notify
  });
}

function notifyQueued(tempId: string) {
  chrome.runtime.sendMessage({ type: "saveitup-page-queued", tempId }).catch(() => {
    // sidepanel not open; nothing to notify
  });
}

async function getConfiguredApiOrigin(): Promise<string | null> {
  const { apiBase } = await chrome.storage.local.get(["apiBase"]);
  if (!apiBase) return null;
  try {
    return new URL(apiBase).origin;
  } catch {
    return null;
  }
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function activatePickerOnTab(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/picker.js"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (window as any).__saveItUpActivatePicker()
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "saveitup-picker-result" && sender.tab?.url) {
    const { title, url, markdown, elementSelector } = message.payload;
    if (!markdown || !markdown.trim()) {
      sendResponse({ ok: false, error: "no extractable text" });
      return;
    }
    const tempId = crypto.randomUUID();
    notifySaving(tempId, { title, domain: domainOf(url) });
    saveOrQueue({
      url,
      title,
      domain: domainOf(url),
      pageContent: markdown,
      elementSelector
    })
      .then((result) => {
        if (result.queued) {
          notifyQueued(tempId);
        } else {
          console.log("[SaveItUp] saved picked element", url);
          notifySidepanel(result.duplicateCount, tempId, result.id);
        }
        sendResponse({ ok: true });
      })
      .catch((err) => {
        console.error("[SaveItUp] save failed", err);
        notifySaveFailed(tempId, (err as Error).message);
        sendResponse({ ok: false, error: (err as Error).message });
      });
    return true;
  }
  if (message?.type === "saveitup-activate-picker" && message.tabId) {
    activatePickerOnTab(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[SaveItUp] picker failed", err);
        sendResponse({ ok: false, error: (err as Error).message });
      });
    return true;
  }
  if (message?.type === "saveitup-check-notes" && message.url) {
    listPagesByUrl(message.url)
      .then((matches) => sendResponse(matches))
      .catch(() => sendResponse([]));
    return true;
  }
  if (message?.type === "saveitup-explain-selection" && message.selection) {
    explainSelection(message.selection, message.pageTitle ?? "", message.surroundingContext ?? "")
      .then((result) => sendResponse({ ok: true, explanation: result.explanation }))
      .catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
    return true;
  }
  if (message?.type === "saveitup-translate-selection" && message.text) {
    translateSelection(message.text)
      .then((result) => sendResponse({ ok: true, translation: result.translation }))
      .catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
    return true;
  }
  if (message?.type === "saveitup-open-save" && message.id) {
    const base = chrome.runtime.getURL("sidepanel/sidepanel.html");
    chrome.tabs.create({ url: `${base}?id=${message.id}` }).catch((err) => {
      console.error("[SaveItUp] failed to open save tab", err);
    });
  }
  if (message?.type === "saveitup-open-tab-session" && message.sessionId && message.apiOrigin) {
    (async () => {
      // Re-verify independently of the content script's own check — a sender
      // (or a future content-script edit) is never trusted to have already
      // gated this. Only ever fetch from, and treat responses from, the
      // backend the user actually configured.
      const trustedOrigin = await getConfiguredApiOrigin();
      if (!trustedOrigin || message.apiOrigin !== trustedOrigin || sender.origin !== trustedOrigin) {
        sendResponse({ ok: false, error: "untrusted origin" });
        return;
      }
      try {
        const res = await fetch(`${trustedOrigin}/tab-sessions/${message.sessionId}`);
        const session = await res.json();
        const tabs = Array.isArray(session?.tabs) ? session.tabs : [];
        for (const tab of tabs) {
          if (isHttpUrl(tab?.url)) await chrome.tabs.create({ url: tab.url });
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: (err as Error).message });
      }
    })();
    return true;
  }
  if (message?.type === "saveitup-take-note-button" && message.tabId && message.noteText) {
    const tabId = message.tabId as number;
    const noteText = message.noteText as string;
    (async () => {
      let tempId: string | undefined;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content/generic-capture.js"]
        });
        const [{ result: generic }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => (window as any).__saveItUpCaptureGeneric()
        });
        tempId = crypto.randomUUID();
        notifySaving(tempId, { title: generic.title, domain: domainOf(generic.url) });
        const result = await saveOrQueue({
          url: generic.url,
          title: generic.title,
          domain: domainOf(generic.url),
          pageContent: generic.pageContent,
          noteText
        });
        if (result.queued) {
          notifyQueued(tempId);
        } else {
          notifySidepanel(result.duplicateCount, tempId, result.id);
        }
        sendResponse({ ok: true });
      } catch (err) {
        if (tempId) notifySaveFailed(tempId, (err as Error).message);
        sendResponse({ ok: false, error: (err as Error).message });
      }
    })();
    return true;
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;

  if (info.menuItemId === "saveitup-pick-element") {
    await activatePickerOnTab(tab.id);
    return;
  }

  if (info.menuItemId === "saveitup-save-page") {
    await saveCurrentPage(tab.id, tab.url);
    return;
  }

  const domain = domainOf(tab.url);
  let tempId: string | undefined;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/generic-capture.js"]
    });

    // Capture the highlight/selector while the user's original text selection
    // is still intact. Showing the note-input dialog below steals focus into a
    // textarea on the page, which clears window.getSelection() — capturing
    // after that point would silently pick up stray leftover selection state
    // instead of what the user actually highlighted.
    const isHighlightSave = info.menuItemId === "saveitup-save-highlight" || info.menuItemId === "saveitup-take-note";
    let highlightContext: string | null = null;
    let elementSelector: string | null = null;
    if (isHighlightSave) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (window as any).__saveItUpCaptureHighlightContext()
      });
      highlightContext = result?.context ?? null;
      elementSelector = result?.elementSelector ?? null;
    }

    let noteText: string | null = null;
    if (info.menuItemId === "saveitup-take-note") {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/note-input.js"]
      });
      const [{ result: noteResult }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (window as any).__saveItUpShowNoteInput()
      });
      if (!noteResult) return;
      noteText = noteResult;
    }

    const [{ result: generic }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window as any).__saveItUpCaptureGeneric()
    });

    tempId = crypto.randomUUID();
    notifySaving(tempId, { title: generic.title, domain });

    let site: SiteCaptureResult | null = null;
    const siteCapture = matchSiteCapture(domain);
    if (siteCapture) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [siteCapture.file] });
      const [{ result: siteResult }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: siteCapture.func
      });
      site = (siteResult as SiteCaptureResult) ?? null;
    }
    const merged = mergeSiteCapture(generic, site);

    const payload = {
      url: generic.url,
      title: merged.title,
      domain,
      pageContent: merged.pageContent,
      description: merged.description,
      transcript: merged.transcript,
      format: merged.format,
      highlightText: isHighlightSave ? info.selectionText ?? null : null,
      highlightContext,
      elementSelector,
      noteText
    };

    const result = await saveOrQueue(payload);
    if (result.queued) {
      notifyQueued(tempId);
    } else {
      console.log("[SaveItUp] saved", payload.url);
      notifySidepanel(result.duplicateCount, tempId, result.id);
    }
  } catch (err) {
    console.error("[SaveItUp] save failed", err);
    if (typeof tempId === "string") notifySaveFailed(tempId, (err as Error).message);
  }
});
