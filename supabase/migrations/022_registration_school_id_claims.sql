-- Keep the School ID entered during self-registration visible to administrators
-- without treating that unverified claim as a trusted login identity.
alter table public.profiles
  add column if not exists registration_school_id text;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'profiles_registration_school_id_format'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_registration_school_id_format
      check (
        registration_school_id is null
        or registration_school_id ~ '^[A-Z0-9][A-Z0-9._-]{2,31}$'
      );
  end if;
end;
$$;

comment on column public.profiles.registration_school_id is
  'Unverified School ID submitted during account registration; never use for authorization or School ID login.';

-- Recover only submitted values actually present in Auth metadata. The canonical
-- profiles.school_id remains untouched until the existing member verification
-- flow links the account to its library record.
with submitted_ids as (
  select
    u.id,
    upper(regexp_replace(btrim(u.raw_user_meta_data ->> 'registration_school_id'), '\s', '', 'g')) as school_id
  from auth.users u
  where u.raw_user_meta_data ? 'registration_school_id'
)
update public.profiles p
set registration_school_id = submitted_ids.school_id
from submitted_ids
where p.id = submitted_ids.id
  and p.role = 'member'
  and p.registration_school_id is null
  and submitted_ids.school_id ~ '^[A-Z0-9][A-Z0-9._-]{2,31}$';

-- Before the normal auth-user trigger inserts a profile, copy the registration
-- claim from that Auth record. This trigger writes only the separate untrusted
-- claim column; the School ID used by school_login_email is still set by
-- complete_member_account_registration after email and card/PIN verification.
create or replace function public.capture_registration_school_id_claim()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  candidate_school_id text;
begin
  if new.role = 'member' and new.school_id is null then
    select upper(regexp_replace(btrim(u.raw_user_meta_data ->> 'registration_school_id'), '\s', '', 'g'))
      into candidate_school_id
    from auth.users u
    where u.id = new.id;

    if candidate_school_id ~ '^[A-Z0-9][A-Z0-9._-]{2,31}$' then
      new.registration_school_id := candidate_school_id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.capture_registration_school_id_claim() from public, anon, authenticated;

drop trigger if exists profiles_capture_registration_school_id_claim on public.profiles;
create trigger profiles_capture_registration_school_id_claim
  before insert on public.profiles
  for each row execute function public.capture_registration_school_id_claim();

-- A linked, active member record with a physical card is the trusted source of
-- identity. Repair a missing canonical profile value only when the submitted
-- claim is absent or matches that record and there is no normalized collision.
update public.profiles p
set school_id = m.school_id,
    updated_at = now()
from public.library_members m
join auth.users u on u.id = m.auth_user_id
where m.auth_user_id = p.id
  and p.role = 'member'
  and p.school_id is null
  and m.is_active
  and m.library_card_number is not null
  and m.school_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$'
  and u.email_confirmed_at is not null
  and (
    p.registration_school_id is null
    or upper(regexp_replace(btrim(p.registration_school_id), '\s', '', 'g')) =
       upper(regexp_replace(btrim(m.school_id), '\s', '', 'g'))
  )
  and not exists (
    select 1
    from public.profiles existing
    where existing.id <> p.id
      and existing.school_id is not null
      and upper(regexp_replace(btrim(existing.school_id), '\s', '', 'g')) =
          upper(regexp_replace(btrim(m.school_id), '\s', '', 'g'))
  );

notify pgrst, 'reload schema';
