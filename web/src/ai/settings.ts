// localStorage-backed twin of the extension's chrome.storage settings module (same API), so the
// copied AI code (providers/chat/cleanup/summarize/embeddings) runs unchanged in the web app.
import type { AIRole, AIErrorEntry } from "../types";
import type { Provider, ProviderCredentials } from "./providers";
import { KNOWN_PROVIDERS } from "./providers";

const CREDENTIALS_KEY = "aiProviderCredentials";
const ROLES_KEY = "aiRoleConfig";
const ERRORS_KEY = "aiErrorLog";
const MAX_ERROR_LOG = 50;

export interface RoleSelection { provider: string; model?: string }
type CredentialsMap = Partial<Record<Provider, ProviderCredentials>>;
type RolesMap = Partial<Record<AIRole, RoleSelection>>;

export { KNOWN_PROVIDERS };

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}
const write = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

export async function getAllCredentials(): Promise<CredentialsMap> { return read<CredentialsMap>(CREDENTIALS_KEY, {}); }
export async function setProviderCredentials(provider: Provider, creds: ProviderCredentials): Promise<void> {
  const all = await getAllCredentials();
  all[provider] = creds;
  write(CREDENTIALS_KEY, all);
}
export async function getProviderCredentials(provider: string): Promise<ProviderCredentials> {
  return (await getAllCredentials())[provider as Provider] ?? {};
}
export async function isProviderConfigured(provider: string): Promise<boolean> {
  if (provider === "ollama") return true;
  return !!(await getProviderCredentials(provider)).apiKey;
}
export async function getAllRoleConfig(): Promise<RolesMap> { return read<RolesMap>(ROLES_KEY, {}); }
export async function getRoleConfig(role: AIRole): Promise<RoleSelection | null> { return (await getAllRoleConfig())[role] ?? null; }
export async function setRoleConfig(role: AIRole, selection: RoleSelection | null): Promise<void> {
  const all = await getAllRoleConfig();
  if (selection) all[role] = selection;
  else delete all[role];
  write(ROLES_KEY, all);
}
export async function recordAIError(role: AIRole, provider: string, model: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const log = read<AIErrorEntry[]>(ERRORS_KEY, []);
  log.unshift({ timestamp: new Date().toISOString(), role, provider, model, message });
  write(ERRORS_KEY, log.slice(0, MAX_ERROR_LOG));
}
export async function listAIErrors(): Promise<AIErrorEntry[]> { return read<AIErrorEntry[]>(ERRORS_KEY, []); }
export async function clearAIErrors(): Promise<void> { localStorage.removeItem(ERRORS_KEY); }

/** Replaces every saved key and model choice at once (used when settings arrive from another device). */
export async function replaceAllSettings(credentials: CredentialsMap, roles: RolesMap): Promise<void> {
  write(CREDENTIALS_KEY, credentials);
  write(ROLES_KEY, roles);
}
