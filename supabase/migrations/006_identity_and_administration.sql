-- Browser role edits and account metadata must not grant privileges or identities.
drop policy "administrators can update profiles" on public.profiles;
revoke update on public.profiles from authenticated, anon;
create function public.change_member_role(p_member_id uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = public as $$
declare old_role public.app_role;
begin
  perform public.lock_circulation();
  if not coalesce(public.is_admin(),false) then raise exception 'Administrator access required'; end if;
  if p_role is null then raise exception 'Role is required'; end if;
  select role into old_role from public.profiles where id = p_member_id for update;
  if old_role is null then raise exception 'Profile not found'; end if;
  if old_role = 'administrator' and p_role <> 'administrator'
    and (select count(*) from public.profiles where role = 'administrator') <= 1 then
    raise exception 'Cannot demote the last administrator';
  end if;
  if old_role = 'member' and p_role <> 'member' and (
    exists(select 1 from public.loans where member_id = p_member_id and status in ('borrowed','overdue')) or
    exists(select 1 from public.reservations where member_id = p_member_id and status in ('waiting','ready_for_pickup'))
  ) then raise exception 'Resolve active loans and reservations before changing this role'; end if;
  update public.profiles set role = p_role, updated_at = now() where id = p_member_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'role_change','profile',p_member_id,jsonb_build_object('from',old_role,'to',p_role));
end;
$$;
revoke all on function public.change_member_role(uuid,public.app_role) from public;
grant execute on function public.change_member_role(uuid,public.app_role) to authenticated;

create function public.validate_circulation_setting() returns trigger
language plpgsql set search_path = public as $$
declare n numeric; min_value numeric; max_value numeric;
begin
  if new.key = 'notifications_enabled' then
    if jsonb_typeof(new.value) <> 'boolean' then raise exception 'Expected boolean'; end if;
    return new;
  end if;
  if new.key not in ('loan_period_days','max_active_loans','due_soon_days','max_renewals','pickup_hold_days','fine_per_day') then
    raise exception 'Unknown circulation setting';
  end if;
  if jsonb_typeof(new.value) <> 'number' then raise exception 'Expected number'; end if;
  n := (new.value #>> '{}')::numeric;
  min_value := case when new.key in ('loan_period_days','max_active_loans','pickup_hold_days') then 1 else 0 end;
  max_value := case when new.key = 'fine_per_day' then 10000 when new.key in ('max_renewals','max_active_loans') then 100 else 365 end;
  if n < min_value or n > max_value or (new.key <> 'fine_per_day' and n <> trunc(n))
    or (new.key = 'fine_per_day' and n <> round(n,2)) then raise exception 'Setting is outside allowed bounds'; end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger validate_circulation_setting before insert or update on public.system_settings
  for each row execute function public.validate_circulation_setting();
-- Do not allow removing settings to silently restore defaults.
drop policy "administrators can manage settings" on public.system_settings;
create policy "admin settings read" on public.system_settings for select to authenticated using(public.is_admin());
create policy "admin settings insert" on public.system_settings for insert to authenticated with check(public.is_admin());
create policy "admin settings update" on public.system_settings for update to authenticated using(public.is_admin()) with check(public.is_admin());

create table public.school_id_invitations (
  token_hash text primary key,
  school_id text not null,
  full_name text not null,
  purpose text not null check(purpose in ('signup','recovery')),
  issued_by uuid not null references public.profiles(id),
  expires_at timestamptz not null default now() + interval '24 hours',
  consumed_at timestamptz
);
alter table public.school_id_invitations enable row level security;
revoke all on public.school_id_invitations from anon, authenticated;

create function public.issue_school_id_invitation(p_school_id text,p_full_name text,p_purpose text default 'signup') returns text
language plpgsql security definer set search_path = public as $$
declare token text; school text;
begin
  if not coalesce(public.is_staff(),false) then raise exception 'Staff access required'; end if;
  school := upper(regexp_replace(trim(p_school_id),'\s','','g'));
  if school is null or school !~ '^[A-Z0-9][A-Z0-9._-]{2,31}$' or coalesce(length(trim(p_full_name)),0) not between 1 and 200
    or p_purpose is null or p_purpose not in ('signup','recovery') then raise exception 'Invalid invitation'; end if;
  if p_purpose = 'recovery' and not exists(select 1 from public.profiles where school_id = school and role = 'member') then
    raise exception 'Member school account not found';
  end if;
  if p_purpose = 'signup' and exists(select 1 from public.profiles where school_id = school) then raise exception 'School account already exists'; end if;
  token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into public.school_id_invitations(token_hash,school_id,full_name,purpose,issued_by)
    values(encode(sha256(convert_to(token,'UTF8')),'hex'),school,trim(p_full_name),p_purpose,auth.uid());
  insert into public.audit_logs(actor_id,action,entity_type,details)
    values(auth.uid(),'issue_school_invitation','profile',jsonb_build_object('school_id',school,'purpose',p_purpose));
  return token;
end;
$$;
revoke all on function public.issue_school_id_invitation(text,text,text) from public;
grant execute on function public.issue_school_id_invitation(text,text,text) to authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare invitation public.school_id_invitations%rowtype; school text;
begin
  school := new.raw_app_meta_data ->> 'school_id';
  if school is not null then
    update public.school_id_invitations set consumed_at = now()
      where token_hash = encode(sha256(convert_to(new.raw_app_meta_data ->> 'school_invitation','UTF8')),'hex')
      and school_id = school and purpose = 'signup' and consumed_at is null and expires_at > now()
      returning * into invitation;
    if invitation.token_hash is null then raise exception 'Valid staff invitation required'; end if;
  elsif new.raw_user_meta_data ? 'school_id' then
    raise exception 'School identities require a staff invitation';
  end if;
  insert into public.profiles(id,full_name,school_id)
    values(new.id,coalesce(invitation.full_name,new.raw_user_meta_data ->> 'full_name'),school);
  if school is not null then
    update auth.users set raw_app_meta_data = raw_app_meta_data - 'school_invitation' where id = new.id;
  end if;
  return new;
end;
$$;

create function public.consume_school_recovery(p_school_id text,p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare target uuid; consumed text;
begin
  select id into target from public.profiles where school_id = p_school_id and role = 'member';
  if target is null then raise exception 'Invalid recovery invitation'; end if;
  update public.school_id_invitations set consumed_at = now()
    where token_hash = encode(sha256(convert_to(p_token,'UTF8')),'hex') and school_id = p_school_id
    and purpose = 'recovery' and consumed_at is null and expires_at > now() returning token_hash into consumed;
  if consumed is null then raise exception 'Invalid recovery invitation'; end if;
  insert into public.audit_logs(action,entity_type,entity_id) values('consume_recovery','profile',target);
  return target;
end;
$$;
revoke all on function public.consume_school_recovery(text,text) from public,anon,authenticated;
grant execute on function public.consume_school_recovery(text,text) to service_role;

create table public.school_auth_limits(bucket text primary key, starts_at timestamptz not null, attempts integer not null);
alter table public.school_auth_limits enable row level security;
revoke all on public.school_auth_limits from anon,authenticated;
create function public.allow_school_auth(p_school_id text) returns boolean
language plpgsql security definer set search_path = public as $$
declare attempts integer; bucket_key text;
begin
  bucket_key := encode(sha256(convert_to(p_school_id,'UTF8')),'hex');
  insert into public.school_auth_limits as lim values(bucket_key,now(),1)
    on conflict(bucket) do update set
      starts_at = case when lim.starts_at < now()-interval '15 minutes' then now() else lim.starts_at end,
      attempts = case when lim.starts_at < now()-interval '15 minutes' then 1 else least(lim.attempts+1,11) end
    returning lim.attempts into attempts;
  delete from public.school_auth_limits where starts_at < now()-interval '1 day';
  return attempts <= 10;
end;
$$;
revoke all on function public.allow_school_auth(text) from public,anon,authenticated;
grant execute on function public.allow_school_auth(text) to service_role;
