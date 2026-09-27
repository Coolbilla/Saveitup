import { popupColors } from "./popup-theme";

function showNoteInput(): Promise<string | null> {
  return new Promise((resolve) => {
    const colors = popupColors();
    let anchorRect: DOMRect | null = null;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) anchorRect = rect;
    }

    const card = document.createElement("div");
    card.style.position = "fixed";
    card.style.zIndex = "2147483647";
    card.style.width = "280px";
    card.style.background = colors.bg;
    card.style.border = `1px solid ${colors.border}`;
    card.style.borderRadius = "10px";
    card.style.boxShadow = colors.shadow;
    card.style.padding = "10px";
    card.style.fontFamily = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";

    if (anchorRect) {
      const top = Math.min(anchorRect.bottom + 8, window.innerHeight - 160);
      const left = Math.min(Math.max(anchorRect.left, 8), window.innerWidth - 296);
      card.style.top = `${Math.max(top, 8)}px`;
      card.style.left = `${left}px`;
    } else {
      card.style.top = "50%";
      card.style.left = "50%";
      card.style.transform = "translate(-50%, -50%)";
    }

    const label = document.createElement("div");
    label.textContent = "Note";
    label.style.fontSize = "11px";
    label.style.fontWeight = "700";
    label.style.color = colors.muted;
    label.style.textTransform = "uppercase";
    label.style.letterSpacing = "0.4px";
    label.style.marginBottom = "6px";
    card.appendChild(label);

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Type your note...";
    textarea.rows = 3;
    textarea.style.width = "100%";
    textarea.style.boxSizing = "border-box";
    textarea.style.resize = "vertical";
    textarea.style.fontSize = "13px";
    textarea.style.fontFamily = "inherit";
    textarea.style.padding = "6px 8px";
    textarea.style.background = colors.inputBg;
    textarea.style.color = colors.text;
    textarea.style.border = `1px solid ${colors.inputBorder}`;
    textarea.style.borderRadius = "6px";
    textarea.style.outline = "none";
    card.appendChild(textarea);

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "flex-end";
    row.style.gap = "6px";
    row.style.marginTop = "8px";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.border = `1px solid ${colors.border}`;
    cancelBtn.style.background = "transparent";
    cancelBtn.style.color = colors.muted;
    cancelBtn.style.fontSize = "12px";
    cancelBtn.style.fontWeight = "600";
    cancelBtn.style.padding = "6px 12px";
    cancelBtn.style.borderRadius = "6px";
    cancelBtn.style.cursor = "pointer";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.border = "none";
    saveBtn.style.background = colors.accent;
    saveBtn.style.color = colors.accentText;
    saveBtn.style.fontSize = "12px";
    saveBtn.style.fontWeight = "600";
    saveBtn.style.padding = "6px 12px";
    saveBtn.style.borderRadius = "6px";
    saveBtn.style.cursor = "pointer";

    row.appendChild(cancelBtn);
    row.appendChild(saveBtn);
    card.appendChild(row);
    document.body.appendChild(card);
    textarea.focus();

    function finish(value: string | null) {
      document.removeEventListener("keydown", onKeyDown, true);
      card.remove();
      resolve(value);
    }

    function submit() {
      const value = textarea.value.trim();
      finish(value ? value : null);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    }

    cancelBtn.addEventListener("click", () => finish(null));
    saveBtn.addEventListener("click", submit);
    document.addEventListener("keydown", onKeyDown, true);
  });
}

(window as any).__saveItUpShowNoteInput = showNoteInput;
