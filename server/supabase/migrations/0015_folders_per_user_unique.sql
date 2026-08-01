-- Folder names only need to be unique within a single user's library, not globally.
alter table folders drop constraint if exists folders_name_key;
create unique index if not exists folders_user_id_name_key on folders (user_id, name);
