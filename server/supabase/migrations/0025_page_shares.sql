-- Single-page share links, same public-by-opaque-id model as tab_sessions
-- (server/src/routes/tab-sessions.ts): anyone with the link can read the shared
-- page's content, regardless of whether they're signed in — access control is
-- "do you have the (random uuid) link", not RLS/ownership. RLS is enabled with
-- no policies (service-role only), matching every other public-share table here.
create table if not exists page_shares (
  id uuid primary key default gen_random_uuid(),
  page_id bigint not null references saved_pages(id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists page_shares_page_id_idx on page_shares(page_id);

alter table page_shares enable row level security;
