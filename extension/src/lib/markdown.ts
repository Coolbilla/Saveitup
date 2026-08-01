import TurndownService from "turndown";

let turndownService: TurndownService | null = null;

// Tags that never carry meaningful reading content and, left in, either dump
// raw HTML into the saved markdown or (iframe/object/svg/form) can carry
// live/executable markup through to whatever later renders this text as HTML.
const STRIP_TAGS = [
  "script", "style", "noscript", "iframe", "object", "embed", "applet",
  "svg", "math", "form", "template", "link", "meta", "base",
  "button", "input", "select", "textarea", "canvas"
];

const DANGEROUS_VALUE_PREFIXES = ["javascript:", "vbscript:", "data:text/html"];

// Turndown has no rule for most non-standard/interactive elements, so it
// falls back to emitting their outerHTML verbatim — attributes included.
// Since this runs on arbitrary, untrusted page HTML, strip anything that
// could execute from every element (not just ones Turndown has a rule for)
// before handing the markup to Turndown at all.
export function sanitizeHtml(html: string): string {
  // DOMParser produces a document with no browsing context, so parsing
  // untrusted markup here never executes scripts or fetches resources —
  // unlike setting .innerHTML on a real element, where even a detached
  // <img onerror=...> fires its handler as soon as it's parsed.
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.querySelectorAll(STRIP_TAGS.join(",")).forEach((el) => el.remove());
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.split("").filter((ch) => ch.charCodeAt(0) > 32).join("").toLowerCase();
      const isEventHandler = name.indexOf("on") === 0;
      const isDangerousValue = DANGEROUS_VALUE_PREFIXES.some((prefix) => value.indexOf(prefix) === 0);
      if (isEventHandler || isDangerousValue) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-"
    });
  }
  return turndownService;
}

export function htmlToMarkdown(html: string): string {
  return getTurndown().turndown(sanitizeHtml(html)).trim();
}

export function elementToMarkdown(el: Element): string {
  return htmlToMarkdown(el.outerHTML);
}
