// Cross-device tab sync, phone side. Chrome on Android doesn't let apps read its open tabs, so the
// phone is a *receiver* (other devices' tabs + an inbox of links sent to it) and a *sender* of links.
import { getSupabase, getCurrentUserId } from "./supabase";

export interface SyncedTab { url: string; title: string; favIconUrl?: string | null }
export interface DeviceRow { deviceId: string; deviceName: string; kind: "desktop" | "mobile"; tabs: SyncedTab[]; updatedAt: string }
export interface InboxItem { id: number; url: string; title: string; fromName: string; createdAt: string }

export function getDeviceId(): string {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("deviceId", id);
  }
  return id;
}
export const getDeviceName = () => localStorage.getItem("deviceName") || (/Android/i.test(navigator.userAgent) ? "Android phone" : "Web app");
export const setDeviceName = (n: string) => localStorage.setItem("deviceName", n.trim());

/** Makes this phone show up as a target ("send to…") on the user's other devices. */
export async function registerDevice(): Promise<void> {
  const userId = await getCurrentUserId();
  if (!userId) return;
  const { error } = await getSupabase().from("device_tabs").upsert({
    user_id: userId,
    device_id: getDeviceId(),
    device_name: getDeviceName(),
    kind: "mobile",
    tabs: [],
    updated_at: new Date().toISOString()
  });
  if (error) throw new Error(error.message);
}

export async function listDevices(): Promise<DeviceRow[]> {
  const { data, error } = await getSupabase().from("device_tabs").select("*").order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({ deviceId: r.device_id, deviceName: r.device_name, kind: r.kind, tabs: r.tabs ?? [], updatedAt: r.updated_at }));
}

export async function sendLink(url: string, title: string, toDeviceId: string | null): Promise<void> {
  const userId = await getCurrentUserId();
  if (!userId) throw new Error("Sign in first.");
  const { error } = await getSupabase()
    .from("sent_tabs")
    .insert({ user_id: userId, url, title, from_device: getDeviceId(), to_device: toDeviceId });
  if (error) throw new Error(error.message);
}

export async function listInbox(devices: DeviceRow[]): Promise<InboxItem[]> {
  const me = getDeviceId();
  const { data, error } = await getSupabase()
    .from("sent_tabs")
    .select("*")
    .or(`to_device.eq.${me},to_device.is.null`)
    .neq("from_device", me)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const names = new Map(devices.map((d) => [d.deviceId, d.deviceName]));
  return (data ?? []).map((r: any) => ({ id: r.id, url: r.url, title: r.title, fromName: names.get(r.from_device) ?? "another device", createdAt: r.created_at }));
}

export async function dismissInbox(id: number): Promise<void> {
  const { error } = await getSupabase().from("sent_tabs").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ---------- opening links in Chrome ----------
type Native = { openInChrome(url: string, incognito: boolean): string };
const native = () => (window as unknown as { SaveItUpNative?: Native }).SaveItUpNative;
export const hasNativeOpen = () => typeof native()?.openInChrome === "function";

/**
 * Opens a link in Chrome. Inside the Android app this fires a real Android intent; in a plain browser
 * only a normal tab is possible (a page can't open incognito windows).
 * Returns "incognito-unconfirmed" when incognito was requested: Chrome only honours that hint for some
 * versions, so the caller should offer "Copy link" as a fallback.
 */
export function openLink(url: string, incognito: boolean): "opened" | "incognito-unconfirmed" | "incognito-unavailable" | "failed" {
  const n = native();
  if (n) {
    const r = n.openInChrome(url, incognito);
    if (r === "error") return "failed";
    return incognito ? "incognito-unconfirmed" : "opened";
  }
  if (incognito) return "incognito-unavailable";
  window.open(url, "_blank", "noopener");
  return "opened";
}
