import { savePage, listPagesByUrl, explainSelection, translateSelection } from "./lib/api-client";
import { domainOf, matchSiteCapture } from "./lib/site-capture";

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
});

function notifySidepanel(duplicateCount = 0, tempId?: string) {
  chrome.runtime.sendMessage({ type: "saveitup-page-saved", duplicateCount, tempId }).catch(() => {
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
    savePage({
      url,
      title,
      domain: domainOf(url),
      pageContent: markdown,
      elementSelector
    })
      .then(({ duplicateCount }) => {
        console.log("[SaveItUp] saved picked element", url);
        notifySidepanel(duplicateCount, tempId);
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
    activatePickerOnTab(message.tabId).catch((err) => console.error("[SaveItUp] picker failed", err));
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
    chrome.tabs.create({ url: `${base}?id=${message.id}` });
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
        const { duplicateCount } = await savePage({
          url: generic.url,
          title: generic.title,
          domain: domainOf(generic.url),
          pageContent: generic.pageContent,
          noteText
        });
        notifySidepanel(duplicateCount, tempId);
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

    let description: string | null = null;
    let transcript: string | null = null;
    const siteCapture = matchSiteCapture(domain);
    if (siteCapture) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [siteCapture.file] });
      const [{ result: siteResult }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: siteCapture.func
      });
      description = siteResult?.description ?? null;
      transcript = siteResult?.transcript ?? null;
    }

    const payload = {
      url: generic.url,
      title: generic.title,
      domain,
      pageContent: generic.pageContent,
      description,
      transcript,
      highlightText: isHighlightSave ? info.selectionText ?? null : null,
      highlightContext,
      elementSelector,
      noteText
    };

    const { duplicateCount } = await savePage(payload);
    console.log("[SaveItUp] saved", payload.url);
    notifySidepanel(duplicateCount, tempId);
  } catch (err) {
    console.error("[SaveItUp] save failed", err);
    if (typeof tempId === "string") notifySaveFailed(tempId, (err as Error).message);
  }
});
