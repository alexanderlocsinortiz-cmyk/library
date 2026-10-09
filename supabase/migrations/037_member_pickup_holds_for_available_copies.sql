-- Members may request a pickup hold when a usable copy is on the shelf.
-- The shared allocator assigns copies in FIFO order, so an older waiter keeps
-- priority and only the next borrower receives the copy immediately.
create or replace function public.reserve_book(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  reservation_id uuid;
  linked_member_id uuid;
  verified_email text;
begin
  perform public.lock_circulation();
  if auth.uid() is null or public.current_user_role() is distinct from 'member' then
    raise exception 'Only authenticated Members can create reservations';
  end if;

  select lower(btrim(email)) into verified_email
  from auth.users
  where id = auth.uid() and email_confirmed_at is not null;
  if verified_email is null then
    raise exception 'Confirm your email before placing an online hold';
  end if;

  select id into linked_member_id
  from public.library_members
  where auth_user_id = auth.uid() and is_active;
  if linked_member_id is null then raise exception 'Your member account is inactive'; end if;

  perform public.process_circulation();
  perform public.assert_reservation_book_eligible(p_book_id);

  select id into reservation_id
  from public.reservations
  where book_id = p_book_id
    and member_id = linked_member_id
    and status in ('waiting', 'ready_for_pickup')
  order by created_at, id
  limit 1;
  if reservation_id is not null then return reservation_id; end if;

  begin
    insert into public.reservations (book_id, member_id, status, email_address)
    values (p_book_id, linked_member_id, 'waiting', verified_email)
    returning id into reservation_id;
  exception when unique_violation then
    select id into reservation_id
    from public.reservations
    where book_id = p_book_id
      and member_id = linked_member_id
      and status in ('waiting', 'ready_for_pickup')
    order by created_at, id
    limit 1;
    return reservation_id;
  end;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id)
  values (auth.uid(), 'reserve', 'reservation', reservation_id);

  perform public.allocate_pickup_holds(p_book_id);
  return reservation_id;
end;
$$;
revoke all on function public.reserve_book(uuid) from public, anon;
grant execute on function public.reserve_book(uuid) to authenticated;

-- Keep an open catalog's availability counts current after pickup holds claim
-- copies. Existing row-level policies continue to control which rows clients see.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'book_copies'
    ) then
    alter publication supabase_realtime add table public.book_copies;
  end if;
end;
$$;

notify pgrst, 'reload schema';
