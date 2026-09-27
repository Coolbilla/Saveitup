// Local retry queue for saves that failed because the server was unreachable (not for
// saves the server actively rejected — a 400/401/500 response means retrying the exact
// same payload won't help, so those still fail immediately rather than queuing forever).
import type { SavedPagePayload } from "../../../shared/src/types";

const QUEUE_KEY = "pendingSaveQueue";

export interface QueuedSave {
  payload: SavedPagePayload;
  queuedAt: string;
}

export async function getQueuedSaves(): Promise<QueuedSave[]> {
  const result = await chrome.storage.local.get(QUEUE_KEY);
  return result[QUEUE_KEY] ?? [];
}

async function setQueue(queue: QueuedSave[]): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

export async function enqueueSave(payload: SavedPagePayload): Promise<void> {
  const queue = await getQueuedSaves();
  queue.push({ payload, queuedAt: new Date().toISOString() });
  await setQueue(queue);
}

export async function removeQueuedSave(queuedAt: string): Promise<void> {
  const queue = await getQueuedSaves();
  await setQueue(queue.filter((q) => q.queuedAt !== queuedAt));
}
