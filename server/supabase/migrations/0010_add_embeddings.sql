create extension if not exists vector;

alter table saved_pages add column embedding vector(1536);

create index on saved_pages using ivfflat (embedding vector_cosine_ops);

create or replace function match_saved_pages(query_embedding vector(1536), match_count int)
returns table(id int, similarity float) language sql stable as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from saved_pages
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
