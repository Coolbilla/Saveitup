import { elementToMarkdown } from "../lib/markdown";

interface RedditCaptureResult {
  description: string | null;
  transcript: string | null;
}

function extractPostBody(): string | null {
  const candidates = [
    "shreddit-post div[slot='text-body']",
    "div[data-test-id='post-content'] div[data-click-id='text']",
    "div.usertext-body",
    "div[data-testid='post-container'] p"
  ];
  for (const selector of candidates) {
    const el = document.querySelector(selector);
    if (el && el.textContent?.trim()) return elementToMarkdown(el).slice(0, 50_000);
  }
  return null;
}

function extractPostTitle(): string {
  const el =
    document.querySelector("shreddit-post")?.getAttribute("post-title") ??
    document.querySelector("h1[slot='title']")?.textContent?.trim() ??
    document.querySelector("h1")?.textContent?.trim() ??
    document.title;
  return el;
}

function extractTopComments(): string | null {
  const commentNodes = Array.from(
    document.querySelectorAll("shreddit-comment, div.comment > div.entry .usertext-body")
  ).slice(0, 20);

  if (commentNodes.length === 0) return null;

  const parts: string[] = [];
  for (const node of commentNodes) {
    const author =
      node.getAttribute?.("author") ??
      node.querySelector?.(".author")?.textContent?.trim() ??
      "unknown";
    const bodyEl =
      node.querySelector("div[slot='comment']") ??
      node.querySelector(".usertext-body") ??
      node;
    const body = bodyEl ? elementToMarkdown(bodyEl) : "";
    if (body) parts.push(`**${author}:** ${body}`);
  }
  return parts.length ? parts.join("\n\n---\n\n").slice(0, 100_000) : null;
}

function captureReddit(): RedditCaptureResult {
  const title = extractPostTitle();
  const body = extractPostBody();
  const description = body ? `# ${title}\n\n${body}` : `# ${title}`;
  const transcript = extractTopComments();
  return { description, transcript };
}

(window as any).__saveItUpCaptureReddit = captureReddit;
