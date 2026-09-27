-- Nested folders. Idempotent, safe to re-run.
--
-- parent_id cascades: deleting a folder deletes its subfolders. Pages are never
-- deleted by this — saved_pages.folder_id is switched to ON DELETE SET NULL below so
-- pages in a removed folder simply become unfiled (it was NO ACTION before, which
-- would have made deleting any non-empty folder fail outright).

alter table folders add column if not exists parent_id integer references folders(id) on delete cascade;

alter table saved_pages drop constraint if exists saved_pages_folder_id_fkey;
alter table saved_pages
  add constraint saved_pages_folder_id_fkey foreign key (folder_id) references folders(id) on delete set null;

-- Same name is allowed under different parents ("Read later" in both Work and Personal).
drop index if exists folders_user_id_name_key;
create unique index if not exists folders_user_parent_name_key on folders (user_id, coalesce(parent_id, 0), name);

create index if not exists folders_parent_id_idx on folders (parent_id);

-- A folder can't be moved under itself or one of its own descendants.
create or replace function folders_prevent_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'a folder cannot be its own parent';
  end if;
  if exists (
    with recursive descendants as (
      select id from folders where parent_id = new.id
      union
      select f.id from folders f join descendants d on f.parent_id = d.id
    )
    select 1 from descendants where id = new.parent_id
  ) then
    raise exception 'a folder cannot be moved into its own subfolder';
  end if;
  return new;
end;
$$;

drop trigger if exists folders_prevent_cycle_trg on folders;
create trigger folders_prevent_cycle_trg before update of parent_id on folders
  for each row execute function folders_prevent_cycle();

-- RLS: a parent must be null or a folder the caller owns (same shape as the
-- folder_id check on saved_pages_update_own in 0021).
drop policy if exists folders_insert_own on folders;
create policy folders_insert_own on folders
  for insert to authenticated
  with check (
    (select auth.uid())::text = user_id
    and (
      parent_id is null
      or exists (
        select 1 from folders p
        where p.id = folders.parent_id and p.user_id = (select auth.uid())::text
      )
    )
  );

drop policy if exists folders_update_own on folders;
create policy folders_update_own on folders
  for update to authenticated
  using ((select auth.uid())::text = user_id)
  with check (
    (select auth.uid())::text = user_id
    and (
      parent_id is null
      or exists (
        select 1 from folders p
        where p.id = folders.parent_id and p.user_id = (select auth.uid())::text
      )
    )
  );

drop policy if exists folders_delete_own on folders;
create policy folders_delete_own on folders
  for delete to authenticated
  using ((select auth.uid())::text = user_id);
