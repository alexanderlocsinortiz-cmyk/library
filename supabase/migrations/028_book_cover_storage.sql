-- Book cover images are public catalog artwork. Any visitor can read them,
-- while only an authenticated administrator may upload, replace, or delete.
alter table public.books
  add column if not exists cover_image_path text;

grant select (cover_image_path) on public.books to anon;

create or replace function public.enforce_book_cover_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(), false) then
    if tg_op = 'INSERT' and (new.cover_image_path is not null or new.cover_url is not null) then
      raise exception 'Only administrators can manage book covers' using errcode = '42501';
    elsif tg_op = 'UPDATE'
      and (new.cover_image_path is distinct from old.cover_image_path
        or new.cover_url is distinct from old.cover_url) then
      raise exception 'Only administrators can manage book covers' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_book_cover_admin() from public, anon, authenticated;
drop trigger if exists enforce_book_cover_admin on public.books;
create trigger enforce_book_cover_admin
  before insert or update of cover_url, cover_image_path on public.books
  for each row execute function public.enforce_book_cover_admin();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'book-covers',
  'book-covers',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public can view book covers" on storage.objects;
create policy "public can view book covers"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'book-covers');

drop policy if exists "administrators can upload book covers" on storage.objects;
create policy "administrators can upload book covers"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'book-covers'
    and public.is_admin()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );

drop policy if exists "administrators can replace book covers" on storage.objects;
create policy "administrators can replace book covers"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'book-covers'
    and public.is_admin()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  )
  with check (
    bucket_id = 'book-covers'
    and public.is_admin()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );

drop policy if exists "administrators can delete book covers" on storage.objects;
create policy "administrators can delete book covers"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'book-covers'
    and public.is_admin()
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );
