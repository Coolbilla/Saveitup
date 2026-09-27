import { findElementContainingText } from "../lib/text-search";
import { popupColors } from "./popup-theme";

interface NoteMatch {
  id: number;
  noteText: string;
  elementSelector: string;
  highlightText: string | null;
}

function reposition(badge: HTMLDivElement, el: Element) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    badge.style.display = "none";
    return;
  }
  badge.style.display = "flex";
  badge.style.top = `${Math.max(rect.top - 8, 4)}px`;
  badge.style.left = `${Math.min(rect.right - 8, window.innerWidth - 26)}px`;
}

function showPopover(anchor: HTMLElement, match: NoteMatch) {
  document.querySelectorAll("[data-saveitup-popover]").forEach((p) => p.remove());

  const colors = popupColors();
  const rect = anchor.getBoundingClientRect();
  const card = document.createElement("div");
  card.dataset.saveitupPopover = "true";
  card.style.position = "fixed";
  card.style.zIndex = "2147483647";
  card.style.width = "260px";
  card.style.background = colors.bg;
  card.style.border = `1px solid ${colors.border}`;
  card.style.borderRadius = "10px";
  card.style.boxShadow = colors.shadow;
  card.style.padding = "10px";
  card.style.fontFamily = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";

  const top = Math.min(rect.bottom + 8, window.innerHeight - 160);
  const left = Math.min(Math.max(rect.left - 220, 8), window.innerWidth - 276);
  card.style.top = `${Math.max(top, 8)}px`;
  card.style.left = `${left}px`;

  const label = document.createElement("div");
  label.textContent = "Note";
  label.style.fontSize = "11px";
  label.style.fontWeight = "700";
  label.style.color = colors.muted;
  label.style.textTransform = "uppercase";
  label.style.letterSpacing = "0.4px";
  label.style.marginBottom = "6px";
  card.appendChild(label);

  const text = document.createElement("div");
  text.textContent = match.noteText;
  text.style.fontSize = "13px";
  text.style.color = colors.text;
  text.style.whiteSpace = "pre-wrap";
  text.style.maxHeight = "140px";
  text.style.overflowY = "auto";
  card.appendChild(text);

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.justifyContent = "space-between";
  row.style.alignItems = "center";
  row.style.marginTop = "8px";

  const openLink = document.createElement("a");
  openLink.textContent = "Open in SaveItUp →";
  openLink.href = "#";
  openLink.style.fontSize = "12px";
  openLink.style.fontWeight = "600";
  openLink.style.color = colors.accent;
  openLink.style.textDecoration = "none";
  openLink.style.cursor = "pointer";
  openLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "saveitup-open-save", id: match.id });
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.border = "none";
  closeBtn.style.background = "transparent";
  closeBtn.style.color = colors.muted;
  closeBtn.style.cursor = "pointer";
  closeBtn.style.fontSize = "13px";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => card.remove());

  row.appendChild(openLink);
  row.appendChild(closeBtn);
  card.appendChild(row);
  document.body.appendChild(card);

  function onDocClick(e: MouseEvent) {
    if (!card.contains(e.target as Node)) {
      card.remove();
      document.removeEventListener("click", onDocClick, true);
    }
  }
  setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
}

function injectBadge(el: Element, match: NoteMatch) {
  if (document.querySelector(`[data-saveitup-badge="${match.id}"]`)) return;

  const colors = popupColors();
  const badge = document.createElement("div");
  badge.dataset.saveitupBadge = String(match.id);
  badge.style.position = "fixed";
  badge.style.zIndex = "2147483647";
  badge.style.width = "22px";
  badge.style.height = "22px";
  badge.style.borderRadius = "50%";
  badge.style.background = colors.accent;
  badge.style.color = colors.accentText;
  badge.style.display = "flex";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.fontSize = "12px";
  badge.style.cursor = "pointer";
  badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";
  badge.title = "SaveItUp note";
  badge.textContent = "📝";
  document.body.appendChild(badge);

  reposition(badge, el);

  let ticking = false;
  const onScrollOrResize = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      reposition(badge, el);
      ticking = false;
    });
  };
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    showPopover(badge, match);
  });
}

chrome.runtime.sendMessage({ type: "saveitup-check-notes", url: location.href }, (matches: NoteMatch[]) => {
  if (!Array.isArray(matches)) return;
  for (const match of matches) {
    // Prefer locating the element by its actual saved text — the CSS selector
    // (an nth-of-type path) can resolve to a totally different element on
    // SPA-heavy pages that re-render their DOM between visits (e.g. YouTube).
    let el: Element | null = null;
    if (match.highlightText) {
      el = findElementContainingText(match.highlightText);
    }
    if (!el && match.elementSelector) {
      try {
        el = document.querySelector(match.elementSelector);
      } catch {
        // stale/invalid selector from a page that's since changed structure
      }
    }
    if (el) injectBadge(el, match);
  }
});
