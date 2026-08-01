import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "@clerk/backend";

const DEV_FAKE_USER_ID = process.env.DEV_FAKE_USER_ID || "00000000-0000-0000-0000-000000000001";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (process.env.CLERK_SECRET_KEY) {
    try {
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
      (req as any).userId = payload.sub;
      next();
      return;
    } catch {
      // Falls through to the static-key check below, which keeps mcp-server (and any other
      // static-key caller) working until Phase F's per-user personal access tokens replace it.
    }
  }

  if (process.env.SAVEITUP_API_KEY && token === process.env.SAVEITUP_API_KEY) {
    (req as any).userId = DEV_FAKE_USER_ID;
    next();
    return;
  }

  res.status(401).json({ error: "unauthorized" });
}
