-- Convert generated catalog disclaimers in place. Preserve each book's ID,
-- bibliographic fields, and relationships; archive the removed text first.
begin;

with marked_books as materialized (
  select id, description
  from public.books
  where description like 'SAMPLE RECORD -%'
), archived as (
  insert into public.activity_logs (
    actor_name_snapshot,
    actor_role_snapshot,
    action,
    module,
    description,
    entity_type,
    entity_id,
    old_values,
    new_values
  )
  select
    'System',
    'system',
    'catalog_sample_metadata_removed',
    'books',
    'Removed the generated sample disclaimer from a catalog title; original text is preserved in the audit details.',
    'book',
    marked_books.id,
    jsonb_build_object('description', marked_books.description),
    jsonb_build_object('description', null::text)
  from marked_books
  returning entity_id
)
update public.books as books
set description = null,
    updated_at = now()
from archived
where books.id = archived.entity_id
  and books.description like 'SAMPLE RECORD -%';

commit;
