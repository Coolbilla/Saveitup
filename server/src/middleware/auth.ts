import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { supabase } from "../db.js";

const DEV_FAKE_USER_ID = process.env.DEV_FAKE_USER_ID || "00000000-0000-0000-0000-000000000001";

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // Check the static key first: it's a fast local comparison, and every mcp-server
  // request (100% of traffic from that caller) used to pay a wasted Supabase network
  // round-trip here before falling through to this exact check anyway.
  if (process.env.SAVEITUP_API_KEY && timingSafeStringEqual(token, process.env.SAVEITUP_API_KEY)) {
    (req as any).userId = DEV_FAKE_USER_ID;
    next();
    return;
  }

  // ponytail: verifies via a network call to Supabase's Auth API (auth.getUser accepts an
  // arbitrary caller-supplied JWT regardless of which key the client itself holds). Upgrade
  // path if latency ever matters: verify locally against SUPABASE_JWT_SECRET instead.
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data.user) {
      (req as any).userId = data.user.id;
      next();
      return;
    }
  } catch (err) {
    console.warn("[saveitup-server] Supabase token verification failed", err);
  }

  res.status(401).json({ error: "unauthorized" });
}
