-- SQL comparisons with NULL do not evaluate to true, so a staff checkout could
-- otherwise bypass the borrower match for a ready walk-in reservation.
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
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can check out books';
  end if;
  perform public.process_circulation();
  select * into selected_member from public.library_members where id = p_member_id and is_active for update;
  if not found or (selected_member.library_card_number is null and not selected_member.email_only) then
    raise exception 'The selected borrower must have an active library record';
  end if;
  select book_id, status into copy_book_id, current_status from public.book_copies where id = p_copy_id for update;
  if copy_book_id is null then raise exception 'Book copy not found'; end if;
  select id, member_id into ready_reservation_id, ready_reservation_member_id from public.reservations
    where copy_id = p_copy_id and status = 'ready_for_pickup' order by created_at asc limit 1 for update;
  if selected_member.email_only and (
    ready_reservation_id is null or ready_reservation_member_id is distinct from p_member_id
  ) then
    raise exception 'Email-only accounts can be checked out only when completing their ready hold';
  end if;
  if ready_reservation_id is not null and ready_reservation_member_id is distinct from p_member_id then
    raise exception 'This copy is held for the next reservation';
  end if;
  if current_status not in ('available', 'reserved') then raise exception 'Book copy is not available'; end if;
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
  if ready_reservation_id is not null then
    update public.reservations set status = 'completed', updated_at = now() where id = ready_reservation_id;
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'checkout', 'loan', loan_id, jsonb_build_object('copy_id', p_copy_id, 'member_id', p_member_id));
  return loan_id;
end;
$$;
revoke all on function public.checkout_copy(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.checkout_copy(uuid, uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
