-- Let a member remove their own unconfirmed registration after proving
-- possession of its password. Library member, loan, and reservation rows are
-- never removed by this flow.

create or replace function public.claim_member_registration_cancellation(
  p_email text,
  p_school_id text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_auth_user auth.users%rowtype;
  v_profile public.profiles%rowtype;
  v_registration public.pending_member_registrations%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_school_id text := upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'));
begin
  if v_email = '' or v_school_id = '' then return null; end if;

  select * into v_auth_user
  from auth.users
  where lower(email) = v_email
  for update skip locked;
  if not found or v_auth_user.email_confirmed_at is not null then return null; end if;

  select * into v_profile
  from public.profiles
  where id = v_auth_user.id
  for update;
  if not found or v_profile.role <> 'member'
    or upper(regexp_replace(btrim(coalesce(v_profile.registration_school_id, '')), '\s', '', 'g')) <> v_school_id then
    return null;
  end if;

  select * into v_registration
  from public.pending_member_registrations
  where user_id = v_auth_user.id
  for update skip locked;
  if not found
    or v_registration.status not in ('pending_email_verification', 'assistance_pending', 'expired')
    or lower(coalesce(v_registration.email_snapshot, '')) <> v_email
    or upper(regexp_replace(btrim(coalesce(v_registration.school_id_snapshot, '')), '\s', '', 'g')) <> v_school_id then
    return null;
  end if;

  -- Protect an account that has already been attached to library activity.
  -- Matching the School ID alone is not a link: deleting this Auth account
  -- leaves the trusted library member and all circulation history untouched.
  if exists (
    select 1 from public.library_members m
    where m.auth_user_id = v_auth_user.id or m.id = v_auth_user.id
  ) or exists (
    select 1 from public.loans l
    left join public.library_members m on m.id = l.member_id
    where l.member_id = v_auth_user.id or m.auth_user_id = v_auth_user.id
  ) or exists (
    select 1 from public.reservations r
    left join public.library_members m on m.id = r.member_id
    where r.member_id = v_auth_user.id or m.auth_user_id = v_auth_user.id
  ) then return null; end if;

  update public.pending_member_registrations
  set status = 'cleanup_in_progress', cleanup_started_at = now(),
      cleanup_attempts = cleanup_attempts + 1, updated_at = now()
  where user_id = v_auth_user.id;
  return v_auth_user.id;
end;
$$;
revoke all on function public.claim_member_registration_cancellation(text, text) from public, anon, authenticated;
grant execute on function public.claim_member_registration_cancellation(text, text) to service_role;

create or replace function public.validate_member_registration_cancellation(
  p_user_id uuid,
  p_email text,
  p_school_id text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_auth_user auth.users%rowtype;
  v_profile public.profiles%rowtype;
  v_registration public.pending_member_registrations%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_school_id text := upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'));
begin
  select * into v_auth_user from auth.users where id = p_user_id for update skip locked;
  if not found or v_auth_user.email_confirmed_at is not null or lower(coalesce(v_auth_user.email, '')) <> v_email then
    return false;
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found or v_profile.role <> 'member'
    or upper(regexp_replace(btrim(coalesce(v_profile.registration_school_id, '')), '\s', '', 'g')) <> v_school_id then
    return false;
  end if;

  select * into v_registration from public.pending_member_registrations
  where user_id = p_user_id for update skip locked;
  if not found or v_registration.status <> 'cleanup_in_progress'
    or lower(coalesce(v_registration.email_snapshot, '')) <> v_email
    or upper(regexp_replace(btrim(coalesce(v_registration.school_id_snapshot, '')), '\s', '', 'g')) <> v_school_id then
    return false;
  end if;

  if exists (
    select 1 from public.library_members m
    where m.auth_user_id = p_user_id or m.id = p_user_id
  ) or exists (
    select 1 from public.loans l
    left join public.library_members m on m.id = l.member_id
    where l.member_id = p_user_id or m.auth_user_id = p_user_id
  ) or exists (
    select 1 from public.reservations r
    left join public.library_members m on m.id = r.member_id
    where r.member_id = p_user_id or m.auth_user_id = p_user_id
  ) then return false; end if;

  return true;
end;
$$;
revoke all on function public.validate_member_registration_cancellation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.validate_member_registration_cancellation(uuid, text, text) to service_role;

-- Do not let a staff-assistance request appear between the last safety check
-- and the Auth deletion.
create or replace function public.block_verification_request_during_registration_cancellation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1 from public.pending_member_registrations r
    where r.user_id = new.user_id and r.status = 'cleanup_in_progress'
  ) then
    raise exception 'This registration is being cancelled. Retry the assistance request shortly.';
  end if;
  return new;
end;
$$;
revoke all on function public.block_verification_request_during_registration_cancellation() from public, anon, authenticated, service_role;
drop trigger if exists block_verification_request_during_registration_cancellation on public.member_verification_assistance_requests;
create trigger block_verification_request_during_registration_cancellation
before insert on public.member_verification_assistance_requests
for each row execute function public.block_verification_request_during_registration_cancellation();

create or replace function public.finish_member_registration_cancellation(
  p_user_id uuid,
  p_deleted boolean,
  p_error_code text default null
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_registration public.pending_member_registrations%rowtype;
  v_error_code text;
begin
  select * into v_registration from public.pending_member_registrations
  where user_id = p_user_id for update;
  if not found then return; end if;

  if p_deleted then
    -- Cancellation is also the member's withdrawal of any open assistance
    -- request. Verified library links are rejected by the safety checks above.
    delete from public.member_verification_assistance_requests
    where user_id = p_user_id and status in ('pending', 'approved');
    insert into public.activity_logs (
      actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
      description, entity_type, entity_id, status, old_values, new_values
    ) values (
      null, 'Member', 'member', 'member_registration_cancelled', 'authentication',
      'A member cancelled an unconfirmed registration after password verification.',
      'auth_registration', p_user_id, 'success',
      jsonb_build_object('registration_status', 'cleanup_in_progress'),
      jsonb_build_object('registration_status', 'cancelled')
    );
    update public.pending_member_registrations
    set status = 'cleaned', email_snapshot = null, school_id_snapshot = null,
        cleanup_started_at = null, updated_at = now()
    where user_id = p_user_id;
    delete from public.registration_resend_limits where user_id = p_user_id;
    return;
  end if;

  v_error_code := case
    when p_error_code ~ '^[a-zA-Z0-9_.-]{1,80}$'
      and p_error_code !~* '(password|token|secret|pin|otp)' then p_error_code
    else 'unknown'
  end;
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, old_values, new_values
  ) values (
    null, 'Member', 'member', 'member_registration_cancellation', 'authentication',
    'A member registration cancellation could not be completed; the registration remains available.',
    'auth_registration', p_user_id, 'failure',
    jsonb_build_object('registration_status', 'cleanup_in_progress'),
    jsonb_build_object('error_code', v_error_code)
  );
  update public.pending_member_registrations
  set status = case
        when exists (
          select 1 from public.member_verification_assistance_requests r
          where r.user_id = p_user_id and r.status in ('pending', 'approved')
        ) then 'assistance_pending'
        when expires_at <= now() then 'expired'
        else 'pending_email_verification'
      end,
      cleanup_started_at = null, updated_at = now()
  where user_id = p_user_id;
end;
$$;
revoke all on function public.finish_member_registration_cancellation(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.finish_member_registration_cancellation(uuid, boolean, text) to service_role;

notify pgrst, 'reload schema';
