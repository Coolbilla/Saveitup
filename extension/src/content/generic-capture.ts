import { Readability } from "@mozilla/readability";
import { htmlToMarkdown, elementToMarkdown } from "../lib/markdown";
import { buildSelector } from "../lib/selector";

interface GenericCaptureResult {
  title: string;
  url: string;
  pageContent: string;
}

function extractMarkdown(): string {
  try {
    const clone = document.cloneNode(true) as Document;
    const article = new Readability(clone).parse();
    if (article?.content) {
      const markdown = htmlToMarkdown(article.content).slice(0, 200_000);
      if (markdown.trim()) return markdown;
    }
  } catch {
    // Readability failed (e.g. non-article page); fall back below.
  }
  try {
    const markdown = elementToMarkdown(document.body).slice(0, 200_000);
    if (markdown.trim()) return markdown;
  } catch {
    // body-to-markdown failed; fall back below.
  }
  return `# ${document.title}\n\n(no extractable text content on this page)`;
}

function captureGenericPage(): GenericCaptureResult {
  return {
    title: document.title,
    url: location.href,
    pageContent: extractMarkdown()
  };
}

interface HighlightContextResult {
  context: string | null;
  elementSelector: string | null;
}

function captureHighlightContext(): HighlightContextResult {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return { context: null, elementSelector: null };
  const anchor = selection.getRangeAt(0).commonAncestorContainer;
  const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
  if (!el) return { context: null, elementSelector: null };
  // Use the immediate enclosing element for the badge anchor (positioning needs
  // something close-fitting to the selection), but a broader block ancestor for
  // the displayed context text — closest("p, article, section, div") can latch
  // onto a full-page wrapping <div>, which is fine for surrounding text but
  // useless (and visually wrong) as a badge position.
  const contextContainer = el.closest("p, article, section, div") ?? el;
  return {
    context: elementToMarkdown(contextContainer).slice(0, 2000),
    elementSelector: buildSelector(el)
  };
}

(window as any).__saveItUpCaptureGeneric = captureGenericPage;
(window as any).__saveItUpCaptureHighlightContext = captureHighlightContext;
