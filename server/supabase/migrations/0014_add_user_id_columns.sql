-- Multi-tenant foundation: add user_id to every per-user table.
-- Nullable for now — existing rows belong to nobody until the developer's first
-- Google sign-in (Phase B), at which point a one-time backfill assigns them all
-- to that account and a follow-up migration tightens these to NOT NULL.

alter table saved_pages add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table folders add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table tab_sessions add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists saved_pages_user_id_created_at_idx on saved_pages (user_id, created_at desc);
create index if not exists folders_user_id_idx on folders (user_id);
create index if not exists tab_sessions_user_id_idx on tab_sessions (user_id);

alter table saved_pages enable row level security;
alter table folders enable row level security;
alter table tab_sessions enable row level security;

-- RLS here is defense-in-depth only: the server always connects with the
-- service-role key, which bypasses RLS unconditionally. Real isolation is
-- enforced in application code (server/src/db.ts), not by these policies.
drop policy if exists saved_pages_owner on saved_pages;
create policy saved_pages_owner on saved_pages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists folders_owner on folders;
create policy folders_owner on folders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists tab_sessions_owner on tab_sessions;
create policy tab_sessions_owner on tab_sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
