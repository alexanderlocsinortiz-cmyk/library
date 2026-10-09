-- Registration confirmation has its own deadline, independent of Auth's OTP
-- expiry. The service-role Edge Function is the only caller allowed to claim
-- and remove an expired, unconfirmed registration.

create schema if not exists extensions;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    execute 'create extension if not exists pg_net with schema extensions';
  else
    raise notice 'pg_net is unavailable; scheduled registration cleanup must be configured on a Supabase project.';
  end if;
end;
$$;

-- The legacy settings trigger validates every system_settings key. Extend its
-- allow-list instead of bypassing validation for the new administrator value.
create or replace function public.validate_circulation_setting()
returns trigger
language plpgsql
set search_path = pg_catalog, public, auth
as $$
declare
  n numeric;
  min_value numeric;
  max_value numeric;
begin
  if new.key = 'notifications_enabled' then
    if jsonb_typeof(new.value) <> 'boolean' then raise exception 'Expected boolean'; end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
  end if;
  if new.key not in (
    'loan_period_days', 'max_active_loans', 'due_soon_days', 'max_renewals',
    'pickup_hold_days', 'fine_per_day', 'registration_completion_minutes'
  ) then
    raise exception 'Unknown circulation setting';
  end if;
  if jsonb_typeof(new.value) <> 'number' then raise exception 'Expected number'; end if;
  n := (new.value #>> '{}')::numeric;
  min_value := case
    when new.key in ('loan_period_days', 'max_active_loans', 'pickup_hold_days') then 1
    when new.key = 'registration_completion_minutes' then 5
    else 0
  end;
  max_value := case
    when new.key = 'loan_period_days' then 3
    when new.key = 'fine_per_day' then 10000
    when new.key in ('max_renewals', 'max_active_loans') then 100
    when new.key = 'registration_completion_minutes' then 1440
    else 365
  end;
  if n < min_value or n > max_value
    or (new.key <> 'fine_per_day' and n <> trunc(n))
    or (new.key = 'fine_per_day' and n <> round(n, 2)) then
    raise exception 'Setting is outside allowed bounds';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

insert into public.system_settings (key, value, description)
values (
  'registration_completion_minutes',
  '30'::jsonb,
  'Minutes allowed to complete a new member registration by email OTP.'
)
on conflict (key) do nothing;

create table if not exists public.pending_member_registrations (
  user_id uuid primary key,
  status text not null default 'pending_email_verification'
    check (status in ('pending_email_verification', 'assistance_pending', 'completed', 'expired', 'cleanup_in_progress', 'cleaned')),
  email_snapshot text,
  school_id_snapshot text,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  cleanup_started_at timestamptz,
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  cleanup_logged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pending_member_registrations_cleanup
  on public.pending_member_registrations (expires_at, user_id)
  where status in ('pending_email_verification', 'expired', 'cleanup_in_progress');

alter table public.pending_member_registrations enable row level security;
revoke all on public.pending_member_registrations from public, anon, authenticated, service_role;

create table if not exists public.registration_resend_limits (
  user_id uuid primary key,
  window_started_at timestamptz not null,
  sent_count integer not null default 1 check (sent_count between 1 and 5),
  last_sent_at timestamptz not null
);
alter table public.registration_resend_limits enable row level security;
revoke all on public.registration_resend_limits from public, anon, authenticated, service_role;

create table if not exists public.registration_public_rate_limits (
  rate_key text primary key check (rate_key ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempts integer not null default 1 check (attempts >= 1)
);
create index if not exists registration_public_rate_limits_window
  on public.registration_public_rate_limits (window_started_at);
alter table public.registration_public_rate_limits enable row level security;
revoke all on public.registration_public_rate_limits from public, anon, authenticated, service_role;

create or replace function public.registration_completion_interval()
returns interval
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_minutes integer;
begin
  select case
    when jsonb_typeof(value) = 'number' then (value #>> '{}')::integer
    else null
  end into v_minutes
  from public.system_settings
  where key = 'registration_completion_minutes';

  -- A corrupt or absent administrator setting must never create an unlimited
  -- registration window or a zero-length deadline.
  v_minutes := greatest(5, least(coalesce(v_minutes, 30), 1440));
  return make_interval(mins => v_minutes);
end;
$$;
revoke all on function public.registration_completion_interval() from public, anon, authenticated;

create or replace function public.start_member_registration_deadline()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_profile public.profiles%rowtype;
  v_school_id text;
begin
  -- Staff/invited accounts and accounts already confirmed by a trusted Auth
  -- flow are not self-service member registrations.
  if new.email_confirmed_at is not null then return new; end if;
  select * into v_profile from public.profiles where id = new.id;
  if not found or v_profile.role <> 'member' then return new; end if;
  if not (new.raw_user_meta_data ? 'registration_school_id') then return new; end if;

  v_school_id := upper(regexp_replace(btrim(coalesce(new.raw_user_meta_data ->> 'registration_school_id', '')), '\s', '', 'g'));
  insert into public.pending_member_registrations (
    user_id, email_snapshot, school_id_snapshot, started_at, expires_at
  ) values (
    new.id,
    lower(nullif(btrim(new.email), '')),
    nullif(v_school_id, ''),
    coalesce(new.created_at, now()),
    coalesce(new.created_at, now()) + public.registration_completion_interval()
  ) on conflict (user_id) do nothing;

  -- Supabase already sent the initial signup OTP. Count it toward backend
  -- resend limits so a client cannot bypass the first cooldown.
  insert into public.registration_resend_limits (user_id, window_started_at, sent_count, last_sent_at)
  values (new.id, coalesce(new.created_at, now()), 1, coalesce(new.created_at, now()))
  on conflict (user_id) do nothing;

  return new;
end;
$$;
revoke all on function public.start_member_registration_deadline() from public, anon, authenticated;
drop trigger if exists on_auth_user_registration_deadline on auth.users;
create trigger on_auth_user_registration_deadline
  after insert on auth.users
  for each row execute function public.start_member_registration_deadline();

-- Give previously created, unconfirmed member registrations a fresh 30-minute
-- transition window. This avoids deleting accounts as a side effect of rollout
-- while still ensuring old incomplete claims cannot block registration forever.
insert into public.pending_member_registrations (
  user_id, status, email_snapshot, school_id_snapshot, started_at, expires_at
)
select p.id,
  case when exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = p.id and r.status in ('pending', 'approved')
  ) then 'assistance_pending' else 'pending_email_verification' end,
  lower(nullif(btrim(u.email), '')),
  upper(regexp_replace(btrim(p.registration_school_id), '\s', '', 'g')),
  now(),
  now() + public.registration_completion_interval()
from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'member'
  and p.registration_school_id is not null
  and u.email_confirmed_at is null
on conflict (user_id) do nothing;

insert into public.registration_resend_limits (user_id, window_started_at, sent_count, last_sent_at)
select r.user_id, now(), 1, now()
from public.pending_member_registrations r
where r.status in ('pending_email_verification', 'assistance_pending')
on conflict (user_id) do nothing;

create or replace function public.registration_has_library_history(
  p_user_id uuid,
  p_school_id text
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    exists (
      select 1 from public.library_members m
      where m.auth_user_id = p_user_id
        or (m.is_active and (
          m.id = p_user_id
          or (nullif(btrim(p_school_id), '') is not null
            and upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) =
              upper(regexp_replace(btrim(p_school_id), '\s', '', 'g')))
        ))
    )
    or exists (
      select 1 from public.loans l
      left join public.library_members m on m.id = l.member_id
      where l.member_id = p_user_id or m.auth_user_id = p_user_id
        or (nullif(btrim(p_school_id), '') is not null
          and upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) =
            upper(regexp_replace(btrim(p_school_id), '\s', '', 'g')))
    )
    or exists (
      select 1 from public.reservations r
      left join public.library_members m on m.id = r.member_id
      where r.member_id = p_user_id or m.auth_user_id = p_user_id
        or (nullif(btrim(p_school_id), '') is not null
          and upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) =
            upper(regexp_replace(btrim(p_school_id), '\s', '', 'g')))
    );
$$;
revoke all on function public.registration_has_library_history(uuid, text) from public, anon, authenticated;

create or replace function public.guard_profile_registration_cleanup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_school_id text;
begin
  if (old.role, old.school_id, old.registration_school_id)
      is not distinct from (new.role, new.school_id, new.registration_school_id) then
    return new;
  end if;

  for v_school_id in
    select distinct upper(regexp_replace(btrim(school_id), '\s', '', 'g'))
    from (values (old.registration_school_id), (new.registration_school_id), (old.school_id), (new.school_id)) as ids(school_id)
    where nullif(btrim(school_id), '') is not null
    order by 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('registration-school-id:' || v_school_id, 0));
  end loop;

  if exists (
    select 1 from public.pending_member_registrations r
    where r.user_id = old.id and r.status = 'cleanup_in_progress'
  ) then
    raise exception 'This registration is being safely cleaned up. Retry this account change shortly.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_profile_registration_cleanup() from public, anon, authenticated;
drop trigger if exists guard_profile_registration_cleanup on public.profiles;
create trigger guard_profile_registration_cleanup
  before update of role, school_id, registration_school_id on public.profiles
  for each row execute function public.guard_profile_registration_cleanup();

create or replace function public.guard_library_member_registration_cleanup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_old_school_id text;
  v_new_school_id text;
  v_old_user_id uuid;
  v_new_user_id uuid;
  v_school_id text;
begin
  if tg_op = 'UPDATE' then
    v_old_school_id := old.school_id;
    v_old_user_id := old.auth_user_id;
  end if;
  v_new_school_id := new.school_id;
  v_new_user_id := new.auth_user_id;

  for v_school_id in
    select distinct upper(regexp_replace(btrim(ids.school_id), '\s', '', 'g'))
    from (
      values
        (v_old_school_id), (v_new_school_id),
        ((select r.school_id_snapshot from public.pending_member_registrations r where r.user_id = v_old_user_id)),
        ((select r.school_id_snapshot from public.pending_member_registrations r where r.user_id = v_new_user_id))
    ) as ids(school_id)
    where nullif(btrim(ids.school_id), '') is not null
    order by 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('registration-school-id:' || v_school_id, 0));
  end loop;

  if exists (
    select 1 from public.pending_member_registrations r
    where r.status = 'cleanup_in_progress'
      and (
        r.user_id in (v_old_user_id, v_new_user_id)
        or (nullif(btrim(v_old_school_id), '') is not null
          and upper(regexp_replace(btrim(r.school_id_snapshot), '\s', '', 'g')) =
            upper(regexp_replace(btrim(v_old_school_id), '\s', '', 'g')))
        or (nullif(btrim(v_new_school_id), '') is not null
          and upper(regexp_replace(btrim(r.school_id_snapshot), '\s', '', 'g')) =
            upper(regexp_replace(btrim(v_new_school_id), '\s', '', 'g')))
      )
  ) then
    raise exception 'This School ID is being safely cleaned up. Retry the library record change shortly.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_library_member_registration_cleanup() from public, anon, authenticated;
drop trigger if exists guard_library_member_registration_cleanup on public.library_members;
create trigger guard_library_member_registration_cleanup
  before insert or update on public.library_members
  for each row execute function public.guard_library_member_registration_cleanup();

create or replace function public.guard_auth_registration_email_cleanup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if old.email is not distinct from new.email then return new; end if;
  if exists (
    select 1 from public.pending_member_registrations r
    where r.user_id = old.id and r.status = 'cleanup_in_progress'
  ) and not exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = old.id and r.status in ('pending', 'approved')
  ) then
    raise exception 'This registration is being safely cleaned up. Retry the email change shortly.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_auth_registration_email_cleanup() from public, anon, authenticated;
drop trigger if exists guard_auth_registration_email_cleanup on auth.users;
create trigger guard_auth_registration_email_cleanup
  before update of email on auth.users
  for each row execute function public.guard_auth_registration_email_cleanup();

create or replace function public.guard_member_registration_email_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_registration public.pending_member_registrations%rowtype;
  v_assistance_open boolean;
begin
  if old.email_confirmed_at is not null or new.email_confirmed_at is null then return new; end if;

  select * into v_registration
    from public.pending_member_registrations
    where user_id = new.id
    for update;
  if not found then return new; end if;
  if v_registration.status in ('completed', 'cleaned') then return new; end if;

  select exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = new.id and r.status in ('pending', 'approved')
  ) into v_assistance_open;

  if v_assistance_open then return new; end if;
  if v_registration.email_snapshot is not null
    and lower(v_registration.email_snapshot) <> lower(coalesce(new.email, '')) then
    raise exception 'Registration email changed. Contact library staff for help.';
  end if;
  if v_registration.status = 'cleanup_in_progress'
     or v_registration.expires_at <= now()
     or v_registration.status in ('expired', 'cleaned') then
    update public.pending_member_registrations
      set status = 'expired', updated_at = now()
      where user_id = new.id;
    raise exception 'Registration expired. Please create your account again.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_member_registration_email_confirmation() from public, anon, authenticated;
drop trigger if exists guard_member_registration_email_confirmation on auth.users;
create trigger guard_member_registration_email_confirmation
  before update of email_confirmed_at on auth.users
  for each row execute function public.guard_member_registration_email_confirmation();

create or replace function public.complete_member_registration_email_verification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_name text;
  v_role text;
begin
  if old.email_confirmed_at is not null or new.email_confirmed_at is null then return new; end if;

  update public.pending_member_registrations
    set status = 'completed', completed_at = coalesce(new.email_confirmed_at, now()), updated_at = now()
    where user_id = new.id
      and status not in ('completed', 'cleaned');
  if found then
    delete from public.registration_resend_limits where user_id = new.id;
    select coalesce(full_name, 'Library user'), role::text into v_name, v_role
      from public.profiles where id = new.id;
    insert into public.activity_logs (
      actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
      description, entity_type, entity_id, status
    ) values (
      new.id, coalesce(v_name, 'Library user'), coalesce(v_role, 'member'),
      'registration_email_verified', 'authentication',
      'Completed account email verification using the registration code.',
      'auth_registration', new.id, 'success'
    );
  end if;
  return new;
end;
$$;
revoke all on function public.complete_member_registration_email_verification() from public, anon, authenticated;
drop trigger if exists complete_member_registration_email_verification on auth.users;
create trigger complete_member_registration_email_verification
  after update of email_confirmed_at on auth.users
  for each row execute function public.complete_member_registration_email_verification();

-- These RPCs are callable only by the registration Edge Function with its
-- server-side service-role client. The browser never supplies a user ID.
create or replace function public.consume_registration_public_rate_limit(
  p_rate_key text,
  p_limit integer default 10,
  p_window_seconds integer default 3600
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
begin
  delete from public.registration_public_rate_limits
    where window_started_at < now() - interval '1 day';
  if p_rate_key is null or p_rate_key !~ '^[a-f0-9]{64}$'
     or p_limit not between 1 and 100
     or p_window_seconds not between 1 and 86400 then
    return false;
  end if;
  insert into public.registration_public_rate_limits as limits (rate_key, window_started_at, attempts)
  values (p_rate_key, now(), 1)
  on conflict (rate_key) do update set
    window_started_at = case
      when limits.window_started_at < now() - make_interval(secs => p_window_seconds) then now()
      else limits.window_started_at end,
    attempts = case
      when limits.window_started_at < now() - make_interval(secs => p_window_seconds) then 1
      else limits.attempts + 1 end
  returning attempts into v_attempts;
  return v_attempts <= p_limit;
end;
$$;
revoke all on function public.consume_registration_public_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_registration_public_rate_limit(text, integer, integer) to service_role;

create or replace function public.get_member_registration_status(
  p_email text,
  p_school_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid;
  v_confirmed_at timestamptz;
  v_current_email text;
  v_registration public.pending_member_registrations%rowtype;
  v_profile public.profiles%rowtype;
  v_assistance_open boolean;
begin
  select u.id, u.email_confirmed_at, lower(u.email) into v_user_id, v_confirmed_at, v_current_email
  from auth.users u
  join public.profiles p on p.id = u.id
  where p.role = 'member'
    and lower(u.email) = lower(btrim(coalesce(p_email, '')))
    and (
      p.registration_school_id is null
      or upper(regexp_replace(btrim(coalesce(p.registration_school_id, '')), '\s', '', 'g')) =
        upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'))
    )
  limit 1;
  if v_user_id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_confirmed_at is not null then return jsonb_build_object('status', 'verified'); end if;

  select * into v_registration from public.pending_member_registrations where user_id = v_user_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = v_user_id and r.status in ('pending', 'approved')
  ) into v_assistance_open;

  if v_assistance_open then
    update public.pending_member_registrations set status = 'assistance_pending', updated_at = now()
      where user_id = v_user_id and status in ('pending_email_verification', 'expired');
    return jsonb_build_object('status', 'assistance_pending', 'expires_at', v_registration.expires_at);
  end if;
  if v_registration.expires_at <= now() or v_registration.status in ('expired', 'cleanup_in_progress', 'cleaned') then
    select * into v_profile from public.profiles where id = v_user_id;
    if not found or v_profile.role <> 'member' then
      return jsonb_build_object('status', 'expired_protected', 'expires_at', v_registration.expires_at);
    end if;
    if (v_registration.email_snapshot is not null and lower(v_registration.email_snapshot) <> v_current_email)
      or public.registration_has_library_history(v_user_id, v_profile.registration_school_id) then
      update public.pending_member_registrations set status = 'expired', updated_at = now()
        where user_id = v_user_id and status not in ('completed', 'cleanup_in_progress');
      return jsonb_build_object('status', 'expired_protected', 'expires_at', v_registration.expires_at);
    end if;
    update public.pending_member_registrations set status = 'expired', updated_at = now()
      where user_id = v_user_id and status not in ('completed', 'cleanup_in_progress');
    return jsonb_build_object('status', 'expired', 'expires_at', v_registration.expires_at);
  end if;
  return jsonb_build_object('status', 'pending_email_verification', 'expires_at', v_registration.expires_at);
end;
$$;
revoke all on function public.get_member_registration_status(text, text) from public, anon, authenticated;
grant execute on function public.get_member_registration_status(text, text) to service_role;

create or replace function public.authorize_registration_otp_resend(
  p_email text,
  p_school_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid;
  v_confirmed_at timestamptz;
  v_current_email text;
  v_registration public.pending_member_registrations%rowtype;
  v_assistance_open boolean;
  v_limit public.registration_resend_limits%rowtype;
  v_profile public.profiles%rowtype;
begin
  select u.id, u.email_confirmed_at, lower(u.email) into v_user_id, v_confirmed_at, v_current_email
  from auth.users u
  join public.profiles p on p.id = u.id
  where p.role = 'member'
    and lower(u.email) = lower(btrim(coalesce(p_email, '')))
    and (
      p.registration_school_id is null
      or upper(regexp_replace(btrim(coalesce(p.registration_school_id, '')), '\s', '', 'g')) =
        upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'))
    )
  limit 1;
  if v_user_id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_confirmed_at is not null then return jsonb_build_object('status', 'verified'); end if;

  select * into v_registration from public.pending_member_registrations
    where user_id = v_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = v_user_id and r.status in ('pending', 'approved')
  ) into v_assistance_open;
  if v_registration.expires_at <= now() and not v_assistance_open then
    select * into v_profile from public.profiles where id = v_user_id;
    if (v_registration.email_snapshot is not null and lower(v_registration.email_snapshot) <> v_current_email)
      or public.registration_has_library_history(v_user_id, v_profile.registration_school_id) then
      return jsonb_build_object('status', 'preserved');
    end if;
    update public.pending_member_registrations set status = 'expired', updated_at = now() where user_id = v_user_id;
    return jsonb_build_object('status', 'expired', 'expires_at', v_registration.expires_at);
  end if;

  insert into public.registration_resend_limits (user_id, window_started_at, sent_count, last_sent_at)
  values (v_user_id, now(), 1, now())
  on conflict (user_id) do nothing;
  select * into v_limit from public.registration_resend_limits where user_id = v_user_id for update;

  if v_limit.last_sent_at > now() - interval '60 seconds' then
    return jsonb_build_object('status', 'cooldown', 'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_limit.last_sent_at + interval '60 seconds' - now())))::integer));
  end if;
  if v_limit.window_started_at <= now() - interval '1 hour' then
    update public.registration_resend_limits set window_started_at = now(), sent_count = 1, last_sent_at = now()
      where user_id = v_user_id;
  elsif v_limit.sent_count >= 5 then
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_limit.window_started_at + interval '1 hour' - now())))::integer));
  else
    update public.registration_resend_limits set sent_count = sent_count + 1, last_sent_at = now()
      where user_id = v_user_id;
  end if;
  return jsonb_build_object('status', 'allowed', 'email', lower(btrim(p_email)));
end;
$$;
revoke all on function public.authorize_registration_otp_resend(text, text) from public, anon, authenticated;
grant execute on function public.authorize_registration_otp_resend(text, text) to service_role;

-- Lock order is always Auth user, then registration state. Assistance requests,
-- OTP confirmation, and cleanup use the same order to avoid deletion races.
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
  v_registration public.pending_member_registrations%rowtype;
  v_profile public.profiles%rowtype;
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

  -- Lock the Auth row first so a request submitted before expiration wins a
  -- deterministic race against the scheduled cleanup worker.
  select u.id, u.email, p.full_name
    into v_user_id, v_email_snapshot, v_full_name
  from auth.users u
  join public.profiles p on p.id = u.id
  where p.role = 'member'
    and lower(u.email) = v_email
    and (
      upper(regexp_replace(btrim(coalesce(p.registration_school_id, '')), '\s', '', 'g')) = v_school_id
      or upper(regexp_replace(btrim(coalesce(p.school_id, '')), '\s', '', 'g')) = v_school_id
    )
  for update of u;
  if v_user_id is null then return false; end if;

  select * into v_registration from public.pending_member_registrations
    where user_id = v_user_id for update;
  if found and v_registration.expires_at <= now() and not exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = v_user_id and r.status in ('pending', 'approved')
  ) then
    select * into v_profile from public.profiles where id = v_user_id;
    if (v_registration.email_snapshot is not null and lower(v_registration.email_snapshot) <> lower(v_email_snapshot))
      or public.registration_has_library_history(v_user_id, v_profile.registration_school_id) then
      return false;
    end if;
    update public.pending_member_registrations set status = 'expired', updated_at = now()
      where user_id = v_user_id;
    return false;
  end if;

  if exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = v_user_id and r.status in ('pending', 'approved')
  ) then
    update public.pending_member_registrations set status = 'assistance_pending', updated_at = now()
      where user_id = v_user_id and status in ('pending_email_verification', 'expired');
    return true;
  end if;

  begin
    insert into public.member_verification_assistance_requests (
      user_id, full_name_snapshot, email_snapshot, school_id_snapshot
    ) values (
      v_user_id, coalesce(nullif(btrim(v_full_name), ''), 'Member account'), v_email_snapshot, v_school_id
    ) returning id into v_request_id;
  exception when unique_violation then
    return true;
  end;

  update public.pending_member_registrations set status = 'assistance_pending', updated_at = now()
    where user_id = v_user_id and status in ('pending_email_verification', 'expired');
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, new_values
  ) values (
    null, 'Unverified requester', 'unknown', 'member_verification_requested', 'members',
    'Requested manual library identity verification.', 'profile', v_user_id, 'success',
    jsonb_build_object('request_id', v_request_id)
  );
  return true;
end;
$$;
revoke all on function public.request_member_verification_assistance(text, text, text) from public, anon, authenticated;
grant execute on function public.request_member_verification_assistance(text, text, text) to service_role;

create or replace function public.claim_expired_member_registration(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_auth_user auth.users%rowtype;
  v_registration public.pending_member_registrations%rowtype;
  v_profile public.profiles%rowtype;
begin
  if p_user_id is null then return false; end if;

  select * into v_auth_user from auth.users where id = p_user_id for update skip locked;
  if not found then
    select * into v_registration from public.pending_member_registrations
      where user_id = p_user_id for update skip locked;
    if not found or v_registration.expires_at > now()
      or v_registration.status not in ('pending_email_verification', 'assistance_pending', 'expired', 'cleanup_in_progress') then
      return false;
    end if;
    if v_registration.status = 'cleanup_in_progress'
      and v_registration.cleanup_started_at >= now() - interval '5 minutes' then
      return false;
    end if;
    if nullif(btrim(v_registration.school_id_snapshot), '') is not null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'registration-school-id:' || upper(regexp_replace(btrim(v_registration.school_id_snapshot), '\s', '', 'g')), 0
      ));
    end if;
    if exists (
      select 1 from public.member_verification_assistance_requests r
      where r.user_id = p_user_id and r.status in ('pending', 'approved')
    ) or public.registration_has_library_history(p_user_id, v_registration.school_id_snapshot) then
      return false;
    end if;
    update public.pending_member_registrations
      set status = 'cleanup_in_progress', cleanup_started_at = now(),
          cleanup_attempts = cleanup_attempts + 1, updated_at = now()
      where user_id = p_user_id;
    return true;
  end if;

  select * into v_registration from public.pending_member_registrations
    where user_id = p_user_id for update skip locked;
  if not found or v_registration.expires_at > now()
    or v_registration.status not in ('pending_email_verification', 'assistance_pending', 'expired', 'cleanup_in_progress') then
    return false;
  end if;
  if v_auth_user.email_confirmed_at is not null then
    update public.pending_member_registrations set status = 'completed', completed_at = coalesce(v_auth_user.email_confirmed_at, now()), updated_at = now()
      where user_id = p_user_id;
    return false;
  end if;
  if v_registration.status = 'cleanup_in_progress'
    and v_registration.cleanup_started_at >= now() - interval '5 minutes' then
    return false;
  end if;
  if exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = p_user_id and r.status in ('pending', 'approved')
  ) then
    update public.pending_member_registrations set status = 'assistance_pending', cleanup_started_at = null, updated_at = now()
      where user_id = p_user_id;
    return false;
  end if;

  select * into v_profile from public.profiles where id = p_user_id;
  if not found or v_profile.role <> 'member' then return false; end if;
  if nullif(btrim(v_profile.registration_school_id), '') is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'registration-school-id:' || upper(regexp_replace(btrim(v_profile.registration_school_id), '\s', '', 'g')), 0
    ));
  end if;
  if (v_registration.email_snapshot is not null
      and lower(v_registration.email_snapshot) <> lower(coalesce(v_auth_user.email, '')))
    or public.registration_has_library_history(p_user_id, v_profile.registration_school_id) then
    return false;
  end if;

  update public.pending_member_registrations
    set status = 'cleanup_in_progress', cleanup_started_at = now(),
        cleanup_attempts = cleanup_attempts + 1, updated_at = now()
    where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.claim_expired_member_registration(uuid) from public, anon, authenticated;
grant execute on function public.claim_expired_member_registration(uuid) to service_role;

create or replace function public.validate_member_registration_cleanup(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_auth_user auth.users%rowtype;
  v_registration public.pending_member_registrations%rowtype;
  v_profile public.profiles%rowtype;
begin
  select * into v_auth_user from auth.users where id = p_user_id for update skip locked;
  if not found then return false; end if;
  select * into v_registration from public.pending_member_registrations
    where user_id = p_user_id for update skip locked;
  if not found or v_registration.status <> 'cleanup_in_progress' then return false; end if;
  if v_auth_user.email_confirmed_at is not null then
    update public.pending_member_registrations
      set status = 'completed', completed_at = v_auth_user.email_confirmed_at,
          cleanup_started_at = null, updated_at = now()
      where user_id = p_user_id;
    return false;
  end if;
  if exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = p_user_id and r.status in ('pending', 'approved')
  ) then
    update public.pending_member_registrations
      set status = 'assistance_pending', cleanup_started_at = null, updated_at = now()
      where user_id = p_user_id;
    return false;
  end if;
  select * into v_profile from public.profiles where id = p_user_id;
  if not found or v_profile.role <> 'member' then
    update public.pending_member_registrations
      set status = 'expired', cleanup_started_at = null, updated_at = now()
      where user_id = p_user_id;
    return false;
  end if;
  if nullif(btrim(v_profile.registration_school_id), '') is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'registration-school-id:' || upper(regexp_replace(btrim(v_profile.registration_school_id), '\s', '', 'g')), 0
    ));
  end if;
  if v_registration.expires_at > now()
    or (v_registration.email_snapshot is not null and lower(v_registration.email_snapshot) <> lower(coalesce(v_auth_user.email, '')))
    or public.registration_has_library_history(p_user_id, v_profile.registration_school_id) then
    update public.pending_member_registrations
      set status = 'expired', cleanup_started_at = null, updated_at = now()
      where user_id = p_user_id;
    return false;
  end if;
  return true;
end;
$$;
revoke all on function public.validate_member_registration_cleanup(uuid) from public, anon, authenticated;
grant execute on function public.validate_member_registration_cleanup(uuid) to service_role;

create or replace function public.claim_expired_registration_for_signup(
  p_email text,
  p_school_id text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid;
begin
  select u.id into v_user_id
  from auth.users u
  join public.profiles p on p.id = u.id
  join public.pending_member_registrations r on r.user_id = u.id
  where lower(u.email) = lower(btrim(coalesce(p_email, '')))
    and (
      p.registration_school_id is null
      or upper(regexp_replace(btrim(coalesce(p.registration_school_id, '')), '\s', '', 'g')) =
        upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'))
    )
  limit 1;
  if v_user_id is null then return null; end if;
  if public.claim_expired_member_registration(v_user_id) then return v_user_id; end if;
  return null;
end;
$$;
revoke all on function public.claim_expired_registration_for_signup(text, text) from public, anon, authenticated;
grant execute on function public.claim_expired_registration_for_signup(text, text) to service_role;

create or replace function public.list_expired_member_registrations(p_limit integer default 50)
returns table(user_id uuid)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select r.user_id
  from public.pending_member_registrations r
  where r.expires_at <= now()
    and r.status in ('pending_email_verification', 'assistance_pending', 'expired', 'cleanup_in_progress')
    and (r.status <> 'cleanup_in_progress' or r.cleanup_started_at < now() - interval '5 minutes')
  order by r.expires_at, r.user_id
  limit greatest(1, least(coalesce(p_limit, 50), 100))
$$;
revoke all on function public.list_expired_member_registrations(integer) from public, anon, authenticated;
grant execute on function public.list_expired_member_registrations(integer) to service_role;

create or replace function public.finish_expired_member_registration_cleanup(
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
  if not found or v_registration.status = 'cleaned' then return; end if;
  if p_deleted then
    if v_registration.cleanup_logged_at is null then
      insert into public.activity_logs (
        actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
        description, entity_type, entity_id, status, old_values, new_values
      ) values (
        null, 'System Cleanup', 'system', 'registration_expired_cleanup', 'authentication',
        'Removed an expired, unconfirmed registration after rechecking account and library records.',
        'auth_registration', p_user_id, 'success',
        jsonb_build_object('registration_status', 'expired'),
        jsonb_build_object('registration_status', 'cleaned')
      );
    end if;
    update public.pending_member_registrations
      set status = 'cleaned', email_snapshot = null, school_id_snapshot = null,
          cleanup_started_at = null, cleanup_logged_at = coalesce(cleanup_logged_at, now()), updated_at = now()
      where user_id = p_user_id;
    delete from public.registration_resend_limits where user_id = p_user_id;
  else
    v_error_code := case
      when p_error_code ~ '^[a-zA-Z0-9_.-]{1,80}$'
        and p_error_code !~* '(password|token|secret|pin|otp)' then p_error_code
      else 'unknown'
    end;
    insert into public.activity_logs (
      actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
      description, entity_type, entity_id, status, old_values, new_values
    ) values (
      null, 'System Cleanup', 'system', 'registration_expired_cleanup', 'authentication',
      'Could not safely remove an expired registration; it remains pending for a later retry.',
      'auth_registration', p_user_id, 'failure',
      jsonb_build_object('registration_status', 'cleanup_in_progress'),
      jsonb_build_object('registration_status', 'expired', 'error_code', v_error_code)
    );
    update public.pending_member_registrations
      set status = 'expired', cleanup_started_at = null, updated_at = now()
      where user_id = p_user_id;
  end if;
end;
$$;
revoke all on function public.finish_expired_member_registration_cleanup(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.finish_expired_member_registration_cleanup(uuid, boolean, text) to service_role;

-- Called by pg_cron each minute. Its URL and shared secret are read from
-- Supabase Vault at runtime; neither value is stored in migrations.
create or replace function public.invoke_registration_cleanup()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, vault, net
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'supabase_project_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'registration_cleanup_secret' limit 1;
  if nullif(v_url, '') is null or nullif(v_secret, '') is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/registration-lifecycle',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('action', 'cleanup'),
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function public.invoke_registration_cleanup() from public, anon, authenticated, service_role;

do $$
declare
  v_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net')
     and to_regclass('vault.decrypted_secrets') is not null then
    select jobid into v_job_id from cron.job where jobname = 'registration-expired-cleanup';
    if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
    perform cron.schedule(
      'registration-expired-cleanup',
      '* * * * *',
      'select public.invoke_registration_cleanup();'
    );
  else
    raise notice 'Registration cleanup was not scheduled because pg_cron, pg_net, or Supabase Vault is unavailable.';
  end if;
end;
$$;

notify pgrst, 'reload schema';
