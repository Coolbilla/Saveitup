// Library-wide maintenance jobs that run from Settings: full export and re-embedding.
import { supabaseTable, listFolders, folderPath } from "./pages-data";
import { generateEmbedding } from "./ai/embeddings";

const BATCH = 100;

/** Every saved page (all columns except the embedding vector) plus the folder tree, as one JSON string. */
export async function exportEverything(onProgress?: (n: number) => void): Promise<{ json: string; count: number }> {
  const supabase = await supabaseTable();
  const folders = await listFolders();
  const pages: Record<string, unknown>[] = [];
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("saved_pages")
      .select("id, url, title, domain, page_content, cleaned_content, description, transcript, highlight_text, highlight_context, element_selector, note_text, summary, pinned, folder_id, created_at")
      .order("id", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) pages.push({ ...row, folder_path: row.folder_id ? folderPath(folders, row.folder_id) : null });
    onProgress?.(pages.length);
    if (!data || data.length < BATCH) break;
  }
  return { json: JSON.stringify({ exportedAt: new Date().toISOString(), folders, pages }, null, 2), count: pages.length };
}

/** Embeds every page that has no embedding yet using the configured embeddings role. */
export async function reembedMissing(
  onProgress: (done: number, failed: number) => void,
  cancel: { stop: boolean }
): Promise<{ done: number; failed: number }> {
  const supabase = await supabaseTable();
  let done = 0;
  let failed = 0;
  const skip = new Set<number>(); // failed ids, so a persistent failure can't loop forever
  while (!cancel.stop) {
    const { data, error } = await supabase
      .from("saved_pages")
      .select("id, title, description, page_content")
      .is("embedding", null)
      .order("id", { ascending: true })
      .limit(20 + skip.size);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).filter((r: { id: number }) => !skip.has(r.id)).slice(0, 20);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (cancel.stop) break;
      try {
        const vec = await generateEmbedding([r.title, r.description, r.page_content].filter(Boolean).join("\n\n"));
        if (!vec) throw new Error("no embeddings provider configured");
        const { error: upErr } = await supabase.from("saved_pages").update({ embedding: vec }).eq("id", r.id);
        if (upErr) throw new Error(upErr.message);
        done++;
      } catch (err) {
        failed++;
        skip.add(r.id);
        if (failed === 1 && done === 0) throw err; // first attempt failing = misconfiguration; surface it
      }
      onProgress(done, failed);
    }
  }
  return { done, failed };
}
