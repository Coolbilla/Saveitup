-- The embedding column was sized for OpenAI's text-embedding-3-small (1536 dims), but the
-- configured embedding provider is NVIDIA NIM's baai/bge-m3, which produces 1024-dim vectors.
-- Every embedding write has been silently failing on the dimension mismatch since EMBEDDING_PROVIDER
-- switched to nvidia. No rows have a non-null embedding yet, so this is a safe in-place resize.
drop index if exists saved_pages_embedding_idx;

alter table saved_pages alter column embedding type vector(1024);

create index saved_pages_embedding_idx on saved_pages using ivfflat (embedding vector_cosine_ops);

create or replace function match_saved_pages(query_embedding vector(1024), match_count int)
returns table(id int, similarity float) language sql stable as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from saved_pages
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
