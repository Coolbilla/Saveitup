import { Router } from "express";
import { getPage, createPageShare, getSharedPage } from "../db.js";
import { getUserId } from "../lib/request-context.js";

export const pageSharesPublicRouter = Router();
export const pageSharesRouter = Router();

function logError(err: unknown): void {
  console.error("[saveitup] request failed", err);
}

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Minimal, dependency-free markdown-to-HTML for the public share page — this route has no
// auth/session context to run the extension's own sanitize-and-render pipeline through, so
// it keeps to a small safe subset (headings/paragraphs/bold/italic/links/lists) rather than
// pulling in a markdown parser just for this one read-only view.
function markdownToSafeHtml(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const withInline = escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
      try {
        const url = new URL(href);
        if (url.protocol !== "http:" && url.protocol !== "https:") return text;
        return `<a href="${escapeHtml(url.toString())}" target="_blank" rel="noopener">${text}</a>`;
      } catch {
        return text;
      }
    });
  return withInline
    .split(/\n{2,}/)
    .map((block) => {
      const heading = block.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        return `<h${level}>${heading[2]}</h${level}>`;
      }
      if (/^\s*[-*]\s+/.test(block)) {
        const items = block
          .split("\n")
          .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
          .filter(Boolean)
          .map((item) => `<li>${item}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

pageSharesPublicRouter.get("/shared/:id", async (req, res) => {
  try {
    const page = await getSharedPage(req.params.id);
    if (!page) {
      res.status(404).send("Shared page not found.");
      return;
    }
    const content = page.cleanedContent || page.pageContent || "";
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title || page.url)} — shared via SaveItUp</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 680px; margin: 32px auto; padding: 0 20px 60px; color: #222; line-height: 1.55; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .meta { font-size: 13px; color: #888; margin-bottom: 24px; }
    .meta a { color: #4f46e5; text-decoration: none; }
    a { color: #4f46e5; }
    pre, code { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
    ul { padding-left: 20px; }
    .footer { margin-top: 40px; font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 16px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(page.title || page.url)}</h1>
  <div class="meta">${escapeHtml(page.domain)} · <a href="${escapeHtml(page.url)}" target="_blank" rel="noopener">Original page →</a></div>
  ${markdownToSafeHtml(content)}
  <div class="footer">Shared via SaveItUp</div>
</body>
</html>`);
  } catch (err) {
    logError(err);
    res.status(500).send("Internal server error.");
  }
});

pageSharesRouter.post("/pages/:id/share", async (req, res) => {
  try {
    const userId = getUserId(req);
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const page = await getPage(userId, id);
    if (!page) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const share = await createPageShare(userId, id);
    res.status(201).json({ id: share.id });
  } catch (err) {
    logError(err);
    res.status(500).json({ error: "internal server error" });
  }
});
