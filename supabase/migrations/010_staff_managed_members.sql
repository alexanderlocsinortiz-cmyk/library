-- Borrowers are library records. An Auth account is an optional link, not the
-- identity required to check out a physical book at the circulation desk.
create table public.library_members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(btrim(full_name)) between 1 and 160),
  library_card_number text,
  school_id text,
  member_type text not null default 'other' check (member_type in ('student','teacher','other')),
  is_active boolean not null default true,
  auth_user_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep legacy foreign keys valid, but don't invent physical card numbers. Staff
-- must verify and record each real card before that patron can check out books.
insert into public.library_members (id, full_name, school_id, member_type, auth_user_id, created_at, updated_at)
select p.id, coalesce(nullif(btrim(p.full_name), ''), 'Unnamed member'), p.school_id, 'other',
  case when p.school_id is not null and exists (
    select 1 from public.school_id_invitations i
    where lower(i.school_id)=lower(p.school_id) and i.purpose='signup' and i.consumed_at is not null
  ) then p.id else null end,
  p.created_at, p.updated_at
from public.profiles p
where p.role='member'
  or exists(select 1 from public.loans l where l.member_id=p.id)
  or exists(select 1 from public.reservations r where r.member_id=p.id)
on conflict (id) do nothing;

create unique index library_members_card_unique on public.library_members (lower(library_card_number))
  where library_card_number is not null;
create unique index library_members_school_id_unique on public.library_members (lower(school_id))
  where school_id is not null;
create unique index library_members_auth_user_unique on public.library_members (auth_user_id)
  where auth_user_id is not null;
create index library_members_name_search on public.library_members using gin (to_tsvector('simple', full_name));

alter table public.reservations drop constraint reservations_member_id_fkey;
alter table public.reservations add constraint reservations_member_id_fkey
  foreign key (member_id) references public.library_members(id) on delete restrict;
alter table public.loans drop constraint loans_member_id_fkey;
alter table public.loans add constraint loans_member_id_fkey
  foreign key (member_id) references public.library_members(id) on delete restrict;

alter table public.library_members enable row level security;
revoke all on public.library_members from anon, authenticated;
grant select on public.library_members to authenticated;
create policy "staff can view library members" on public.library_members for select to authenticated
  using (public.is_staff());
create policy "members can view their linked record" on public.library_members for select to authenticated
  using (auth_user_id = auth.uid());

drop policy if exists "members can view their reservations" on public.reservations;
create policy "members can view their reservations" on public.reservations for select to authenticated
  using (public.is_staff() or exists (
    select 1 from public.library_members m where m.id = member_id and m.auth_user_id = auth.uid()
  ));
drop policy if exists "members can view their loans" on public.loans;
create policy "members can view their loans" on public.loans for select to authenticated
  using (public.is_staff() or exists (
    select 1 from public.library_members m where m.id = member_id and m.auth_user_id = auth.uid()
  ));

-- Public catalog browsing exposes title metadata, copy status and shelf
-- location only. Internal copy condition, IDs and barcodes remain staff-only.
drop policy if exists "public can browse books" on public.books;
create policy "public can browse books" on public.books for select to anon using (true);
drop policy if exists "public can browse copy availability" on public.book_copies;
create policy "public can browse copy availability" on public.book_copies for select to anon using (true);
revoke all on public.books, public.book_copies from public, anon;
grant select on public.books, public.book_copies to authenticated, service_role;
grant select (id, title, author, isbn, category, description, publication_year, cover_url, created_at, updated_at)
  on public.books to anon;
grant select (id, book_id, status, location) on public.book_copies to anon;

create function public.register_library_member(
  p_full_name text,
  p_library_card_number text,
  p_school_id text default null,
  p_member_type text default 'student'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare member_id uuid; linked_user_id uuid; normalized_school_id text;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  if p_full_name is null or length(btrim(p_full_name)) not between 1 and 160 then raise exception 'Enter a valid member name'; end if;
  if p_library_card_number is null or length(btrim(p_library_card_number)) not between 1 and 100 then raise exception 'A verified library card number is required'; end if;
  if p_member_type not in ('student','teacher','other') then raise exception 'Invalid member type'; end if;
  normalized_school_id := nullif(upper(btrim(p_school_id)), '');
  if normalized_school_id is not null and length(normalized_school_id) > 100 then raise exception 'School ID is too long'; end if;

  if normalized_school_id is not null then
    select p.id into linked_user_id from public.profiles p
      where lower(p.school_id)=lower(normalized_school_id) and p.role='member'
        and exists(select 1 from public.school_id_invitations i where lower(i.school_id)=lower(p.school_id)
          and i.purpose='signup' and i.consumed_at is not null);
  end if;
  insert into public.library_members (full_name, library_card_number, school_id, member_type, auth_user_id, created_by)
  values (btrim(p_full_name), upper(btrim(p_library_card_number)), normalized_school_id, p_member_type, linked_user_id, auth.uid())
  returning id into member_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(auth.uid(), 'member_register', 'library_member', member_id,
    jsonb_build_object('library_card_number', upper(btrim(p_library_card_number)), 'member_type', p_member_type));
  return member_id;
end;
$$;
revoke all on function public.register_library_member(text,text,text,text) from public, anon;
grant execute on function public.register_library_member(text,text,text,text) to authenticated;

create function public.update_library_member(
  p_member_id uuid,
  p_full_name text,
  p_library_card_number text,
  p_school_id text,
  p_member_type text,
  p_is_active boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare member_row public.library_members%rowtype; linked_user_id uuid; normalized_school_id text;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  select * into member_row from public.library_members where id = p_member_id for update;
  if member_row.id is null then raise exception 'Library member not found'; end if;
  if p_full_name is null or length(btrim(p_full_name)) not between 1 and 160 then raise exception 'Enter a valid member name'; end if;
  if p_library_card_number is not null and length(btrim(p_library_card_number)) > 100 then raise exception 'Library card number is too long'; end if;
  if p_member_type not in ('student','teacher','other') then raise exception 'Invalid member type'; end if;
  if p_is_active is null then raise exception 'Member status is required'; end if;
  normalized_school_id := nullif(upper(btrim(p_school_id)), '');
  if normalized_school_id is not null and length(normalized_school_id) > 100 then raise exception 'School ID is too long'; end if;

  if not p_is_active and member_row.is_active and (
    exists(select 1 from public.loans where member_id=p_member_id and status in ('borrowed','overdue')) or
    exists(select 1 from public.reservations where member_id=p_member_id and status in ('waiting','ready_for_pickup'))
  ) then raise exception 'Resolve active loans and reservations before deactivating this member'; end if;

  if normalized_school_id is not null then
    select p.id into linked_user_id from public.profiles p
      where lower(p.school_id)=lower(normalized_school_id) and p.role='member'
        and exists(select 1 from public.school_id_invitations i where lower(i.school_id)=lower(p.school_id)
          and i.purpose='signup' and i.consumed_at is not null);
    if linked_user_id is not null and exists (
      select 1 from public.library_members where auth_user_id=linked_user_id and id<>p_member_id
    ) then raise exception 'That school account is already linked to another library member'; end if;
    if linked_user_id is not null and member_row.auth_user_id is not null and linked_user_id<>member_row.auth_user_id then
      raise exception 'That school ID belongs to a different linked account';
    end if;
  end if;

  update public.library_members set
    full_name=btrim(p_full_name),
    library_card_number=nullif(upper(btrim(p_library_card_number)),''),
    school_id=normalized_school_id,
    member_type=p_member_type,
    is_active=p_is_active,
    auth_user_id=coalesce(member_row.auth_user_id, linked_user_id),
    updated_at=now()
  where id=p_member_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(auth.uid(), 'member_update', 'library_member', p_member_id,
    jsonb_build_object('is_active', p_is_active, 'member_type', p_member_type));
end;
$$;
revoke all on function public.update_library_member(uuid,text,text,text,text,boolean) from public, anon;
grant execute on function public.update_library_member(uuid,text,text,text,text,boolean) to authenticated;

create function public.link_library_member_account(p_member_id uuid,p_profile_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare member_row public.library_members%rowtype; profile_school_id text;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception 'Staff access required'; end if;
  select * into member_row from public.library_members where id=p_member_id for update;
  if member_row.id is null then raise exception 'Library member not found'; end if;
  if not member_row.is_active or member_row.library_card_number is null then
    raise exception 'An active member with a verified library card is required';
  end if;
  select school_id into profile_school_id from public.profiles where id=p_profile_id and role='member' for update;
  if not found then raise exception 'Member account not found'; end if;
  if member_row.school_id is null or profile_school_id is null or lower(member_row.school_id)<>lower(profile_school_id) then
    raise exception 'The verified School IDs do not match';
  end if;
  if exists(select 1 from public.library_members where auth_user_id=p_profile_id and id<>p_member_id) then
    raise exception 'That account is already linked to another library member';
  end if;
  if member_row.auth_user_id is not null and member_row.auth_user_id<>p_profile_id then
    raise exception 'This library member already has a linked account';
  end if;
  update public.library_members set auth_user_id=p_profile_id,updated_at=now() where id=p_member_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'member_account_link','library_member',p_member_id,jsonb_build_object('profile_id',p_profile_id));
end;
$$;
revoke all on function public.link_library_member_account(uuid,uuid) from public,anon;
grant execute on function public.link_library_member_account(uuid,uuid) to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare invitation public.school_id_invitations%rowtype; matched_member_id uuid; school text;
begin
  school := new.raw_app_meta_data ->> 'school_id';
  if school is not null then
    update public.school_id_invitations set consumed_at=now()
      where token_hash=encode(sha256(convert_to(new.raw_app_meta_data ->> 'school_invitation','UTF8')),'hex')
        and school_id=school and purpose='signup' and consumed_at is null and expires_at>now()
      returning * into invitation;
    if invitation.token_hash is null then raise exception 'Valid staff invitation required'; end if;
  elsif new.raw_user_meta_data ? 'school_id' then
    raise exception 'School identities require a staff invitation';
  end if;
  insert into public.profiles (id, full_name, school_id)
  values (new.id, coalesce(invitation.full_name,new.raw_user_meta_data ->> 'full_name'), school);
  if school is not null then
    select id into matched_member_id from public.library_members
      where lower(school_id)=lower(school) for update;
    if matched_member_id is not null then
      update public.library_members set auth_user_id=new.id, updated_at=now()
        where id=matched_member_id and (auth_user_id is null or auth_user_id=new.id);
      if not found then raise exception 'This library member is already linked to an account'; end if;
    end if;
    update auth.users set raw_app_meta_data=raw_app_meta_data-'school_invitation' where id=new.id;
  end if;
  return new;
end;
$$;

create function public.staff_reserve_book(p_book_id uuid, p_member_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare reservation_id uuid;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception 'Staff access required'; end if;
  perform public.process_circulation();
  if not exists(select 1 from public.library_members where id=p_member_id and is_active and library_card_number is not null) then
    raise exception 'Select an active member with a verified library card';
  end if;
  if not exists(select 1 from public.books where id=p_book_id) then raise exception 'Book not found'; end if;
  if not exists(select 1 from public.book_copies where book_id=p_book_id) then
    raise exception 'This title has no physical copies; record an acquisition request instead';
  end if;
  if exists(select 1 from public.book_copies where book_id=p_book_id and status='available') then
    raise exception 'This title has an available copy; check it out at the desk instead';
  end if;
  select id into reservation_id from public.reservations
    where book_id=p_book_id and member_id=p_member_id and status in ('waiting','ready_for_pickup') limit 1;
  if reservation_id is not null then return reservation_id; end if;
  begin
    insert into public.reservations(book_id,member_id,status) values(p_book_id,p_member_id,'waiting') returning id into reservation_id;
  exception when unique_violation then
    select id into reservation_id from public.reservations
      where book_id=p_book_id and member_id=p_member_id and status in ('waiting','ready_for_pickup') limit 1;
    return reservation_id;
  end;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'reserve','reservation',reservation_id,jsonb_build_object('member_id',p_member_id,'source','staff'));
  return reservation_id;
end;
$$;
revoke all on function public.staff_reserve_book(uuid,uuid) from public, anon;
grant execute on function public.staff_reserve_book(uuid,uuid) to authenticated;

create or replace function public.reserve_book(p_book_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare reservation_id uuid; linked_member_id uuid;
begin
  perform public.lock_circulation();
  if auth.uid() is null or public.current_user_role() is distinct from 'member' then
    raise exception 'Only authenticated Members can create reservations';
  end if;
  select id into linked_member_id from public.library_members
    where auth_user_id=auth.uid() and is_active and library_card_number is not null;
  if linked_member_id is null then raise exception 'Your account is not linked to an active library member with a verified card'; end if;
  perform public.process_circulation();
  if not exists(select 1 from public.books where id=p_book_id) then raise exception 'Book not found'; end if;
  if not exists(select 1 from public.book_copies where book_id=p_book_id) then
    raise exception 'This title has no physical copies; ask staff about an acquisition request';
  end if;
  if exists(select 1 from public.book_copies where book_id=p_book_id and status='available') then
    raise exception 'This book is currently available and does not need a reservation';
  end if;
  select id into reservation_id from public.reservations
    where book_id=p_book_id and member_id=linked_member_id and status in ('waiting','ready_for_pickup') limit 1;
  if reservation_id is not null then return reservation_id; end if;
  begin
    insert into public.reservations(book_id,member_id,status) values(p_book_id,linked_member_id,'waiting') returning id into reservation_id;
  exception when unique_violation then
    select id into reservation_id from public.reservations
      where book_id=p_book_id and member_id=linked_member_id and status in ('waiting','ready_for_pickup') limit 1;
    return reservation_id;
  end;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(auth.uid(),'reserve','reservation',reservation_id);
  return reservation_id;
end;
$$;

create or replace function public.cancel_reservation(p_reservation_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reservations%rowtype; linked_user_id uuid;
begin
  perform public.lock_circulation();
  select * into r from public.reservations where id=p_reservation_id for update;
  if r.id is null then raise exception 'Reservation not found'; end if;
  select auth_user_id into linked_user_id from public.library_members where id=r.member_id;
  if auth.uid() is null or (linked_user_id is distinct from auth.uid() and not coalesce(public.is_staff(),false)) then
    raise exception 'Not allowed to cancel this reservation';
  end if;
  if r.status not in ('waiting','ready_for_pickup') then raise exception 'Reservation is not active'; end if;
  update public.reservations set status='cancelled',updated_at=now() where id=r.id;
  update public.book_copies set status='available',updated_at=now() where id=r.copy_id and status='reserved';
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'cancel','reservation',r.id,jsonb_build_object('copy_id',r.copy_id));
  perform public.allocate_pickup_holds(r.book_id);
end;
$$;

create or replace function public.checkout_copy(p_copy_id uuid,p_member_id uuid,p_due_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare loan_id uuid; copy_book_id uuid; current_status public.copy_status; active_loan_count integer;
  ready_reservation_id uuid; ready_reservation_member_id uuid; resolved_due_at timestamptz;
begin
  perform public.lock_circulation();
  if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception 'Only Librarians and Administrators can check out books'; end if;
  perform public.process_circulation();
  if not exists(select 1 from public.library_members where id=p_member_id and is_active and library_card_number is not null) then
    raise exception 'The selected borrower must be active and have a verified library card';
  end if;
  select book_id,status into copy_book_id,current_status from public.book_copies where id=p_copy_id for update;
  if copy_book_id is null then raise exception 'Book copy not found'; end if;
  if current_status not in ('available','reserved') then raise exception 'Book copy is not available'; end if;
  select id,member_id into ready_reservation_id,ready_reservation_member_id from public.reservations
    where copy_id=p_copy_id and status='ready_for_pickup' order by created_at asc limit 1 for update;
  if ready_reservation_id is not null and ready_reservation_member_id<>p_member_id then raise exception 'This copy is held for the next reservation'; end if;
  if current_status='reserved' and ready_reservation_id is null then raise exception 'Copy has no valid pickup assignment'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text,0));
  select count(*) into active_loan_count from public.loans where member_id=p_member_id and status in ('borrowed','overdue');
  if active_loan_count>=public.get_setting_int('max_active_loans',5) then raise exception 'This Member has reached the active loan limit'; end if;
  resolved_due_at:=coalesce(p_due_at,now()+make_interval(days=>public.get_setting_int('loan_period_days',3)));
  if resolved_due_at<=now() then raise exception 'The due date must be in the future'; end if;
  if resolved_due_at>now()+make_interval(days=>public.get_setting_int('loan_period_days',3))+interval '1 minute' then
    raise exception 'The due date exceeds the configured loan period';
  end if;
  insert into public.loans(copy_id,member_id,checked_out_by,due_at,status)
    values(p_copy_id,p_member_id,auth.uid(),resolved_due_at,'borrowed') returning id into loan_id;
  update public.book_copies set status='borrowed',updated_at=now() where id=p_copy_id;
  if ready_reservation_id is not null then update public.reservations set status='completed',updated_at=now() where id=ready_reservation_id; end if;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'checkout','loan',loan_id,jsonb_build_object('copy_id',p_copy_id,'member_id',p_member_id));
  return loan_id;
end;
$$;

create or replace function public.renew_loan(p_loan_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare current_loan public.loans%rowtype; actor_role public.app_role; next_due_at timestamptz;
begin
  perform public.lock_circulation();
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  actor_role:=public.current_user_role();
  select * into current_loan from public.loans where id=p_loan_id for update;
  if current_loan.id is null then raise exception 'Loan not found'; end if;
  if coalesce(actor_role::text,'') not in ('librarian','administrator') and not exists(
    select 1 from public.library_members where id=current_loan.member_id and auth_user_id=auth.uid()
  ) then raise exception 'You are not allowed to renew this loan'; end if;
  if current_loan.status<>'borrowed' then raise exception 'Only active loans can be renewed'; end if;
  if current_loan.due_at is null then raise exception 'This loan has no due date'; end if;
  if current_loan.due_at<=now() then raise exception 'Overdue loans cannot be renewed'; end if;
  if current_loan.renewal_count>=public.get_setting_int('max_renewals',1) then raise exception 'This loan has reached the renewal limit'; end if;
  if exists(select 1 from public.reservations r join public.book_copies c on c.book_id=r.book_id
    where c.id=current_loan.copy_id and r.status in ('waiting','ready_for_pickup')) then raise exception 'This title has a reservation queue'; end if;
  next_due_at:=greatest(current_loan.due_at,now())+make_interval(days=>public.get_setting_int('loan_period_days',3));
  update public.loans set due_at=next_due_at,renewal_count=renewal_count+1,last_renewed_at=now() where id=p_loan_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'renew','loan',p_loan_id,jsonb_build_object('due_at',next_due_at));
  return p_loan_id;
end;
$$;

create or replace function public.process_circulation() returns void
language plpgsql security definer set search_path = public as $$
declare r record; b uuid; notification_user_id uuid;
begin
  perform public.lock_circulation();
  with changed as (
    update public.loans set status='overdue' where status='borrowed' and due_at<now()
    returning member_id,fine_amount
  ) insert into public.notifications(member_id,title,message)
    select m.auth_user_id,'Book overdue',format('A borrowed book is overdue. Current fine: %s.',changed.fine_amount)
    from changed join public.library_members m on m.id=changed.member_id
    where m.auth_user_id is not null and public.get_setting_bool('notifications_enabled',true);
  update public.loans set fine_amount=fine_amount where status='overdue';
  update public.book_copies c set status='overdue',updated_at=now()
    from public.loans l where l.copy_id=c.id and l.status='overdue' and c.status='borrowed';
  for r in select * from public.reservations where status='ready_for_pickup' and pickup_expires_at<=now() for update loop
    update public.reservations set status='expired',updated_at=now() where id=r.id;
    update public.book_copies set status='available',updated_at=now() where id=r.copy_id and status='reserved';
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
      values(auth.uid(),'expired','reservation',r.id,jsonb_build_object('copy_id',r.copy_id));
    select auth_user_id into notification_user_id from public.library_members where id=r.member_id;
    if notification_user_id is not null and public.get_setting_bool('notifications_enabled',true) then
      insert into public.notifications(member_id,title,message)
        values(notification_user_id,'Reservation expired','Your pickup deadline passed. The copy has been released.');
    end if;
  end loop;
  for b in select distinct book_id from public.reservations where status='waiting' loop
    perform public.allocate_pickup_holds(b);
  end loop;
  insert into public.circulation_job_health(singleton,last_success_at) values(true,now())
    on conflict(singleton) do update set last_success_at=excluded.last_success_at;
end;
$$;
revoke all on function public.process_circulation() from public,anon,authenticated;
grant execute on function public.process_circulation() to service_role;

create or replace function public.my_reservation_positions() returns table(id uuid,queue_position bigint)
language sql stable security definer set search_path = public as $$
  select r.id,(select count(*) from public.reservations q where q.book_id=r.book_id and q.status='waiting'
    and (q.created_at,q.id)<=(r.created_at,r.id))
  from public.reservations r join public.library_members m on m.id=r.member_id
  where m.auth_user_id=auth.uid() and r.status='waiting';
$$;
revoke all on function public.my_reservation_positions() from public,anon;
grant execute on function public.my_reservation_positions() to authenticated;

create or replace function public.transaction_history(p_query text default '',p_page integer default 0,p_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not coalesce(public.is_staff(),false) then raise exception 'Staff access required'; end if;
  if p_page is null or p_page<0 or p_page>1000000 or p_size is null or p_size not between 1 and 100 or length(p_query)>200 then raise exception 'Invalid page'; end if;
  with history as (
    select a.id,a.created_at,a.action,a.entity_type,a.entity_id,a.details,
      m.full_name as member_name,m.school_id,m.library_card_number,b.title,c.barcode,actor.full_name as actor_name
    from public.audit_logs a
    left join public.loans l on a.entity_type='loan' and l.id=a.entity_id
    left join public.reservations r on a.entity_type='reservation' and r.id=a.entity_id
    left join public.book_copies c on c.id=coalesce(l.copy_id,r.copy_id)
    left join public.books b on b.id=coalesce(c.book_id,r.book_id)
    left join public.library_members m on m.id=coalesce(l.member_id,r.member_id)
    left join public.profiles actor on actor.id=a.actor_id
  ), filtered as (
    select * from history where strpos(lower(concat_ws(' ',action,member_name,school_id,library_card_number,title,barcode,entity_id::text)),lower(coalesce(p_query,'')))>0
  ) select jsonb_build_object('total',(select count(*) from filtered),'items',coalesce((
    select jsonb_agg(to_jsonb(page) order by created_at desc,id desc)
    from (select * from filtered order by created_at desc,id desc limit p_size offset p_page*p_size) page
  ),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.transaction_history(text,integer,integer) from public,anon;
grant execute on function public.transaction_history(text,integer,integer) to authenticated;

create or replace function public.change_member_role(p_member_id uuid,p_role public.app_role) returns void
language plpgsql security definer set search_path = public as $$
declare old_role public.app_role; library_member_id uuid;
begin
  perform public.lock_circulation();
  if not coalesce(public.is_admin(),false) then raise exception 'Administrator access required'; end if;
  if p_role is null then raise exception 'Role is required'; end if;
  select role into old_role from public.profiles where id=p_member_id for update;
  if old_role is null then raise exception 'Profile not found'; end if;
  if old_role='administrator' and p_role<>'administrator' and (select count(*) from public.profiles where role='administrator')<=1 then
    raise exception 'Cannot demote the last administrator';
  end if;
  select id into library_member_id from public.library_members where auth_user_id=p_member_id;
  if old_role='member' and p_role<>'member' and library_member_id is not null and (
    exists(select 1 from public.loans where member_id=library_member_id and status in ('borrowed','overdue')) or
    exists(select 1 from public.reservations where member_id=library_member_id and status in ('waiting','ready_for_pickup'))
  ) then raise exception 'Resolve active loans and reservations before changing this role'; end if;
  update public.profiles set role=p_role,updated_at=now() where id=p_member_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'role_change','profile',p_member_id,jsonb_build_object('from',old_role,'to',p_role));
end;
$$;
revoke all on function public.change_member_role(uuid,public.app_role) from public,anon;
grant execute on function public.change_member_role(uuid,public.app_role) to authenticated;
