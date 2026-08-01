import type { Request } from "express";

// Temporary stand-in for real auth (Phase B). Every multi-tenant query in db.ts is already
// wired to filter by userId, so swapping this for req.userId (set by the real auth middleware)
// is the only change needed once Supabase Auth lands — no caller of getUserId() needs to change.
const DEV_FAKE_USER_ID = process.env.DEV_FAKE_USER_ID || "00000000-0000-0000-0000-000000000001";

export function getUserId(req: Request): string {
  return (req as any).userId || DEV_FAKE_USER_ID;
}
