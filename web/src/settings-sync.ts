// Encrypted cross-device sync of AI keys + model choices (engine in shared/src/settings-sync.ts).
import { createSettingsSync } from "../../shared/src/settings-sync";
import { getSupabase, getCurrentUserId } from "./supabase";
import { getAllCredentials, getAllRoleConfig, replaceAllSettings } from "./ai/settings";

const PASS = "settingsSyncPassphrase";
const STAMP = "settingsSyncStamp";
const put = (k: string, v: string | null) => (v ? localStorage.setItem(k, v) : localStorage.removeItem(k));

export const settingsSync = createSettingsSync({
  get supabase() { return getSupabase(); },
  userId: getCurrentUserId,
  getPassphrase: async () => localStorage.getItem(PASS),
  setPassphrase: async (p) => put(PASS, p),
  getStamp: async () => localStorage.getItem(STAMP),
  setStamp: async (s) => put(STAMP, s),
  readLocal: async () => ({ v: 1, credentials: await getAllCredentials(), roles: await getAllRoleConfig() }),
  writeLocal: async (p) => replaceAllSettings(p.credentials as any, p.roles as any)
});
