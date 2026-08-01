import { getUserRoleConfig, setUserRoleConfig, recordAIErrorRow, listAIErrorRows, clearAIErrorRows } from "../db.js";

export type AIRole = "cleanup" | "categorize" | "summarize" | "chat" | "embeddings";

export interface ProviderModelPair {
  provider: string;
  model: string;
}

export interface RoleConfig {
  chain: ProviderModelPair[];
}

export async function getRoleConfig(userId: string, role: AIRole): Promise<RoleConfig | null> {
  let value: { chain: unknown[] } | null;
  try {
    value = await getUserRoleConfig(userId, role);
  } catch (err) {
    console.error(`[saveitup] failed to load role config for "${role}", falling back to env vars`, err);
    return null;
  }
  if (!value || !Array.isArray(value.chain) || value.chain.length === 0) return null;
  return { chain: value.chain as ProviderModelPair[] };
}

export async function setRoleConfig(userId: string, role: AIRole, config: RoleConfig): Promise<void> {
  await setUserRoleConfig(userId, role, config.chain);
}

export interface AIErrorEntry {
  timestamp: string;
  role: AIRole;
  provider: string;
  model: string;
  message: string;
}

export function recordAIError(userId: string, role: AIRole, provider: string, model: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  recordAIErrorRow(userId, role, provider, model, message).catch((logErr) =>
    console.error("[saveitup] failed to persist AI error log entry", logErr)
  );
}

export async function listAIErrors(userId: string): Promise<AIErrorEntry[]> {
  return (await listAIErrorRows(userId)) as AIErrorEntry[];
}

export async function clearAIErrors(userId: string): Promise<void> {
  await clearAIErrorRows(userId);
}
