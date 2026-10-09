-- School ID lookup removes whitespace and ignores case. The old lower(school_id)
-- indexes did not enforce uniqueness under that same normalization, so a lookup
-- could match multiple profiles and LIMIT 1 could choose an arbitrary account.
-- Fail safely if existing values collide; do not rewrite any stored identifiers.
do $$
begin
  if exists (
    select 1
    from public.profiles
    where school_id is not null and btrim(school_id) <> ''
    group by upper(regexp_replace(btrim(school_id), '\s', '', 'g'))
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce School ID login uniqueness: duplicate normalized profile School IDs exist';
  end if;

  if exists (
    select 1
    from public.library_members
    where school_id is not null and btrim(school_id) <> ''
    group by upper(regexp_replace(btrim(school_id), '\s', '', 'g'))
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce School ID login uniqueness: duplicate normalized library-member School IDs exist';
  end if;
end;
$$;

create unique index if not exists profiles_school_id_canonical_unique
  on public.profiles (upper(regexp_replace(btrim(school_id), '\s', '', 'g')))
  where school_id is not null and btrim(school_id) <> '';

create unique index if not exists library_members_school_id_canonical_unique
  on public.library_members (upper(regexp_replace(btrim(school_id), '\s', '', 'g')))
  where school_id is not null and btrim(school_id) <> '';

-- Return an email only when exactly one eligible account matches. Supabase Auth
-- remains the only component that verifies passwords and issues sessions.
create or replace function public.school_login_email(p_school_id text)
returns text
language sql stable security definer
set search_path = pg_catalog, public, auth as $$
  with requested as (
    select upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g')) as school_id
  ), eligible_accounts as (
    select p.id, u.email
    from public.profiles p
    join auth.users u on u.id = p.id
    cross join requested r
    where r.school_id <> ''
      and p.school_id is not null
      and upper(regexp_replace(btrim(p.school_id), '\s', '', 'g')) = r.school_id
      and (
        p.role in ('librarian'::public.app_role, 'administrator'::public.app_role)
        or (
          p.role = 'member'::public.app_role
          and exists (
            select 1
            from public.library_members m
            where m.auth_user_id = p.id
              and m.is_active
              and m.school_id is not null
              and m.library_card_number is not null
              and upper(regexp_replace(btrim(m.school_id), '\s', '', 'g')) = r.school_id
          )
        )
      )
  )
  select case when count(*) = 1 then min(email) else null end
  from eligible_accounts
$$;

-- Only the server-side School ID auth function may resolve Auth emails.
revoke all on function public.school_login_email(text) from public, anon, authenticated;
grant execute on function public.school_login_email(text) to service_role;

notify pgrst, 'reload schema';
