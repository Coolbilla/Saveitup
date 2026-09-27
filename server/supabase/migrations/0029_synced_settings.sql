-- Encrypted sync of AI provider keys + model choices across devices.
-- The client encrypts everything with the user's passphrase (AES-GCM) before upload, so this table
-- only ever holds ciphertext. One row per user, own-row RLS. Idempotent.

create table if not exists synced_settings (
  user_id text primary key,
  salt text not null,
  iv text not null,
  ciphertext text not null,
  iterations integer not null default 250000,
  updated_at timestamptz not null default now()
);

alter table synced_settings enable row level security;

drop policy if exists synced_settings_select_own on synced_settings;
create policy synced_settings_select_own on synced_settings for select to authenticated
  using ((select auth.uid())::text = user_id);
drop policy if exists synced_settings_insert_own on synced_settings;
create policy synced_settings_insert_own on synced_settings for insert to authenticated
  with check ((select auth.uid())::text = user_id);
drop policy if exists synced_settings_update_own on synced_settings;
create policy synced_settings_update_own on synced_settings for update to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);
drop policy if exists synced_settings_delete_own on synced_settings;
create policy synced_settings_delete_own on synced_settings for delete to authenticated
  using ((select auth.uid())::text = user_id);
