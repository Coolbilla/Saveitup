import express from "express";
import cors from "cors";
import { pagesRouter } from "./routes/pages.js";
import { tabSessionsPublicRouter, tabSessionsRouter } from "./routes/tab-sessions.js";
import { embedPublicRouter } from "./routes/embed.js";
import { pageSharesPublicRouter, pageSharesRouter } from "./routes/page-shares.js";
import { requireAuth } from "./middleware/auth.js";

const app = express();

// Extension pages (background/sidepanel) call this API with host_permissions granted, so their
// fetches aren't subject to CORS at all. This allowlist only matters for arbitrary web pages.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("not allowed by CORS"));
    },
  })
);
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});
app.use(express.json({ limit: "10mb" }));
// semanticSearch tells the extension whether /pages?q= does embedding-based ranking
// or falls back to plain full-text search — otherwise that's invisible client-side.
app.get("/health", (_req, res) =>
  res.json({ ok: true, semanticSearch: (process.env.EMBEDDING_PROVIDER || "none").toLowerCase() !== "none" })
);
app.use(tabSessionsPublicRouter);
app.use(embedPublicRouter);
app.use(pageSharesPublicRouter);
app.use(requireAuth);
app.use(pagesRouter);
app.use(tabSessionsRouter);
app.use(pageSharesRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[saveitup-server] unhandled error", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal server error" });
});

export default app;
