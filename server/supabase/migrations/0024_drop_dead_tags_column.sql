-- tags text[] (added in 0002_add_tags.sql) has never had a code path: not in
-- shared/src/types.ts, not read/written by any route, not in the extension UI.
-- Dropping it rather than building a whole tagging feature nobody's asked to use yet —
-- folders + full-text search already cover the "find my stuff" need today.
drop index if exists saved_pages_tags_idx;
alter table saved_pages drop column if exists tags;
