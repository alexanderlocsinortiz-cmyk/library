-- Loans and reservations refer to library_members, not profiles. Keep these
-- relationships intact when the online Auth profile is removed.

create table public.admin_account_deletion_claims (
  target_user_id uuid primary key,
  claimed_by uuid not null,
  actor_name text not null,
  actor_role text not null,
  target_name text not null,
  target_role text not null,
  claimed_at timestamptz not null default now()
);
alter table public.admin_account_deletion_claims enable row level security;
revoke all on public.admin_account_deletion_claims from public, anon, authenticated, service_role;

create or replace function public.block_account_changes_during_deletion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1 from public.admin_account_deletion_claims
    where target_user_id = new.user_id
      and claimed_at > now() - interval '10 minutes'
  ) then
    raise exception 'This account is being deleted. Please try again shortly.';
  end if;
  return new;
end;
$$;
revoke all on function public.block_account_changes_during_deletion() from public, anon, authenticated, service_role;
create trigger block_verification_request_during_account_deletion
before insert on public.member_verification_assistance_requests
for each row execute function public.block_account_changes_during_deletion();

create or replace function public.block_role_changes_during_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.role is distinct from old.role and exists (
    select 1 from public.admin_account_deletion_claims
    where target_user_id = new.id
      and claimed_at > now() - interval '10 minutes'
  ) then
    raise exception 'This account is being deleted. Please try again shortly.';
  end if;
  return new;
end;
$$;
revoke all on function public.block_role_changes_during_account_deletion() from public, anon, authenticated, service_role;
create trigger block_role_change_during_account_deletion
before update of role on public.profiles
for each row execute function public.block_role_changes_during_account_deletion();

create or replace function public.block_circulation_during_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth_user_id uuid;
begin
  select auth_user_id into v_auth_user_id
  from public.library_members where id = new.member_id;
  if v_auth_user_id is not null and exists (
    select 1 from public.admin_account_deletion_claims
    where target_user_id = v_auth_user_id
      and claimed_at > now() - interval '10 minutes'
  ) then
    raise exception 'This account is being deleted. Please try again shortly.';
  end if;
  return new;
end;
$$;
revoke all on function public.block_circulation_during_account_deletion() from public, anon, authenticated, service_role;
create trigger block_reservations_during_account_deletion
before insert or update on public.reservations
for each row execute function public.block_circulation_during_account_deletion();
create trigger block_loans_during_account_deletion
before insert or update on public.loans
for each row execute function public.block_circulation_during_account_deletion();

-- The Edge Function calls this with a server-verified administrator identity.
-- It returns only a safe reason and target label, never email or credentials.
create or replace function public.admin_user_deletion_preflight(
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_auth_user_id uuid;
begin
  select * into v_actor from public.profiles
  where id = p_actor_user_id and role = 'administrator';
  if p_actor_user_id is null or not found then
    return jsonb_build_object('allowed', false, 'code', 'admin_required');
  end if;

  if p_actor_user_id = p_target_user_id then
    return jsonb_build_object('allowed', false, 'code', 'cannot_delete_self');
  end if;

  -- Serialize against the existing assistance request RPC, which locks the
  -- Auth row before recording a request. Either the request wins and deletion
  -- is blocked, or the deletion claim wins and the request trigger blocks it.
  select id into v_auth_user_id from auth.users where id = p_target_user_id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'code', 'account_not_found');
  end if;

  select * into v_target
  from public.profiles
  where id = p_target_user_id
  for update;
  if not found then
    return jsonb_build_object('allowed', false, 'code', 'account_not_found');
  end if;

  if v_target.role = 'administrator' then
    return jsonb_build_object('allowed', false, 'code', 'administrator_role_required');
  end if;

  -- Lock linked borrower rows in stable order. Circulation writes take a
  -- compatible FK lock and are rejected by the claim trigger once claimed.
  perform 1 from public.library_members m
  where m.auth_user_id = p_target_user_id
     or m.id = p_target_user_id
     or upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) =
        upper(regexp_replace(btrim(coalesce(v_target.school_id, v_target.registration_school_id, '')), '\s', '', 'g'))
  order by m.id
  for update;

  if exists (
    select 1 from public.loans l
    join public.library_members m on m.id = l.member_id
    where m.auth_user_id = p_target_user_id or m.id = p_target_user_id
       or upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) =
          upper(regexp_replace(btrim(coalesce(v_target.school_id, v_target.registration_school_id, '')), '\s', '', 'g'))
  ) or exists (
    select 1 from public.reservations r
    join public.library_members m on m.id = r.member_id
    where m.auth_user_id = p_target_user_id or m.id = p_target_user_id
       or upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) =
          upper(regexp_replace(btrim(coalesce(v_target.school_id, v_target.registration_school_id, '')), '\s', '', 'g'))
  ) then
    return jsonb_build_object('allowed', false, 'code', 'library_history_exists');
  end if;

  if exists (
    select 1 from public.member_verification_assistance_requests
    where user_id = p_target_user_id and status in ('pending', 'approved')
  ) then
    return jsonb_build_object('allowed', false, 'code', 'verification_assistance_open');
  end if;

  insert into public.admin_account_deletion_claims (
    target_user_id, claimed_by, actor_name, actor_role, target_name, target_role, claimed_at
  ) values (
    p_target_user_id, p_actor_user_id,
    coalesce(nullif(btrim(v_actor.full_name), ''), 'Administrator'),
    v_actor.role::text,
    coalesce(nullif(btrim(v_target.full_name), ''), 'Unnamed user'),
    v_target.role::text,
    now()
  )
  on conflict (target_user_id) do update set
    claimed_by = excluded.claimed_by,
    actor_name = excluded.actor_name,
    actor_role = excluded.actor_role,
    target_name = excluded.target_name,
    target_role = excluded.target_role,
    claimed_at = excluded.claimed_at
  where public.admin_account_deletion_claims.claimed_at <= now() - interval '10 minutes';
  if not found then
    return jsonb_build_object('allowed', false, 'code', 'deletion_in_progress');
  end if;

  return jsonb_build_object(
    'allowed', true,
    'target_name', coalesce(nullif(btrim(v_target.full_name), ''), 'Unnamed user'),
    'target_role', v_target.role::text
  );
end;
$$;
revoke all on function public.admin_user_deletion_preflight(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_user_deletion_preflight(uuid, uuid) to service_role;

-- Auth deletion, operational OTP-state cleanup, and its immutable activity log
-- are committed in one transaction. This trigger is the success audit record.
create or replace function public.capture_admin_user_deletion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claim public.admin_account_deletion_claims%rowtype;
begin
  select * into v_claim from public.admin_account_deletion_claims
  where target_user_id = old.id;
  if not found then return old; end if;

  delete from public.pending_member_registrations where user_id = old.id;
  delete from public.registration_resend_limits where user_id = old.id;
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, old_values
  ) values (
    v_claim.claimed_by, v_claim.actor_name, v_claim.actor_role,
    'user_account_deleted', 'administration',
    'Deleted a sign-in account; library and audit history were retained.',
    'profile', old.id, 'success',
    jsonb_build_object('target_name', v_claim.target_name, 'target_role', v_claim.target_role)
  );
  delete from public.admin_account_deletion_claims where target_user_id = old.id;
  return old;
end;
$$;
revoke all on function public.capture_admin_user_deletion() from public, anon, authenticated, service_role;
drop trigger if exists capture_admin_user_deletion on auth.users;
create trigger capture_admin_user_deletion
after delete on auth.users
for each row execute function public.capture_admin_user_deletion();

-- On an Auth API failure, release the short-lived claim and record the failed
-- attempt. Successful account and audit changes are handled atomically above.
create or replace function public.record_admin_user_deletion_failure(
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claim public.admin_account_deletion_claims%rowtype;
begin
  select * into v_claim from public.admin_account_deletion_claims
  where target_user_id = p_target_user_id and claimed_by = p_actor_user_id
  for update;
  if not found then return; end if;
  delete from public.admin_account_deletion_claims where target_user_id = p_target_user_id;

  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, old_values
  ) values (
    v_claim.claimed_by, v_claim.actor_name, v_claim.actor_role,
    'user_account_deletion_failed',
    'administration',
    'An administrator account deletion attempt failed; the account was retained.',
    'profile', p_target_user_id,
    'failure',
    jsonb_build_object(
      'target_name', v_claim.target_name,
      'target_role', v_claim.target_role
    )
  );
end;
$$;
revoke all on function public.record_admin_user_deletion_failure(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_admin_user_deletion_failure(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
