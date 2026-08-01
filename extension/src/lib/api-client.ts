import type {
  SavedPagePayload,
  SavedPageSummary,
  SavedPageRecord,
  InsertPageResult,
  TabSessionTab,
  Folder,
  ChatMessage,
  ChatCurrentPage,
  ChatResponse,
  ExplainResponse,
  AIRole,
  ProviderModelPair,
  AISettingsResponse,
  AIErrorEntry
} from "../../../shared/src/types";

import { getAuthToken } from "./auth";

export interface ExtensionSettings {
  apiBase: string;
}

// Set SAVEITUP_DEFAULT_API_BASE in .env before a production build to ship a
// real default — falls back to the local dev server when unset so nothing
// changes for local development.
const DEFAULT_API_BASE = process.env.SAVEITUP_DEFAULT_API_BASE || "http://localhost:3001";

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(["apiBase"]);
  return { apiBase: stored.apiBase || DEFAULT_API_BASE };
}

// Backend host access is an optional_host_permissions grant (not a static
// <all_urls> permission), since the backend URL is user-configurable
// (self-hosting). contains() is always safe to call; request() only
// succeeds within a user gesture — most callers here are click handlers, so
// it resolves to false (not a throw) rather than the fetch failing opaquely
// when that's not the case.
async function ensureHostPermission(origin: string): Promise<boolean> {
  const pattern = `${origin}/*`;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const settings = await getSettings();
  const token = await getAuthToken();
  if (!token) {
    throw new Error("Sign in to SaveItUp to use this feature.");
  }
  const origin = new URL(settings.apiBase).origin;
  const hasPermission = await ensureHostPermission(origin);
  if (!hasPermission) {
    throw new Error(`SaveItUp needs permission to reach ${origin}. Open Settings and click "Save settings" to grant it.`);
  }
  const res = await fetch(`${settings.apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers
    }
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function savePage(payload: SavedPagePayload): Promise<InsertPageResult> {
  const res = await authedFetch("/pages", { method: "POST", body: JSON.stringify(payload) });
  return res.json();
}

export async function listPages(opts: {
  q?: string;
  limit?: number;
  folderId?: number;
}): Promise<SavedPageSummary[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.folderId !== undefined) qs.set("folderId", String(opts.folderId));
  qs.set("limit", String(opts.limit ?? 50));
  const res = await authedFetch(`/pages?${qs.toString()}`);
  return res.json();
}

export async function getPage(id: number): Promise<SavedPageRecord> {
  const res = await authedFetch(`/pages/${id}`);
  return res.json();
}

export async function listFolders(): Promise<Folder[]> {
  const res = await authedFetch("/folders");
  return res.json();
}

export async function createFolder(name: string): Promise<Folder> {
  const res = await authedFetch("/folders", { method: "POST", body: JSON.stringify({ name }) });
  return res.json();
}

async function patchPage(
  id: number,
  fields: { noteText?: string; pinned?: boolean; folderId?: number | null }
): Promise<SavedPageRecord> {
  const res = await authedFetch(`/pages/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
  return res.json();
}

export async function setFolder(id: number, folderId: number | null): Promise<SavedPageRecord> {
  return patchPage(id, { folderId });
}

export async function updateNote(id: number, noteText: string): Promise<SavedPageRecord> {
  return patchPage(id, { noteText });
}

export async function setPinned(id: number, pinned: boolean): Promise<SavedPageRecord> {
  return patchPage(id, { pinned });
}

export async function deletePage(id: number): Promise<void> {
  await authedFetch(`/pages/${id}`, { method: "DELETE" });
}

export async function generateSummary(id: number): Promise<SavedPageRecord> {
  const res = await authedFetch(`/pages/${id}/summary`, { method: "POST" });
  return res.json();
}

export async function reclean(id: number): Promise<SavedPageRecord & { unchanged?: boolean }> {
  const res = await authedFetch(`/pages/${id}/reclean`, { method: "POST" });
  return res.json();
}

export async function transformPage(id: number, instruction: string): Promise<{ result: string }> {
  const res = await authedFetch(`/pages/${id}/transform`, {
    method: "POST",
    body: JSON.stringify({ instruction })
  });
  return res.json();
}

export async function extractUrlToMarkdown(
  url: string
): Promise<{ id: number; title: string; markdown: string; duplicateCount: number }> {
  const res = await authedFetch("/url-to-markdown", { method: "POST", body: JSON.stringify({ url }) });
  return res.json();
}

export async function createTabSession(tabs: TabSessionTab[]): Promise<{ id: string }> {
  const res = await authedFetch("/tab-sessions", { method: "POST", body: JSON.stringify({ tabs }) });
  return res.json();
}

export async function chatMessage(
  message: string,
  history: ChatMessage[],
  currentPage?: ChatCurrentPage | null
): Promise<ChatResponse> {
  const res = await authedFetch("/chat", {
    method: "POST",
    body: JSON.stringify({ message, history, currentPage: currentPage ?? null })
  });
  return res.json();
}

export async function explainSelection(
  selection: string,
  pageTitle: string,
  surroundingContext: string
): Promise<ExplainResponse> {
  const res = await authedFetch("/explain", {
    method: "POST",
    body: JSON.stringify({ selection, pageTitle, surroundingContext })
  });
  return res.json();
}

export async function translateSelection(text: string): Promise<{ translation: string }> {
  const res = await authedFetch("/translate", {
    method: "POST",
    body: JSON.stringify({ text })
  });
  return res.json();
}

export async function listPagesByUrl(
  url: string
): Promise<Array<{ id: number; noteText: string; elementSelector: string; highlightText: string | null }>> {
  const qs = new URLSearchParams({ url });
  const res = await authedFetch(`/pages/by-url?${qs.toString()}`);
  return res.json();
}

export async function getAIConfig(): Promise<AISettingsResponse> {
  const res = await authedFetch("/settings/ai");
  return res.json();
}

export async function updateAIConfig(role: AIRole, chain: ProviderModelPair[]): Promise<void> {
  await authedFetch("/settings/ai", { method: "PUT", body: JSON.stringify({ role, chain }) });
}

export async function listAIErrors(): Promise<AIErrorEntry[]> {
  const res = await authedFetch("/settings/errors");
  return res.json();
}

export async function clearAIErrors(): Promise<void> {
  await authedFetch("/settings/errors/clear", { method: "POST" });
}
