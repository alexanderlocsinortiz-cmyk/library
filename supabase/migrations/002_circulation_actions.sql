-- Baseline circulation actions for testing.
-- Policy-specific limits, fines, renewals, and pickup rules remain deferred.

create or replace function public.reserve_book(p_book_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  reservation_id uuid;
begin
  if auth.uid() is null or public.current_user_role() <> 'member' then
    raise exception 'Only authenticated Members can create reservations';
  end if;

  select id into reservation_id
  from public.reservations
  where book_id = p_book_id
    and member_id = auth.uid()
    and status in ('waiting', 'ready_for_pickup')
  limit 1;

  if reservation_id is not null then
    return reservation_id;
  end if;

  begin
    insert into public.reservations (book_id, member_id, status)
    values (p_book_id, auth.uid(), 'waiting')
    returning id into reservation_id;
  exception when unique_violation then
    select id into reservation_id
    from public.reservations
    where book_id = p_book_id
      and member_id = auth.uid()
      and status in ('waiting', 'ready_for_pickup')
    limit 1;
  end;

  return reservation_id;
end;
$$;

create or replace function public.cancel_reservation(p_reservation_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  reservation_member_id uuid;
begin
  select member_id into reservation_member_id
  from public.reservations
  where id = p_reservation_id
  for update;

  if reservation_member_id is null then
    raise exception 'Reservation not found';
  end if;

  if reservation_member_id <> auth.uid() and not public.is_staff() then
    raise exception 'You are not allowed to cancel this reservation';
  end if;

  update public.reservations
  set status = 'cancelled', updated_at = now()
  where id = p_reservation_id;
end;
$$;

create or replace function public.checkout_copy(
  p_copy_id uuid,
  p_member_id uuid,
  p_due_at timestamptz default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  loan_id uuid;
  current_status public.copy_status;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Only Librarians and Administrators can check out books';
  end if;

  if not exists (select 1 from public.profiles where id = p_member_id and role = 'member') then
    raise exception 'The selected borrower is not a Member';
  end if;

  select status into current_status
  from public.book_copies
  where id = p_copy_id
  for update;

  if current_status is null then
    raise exception 'Book copy not found';
  end if;

  if current_status <> 'available' then
    raise exception 'Book copy is not available';
  end if;

  insert into public.loans (copy_id, member_id, checked_out_by, due_at, status)
  values (p_copy_id, p_member_id, auth.uid(), p_due_at, 'borrowed')
  returning id into loan_id;

  update public.book_copies
  set status = 'borrowed', updated_at = now()
  where id = p_copy_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'checkout', 'loan', loan_id, jsonb_build_object('copy_id', p_copy_id, 'member_id', p_member_id));

  return loan_id;
end;
$$;

create or replace function public.return_loan(p_loan_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  loan_copy_id uuid;
  current_status public.loan_status;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Only Librarians and Administrators can return books';
  end if;

  select copy_id, status into loan_copy_id, current_status
  from public.loans
  where id = p_loan_id
  for update;

  if loan_copy_id is null then
    raise exception 'Loan not found';
  end if;

  if current_status not in ('borrowed', 'overdue') then
    raise exception 'This loan is already closed';
  end if;

  update public.loans
  set status = 'returned', returned_at = now()
  where id = p_loan_id;

  update public.book_copies
  set status = 'available', updated_at = now()
  where id = loan_copy_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'return', 'loan', p_loan_id, jsonb_build_object('copy_id', loan_copy_id));
end;
$$;

grant execute on function public.reserve_book(uuid) to authenticated;
grant execute on function public.cancel_reservation(uuid) to authenticated;
grant execute on function public.checkout_copy(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.return_loan(uuid) to authenticated;
