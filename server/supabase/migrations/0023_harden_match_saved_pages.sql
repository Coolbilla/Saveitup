-- match_saved_pages is safe today only because table-level RLS on saved_pages
-- restricts what the query inside it can see (it's a plain `language sql
-- stable` function — no `security definer` — so it runs with the caller's own
-- RLS). That's a single point of failure: it was one dashboard toggle away
-- from leaking every user's data when RLS got disabled outside these
-- migrations (see 0022). Add a defense-in-depth filter here so the function
-- is safe on its own even if a table-level policy gap reopens: it ignores
-- whatever match_user_id a caller passes and only ever matches the caller's
-- own auth.uid(), same as every RLS policy elsewhere in this schema.
--
-- match_user_id stays a parameter (not removed) so server/src/db.ts's
-- service-role call — which legitimately passes an already-verified userId
-- for a different Postgres role than the calling client's own auth.uid() —
-- keeps working unchanged; service-role calls bypass RLS but this explicit
-- check still applies to them too, which is fine since the server always
-- passes the correct id anyway.

create or replace function match_saved_pages(query_embedding vector(768), match_count int, match_user_id text)
returns table(id int, similarity float) language sql stable as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from saved_pages
  where embedding is not null
    and user_id = match_user_id
    and (auth.uid() is null or match_user_id = (auth.uid())::text)
  order by embedding <=> query_embedding
  limit match_count;
$$;
