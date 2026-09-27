import { Router } from "express";
import { insertPage, listPages, getPage, updatePage, updateCleanedContent, listFolders, findOrCreateFolder, updateEmbedding } from "../db.js";
import { suggestFolder } from "../lib/categorize.js";
import { generateEmbedding } from "../lib/embeddings.js";
import { cleanMarkdown } from "../lib/cleanup.js";
import { extractFromUrl } from "../lib/url-extract.js";
import { recordAIError } from "../lib/ai-config.js";
import { getUserId } from "../lib/request-context.js";
import { createRateLimiter } from "../middleware/rate-limit.js";

export const pagesRouter = Router();

// Each save / URL import can fetch a page and spend AI credits, so cap them per user.
const saveLimiter = createRateLimiter(60, 60_000);

function sendError(res: import("express").Response, status: number, err: unknown): void {
  console.error("[saveitup] request failed", err);
  res.status(status).json({ error: "internal server error" });
}

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function buildCleanupSource(pageContent: string, description?: string | null, transcript?: string | null): string {
  const parts = [pageContent];
  if (description) parts.push(`## Description\n\n${description}`);
  if (transcript) parts.push(`## Transcript\n\n${transcript}`);
  return parts.join("\n\n");
}

pagesRouter.post("/pages", saveLimiter, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { url, title, domain, pageContent } = req.body;
    if (!url || !pageContent) {
      res.status(400).json({ error: "url and pageContent are required" });
      return;
    }
    const result = await insertPage(userId, req.body);

    if (req.body.format === "youtube-v1") {
      // Already in the fixed YouTube format (header, description, chapters): AI cleanup would only
      // cost calls and risk rewriting it, so store it as-is.
      await updateCleanedContent(userId, result.id, req.body.pageContent);
    } else {
      const cleanupSource = buildCleanupSource(req.body.pageContent, req.body.description, req.body.transcript);
      try {
        const cleaned = await cleanMarkdown(userId, { title: req.body.title, pageContent: cleanupSource });
        await updateCleanedContent(userId, result.id, cleaned);
      } catch (err) {
        console.error("[saveitup] auto-cleanup failed", err);
        recordAIError(userId, "cleanup", "auto", "", err);
        // Don't leave cleanedContent permanently null on a pipeline-level failure — fall back to
        // the uncleaned merged source (still includes transcript/description) so the page isn't
        // missing content entirely; the user can hit Re-clean later to retry the AI pass.
        try {
          await updateCleanedContent(userId, result.id, cleanupSource);
        } catch (fallbackErr) {
          console.error("[saveitup] failed to persist cleanup fallback", fallbackErr);
        }
      }
    }

    if (req.body.folderId === undefined) {
      try {
        const folders = await listFolders(userId);
        const name = await suggestFolder(
          userId,
          {
            title: req.body.title,
            description: req.body.description,
            pageContent: req.body.pageContent,
            domain: req.body.domain
          },
          folders.filter((f) => f.parentId === null).map((f) => f.name)
        );
        const folder = await findOrCreateFolder(userId, name);
        await updatePage(userId, result.id, { folderId: folder.id });
      } catch (err) {
        console.error("[saveitup] auto-categorize failed", err);
      }
    }

    res.status(201).json(result);

    const embedText = [req.body.title, req.body.description, req.body.pageContent].filter(Boolean).join("\n\n");
    generateEmbedding(userId, embedText)
      .then((embedding) => {
        if (embedding) return updateEmbedding(userId, result.id, embedding);
      })
      .catch((err) => console.error("[saveitup] auto-embed failed", err));
  } catch (err) {
    sendError(res, 500, err);
  }
});

pagesRouter.get("/pages", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { limit, offset, domain, q, folderId } = req.query;
    const records = await listPages(userId, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      domain: domain ? String(domain) : undefined,
      q: q ? String(q) : undefined,
      folderIds: folderId ? String(folderId).split(",").map(Number).filter(Number.isInteger) : undefined
    });
    res.json(records);
  } catch (err) {
    sendError(res, 500, err);
  }
});

// Used by mcp-server (read-only) and the extension's "Test connection" probe.
pagesRouter.get("/folders", async (req, res) => {
  try {
    const userId = getUserId(req);
    const folders = await listFolders(userId);
    res.json(folders);
  } catch (err) {
    sendError(res, 500, err);
  }
});

pagesRouter.get("/pages/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const record = await getPage(userId, id);
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(record);
  } catch (err) {
    sendError(res, 500, err);
  }
});

pagesRouter.post("/url-to-markdown", saveLimiter, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { url, folderId } = req.body;
    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
      return;
    }
    if (folderId !== undefined && !Number.isInteger(folderId)) {
      res.status(400).json({ error: "folderId must be an integer" });
      return;
    }
    const { title, markdown, rawMarkdown } = await extractFromUrl(userId, url);
    const domain = new URL(url).hostname.replace(/^www\./, "");

    // A caller-chosen folder (bookmark import) files the page directly and skips AI
    // categorize — otherwise every import would spend a categorize call just to be overridden.
    const inserted = await insertPage(userId, { url, title, domain, pageContent: rawMarkdown, folderId });
    await updateCleanedContent(userId, inserted.id, markdown);

    if (folderId === undefined) {
      try {
        const folders = await listFolders(userId);
        const name = await suggestFolder(userId, { title, pageContent: rawMarkdown, domain }, folders.filter((f) => f.parentId === null).map((f) => f.name));
        const folder = await findOrCreateFolder(userId, name);
        await updatePage(userId, inserted.id, { folderId: folder.id });
      } catch (err) {
        console.error("[saveitup] auto-categorize failed for url-to-markdown", err);
      }
    }

    res.json({ id: inserted.id, title, markdown, duplicateCount: inserted.duplicateCount });

    const embedText = [title, rawMarkdown].filter(Boolean).join("\n\n");
    generateEmbedding(userId, embedText)
      .then((embedding) => {
        if (embedding) return updateEmbedding(userId, inserted.id, embedding);
      })
      .catch((err) => console.error("[saveitup] auto-embed failed for url-to-markdown", err));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
