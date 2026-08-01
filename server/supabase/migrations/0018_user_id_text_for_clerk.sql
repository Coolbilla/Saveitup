-- Switch from Supabase Auth (uuid user_id referencing auth.users) to Clerk
-- (text user_id holding Clerk's `sub` claim, e.g. "user_2NNxk8t...").
-- Clerk users are never written into Supabase's auth.users table, so the old
-- foreign keys and auth.uid()-based RLS policies no longer make sense.
--
-- RLS is left ENABLED with no policies (default-deny) intentionally: the
-- server always connects with the service-role key, which bypasses RLS
-- unconditionally, so RLS here is not the real enforcement boundary (that's
-- db.ts's userId filtering, per Phase A). Nothing else ever connects to
-- these tables, so default-deny is harmless and accurately reflects that
-- Clerk identities aren't visible to Postgres.

drop policy if exists saved_pages_owner on saved_pages;
drop policy if exists folders_owner on folders;
drop policy if exists tab_sessions_owner on tab_sessions;

alter table saved_pages drop constraint if exists saved_pages_user_id_fkey;
alter table folders drop constraint if exists folders_user_id_fkey;
alter table tab_sessions drop constraint if exists tab_sessions_user_id_fkey;

alter table saved_pages alter column user_id type text using user_id::text;
alter table folders alter column user_id type text using user_id::text;
alter table tab_sessions alter column user_id type text using user_id::text;
