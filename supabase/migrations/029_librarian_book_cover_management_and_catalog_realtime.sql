-- Librarians and administrators may manage public catalog artwork. This does
-- not change any account roles or the broader book-management policies.
create or replace function public.enforce_book_cover_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not coalesce(public.is_staff(), false) then
    if tg_op = 'INSERT' and (new.cover_image_path is not null or new.cover_url is not null) then
      raise exception 'Only library staff can manage book covers' using errcode = '42501';
    elsif tg_op = 'UPDATE'
      and (new.cover_image_path is distinct from old.cover_image_path
        or new.cover_url is distinct from old.cover_url) then
      raise exception 'Only library staff can manage book covers' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop policy if exists "administrators can upload book covers" on storage.objects;
drop policy if exists "administrators can replace book covers" on storage.objects;
drop policy if exists "administrators can delete book covers" on storage.objects;

drop policy if exists "staff can upload book covers" on storage.objects;
create policy "staff can upload book covers"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'book-covers'
    and public.is_staff()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );

drop policy if exists "staff can replace book covers" on storage.objects;
create policy "staff can replace book covers"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'book-covers'
    and public.is_staff()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  )
  with check (
    bucket_id = 'book-covers'
    and public.is_staff()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );

drop policy if exists "staff can delete book covers" on storage.objects;
create policy "staff can delete book covers"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'book-covers'
    and public.is_staff()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );

-- Catalog clients can refresh an already-open catalog when a staff member
-- adds or changes a book. Existing row-level policies still control visibility.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'books'
    ) then
    alter publication supabase_realtime add table public.books;
  end if;
end;
$$;
