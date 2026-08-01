alter table saved_pages add column search_vector tsvector
  generated always as (
    to_tsvector('english',
      coalesce(title, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(transcript, '') || ' ' ||
      coalesce(note_text, '') || ' ' ||
      coalesce(highlight_text, '') || ' ' ||
      coalesce(page_content, '')
    )
  ) stored;

create index saved_pages_search_idx on saved_pages using gin (search_vector);
