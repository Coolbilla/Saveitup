create table tab_sessions (
  id uuid primary key default gen_random_uuid(),
  tabs jsonb not null,
  created_at timestamptz not null default now()
);
