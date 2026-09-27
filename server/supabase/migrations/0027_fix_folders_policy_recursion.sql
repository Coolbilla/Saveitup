-- 0026's insert/update policies on `folders` looked up the parent row in `folders` itself, which
-- Postgres rejects with "infinite recursion detected in policy for relation folders" — so creating
-- or moving any folder from the extension / mobile app failed. The ownership lookup moves into a
-- SECURITY DEFINER function (which reads `folders` without re-triggering its own RLS policies).
-- Idempotent; run after 0026.

create or replace function public.owns_folder(fid integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.folders
    where id = fid and user_id = (select auth.uid())::text
  );
$$;

revoke all on function public.owns_folder(integer) from public;
grant execute on function public.owns_folder(integer) to authenticated;

drop policy if exists folders_insert_own on folders;
create policy folders_insert_own on folders
  for insert to authenticated
  with check (
    (select auth.uid())::text = user_id
    and (parent_id is null or public.owns_folder(parent_id))
  );

drop policy if exists folders_update_own on folders;
create policy folders_update_own on folders
  for update to authenticated
  using ((select auth.uid())::text = user_id)
  with check (
    (select auth.uid())::text = user_id
    and (parent_id is null or public.owns_folder(parent_id))
  );

-- saved_pages_update_own (0021) has the same shape but queries a *different* table, so it doesn't
-- recurse; it is left as is.
