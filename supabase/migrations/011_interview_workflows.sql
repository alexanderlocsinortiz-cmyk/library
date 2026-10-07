-- Search by course/subject, record unmet demand, and reconcile digital
-- inventory against physical copies without automatically changing copy state.

alter table public.books
  add column course_subject text not null default ''
  check (length(course_subject) <= 200);

grant select (course_subject) on public.books to anon;
create index books_course_subject_search on public.books
  using gin (to_tsvector('simple', title || ' ' || author || ' ' || coalesce(category, '') || ' ' || course_subject));

create table public.book_requests (
  id uuid primary key default gen_random_uuid(),
  requested_title text not null check (length(btrim(requested_title)) between 1 and 200),
  requested_author text check (requested_author is null or length(requested_author) <= 200),
  course_subject text not null default '' check (length(course_subject) <= 200),
  member_id uuid references public.library_members(id) on delete set null,
  status text not null default 'new' check (status in ('new','reviewing','ordered','acquired','declined')),
  staff_notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index book_requests_status_created on public.book_requests(status, created_at desc);
create index book_requests_title_search on public.book_requests
  using gin (to_tsvector('simple', requested_title || ' ' || coalesce(requested_author, '') || ' ' || course_subject));
alter table public.book_requests enable row level security;
revoke all on public.book_requests from public, anon, authenticated;
grant select on public.book_requests to authenticated;
create policy "staff can view book requests" on public.book_requests for select to authenticated
  using (public.is_staff());

create function public.record_book_request(
  p_requested_title text,
  p_requested_author text default null,
  p_course_subject text default '',
  p_member_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare request_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  if p_requested_title is null or length(btrim(p_requested_title)) not between 1 and 200 then raise exception 'Enter a valid requested title'; end if;
  if p_requested_author is not null and length(btrim(p_requested_author)) > 200 then raise exception 'Requested author is too long'; end if;
  if p_course_subject is not null and length(btrim(p_course_subject)) > 200 then raise exception 'Course or subject is too long'; end if;
  if p_member_id is not null and not exists(select 1 from public.library_members where id=p_member_id and is_active) then
    raise exception 'Select an active library member or leave the requester blank';
  end if;

  insert into public.book_requests(requested_title, requested_author, course_subject, member_id, created_by)
    values(btrim(p_requested_title), nullif(btrim(p_requested_author), ''), coalesce(btrim(p_course_subject), ''), p_member_id, auth.uid())
    returning id into request_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values(auth.uid(), 'book_request_record', 'book_request', request_id,
      jsonb_build_object('title', btrim(p_requested_title), 'course_subject', coalesce(btrim(p_course_subject), '')));
  return request_id;
end;
$$;
revoke all on function public.record_book_request(text,text,text,uuid) from public, anon;
grant execute on function public.record_book_request(text,text,text,uuid) to authenticated;

create function public.update_book_request(p_request_id uuid, p_status text, p_staff_notes text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare request_row public.book_requests%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  if p_status is null or p_status not in ('new','reviewing','ordered','acquired','declined') then raise exception 'Invalid book request status'; end if;
  if p_staff_notes is not null and length(p_staff_notes) > 2000 then raise exception 'Staff notes are too long'; end if;
  select * into request_row from public.book_requests where id=p_request_id for update;
  if request_row.id is null then raise exception 'Book request not found'; end if;
  if request_row.status <> p_status and not (
    (request_row.status='new' and p_status in ('reviewing','ordered','acquired','declined')) or
    (request_row.status='reviewing' and p_status in ('ordered','acquired','declined')) or
    (request_row.status='ordered' and p_status='acquired')
  ) then raise exception 'Invalid book request transition'; end if;

  update public.book_requests set status=p_status, staff_notes=nullif(btrim(p_staff_notes), ''), updated_at=now(),
    closed_at=case when p_status in ('acquired','declined') then coalesce(closed_at,now()) else null end
    where id=p_request_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values(auth.uid(), 'book_request_update', 'book_request', p_request_id,
      jsonb_build_object('from',request_row.status,'to',p_status,
        'notes_changed',request_row.staff_notes is distinct from nullif(btrim(p_staff_notes),'')));
end;
$$;
revoke all on function public.update_book_request(uuid,text,text) from public, anon;
grant execute on function public.update_book_request(uuid,text,text) to authenticated;

create table public.inventory_audits (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  started_by uuid references public.profiles(id) on delete set null,
  completed_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);
create unique index one_open_inventory_audit on public.inventory_audits(status) where status='in_progress';
alter table public.inventory_audits enable row level security;
revoke all on public.inventory_audits from public, anon, authenticated;
grant select on public.inventory_audits to authenticated;
create policy "staff can view inventory audits" on public.inventory_audits for select to authenticated
  using (public.is_staff());

create table public.inventory_audit_items (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.inventory_audits(id) on delete cascade,
  copy_id uuid references public.book_copies(id) on delete set null,
  barcode text not null,
  title_snapshot text,
  expected_status text,
  expected_location text,
  observed_location text,
  status_matches boolean,
  location_matches boolean,
  result text not null default 'not_scanned'
    check (result in ('not_scanned','found','wrong_location','status_changed','multiple_mismatches','not_found','not_in_snapshot','unknown_barcode')),
  scanned_at timestamptz,
  unique(audit_id, barcode)
);
create index inventory_audit_items_audit_result on public.inventory_audit_items(audit_id, result);
alter table public.inventory_audit_items enable row level security;
revoke all on public.inventory_audit_items from public, anon, authenticated;
grant select on public.inventory_audit_items to authenticated;
create policy "staff can view inventory audit items" on public.inventory_audit_items for select to authenticated
  using (exists(select 1 from public.inventory_audits a where a.id=inventory_audit_items.audit_id and public.is_staff()));

create function public.start_inventory_audit() returns uuid
language plpgsql security definer set search_path = public as $$
declare v_audit_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  perform public.lock_circulation();
  insert into public.inventory_audits(started_by) values(auth.uid()) returning id into v_audit_id;
  insert into public.inventory_audit_items(audit_id, copy_id, barcode, title_snapshot, expected_status, expected_location)
    select v_audit_id, c.id, c.barcode, b.title, c.status::text, c.location
    from public.book_copies c join public.books b on b.id=c.book_id
    where c.status in ('available','reserved','maintenance','damaged');
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    select auth.uid(), 'inventory_audit_start', 'inventory_audit', v_audit_id,
      jsonb_build_object('expected_copies',count(*)) from public.inventory_audit_items where inventory_audit_items.audit_id=v_audit_id;
  return v_audit_id;
end;
$$;
revoke all on function public.start_inventory_audit() from public, anon;
grant execute on function public.start_inventory_audit() to authenticated;

create function public.scan_inventory_audit_copy(p_audit_id uuid, p_barcode text, p_observed_location text)
returns text
language plpgsql security definer set search_path = public as $$
declare audit_row public.inventory_audits%rowtype; item_row public.inventory_audit_items%rowtype;
  copy_row public.book_copies%rowtype; result_value text; matches_status boolean; matches_location boolean;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  if p_barcode is null or length(btrim(p_barcode)) not between 1 and 100 then raise exception 'Scan a valid barcode'; end if;
  if p_observed_location is null or length(btrim(p_observed_location)) not between 1 and 100 then raise exception 'Enter the shelf or location being checked'; end if;
  perform public.lock_circulation();
  select * into audit_row from public.inventory_audits where id=p_audit_id for update;
  if audit_row.id is null or audit_row.status<>'in_progress' then raise exception 'Inventory audit is not open'; end if;
  select * into item_row from public.inventory_audit_items where audit_id=p_audit_id and barcode=btrim(p_barcode) for update;
  if item_row.scanned_at is not null then raise exception 'This barcode was already scanned in this audit'; end if;
  select * into copy_row from public.book_copies where barcode=btrim(p_barcode);

  if item_row.id is null then
    if copy_row.id is null then
      insert into public.inventory_audit_items(audit_id,barcode,observed_location,result,scanned_at)
        values(p_audit_id,btrim(p_barcode),btrim(p_observed_location),'unknown_barcode',now());
      result_value := 'unknown_barcode';
    else
      insert into public.inventory_audit_items(audit_id,copy_id,barcode,title_snapshot,expected_status,expected_location,observed_location,result,scanned_at)
        select p_audit_id,copy_row.id,copy_row.barcode,b.title,copy_row.status::text,copy_row.location,btrim(p_observed_location),'not_in_snapshot',now()
        from public.books b where b.id=copy_row.book_id;
      result_value := 'not_in_snapshot';
    end if;
  else
    matches_status := copy_row.id is not null and copy_row.status::text=item_row.expected_status;
    matches_location := copy_row.id is not null and lower(btrim(coalesce(item_row.expected_location,'')))=lower(btrim(p_observed_location));
    result_value := case when copy_row.id is null then 'not_found'
      when matches_status and matches_location then 'found'
      when not matches_status and not matches_location then 'multiple_mismatches'
      when not matches_location then 'wrong_location' else 'status_changed' end;
    update public.inventory_audit_items set observed_location=btrim(p_observed_location), status_matches=matches_status,
      location_matches=matches_location, result=result_value, scanned_at=now() where id=item_row.id;
  end if;
  return result_value;
end;
$$;
revoke all on function public.scan_inventory_audit_copy(uuid,text,text) from public, anon;
grant execute on function public.scan_inventory_audit_copy(uuid,text,text) to authenticated;

create function public.complete_inventory_audit(p_audit_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare audit_row public.inventory_audits%rowtype; result_summary jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then raise exception 'Staff access required'; end if;
  perform public.lock_circulation();
  select * into audit_row from public.inventory_audits where id=p_audit_id for update;
  if audit_row.id is null or audit_row.status<>'in_progress' then raise exception 'Inventory audit is not open'; end if;

  update public.inventory_audit_items i set result=case
      when c.id is null then 'not_found'
      when c.status::text=snapshot.expected_status then 'not_found'
      else 'status_changed' end
    from public.inventory_audit_items snapshot
    left join public.book_copies c on c.id=snapshot.copy_id
    where i.id=snapshot.id and snapshot.audit_id=p_audit_id and snapshot.result='not_scanned'
      and snapshot.expected_status is not null;

  select jsonb_build_object(
    'expected_copies',count(*) filter(where expected_status is not null),
    'found',count(*) filter(where result='found'),
    'wrong_location',count(*) filter(where result='wrong_location'),
    'status_changed',count(*) filter(where result='status_changed'),
    'multiple_mismatches',count(*) filter(where result='multiple_mismatches'),
    'not_found',count(*) filter(where result='not_found'),
    'not_in_snapshot',count(*) filter(where result='not_in_snapshot'),
    'unknown_barcode',count(*) filter(where result='unknown_barcode')
  ) into result_summary from public.inventory_audit_items where audit_id=p_audit_id;

  update public.inventory_audits set status='completed', completed_by=auth.uid(), completed_at=now(), summary=result_summary where id=p_audit_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values(auth.uid(), 'inventory_audit_complete', 'inventory_audit', p_audit_id, result_summary);
  return result_summary;
end;
$$;
revoke all on function public.complete_inventory_audit(uuid) from public, anon;
grant execute on function public.complete_inventory_audit(uuid) to authenticated;
