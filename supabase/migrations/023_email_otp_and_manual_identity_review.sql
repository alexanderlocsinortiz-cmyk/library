-- Keep Supabase email confirmation and library identity verification separate.
-- Email confirmation remains owned by Supabase Auth; this migration only adds
-- a staff-reviewed path to link an unlinked library member record.

alter table public.profiles
  add column if not exists library_identity_verification_method text,
  add column if not exists library_identity_verified_at timestamptz,
  add column if not exists library_identity_verified_by uuid references public.profiles(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'profiles_library_identity_method_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_library_identity_method_check
      check (library_identity_verification_method is null or library_identity_verification_method in ('card_pin', 'admin_review'));
  end if;
end;
$$;

comment on column public.profiles.library_identity_verification_method is
  'Method used to link this account to a trusted library member record; independent from Supabase email confirmation.';

create table public.member_verification_assistance_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  full_name_snapshot text not null,
  email_snapshot text not null,
  school_id_snapshot text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  library_member_id uuid references public.library_members(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  replacement_email_snapshot text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.member_verification_assistance_requests enable row level security;
revoke all on public.member_verification_assistance_requests from public, anon, authenticated, service_role;
create index member_verification_requests_created on public.member_verification_assistance_requests (status, created_at desc);
create unique index member_verification_requests_user_pending
  on public.member_verification_assistance_requests (user_id)
  where status = 'pending';
create unique index member_verification_requests_school_pending
  on public.member_verification_assistance_requests (upper(regexp_replace(btrim(school_id_snapshot), '\s', '', 'g')))
  where status = 'pending';

create table public.member_verification_assistance_limits (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);
alter table public.member_verification_assistance_limits enable row level security;
revoke all on public.member_verification_assistance_limits from public, anon, authenticated, service_role;

-- The untrusted registration claim is unique for new registrations, including
-- against already verified profile School IDs. Advisory locking prevents two
-- concurrent signups from claiming the same normalized School ID. Existing
-- records are not rewritten or deleted.
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
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('registration-school-id:' || candidate_school_id, 0));
      if exists (
        select 1 from public.profiles p
        where p.id <> new.id
          and (
            upper(regexp_replace(btrim(coalesce(p.registration_school_id, '')), '\s', '', 'g')) = candidate_school_id
            or upper(regexp_replace(btrim(coalesce(p.school_id, '')), '\s', '', 'g')) = candidate_school_id
          )
      ) then
        raise exception 'This School ID is already registered. Check the ID or contact library staff.';
      end if;
      new.registration_school_id := candidate_school_id;
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.capture_registration_school_id_claim() from public, anon, authenticated;

-- Preserve the existing card/PIN checks while explicitly recording the
-- independent library identity verification method for self-service links.
create or replace function public.complete_member_account_registration(
  p_school_id text,
  p_card_number text,
  p_pin text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_member_id uuid;
  v_member public.library_members%rowtype;
  v_profile public.profiles%rowtype;
  v_email_confirmed_at timestamptz;
  v_candidate_school_id text;
  v_school_id text;
begin
  if v_user_id is null then raise exception 'Sign in to finish account registration'; end if;
  perform public.lock_circulation();

  select * into v_profile from public.profiles where id = v_user_id for update;
  if not found or v_profile.role <> 'member' then raise exception 'A member account is required'; end if;
  select email_confirmed_at, raw_user_meta_data ->> 'registration_school_id'
    into v_email_confirmed_at, v_candidate_school_id
    from auth.users where id = v_user_id;
  if v_email_confirmed_at is null then raise exception 'Confirm your email before linking your library record'; end if;

  v_school_id := upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'));
  if v_school_id !~ '^[A-Z0-9][A-Z0-9._-]{2,31}$' then return jsonb_build_object('verified', false); end if;
  if v_candidate_school_id is not null and upper(regexp_replace(btrim(v_candidate_school_id), '\s', '', 'g')) <> v_school_id then
    return jsonb_build_object('verified', false);
  end if;

  v_member_id := public.verify_library_card_reservation_pin(p_card_number, p_pin);
  if v_member_id is null then return jsonb_build_object('verified', false); end if;
  select * into v_member from public.library_members where id = v_member_id for update;
  if not found or not v_member.is_active or v_member.school_id is null
    or upper(regexp_replace(btrim(v_member.school_id), '\s', '', 'g')) <> v_school_id then
    return jsonb_build_object('verified', false);
  end if;
  if v_member.auth_user_id is not null and v_member.auth_user_id <> v_user_id then return jsonb_build_object('verified', false); end if;
  if v_profile.school_id is not null and lower(v_profile.school_id) <> lower(v_member.school_id) then return jsonb_build_object('verified', false); end if;
  if exists (select 1 from public.library_members where auth_user_id = v_user_id and id <> v_member.id)
    or exists (select 1 from public.profiles where lower(school_id) = lower(v_member.school_id) and id <> v_user_id) then
    return jsonb_build_object('verified', false);
  end if;

  update public.library_members set auth_user_id = v_user_id, updated_at = now() where id = v_member.id;
  update public.profiles set full_name = v_member.full_name, school_id = v_member.school_id,
    library_identity_verification_method = 'card_pin', library_identity_verified_at = now(),
    library_identity_verified_by = null, updated_at = now()
    where id = v_user_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (v_user_id, 'member_account_self_link', 'library_member', v_member.id,
      jsonb_build_object('method', 'verified_card_pin'));
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, old_values, new_values
  ) values (
    v_user_id, coalesce(v_member.full_name, v_profile.full_name, 'Library member'), 'member',
    'member_identity_verified', 'members', 'Linked the account after verifying its library card and PIN.',
    'library_member', v_member.id, 'success',
    jsonb_build_object('library_identity_verified', false),
    jsonb_build_object('library_identity_verified', true, 'method', 'card_pin')
  );
  return jsonb_build_object('verified', true);
end;
$$;
revoke all on function public.complete_member_account_registration(text, text, text) from public, anon;
grant execute on function public.complete_member_account_registration(text, text, text) to authenticated;

-- Called only by the public assistance Edge Function using its server-side
-- service-role client. The function accepts no actor ID and matches both the
-- email and the untrusted registration claim to an existing Auth account.
create or replace function public.request_member_verification_assistance(
  p_email text,
  p_school_id text,
  p_rate_key text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_school_id text := upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'));
  v_attempts integer;
  v_user_id uuid;
  v_full_name text;
  v_email_snapshot text;
  v_request_id uuid;
begin
  if p_rate_key is null or p_rate_key !~ '^[a-f0-9]{64}$'
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or v_school_id !~ '^[A-Z0-9][A-Z0-9._-]{2,31}$' then
    return false;
  end if;

  delete from public.member_verification_assistance_limits
  where window_started_at < now() - interval '1 day';

  insert into public.member_verification_assistance_limits as limits (key_hash, window_started_at, attempts)
  values (p_rate_key, now(), 1)
  on conflict (key_hash) do update set
    window_started_at = case when limits.window_started_at < now() - interval '1 hour' then now() else limits.window_started_at end,
    attempts = case when limits.window_started_at < now() - interval '1 hour' then 1 else limits.attempts + 1 end
  returning attempts into v_attempts;
  if v_attempts > 5 then return false; end if;

  select p.id, p.full_name, u.email
    into v_user_id, v_full_name, v_email_snapshot
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'member'
    and lower(u.email) = v_email
    and (
      upper(regexp_replace(btrim(coalesce(p.registration_school_id, '')), '\s', '', 'g')) = v_school_id
      or upper(regexp_replace(btrim(coalesce(p.school_id, '')), '\s', '', 'g')) = v_school_id
    )
  for update of p;

  if v_user_id is null then return false; end if;
  if exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = v_user_id and r.status in ('pending', 'approved')
  ) then
    return true;
  end if;

  begin
    insert into public.member_verification_assistance_requests (
      user_id, full_name_snapshot, email_snapshot, school_id_snapshot
    ) values (
      v_user_id, coalesce(nullif(btrim(v_full_name), ''), 'Member account'), v_email_snapshot, v_school_id
    ) returning id into v_request_id;
  exception when unique_violation then
    -- An equivalent request already exists or another account currently holds
    -- this claim. Return the same generic response either way.
    return true;
  end;

  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, new_values
  ) values (
    null, 'Unverified requester', 'unknown',
    'member_verification_requested', 'members', 'Requested manual library identity verification.',
    'profile', v_user_id, 'success', jsonb_build_object('request_id', v_request_id)
  );

  return true;
end;
$$;
revoke all on function public.request_member_verification_assistance(text, text, text) from public, anon, authenticated;
grant execute on function public.request_member_verification_assistance(text, text, text) to service_role;

create or replace function public.admin_user_email_verification_status()
returns table(user_id uuid, email_confirmed_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Administrator access required'; end if;
  return query
    select p.id, u.email_confirmed_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.created_at desc;
end;
$$;
revoke all on function public.admin_user_email_verification_status() from public, anon;
grant execute on function public.admin_user_email_verification_status() to authenticated;

create or replace function public.admin_member_verification_requests()
returns table(
  request_id uuid,
  user_id uuid,
  full_name text,
  email text,
  school_id text,
  status text,
  email_confirmed_at timestamptz,
  library_member_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Administrator access required'; end if;
  return query
    select r.id, r.user_id, r.full_name_snapshot, coalesce(u.email, r.email_snapshot), r.school_id_snapshot,
      r.status, u.email_confirmed_at, r.library_member_id, r.created_at
    from public.member_verification_assistance_requests r
    left join auth.users u on u.id = r.user_id
    where r.status = 'pending'
      or (r.status = 'approved' and u.email_confirmed_at is null)
    order by case when r.status = 'pending' then 0 else 1 end, r.created_at desc;
end;
$$;
revoke all on function public.admin_member_verification_requests() from public, anon;
grant execute on function public.admin_member_verification_requests() to authenticated;

create or replace function public.get_admin_verification_request(
  p_request_id uuid,
  p_admin_user_id uuid
) returns table(id uuid, user_id uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from public.profiles where profiles.id = p_admin_user_id and role = 'administrator') then
    raise exception 'Administrator access required';
  end if;
  return query
    select r.id, r.user_id, r.status
    from public.member_verification_assistance_requests r
    where r.id = p_request_id;
end;
$$;
revoke all on function public.get_admin_verification_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_admin_verification_request(uuid, uuid) to service_role;

create or replace function public.admin_review_member_verification_request(
  p_request_id uuid,
  p_decision text,
  p_library_member_id uuid default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_request public.member_verification_assistance_requests%rowtype;
  v_profile public.profiles%rowtype;
  v_member public.library_members%rowtype;
  v_admin_name text;
  v_admin_role text;
  v_school_id text;
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Administrator access required'; end if;
  if p_decision not in ('approve', 'deny') then raise exception 'Invalid review decision'; end if;
  perform public.lock_circulation();

  select * into v_request
  from public.member_verification_assistance_requests
  where id = p_request_id
  for update;
  if not found or v_request.status <> 'pending' then raise exception 'This request is no longer awaiting review'; end if;

  select * into v_profile from public.profiles where id = v_request.user_id for update;
  if not found or v_profile.role <> 'member' then raise exception 'The member account is no longer available'; end if;

  select coalesce(full_name, 'Administrator'), role::text into v_admin_name, v_admin_role
  from public.profiles where id = auth.uid();

  if p_decision = 'deny' then
    update public.member_verification_assistance_requests
      set status = 'denied', reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
      where id = p_request_id;
    insert into public.activity_logs (
      actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
      description, entity_type, entity_id, status, old_values, new_values
    ) values (
      auth.uid(), coalesce(v_admin_name, 'Administrator'), coalesce(v_admin_role, 'administrator'),
      'member_identity_verification_denied', 'members', 'Declined a manual library identity verification request.',
      'profile', v_request.user_id, 'success', jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'denied')
    );
    return true;
  end if;

  if p_library_member_id is null then raise exception 'Select a trusted library member record before approving'; end if;
  select * into v_member from public.library_members where id = p_library_member_id for update;
  if not found or not v_member.is_active or nullif(btrim(v_member.library_card_number), '') is null or v_member.school_id is null then
    raise exception 'The selected library record is inactive or lacks a verified card and School ID';
  end if;

  v_school_id := upper(regexp_replace(btrim(v_member.school_id), '\s', '', 'g'));
  if v_school_id <> upper(regexp_replace(btrim(v_request.school_id_snapshot), '\s', '', 'g')) then
    raise exception 'The trusted library record does not match the requested School ID';
  end if;
  if v_profile.school_id is not null and upper(regexp_replace(btrim(v_profile.school_id), '\s', '', 'g')) <> v_school_id then
    raise exception 'This account is already linked to a different verified School ID';
  end if;
  if v_member.auth_user_id is not null and v_member.auth_user_id <> v_request.user_id then
    raise exception 'The trusted library record is already linked to another account';
  end if;
  if exists (
    select 1 from public.library_members m
    where m.auth_user_id = v_request.user_id and m.id <> v_member.id
  ) then
    raise exception 'This account is already linked to a different library record';
  end if;

  update public.library_members
    set auth_user_id = v_request.user_id, updated_at = now()
    where id = v_member.id;
  update public.profiles
    set full_name = v_member.full_name,
        school_id = v_member.school_id,
        library_identity_verification_method = 'admin_review',
        library_identity_verified_at = now(),
        library_identity_verified_by = auth.uid(),
        updated_at = now()
    where id = v_request.user_id;
  update public.member_verification_assistance_requests
    set status = 'approved', library_member_id = v_member.id,
        reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
    where id = p_request_id;

  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, old_values, new_values
  ) values (
    auth.uid(), coalesce(v_admin_name, 'Administrator'), coalesce(v_admin_role, 'administrator'),
    'member_identity_manually_verified', 'members', 'Manually verified a member against a trusted library record.',
    'library_member', v_member.id, 'success',
    jsonb_build_object('library_identity_verified', false),
    jsonb_build_object('library_identity_verified', true, 'method', 'admin_review')
  );
  return true;
end;
$$;
revoke all on function public.admin_review_member_verification_request(uuid, text, uuid) from public, anon;
grant execute on function public.admin_review_member_verification_request(uuid, text, uuid) to authenticated;

-- Called by the administrator-only email recovery Edge Function after it has
-- validated the caller's JWT and changed the address through the Auth Admin API.
-- It records the replacement address and audit entry without ever confirming it.
create or replace function public.record_admin_verification_email_change(
  p_request_id uuid,
  p_admin_user_id uuid,
  p_new_email text,
  p_otp_sent boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_request public.member_verification_assistance_requests%rowtype;
  v_name text;
begin
  if p_new_email is null or p_new_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_user_id and role = 'administrator') then
    raise exception 'Administrator access required';
  end if;
  select * into v_request
    from public.member_verification_assistance_requests
    where id = p_request_id and status = 'approved'
    for update;
  if not found then raise exception 'Complete the trusted library identity review before email recovery'; end if;
  if not exists (
    select 1 from auth.users
    where id = v_request.user_id
      and lower(email) = lower(btrim(p_new_email))
      and email_confirmed_at is null
  ) then
    raise exception 'The new address is not the account email awaiting confirmation';
  end if;
  select coalesce(full_name, 'Administrator') into v_name
    from public.profiles where id = p_admin_user_id;
  update public.member_verification_assistance_requests
    set replacement_email_snapshot = lower(btrim(p_new_email)), updated_at = now()
    where id = p_request_id;
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, new_values
  ) values (
    p_admin_user_id, v_name, 'administrator', 'account_email_recovery_assisted', 'authentication',
    case when p_otp_sent
      then 'Assisted with email confirmation after a trusted library identity review; email remains unconfirmed pending OTP.'
      else 'Updated the unconfirmed email after trusted identity review, but OTP delivery failed; confirmation remains required.'
    end,
    'account', v_request.user_id, case when p_otp_sent then 'success' else 'failure' end,
    jsonb_build_object('email_confirmation_required', true, 'otp_sent', p_otp_sent)
  );
  return true;
end;
$$;
revoke all on function public.record_admin_verification_email_change(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.record_admin_verification_email_change(uuid, uuid, text, boolean) to service_role;

-- Log a completed OTP password reset without ever recording the password.
create or replace function public.record_password_changed()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text;
  v_role text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select coalesce(full_name, 'Library user'), role::text into v_name, v_role
  from public.profiles where id = auth.uid();
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status
  ) values (
    auth.uid(), coalesce(v_name, 'Library user'), coalesce(v_role, 'unknown'),
    'password_changed', 'authentication', 'Changed an account password after email recovery verification.',
    'account', auth.uid(), 'success'
  );
end;
$$;
revoke all on function public.record_password_changed() from public, anon;
grant execute on function public.record_password_changed() to authenticated;

notify pgrst, 'reload schema';
