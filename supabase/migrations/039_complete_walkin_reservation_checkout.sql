-- Complete a ready walk-in reservation at the desk without requiring an
-- online account or a library card. The circulation tables still keep a
-- borrower record for loan history and enforce the normal checkout rules.
create or replace function public.staff_complete_walkin_reservation(
  p_reservation_id uuid
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_reservation_snapshot jsonb;
  v_member_id uuid;
  v_loan_id uuid;
  v_member_type text;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can check out books';
  end if;

  perform public.process_circulation();
  select * into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if not found then raise exception 'Reservation not found'; end if;
  v_reservation_snapshot := to_jsonb(v_reservation);
  if v_reservation.status <> 'ready_for_pickup' then
    raise exception 'Only a ready reservation can be checked out';
  end if;
  -- Migration 040 adds this column. On the legacy 038 schema there is no
  -- manual copy-confirmation stage, so keep this RPC compatible with both.
  if v_reservation_snapshot ? 'pickup_confirmed_at'
    and v_reservation_snapshot->>'pickup_confirmed_at' is null then
    raise exception 'A Librarian or Administrator must confirm pickup readiness before checkout';
  end if;
  if v_reservation.member_id is not null then
    raise exception 'This reservation is already linked to a library member';
  end if;
  if v_reservation.copy_id is null then
    raise exception 'This reservation has no physical copy assigned';
  end if;

  v_member_type := case v_reservation.borrower_type
    when 'student' then 'student'
    when 'faculty' then 'teacher'
    else 'other'
  end;

  insert into public.library_members (full_name, member_type, created_by)
  values (btrim(v_reservation.borrower_full_name), v_member_type, auth.uid())
  returning id into v_member_id;

  -- checkout_copy requires the ready hold to belong to its borrower. Link the
  -- short-lived circulation record within this transaction; checkout failure
  -- rolls the link and inserted member record back with it.
  update public.reservations
  set member_id = v_member_id
  where id = v_reservation.id;

  v_loan_id := public.checkout_copy(v_reservation.copy_id, v_member_id);

  -- The legacy reservation snapshot trigger maps borrower types through the
  -- narrower member_type list. Restore the staff-entered walk-in snapshot.
  update public.reservations
  set borrower_type = v_reservation.borrower_type,
      borrower_full_name = v_reservation.borrower_full_name,
      student_employee_id = v_reservation.student_employee_id,
      contact_number = v_reservation.contact_number,
      email_address = v_reservation.email_address,
      updated_at = now()
  where id = v_reservation.id;

  return v_loan_id;
end;
$$;

revoke all on function public.staff_complete_walkin_reservation(uuid) from public, anon;
grant execute on function public.staff_complete_walkin_reservation(uuid) to authenticated;

notify pgrst, 'reload schema';
