-- Allow staff to reserve titles with available copies as well as titles that
-- are already circulating. Available copies are assigned through the existing
-- FIFO allocator, so a new request cannot jump ahead of an older reservation.

create or replace function public.assert_reservation_book_eligible(p_book_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.books where id = p_book_id) then
    raise exception 'Book not found';
  end if;
  if not exists (select 1 from public.book_copies where book_id = p_book_id) then
    raise exception 'This title has no physical copies; record an acquisition request instead';
  end if;
  if not exists (
    select 1 from public.book_copies
    where book_id = p_book_id and status in ('available', 'borrowed', 'overdue', 'reserved')
  ) then
    raise exception 'No physical copies of this title are available or circulating';
  end if;
end;
$$;

create or replace function public.staff_create_reservation(
  p_book_id uuid,
  p_member_id uuid,
  p_borrower_type text,
  p_borrower_full_name text,
  p_student_employee_id text,
  p_contact_number text,
  p_email_address text,
  p_reservation_date date,
  p_expected_pickup_date date,
  p_notes text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_borrower jsonb;
  v_reservation_date date := coalesce(p_reservation_date, current_date);
  v_duplicate uuid;
  v_reservation_id uuid;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Staff access required';
  end if;
  perform public.process_circulation();

  if v_reservation_date > current_date then
    raise exception 'Reservation date cannot be in the future';
  end if;
  if p_expected_pickup_date is not null and p_expected_pickup_date < v_reservation_date then
    raise exception 'Expected pickup date cannot be before the reservation date';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception 'Notes must be 2000 characters or fewer';
  end if;

  v_borrower := public.resolve_reservation_borrower(
    p_member_id, p_borrower_type, p_borrower_full_name,
    p_student_employee_id, p_contact_number, p_email_address
  );
  perform public.assert_reservation_book_eligible(p_book_id);

  v_duplicate := public.find_active_reservation_duplicate(
    p_book_id, p_member_id,
    v_borrower->>'borrower_full_name', v_borrower->>'student_employee_id',
    v_borrower->>'contact_number', v_borrower->>'email_address'
  );
  if v_duplicate is not null then
    raise exception 'This borrower already has an active reservation for this book';
  end if;

  insert into public.reservations(
    book_id, member_id, status, borrower_type, borrower_full_name,
    student_employee_id, contact_number, email_address, reservation_date,
    expected_pickup_date, notes, created_by
  ) values (
    p_book_id, p_member_id, 'waiting', v_borrower->>'borrower_type',
    v_borrower->>'borrower_full_name', v_borrower->>'student_employee_id',
    v_borrower->>'contact_number', v_borrower->>'email_address', v_reservation_date,
    p_expected_pickup_date, nullif(btrim(p_notes), ''), auth.uid()
  ) returning id into v_reservation_id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'walk_in_reservation_create', 'reservation', v_reservation_id,
    jsonb_build_object('book_id', p_book_id, 'member_id', p_member_id, 'borrower_type', v_borrower->>'borrower_type'));

  -- This uses the same ordered allocator as returns and cancellations. If an
  -- older waiter exists it receives the copy first; otherwise an available
  -- copy is immediately assigned to this reservation.
  perform public.allocate_pickup_holds(p_book_id);
  return v_reservation_id;
end;
$$;

revoke all on function public.staff_create_reservation(uuid, uuid, text, text, text, text, text, date, date, text) from public, anon;
grant execute on function public.staff_create_reservation(uuid, uuid, text, text, text, text, text, date, date, text) to authenticated;

notify pgrst, 'reload schema';
