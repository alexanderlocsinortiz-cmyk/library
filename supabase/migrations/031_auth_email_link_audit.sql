-- Keep the admin recovery audit accurate now that signup confirmation emails
-- contain links instead of numeric OTP codes. Preserve the RPC argument name
-- for compatibility with already-deployed Edge Functions.
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
      then 'Assisted with email confirmation after a trusted library identity review; a verification link was sent and confirmation is still required.'
      else 'Updated the unconfirmed email after trusted identity review, but verification email delivery failed; confirmation is still required.'
    end,
    'account', v_request.user_id, case when p_otp_sent then 'success' else 'failure' end,
    jsonb_build_object('email_confirmation_required', true, 'verification_email_sent', p_otp_sent)
  );
  return true;
end;
$$;
revoke all on function public.record_admin_verification_email_change(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.record_admin_verification_email_change(uuid, uuid, text, boolean) to service_role;
