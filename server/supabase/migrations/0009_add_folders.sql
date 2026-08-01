create table folders (
  id serial primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table saved_pages add column folder_id integer references folders(id);
