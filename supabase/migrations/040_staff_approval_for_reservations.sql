-- A member request is not a pickup promise until staff approves it. Once an
-- approved request receives a physical copy, staff must confirm that copy is
-- actually present and usable before the pickup window or notification starts.

alter table public.reservations
  add column if not exists staff_approved_at timestamptz,
  add column if not exists staff_approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists pickup_confirmed_at timestamptz,
  add column if not exists pickup_confirmed_by uuid references public.profiles(id) on delete set null;

alter table public.reservations drop constraint if exists ready_hold_requires_copy;

-- Existing ready rows have an assigned copy, but must be rechecked by staff
-- under the new workflow. Do not let their old deadlines imply confirmation.
update public.reservations
set pickup_expires_at = null
where status = 'ready_for_pickup' and pickup_confirmed_at is null;

alter table public.reservations
  add constraint ready_hold_requires_copy
    check (status <> 'ready_for_pickup' or copy_id is not null),
  add constraint confirmed_ready_hold_requires_deadline
    check (status <> 'ready_for_pickup' or pickup_confirmed_at is null or pickup_expires_at is not null);

create or replace function public.apply_reservation_policy()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.status = 'ready_for_pickup' and new.pickup_confirmed_at is not null
    and (tg_op = 'INSERT' or old.status is distinct from new.status or old.pickup_confirmed_at is null) then
    new.pickup_expires_at := now() + make_interval(days => public.get_setting_int('pickup_hold_days', 3));
  elsif new.status = 'ready_for_pickup' and new.pickup_confirmed_at is null then
    new.pickup_expires_at := null;
  elsif new.status is distinct from 'ready_for_pickup' then
    new.pickup_expires_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists reservation_policy_trigger on public.reservations;
create trigger reservation_policy_trigger
before insert or update of status, pickup_confirmed_at on public.reservations
for each row execute procedure public.apply_reservation_policy();

create or replace function public.notify_reservation_ready()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_book_title text;
  v_auth_user_id uuid;
begin
  if new.status = 'ready_for_pickup'
    and new.pickup_confirmed_at is not null
    and (tg_op = 'INSERT' or old.status is distinct from new.status or old.pickup_confirmed_at is null)
    and public.get_setting_bool('notifications_enabled', true) then
    select title into v_book_title from public.books where id = new.book_id;
    select auth_user_id into v_auth_user_id from public.library_members where id = new.member_id;
    if v_auth_user_id is not null then
      insert into public.notifications (member_id, title, message)
      values (
        v_auth_user_id,
        'Reservation ready for pickup',
        format('%s is ready for pickup until %s.', coalesce(v_book_title, 'Your reserved book'), to_char(new.pickup_expires_at, 'YYYY-MM-DD'))
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists reservation_ready_notification_trigger on public.reservations;
create trigger reservation_ready_notification_trigger
after insert or update of status, pickup_confirmed_at on public.reservations
for each row execute procedure public.notify_reservation_ready();

-- Only requests explicitly approved by staff can claim available inventory.
create or replace function public.allocate_pickup_holds(p_book_id uuid) returns uuid
language plpgsql
security definer set search_path = public as $$
declare
  v_reservation_id uuid;
  v_copy_id uuid;
  v_first_reservation_id uuid;
begin
  perform public.lock_circulation();
  loop
    select id into v_reservation_id
    from public.reservations
    where book_id = p_book_id
      and status = 'waiting'
      and staff_approved_at is not null
    order by created_at, id
    limit 1
    for update;
    exit when v_reservation_id is null;

    select id into v_copy_id
    from public.book_copies
    where book_id = p_book_id and status = 'available'
    order by id
    limit 1
    for update;
    exit when v_copy_id is null;

    update public.book_copies set status = 'reserved', updated_at = now() where id = v_copy_id;
    update public.reservations
    set status = 'ready_for_pickup',
        copy_id = v_copy_id,
        pickup_confirmed_at = null,
        pickup_confirmed_by = null,
        updated_at = now()
    where id = v_reservation_id;

    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'pickup_assigned_pending_confirmation', 'reservation', v_reservation_id,
      jsonb_build_object('copy_id', v_copy_id));
    v_first_reservation_id := coalesce(v_first_reservation_id, v_reservation_id);
  end loop;
  return v_first_reservation_id;
end;
$$;
revoke all on function public.allocate_pickup_holds(uuid) from public, anon, authenticated;

create or replace function public.promote_next_reservation(p_book_id uuid) returns uuid
language plpgsql
security definer set search_path = public as $$
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can promote reservations';
  end if;
  return public.allocate_pickup_holds(p_book_id);
end;
$$;
revoke all on function public.promote_next_reservation(uuid) from public, anon;
grant execute on function public.promote_next_reservation(uuid) to authenticated;

create or replace function public.staff_approve_reservation_request(p_reservation_id uuid)
returns uuid
language plpgsql
security definer set search_path = public as $$
declare
  v_reservation public.reservations%rowtype;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can approve reservations';
  end if;

  perform public.process_circulation();
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if v_reservation.status <> 'waiting' then raise exception 'Only pending reservations can be approved'; end if;

  if v_reservation.staff_approved_at is null then
    update public.reservations
    set staff_approved_at = now(), staff_approved_by = auth.uid(), updated_at = now()
    where id = v_reservation.id;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'reservation_approved', 'reservation', v_reservation.id,
      jsonb_build_object('book_id', v_reservation.book_id));
  end if;

  perform public.allocate_pickup_holds(v_reservation.book_id);
  return v_reservation.id;
end;
$$;
revoke all on function public.staff_approve_reservation_request(uuid) from public, anon;
grant execute on function public.staff_approve_reservation_request(uuid) to authenticated;

-- Creating a walk-in reservation is already a staff decision, so record that
-- approval at creation. Its assigned copy still needs the separate physical
-- readiness confirmation below.
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
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  perform public.process_circulation();
  if v_reservation_date > current_date then raise exception 'Reservation date cannot be in the future'; end if;
  if p_expected_pickup_date is not null and p_expected_pickup_date < v_reservation_date then
    raise exception 'Expected pickup date cannot be before the reservation date';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then raise exception 'Notes must be 2000 characters or fewer'; end if;

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
  if v_duplicate is not null then raise exception 'This borrower already has an active reservation for this book'; end if;

  insert into public.reservations(
    book_id, member_id, status, borrower_type, borrower_full_name,
    student_employee_id, contact_number, email_address, reservation_date,
    expected_pickup_date, notes, created_by, staff_approved_at, staff_approved_by
  ) values (
    p_book_id, p_member_id, 'waiting', v_borrower->>'borrower_type',
    v_borrower->>'borrower_full_name', v_borrower->>'student_employee_id',
    v_borrower->>'contact_number', v_borrower->>'email_address', v_reservation_date,
    p_expected_pickup_date, nullif(btrim(p_notes), ''), auth.uid(), now(), auth.uid()
  ) returning id into v_reservation_id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'walk_in_reservation_create', 'reservation', v_reservation_id,
    jsonb_build_object('book_id', p_book_id, 'member_id', p_member_id,
      'borrower_type', v_borrower->>'borrower_type', 'staff_approved', true));
  perform public.allocate_pickup_holds(p_book_id);
  return v_reservation_id;
end;
$$;
revoke all on function public.staff_create_reservation(uuid, uuid, text, text, text, text, text, date, date, text) from public, anon;
grant execute on function public.staff_create_reservation(uuid, uuid, text, text, text, text, text, date, date, text) to authenticated;

create or replace function public.staff_confirm_reservation_pickup(p_reservation_id uuid)
returns uuid
language plpgsql
security definer set search_path = public as $$
declare
  v_reservation public.reservations%rowtype;
  v_copy_book_id uuid;
  v_copy_status public.copy_status;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can confirm pickup readiness';
  end if;

  perform public.process_circulation();
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if v_reservation.status <> 'ready_for_pickup' or v_reservation.copy_id is null then
    raise exception 'A physical copy must be assigned before pickup can be confirmed';
  end if;
  if v_reservation.pickup_confirmed_at is not null then return v_reservation.id; end if;

  select book_id, status into v_copy_book_id, v_copy_status
  from public.book_copies where id = v_reservation.copy_id for update;
  if v_copy_book_id is distinct from v_reservation.book_id or v_copy_status is distinct from 'reserved' then
    raise exception 'The assigned copy is no longer held for this reservation';
  end if;

  update public.reservations
  set staff_approved_at = coalesce(staff_approved_at, now()),
      staff_approved_by = coalesce(staff_approved_by, auth.uid()),
      pickup_confirmed_at = now(),
      pickup_confirmed_by = auth.uid(),
      updated_at = now()
  where id = v_reservation.id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'reservation_pickup_confirmed', 'reservation', v_reservation.id,
    jsonb_build_object('copy_id', v_reservation.copy_id));
  return v_reservation.id;
end;
$$;
revoke all on function public.staff_confirm_reservation_pickup(uuid) from public, anon;
grant execute on function public.staff_confirm_reservation_pickup(uuid) to authenticated;

-- A staff confirmation is required before any staff workflow can check out a
-- copy assigned to a reservation. Ordinary available-copy checkouts remain as-is.
create or replace function public.checkout_copy(p_copy_id uuid, p_member_id uuid, p_due_at timestamptz default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_loan_id uuid;
  v_book_id uuid;
  v_copy_status public.copy_status;
  v_active_loan_count integer;
  v_reservation_id uuid;
  v_reservation_member_id uuid;
  v_pickup_confirmed_at timestamptz;
  v_due_at timestamptz;
  v_member public.library_members%rowtype;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can check out books';
  end if;
  perform public.process_circulation();

  select * into v_member from public.library_members where id = p_member_id and is_active for update;
  if not found then raise exception 'The selected borrower must have an active library record'; end if;
  select book_id, status into v_book_id, v_copy_status from public.book_copies where id = p_copy_id for update;
  if v_book_id is null then raise exception 'Book copy not found'; end if;

  select id, member_id, pickup_confirmed_at
  into v_reservation_id, v_reservation_member_id, v_pickup_confirmed_at
  from public.reservations
  where copy_id = p_copy_id and status = 'ready_for_pickup'
  order by created_at, id limit 1 for update;
  if v_reservation_id is not null and v_pickup_confirmed_at is null then
    raise exception 'A Librarian or Administrator must confirm the copy is ready before checkout';
  end if;
  if v_member.library_card_number is null
    and (v_reservation_id is null or v_reservation_member_id is distinct from p_member_id) then
    raise exception 'Borrowers without a verified library card can only be checked out against their confirmed reservation';
  end if;
  if v_reservation_id is not null and v_reservation_member_id is distinct from p_member_id then
    raise exception 'This copy is held for the next reservation';
  end if;
  if v_copy_status not in ('available', 'reserved') then raise exception 'Book copy is not available'; end if;
  if v_copy_status = 'reserved' and v_reservation_id is null then raise exception 'Copy has no valid pickup assignment'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  select count(*) into v_active_loan_count from public.loans where member_id = p_member_id and status in ('borrowed', 'overdue');
  if v_active_loan_count >= public.get_setting_int('max_active_loans', 5) then raise exception 'This Member has reached the active loan limit'; end if;
  v_due_at := coalesce(p_due_at, now() + make_interval(days => public.get_setting_int('loan_period_days', 3)));
  if v_due_at <= now() then raise exception 'The due date must be in the future'; end if;
  if v_due_at > now() + make_interval(days => public.get_setting_int('loan_period_days', 3)) + interval '1 minute' then
    raise exception 'The due date exceeds the configured loan period';
  end if;

  insert into public.loans(copy_id, member_id, checked_out_by, due_at, status)
  values (p_copy_id, p_member_id, auth.uid(), v_due_at, 'borrowed') returning id into v_loan_id;
  update public.book_copies set status = 'borrowed', updated_at = now() where id = p_copy_id;
  if v_reservation_id is not null then
    update public.reservations set status = 'completed', updated_at = now() where id = v_reservation_id;
  end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'checkout', 'loan', v_loan_id, jsonb_build_object('copy_id', p_copy_id, 'member_id', p_member_id));
  return v_loan_id;
end;
$$;
revoke all on function public.checkout_copy(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.checkout_copy(uuid, uuid, timestamptz) to authenticated;

create or replace function public.staff_complete_walkin_reservation(p_reservation_id uuid)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_reservation public.reservations%rowtype;
  v_member_id uuid;
  v_loan_id uuid;
  v_member_type text;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Only Librarians and Administrators can check out books';
  end if;
  perform public.process_circulation();
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if v_reservation.status <> 'ready_for_pickup' or v_reservation.pickup_confirmed_at is null then
    raise exception 'A Librarian or Administrator must confirm pickup readiness before checkout';
  end if;
  if v_reservation.member_id is not null then raise exception 'This reservation is already linked to a library member'; end if;
  if v_reservation.copy_id is null then raise exception 'This reservation has no physical copy assigned'; end if;

  v_member_type := case v_reservation.borrower_type when 'student' then 'student' when 'faculty' then 'teacher' else 'other' end;
  insert into public.library_members(full_name, member_type, created_by)
  values (btrim(v_reservation.borrower_full_name), v_member_type, auth.uid()) returning id into v_member_id;
  update public.reservations set member_id = v_member_id where id = v_reservation.id;
  v_loan_id := public.checkout_copy(v_reservation.copy_id, v_member_id);
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

-- Queue positions only count requests which staff approved. A new request
-- therefore reports "pending approval" instead of misleading the member with
-- a FIFO position it has not earned yet.
create or replace function public.my_reservation_positions()
returns table(id uuid, queue_position bigint)
language sql stable security definer set search_path = public as $$
  select r.id,
    case when r.staff_approved_at is null then null else (
      select count(*) from public.reservations q
      where q.book_id = r.book_id and q.status = 'waiting' and q.staff_approved_at is not null
        and (q.created_at, q.id) <= (r.created_at, r.id)
    ) end
  from public.reservations r
  join public.library_members m on m.id = r.member_id
  where m.auth_user_id = auth.uid() and r.status = 'waiting';
$$;
revoke all on function public.my_reservation_positions() from public, anon;
grant execute on function public.my_reservation_positions() to authenticated;

create or replace function public.card_reservation_status(p_card_number text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare
  v_member_id uuid;
  v_reservations jsonb;
begin
  perform public.lock_circulation();
  v_member_id := public.verify_library_card_reservation_pin(p_card_number, p_pin);
  if v_member_id is null then return jsonb_build_object('verified', false); end if;
  perform public.process_circulation();
  select coalesce(jsonb_agg(jsonb_build_object(
      'reservation_id', r.id,
      'book_title', b.title,
      'author', b.author,
      'status', r.status,
      'staff_approved', r.staff_approved_at is not null,
      'pickup_confirmed', r.pickup_confirmed_at is not null,
      'queue_position', case when r.status = 'waiting' and r.staff_approved_at is not null then (
        select count(*) from public.reservations q
        where q.book_id = r.book_id and q.status = 'waiting' and q.staff_approved_at is not null
          and (q.created_at, q.id) <= (r.created_at, r.id)
      ) else null end,
      'created_at', r.created_at,
      'pickup_expires_at', r.pickup_expires_at
    ) order by r.created_at desc, r.id desc), '[]'::jsonb)
  into v_reservations
  from public.reservations r join public.books b on b.id = r.book_id
  where r.member_id = v_member_id and r.status in ('waiting', 'ready_for_pickup');
  return jsonb_build_object('verified', true, 'reservations', v_reservations);
end;
$$;
revoke all on function public.card_reservation_status(text, text) from public;
grant execute on function public.card_reservation_status(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
