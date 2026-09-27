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

import { getAuthToken } from "./supabase";
import { answerChat, explainSelection as aiExplainSelection, translateSelection as aiTranslateSelection } from "./ai/chat";
import { generateSummary as aiGenerateSummary } from "./ai/summarize";
import { cleanMarkdownDetailed, transformContent } from "./ai/cleanup";
import {
  getAllRoleConfig,
  setRoleConfig,
  listAIErrors as aiListAIErrors,
  clearAIErrors as aiClearAIErrors,
  KNOWN_PROVIDERS
} from "./ai/settings";
import {
  listPagesDirect,
  getPage,
  listFolders as listFoldersDirect,
  createFolder as createFolderDirect,
  renameFolder,
  moveFolder,
  deleteFolder,
  folderPath,
  withDescendantIds,
  folderTree,
  ensureFolderPath,
  patchPage,
  updatePageRaw,
  deletePage as deletePageDirect,
  listPagesByUrl as listPagesByUrlDirect
} from "./pages-data";
import { groupTranscript, segmentsFromFlat, parseChaptersFromDescription } from "../../../shared/src/youtube-format";
import { reformatLegacyYouTube } from "../../../shared/src/youtube-legacy";
import { enqueueSave, getQueuedSaves, removeQueuedSave } from "./save-queue";

export { getQueuedSaves };

export { getPage };

export interface ExtensionSettings {
  apiBase: string;
  /** Optional public origin for links you share with other people; falls back to apiBase. */
  publicBase: string;
}

// Set SAVEITUP_DEFAULT_API_BASE in .env before a production build to ship a
// real default — falls back to the local dev server when unset so nothing
// changes for local development.
const DEFAULT_API_BASE = process.env.SAVEITUP_DEFAULT_API_BASE || "http://localhost:3001";

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(["apiBase", "publicBase"]);
  const apiBase = stored.apiBase || DEFAULT_API_BASE;
  return { apiBase, publicBase: (stored.publicBase || apiBase).replace(/\/+$/, "") };
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

// Unauthenticated, permission-agnostic reachability check — used to show a
// clear "server not running" state instead of letting every feature that
// touches Express (save, AI, search, tab-sessions) fail with a raw fetch
// error. Doesn't request host permission itself: a denied/ungranted
// permission and an unreachable server both just read as "not reachable"
// here, which is the right answer for a status indicator (the explicit
// "test connection" flow in Settings is where permission gets requested).
export async function checkServerHealth(): Promise<boolean> {
  const health = await getServerHealth();
  return health !== null;
}

// null means unreachable/unknown; otherwise tells the search box whether a typed
// query gets embedding-based ranking or falls back to plain full-text search —
// that distinction is silent server-side config, otherwise invisible client-side.
export async function getServerHealth(): Promise<{ semanticSearch: boolean } | null> {
  try {
    const settings = await getSettings();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${settings.apiBase}/health`, { signal: controller.signal });
      if (!res.ok) return null;
      const body = await res.json();
      return { semanticSearch: !!body.semanticSearch };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

export async function savePage(payload: SavedPagePayload): Promise<InsertPageResult> {
  const res = await authedFetch("/pages", { method: "POST", body: JSON.stringify(payload) });
  return res.json();
}

// fetch() throws a TypeError specifically for network-level failures (DNS, connection
// refused, offline) — before any Response ever comes back. authedFetch's own thrown
// errors (auth/permission/4xx/5xx) are plain Error instances, not TypeError, so this
// reliably tells "server unreachable" apart from "server responded, and said no" —
// only the former is worth queuing and retrying later with the same payload.
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export type SaveResult = ({ queued: false } & InsertPageResult) | { queued: true };

export async function saveOrQueue(payload: SavedPagePayload): Promise<SaveResult> {
  try {
    const result = await savePage(payload);
    return { queued: false, ...result };
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueueSave(payload);
      return { queued: true };
    }
    throw err;
  }
}

// Called on a timer (background.ts) and whenever the server-status banner sees the
// server come back up — retries every queued save, keeping only the ones that still fail.
export async function retryQueuedSaves(): Promise<{ succeeded: number; remaining: number }> {
  const queue = await getQueuedSaves();
  let succeeded = 0;
  for (const item of queue) {
    try {
      await savePage(item.payload);
      await removeQueuedSave(item.queuedAt);
      succeeded++;
    } catch (err) {
      if (!isNetworkError(err)) {
        // The server is reachable but rejected this payload outright (not a connectivity
        // issue) — retrying it again later won't change that, so drop it rather than
        // queuing forever.
        await removeQueuedSave(item.queuedAt);
      }
    }
  }
  const remaining = (await getQueuedSaves()).length;
  return { succeeded, remaining };
}

export async function listPages(opts: {
  q?: string;
  limit?: number;
  folderIds?: number[];
}): Promise<SavedPageSummary[]> {
  // A search query goes through the server, not direct-to-Supabase: /pages?q=
  // does embedding-based semantic ranking when EMBEDDING_PROVIDER is
  // configured (which needs a server-held provider key the extension can't
  // hold), and falls back to the same plain full-text search otherwise — so
  // this is never worse, and sometimes meaningfully better, than searching
  // directly. Plain listing/filtering (no query) stays on the direct-Supabase
  // path from Phase 1.
  if (opts.q) {
    const qs = new URLSearchParams();
    qs.set("q", opts.q);
    if (opts.folderIds && opts.folderIds.length > 0) qs.set("folderId", opts.folderIds.join(","));
    qs.set("limit", String(opts.limit ?? 50));
    const res = await authedFetch(`/pages?${qs.toString()}`);
    return res.json();
  }

  return listPagesDirect(opts);
}

export { renameFolder, moveFolder, deleteFolder, folderPath, withDescendantIds, folderTree, ensureFolderPath };

export async function listFolders(): Promise<Folder[]> {
  return listFoldersDirect();
}

export async function createFolder(name: string, parentId: number | null = null): Promise<Folder> {
  return createFolderDirect(name, parentId);
}

function buildCleanupSource(pageContent: string, description?: string | null, transcript?: string | null): string {
  const parts = [pageContent];
  if (description) parts.push(`## Description\n\n${description}`);
  if (transcript) parts.push(`## Transcript\n\n${transcript}`);
  return parts.join("\n\n");
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

export async function updatePageTitle(id: number, title: string): Promise<SavedPageRecord> {
  return updatePageRaw(id, { title });
}

export async function updatePageContent(id: number, cleanedContent: string): Promise<SavedPageRecord> {
  return updatePageRaw(id, { cleaned_content: cleanedContent });
}

export async function updateTranscript(id: number, transcript: string): Promise<SavedPageRecord> {
  return updatePageRaw(id, { transcript });
}

export async function deletePage(id: number): Promise<void> {
  return deletePageDirect(id);
}

export async function generateSummary(id: number): Promise<SavedPageRecord> {
  const page = await getPage(id);
  const summary = await aiGenerateSummary({
    title: page.title,
    description: page.description,
    transcript: page.transcript,
    pageContent: page.pageContent
  });
  return updatePageRaw(id, { summary });
}

export interface RecleanReport {
  configured: boolean;
  chunks: number;
  cleanedChunks: number;
  before: number;
  after: number;
  sameText: boolean;
}

export async function reclean(id: number): Promise<SavedPageRecord & { unchanged?: boolean; report?: RecleanReport; message?: string }> {
  const page = await getPage(id);
  // YouTube pages are formatted by code, not AI: rebuild an old flattened capture into the fixed layout
  // (description, chapters, grouped Links) and re-group a flat transcript into paragraphs.
  if (/(?:youtube\.com|youtu\.be)/.test(page.url)) {
    const u = new URL(page.url);
    const videoId = u.searchParams.get("v") || u.pathname.replace("/", "");
    const alreadyFormatted = /^# .*\n[\s\S]*\[Watch on YouTube\]\(/.test(page.cleanedContent ?? page.pageContent);
    const changes: Record<string, unknown> = {};
    const notes: string[] = [];
    if (!alreadyFormatted && videoId) {
      changes.cleaned_content = reformatLegacyYouTube(page.pageContent, { title: page.title, videoId, url: page.url });
      notes.push("page rebuilt in the YouTube layout");
    }
    if (page.transcript && !/^### |\]\(https:\/\/youtu\.be\//m.test(page.transcript)) {
      changes.transcript = groupTranscript(segmentsFromFlat(page.transcript), parseChaptersFromDescription(page.description ?? ""), videoId);
      notes.push("transcript grouped into paragraphs");
    }
    if (Object.keys(changes).length === 0) {
      return { ...page, unchanged: true, message: "Already in the YouTube format. Nothing to change." };
    }
    const record = await updatePageRaw(id, changes);
    return { ...record, unchanged: false, message: `Reformatted: ${notes.join(", ")}.` };
  }
  const source = buildCleanupSource(page.pageContent, page.description, page.transcript);
  const detailed = await cleanMarkdownDetailed({ title: page.title, pageContent: source });
  const cleaned = detailed.text;
  const record = await updatePageRaw(id, { cleaned_content: cleaned });
  const previous = page.cleanedContent ?? page.pageContent;
  return {
    ...record,
    unchanged: cleaned === source,
    report: {
      configured: detailed.configured,
      chunks: detailed.chunks,
      cleanedChunks: detailed.cleanedChunks,
      before: previous.length,
      after: cleaned.length,
      sameText: cleaned === previous
    }
  };
}

export async function transformPage(id: number, instruction: string): Promise<{ result: string }> {
  const page = await getPage(id);
  const result = await transformContent({ content: page.cleanedContent ?? page.pageContent, instruction });
  return { result };
}

export async function extractUrlToMarkdown(
  url: string,
  folderId?: number
): Promise<{ id: number; title: string; markdown: string; duplicateCount: number }> {
  const res = await authedFetch("/url-to-markdown", { method: "POST", body: JSON.stringify({ url, folderId }) });
  return res.json();
}

export async function createTabSession(tabs: TabSessionTab[]): Promise<{ id: string }> {
  const res = await authedFetch("/tab-sessions", { method: "POST", body: JSON.stringify({ tabs }) });
  return res.json();
}

// Public share link for a single saved page — stays server-side (like tab-sessions),
// since it needs to be openable by someone with no extension installed and no RLS access.
export async function createPageShare(id: number): Promise<{ id: string }> {
  const res = await authedFetch(`/pages/${id}/share`, { method: "POST" });
  return res.json();
}

/** True when a link points at this machine, so nobody else can open it. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".local");
  } catch {
    return false;
  }
}

export async function getShareUrl(shareId: string): Promise<string> {
  const { publicBase } = await getSettings();
  return `${publicBase}/shared/${shareId}`;
}

export { testRoleModel } from "./ai/chat";

export async function chatMessage(
  message: string,
  history: ChatMessage[],
  currentPage?: ChatCurrentPage | null,
  run?: { onToken?: (delta: string) => void; signal?: AbortSignal }
): Promise<ChatResponse> {
  return answerChat({ message, history, currentPage: currentPage ?? null }, run);
}

export async function explainSelection(
  selection: string,
  pageTitle: string,
  surroundingContext: string
): Promise<ExplainResponse> {
  const explanation = await aiExplainSelection({ selection, pageTitle, surroundingContext });
  return { explanation };
}

export async function translateSelection(text: string): Promise<{ translation: string }> {
  const translation = await aiTranslateSelection(text);
  return { translation };
}

export async function listPagesByUrl(
  url: string
): Promise<Array<{ id: number; noteText: string; elementSelector: string; highlightText: string | null }>> {
  return listPagesByUrlDirect(url);
}

const CONFIGURABLE_ROLES: AIRole[] = ["cleanup", "summarize", "chat", "embeddings"];

export async function getAIConfig(): Promise<AISettingsResponse> {
  const allRoles = await getAllRoleConfig();
  const roles = {} as Record<AIRole, { chain: ProviderModelPair[] } | null>;
  for (const role of CONFIGURABLE_ROLES) {
    const sel = allRoles[role];
    roles[role] = sel ? { chain: [{ provider: sel.provider, model: sel.model || "" }] } : null;
  }
  roles.categorize = null;
  return { roles, knownProviders: [...KNOWN_PROVIDERS], envDefaults: {} as Record<AIRole, string> };
}

export async function updateAIConfig(role: AIRole, chain: ProviderModelPair[]): Promise<void> {
  const pair = chain[0];
  await setRoleConfig(role, pair ? { provider: pair.provider, model: pair.model || undefined } : null);
}

export async function listAIErrors(): Promise<AIErrorEntry[]> {
  return aiListAIErrors();
}

export async function clearAIErrors(): Promise<void> {
  await aiClearAIErrors();
}
