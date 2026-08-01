create table saved_pages (
  id bigint generated always as identity primary key,
  url text not null,
  title text,
  domain text,
  page_content text,
  description text,
  transcript text,
  highlight_text text,
  highlight_context text,
  created_at timestamptz not null default now()
);

create index saved_pages_domain_idx on saved_pages (domain);
create index saved_pages_created_at_idx on saved_pages (created_at desc);
