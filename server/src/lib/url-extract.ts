import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { cleanMarkdown } from "./cleanup.js";
import { timedFetch } from "./providers.js";

function isPrivateOrLoopbackIp(ip: string, family: 4 | 6): boolean {
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 127 || // loopback
      a === 10 || // private
      a === 0 || // "this network"
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) // private
    );
  }
  return ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd");
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateOrLoopbackIp(hostname, isIP(hostname) === 6 ? 6 : 4)) {
      throw new Error("Refusing to fetch a private/loopback address");
    }
    return;
  }
  let resolved: { address: string; family: number };
  try {
    resolved = await lookup(hostname);
  } catch (err) {
    // ENOTFOUND etc. is a real failure. But on Cloudflare Workers there is no DNS lookup (and the
    // platform itself refuses to connect to private/loopback addresses), so skip the check there.
    if ((err as { code?: string }).code) throw err;
    return;
  }
  if (isPrivateOrLoopbackIp(resolved.address, resolved.family as 4 | 6)) {
    throw new Error("Refusing to fetch a private/loopback address");
  }
}

const MAX_REDIRECTS = 5;

// Re-checks assertPublicHost on every redirect hop, not just the URL the caller supplied —
// a public-looking URL that 302s to a private/internal address would otherwise sail through.
async function fetchFollowingGuardedRedirects(url: URL): Promise<Response> {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(current.hostname);
    const res = await timedFetch(current.toString(), {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; SaveItUpBot/1.0)" }
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, current);
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("Only http/https URLs are supported");
    }
  }
  throw new Error("Too many redirects");
}

let turndownService: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-"
    });
    turndownService.remove(["script", "style", "noscript"]);
  }
  return turndownService;
}

// Hand Turndown a linkedom node instead of an HTML string: given a string it parses with its own
// DOM (domino on Node, the global `document` in its browser build), which Workers don't have.
function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`) as any;
  return getTurndown().turndown(document.body).trim();
}

export async function extractFromUrl(
  userId: string,
  url: string
): Promise<{ title: string; markdown: string; rawMarkdown: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported");
  }
  const res = await fetchFollowingGuardedRedirects(parsed);
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);
  const html = await res.text();

  const document = (parseHTML(html) as any).document;
  let title = document.title || parsed.hostname;
  let rawMarkdown: string;

  try {
    const article = new Readability(document as any).parse();
    if (article?.content) {
      title = article.title || title;
      rawMarkdown = htmlToMarkdown(article.content);
    } else {
      rawMarkdown = htmlToMarkdown(document.body.innerHTML);
    }
  } catch {
    rawMarkdown = htmlToMarkdown(document.body.innerHTML);
  }

  if (!rawMarkdown) {
    rawMarkdown = `# ${title}\n\n(no extractable text content at this URL)`;
  }

  const markdown = await cleanMarkdown(userId, { title, pageContent: rawMarkdown });
  return { title, markdown, rawMarkdown };
}
