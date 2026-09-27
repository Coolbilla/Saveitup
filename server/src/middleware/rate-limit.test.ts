import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "./rate-limit.js";

function run(limiter: ReturnType<typeof createRateLimiter>, userId: string) {
  let status = 200;
  let passed = false;
  const res: any = { setHeader() {}, status(s: number) { status = s; return this; }, json() {} };
  limiter({ userId } as any, res, () => (passed = true));
  return { status, passed };
}

test("allows up to max per window, then 429s, per user", () => {
  let t = 0;
  const limiter = createRateLimiter(2, 1000, () => t);
  assert.ok(run(limiter, "a").passed);
  assert.ok(run(limiter, "a").passed);
  const blocked = run(limiter, "a");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.passed, false);
  assert.ok(run(limiter, "b").passed); // other users unaffected
  t = 1001;
  assert.ok(run(limiter, "a").passed); // window reset
});
