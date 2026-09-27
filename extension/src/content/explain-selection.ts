import { elementToMarkdown } from "../lib/markdown";
import { popupColors } from "./popup-theme";

const MIN_SELECTION_CHARS = 3;
const MAX_SELECTION_CHARS = 300;
const DEBOUNCE_MS = 400;
const REQUEST_TIMEOUT_MS = 30000;

let debounceTimer: number | undefined;
let lastSelectionText: string | null = null;
let popup: HTMLDivElement | null = null;
let requestId = 0;
let currentSelectionText = "";
let translateRequestId = 0;

function removePopup() {
  popup?.remove();
  popup = null;
  document.removeEventListener("keydown", onPopupKeyDown, true);
}

function onPopupKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") removePopup();
}

function createPopup(): HTMLDivElement {
  removePopup();
  const colors = popupColors();
  const card = document.createElement("div");
  card.style.position = "fixed";
  card.style.zIndex = "2147483647";
  card.style.bottom = "16px";
  card.style.right = "16px";
  card.style.width = "280px";
  card.style.maxHeight = "200px";
  card.style.overflowY = "auto";
  card.style.background = colors.bg;
  card.style.color = colors.text;
  card.style.border = `1px solid ${colors.border}`;
  card.style.borderRadius = "10px";
  card.style.boxShadow = colors.shadow;
  card.style.padding = "10px 12px";
  card.style.fontFamily = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";
  card.style.fontSize = "12.5px";
  card.style.lineHeight = "1.45";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.position = "absolute";
  closeBtn.style.top = "6px";
  closeBtn.style.right = "8px";
  closeBtn.style.border = "none";
  closeBtn.style.background = "transparent";
  closeBtn.style.color = colors.muted;
  closeBtn.style.fontSize = "16px";
  closeBtn.style.cursor = "pointer";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", removePopup);
  card.appendChild(closeBtn);

  const labelRow = document.createElement("div");
  labelRow.style.display = "flex";
  labelRow.style.alignItems = "center";
  labelRow.style.justifyContent = "space-between";
  labelRow.style.marginBottom = "6px";
  labelRow.style.paddingRight = "16px";

  const label = document.createElement("div");
  label.textContent = "EXPLAIN";
  label.style.fontSize = "10.5px";
  label.style.fontWeight = "700";
  label.style.color = colors.muted;
  label.style.textTransform = "uppercase";
  label.style.letterSpacing = "0.4px";
  labelRow.appendChild(label);

  const translateBtn = document.createElement("button");
  translateBtn.textContent = "Translate";
  translateBtn.className = "saveitup-explain-translate-btn";
  translateBtn.style.border = `1px solid ${colors.border}`;
  translateBtn.style.background = "transparent";
  translateBtn.style.color = colors.muted;
  translateBtn.style.fontSize = "10.5px";
  translateBtn.style.borderRadius = "5px";
  translateBtn.style.padding = "2px 7px";
  translateBtn.style.cursor = "pointer";
  translateBtn.addEventListener("click", translateCurrentSelection);
  labelRow.appendChild(translateBtn);

  card.appendChild(labelRow);

  const body = document.createElement("div");
  body.className = "saveitup-explain-body";
  body.textContent = "Explaining...";
  card.appendChild(body);

  const translationBody = document.createElement("div");
  translationBody.className = "saveitup-explain-translation";
  translationBody.style.marginTop = "8px";
  translationBody.style.paddingTop = "8px";
  translationBody.style.borderTop = `1px solid ${colors.border}`;
  translationBody.style.display = "none";
  card.appendChild(translationBody);

  document.body.appendChild(card);
  popup = card;
  document.addEventListener("keydown", onPopupKeyDown, true);
  return card;
}

function translateCurrentSelection() {
  if (!popup || !currentSelectionText) return;
  const translationBody = popup.querySelector(".saveitup-explain-translation") as HTMLDivElement | null;
  if (!translationBody) return;

  translationBody.style.display = "block";
  translationBody.textContent = "Translating...";
  const myTranslateId = ++translateRequestId;

  chrome.runtime.sendMessage(
    { type: "saveitup-translate-selection", text: currentSelectionText },
    (response) => {
      if (myTranslateId !== translateRequestId || !popup) return;
      const body = popup.querySelector(".saveitup-explain-translation") as HTMLDivElement | null;
      if (!body) return;
      if (response?.ok) {
        body.textContent = response.translation;
      } else {
        body.textContent = `Couldn't translate: ${response?.error ?? "unknown error"}`;
      }
    }
  );
}

function setPopupText(text: string) {
  const body = popup?.querySelector(".saveitup-explain-body");
  if (body) body.textContent = text;
}

function gatherSurroundingContext(range: Range): string {
  const anchor = range.commonAncestorContainer;
  const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
  if (!el) return "";
  const container = el.closest("p, article, section, div") ?? el;
  try {
    return elementToMarkdown(container).slice(0, 2000);
  } catch {
    return container.textContent?.slice(0, 2000) ?? "";
  }
}

function handleSelectionSettled() {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";

  if (!text || text.length < MIN_SELECTION_CHARS || text.length > MAX_SELECTION_CHARS) {
    return;
  }
  if (text === lastSelectionText) return;
  lastSelectionText = text;
  currentSelectionText = text;

  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const surroundingContext = gatherSurroundingContext(range);

  createPopup();
  translateRequestId++;
  const myRequestId = ++requestId;
  let settled = false;

  const timeoutTimer = window.setTimeout(() => {
    if (settled || myRequestId !== requestId || !popup) return;
    settled = true;
    setPopupText("Explanation timed out — the AI provider may be slow or unconfigured.");
  }, REQUEST_TIMEOUT_MS);

  chrome.runtime.sendMessage(
    {
      type: "saveitup-explain-selection",
      selection: text,
      pageTitle: document.title,
      surroundingContext
    },
    (response) => {
      if (settled || myRequestId !== requestId) return;
      settled = true;
      window.clearTimeout(timeoutTimer);
      if (!popup) return;
      if (response?.ok) {
        setPopupText(response.explanation);
      } else {
        setPopupText(`Couldn't explain selection: ${response?.error ?? "unknown error"}`);
      }
    }
  );
}

document.addEventListener("selectionchange", () => {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(handleSelectionSettled, DEBOUNCE_MS);
});
