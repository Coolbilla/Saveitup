// Page-level actions that combine the data layer with the AI modules (same logic as the
// extension's api-client wrappers), plus library search.
import type { SavedPageRecord, SavedPageSummary } from "./types";
import { supabaseTable, toSummary, getPage, updatePageRaw, listPagesDirect, withDescendantIds, listFolders } from "./db";
import { generateSummary } from "./ai/summarize";
import { cleanMarkdownDetailed } from "./ai/cleanup";
import { serverSearch } from "./api";

const SUMMARY_COLUMNS =
  "id, url, title, domain, created_at, description, transcript, highlight_text, element_selector, note_text, pinned, summary, folder_id, folders(name)";

/** Library query: server search (semantic when configured) → direct full-text → plain list. */
export async function queryLibrary(opts: { q: string; limit: number; folderId: number | null }): Promise<SavedPageSummary[]> {
  const folderIds = opts.folderId !== null ? withDescendantIds(await listFolders(), opts.folderId) : null;
  if (!opts.q) return listPagesDirect({ limit: opts.limit, folderIds: folderIds ?? undefined });

  const remote = await serverSearch(opts.q, opts.limit, folderIds);
  if (remote) return remote as SavedPageSummary[];

  const supabase = await supabaseTable();
  let query = supabase
    .from("saved_pages")
    .select(SUMMARY_COLUMNS)
    .textSearch("search_vector", opts.q, { type: "websearch" })
    .order("created_at", { ascending: false })
    .limit(opts.limit);
  if (folderIds) query = query.in("folder_id", folderIds);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toSummary);
}

export async function summarizePage(id: number): Promise<SavedPageRecord> {
  const page = await getPage(id);
  const summary = await generateSummary({
    title: page.title,
    description: page.description,
    transcript: page.transcript,
    pageContent: page.pageContent
  });
  return updatePageRaw(id, { summary });
}

export async function recleanPage(id: number): Promise<{ record: SavedPageRecord; message: string }> {
  const page = await getPage(id);
  const parts = [page.pageContent];
  if (page.description) parts.push(`## Description\n\n${page.description}`);
  if (page.transcript) parts.push(`## Transcript\n\n${page.transcript}`);
  const r = await cleanMarkdownDetailed({ title: page.title, pageContent: parts.join("\n\n") });
  const record = await updatePageRaw(id, { cleaned_content: r.text });
  const before = (page.cleanedContent ?? page.pageContent).length;
  let message: string;
  if (!r.configured) message = "No Cleanup AI is set, so only spacing was tidied. Choose one in Settings.";
  else if (r.cleanedChunks === 0) message = "The AI couldn't clean this page (its answers looked wrong), so nothing changed.";
  else if (r.text === (page.cleanedContent ?? page.pageContent)) message = "Already clean. The AI found nothing to remove.";
  else message = `Cleaned: removed ${(before - r.text.length).toLocaleString()} characters`;
  return { record, message };
}
