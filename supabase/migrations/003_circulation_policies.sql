-- Configurable circulation rules and server-side enforcement.
-- Defaults are intentionally conservative and can be changed by administrators
-- through the User Management policy form or directly in system_settings.

alter table public.reservations
  add column if not exists pickup_expires_at timestamptz;

alter table public.loans
  add column if not exists renewal_count integer not null default 0,
  add column if not exists last_renewed_at timestamptz,
  add column if not exists fine_amount numeric(10, 2) not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'loans_renewal_count_nonnegative'
  ) then
    alter table public.loans add constraint loans_renewal_count_nonnegative check (renewal_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'loans_fine_amount_nonnegative'
  ) then
    alter table public.loans add constraint loans_fine_amount_nonnegative check (fine_amount >= 0);
  end if;
end;
$$;

insert into public.system_settings (key, value, description)
values
  ('loan_period_days', to_jsonb(14), 'Default number of days for a new loan.'),
  ('max_active_loans', to_jsonb(5), 'Maximum borrowed or overdue loans per member.'),
  ('due_soon_days', to_jsonb(3), 'Number of days before due date shown as due soon.'),
  ('max_renewals', to_jsonb(1), 'Maximum renewals allowed per loan.'),
  ('pickup_hold_days', to_jsonb(3), 'Number of days a ready reservation is held.'),
  ('fine_per_day', to_jsonb(0), 'Fine amount charged per overdue day.'),
  ('notifications_enabled', to_jsonb(true), 'Enable in-app circulation notifications.')
on conflict (key) do nothing;

create or replace function public.get_setting_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer set search_path = public
as $$
  select coalesce((
    select case
      when value #>> '{}' ~ '^-?[0-9]+$' then (value #>> '{}')::integer
      else null
    end
    from public.system_settings
    where key = p_key
  ), p_default);
$$;

create or replace function public.get_setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer set search_path = public
as $$
  select coalesce((
    select case
      when value #>> '{}' ~ '^-?[0-9]+([.][0-9]+)?$' then (value #>> '{}')::numeric
      else null
    end
    from public.system_settings
    where key = p_key
  ), p_default);
$$;

create or replace function public.get_setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce((
    select case
      when lower(value #>> '{}') in ('true', 'false') then (value #>> '{}')::boolean
      else null
    end
    from public.system_settings
    where key = p_key
  ), p_default);
$$;

revoke all on function public.get_setting_int(text, integer) from public;
revoke all on function public.get_setting_numeric(text, numeric) from public;
revoke all on function public.get_setting_bool(text, boolean) from public;

create or replace function public.get_circulation_policy()
returns jsonb
language sql
stable
security definer set search_path = public
as $$
  select jsonb_build_object(
    'loan_period_days', public.get_setting_int('loan_period_days', 14),
    'max_active_loans', public.get_setting_int('max_active_loans', 5),
    'due_soon_days', public.get_setting_int('due_soon_days', 3),
    'max_renewals', public.get_setting_int('max_renewals', 1),
    'pickup_hold_days', public.get_setting_int('pickup_hold_days', 3),
    'fine_per_day', public.get_setting_numeric('fine_per_day', 0),
    'notifications_enabled', public.get_setting_bool('notifications_enabled', true)
  );
$$;

revoke all on function public.get_circulation_policy() from public;
grant execute on function public.get_circulation_policy() to authenticated;

create or replace function public.apply_reservation_policy()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.status = 'ready_for_pickup'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.pickup_expires_at := now() + make_interval(days => public.get_setting_int('pickup_hold_days', 3));
  elsif new.status is distinct from 'ready_for_pickup' then
    new.pickup_expires_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists reservation_policy_trigger on public.reservations;
create trigger reservation_policy_trigger
before insert or update of status on public.reservations
for each row execute procedure public.apply_reservation_policy();

create or replace function public.notify_reservation_ready()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  book_title text;
begin
  if new.status = 'ready_for_pickup'
    and (tg_op = 'INSERT' or old.status is distinct from new.status)
    and public.get_setting_bool('notifications_enabled', true) then
    select title into book_title from public.books where id = new.book_id;
    insert into public.notifications (member_id, title, message)
    values (
      new.member_id,
      'Reservation ready for pickup',
      format('%s is ready for pickup until %s.', coalesce(book_title, 'Your reserved book'), to_char(new.pickup_expires_at, 'YYYY-MM-DD'))
    );
  end if;
  return new;
end;
$$;

drop trigger if exists reservation_ready_notification_trigger on public.reservations;
create trigger reservation_ready_notification_trigger
after insert or update of status on public.reservations
for each row execute procedure public.notify_reservation_ready();

create or replace function public.refresh_circulation_statuses()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  expired_book_id uuid;
begin
  if (auth.uid() is null and coalesce(auth.role(), '') <> 'service_role')
    or (auth.uid() is not null and not public.is_staff()) then
    raise exception 'Only Librarians and Administrators can refresh circulation statuses';
  end if;

  with changed as (
    update public.loans
    set status = 'overdue',
        fine_amount = greatest(
          0,
          ceil(extract(epoch from (now() - due_at)) / 86400)
            * public.get_setting_numeric('fine_per_day', 0)
        )
    where status = 'borrowed' and due_at is not null and due_at < now()
    returning id, member_id, copy_id, due_at
  )
  insert into public.notifications (member_id, title, message)
  select changed.member_id,
         'Book overdue',
         format('A borrowed book is overdue. Current fine: %s.', to_char(
           greatest(0, ceil(extract(epoch from (now() - changed.due_at)) / 86400)
             * public.get_setting_numeric('fine_per_day', 0)), 'FM999999990.00'
         ))
  from changed
  where public.get_setting_bool('notifications_enabled', true);

  update public.loans
  set fine_amount = greatest(
    0,
    ceil(extract(epoch from (now() - due_at)) / 86400)
      * public.get_setting_numeric('fine_per_day', 0)
  )
  where status = 'overdue' and due_at is not null;

  update public.book_copies copies
  set status = 'overdue', updated_at = now()
  from public.loans loans
  where loans.copy_id = copies.id and loans.status = 'overdue' and copies.status = 'borrowed';

  with expired as (
    update public.reservations
    set status = 'expired', updated_at = now()
    where status = 'ready_for_pickup' and pickup_expires_at is not null and pickup_expires_at <= now()
    returning member_id, book_id
  )
  insert into public.notifications (member_id, title, message)
  select expired.member_id,
         'Reservation expired',
         format('Your reservation for %s expired because it was not collected in time.', coalesce(books.title, 'a book'))
  from expired
  left join public.books on books.id = expired.book_id
  where public.get_setting_bool('notifications_enabled', true);

  for expired_book_id in
    select distinct reservations.book_id
    from public.reservations
    where reservations.status = 'expired'
      and exists (select 1 from public.reservations next_reservation where next_reservation.book_id = reservations.book_id and next_reservation.status = 'waiting')
      and exists (select 1 from public.book_copies available_copy where available_copy.book_id = reservations.book_id and available_copy.status = 'available')
  loop
    perform public.promote_next_reservation(expired_book_id);
  end loop;
end;
$$;

revoke all on function public.refresh_circulation_statuses() from public;
grant execute on function public.refresh_circulation_statuses() to authenticated;

create or replace function public.promote_next_reservation(p_book_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  next_reservation_id uuid;
begin
  if (auth.uid() is null and coalesce(auth.role(), '') <> 'service_role')
    or (auth.uid() is not null and not public.is_staff()) then
    raise exception 'Only Librarians and Administrators can promote reservations';
  end if;

  select id into next_reservation_id
  from public.reservations
  where book_id = p_book_id and status = 'waiting'
  order by created_at asc
  limit 1
  for update skip locked;

  if next_reservation_id is null then
    return null;
  end if;

  update public.reservations
  set status = 'ready_for_pickup', updated_at = now()
  where id = next_reservation_id;

  return next_reservation_id;
end;
$$;

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
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Only Librarians and Administrators can check out books';
  end if;

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

  if current_status <> 'available' then
    raise exception 'Book copy is not available';
  end if;

  select id, member_id into ready_reservation_id, ready_reservation_member_id
  from public.reservations
  where book_id = copy_book_id and status = 'ready_for_pickup'
  order by created_at asc
  limit 1
  for update;

  if ready_reservation_id is not null and ready_reservation_member_id <> p_member_id then
    raise exception 'This copy is held for the next reservation';
  end if;

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
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  actor_role := public.current_user_role();
  select * into current_loan from public.loans where id = p_loan_id for update;
  if current_loan.id is null then raise exception 'Loan not found'; end if;
  if actor_role <> 'librarian' and actor_role <> 'administrator' and current_loan.member_id <> auth.uid() then
    raise exception 'You are not allowed to renew this loan';
  end if;
  if current_loan.status <> 'borrowed' then raise exception 'Only active loans can be renewed'; end if;
  if current_loan.due_at is null then raise exception 'This loan has no due date'; end if;
  if current_loan.due_at <= now() then raise exception 'Overdue loans cannot be renewed'; end if;
  if current_loan.renewal_count >= public.get_setting_int('max_renewals', 1) then
    raise exception 'This loan has reached the renewal limit';
  end if;

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
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Only Librarians and Administrators can close a loan';
  end if;
  if p_status not in ('lost', 'damaged') then
    raise exception 'Invalid closed loan status';
  end if;

  select copy_id, status into loan_copy_id, current_status
  from public.loans where id = p_loan_id for update;
  if loan_copy_id is null then raise exception 'Loan not found'; end if;
  if current_status not in ('borrowed', 'overdue') then raise exception 'This loan is already closed'; end if;

  update public.loans set status = p_status, returned_at = now() where id = p_loan_id;
  update public.book_copies set status = p_status::text::public.copy_status, updated_at = now() where id = loan_copy_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), p_status::text, 'loan', p_loan_id, jsonb_build_object('copy_id', loan_copy_id));
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
  if auth.uid() is null or not public.is_staff() then
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
  values (auth.uid(), 'return', 'loan', p_loan_id, jsonb_build_object('copy_id', loan_copy_id));
end;
$$;

create or replace function public.delete_book_record(p_book_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_staff() then
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

drop policy if exists "staff can manage books" on public.books;
create policy "staff can insert books"
  on public.books for insert
  to authenticated
  with check (public.is_staff());

create policy "staff can update books"
  on public.books for update
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

revoke all on function public.reserve_book(uuid) from public;
revoke all on function public.cancel_reservation(uuid) from public;
revoke all on function public.checkout_copy(uuid, uuid, timestamptz) from public;
revoke all on function public.return_loan(uuid) from public;
revoke all on function public.promote_next_reservation(uuid) from public;
revoke all on function public.renew_loan(uuid) from public;
revoke all on function public.close_loan_with_status(uuid, public.loan_status) from public;
revoke all on function public.delete_book_record(uuid) from public;

grant execute on function public.reserve_book(uuid) to authenticated;
grant execute on function public.cancel_reservation(uuid) to authenticated;
grant execute on function public.checkout_copy(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.return_loan(uuid) to authenticated;
grant execute on function public.promote_next_reservation(uuid) to authenticated;
grant execute on function public.renew_loan(uuid) to authenticated;
grant execute on function public.close_loan_with_status(uuid, public.loan_status) to authenticated;
grant execute on function public.delete_book_record(uuid) to authenticated;

create index if not exists reservations_pickup_expiry on public.reservations (status, pickup_expires_at);
create index if not exists loans_due_status on public.loans (status, due_at);
