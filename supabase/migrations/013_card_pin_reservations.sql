-- Permit accountless online holds only after proving possession of a library
-- card and a staff-issued PIN. Credential hashes are never readable through
-- PostgREST, and anonymous users receive access only to these bounded RPCs.

create table public.library_member_reservation_pins (
  member_id uuid primary key references public.library_members(id) on delete cascade,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.library_member_reservation_pins enable row level security;
revoke all on public.library_member_reservation_pins from public, anon, authenticated, service_role;

create function public.set_library_card_reservation_pin(p_member_id uuid, p_pin text)
returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Staff access required';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{6,12}$' then
    raise exception 'Use a PIN containing 6 to 12 digits';
  end if;
  perform public.lock_circulation();
  if not exists (
    select 1 from public.library_members
    where id = p_member_id and is_active and library_card_number is not null
    for update
  ) then
    raise exception 'An active member with a verified library card is required';
  end if;
  insert into public.library_member_reservation_pins(member_id, pin_hash)
    values (p_member_id, crypt(p_pin, gen_salt('bf', 12)))
    on conflict (member_id) do update set
      pin_hash = excluded.pin_hash,
      failed_attempts = 0,
      locked_until = null,
      updated_at = now();
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'reservation_pin_set', 'library_member', p_member_id, '{}'::jsonb);
end;
$$;
revoke all on function public.set_library_card_reservation_pin(uuid, text) from public, anon;
grant execute on function public.set_library_card_reservation_pin(uuid, text) to authenticated;

-- Internal verifier. Locking the member and credential rows serializes failed
-- attempts so parallel requests cannot bypass the five-attempt lockout.
create function public.verify_library_card_reservation_pin(p_card_number text, p_pin text)
returns uuid
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare
  v_member_id uuid;
  v_pin_hash text;
  v_failed_attempts integer;
  v_locked_until timestamptz;
begin
  if p_card_number is null or length(btrim(p_card_number)) not between 1 and 100
     or p_pin is null or p_pin !~ '^[0-9]{6,12}$' then
    return null;
  end if;
  select m.id into v_member_id
    from public.library_members m
    where upper(btrim(m.library_card_number)) = upper(btrim(p_card_number))
      and m.is_active and m.library_card_number is not null
    for update;
  if v_member_id is null then return null; end if;

  select c.pin_hash, c.failed_attempts, c.locked_until
    into v_pin_hash, v_failed_attempts, v_locked_until
    from public.library_member_reservation_pins c
    where c.member_id = v_member_id
    for update;
  if v_pin_hash is null or v_locked_until > now() then return null; end if;

  if crypt(p_pin, v_pin_hash) = v_pin_hash then
    update public.library_member_reservation_pins
      set failed_attempts = 0, locked_until = null, updated_at = now()
      where member_id = v_member_id;
    return v_member_id;
  end if;

  v_failed_attempts := least(v_failed_attempts + 1, 5);
  update public.library_member_reservation_pins
    set failed_attempts = v_failed_attempts,
        locked_until = case when v_failed_attempts >= 5 then now() + interval '15 minutes' else null end,
        updated_at = now()
    where member_id = v_member_id;
  return null;
end;
$$;
revoke all on function public.verify_library_card_reservation_pin(text, text) from public, anon, authenticated;

create function public.reserve_book_by_card(p_card_number text, p_pin text, p_book_id uuid)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare
  v_member_id uuid;
  v_reservation public.reservations%rowtype;
  v_queue_position bigint;
  v_created boolean := false;
begin
  perform public.lock_circulation();
  v_member_id := public.verify_library_card_reservation_pin(p_card_number, p_pin);
  if v_member_id is null then
    return jsonb_build_object('verified', false);
  end if;
  perform public.process_circulation();
  if not exists (select 1 from public.books where id = p_book_id) then
    raise exception 'Book not found';
  end if;
  if not exists (select 1 from public.book_copies where book_id = p_book_id) then
    raise exception 'The library has no physical copy of this title';
  end if;
  if exists (select 1 from public.book_copies where book_id = p_book_id and status = 'available') then
    raise exception 'A copy is available now; borrow it at the circulation desk';
  end if;
  if not exists (
    select 1 from public.book_copies
    where book_id = p_book_id and status in ('borrowed', 'overdue', 'reserved')
  ) then
    raise exception 'No copies of this title are currently circulating';
  end if;

  select * into v_reservation from public.reservations
    where book_id = p_book_id and member_id = v_member_id
      and status in ('waiting', 'ready_for_pickup')
    order by created_at, id limit 1;
  if not found then
    insert into public.reservations(book_id, member_id, status)
      values (p_book_id, v_member_id, 'waiting')
      on conflict (book_id, member_id) where status in ('waiting', 'ready_for_pickup') do nothing
      returning * into v_reservation;
    v_created := found;
    if not v_created then
      select * into v_reservation from public.reservations
        where book_id = p_book_id and member_id = v_member_id
          and status in ('waiting', 'ready_for_pickup')
        order by created_at, id limit 1;
    end if;
  end if;

  if v_reservation.status = 'waiting' then
    select count(*) into v_queue_position from public.reservations q
      where q.book_id = p_book_id and q.status = 'waiting'
        and (q.created_at, q.id) <= (v_reservation.created_at, v_reservation.id);
  end if;
  if v_created then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
      values (null, 'reserve', 'reservation', v_reservation.id,
        jsonb_build_object('member_id', v_member_id, 'source', 'card_pin'));
  end if;
  return jsonb_build_object(
    'verified', true,
    'reservation_id', v_reservation.id,
    'status', v_reservation.status,
    'queue_position', v_queue_position,
    'pickup_expires_at', v_reservation.pickup_expires_at
  );
end;
$$;
revoke all on function public.reserve_book_by_card(text, text, uuid) from public;
grant execute on function public.reserve_book_by_card(text, text, uuid) to anon, authenticated;

create function public.card_reservation_status(p_card_number text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_member_id uuid; v_reservations jsonb;
begin
  perform public.lock_circulation();
  v_member_id := public.verify_library_card_reservation_pin(p_card_number, p_pin);
  if v_member_id is null then
    return jsonb_build_object('verified', false);
  end if;
  perform public.process_circulation();
  select coalesce(jsonb_agg(jsonb_build_object(
      'reservation_id', r.id,
      'book_title', b.title,
      'author', b.author,
      'status', r.status,
      'queue_position', case when r.status = 'waiting' then (
        select count(*) from public.reservations q
        where q.book_id = r.book_id and q.status = 'waiting'
          and (q.created_at, q.id) <= (r.created_at, r.id)
      ) else null end,
      'created_at', r.created_at,
      'pickup_expires_at', r.pickup_expires_at
    ) order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v_reservations
    from public.reservations r
    join public.books b on b.id = r.book_id
    where r.member_id = v_member_id and r.status in ('waiting', 'ready_for_pickup');
  return jsonb_build_object('verified', true, 'reservations', v_reservations);
end;
$$;
revoke all on function public.card_reservation_status(text, text) from public;
grant execute on function public.card_reservation_status(text, text) to anon, authenticated;

create function public.cancel_card_reservation(p_card_number text, p_pin text, p_reservation_id uuid)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare
  v_member_id uuid;
  v_reservation public.reservations%rowtype;
begin
  perform public.lock_circulation();
  v_member_id := public.verify_library_card_reservation_pin(p_card_number, p_pin);
  if v_member_id is null then
    return jsonb_build_object('verified', false);
  end if;
  perform public.process_circulation();
  select * into v_reservation from public.reservations
    where id = p_reservation_id and member_id = v_member_id
      and status in ('waiting', 'ready_for_pickup')
    for update;
  if not found then raise exception 'Active reservation not found'; end if;

  update public.reservations set status = 'cancelled', updated_at = now()
    where id = v_reservation.id;
  update public.book_copies set status = 'available', updated_at = now()
    where id = v_reservation.copy_id and status = 'reserved';
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (null, 'cancel', 'reservation', v_reservation.id,
      jsonb_build_object('copy_id', v_reservation.copy_id, 'source', 'card_pin'));
  perform public.allocate_pickup_holds(v_reservation.book_id);
  return jsonb_build_object('verified', true);
end;
$$;
revoke all on function public.cancel_card_reservation(text, text, uuid) from public;
grant execute on function public.cancel_card_reservation(text, text, uuid) to anon, authenticated;

-- Accountless members read their own hold status through the card/PIN RPC. The
-- existing notification table is keyed to Auth profiles, so only linked users
-- receive in-app notifications when a pickup hold becomes ready.
create or replace function public.notify_reservation_ready()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_book_title text;
  v_auth_user_id uuid;
begin
  if new.status = 'ready_for_pickup'
    and (tg_op = 'INSERT' or old.status is distinct from new.status)
    and public.get_setting_bool('notifications_enabled', true) then
    select m.auth_user_id into v_auth_user_id
      from public.library_members m where m.id = new.member_id;
    if v_auth_user_id is not null then
      select b.title into v_book_title from public.books b where b.id = new.book_id;
      insert into public.notifications(member_id, title, message)
        values (v_auth_user_id, 'Reservation ready for pickup',
          format('%s is ready for pickup until %s.', coalesce(v_book_title, 'Your reserved book'),
            to_char(new.pickup_expires_at, 'YYYY-MM-DD')));
    end if;
  end if;
  return new;
end;
$$;

-- Keep staff and authenticated-member reservation rules aligned with the
-- accountless flow: holds are for copies that are out or already assigned.
create or replace function public.staff_reserve_book(p_book_id uuid, p_member_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare reservation_id uuid;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Staff access required';
  end if;
  perform public.process_circulation();
  if not exists (select 1 from public.library_members where id = p_member_id and is_active and library_card_number is not null) then
    raise exception 'Select an active member with a verified library card';
  end if;
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
  select id into reservation_id from public.reservations
    where book_id = p_book_id and member_id = p_member_id and status in ('waiting', 'ready_for_pickup')
    order by created_at, id limit 1;
  if reservation_id is not null then return reservation_id; end if;
  insert into public.reservations(book_id, member_id, status)
    values (p_book_id, p_member_id, 'waiting') returning id into reservation_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'reserve', 'reservation', reservation_id,
      jsonb_build_object('member_id', p_member_id, 'source', 'staff'));
  return reservation_id;
end;
$$;
revoke all on function public.staff_reserve_book(uuid, uuid) from public, anon;
grant execute on function public.staff_reserve_book(uuid, uuid) to authenticated;

create or replace function public.reserve_book(p_book_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare reservation_id uuid; linked_member_id uuid;
begin
  perform public.lock_circulation();
  if auth.uid() is null or public.current_user_role() is distinct from 'member' then
    raise exception 'Only authenticated Members can create reservations';
  end if;
  select id into linked_member_id from public.library_members
    where auth_user_id = auth.uid() and is_active and library_card_number is not null;
  if linked_member_id is null then raise exception 'Your account is not linked to an active library member with a verified card'; end if;
  perform public.process_circulation();
  if not exists (select 1 from public.books where id = p_book_id) then raise exception 'Book not found'; end if;
  if not exists (select 1 from public.book_copies where book_id = p_book_id) then
    raise exception 'This title has no physical copies; ask staff about an acquisition request';
  end if;
  if exists (select 1 from public.book_copies where book_id = p_book_id and status = 'available') then
    raise exception 'This book is currently available and does not need a reservation';
  end if;
  if not exists (select 1 from public.book_copies where book_id = p_book_id and status in ('borrowed', 'overdue', 'reserved')) then
    raise exception 'No copies of this title are currently circulating';
  end if;
  select id into reservation_id from public.reservations
    where book_id = p_book_id and member_id = linked_member_id and status in ('waiting', 'ready_for_pickup')
    order by created_at, id limit 1;
  if reservation_id is not null then return reservation_id; end if;
  insert into public.reservations(book_id, member_id, status)
    values (p_book_id, linked_member_id, 'waiting') returning id into reservation_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'reserve', 'reservation', reservation_id, '{}'::jsonb);
  return reservation_id;
end;
$$;
revoke all on function public.reserve_book(uuid) from public, anon;
grant execute on function public.reserve_book(uuid) to authenticated;
