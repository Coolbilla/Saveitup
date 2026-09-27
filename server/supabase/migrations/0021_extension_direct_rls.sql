-- Grants the extension's own Supabase client (anon key + a real Supabase Auth
-- session, now that email/password sign-in replaced Clerk) direct, RLS-scoped
-- access to plain CRUD on saved_pages/folders, so those calls no longer have
-- to round-trip through the Express server.
--
-- user_id columns stay `text` (unchanged from the Clerk era) rather than
-- being converted to uuid: auth.uid() is uuid, so policies compare it as
-- text instead. This avoids a data migration and keeps DEV_FAKE_USER_ID
-- (used by mcp-server's static-key auth path, which has no real Supabase
-- Auth user behind it) working with no FK to violate.
--
-- The server keeps connecting with the service-role key, which bypasses RLS
-- unconditionally, so none of this affects server/src/db.ts.
--
-- Scope matches what the extension actually calls: no INSERT on saved_pages
-- (saving a page stays server-side, since it triggers the AI pipeline) and no
-- UPDATE/DELETE on folders (no such feature exists in the extension).

drop policy if exists saved_pages_select_own on saved_pages;
create policy saved_pages_select_own on saved_pages
  for select to authenticated
  using ((select auth.uid())::text = user_id);

drop policy if exists saved_pages_update_own on saved_pages;
create policy saved_pages_update_own on saved_pages
  for update to authenticated
  using ((select auth.uid())::text = user_id)
  with check (
    (select auth.uid())::text = user_id
    and (
      folder_id is null
      or exists (
        select 1 from folders
        where folders.id = saved_pages.folder_id
        and folders.user_id = (select auth.uid())::text
      )
    )
  );

drop policy if exists saved_pages_delete_own on saved_pages;
create policy saved_pages_delete_own on saved_pages
  for delete to authenticated
  using ((select auth.uid())::text = user_id);

drop policy if exists folders_select_own on folders;
create policy folders_select_own on folders
  for select to authenticated
  using ((select auth.uid())::text = user_id);

drop policy if exists folders_insert_own on folders;
create policy folders_insert_own on folders
  for insert to authenticated
  with check ((select auth.uid())::text = user_id);
