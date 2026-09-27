// Bookmark import: Chrome bookmarks or a Netscape bookmarks.html export -> saved pages,
// bookmark folders -> nested folders. Each page goes through the server's /url-to-markdown
// (fetch + AI cleanup + embed), so it's slow and costs AI credits; the job is persisted so
// closing the side panel pauses instead of losing it. The loop runs in the panel (an MV3
// service worker can't be trusted to live for a multi-hour job).
import { extractUrlToMarkdown } from "./api-client";
import { supabaseTable, ensureFolderPath, listFolders } from "./pages-data";

export interface BookmarkItem {
  url: string;
  title: string;
  path: string[];
}

export interface ImportJob {
  items: BookmarkItem[];
  done: number;
  skipped: number;
  failed: Array<{ item: BookmarkItem; error: string }>;
  next: number;
}

const KEY = "bookmarkImportJob";
const CONCURRENCY = 2;

export async function loadJob(): Promise<ImportJob | null> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as ImportJob | undefined) ?? null;
}
const saveJob = (job: ImportJob) => chrome.storage.local.set({ [KEY]: job });
export const clearJob = () => chrome.storage.local.remove(KEY);

const isWeb = (u: string) => /^https?:\/\//i.test(u);

export async function readChromeBookmarks(): Promise<BookmarkItem[]> {
  const items: BookmarkItem[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]) => {
    for (const n of nodes) {
      if (n.children) walk(n.children, n.title ? [...path, n.title] : path);
      else if (n.url && isWeb(n.url)) items.push({ url: n.url, title: n.title || n.url, path });
    }
  };
  walk(await chrome.bookmarks.getTree(), []);
  return items;
}

export function parseBookmarksHtml(html: string): BookmarkItem[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items: BookmarkItem[] = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const url = a.getAttribute("href") ?? "";
    if (!isWeb(url)) return;
    // Each enclosing <DL> is titled by the <H3> just before it.
    const path: string[] = [];
    for (let el = a.parentElement; el; el = el.parentElement) {
      if (el.tagName !== "DL") continue;
      const h3 = el.previousElementSibling?.tagName === "H3" ? el.previousElementSibling : el.parentElement?.querySelector(":scope > h3");
      if (h3?.textContent?.trim()) path.unshift(h3.textContent.trim());
    }
    items.push({ url, title: a.textContent?.trim() || url, path });
  });
  return items;
}

/** Drops duplicate URLs within the list and ones already saved; returns the job to run. */
export async function buildJob(all: BookmarkItem[]): Promise<ImportJob> {
  const seen = new Set<string>();
  const unique = all.filter((i) => !seen.has(i.url) && seen.add(i.url));
  const supabase = await supabaseTable();
  const saved = new Set<string>();
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase
      .from("saved_pages")
      .select("url")
      .in("url", unique.slice(i, i + 100).map((x) => x.url));
    if (error) throw new Error(error.message);
    (data ?? []).forEach((r: { url: string }) => saved.add(r.url));
  }
  const items = unique.filter((i) => !saved.has(i.url));
  const job: ImportJob = { items, done: 0, skipped: all.length - items.length, failed: [], next: 0 };
  await saveJob(job);
  return job;
}

/** Runs (or resumes) the job. Stops promptly when `cancel.stop` is set; state stays saved. */
export async function runJob(job: ImportJob, cancel: { stop: boolean }, onProgress: (j: ImportJob) => void): Promise<void> {
  // Folders are created up front, one at a time, so parallel workers never race to create the same one.
  const folders = await listFolders();
  const folderIds = new Map<string, number | null>();
  for (const item of job.items.slice(job.next)) {
    const key = item.path.join("/");
    if (!folderIds.has(key)) folderIds.set(key, await ensureFolderPath(item.path, folders));
  }

  const worker = async () => {
    while (!cancel.stop && job.next < job.items.length) {
      const item = job.items[job.next++];
      try {
        await extractUrlToMarkdown(item.url, folderIds.get(item.path.join("/")) ?? undefined);
        job.done++;
      } catch (err) {
        job.failed.push({ item, error: (err as Error).message });
      }
      await saveJob(job);
      onProgress(job);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** Re-queues failed items after the current end of the list. */
export async function retryFailed(job: ImportJob): Promise<void> {
  job.items.push(...job.failed.map((f) => f.item));
  job.failed = [];
  await saveJob(job);
}
