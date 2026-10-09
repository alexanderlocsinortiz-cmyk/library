-- Email confirmation creates a separate, provisional borrower record. It never
-- attaches the account to an existing student record or copies a submitted ID.
alter table public.library_members
  add column if not exists email_only boolean not null default false;

comment on column public.library_members.email_only is
  'True for a borrower record created from a verified email account before trusted LMS identity matching.';

update public.system_settings
set description = 'Minutes allowed to complete a new member registration by email confirmation.'
where key = 'registration_completion_minutes';

-- New accounts no longer need to claim an existing borrower record during signup.
revoke all on function public.complete_member_account_registration(text, text, text)
  from public, anon, authenticated;
revoke all on function public.admin_member_verification_requests()
  from public, anon, authenticated;
revoke all on function public.admin_review_member_verification_request(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.request_member_verification_assistance(text, text, text)
  from public, anon, authenticated, service_role;

-- Retire unfinished assistance requests without deleting their history. They
-- no longer block email confirmation or the normal pending-registration cleanup.
alter table public.member_verification_assistance_requests
  drop constraint if exists member_verification_assistance_requests_status_check;
alter table public.member_verification_assistance_requests
  add constraint member_verification_assistance_requests_status_check
  check (status in ('pending', 'approved', 'denied', 'withdrawn'));
update public.member_verification_assistance_requests
set status = 'withdrawn', reviewed_at = coalesce(reviewed_at, now()), updated_at = now()
where status = 'pending';
update public.pending_member_registrations r
set status = 'pending_email_verification', updated_at = now()
where r.status = 'assistance_pending'
  and not exists (
    select 1 from public.member_verification_assistance_requests a
    where a.user_id = r.user_id and a.status = 'approved'
  );

create or replace function public.mark_email_only_library_member_verified()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.library_card_number is not null and new.school_id is not null then
    new.email_only := false;
  end if;
  return new;
end;
$$;
revoke all on function public.mark_email_only_library_member_verified() from public, anon, authenticated;
drop trigger if exists mark_email_only_library_member_verified on public.library_members;
create trigger mark_email_only_library_member_verified
  before update of library_card_number, school_id on public.library_members
  for each row execute function public.mark_email_only_library_member_verified();

-- An active email-only record is enough for an account to access its own holds.
-- It has no School ID or card number, so it cannot inherit another borrower's
-- history or sign in using that borrower's identity.
create or replace function public.current_user_has_active_library_member()
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.library_members m on m.auth_user_id = p.id
    where p.id = auth.uid()
      and p.role = 'member'
      and m.is_active
  )
$$;
revoke all on function public.current_user_has_active_library_member() from public, anon;
grant execute on function public.current_user_has_active_library_member() to authenticated;

-- Start the same server-side confirmation deadline for every self-service
-- member registration. A School ID is no longer required during signup.
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
  if new.email_confirmed_at is not null then return new; end if;
  select * into v_profile from public.profiles where id = new.id;
  if not found or v_profile.role <> 'member' then return new; end if;

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

  insert into public.registration_resend_limits (user_id, window_started_at, sent_count, last_sent_at)
  values (new.id, coalesce(new.created_at, now()), 1, coalesce(new.created_at, now()))
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.start_member_registration_deadline() from public, anon, authenticated;

-- Completion of the email link creates a fresh borrower record owned by this
-- Auth account. The submitted School ID is intentionally not copied or matched.
create or replace function public.complete_member_registration_email_verification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_name text;
  v_role text;
  v_registration_completed boolean;
begin
  if old.email_confirmed_at is not null or new.email_confirmed_at is null then return new; end if;

  update public.pending_member_registrations
    set status = 'completed', completed_at = coalesce(new.email_confirmed_at, now()), updated_at = now()
    where user_id = new.id and status not in ('completed', 'cleaned');
  v_registration_completed := found;
  if v_registration_completed then
    delete from public.registration_resend_limits where user_id = new.id;
  end if;

  select coalesce(nullif(btrim(full_name), ''), 'Library user'), role::text
    into v_name, v_role
    from public.profiles where id = new.id;
  if v_role = 'member' then
    insert into public.library_members (full_name, member_type, auth_user_id, email_only)
    values (v_name, 'other', new.id, true)
    on conflict (auth_user_id) where auth_user_id is not null do nothing;
  end if;

  if v_registration_completed then
    insert into public.activity_logs (
      actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
      description, entity_type, entity_id, status
    ) values (
      new.id, coalesce(v_name, 'Library user'), coalesce(v_role, 'member'),
      'registration_email_verified', 'authentication',
      'Completed account email verification using the confirmation link.',
      'auth_registration', new.id, 'success'
    );
  end if;
  return new;
end;
$$;
revoke all on function public.complete_member_registration_email_verification() from public, anon, authenticated;

-- Give already-confirmed unlinked member accounts their own provisional record.
-- Never match these accounts to an existing library member by a claimed ID.
insert into public.library_members (full_name, member_type, auth_user_id, email_only)
select coalesce(nullif(btrim(p.full_name), ''), 'Library user'), 'other', p.id, true
from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'member'
  and u.email_confirmed_at is not null
  and not exists (select 1 from public.library_members m where m.auth_user_id = p.id)
on conflict (auth_user_id) where auth_user_id is not null do nothing;

-- The public resume/resend flow is email-only. Older registrations that have a
-- stored School ID claim remain resumable by email; the claim still grants no
-- identity or record-linking authority.
create or replace function public.get_member_registration_status(
  p_email text,
  p_school_id text
) returns jsonb
language plpgsql security definer
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
      nullif(btrim(coalesce(p_school_id, '')), '') is null
      or p.registration_school_id is null
      or upper(regexp_replace(btrim(p.registration_school_id), '\s', '', 'g')) =
         upper(regexp_replace(btrim(p_school_id), '\s', '', 'g'))
    )
  limit 1;
  if v_user_id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_confirmed_at is not null then return jsonb_build_object('status', 'verified'); end if;

  select * into v_registration from public.pending_member_registrations where user_id = v_user_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = v_user_id and r.status = 'pending'
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
language plpgsql security definer
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
      nullif(btrim(coalesce(p_school_id, '')), '') is null
      or p.registration_school_id is null
      or upper(regexp_replace(btrim(p.registration_school_id), '\s', '', 'g')) =
         upper(regexp_replace(btrim(p_school_id), '\s', '', 'g'))
    )
  limit 1;
  if v_user_id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_confirmed_at is not null then return jsonb_build_object('status', 'verified'); end if;

  select * into v_registration from public.pending_member_registrations where user_id = v_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select exists (
    select 1 from public.member_verification_assistance_requests r
    where r.user_id = v_user_id and r.status = 'pending'
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
  values (v_user_id, now(), 1, now()) on conflict (user_id) do nothing;
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

create or replace function public.claim_expired_registration_for_signup(
  p_email text,
  p_school_id text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, auth
as $$
declare v_user_id uuid;
begin
  select u.id into v_user_id
  from auth.users u
  join public.profiles p on p.id = u.id
  join public.pending_member_registrations r on r.user_id = u.id
  where lower(u.email) = lower(btrim(coalesce(p_email, '')))
    and (
      nullif(btrim(coalesce(p_school_id, '')), '') is null
      or p.registration_school_id is null
      or upper(regexp_replace(btrim(p.registration_school_id), '\s', '', 'g')) =
         upper(regexp_replace(btrim(p_school_id), '\s', '', 'g'))
    )
  limit 1;
  if v_user_id is null then return null; end if;
  if public.claim_expired_member_registration(v_user_id) then return v_user_id; end if;
  return null;
end;
$$;
revoke all on function public.claim_expired_registration_for_signup(text, text) from public, anon, authenticated;
grant execute on function public.claim_expired_registration_for_signup(text, text) to service_role;

create or replace function public.claim_member_registration_cancellation(
  p_email text,
  p_school_id text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_auth_user auth.users%rowtype;
  v_profile public.profiles%rowtype;
  v_registration public.pending_member_registrations%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_school_id text := upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'));
begin
  if v_email = '' then return null; end if;
  select * into v_auth_user from auth.users where lower(email) = v_email for update skip locked;
  if not found or v_auth_user.email_confirmed_at is not null then return null; end if;
  select * into v_profile from public.profiles where id = v_auth_user.id for update;
  if not found or v_profile.role <> 'member'
    or (v_school_id <> '' and upper(regexp_replace(btrim(coalesce(v_profile.registration_school_id, '')), '\s', '', 'g')) <> v_school_id) then
    return null;
  end if;
  select * into v_registration from public.pending_member_registrations where user_id = v_auth_user.id for update skip locked;
  if not found or v_registration.status not in ('pending_email_verification', 'assistance_pending', 'expired')
    or lower(coalesce(v_registration.email_snapshot, '')) <> v_email
    or (v_school_id <> '' and upper(regexp_replace(btrim(coalesce(v_registration.school_id_snapshot, '')), '\s', '', 'g')) <> v_school_id) then
    return null;
  end if;
  if exists (
    select 1 from public.library_members m where m.auth_user_id = v_auth_user.id or m.id = v_auth_user.id
  ) or exists (
    select 1 from public.loans l left join public.library_members m on m.id = l.member_id
    where l.member_id = v_auth_user.id or m.auth_user_id = v_auth_user.id
  ) or exists (
    select 1 from public.reservations r left join public.library_members m on m.id = r.member_id
    where r.member_id = v_auth_user.id or m.auth_user_id = v_auth_user.id
  ) then return null; end if;
  update public.pending_member_registrations
  set status = 'cleanup_in_progress', cleanup_started_at = now(), cleanup_attempts = cleanup_attempts + 1, updated_at = now()
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
language plpgsql security definer
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
  if not found or v_auth_user.email_confirmed_at is not null or lower(coalesce(v_auth_user.email, '')) <> v_email then return false; end if;
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found or v_profile.role <> 'member'
    or (v_school_id <> '' and upper(regexp_replace(btrim(coalesce(v_profile.registration_school_id, '')), '\s', '', 'g')) <> v_school_id) then return false; end if;
  select * into v_registration from public.pending_member_registrations where user_id = p_user_id for update skip locked;
  if not found or v_registration.status <> 'cleanup_in_progress'
    or lower(coalesce(v_registration.email_snapshot, '')) <> v_email
    or (v_school_id <> '' and upper(regexp_replace(btrim(coalesce(v_registration.school_id_snapshot, '')), '\s', '', 'g')) <> v_school_id) then return false; end if;
  if exists (
    select 1 from public.library_members m where m.auth_user_id = p_user_id or m.id = p_user_id
  ) or exists (
    select 1 from public.loans l left join public.library_members m on m.id = l.member_id
    where l.member_id = p_user_id or m.auth_user_id = p_user_id
  ) or exists (
    select 1 from public.reservations r left join public.library_members m on m.id = r.member_id
    where r.member_id = p_user_id or m.auth_user_id = p_user_id
  ) then return false; end if;
  return true;
end;
$$;
revoke all on function public.validate_member_registration_cancellation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.validate_member_registration_cancellation(uuid, text, text) to service_role;

-- Email-verified accounts may place holds using their own provisional record.
-- The physical checkout remains a staff action at the library desk.
create or replace function public.reserve_book(p_book_id uuid)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare reservation_id uuid; linked_member_id uuid; verified_email text;
begin
  perform public.lock_circulation();
  if auth.uid() is null or public.current_user_role() is distinct from 'member' then
    raise exception 'Only authenticated Members can create reservations';
  end if;
  select lower(btrim(email)) into verified_email
  from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if verified_email is null then
    raise exception 'Confirm your email before placing an online hold';
  end if;
  select id into linked_member_id from public.library_members
    where auth_user_id = auth.uid() and is_active;
  if linked_member_id is null then raise exception 'Your member account is inactive'; end if;
  perform public.process_circulation();
  if not exists (select 1 from public.books where id = p_book_id) then raise exception 'Book not found'; end if;
  if not exists (select 1 from public.book_copies where book_id = p_book_id) then
    raise exception 'This title has no physical copies; ask staff about an acquisition request';
  end if;
  if exists (select 1 from public.book_copies where book_id = p_book_id and status = 'available') then
    raise exception 'This book is currently available and does not need a reservation';
  end if;
  select id into reservation_id from public.reservations
    where book_id = p_book_id and member_id = linked_member_id and status in ('waiting', 'ready_for_pickup') limit 1;
  if reservation_id is not null then return reservation_id; end if;
  begin
    insert into public.reservations (book_id, member_id, status, email_address)
    values (p_book_id, linked_member_id, 'waiting', verified_email) returning id into reservation_id;
  exception when unique_violation then
    select id into reservation_id from public.reservations
    where book_id = p_book_id and member_id = linked_member_id and status in ('waiting', 'ready_for_pickup') limit 1;
    return reservation_id;
  end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id)
  values (auth.uid(), 'reserve', 'reservation', reservation_id);
  return reservation_id;
end;
$$;
revoke all on function public.reserve_book(uuid) from public, anon;
grant execute on function public.reserve_book(uuid) to authenticated;

-- Staff may complete an email-only account's ready hold after confirming the
-- borrower is present. Such accounts cannot be checked out as walk-ins before
-- a hold is ready; existing physical member records still require a card.
create or replace function public.checkout_copy(p_copy_id uuid, p_member_id uuid, p_due_at timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  loan_id uuid;
  copy_book_id uuid;
  current_status public.copy_status;
  active_loan_count integer;
  ready_reservation_id uuid;
  ready_reservation_member_id uuid;
  resolved_due_at timestamptz;
  selected_member public.library_members%rowtype;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Only Librarians and Administrators can check out books'; end if;
  perform public.process_circulation();
  select * into selected_member from public.library_members where id = p_member_id and is_active for update;
  if not found or (selected_member.library_card_number is null and not selected_member.email_only) then
    raise exception 'The selected borrower must have an active library record';
  end if;
  select book_id, status into copy_book_id, current_status from public.book_copies where id = p_copy_id for update;
  if copy_book_id is null then raise exception 'Book copy not found'; end if;
  select id, member_id into ready_reservation_id, ready_reservation_member_id from public.reservations
    where copy_id = p_copy_id and status = 'ready_for_pickup' order by created_at asc limit 1 for update;
  if selected_member.email_only and (ready_reservation_id is null or ready_reservation_member_id <> p_member_id) then
    raise exception 'Email-only accounts can be checked out only when completing their ready hold';
  end if;
  if current_status not in ('available', 'reserved') then raise exception 'Book copy is not available'; end if;
  if ready_reservation_id is not null and ready_reservation_member_id <> p_member_id then raise exception 'This copy is held for the next reservation'; end if;
  if current_status = 'reserved' and ready_reservation_id is null then raise exception 'Copy has no valid pickup assignment'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  select count(*) into active_loan_count from public.loans where member_id = p_member_id and status in ('borrowed', 'overdue');
  if active_loan_count >= public.get_setting_int('max_active_loans', 5) then raise exception 'This Member has reached the active loan limit'; end if;
  resolved_due_at := coalesce(p_due_at, now() + make_interval(days => public.get_setting_int('loan_period_days', 3)));
  if resolved_due_at <= now() then raise exception 'The due date must be in the future'; end if;
  if resolved_due_at > now() + make_interval(days => public.get_setting_int('loan_period_days', 3)) + interval '1 minute' then
    raise exception 'The due date exceeds the configured loan period';
  end if;
  insert into public.loans (copy_id, member_id, checked_out_by, due_at, status)
    values (p_copy_id, p_member_id, auth.uid(), resolved_due_at, 'borrowed') returning id into loan_id;
  update public.book_copies set status = 'borrowed', updated_at = now() where id = p_copy_id;
  if ready_reservation_id is not null then update public.reservations set status = 'completed', updated_at = now() where id = ready_reservation_id; end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'checkout', 'loan', loan_id, jsonb_build_object('copy_id', p_copy_id, 'member_id', p_member_id));
  return loan_id;
end;
$$;

notify pgrst, 'reload schema';
