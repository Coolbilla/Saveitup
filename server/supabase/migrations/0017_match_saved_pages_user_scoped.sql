-- Scope semantic search to a single user's saved pages.
drop function if exists match_saved_pages(vector(1024), int);

create or replace function match_saved_pages(query_embedding vector(1024), match_count int, match_user_id uuid)
returns table(id int, similarity float) language sql stable as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from saved_pages
  where embedding is not null and user_id = match_user_id
  order by embedding <=> query_embedding
  limit match_count;
$$;
