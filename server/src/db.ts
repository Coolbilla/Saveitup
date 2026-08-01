import { createClient } from "@supabase/supabase-js";
import type { Folder, SavedPagePayload, SavedPageRecord, SavedPageSummary, TabSession, TabSessionTab } from "../../shared/src/types";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

const supabase = createClient(supabaseUrl, supabaseKey);

function toRecord(row: any): SavedPageRecord {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    pageContent: row.page_content,
    description: row.description,
    transcript: row.transcript,
    highlightText: row.highlight_text,
    highlightContext: row.highlight_context,
    elementSelector: row.element_selector,
    noteText: row.note_text,
    createdAt: row.created_at,
    pinned: !!row.pinned,
    summary: row.summary,
    folderId: row.folder_id ?? null,
    cleanedContent: row.cleaned_content ?? null
  };
}

export async function insertPage(userId: string, payload: SavedPagePayload): Promise<{ id: number; duplicateCount: number }> {
  const { data, error } = await supabase
    .from("saved_pages")
    .insert({
      user_id: userId,
      url: payload.url,
      title: payload.title,
      domain: payload.domain,
      page_content: payload.pageContent,
      description: payload.description ?? null,
      transcript: payload.transcript ?? null,
      highlight_text: payload.highlightText ?? null,
      highlight_context: payload.highlightContext ?? null,
      element_selector: payload.elementSelector ?? null,
      note_text: payload.noteText ?? null,
      folder_id: payload.folderId ?? null
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  // Counted after the insert (which already committed our own row), so the
  // window for a concurrent save of the same URL to be missed is negligible
  // instead of guaranteed, as it was when this count ran before the insert.
  const { count: totalCount, error: countError } = await supabase
    .from("saved_pages")
    .select("id", { count: "exact", head: true })
    .eq("url", payload.url)
    .eq("user_id", userId);
  if (countError) throw new Error(countError.message);

  return { id: data.id, duplicateCount: Math.max((totalCount ?? 1) - 1, 0) };
}

function toSummary(row: any): SavedPageSummary {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    createdAt: row.created_at,
    hasDescription: !!row.description,
    hasTranscript: !!row.transcript,
    hasHighlight: !!row.highlight_text,
    hasElementSelector: !!row.element_selector,
    hasNote: !!row.note_text,
    hasSummary: !!row.summary,
    pinned: !!row.pinned,
    folderId: row.folder_id ?? null,
    folderName: row.folders?.name ?? null
  };
}

const SUMMARY_COLUMNS =
  "id, url, title, domain, created_at, description, transcript, highlight_text, element_selector, note_text, pinned, summary, folder_id, folders(name)";

export async function listPages(
  userId: string,
  opts: {
    limit?: number;
    offset?: number;
    domain?: string;
    q?: string;
    folderId?: number;
  }
): Promise<SavedPageSummary[]> {
  const embeddingProvider = (process.env.EMBEDDING_PROVIDER || "none").toLowerCase();
  if (opts.q && embeddingProvider !== "none") {
    const { generateEmbedding } = await import("./lib/embeddings.js");
    const queryEmbedding = await generateEmbedding(userId, opts.q);
    if (queryEmbedding) {
      const matchCount = (opts.offset ?? 0) + (opts.limit ?? 50);
      const orderedIds = await matchSavedPages(userId, queryEmbedding, matchCount);
      if (orderedIds.length === 0) return [];

      let query = supabase.from("saved_pages").select(SUMMARY_COLUMNS).eq("user_id", userId).in("id", orderedIds);
      if (opts.domain) query = query.eq("domain", opts.domain);
      if (opts.folderId !== undefined) query = query.eq("folder_id", opts.folderId);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const byId = new Map((data ?? []).map((row) => [row.id, row]));
      const ordered = orderedIds.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => !!row);
      const page = ordered.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
      return page.map(toSummary);
    }
  }

  let query = supabase
    .from("saved_pages")
    .select(SUMMARY_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50) - 1);

  if (opts.domain) query = query.eq("domain", opts.domain);
  if (opts.folderId !== undefined) query = query.eq("folder_id", opts.folderId);
  if (opts.q) {
    query = query.textSearch("search_vector", opts.q, { type: "websearch" });
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toSummary);
}

export async function getPage(userId: string, id: number): Promise<SavedPageRecord | null> {
  const { data, error } = await supabase.from("saved_pages").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toRecord(data) : null;
}

export async function updatePage(
  userId: string,
  id: number,
  fields: { noteText?: string; pinned?: boolean; folderId?: number | null }
): Promise<SavedPageRecord | null> {
  const update: Record<string, unknown> = {};
  if (fields.noteText !== undefined) update.note_text = fields.noteText;
  if (fields.pinned !== undefined) update.pinned = fields.pinned;
  if (fields.folderId !== undefined) update.folder_id = fields.folderId;

  const { data, error } = await supabase
    .from("saved_pages")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toRecord(data) : null;
}

export async function updateSummary(userId: string, id: number, summary: string): Promise<SavedPageRecord | null> {
  const { data, error } = await supabase
    .from("saved_pages")
    .update({ summary })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toRecord(data) : null;
}

export async function updateCleanedContent(userId: string, id: number, cleanedContent: string): Promise<SavedPageRecord | null> {
  const { data, error } = await supabase
    .from("saved_pages")
    .update({ cleaned_content: cleanedContent })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toRecord(data) : null;
}

export async function updateEmbedding(userId: string, id: number, embedding: number[]): Promise<void> {
  const { error } = await supabase.from("saved_pages").update({ embedding }).eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function matchSavedPages(userId: string, queryEmbedding: number[], matchCount: number): Promise<number[]> {
  const { data, error } = await supabase.rpc("match_saved_pages", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    match_user_id: userId
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: { id: number }) => row.id);
}

export async function getPagesByUrl(
  userId: string,
  url: string
): Promise<Array<{ id: number; noteText: string; elementSelector: string; highlightText: string | null }>> {
  const { data, error } = await supabase
    .from("saved_pages")
    .select("id, note_text, element_selector, highlight_text")
    .eq("url", url)
    .eq("user_id", userId)
    .not("note_text", "is", null)
    .not("element_selector", "is", null);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id,
    noteText: row.note_text,
    elementSelector: row.element_selector,
    highlightText: row.highlight_text
  }));
}

export async function deletePage(userId: string, id: number): Promise<boolean> {
  const { data, error } = await supabase.from("saved_pages").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function createTabSession(userId: string, tabs: TabSessionTab[]): Promise<{ id: string }> {
  const { data, error } = await supabase.from("tab_sessions").insert({ tabs, user_id: userId }).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id };
}

// Deliberately NOT scoped by user: tab-session share links (GET /tab-sessions/:id,
// GET /open/:id) are intentionally public to anyone with the link, regardless of
// who's signed in. Do not add a userId filter here.
export async function getTabSession(id: string): Promise<TabSession | null> {
  const { data, error } = await supabase
    .from("tab_sessions")
    .select("id, tabs, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { id: data.id, tabs: data.tabs, createdAt: data.created_at } : null;
}

export async function listFolders(userId: string): Promise<Folder[]> {
  const { data, error } = await supabase
    .from("folders")
    .select("id, name")
    .eq("user_id", userId)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createFolder(userId: string, name: string): Promise<Folder> {
  const { data, error } = await supabase.from("folders").insert({ name, user_id: userId }).select("id, name").single();
  if (error) throw new Error(error.message);
  return data;
}

export async function findOrCreateFolder(userId: string, name: string): Promise<Folder> {
  const { data: existing, error: findError } = await supabase
    .from("folders")
    .select("id, name")
    .eq("name", name)
    .eq("user_id", userId)
    .maybeSingle();
  if (findError) throw new Error(findError.message);
  if (existing) return existing;
  return createFolder(userId, name);
}

export async function getUserRoleConfig(userId: string, role: string): Promise<{ chain: unknown[] } | null> {
  const { data, error } = await supabase
    .from("user_ai_settings")
    .select("chain")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { chain: data.chain } : null;
}

export async function setUserRoleConfig(userId: string, role: string, chain: unknown[]): Promise<void> {
  const { error } = await supabase
    .from("user_ai_settings")
    .upsert({ user_id: userId, role, chain, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function recordAIErrorRow(
  userId: string,
  role: string,
  provider: string,
  model: string,
  message: string
): Promise<void> {
  const { error } = await supabase.from("ai_error_log").insert({ user_id: userId, role, provider, model, message });
  if (error) throw new Error(error.message);
}

export async function listAIErrorRows(
  userId: string
): Promise<Array<{ timestamp: string; role: string; provider: string; model: string; message: string }>> {
  const { data, error } = await supabase
    .from("ai_error_log")
    .select("role, provider, model, message, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    timestamp: row.created_at,
    role: row.role,
    provider: row.provider,
    model: row.model,
    message: row.message
  }));
}

export async function clearAIErrorRows(userId: string): Promise<void> {
  const { error } = await supabase.from("ai_error_log").delete().eq("user_id", userId);
  if (error) throw new Error(error.message);
}
