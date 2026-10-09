-- PostgreSQL preserves auth.users.email as varchar through COALESCE, but the
-- RPC contract declares email as text. Keep the public return signature while
-- casting the selected value to its declared type.
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
  if not coalesce(public.is_admin(), false) then
    raise exception 'Administrator access required';
  end if;

  return query
    select r.id, r.user_id, r.full_name_snapshot, coalesce(u.email, r.email_snapshot)::text,
      r.school_id_snapshot, r.status, u.email_confirmed_at, r.library_member_id, r.created_at
    from public.member_verification_assistance_requests r
    left join auth.users u on u.id = r.user_id
    where r.status = 'pending'
      or (r.status = 'approved' and u.email_confirmed_at is null)
    order by case when r.status = 'pending' then 0 else 1 end, r.created_at desc;
end;
$$;

revoke all on function public.admin_member_verification_requests() from public, anon;
grant execute on function public.admin_member_verification_requests() to authenticated;

notify pgrst, 'reload schema';
