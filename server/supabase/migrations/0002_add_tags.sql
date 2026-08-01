alter table saved_pages add column tags text[] not null default '{}'::text[];

create index saved_pages_tags_idx on saved_pages using gin (tags);
