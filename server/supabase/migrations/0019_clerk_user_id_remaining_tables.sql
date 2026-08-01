-- Convert user_ai_settings and ai_error_log user_id columns from uuid (auth.users)
-- to text (Clerk user IDs, e.g. user_3FrX...). Also update match_saved_pages RPC
-- to accept text instead of uuid for match_user_id.
-- These were missed in migration 0018 which only covered saved_pages/folders/tab_sessions.

-- user_ai_settings: drop FK + RLS policy referencing auth.uid(), retype to text
drop policy if exists user_ai_settings_owner on user_ai_settings;
alter table user_ai_settings drop constraint if exists user_ai_settings_user_id_fkey;
alter table user_ai_settings alter column user_id type text using user_id::text;

-- ai_error_log: same treatment
drop policy if exists ai_error_log_owner on ai_error_log;
alter table ai_error_log drop constraint if exists ai_error_log_user_id_fkey;
alter table ai_error_log alter column user_id type text using user_id::text;

-- match_saved_pages RPC: recreate with match_user_id text instead of uuid
drop function if exists match_saved_pages(vector(1024), int, uuid);

create or replace function match_saved_pages(query_embedding vector(1024), match_count int, match_user_id text)
returns table(id int, similarity float) language sql stable as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from saved_pages
  where embedding is not null and user_id = match_user_id
  order by embedding <=> query_embedding
  limit match_count;
$$;
