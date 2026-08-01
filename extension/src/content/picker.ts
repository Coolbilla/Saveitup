import { elementToMarkdown } from "../lib/markdown";
import { buildSelector } from "../lib/selector";

function showToast(text: string, color: string) {
  const toast = document.createElement("div");
  toast.textContent = text;
  toast.style.position = "fixed";
  toast.style.bottom = "24px";
  toast.style.left = "50%";
  toast.style.transform = "translateX(-50%)";
  toast.style.zIndex = "2147483647";
  toast.style.background = color;
  toast.style.color = "#fff";
  toast.style.padding = "8px 16px";
  toast.style.borderRadius = "6px";
  toast.style.fontFamily = "sans-serif";
  toast.style.fontSize = "13px";
  toast.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

function activatePicker() {
  if ((window as any).__saveItUpPickerActive) return;
  (window as any).__saveItUpPickerActive = true;

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483647";
  overlay.style.border = "2px solid #2563eb";
  overlay.style.background = "rgba(37, 99, 235, 0.1)";
  overlay.style.transition = "all 60ms ease-out";
  overlay.style.display = "none";
  document.body.appendChild(overlay);

  let hovered: Element | null = null;

  function updateOverlay(el: Element, color = "#2563eb") {
    const rect = el.getBoundingClientRect();
    overlay.style.borderColor = color;
    overlay.style.background = color === "#2563eb" ? "rgba(37, 99, 235, 0.1)" : "rgba(220, 38, 38, 0.1)";
    overlay.style.display = "block";
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function onMouseMove(e: MouseEvent) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay) return;
    hovered = el;
    updateOverlay(el);
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    (window as any).__saveItUpPickerActive = false;
  }

  function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!hovered) return;
    const markdown = elementToMarkdown(hovered).slice(0, 50_000);

    if (!markdown.trim()) {
      updateOverlay(hovered, "#dc2626");
      showToast("No text in that element — try another", "#dc2626");
      return;
    }

    const elementSelector = buildSelector(hovered);
    cleanup();
    showToast("Saving...", "#2563eb");
    chrome.runtime.sendMessage(
      {
        type: "saveitup-picker-result",
        payload: { title: document.title, url: location.href, markdown, elementSelector }
      },
      (response) => {
        if (response?.ok) {
          showToast("Saved to SaveItUp", "#16a34a");
        } else {
          showToast(`Save failed: ${response?.error ?? "unknown error"}`, "#dc2626");
        }
      }
    );
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      cleanup();
      showToast("Picker cancelled", "#6b7280");
    }
  }

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
}

(window as any).__saveItUpActivatePicker = activatePicker;
