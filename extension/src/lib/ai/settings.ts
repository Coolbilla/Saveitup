import type { AIRole, AIErrorEntry } from "../../../../shared/src/types";
import type { Provider, ProviderCredentials } from "./providers";
import { KNOWN_PROVIDERS } from "./providers";

// Replaces server/src/lib/ai-config.ts and the user_ai_settings/ai_error_log Supabase
// tables: everything AI-config-related lives in chrome.storage.local instead, since
// per-user provider API keys live there too and this config is meaningless without them.

const CREDENTIALS_KEY = "aiProviderCredentials";
const ROLES_KEY = "aiRoleConfig";
const ERRORS_KEY = "aiErrorLog";
const MAX_ERROR_LOG = 50;

export interface RoleSelection {
  provider: string;
  model?: string;
}

type CredentialsMap = Partial<Record<Provider, ProviderCredentials>>;
type RolesMap = Partial<Record<AIRole, RoleSelection>>;

export { KNOWN_PROVIDERS };

export async function getAllCredentials(): Promise<CredentialsMap> {
  const result = await chrome.storage.local.get(CREDENTIALS_KEY);
  return result[CREDENTIALS_KEY] ?? {};
}

export async function setProviderCredentials(provider: Provider, creds: ProviderCredentials): Promise<void> {
  const all = await getAllCredentials();
  all[provider] = creds;
  await chrome.storage.local.set({ [CREDENTIALS_KEY]: all });
}

export async function getProviderCredentials(provider: string): Promise<ProviderCredentials> {
  const all = await getAllCredentials();
  return all[provider as Provider] ?? {};
}

export async function isProviderConfigured(provider: string): Promise<boolean> {
  if (provider === "ollama") return true;
  const creds = await getProviderCredentials(provider);
  return !!creds.apiKey;
}

export async function getAllRoleConfig(): Promise<RolesMap> {
  const result = await chrome.storage.local.get(ROLES_KEY);
  return result[ROLES_KEY] ?? {};
}

export async function getRoleConfig(role: AIRole): Promise<RoleSelection | null> {
  const all = await getAllRoleConfig();
  return all[role] ?? null;
}

export async function setRoleConfig(role: AIRole, selection: RoleSelection | null): Promise<void> {
  const all = await getAllRoleConfig();
  if (selection) {
    all[role] = selection;
  } else {
    delete all[role];
  }
  await chrome.storage.local.set({ [ROLES_KEY]: all });
}

export async function recordAIError(role: AIRole, provider: string, model: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const result = await chrome.storage.local.get(ERRORS_KEY);
  const log: AIErrorEntry[] = result[ERRORS_KEY] ?? [];
  log.unshift({ timestamp: new Date().toISOString(), role, provider, model, message });
  await chrome.storage.local.set({ [ERRORS_KEY]: log.slice(0, MAX_ERROR_LOG) });
}

export async function listAIErrors(): Promise<AIErrorEntry[]> {
  const result = await chrome.storage.local.get(ERRORS_KEY);
  return result[ERRORS_KEY] ?? [];
}

export async function clearAIErrors(): Promise<void> {
  await chrome.storage.local.remove(ERRORS_KEY);
}

/** Replaces every saved key and model choice at once (used when settings arrive from another device). */
export async function replaceAllSettings(credentials: CredentialsMap, roles: RolesMap): Promise<void> {
  await chrome.storage.local.set({ [CREDENTIALS_KEY]: credentials, [ROLES_KEY]: roles });
}
