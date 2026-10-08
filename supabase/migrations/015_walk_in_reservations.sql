-- Walk-in reservations keep borrower identity on the reservation itself.
-- Existing reservations remain linked to their library member and keep their
-- current status, physical copy assignment, and FIFO queue timestamp.

alter table public.reservations
  alter column member_id drop not null,
  add column borrower_type text,
  add column borrower_full_name text,
  add column student_employee_id text,
  add column contact_number text,
  add column email_address text,
  add column reservation_date date,
  add column expected_pickup_date date,
  add column notes text,
  add column created_by uuid references public.profiles(id) on delete set null;

update public.reservations r
set borrower_full_name = m.full_name,
    borrower_type = case m.member_type
      when 'student' then 'student'
      when 'teacher' then 'faculty'
      else 'visitor'
    end,
    student_employee_id = nullif(btrim(m.school_id), ''),
    reservation_date = coalesce(r.created_at::date, current_date)
from public.library_members m
where m.id = r.member_id;

update public.reservations
set borrower_full_name = coalesce(nullif(btrim(borrower_full_name), ''), 'Unknown borrower'),
    borrower_type = coalesce(borrower_type, 'visitor'),
    reservation_date = coalesce(reservation_date, created_at::date, current_date);

alter table public.reservations
  alter column borrower_type set not null,
  alter column borrower_full_name set not null,
  alter column reservation_date set default current_date,
  alter column reservation_date set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reservations_borrower_type_valid') then
    alter table public.reservations add constraint reservations_borrower_type_valid
      check (borrower_type in ('student', 'faculty', 'staff', 'visitor'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservations_borrower_name_valid') then
    alter table public.reservations add constraint reservations_borrower_name_valid
      check (length(btrim(borrower_full_name)) between 1 and 160);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservations_student_employee_id_length') then
    alter table public.reservations add constraint reservations_student_employee_id_length
      check (student_employee_id is null or length(btrim(student_employee_id)) between 1 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservations_contact_number_length') then
    alter table public.reservations add constraint reservations_contact_number_length
      check (contact_number is null or (
        length(btrim(contact_number)) between 1 and 40
        and length(regexp_replace(contact_number, '[^0-9]', '', 'g')) between 7 and 15
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservations_email_address_valid') then
    alter table public.reservations add constraint reservations_email_address_valid
      check (email_address is null or (
        length(btrim(email_address)) <= 254
        and email_address ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservations_notes_length') then
    alter table public.reservations add constraint reservations_notes_length
      check (notes is null or length(notes) <= 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservations_expected_pickup_not_before_request') then
    alter table public.reservations add constraint reservations_expected_pickup_not_before_request
      check (expected_pickup_date is null or expected_pickup_date >= reservation_date);
  end if;
end;
$$;

create index reservations_borrower_name_search on public.reservations using gin (to_tsvector('simple', borrower_full_name));
create index reservations_borrower_id_search on public.reservations (lower(student_employee_id)) where student_employee_id is not null;
create index reservations_walkin_duplicate_lookup on public.reservations (book_id, status, lower(borrower_full_name))
  where status in ('waiting', 'ready_for_pickup');

-- Legacy reservation APIs still insert only book/member/status. Populate the
-- borrower snapshot so existing member and card/PIN flows remain readable.
create or replace function public.populate_reservation_borrower_snapshot()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_member public.library_members%rowtype;
begin
  if new.member_id is not null and (
    tg_op = 'INSERT'
    or new.member_id is distinct from old.member_id
    or new.borrower_full_name is null
    or new.borrower_type is null
  ) then
    select * into v_member from public.library_members where id = new.member_id;
    if not found then raise exception 'The selected library member does not exist'; end if;
    new.borrower_full_name := v_member.full_name;
    new.borrower_type := case v_member.member_type
      when 'student' then 'student'
      when 'teacher' then 'faculty'
      else 'visitor'
    end;
    new.student_employee_id := nullif(btrim(v_member.school_id), '');
  end if;
  new.reservation_date := coalesce(new.reservation_date, current_date);
  return new;
end;
$$;
revoke all on function public.populate_reservation_borrower_snapshot() from public, anon, authenticated;
drop trigger if exists reservation_borrower_snapshot on public.reservations;
create trigger reservation_borrower_snapshot
before insert or update of member_id, borrower_full_name, borrower_type on public.reservations
for each row execute function public.populate_reservation_borrower_snapshot();

create function public.resolve_reservation_borrower(
  p_member_id uuid,
  p_borrower_type text,
  p_borrower_full_name text,
  p_student_employee_id text,
  p_contact_number text,
  p_email_address text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_member public.library_members%rowtype;
  v_type text := p_borrower_type;
  v_name text := nullif(btrim(p_borrower_full_name), '');
  v_id text := nullif(btrim(p_student_employee_id), '');
  v_contact text := nullif(btrim(p_contact_number), '');
  v_email text := nullif(btrim(p_email_address), '');
begin
  if p_member_id is not null then
    select * into v_member from public.library_members
      where id = p_member_id and is_active and library_card_number is not null for share;
    if not found then raise exception 'Choose an active member with a verified library card, or clear the member selection for a walk-in'; end if;
    v_name := v_member.full_name;
    v_id := nullif(btrim(v_member.school_id), '');
    v_type := case v_member.member_type
      when 'student' then 'student'
      when 'teacher' then 'faculty'
      else 'visitor'
    end;
  end if;

  if v_type not in ('student', 'faculty', 'staff', 'visitor') then raise exception 'Choose a valid borrower type'; end if;
  if v_name is null or length(v_name) > 160 then raise exception 'Enter a valid borrower name'; end if;
  if v_id is not null and length(v_id) > 100 then raise exception 'Student/Employee ID must be 100 characters or fewer'; end if;
  if v_contact is not null and (
    length(v_contact) > 40 or length(regexp_replace(v_contact, '[^0-9]', '', 'g')) not between 7 and 15
  ) then raise exception 'Enter a valid contact number with 7 to 15 digits'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') then
    raise exception 'Enter a valid email address';
  end if;

  return jsonb_build_object(
    'borrower_type', v_type,
    'borrower_full_name', v_name,
    'student_employee_id', v_id,
    'contact_number', v_contact,
    'email_address', lower(v_email)
  );
end;
$$;
revoke all on function public.resolve_reservation_borrower(uuid, text, text, text, text, text) from public, anon, authenticated;

create function public.assert_reservation_book_eligible(p_book_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.books where id = p_book_id) then raise exception 'Book not found'; end if;
  if not exists (select 1 from public.book_copies where book_id = p_book_id) then
    raise exception 'This title has no physical copies; record an acquisition request instead';
  end if;
  if exists (select 1 from public.book_copies where book_id = p_book_id and status = 'available') then
    raise exception 'This title has an available copy; check it out at the desk instead';
  end if;
  if not exists (select 1 from public.book_copies where book_id = p_book_id and status in ('borrowed', 'overdue', 'reserved')) then
    raise exception 'No copies of this title are currently circulating';
  end if;
end;
$$;
revoke all on function public.assert_reservation_book_eligible(uuid) from public, anon, authenticated;

create function public.find_active_reservation_duplicate(
  p_book_id uuid,
  p_member_id uuid,
  p_borrower_full_name text,
  p_student_employee_id text,
  p_contact_number text,
  p_email_address text,
  p_exclude_reservation_id uuid default null
) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select r.id
  from public.reservations r
  where r.book_id = p_book_id
    and r.status in ('waiting', 'ready_for_pickup')
    and (p_exclude_reservation_id is null or r.id <> p_exclude_reservation_id)
    and (
      (p_member_id is not null and r.member_id = p_member_id)
      or (nullif(btrim(p_student_employee_id), '') is not null
        and lower(btrim(r.student_employee_id)) = lower(btrim(p_student_employee_id)))
      or (nullif(btrim(p_email_address), '') is not null
        and lower(btrim(r.email_address)) = lower(btrim(p_email_address)))
      or (length(regexp_replace(coalesce(p_contact_number, ''), '[^0-9]', '', 'g')) >= 7
        and regexp_replace(coalesce(r.contact_number, ''), '[^0-9]', '', 'g') = regexp_replace(p_contact_number, '[^0-9]', '', 'g'))
      or (
        nullif(p_student_employee_id, '') is null and nullif(r.student_employee_id, '') is null
        and nullif(p_email_address, '') is null and nullif(r.email_address, '') is null
        and length(regexp_replace(coalesce(p_contact_number, ''), '[^0-9]', '', 'g')) < 7
        and length(regexp_replace(coalesce(r.contact_number, ''), '[^0-9]', '', 'g')) < 7
        and lower(regexp_replace(btrim(r.borrower_full_name), '[[:space:]]+', ' ', 'g')) =
            lower(regexp_replace(btrim(p_borrower_full_name), '[[:space:]]+', ' ', 'g'))
      )
    )
  order by r.created_at, r.id
  limit 1
$$;
revoke all on function public.find_active_reservation_duplicate(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;

create function public.staff_create_reservation(
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
  return v_reservation_id;
end;
$$;
revoke all on function public.staff_create_reservation(uuid, uuid, text, text, text, text, text, date, date, text) from public, anon;
grant execute on function public.staff_create_reservation(uuid, uuid, text, text, text, text, text, date, date, text) to authenticated;

create function public.staff_update_reservation(
  p_reservation_id uuid,
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
  v_reservation public.reservations%rowtype;
  v_borrower jsonb;
  v_reservation_date date := coalesce(p_reservation_date, current_date);
  v_duplicate uuid;
  v_requeue boolean;
  v_linking_walkin boolean;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  perform public.process_circulation();
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if v_reservation.status not in ('waiting', 'ready_for_pickup') then
    raise exception 'Only active reservations can be edited';
  end if;
  if v_reservation_date > current_date then raise exception 'Reservation date cannot be in the future'; end if;
  if p_expected_pickup_date is not null and p_expected_pickup_date < v_reservation_date then
    raise exception 'Expected pickup date cannot be before the reservation date';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then raise exception 'Notes must be 2000 characters or fewer'; end if;

  v_borrower := public.resolve_reservation_borrower(
    p_member_id, p_borrower_type, p_borrower_full_name,
    p_student_employee_id, p_contact_number, p_email_address
  );
  v_linking_walkin := v_reservation.member_id is null and p_member_id is not null;
  if v_reservation.status = 'ready_for_pickup' and (
    p_book_id is distinct from v_reservation.book_id
    or (p_member_id is distinct from v_reservation.member_id and not v_linking_walkin)
    or (not v_linking_walkin and (
      p_borrower_type is distinct from v_reservation.borrower_type
      or nullif(btrim(p_borrower_full_name), '') is distinct from v_reservation.borrower_full_name
      or nullif(btrim(p_student_employee_id), '') is distinct from v_reservation.student_employee_id
    ))
  ) then
    raise exception 'A ready reservation already holds a physical copy. Its borrower and book cannot be changed';
  end if;
  if v_reservation.status = 'ready_for_pickup' and v_linking_walkin and (
    lower(v_borrower->>'borrower_full_name') <> lower(v_reservation.borrower_full_name)
    or (nullif(v_borrower->>'student_employee_id', '') is not null
      and nullif(v_reservation.student_employee_id, '') is not null
      and lower(v_borrower->>'student_employee_id') <> lower(v_reservation.student_employee_id))
  ) then
    raise exception 'The active library member details do not match this walk-in borrower';
  end if;
  v_requeue := p_book_id is distinct from v_reservation.book_id;
  if v_requeue then
    if v_reservation.status <> 'waiting' then raise exception 'A ready reservation cannot be moved to another book'; end if;
    perform public.assert_reservation_book_eligible(p_book_id);
  end if;
  v_duplicate := public.find_active_reservation_duplicate(
    p_book_id, p_member_id,
    v_borrower->>'borrower_full_name', v_borrower->>'student_employee_id',
    v_borrower->>'contact_number', v_borrower->>'email_address', p_reservation_id
  );
  if v_duplicate is not null then raise exception 'This borrower already has an active reservation for this book'; end if;

  update public.reservations set
    book_id = p_book_id,
    member_id = p_member_id,
    borrower_type = v_borrower->>'borrower_type',
    borrower_full_name = v_borrower->>'borrower_full_name',
    student_employee_id = v_borrower->>'student_employee_id',
    contact_number = v_borrower->>'contact_number',
    email_address = v_borrower->>'email_address',
    reservation_date = v_reservation_date,
    expected_pickup_date = p_expected_pickup_date,
    notes = nullif(btrim(p_notes), ''),
    created_at = case when v_requeue then now() else created_at end,
    updated_at = now()
  where id = p_reservation_id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'reservation_edit', 'reservation', p_reservation_id,
    jsonb_build_object('book_id', p_book_id, 'member_id', p_member_id, 'queue_repositioned', v_requeue));
  return p_reservation_id;
end;
$$;
revoke all on function public.staff_update_reservation(uuid, uuid, uuid, text, text, text, text, text, date, date, text) from public, anon;
grant execute on function public.staff_update_reservation(uuid, uuid, uuid, text, text, text, text, text, date, date, text) to authenticated;

-- Keep the existing staff API available for callers that still submit a member
-- ID, while routing new writes through the same validated queue implementation.
create or replace function public.staff_reserve_book(p_book_id uuid, p_member_id uuid)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_member public.library_members%rowtype;
  v_reservation_id uuid;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  perform public.process_circulation();
  select * into v_member from public.library_members
    where id = p_member_id and is_active and library_card_number is not null;
  if not found then raise exception 'Select an active member with a verified library card'; end if;
  perform public.assert_reservation_book_eligible(p_book_id);
  select id into v_reservation_id from public.reservations
    where book_id = p_book_id and member_id = p_member_id and status in ('waiting', 'ready_for_pickup')
    order by created_at, id limit 1;
  if v_reservation_id is not null then return v_reservation_id; end if;
  return public.staff_create_reservation(
    p_book_id, p_member_id,
    case v_member.member_type when 'student' then 'student' when 'teacher' then 'faculty' else 'visitor' end,
    v_member.full_name, v_member.school_id, null, null, current_date, null, null
  );
end;
$$;
revoke all on function public.staff_reserve_book(uuid, uuid) from public, anon;
grant execute on function public.staff_reserve_book(uuid, uuid) to authenticated;

create or replace function public.cancel_reservation(p_reservation_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_reservation public.reservations%rowtype;
begin
  perform public.lock_circulation();
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not coalesce(public.is_staff(), false) and not exists (
    select 1 from public.library_members where id = v_reservation.member_id and auth_user_id = auth.uid()
  ) then raise exception 'Not allowed to cancel this reservation'; end if;
  if v_reservation.status not in ('waiting', 'ready_for_pickup') then raise exception 'Reservation is not active'; end if;
  update public.reservations set status = 'cancelled', updated_at = now() where id = v_reservation.id;
  update public.book_copies set status = 'available', updated_at = now()
    where id = v_reservation.copy_id and status = 'reserved';
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'cancel', 'reservation', v_reservation.id, jsonb_build_object('copy_id', v_reservation.copy_id));
  perform public.allocate_pickup_holds(v_reservation.book_id);
end;
$$;
revoke all on function public.cancel_reservation(uuid) from public, anon;
grant execute on function public.cancel_reservation(uuid) to authenticated;

-- A walk-in hold can never be completed by checking it out to an unrelated
-- borrower. Staff first associate it with an active library member in Edit.
create or replace function public.checkout_copy(p_copy_id uuid, p_member_id uuid, p_due_at timestamptz default null)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_loan_id uuid;
  v_book_id uuid;
  v_copy_status public.copy_status;
  v_active_loan_count integer;
  v_ready_reservation_id uuid;
  v_ready_reservation_member_id uuid;
  v_due_at timestamptz;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Only Librarians and Administrators can check out books'; end if;
  perform public.process_circulation();
  if not exists (select 1 from public.library_members where id = p_member_id and is_active and library_card_number is not null) then
    raise exception 'The selected borrower must be active and have a verified library card';
  end if;
  select book_id, status into v_book_id, v_copy_status from public.book_copies where id = p_copy_id for update;
  if v_book_id is null then raise exception 'Book copy not found'; end if;
  if v_copy_status not in ('available', 'reserved') then raise exception 'Book copy is not available'; end if;
  select id, member_id into v_ready_reservation_id, v_ready_reservation_member_id
    from public.reservations where copy_id = p_copy_id and status = 'ready_for_pickup'
    order by created_at, id limit 1 for update;
  if v_ready_reservation_id is not null and v_ready_reservation_member_id is distinct from p_member_id then
    raise exception 'This copy is held for the next reservation';
  end if;
  if v_copy_status = 'reserved' and v_ready_reservation_id is null then raise exception 'Copy has no valid pickup assignment'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  select count(*) into v_active_loan_count from public.loans
    where member_id = p_member_id and status in ('borrowed', 'overdue');
  if v_active_loan_count >= public.get_setting_int('max_active_loans', 5) then raise exception 'This Member has reached the active loan limit'; end if;
  v_due_at := coalesce(p_due_at, now() + make_interval(days => public.get_setting_int('loan_period_days', 3)));
  if v_due_at <= now() then raise exception 'The due date must be in the future'; end if;
  if v_due_at > now() + make_interval(days => public.get_setting_int('loan_period_days', 3)) + interval '1 minute' then
    raise exception 'The due date exceeds the configured loan period';
  end if;
  insert into public.loans(copy_id, member_id, checked_out_by, due_at, status)
    values (p_copy_id, p_member_id, auth.uid(), v_due_at, 'borrowed') returning id into v_loan_id;
  update public.book_copies set status = 'borrowed', updated_at = now() where id = p_copy_id;
  if v_ready_reservation_id is not null then
    update public.reservations set status = 'completed', updated_at = now() where id = v_ready_reservation_id;
  end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'checkout', 'loan', v_loan_id, jsonb_build_object('copy_id', p_copy_id, 'member_id', p_member_id));
  return v_loan_id;
end;
$$;
revoke all on function public.checkout_copy(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.checkout_copy(uuid, uuid, timestamptz) to authenticated;

-- Expiring a walk-in pickup releases the copy but must not try to create a
-- profile-keyed notification with a null reservation.member_id.
create or replace function public.process_circulation()
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_reservation record;
  v_book_id uuid;
  v_notification_user_id uuid;
begin
  perform public.lock_circulation();
  with changed as (
    update public.loans set status = 'overdue' where status = 'borrowed' and due_at < now()
    returning member_id, fine_amount
  )
  insert into public.notifications(member_id, title, message)
  select m.auth_user_id, 'Book overdue', format('A borrowed book is overdue. Current fine: %s.', changed.fine_amount)
  from changed join public.library_members m on m.id = changed.member_id
  where m.auth_user_id is not null and public.get_setting_bool('notifications_enabled', true);
  update public.loans set fine_amount = fine_amount where status = 'overdue';
  update public.book_copies c set status = 'overdue', updated_at = now()
    from public.loans l where l.copy_id = c.id and l.status = 'overdue' and c.status = 'borrowed';

  for v_reservation in
    select * from public.reservations where status = 'ready_for_pickup' and pickup_expires_at <= now() for update
  loop
    update public.reservations set status = 'expired', updated_at = now() where id = v_reservation.id;
    update public.book_copies set status = 'available', updated_at = now()
      where id = v_reservation.copy_id and status = 'reserved';
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
      values (auth.uid(), 'expired', 'reservation', v_reservation.id, jsonb_build_object('copy_id', v_reservation.copy_id));
    select m.auth_user_id into v_notification_user_id
      from public.library_members m where m.id = v_reservation.member_id;
    if v_notification_user_id is not null and public.get_setting_bool('notifications_enabled', true) then
      insert into public.notifications(member_id, title, message)
        values (v_notification_user_id, 'Reservation expired', 'Your pickup deadline passed. The copy has been released.');
    end if;
  end loop;

  for v_book_id in select distinct book_id from public.reservations where status = 'waiting' loop
    perform public.allocate_pickup_holds(v_book_id);
  end loop;
  insert into public.circulation_job_health(singleton, last_success_at) values (true, now())
    on conflict (singleton) do update set last_success_at = excluded.last_success_at;
end;
$$;
revoke all on function public.process_circulation() from public, anon, authenticated;
grant execute on function public.process_circulation() to service_role;

notify pgrst, 'reload schema';
