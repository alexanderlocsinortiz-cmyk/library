-- Restore School ID sign-in for staff accounts provisioned with an existing
-- profiles.school_id. Member sign-in still requires the verified, active
-- library-member link and card number added by migration 014.
create or replace function public.school_login_email(p_school_id text)
returns text
language sql stable security definer
set search_path = pg_catalog, public, auth as $$
  with requested as (
    select upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g')) as school_id
  )
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  cross join requested r
  where p.school_id is not null
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
  limit 1
$$;

-- Only the server-side School ID auth function may resolve Auth emails.
revoke all on function public.school_login_email(text) from public, anon, authenticated;
grant execute on function public.school_login_email(text) to service_role;

notify pgrst, 'reload schema';
