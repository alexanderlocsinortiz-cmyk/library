-- All circulation writes pass through audited RPCs. A shared transaction lock
-- deliberately serializes this small library's circulation operations. It also
-- gives checkout, expiry, cancellation and queue promotion one lock order.
create function public.lock_circulation() returns void
language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(7281936401::bigint);
$$;
revoke all on function public.lock_circulation() from public, anon, authenticated;

drop policy "members can create their reservations" on public.reservations;
drop policy "staff can manage reservations" on public.reservations;
drop policy "staff can manage loans" on public.loans;
drop policy "staff can manage copies" on public.book_copies;
drop policy "staff can create audit logs" on public.audit_logs;
revoke insert, update, delete on public.reservations, public.loans, public.audit_logs from authenticated, anon;
revoke insert, update, delete on public.book_copies from authenticated, anon;
grant insert (book_id, barcode, location, condition) on public.book_copies to authenticated;
create policy "staff can register copies" on public.book_copies for insert to authenticated
  with check (public.is_staff() and status = 'available');
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

alter table public.reservations add column copy_id uuid references public.book_copies(id) on delete restrict;
-- Legacy ready rows never represented allocated inventory. Preserve FIFO dates
-- and reallocate them below, rather than inventing physical assignments.
update public.reservations set status = 'waiting' where status = 'ready_for_pickup';
create unique index one_ready_hold_per_copy on public.reservations(copy_id) where status = 'ready_for_pickup';
alter table public.reservations add constraint ready_hold_requires_copy
  check (status <> 'ready_for_pickup' or (copy_id is not null and pickup_expires_at is not null));

alter table public.loans add column fine_daily_rate numeric(10,2),
  add column fine_calculated_at timestamptz;
-- Existing loans have no historic rate: explicitly adopt the migration-time rate.
update public.loans set fine_daily_rate = public.get_setting_numeric('fine_per_day', 0);
alter table public.loans alter column fine_daily_rate set not null;
alter table public.loans add constraint fine_rate_bounds check (fine_daily_rate between 0 and 10000);

create function public.calculate_loan_fine(p_due timestamptz, p_at timestamptz, p_rate numeric)
returns numeric language sql immutable set search_path = public as $$
  select least(99999999.99, greatest(0, coalesce(ceil(extract(epoch from (p_at - p_due)) / 86400), 0)) * p_rate);
$$;
revoke all on function public.calculate_loan_fine(timestamptz,timestamptz,numeric) from public;

create function public.set_loan_fine() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.fine_daily_rate := public.get_setting_numeric('fine_per_day', 0);
  end if;
  if new.status in ('returned','lost','damaged') then
    new.fine_calculated_at := new.returned_at;
  else
    new.fine_calculated_at := now();
  end if;
  new.fine_amount := public.calculate_loan_fine(new.due_at, new.fine_calculated_at, new.fine_daily_rate);
  return new;
end;
$$;
create trigger loan_fine before insert or update on public.loans for each row execute function public.set_loan_fine();
-- Repair already closed loans, too; ongoing rates are frozen from this point on.
update public.loans set fine_amount = fine_amount;

-- Internal allocator: executable only by database-owned functions.
create function public.allocate_pickup_holds(p_book_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare r uuid; c uuid; first_id uuid;
begin
  perform public.lock_circulation();
  loop
    select id into r from public.reservations where book_id = p_book_id and status = 'waiting'
      order by created_at, id limit 1 for update;
    exit when r is null;
    select id into c from public.book_copies where book_id = p_book_id and status = 'available'
      order by id limit 1 for update;
    exit when c is null;
    update public.book_copies set status = 'reserved', updated_at = now() where id = c;
    update public.reservations set status = 'ready_for_pickup', copy_id = c, updated_at = now() where id = r;
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
      values(auth.uid(),'pickup_ready','reservation',r,jsonb_build_object('copy_id',c));
    first_id := coalesce(first_id,r);
  end loop;
  return first_id;
end;
$$;
revoke all on function public.allocate_pickup_holds(uuid) from public, anon, authenticated;

create or replace function public.promote_next_reservation(p_book_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.is_staff(),false) then raise exception 'Staff access required'; end if;
  return public.allocate_pickup_holds(p_book_id);
end;
$$;

create table public.circulation_job_health(singleton boolean primary key default true check(singleton), last_success_at timestamptz);
alter table public.circulation_job_health enable row level security;
revoke all on public.circulation_job_health from anon,authenticated;
grant select on public.circulation_job_health to authenticated;
create policy "admin job health" on public.circulation_job_health for select to authenticated using(public.is_admin());

create function public.process_circulation() returns void
language plpgsql security definer set search_path = public as $$
declare r record; b uuid;
begin
  perform public.lock_circulation();
  with changed as (
    update public.loans set status = 'overdue' where status = 'borrowed' and due_at < now()
    returning member_id, fine_amount
  ) insert into public.notifications(member_id,title,message)
    select member_id,'Book overdue',format('A borrowed book is overdue. Current fine: %s.',fine_amount)
    from changed where public.get_setting_bool('notifications_enabled',true);
  update public.loans set fine_amount = fine_amount where status = 'overdue';
  update public.book_copies c set status = 'overdue', updated_at = now()
    from public.loans l where l.copy_id = c.id and l.status = 'overdue' and c.status = 'borrowed';
  for r in select * from public.reservations where status = 'ready_for_pickup' and pickup_expires_at <= now() for update loop
    update public.reservations set status = 'expired', updated_at = now() where id = r.id;
    update public.book_copies set status = 'available', updated_at = now() where id = r.copy_id and status = 'reserved';
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
      values(auth.uid(),'expired','reservation',r.id,jsonb_build_object('copy_id',r.copy_id));
    if public.get_setting_bool('notifications_enabled',true) then
      insert into public.notifications(member_id,title,message) values(r.member_id,'Reservation expired','Your pickup deadline passed. The copy has been released.');
    end if;
  end loop;
  for b in select distinct book_id from public.reservations where status = 'waiting' loop
    perform public.allocate_pickup_holds(b);
  end loop;
  insert into public.circulation_job_health(singleton,last_success_at) values(true,now()) on conflict(singleton) do update set last_success_at=excluded.last_success_at;
end;
$$;
revoke all on function public.process_circulation() from public, anon, authenticated;
grant execute on function public.process_circulation() to service_role;

create or replace function public.refresh_circulation_statuses() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.is_staff(),false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Staff access required';
  end if;
  perform public.process_circulation();
end;
$$;

create or replace function public.cancel_reservation(p_reservation_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reservations%rowtype;
begin
  perform public.lock_circulation();
  select * into r from public.reservations where id = p_reservation_id for update;
  if auth.uid() is null or (r.member_id is distinct from auth.uid() and not coalesce(public.is_staff(),false)) then
    raise exception 'Not allowed to cancel this reservation';
  end if;
  if r.id is null or r.status not in ('waiting','ready_for_pickup') then raise exception 'Reservation is not active'; end if;
  update public.reservations set status = 'cancelled', updated_at = now() where id = r.id;
  update public.book_copies set status = 'available', updated_at = now() where id = r.copy_id and status = 'reserved';
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'cancel','reservation',r.id,jsonb_build_object('copy_id',r.copy_id));
  perform public.allocate_pickup_holds(r.book_id);
end;
$$;

create function public.allocate_new_copy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.allocate_pickup_holds(new.book_id);
  return new;
end;
$$;
create trigger allocate_new_copy after insert on public.book_copies for each row execute function public.allocate_new_copy();

create function public.lock_copy_registration() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.lock_circulation();
  return new;
end;
$$;
create trigger lock_copy_registration before insert on public.book_copies for each row execute function public.lock_copy_registration();

-- Reconcile old ready queues with actual available stock.
select public.process_circulation();


create or replace function public.reserve_book(p_book_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  reservation_id uuid;
begin
  perform public.lock_circulation();
  if auth.uid() is null or public.current_user_role() is distinct from 'member' then
    raise exception 'Only authenticated Members can create reservations';
  end if;

  perform public.process_circulation();

  if not exists (select 1 from public.books where id = p_book_id) then
    raise exception 'Book not found';
  end if;

  if exists (select 1 from public.book_copies where book_id = p_book_id and status = 'available') then
    raise exception 'This book is currently available and does not need a reservation';
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

  insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(auth.uid(),'reserve','reservation',reservation_id);
  return reservation_id;
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
  copy_book_id uuid;
  current_status public.copy_status;
  active_loan_count integer;
  ready_reservation_id uuid;
  ready_reservation_member_id uuid;
  resolved_due_at timestamptz;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can check out books';
  end if;

  perform public.process_circulation();

  if not exists (select 1 from public.profiles where id = p_member_id and role = 'member') then
    raise exception 'The selected borrower is not a Member';
  end if;

  select book_id, status into copy_book_id, current_status
  from public.book_copies
  where id = p_copy_id
  for update;

  if copy_book_id is null then
    raise exception 'Book copy not found';
  end if;

  if current_status not in ('available', 'reserved') then
    raise exception 'Book copy is not available';
  end if;

  select id, member_id into ready_reservation_id, ready_reservation_member_id
  from public.reservations
  where copy_id = p_copy_id and status = 'ready_for_pickup'
  order by created_at asc
  limit 1
  for update;

  if ready_reservation_id is not null and ready_reservation_member_id <> p_member_id then
    raise exception 'This copy is held for the next reservation';
  end if;

  if current_status = 'reserved' and ready_reservation_id is null then raise exception 'Copy has no valid pickup assignment'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  select count(*) into active_loan_count
  from public.loans
  where member_id = p_member_id and status in ('borrowed', 'overdue');

  if active_loan_count >= public.get_setting_int('max_active_loans', 5) then
    raise exception 'This Member has reached the active loan limit';
  end if;

  resolved_due_at := coalesce(
    p_due_at,
    now() + make_interval(days => public.get_setting_int('loan_period_days', 14))
  );
  if resolved_due_at <= now() then
    raise exception 'The due date must be in the future';
  end if;

  insert into public.loans (copy_id, member_id, checked_out_by, due_at, status)
  values (p_copy_id, p_member_id, auth.uid(), resolved_due_at, 'borrowed')
  returning id into loan_id;

  update public.book_copies
  set status = 'borrowed', updated_at = now()
  where id = p_copy_id;

  if ready_reservation_id is not null then
    update public.reservations
    set status = 'completed', updated_at = now()
    where id = ready_reservation_id;
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'checkout', 'loan', loan_id, jsonb_build_object('copy_id', p_copy_id, 'member_id', p_member_id));

  return loan_id;
end;
$$;

create or replace function public.renew_loan(p_loan_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  current_loan public.loans%rowtype;
  actor_role public.app_role;
  next_due_at timestamptz;
begin
  perform public.lock_circulation();
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  actor_role := public.current_user_role();
  select * into current_loan from public.loans where id = p_loan_id for update;
  if current_loan.id is null then raise exception 'Loan not found'; end if;
  if coalesce(actor_role::text, '') not in ('librarian', 'administrator') and current_loan.member_id <> auth.uid() then
    raise exception 'You are not allowed to renew this loan';
  end if;
  if current_loan.status <> 'borrowed' then raise exception 'Only active loans can be renewed'; end if;
  if current_loan.due_at is null then raise exception 'This loan has no due date'; end if;
  if current_loan.due_at <= now() then raise exception 'Overdue loans cannot be renewed'; end if;
  if current_loan.renewal_count >= public.get_setting_int('max_renewals', 1) then
    raise exception 'This loan has reached the renewal limit';
  end if;

  if exists (select 1 from public.reservations r join public.book_copies c on c.book_id = r.book_id where c.id = current_loan.copy_id and r.status in ('waiting','ready_for_pickup')) then raise exception 'This title has a reservation queue'; end if;

  next_due_at := greatest(current_loan.due_at, now()) + make_interval(days => public.get_setting_int('loan_period_days', 14));
  update public.loans
  set due_at = next_due_at, renewal_count = renewal_count + 1, last_renewed_at = now()
  where id = p_loan_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'renew', 'loan', p_loan_id, jsonb_build_object('due_at', next_due_at));

  return p_loan_id;
end;
$$;

create or replace function public.close_loan_with_status(p_loan_id uuid, p_status public.loan_status)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  loan_copy_id uuid;
  current_status public.loan_status;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can close a loan';
  end if;
  if p_status is null or p_status not in ('lost', 'damaged') then
    raise exception 'Invalid closed loan status';
  end if;

  select copy_id, status into loan_copy_id, current_status
  from public.loans where id = p_loan_id for update;
  if loan_copy_id is null then raise exception 'Loan not found'; end if;
  if current_status not in ('borrowed', 'overdue') then raise exception 'This loan is already closed'; end if;

  update public.loans set status = p_status, returned_at = now() where id = p_loan_id;
  update public.book_copies set status = p_status::text::public.copy_status, updated_at = now() where id = loan_copy_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), p_status::text, 'loan', p_loan_id, (select jsonb_build_object('copy_id',loan_copy_id,'fine_amount',fine_amount,'fine_daily_rate',fine_daily_rate,'fine_calculated_at',fine_calculated_at) from public.loans where id = p_loan_id));
end;
$$;

create or replace function public.return_loan(p_loan_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  loan_copy_id uuid;
  loan_book_id uuid;
  current_status public.loan_status;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can return books';
  end if;

  select loans.copy_id, copies.book_id, loans.status into loan_copy_id, loan_book_id, current_status
  from public.loans loans
  join public.book_copies copies on copies.id = loans.copy_id
  where loans.id = p_loan_id
  for update;

  if loan_copy_id is null then raise exception 'Loan not found'; end if;
  if current_status not in ('borrowed', 'overdue') then raise exception 'This loan is already closed'; end if;

  update public.loans set status = 'returned', returned_at = now() where id = p_loan_id;
  update public.book_copies set status = 'available', updated_at = now() where id = loan_copy_id;
  perform public.promote_next_reservation(loan_book_id);

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'return', 'loan', p_loan_id, (select jsonb_build_object('copy_id',loan_copy_id,'fine_amount',fine_amount,'fine_daily_rate',fine_daily_rate,'fine_calculated_at',fine_calculated_at) from public.loans where id = p_loan_id));
end;
$$;

create or replace function public.delete_book_record(p_book_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can delete catalog records';
  end if;
  if not exists (select 1 from public.books where id = p_book_id) then
    raise exception 'Book not found';
  end if;
  if exists (
    select 1 from public.loans
    join public.book_copies on book_copies.id = loans.copy_id
    where book_copies.book_id = p_book_id
  ) then
    raise exception 'This book has loan history and cannot be deleted';
  end if;
  if exists (
    select 1 from public.reservations
    where book_id = p_book_id and status in ('waiting', 'ready_for_pickup')
  ) then
    raise exception 'This book has active reservations and cannot be deleted';
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'delete', 'book', p_book_id, jsonb_build_object('reason', 'catalog cleanup'));
  delete from public.books where id = p_book_id;
end;
$$;
