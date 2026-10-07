-- School-ID authentication support.
-- Authentication is still handled by Supabase Auth; the Edge Function maps a
-- normalized school ID to an internal Auth identity without exposing that
-- identity to the browser.

alter table public.profiles
  add column if not exists school_id text;

create unique index if not exists profiles_school_id_unique
  on public.profiles (lower(school_id))
  where school_id is not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, school_id)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'school_id'
  );
  return new;
end;
$$;
