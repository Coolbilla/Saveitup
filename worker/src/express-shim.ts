// A tiny stand-in for the parts of Express that server/src/routes/* actually use
// (Router + req.params/query/body/header + res.status/json/send/setHeader), so the very same
// route files run unchanged on Cloudflare Workers. Wired in via [alias] in wrangler.toml.
import type { Context, Hono, MiddlewareHandler } from "hono";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Handler = (req: any, res: any, next: () => void) => unknown;
interface RouteDef { method: Method; path: string; handlers: Handler[] }

export function Router() {
  const routes: RouteDef[] = [];
  const add = (method: Method) => (path: string, ...handlers: Handler[]) => {
    routes.push({ method, path, handlers });
  };
  return { routes, get: add("get"), post: add("post"), put: add("put"), patch: add("patch"), delete: add("delete") };
}
export type ShimRouter = ReturnType<typeof Router>;

// Runs a chain of Express-style handlers. Resolves to a Response if one of them replied,
// or null if the chain finished by calling next() with no reply (i.e. middleware passthrough).
async function runChain(c: Context, handlers: Handler[]): Promise<Response | null> {
  let body: unknown = {};
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    body = await c.req.json().catch(() => ({}));
  }
  const req: any = {
    params: c.req.param(),
    query: c.req.query(),
    body,
    method: c.req.method,
    header: (name: string) => c.req.header(name),
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    userId: c.get("userId")
  };

  return new Promise<Response | null>((resolve, reject) => {
    let status = 200;
    const headers = new Headers();
    let done = false;
    const finish = (payload: BodyInit | null) => {
      done = true;
      resolve(new Response(payload, { status, headers }));
    };
    const res: any = {
      get headersSent() { return done; },
      status(code: number) { status = code; return res; },
      setHeader(k: string, v: string) { headers.set(k, v); return res; },
      json(obj: unknown) { headers.set("content-type", "application/json"); finish(JSON.stringify(obj)); return res; },
      send(payload: unknown) {
        if (typeof payload === "string") {
          if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
          finish(payload);
        } else {
          res.json(payload);
        }
        return res;
      },
      end() { finish(null); return res; }
    };

    const step = (i: number) => {
      if (done) return;
      if (i >= handlers.length) {
        c.set("userId", req.userId);
        resolve(null);
        return;
      }
      try {
        const out = handlers[i](req, res, () => step(i + 1));
        if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(reject);
      } catch (err) {
        reject(err);
      }
    };
    step(0);
  }).then((r) => {
    c.set("userId", req.userId);
    return r;
  });
}

/** Mounts every route of a shimmed Router onto a Hono app. */
export function mount(app: Hono<any>, router: ShimRouter) {
  for (const r of router.routes) {
    app.on(r.method.toUpperCase(), r.path, async (c) => {
      const res = await runChain(c, r.handlers);
      return res ?? c.text("Not found", 404);
    });
  }
}

/** Adapts an Express-style middleware (like requireAuth) to Hono. */
export function middleware(handler: Handler): MiddlewareHandler {
  return async (c, next) => {
    const res = await runChain(c, [handler]);
    if (res) return res;
    await next();
  };
}
