// Offline support: a tiny IndexedDB key-value store, a queue of saves made while offline,
// and a cache of recently viewed pages/lists so the app is readable without a connection.
const DB_NAME = "saveitup";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* private mode / quota: caching is best-effort */
  }
}

// ---- cache of viewed pages (newest 40) ----
const MAX_CACHED_PAGES = 40;
export async function cachePage(page: { id: number }): Promise<void> {
  const cache = (await kvGet<Record<number, unknown>>("pageCache")) ?? {};
  const order = ((await kvGet<number[]>("pageCacheOrder")) ?? []).filter((id) => id !== page.id);
  order.unshift(page.id);
  cache[page.id] = page;
  for (const old of order.splice(MAX_CACHED_PAGES)) delete cache[old];
  await kvSet("pageCache", cache);
  await kvSet("pageCacheOrder", order);
}
export async function getCachedPage<T>(id: number): Promise<T | undefined> {
  return ((await kvGet<Record<number, T>>("pageCache")) ?? {})[id];
}

// ---- cache of the library list (first page, per filter) ----
export const cacheList = (key: string, rows: unknown) => kvSet(`list:${key}`, rows);
export const getCachedList = <T>(key: string) => kvGet<T>(`list:${key}`);

// ---- queue of "save this URL" requests made while offline ----
export interface QueuedSave { url: string; queuedAt: number }
export const getQueue = async () => (await kvGet<QueuedSave[]>("saveQueue")) ?? [];
export async function enqueueSave(url: string): Promise<void> {
  const q = await getQueue();
  if (!q.some((s) => s.url === url)) q.push({ url, queuedAt: Date.now() });
  await kvSet("saveQueue", q);
}
export const setQueue = (q: QueuedSave[]) => kvSet("saveQueue", q);
