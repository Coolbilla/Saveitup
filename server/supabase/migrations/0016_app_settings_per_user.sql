-- Replace the flat global app_settings KV store (used only for AI role config)
-- with a per-user table, and turn the in-memory AI error ring buffer into a
-- real table so errors survive restarts and are scoped per user.

create table if not exists user_ai_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  chain jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, role)
);

alter table user_ai_settings enable row level security;
drop policy if exists user_ai_settings_owner on user_ai_settings;
create policy user_ai_settings_owner on user_ai_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists ai_error_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  provider text not null,
  model text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_error_log_user_id_created_at_idx on ai_error_log (user_id, created_at desc);

alter table ai_error_log enable row level security;
drop policy if exists ai_error_log_owner on ai_error_log;
create policy ai_error_log_owner on ai_error_log for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
