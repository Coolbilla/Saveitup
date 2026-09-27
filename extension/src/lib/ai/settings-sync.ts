// Encrypted cross-device sync of AI keys + model choices (engine in shared/src/settings-sync.ts).
import { createSettingsSync } from "../../../../shared/src/settings-sync";
import { getSupabase, getCurrentUserId } from "../supabase";
import { getAllCredentials, getAllRoleConfig, replaceAllSettings } from "./settings";

const PASS = "settingsSyncPassphrase";
const STAMP = "settingsSyncStamp";

export const settingsSync = createSettingsSync({
  get supabase() { return getSupabase(); },
  userId: getCurrentUserId,
  async getPassphrase() { return ((await chrome.storage.local.get(PASS))[PASS] as string) ?? null; },
  async setPassphrase(p) { p ? await chrome.storage.local.set({ [PASS]: p }) : await chrome.storage.local.remove(PASS); },
  async getStamp() { return ((await chrome.storage.local.get(STAMP))[STAMP] as string) ?? null; },
  async setStamp(s) { s ? await chrome.storage.local.set({ [STAMP]: s }) : await chrome.storage.local.remove(STAMP); },
  async readLocal() { return { v: 1, credentials: await getAllCredentials(), roles: await getAllRoleConfig() }; },
  async writeLocal(p) { await replaceAllSettings(p.credentials as any, p.roles as any); }
});
