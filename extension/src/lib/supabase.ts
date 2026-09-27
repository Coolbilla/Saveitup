import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// supabase-js defaults to localStorage for session persistence, which doesn't
// exist in an MV3 service worker. chrome.storage.local works in every
// extension context (background, sidepanel) and is shared across all of
// them, so signing in from the sidepanel is immediately visible to
// background.ts too.
const chromeStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }
};

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SaveItUp isn't configured with a Supabase project yet.");
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: chromeStorageAdapter,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
  }
  return client;
}

export async function getAuthToken(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}

export async function getAuthState(): Promise<{ signedIn: boolean; email: string | null }> {
  const { data } = await getSupabase().auth.getSession();
  return { signedIn: !!data.session, email: data.session?.user.email ?? null };
}

export async function signOut(): Promise<void> {
  await getSupabase().auth.signOut();
}

// Same optional_host_permissions grant mechanism api-client.ts uses for the
// user-configurable apiBase — Supabase's host isn't a static permission
// either, so this needs a runtime grant the same way.
export async function ensureSupabaseHostPermission(): Promise<boolean> {
  const origin = new URL(SUPABASE_URL).origin;
  const pattern = `${origin}/*`;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function getCurrentUserId(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.user.id ?? null;
}

// Mirrors server/src/db.ts's matchSavedPages — same RPC, but the caller's own
// id is used instead of a client-supplied one: the RLS policy from migration
// 0021 already restricts saved_pages reads to rows you own, so this can't be
// used to see anyone else's matches regardless of what id were passed.
export async function matchSavedPages(queryEmbedding: number[], matchCount: number): Promise<number[]> {
  const userId = await getCurrentUserId();
  if (!userId) return [];
  const { data, error } = await getSupabase().rpc("match_saved_pages", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    match_user_id: userId
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: { id: number }) => row.id);
}
