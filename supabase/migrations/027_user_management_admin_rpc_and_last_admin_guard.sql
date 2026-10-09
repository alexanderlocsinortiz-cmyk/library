-- Return only the account fields needed by the administrator UI. Auth credentials
-- remain inside auth.users and are never included in this RPC response.
create or replace function public.admin_user_management_rows()
returns table (
  id uuid,
  full_name text,
  school_id text,
  registration_school_id text,
  role text,
  created_at timestamptz,
  email text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  account_active boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  return query
    select p.id,
      p.full_name,
      p.school_id,
      p.registration_school_id,
      p.role::text,
      p.created_at,
      u.email::text,
      u.email_confirmed_at,
      u.last_sign_in_at,
      coalesce(u.banned_until is null or u.banned_until <= now(), false)
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.created_at desc, p.id;
end;
$$;
revoke all on function public.admin_user_management_rows() from public, anon;
grant execute on function public.admin_user_management_rows() to authenticated;

-- Deletion and role changes take the same transaction lock. This prevents two
-- concurrent operations from each treating the other's administrator as the
-- remaining active administrator.
create or replace function public.admin_user_deletion_preflight(
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_auth_user_id uuid;
  v_school_id text;
begin
  if p_actor_user_id is null then
    return jsonb_build_object('allowed', false, 'code', 'admin_required');
  end if;

  if p_actor_user_id = p_target_user_id then
    return jsonb_build_object('allowed', false, 'code', 'cannot_delete_self');
  end if;

  perform public.lock_circulation();

  select p.* into v_actor
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.id = p_actor_user_id
    and p.role = 'administrator'
    and (u.banned_until is null or u.banned_until <= now())
    and not exists (
      select 1 from public.admin_account_deletion_claims c
      where c.target_user_id = p.id
        and c.claimed_at > now() - interval '10 minutes'
    )
  for update of p;
  if not found then
    return jsonb_build_object('allowed', false, 'code', 'admin_required');
  end if;

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

  v_school_id := nullif(upper(regexp_replace(btrim(coalesce(v_target.school_id, v_target.registration_school_id, '')), '\s', '', 'g')), '');

  if v_target.role = 'administrator' and not exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'administrator'
      and p.id <> p_target_user_id
      and (u.banned_until is null or u.banned_until <= now())
      and not exists (
        select 1 from public.admin_account_deletion_claims c
        where c.target_user_id = p.id
          and c.claimed_at > now() - interval '10 minutes'
      )
  ) then
    return jsonb_build_object('allowed', false, 'code', 'last_administrator_required');
  end if;

  -- Lock linked borrower rows in stable order. Match by School ID only when
  -- one exists; otherwise NULL values would match all walk-in library members.
  perform 1 from public.library_members m
  where m.auth_user_id = p_target_user_id
     or m.id = p_target_user_id
     or (v_school_id is not null and upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) = v_school_id)
  order by m.id
  for update;

  if exists (
    select 1 from public.loans l
    join public.library_members m on m.id = l.member_id
    where m.auth_user_id = p_target_user_id or m.id = p_target_user_id
       or (v_school_id is not null and upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) = v_school_id)
  ) or exists (
    select 1 from public.reservations r
    join public.library_members m on m.id = r.member_id
    where m.auth_user_id = p_target_user_id or m.id = p_target_user_id
       or (v_school_id is not null and upper(regexp_replace(btrim(coalesce(m.school_id, '')), '\s', '', 'g')) = v_school_id)
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

-- Role changes also honor active deletion claims when checking the last active
-- administrator, so a claimed account cannot be counted as a fallback admin.
create or replace function public.change_member_role(p_member_id uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  old_role public.app_role;
  library_member_id uuid;
  target_is_active_admin boolean;
begin
  perform public.lock_circulation();
  if not coalesce(public.is_admin(),false) then raise exception 'Administrator access required'; end if;
  if p_role is null then raise exception 'Role is required'; end if;
  select role into old_role from public.profiles where id=p_member_id for update;
  if old_role is null then raise exception 'Profile not found'; end if;

  if old_role='administrator' and p_role<>'administrator' then
    select exists (
      select 1 from auth.users u
      where u.id = p_member_id and (u.banned_until is null or u.banned_until <= now())
    ) into target_is_active_admin;
    if target_is_active_admin and not exists (
      select 1
      from public.profiles p
      join auth.users u on u.id = p.id
      where p.role = 'administrator'
        and p.id <> p_member_id
        and (u.banned_until is null or u.banned_until <= now())
        and not exists (
          select 1 from public.admin_account_deletion_claims c
          where c.target_user_id = p.id
            and c.claimed_at > now() - interval '10 minutes'
        )
    ) then
      raise exception 'Cannot demote the last active administrator';
    end if;
  end if;

  select id into library_member_id from public.library_members where auth_user_id=p_member_id;
  if old_role='member' and p_role<>'member' and library_member_id is not null and (
    exists(select 1 from public.loans where member_id=library_member_id and status in ('borrowed','overdue')) or
    exists(select 1 from public.reservations where member_id=library_member_id and status in ('waiting','ready_for_pickup'))
  ) then raise exception 'Resolve active loans and reservations before changing this role'; end if;
  update public.profiles set role=p_role,updated_at=now() where id=p_member_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'role_change','profile',p_member_id,jsonb_build_object('from',old_role,'to',p_role));
end;
$$;
revoke all on function public.change_member_role(uuid,public.app_role) from public,anon;
grant execute on function public.change_member_role(uuid,public.app_role) to authenticated;

notify pgrst, 'reload schema';
