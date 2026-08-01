import "dotenv/config";
import express from "express";
import cors from "cors";
import { pagesRouter } from "./routes/pages.js";
import { tabSessionsPublicRouter, tabSessionsRouter } from "./routes/tab-sessions.js";
import { embedPublicRouter } from "./routes/embed.js";
import { settingsRouter } from "./routes/settings.js";
import { requireAuth } from "./middleware/auth.js";

const app = express();
app.use(cors());
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(tabSessionsPublicRouter);
app.use(embedPublicRouter);
app.use(requireAuth);
app.use(pagesRouter);
app.use(tabSessionsRouter);
app.use(settingsRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[saveitup-server] unhandled error", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal server error" });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`[saveitup-server] listening on :${port}`);
});
