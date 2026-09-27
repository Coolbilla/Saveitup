// Regression check for the RLS-disabled incident: creates two throwaway users,
// has a service-role client insert a row owned by user A, then asserts user B's
// anon-key client cannot read/update/delete it (and can't forge an insert under
// A's id either). Run this after any migration that touches RLS policies.
//
// Usage: npm run check:rls   (needs SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY in server/.env — SUPABASE_ANON_KEY isn't normally
// needed by the server itself, only by this script, to act as a real anon client.)
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set to run this check.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
let failed = false;

function fail(message: string): void {
  console.error(`FAIL: ${message}`);
  failed = true;
}

async function createSignedInTestUser(tag: string): Promise<{ id: string; client: SupabaseClient }> {
  const email = `saveitup-rls-check-${tag}-${Date.now()}@example.com`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`failed to create test user: ${error?.message}`);

  const client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`failed to sign in test user: ${signInError.message}`);
  return { id: data.user.id, client };
}

async function main() {
  const userA = await createSignedInTestUser("a");
  const userB = await createSignedInTestUser("b");

  try {
    const { data: page, error: pageInsertError } = await admin
      .from("saved_pages")
      .insert({ user_id: userA.id, url: "https://example.com/rls-check", title: "RLS check", domain: "example.com", page_content: "test" })
      .select("id")
      .single();
    if (pageInsertError || !page) throw new Error(`setup: couldn't insert test page: ${pageInsertError?.message}`);

    const { data: folder, error: folderInsertError } = await admin
      .from("folders")
      .insert({ user_id: userA.id, name: "RLS check folder" })
      .select("id")
      .single();
    if (folderInsertError || !folder) throw new Error(`setup: couldn't insert test folder: ${folderInsertError?.message}`);

    // --- user B must not see or touch user A's rows ---
    const { data: bReadPage } = await userB.client.from("saved_pages").select("id").eq("id", page.id);
    if (bReadPage && bReadPage.length > 0) fail("user B can read user A's saved_pages row");

    const { data: bUpdatePage } = await userB.client.from("saved_pages").update({ pinned: true }).eq("id", page.id).select("id");
    if (bUpdatePage && bUpdatePage.length > 0) fail("user B can update user A's saved_pages row");

    const { data: bDeletePage } = await userB.client.from("saved_pages").delete().eq("id", page.id).select("id");
    if (bDeletePage && bDeletePage.length > 0) fail("user B can delete user A's saved_pages row");

    const { data: bReadFolder } = await userB.client.from("folders").select("id").eq("id", folder.id);
    if (bReadFolder && bReadFolder.length > 0) fail("user B can read user A's folder");

    // saved_pages has no client-side INSERT policy at all (saving stays server-side) —
    // confirm an anon-key client can't insert one directly, forged under A's id or not.
    const { data: bForgedInsert } = await userB.client
      .from("saved_pages")
      .insert({ user_id: userA.id, url: "https://example.com/forged", title: "forged", domain: "example.com", page_content: "x" })
      .select("id");
    if (bForgedInsert && bForgedInsert.length > 0) {
      fail("an anon-key client was able to insert into saved_pages directly (should be server-only)");
      await admin.from("saved_pages").delete().eq("id", bForgedInsert[0].id);
    }

    // --- nested folders: parent ownership + cycle guard ---
    const { data: bChild } = await userB.client
      .from("folders")
      .insert({ user_id: userB.id, name: "rls child", parent_id: folder.id })
      .select("id");
    if (bChild && bChild.length > 0) {
      fail("user B can create a folder under user A's folder");
      await admin.from("folders").delete().eq("id", bChild[0].id);
    }
    const { data: bMove } = await userB.client.from("folders").update({ parent_id: null, name: "hijacked" }).eq("id", folder.id).select("id");
    if (bMove && bMove.length > 0) fail("user B can modify user A's folder");
    const { data: bDelFolder } = await userB.client.from("folders").delete().eq("id", folder.id).select("id");
    if (bDelFolder && bDelFolder.length > 0) fail("user B can delete user A's folder");

    const { data: aChild } = await userA.client
      .from("folders")
      .insert({ user_id: userA.id, name: "rls child", parent_id: folder.id })
      .select("id")
      .single();
    if (!aChild) fail("user A cannot create a subfolder under their own folder");
    else {
      const { error: cycleError } = await userA.client.from("folders").update({ parent_id: aChild.id }).eq("id", folder.id);
      if (!cycleError) fail("moving a folder under its own descendant was allowed (cycle guard missing)");
    }

    // --- tab sync tables ---
    await admin.from("device_tabs").insert({ user_id: userA.id, device_id: "rls-dev-a", device_name: "A laptop", tabs: [{ url: "https://example.com", title: "x" }] });
    const { data: sent } = await admin.from("sent_tabs").insert({ user_id: userA.id, url: "https://example.com/s", from_device: "rls-dev-a" }).select("id").single();
    const { data: bDevices } = await userB.client.from("device_tabs").select("device_id").eq("device_id", "rls-dev-a");
    if (bDevices && bDevices.length > 0) fail("user B can read user A's device_tabs");
    const { data: bSent } = await userB.client.from("sent_tabs").select("id");
    if (bSent && bSent.length > 0) fail("user B can read user A's sent_tabs");
    const { error: bForgeDevice } = await userB.client.from("device_tabs").insert({ user_id: userA.id, device_id: "rls-forged", device_name: "forged" });
    if (!bForgeDevice) fail("user B could insert a device_tabs row under user A's id");
    const { error: bForgeSent } = await userB.client.from("sent_tabs").insert({ user_id: userA.id, url: "https://evil.example", from_device: "x" });
    if (!bForgeSent) fail("user B could push a link into user A's inbox");
    const { data: bDelDevice } = await userB.client.from("device_tabs").delete().eq("device_id", "rls-dev-a").select("device_id");
    if (bDelDevice && bDelDevice.length > 0) fail("user B can delete user A's device_tabs row");
    const { data: aDevices } = await userA.client.from("device_tabs").select("device_id").eq("device_id", "rls-dev-a");
    if (!aDevices || aDevices.length === 0) fail("user A cannot read their own device_tabs row");
    await admin.from("device_tabs").delete().eq("user_id", userA.id);
    if (sent) await admin.from("sent_tabs").delete().eq("id", sent.id);

    // --- user A must still see their own rows ---
    const { data: aReadPage, error: aReadError } = await userA.client.from("saved_pages").select("id").eq("id", page.id);
    if (aReadError || !aReadPage || aReadPage.length === 0) fail("user A cannot read their own saved_pages row");

    await admin.from("saved_pages").delete().eq("id", page.id);
    await admin.from("folders").delete().eq("id", folder.id);
  } finally {
    await admin.auth.admin.deleteUser(userA.id).catch(() => {});
    await admin.auth.admin.deleteUser(userB.id).catch(() => {});
  }

  if (failed) {
    console.error("\nRLS regression check FAILED.");
    process.exit(1);
  }
  console.log("RLS regression check passed: cross-account access is correctly denied.");
}

main().catch((err) => {
  console.error("RLS check crashed:", err);
  process.exit(1);
});
