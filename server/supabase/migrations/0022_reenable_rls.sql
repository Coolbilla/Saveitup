-- RLS on saved_pages/folders was found disabled at the table level (relrowsecurity =
-- false) — nothing in this migration history ever did that, so it was flipped off
-- outside of these files (most likely via the dashboard Table Editor's RLS toggle,
-- probably during debugging). With RLS off, Postgres skips policy evaluation
-- entirely, so every row was readable/writable by any authenticated anon-key
-- client regardless of the correct owner-scoped policies from 0021 — a real
-- cross-account data leak, not just a missing policy.
--
-- Re-asserting explicitly here (rather than trusting it stays on) so a future
-- `supabase db reset`/migration replay can't silently drift back to this state.

alter table saved_pages enable row level security;
alter table folders enable row level security;
alter table user_ai_settings enable row level security;
alter table ai_error_log enable row level security;
alter table tab_sessions enable row level security;
