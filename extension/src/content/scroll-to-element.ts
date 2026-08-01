import { drawHighlightBox } from "../lib/highlight-box";

function scrollToSelector(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) return false;

  el.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => drawHighlightBox(el), 500);

  return true;
}

(window as any).__saveItUpScrollToSelector = scrollToSelector;
