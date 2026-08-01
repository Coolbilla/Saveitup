import { Router } from "express";
import {
  insertPage,
  listPages,
  getPage,
  updatePage,
  deletePage,
  getPagesByUrl,
  updateSummary,
  updateCleanedContent,
  listFolders,
  findOrCreateFolder,
  createFolder,
  updateEmbedding
} from "../db.js";
import { generateSummary } from "../lib/summarize.js";
import { suggestFolder } from "../lib/categorize.js";
import { generateEmbedding } from "../lib/embeddings.js";
import { cleanMarkdown, transformContent } from "../lib/cleanup.js";
import { extractFromUrl } from "../lib/url-extract.js";
import { answerChat, explainSelection, translateSelection } from "../lib/chat.js";
import { recordAIError } from "../lib/ai-config.js";
import { getUserId } from "../lib/request-context.js";

export const pagesRouter = Router();

function buildCleanupSource(pageContent: string, description?: string | null, transcript?: string | null): string {
  const parts = [pageContent];
  if (description) parts.push(`## Description\n\n${description}`);
  if (transcript) parts.push(`## Transcript\n\n${transcript}`);
  return parts.join("\n\n");
}

pagesRouter.post("/chat", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { message, history, currentPage } = req.body;
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const result = await answerChat(userId, { message, history: history ?? [], currentPage: currentPage ?? null });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/explain", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { selection, pageTitle, surroundingContext } = req.body;
    if (!selection) {
      res.status(400).json({ error: "selection is required" });
      return;
    }
    const explanation = await explainSelection(userId, {
      selection,
      pageTitle: pageTitle ?? "",
      surroundingContext: surroundingContext ?? ""
    });
    res.json({ explanation });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/translate", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { text } = req.body;
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const translation = await translateSelection(userId, text);
    res.json({ translation });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/pages", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { url, title, domain, pageContent } = req.body;
    if (!url || !pageContent) {
      res.status(400).json({ error: "url and pageContent are required" });
      return;
    }
    const result = await insertPage(userId, req.body);

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
          folders.map((f) => f.name)
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
    res.status(500).json({ error: (err as Error).message });
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
      folderId: folderId ? Number(folderId) : undefined
    });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.get("/folders", async (req, res) => {
  try {
    const userId = getUserId(req);
    const folders = await listFolders(userId);
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/folders", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const folder = await createFolder(userId, name.trim());
    res.status(201).json(folder);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.get("/pages/by-url", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { url } = req.query;
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const matches = await getPagesByUrl(userId, String(url));
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.get("/pages/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const record = await getPage(userId, Number(req.params.id));
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.patch("/pages/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { noteText, pinned, folderId } = req.body;
    if (noteText !== undefined && typeof noteText !== "string") {
      res.status(400).json({ error: "noteText must be a string" });
      return;
    }
    if (pinned !== undefined && typeof pinned !== "boolean") {
      res.status(400).json({ error: "pinned must be a boolean" });
      return;
    }
    if (folderId !== undefined && folderId !== null && typeof folderId !== "number") {
      res.status(400).json({ error: "folderId must be a number or null" });
      return;
    }
    if (noteText === undefined && pinned === undefined && folderId === undefined) {
      res.status(400).json({ error: "noteText, pinned, or folderId is required" });
      return;
    }
    const record = await updatePage(userId, Number(req.params.id), { noteText, pinned, folderId });
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/pages/:id/summary", async (req, res) => {
  try {
    const userId = getUserId(req);
    const page = await getPage(userId, Number(req.params.id));
    if (!page) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const summary = await generateSummary(userId, {
      title: page.title,
      description: page.description,
      transcript: page.transcript,
      pageContent: page.pageContent
    });
    const record = await updateSummary(userId, page.id, summary);
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/pages/:id/reclean", async (req, res) => {
  try {
    const userId = getUserId(req);
    const page = await getPage(userId, Number(req.params.id));
    if (!page) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const source = buildCleanupSource(page.pageContent, page.description, page.transcript);
    const cleaned = await cleanMarkdown(userId, { title: page.title, pageContent: source });
    const record = await updateCleanedContent(userId, page.id, cleaned);
    res.json({ ...record, unchanged: cleaned === source });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/pages/:id/transform", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { instruction } = req.body;
    if (!instruction || typeof instruction !== "string") {
      res.status(400).json({ error: "instruction is required" });
      return;
    }
    const page = await getPage(userId, Number(req.params.id));
    if (!page) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const result = await transformContent(userId, {
      content: page.cleanedContent ?? page.pageContent,
      instruction
    });
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

pagesRouter.post("/url-to-markdown", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const { title, markdown, rawMarkdown } = await extractFromUrl(userId, url);
    const domain = new URL(url).hostname.replace(/^www\./, "");

    const inserted = await insertPage(userId, { url, title, domain, pageContent: rawMarkdown });
    await updateCleanedContent(userId, inserted.id, markdown);

    try {
      const folders = await listFolders(userId);
      const name = await suggestFolder(userId, { title, pageContent: rawMarkdown, domain }, folders.map((f) => f.name));
      const folder = await findOrCreateFolder(userId, name);
      await updatePage(userId, inserted.id, { folderId: folder.id });
    } catch (err) {
      console.error("[saveitup] auto-categorize failed for url-to-markdown", err);
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

pagesRouter.delete("/pages/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const deleted = await deletePage(userId, Number(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
