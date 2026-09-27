import type { Request, Response, NextFunction } from "express";
import { getUserId } from "../lib/request-context.js";

/**
 * Fixed-window, per-user limiter for the expensive routes (each call can fetch a page and spend AI credits).
 * In-memory: resets on restart and isn't shared across instances — fine for a single Render service.
 * ponytail: move to Redis/Supabase if the server is ever scaled to more than one instance.
 */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = getUserId(req);
    const t = now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    if (++entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - t) / 1000)));
      res.status(429).json({ error: "Too many requests — slow down and try again shortly." });
      return;
    }
    next();
  };
}
