// Pushes the secrets from server/.env to your Cloudflare Worker (asks Cloudflare, not you, to store them).
// Usage: npx wrangler login   (once)   then   npm run secrets   then   npm run deploy
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const env = readFileSync(new URL("../../server/.env", import.meta.url), "utf8");
const wanted = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SAVEITUP_API_KEY", "OPENROUTER_API_KEY"];
for (const key of wanted) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m || !m[1].trim()) { console.log(`skip ${key} (not set in server/.env)`); continue; }
  const r = spawnSync("npx", ["wrangler", "secret", "put", key], { input: m[1].trim(), stdio: ["pipe", "inherit", "inherit"], shell: true });
  console.log(r.status === 0 ? `set ${key}` : `FAILED ${key}`);
}
