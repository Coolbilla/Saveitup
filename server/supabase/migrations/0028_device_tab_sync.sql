-- Cross-device tab sync.
--   device_tabs : one row per (user, device) holding that device's open tabs, refreshed by the device.
--   sent_tabs   : links one device sends to another ("inbox"); to_device NULL = any device.
-- Both are read/written straight from the extension and the mobile app under RLS (own rows only).
-- Idempotent.

create table if not exists device_tabs (
  user_id text not null,
  device_id text not null,
  device_name text not null default 'Device',
  kind text not null default 'desktop' check (kind in ('desktop', 'mobile')),
  tabs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

create table if not exists sent_tabs (
  id bigserial primary key,
  user_id text not null,
  url text not null,
  title text not null default '',
  from_device text not null,
  to_device text,
  created_at timestamptz not null default now()
);
create index if not exists sent_tabs_user_idx on sent_tabs (user_id, created_at desc);

alter table device_tabs enable row level security;
alter table sent_tabs enable row level security;

drop policy if exists device_tabs_select_own on device_tabs;
create policy device_tabs_select_own on device_tabs for select to authenticated
  using ((select auth.uid())::text = user_id);
drop policy if exists device_tabs_insert_own on device_tabs;
create policy device_tabs_insert_own on device_tabs for insert to authenticated
  with check ((select auth.uid())::text = user_id);
drop policy if exists device_tabs_update_own on device_tabs;
create policy device_tabs_update_own on device_tabs for update to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);
drop policy if exists device_tabs_delete_own on device_tabs;
create policy device_tabs_delete_own on device_tabs for delete to authenticated
  using ((select auth.uid())::text = user_id);

drop policy if exists sent_tabs_select_own on sent_tabs;
create policy sent_tabs_select_own on sent_tabs for select to authenticated
  using ((select auth.uid())::text = user_id);
drop policy if exists sent_tabs_insert_own on sent_tabs;
create policy sent_tabs_insert_own on sent_tabs for insert to authenticated
  with check ((select auth.uid())::text = user_id);
drop policy if exists sent_tabs_delete_own on sent_tabs;
create policy sent_tabs_delete_own on sent_tabs for delete to authenticated
  using ((select auth.uid())::text = user_id);
