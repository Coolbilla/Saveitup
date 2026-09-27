// Low-level direct-Supabase data layer for saved_pages/folders (RLS-scoped by the
// signed-in Supabase Auth user). Split out of api-client.ts so ai/chat.ts (which needs
// getPage for chat retrieval) doesn't have to import back from api-client.ts, which in
// turn imports from ai/chat.ts — that circular pair worked, but was a layering inversion
// worth avoiding as more AI modules get added. Mirrors the row<->camelCase mapping in
// server/src/db.ts's toRecord/toSummary.
import type { SavedPageSummary, SavedPageRecord, Folder } from "./types";
import { getSupabase, ensureSupabaseHostPermission, getCurrentUserId } from "./supabase";

function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data as T;
}

export async function supabaseTable() {
  const granted = await ensureSupabaseHostPermission();
  if (!granted) {
    throw new Error('SaveItUp needs permission to reach Supabase. Open Settings and click "Save settings" to grant it.');
  }
  return getSupabase();
}

const SUMMARY_COLUMNS =
  "id, url, title, domain, created_at, description, transcript, highlight_text, element_selector, note_text, pinned, summary, folder_id, folders(name)";

export function toSummary(row: any): SavedPageSummary {
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

export async function listPagesDirect(opts: { limit?: number; folderIds?: number[] }): Promise<SavedPageSummary[]> {
  const supabase = await supabaseTable();
  const limit = opts.limit ?? 50;
  let query = supabase.from("saved_pages").select(SUMMARY_COLUMNS).order("created_at", { ascending: false }).range(0, limit - 1);
  if (opts.folderIds && opts.folderIds.length > 0) query = query.in("folder_id", opts.folderIds);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toSummary);
}

export async function getPage(id: number): Promise<SavedPageRecord> {
  const supabase = await supabaseTable();
  const row = unwrap(await supabase.from("saved_pages").select("*").eq("id", id).maybeSingle());
  if (!row) throw new Error("Request failed: 404 not found");
  return toRecord(row);
}

type FolderRow = { id: number; name: string; parent_id: number | null };
const toFolder = (row: FolderRow): Folder => ({ id: row.id, name: row.name, parentId: row.parent_id ?? null });

export async function listFolders(): Promise<Folder[]> {
  const supabase = await supabaseTable();
  const rows = unwrap(await supabase.from("folders").select("id, name, parent_id").order("name", { ascending: true })) ?? [];
  return (rows as FolderRow[]).map(toFolder);
}

export async function createFolder(name: string, parentId: number | null = null): Promise<Folder> {
  const supabase = await supabaseTable();
  // folders.user_id has no column default, and the RLS insert policy requires it to equal
  // the caller's own id — omitting it (as this used to) makes every insert fail the check.
  const userId = await getCurrentUserId();
  if (!userId) throw new Error("Sign in to SaveItUp to create folders.");
  return toFolder(
    unwrap(
      await supabase.from("folders").insert({ name, parent_id: parentId, user_id: userId }).select("id, name, parent_id").single()
    ) as FolderRow
  );
}

export async function renameFolder(id: number, name: string): Promise<void> {
  const supabase = await supabaseTable();
  const { error } = await supabase.from("folders").update({ name }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function moveFolder(id: number, parentId: number | null): Promise<void> {
  const supabase = await supabaseTable();
  const { error } = await supabase.from("folders").update({ parent_id: parentId }).eq("id", id);
  if (error) throw new Error(error.message);
}

// Subfolders cascade-delete in the DB; pages in them become unfiled (ON DELETE SET NULL).
export async function deleteFolder(id: number): Promise<void> {
  const supabase = await supabaseTable();
  const { error } = await supabase.from("folders").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** "Work / Reading" — the folder's name prefixed by its ancestors'. */
export function folderPath(folders: Folder[], id: number): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur = byId.get(id);
  for (let guard = 0; cur && guard < 50; guard++) {
    parts.unshift(cur.name);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return parts.join(" / ");
}

/** The folder itself plus every folder nested anywhere beneath it. */
export function withDescendantIds(folders: Folder[], id: number): number[] {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    for (const f of folders) if (f.parentId === ids[i] && !ids.includes(f.id)) ids.push(f.id);
  }
  return ids;
}

/** Depth-first order (each folder right after its parent) with a display path and depth. */
export function folderTree(folders: Folder[]): Array<{ folder: Folder; path: string; depth: number }> {
  const out: Array<{ folder: Folder; path: string; depth: number }> = [];
  const walk = (parentId: number | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parentId)) {
      out.push({ folder: f, path: folderPath(folders, f.id), depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export async function patchPage(
  id: number,
  fields: { noteText?: string; pinned?: boolean; folderId?: number | null }
): Promise<SavedPageRecord> {
  const update: Record<string, unknown> = {};
  if (fields.noteText !== undefined) update.note_text = fields.noteText;
  if (fields.pinned !== undefined) update.pinned = fields.pinned;
  if (fields.folderId !== undefined) update.folder_id = fields.folderId;
  return updatePageRaw(id, update);
}

export async function updatePageRaw(id: number, columns: Record<string, unknown>): Promise<SavedPageRecord> {
  const supabase = await supabaseTable();
  const row = unwrap(await supabase.from("saved_pages").update(columns).eq("id", id).select("*").maybeSingle());
  if (!row) throw new Error("Request failed: 404 not found");
  return toRecord(row);
}

export async function deletePage(id: number): Promise<void> {
  const supabase = await supabaseTable();
  const { error } = await supabase.from("saved_pages").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function listPagesByUrl(
  url: string
): Promise<Array<{ id: number; noteText: string; elementSelector: string; highlightText: string | null }>> {
  const supabase = await supabaseTable();
  const rows = unwrap(
    await supabase
      .from("saved_pages")
      .select("id, note_text, element_selector, highlight_text")
      .eq("url", url)
      .not("note_text", "is", null)
      .not("element_selector", "is", null)
  ) as any[];
  return (rows ?? []).map((row) => ({
    id: row.id,
    noteText: row.note_text,
    elementSelector: row.element_selector,
    highlightText: row.highlight_text
  }));
}

/** Find-or-create a nested folder from path segments (["Work","Reading"]); returns the leaf id. */
export async function ensureFolderPath(segments: string[], folders?: Folder[]): Promise<number | null> {
  const all = folders ?? (await listFolders());
  let parentId: number | null = null;
  for (const name of segments.map((s) => s.trim()).filter(Boolean)) {
    let f: Folder | undefined = all.find((x) => x.parentId === parentId && x.name === name);
    if (!f) {
      f = await createFolder(name, parentId);
      all.push(f);
    }
    parentId = f.id;
  }
  return parentId;
}

const STOPWORDS = new Set(
  "a an the and or but if of to in on at by for with about from as is are was were be been do did does done have has had i me my we you your it its this that these those what which who whom when where why how can could should would will just please tell show find give any all some saved save saves page pages tab article articles".split(
    " "
  )
);

/** Meaningful words of a natural-language question ("what did I save about rust lifetimes?" -> rust, lifetimes). */
export function keywordsOf(question: string): string[] {
  const words = question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 8);
}

/**
 * Keyword search for chat retrieval, returning ids (newest first). The question is reduced to its
 * keywords and OR-ed — passing the whole sentence to websearch ANDs every word (including "what
 * did I save about"), which matches nothing. Falls back to a title/URL substring match.
 */
export async function searchPageIds(q: string, limit: number): Promise<number[]> {
  const words = keywordsOf(q);
  if (words.length === 0) return [];
  const supabase = await supabaseTable();
  const { data, error } = await supabase
    .from("saved_pages")
    .select("id")
    .textSearch("search_vector", words.join(" or "), { type: "websearch" })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  if (data && data.length > 0) return data.map((r: { id: number }) => r.id);

  const like = words.map((w) => `title.ilike.%${w.replace(/[%,()]/g, "")}%,url.ilike.%${w.replace(/[%,()]/g, "")}%`).join(",");
  const { data: fallback, error: err2 } = await supabase
    .from("saved_pages")
    .select("id")
    .or(like)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (err2) throw new Error(err2.message);
  return (fallback ?? []).map((r: { id: number }) => r.id);
}

/** Semantic search over the caller's own saves (RLS also scopes the RPC). */
export async function matchSavedPages(queryEmbedding: number[], matchCount: number): Promise<number[]> {
  const userId = await getCurrentUserId();
  if (!userId) return [];
  const { data, error } = await getSupabase().rpc("match_saved_pages", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    match_user_id: userId
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: { id: number }) => row.id);
}
