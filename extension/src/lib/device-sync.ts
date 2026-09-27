// Cross-device tab sync. Each opted-in device keeps one snapshot row of its open tabs
// (`device_tabs`); links sent from one device to another land in `sent_tabs` (the inbox).
// Everything goes straight to Supabase under RLS (own rows only) — no server involved.
import { supabaseTable } from "./pages-data";
import { getCurrentUserId } from "./supabase";

export interface SyncedTab { url: string; title: string; favIconUrl?: string | null }
export interface DeviceRow {
  deviceId: string;
  deviceName: string;
  kind: "desktop" | "mobile";
  tabs: SyncedTab[];
  updatedAt: string;
}
export interface InboxItem { id: number; url: string; title: string; fromDevice: string; fromName: string; createdAt: string }

const K = { id: "deviceId", name: "deviceName", enabled: "deviceSyncEnabled" };

export async function getDeviceId(): Promise<string> {
  const got = await chrome.storage.local.get(K.id);
  if (got[K.id]) return got[K.id] as string;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [K.id]: id });
  return id;
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "computer";
  return `Chrome on ${os}`;
}

export async function getDeviceName(): Promise<string> {
  const got = await chrome.storage.local.get(K.name);
  return (got[K.name] as string) || defaultDeviceName();
}
export async function setDeviceName(name: string): Promise<void> {
  await chrome.storage.local.set({ [K.name]: name.trim() });
}
export async function isSyncEnabled(): Promise<boolean> {
  return !!(await chrome.storage.local.get(K.enabled))[K.enabled];
}

/** http(s) tabs from normal windows only — incognito tabs and browser-internal pages are never synced. */
export function toSyncedTabs(tabs: chrome.tabs.Tab[]): SyncedTab[] {
  return tabs
    .filter((t) => !t.incognito && t.url && /^https?:\/\//i.test(t.url))
    .map((t) => ({ url: t.url as string, title: t.title || t.url || "", favIconUrl: t.favIconUrl ?? null }));
}

export async function pushTabs(): Promise<number> {
  const userId = await getCurrentUserId();
  if (!userId) return 0;
  const tabs = toSyncedTabs(await chrome.tabs.query({}));
  const supabase = await supabaseTable();
  const { error } = await supabase.from("device_tabs").upsert({
    user_id: userId,
    device_id: await getDeviceId(),
    device_name: await getDeviceName(),
    kind: "desktop",
    tabs,
    updated_at: new Date().toISOString()
  });
  if (error) throw new Error(error.message);
  return tabs.length;
}

export async function setSyncEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [K.enabled]: enabled });
  if (enabled) {
    await pushTabs();
  } else {
    await forgetThisDevice();
  }
  chrome.runtime.sendMessage({ type: "saveitup-device-sync-changed" }).catch(() => {});
}

/** Removes this device's snapshot from the account (used when sync is switched off). */
export async function forgetThisDevice(): Promise<void> {
  const userId = await getCurrentUserId();
  if (!userId) return;
  const supabase = await supabaseTable();
  await supabase.from("device_tabs").delete().eq("device_id", await getDeviceId());
}

function toDevice(row: any): DeviceRow {
  return { deviceId: row.device_id, deviceName: row.device_name, kind: row.kind, tabs: row.tabs ?? [], updatedAt: row.updated_at };
}

export async function listDevices(): Promise<DeviceRow[]> {
  const supabase = await supabaseTable();
  const { data, error } = await supabase.from("device_tabs").select("*").order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(toDevice);
}

export async function sendTab(url: string, title: string, toDeviceId: string | null): Promise<void> {
  const userId = await getCurrentUserId();
  if (!userId) throw new Error("Sign in first.");
  const supabase = await supabaseTable();
  const { error } = await supabase
    .from("sent_tabs")
    .insert({ user_id: userId, url, title, from_device: await getDeviceId(), to_device: toDeviceId });
  if (error) throw new Error(error.message);
}

/** Links sent to this device (or to any device) by another device. */
export async function listInbox(devices: DeviceRow[]): Promise<InboxItem[]> {
  const me = await getDeviceId();
  const supabase = await supabaseTable();
  const { data, error } = await supabase
    .from("sent_tabs")
    .select("*")
    .or(`to_device.eq.${me},to_device.is.null`)
    .neq("from_device", me)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const names = new Map(devices.map((d) => [d.deviceId, d.deviceName]));
  return (data ?? []).map((r: any) => ({
    id: r.id, url: r.url, title: r.title, fromDevice: r.from_device,
    fromName: names.get(r.from_device) ?? "another device", createdAt: r.created_at
  }));
}

export async function dismissInbox(id: number): Promise<void> {
  const supabase = await supabaseTable();
  const { error } = await supabase.from("sent_tabs").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Opens urls together in one new window — a normal one, or an incognito one. */
export async function openUrls(urls: string[], mode: "normal" | "incognito"): Promise<{ ok: boolean; message?: string }> {
  if (urls.length === 0) return { ok: true };
  if (mode === "incognito") {
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!allowed) {
      return { ok: false, message: "Turn on “Allow in Incognito” for SaveItUp in chrome://extensions, then try again." };
    }
  }
  try {
    await chrome.windows.create({ url: urls, incognito: mode === "incognito", focused: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
