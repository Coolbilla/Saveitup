// SaveItUp server on Cloudflare Workers: the same route files as server/src, mounted on Hono.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mount, middleware } from "./express-shim";
import { pagesRouter } from "../../server/src/routes/pages";
import { tabSessionsPublicRouter, tabSessionsRouter } from "../../server/src/routes/tab-sessions";
import { embedPublicRouter } from "../../server/src/routes/embed";
import { pageSharesPublicRouter, pageSharesRouter } from "../../server/src/routes/page-shares";
import { requireAuth } from "../../server/src/middleware/auth";

const app = new Hono();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  "*",
  cors({
    origin: (origin) => (allowedOrigins.length === 0 || allowedOrigins.includes(origin) ? origin || "*" : ""),
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  })
);
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
});

app.get("/health", (c) =>
  c.json({ ok: true, semanticSearch: (process.env.EMBEDDING_PROVIDER || "none").toLowerCase() !== "none" })
);

// public (no auth)
for (const r of [tabSessionsPublicRouter, embedPublicRouter, pageSharesPublicRouter]) mount(app, r as any);

// everything below needs a signed-in user
app.use("*", middleware(requireAuth as any));
for (const r of [pagesRouter, tabSessionsRouter, pageSharesRouter]) mount(app, r as any);

app.onError((err, c) => {
  console.error("[saveitup-worker] unhandled error", err);
  return c.json({ error: "internal server error" }, 500);
});

export default app;
