-- Switch embedding dimension from 1024 (NVIDIA baai/bge-m3) to 768 (Gemini text-embedding-004).
-- NVIDIA's /v1/embeddings endpoint returns 404 so no embeddings have ever been stored;
-- all rows have null embeddings, making this a safe in-place resize with no data loss.

drop index if exists saved_pages_embedding_idx;

alter table saved_pages alter column embedding type vector(768);

create index saved_pages_embedding_idx on saved_pages using ivfflat (embedding vector_cosine_ops);

drop function if exists match_saved_pages(vector(1024), int, text);

create or replace function match_saved_pages(query_embedding vector(768), match_count int, match_user_id text)
returns table(id int, similarity float) language sql stable as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from saved_pages
  where embedding is not null and user_id = match_user_id
  order by embedding <=> query_embedding
  limit match_count;
$$;
