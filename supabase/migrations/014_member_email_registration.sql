-- Allow students and teachers to create email accounts while keeping School ID
-- ownership tied to the staff-verified member record and card/PIN credential.
create function public.school_login_email(p_school_id text)
returns text
language sql stable security definer
set search_path = pg_catalog, public, auth as $$
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  join public.library_members m on m.auth_user_id = p.id and m.is_active
  where p.role = 'member'
    and p.school_id is not null
    and m.school_id is not null
    and m.library_card_number is not null
    and upper(regexp_replace(btrim(p.school_id), '\s', '', 'g')) =
        upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'))
    and upper(regexp_replace(btrim(m.school_id), '\s', '', 'g')) =
        upper(regexp_replace(btrim(coalesce(p_school_id, '')), '\s', '', 'g'))
  limit 1
$$;
revoke all on function public.school_login_email(text) from public, anon, authenticated;
grant execute on function public.school_login_email(text) to service_role;

create function public.current_user_has_active_library_member()
returns boolean
language sql stable security definer
set search_path = pg_catalog, public as $$
  select exists (
    select 1
    from public.profiles p
    join public.library_members m on m.auth_user_id = p.id
    where p.id = auth.uid()
      and p.role = 'member'
      and m.is_active
      and m.library_card_number is not null
      and m.school_id is not null
      and p.school_id is not null
      and upper(regexp_replace(btrim(p.school_id), '\s', '', 'g')) =
          upper(regexp_replace(btrim(m.school_id), '\s', '', 'g'))
  )
$$;
revoke all on function public.current_user_has_active_library_member() from public, anon;
grant execute on function public.current_user_has_active_library_member() to authenticated;

create function public.complete_member_account_registration(
  p_school_id text,
  p_card_number text,
  p_pin text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions as $$
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
  if v_school_id !~ '^[A-Z0-9][A-Z0-9._-]{2,31}$' then
    return jsonb_build_object('verified', false);
  end if;
  if v_candidate_school_id is not null and
     upper(regexp_replace(btrim(v_candidate_school_id), '\s', '', 'g')) <> v_school_id then
    return jsonb_build_object('verified', false);
  end if;

  v_member_id := public.verify_library_card_reservation_pin(p_card_number, p_pin);
  if v_member_id is null then return jsonb_build_object('verified', false); end if;
  select * into v_member from public.library_members where id = v_member_id for update;
  if not found or not v_member.is_active or v_member.school_id is null or
     upper(regexp_replace(btrim(v_member.school_id), '\s', '', 'g')) <> v_school_id then
    return jsonb_build_object('verified', false);
  end if;
  if v_member.auth_user_id is not null and v_member.auth_user_id <> v_user_id then
    return jsonb_build_object('verified', false);
  end if;
  if v_profile.school_id is not null and lower(v_profile.school_id) <> lower(v_member.school_id) then
    return jsonb_build_object('verified', false);
  end if;
  if exists (
    select 1 from public.library_members
    where auth_user_id = v_user_id and id <> v_member.id
  ) or exists (
    select 1 from public.profiles
    where lower(school_id) = lower(v_member.school_id) and id <> v_user_id
  ) then
    return jsonb_build_object('verified', false);
  end if;

  update public.library_members
    set auth_user_id = v_user_id, updated_at = now()
    where id = v_member.id;
  update public.profiles
    set full_name = v_member.full_name, school_id = v_member.school_id, updated_at = now()
    where id = v_user_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (v_user_id, 'member_account_self_link', 'library_member', v_member.id,
      jsonb_build_object('school_id', v_member.school_id, 'method', 'verified_card_pin'));
  return jsonb_build_object('verified', true);
end;
$$;

revoke all on function public.complete_member_account_registration(text, text, text) from public, anon;
grant execute on function public.complete_member_account_registration(text, text, text) to authenticated;
