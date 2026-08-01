import { drawHighlightBox } from "../lib/highlight-box";
import { findElementContainingText } from "../lib/text-search";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrollToText(snippet: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const el = findElementContainingText(snippet);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => drawHighlightBox(el), 500);
      return true;
    }
    await sleep(500);
  }
  return false;
}

(window as any).__saveItUpScrollToText = scrollToText;
