// Calls to the SaveItUp server (needed for saving by URL, sharing and semantic search).
import { getAuthToken } from "./supabase";
import { enqueueSave, getQueue, setQueue } from "./offline";

export const getApiBase = () =>
  (localStorage.getItem("apiBase") || (import.meta.env.VITE_API_BASE as string) || "").replace(/\/+$/, "");
export const getPublicBase = () => (localStorage.getItem("publicBase") || getApiBase()).replace(/\/+$/, "");

export class NetworkError extends Error {}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getApiBase();
  if (!base) throw new Error("Set your SaveItUp server address in Settings first.");
  const token = await getAuthToken();
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
    });
  } catch {
    throw new NetworkError("Couldn't reach the server.");
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Server said ${res.status}`);
  return body as T;
}

export interface SavedUrl { id: number; title: string; markdown: string; duplicateCount: number }

export async function saveUrl(url: string, folderId?: number): Promise<SavedUrl> {
  return json(await authedFetch("/url-to-markdown", { method: "POST", body: JSON.stringify({ url, folderId }) }));
}

/** Saves now, or queues the URL if the device/server is unreachable. */
export async function saveUrlOrQueue(url: string): Promise<{ queued: true } | ({ queued: false } & SavedUrl)> {
  if (!navigator.onLine) {
    await enqueueSave(url);
    return { queued: true };
  }
  try {
    return { queued: false, ...(await saveUrl(url)) };
  } catch (err) {
    if (err instanceof NetworkError) {
      await enqueueSave(url);
      return { queued: true };
    }
    throw err;
  }
}

/** Retries queued saves; keeps only the ones that still can't reach the server. */
export async function flushQueue(): Promise<number> {
  const queue = await getQueue();
  if (queue.length === 0 || !navigator.onLine) return 0;
  const remaining = [];
  let done = 0;
  for (const item of queue) {
    try {
      await saveUrl(item.url);
      done++;
    } catch (err) {
      if (err instanceof NetworkError) remaining.push(item); // server rejections are dropped, not retried forever
    }
  }
  await setQueue(remaining);
  return done;
}

export async function createPageShare(id: number): Promise<string> {
  const { id: shareId } = await json<{ id: string }>(await authedFetch(`/pages/${id}/share`, { method: "POST" }));
  return `${getPublicBase()}/shared/${shareId}`;
}

/** Server-side (semantic when configured) search. Returns null when unavailable so callers can fall back. */
export async function serverSearch(q: string, limit: number, folderIds: number[] | null): Promise<any[] | null> {
  if (!getApiBase() || !navigator.onLine) return null;
  try {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    if (folderIds) qs.set("folderId", folderIds.join(","));
    const res = await authedFetch(`/pages?${qs}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
