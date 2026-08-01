import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { cleanMarkdown } from "./cleanup.js";

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

  const res = await fetch(parsed.toString(), {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SaveItUpBot/1.0)" }
  });
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);
  const html = await res.text();

  const document = (parseHTML(html) as any).document;
  let title = document.title || parsed.hostname;
  let rawMarkdown: string;

  try {
    const article = new Readability(document as any).parse();
    if (article?.content) {
      title = article.title || title;
      rawMarkdown = getTurndown().turndown(article.content).trim();
    } else {
      rawMarkdown = getTurndown().turndown(document.body.innerHTML).trim();
    }
  } catch {
    rawMarkdown = getTurndown().turndown(document.body.innerHTML).trim();
  }

  if (!rawMarkdown) {
    rawMarkdown = `# ${title}\n\n(no extractable text content at this URL)`;
  }

  const markdown = await cleanMarkdown(userId, { title, pageContent: rawMarkdown });
  return { title, markdown, rawMarkdown };
}
