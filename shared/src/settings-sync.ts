// End-to-end encrypted sync of AI provider keys + model choices across a user's devices.
// The keys are encrypted in the client with a passphrase (PBKDF2 → AES-GCM) before they leave the
// device, so the database only ever holds ciphertext: a database leak alone reveals nothing, and
// even the server operator can't read them. Lose the passphrase and you simply re-enter your keys.
//
// Runs anywhere WebCrypto exists (extension pages, browsers, the Android WebView).

const ITERATIONS = 250_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface EncryptedBlob { salt: string; iv: string; ciphertext: string; iterations: number }

export async function encryptJson(passphrase: string, data: unknown): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { salt: b64(salt), iv: b64(iv), ciphertext: b64(ct), iterations: ITERATIONS };
}

/** Throws "wrong passphrase" if the passphrase can't open the blob (AES-GCM authenticates it). */
export async function decryptJson<T>(passphrase: string, blob: EncryptedBlob): Promise<T> {
  try {
    const key = await deriveKey(passphrase, unb64(blob.salt), blob.iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ciphertext) as BufferSource);
    return JSON.parse(dec.decode(plain)) as T;
  } catch {
    throw new Error("Wrong passphrase.");
  }
}

// ---------- sync engine ----------
export interface SyncedPayload {
  v: 1;
  credentials: Record<string, unknown>;
  roles: Record<string, unknown>;
}

export interface SettingsSyncStore {
  /** Supabase client (anon key + the user's session; RLS limits it to their own row). */
  supabase: any;
  userId(): Promise<string | null>;
  getPassphrase(): Promise<string | null>;
  setPassphrase(p: string | null): Promise<void>;
  /** ISO time of the cloud copy this device last pushed/pulled. */
  getStamp(): Promise<string | null>;
  setStamp(iso: string | null): Promise<void>;
  readLocal(): Promise<SyncedPayload>;
  writeLocal(p: SyncedPayload): Promise<void>;
}

export type SyncStatus =
  | { state: "off"; cloudCopy: boolean }
  | { state: "on"; cloudUpdatedAt: string | null; inSync: boolean };

export function createSettingsSync(store: SettingsSyncStore) {
  async function fetchRemote(userId: string): Promise<{ blob: EncryptedBlob; updatedAt: string } | null> {
    const { data, error } = await store.supabase.from("synced_settings").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { blob: { salt: data.salt, iv: data.iv, ciphertext: data.ciphertext, iterations: data.iterations }, updatedAt: data.updated_at };
  }

  async function needUser(): Promise<string> {
    const id = await store.userId();
    if (!id) throw new Error("Sign in first.");
    return id;
  }

  async function push(): Promise<void> {
    const userId = await needUser();
    const pass = await store.getPassphrase();
    if (!pass) throw new Error("Sync is off.");
    const blob = await encryptJson(pass, await store.readLocal());
    const updatedAt = new Date().toISOString();
    const { error } = await store.supabase.from("synced_settings").upsert({ user_id: userId, ...blob, updated_at: updatedAt });
    if (error) throw new Error(error.message);
    await store.setStamp(updatedAt);
  }

  async function pull(): Promise<boolean> {
    const userId = await needUser();
    const pass = await store.getPassphrase();
    if (!pass) throw new Error("Sync is off.");
    const remote = await fetchRemote(userId);
    if (!remote) return false;
    await store.writeLocal(await decryptJson<SyncedPayload>(pass, remote.blob));
    await store.setStamp(remote.updatedAt);
    return true;
  }

  return {
    async status(): Promise<SyncStatus> {
      const userId = await store.userId();
      const pass = await store.getPassphrase();
      const remote = userId ? await fetchRemote(userId).catch(() => null) : null;
      if (!pass) return { state: "off", cloudCopy: !!remote };
      const stamp = await store.getStamp();
      return { state: "on", cloudUpdatedAt: remote?.updatedAt ?? null, inSync: !!remote && stamp === remote.updatedAt };
    },

    /** Turn sync on. If a cloud copy exists the passphrase must open it (then it's applied here); otherwise this device's settings are uploaded. */
    async enable(passphrase: string): Promise<"pulled" | "pushed"> {
      if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
      const userId = await needUser();
      const remote = await fetchRemote(userId);
      if (remote) {
        const payload = await decryptJson<SyncedPayload>(passphrase, remote.blob); // verifies the passphrase
        await store.setPassphrase(passphrase);
        await store.writeLocal(payload);
        await store.setStamp(remote.updatedAt);
        return "pulled";
      }
      await store.setPassphrase(passphrase);
      await push();
      return "pushed";
    },

    push,
    pull,

    /** Called after this device changes a key/model, and when Settings opens: uploads if on. */
    async pushIfOn(): Promise<void> {
      if (await store.getPassphrase()) await push();
    },

    /** Pulls when the cloud copy is newer than what this device last saw. Returns true if settings changed. */
    async pullIfNewer(): Promise<boolean> {
      const userId = await store.userId();
      if (!userId || !(await store.getPassphrase())) return false;
      const remote = await fetchRemote(userId);
      if (!remote || (await store.getStamp()) === remote.updatedAt) return false;
      return pull();
    },

    /** Stops syncing on this device; optionally deletes the encrypted cloud copy too. */
    async disable(deleteCloudCopy: boolean): Promise<void> {
      if (deleteCloudCopy) {
        const userId = await needUser();
        const { error } = await store.supabase.from("synced_settings").delete().eq("user_id", userId);
        if (error) throw new Error(error.message);
      }
      await store.setPassphrase(null);
      await store.setStamp(null);
    }
  };
}
