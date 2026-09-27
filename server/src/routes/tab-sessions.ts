import { Router } from "express";
import { createTabSession, getTabSession } from "../db.js";
import { getUserId } from "../lib/request-context.js";

export const tabSessionsPublicRouter = Router();
export const tabSessionsRouter = Router();

function logError(err: unknown): void {
  console.error("[saveitup] request failed", err);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

tabSessionsPublicRouter.get("/tab-sessions/:id", async (req, res) => {
  try {
    const session = await getTabSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(session);
  } catch (err) {
    logError(err);
    res.status(500).json({ error: "internal server error" });
  }
});

tabSessionsPublicRouter.get("/open/:id", async (req, res) => {
  try {
    const session = await getTabSession(req.params.id);
    if (!session) {
      res.status(404).send("Session not found.");
      return;
    }

    const links = session.tabs
      .map(
        (tab) =>
          `<li><a href="${escapeHtml(tab.url)}" target="_blank" rel="noopener">${escapeHtml(
            tab.title || tab.url
          )}</a></li>`
      )
      .join("\n");

    const tabsJson = JSON.stringify(session.tabs).replace(/</g, "\\u003c");

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SaveItUp — ${session.tabs.length} tabs</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 32px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 18px; }
    button { font-size: 14px; padding: 10px 16px; border: none; border-radius: 8px; background: #4f46e5; color: #fff; cursor: pointer; margin-bottom: 16px; }
    ul { list-style: none; padding: 0; }
    li { padding: 8px 0; border-bottom: 1px solid #eee; }
    a { color: #4f46e5; text-decoration: none; word-break: break-all; }
  </style>
</head>
<body>
  <div id="saveitup-session-marker" data-session-id="${escapeHtml(req.params.id)}"></div>
  <h1>${session.tabs.length} tab${session.tabs.length === 1 ? "" : "s"} shared via SaveItUp</h1>
  <button id="open-all">Open all ${session.tabs.length} tabs</button>
  <ul>${links}</ul>
  <script>
    var tabs = ${tabsJson};
    document.getElementById("open-all").addEventListener("click", function () {
      tabs.forEach(function (t) { window.open(t.url, "_blank"); });
    });
  </script>
</body>
</html>`);
  } catch (err) {
    logError(err);
    res.status(500).send("Internal server error.");
  }
});

tabSessionsRouter.post("/tab-sessions", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { tabs } = req.body;
    if (!Array.isArray(tabs) || tabs.length === 0) {
      res.status(400).json({ error: "tabs must be a non-empty array" });
      return;
    }
    if (!tabs.every((tab) => isHttpUrl(tab?.url))) {
      res.status(400).json({ error: "tabs must have http or https URLs" });
      return;
    }
    const result = await createTabSession(userId, tabs);
    res.status(201).json(result);
  } catch (err) {
    logError(err);
    res.status(500).json({ error: "internal server error" });
  }
});
