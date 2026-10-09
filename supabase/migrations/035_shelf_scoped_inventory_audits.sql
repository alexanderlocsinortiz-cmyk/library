-- Let staff audit one shelf at a time while retaining a full inventory
-- snapshot so scanning a copy found on the wrong shelf is still flagged.
alter table public.inventory_audits
  add column location_scope text;

create function public.start_inventory_audit_for_shelf(p_location text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_audit_id uuid; v_location text;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Staff access required';
  end if;
  v_location := nullif(btrim(p_location), '');
  if v_location is null or length(v_location) > 100 or not (
    v_location in ('Filipiniana', 'Thesis', 'General Circulation', 'Fiction')
    or exists(select 1 from public.book_copies where btrim(location)=v_location)
  ) then
    raise exception 'Choose a valid shelf';
  end if;

  perform public.lock_circulation();
  insert into public.inventory_audits(started_by, location_scope)
    values(auth.uid(), v_location) returning id into v_audit_id;
  insert into public.inventory_audit_items(audit_id, copy_id, barcode, title_snapshot, expected_status, expected_location)
    select v_audit_id, c.id, c.barcode, b.title, c.status::text, c.location
    from public.book_copies c join public.books b on b.id=c.book_id
    where c.status in ('available','reserved','maintenance','damaged');
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    select auth.uid(), 'inventory_audit_start', 'inventory_audit', v_audit_id,
      jsonb_build_object('expected_copies', count(*) filter(where btrim(expected_location)=v_location), 'location_scope', v_location)
    from public.inventory_audit_items where inventory_audit_items.audit_id=v_audit_id;
  return v_audit_id;
end;
$$;
revoke all on function public.start_inventory_audit_for_shelf(text) from public, anon;
grant execute on function public.start_inventory_audit_for_shelf(text) to authenticated;

create or replace function public.complete_inventory_audit(p_audit_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare audit_row public.inventory_audits%rowtype; result_summary jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception 'Staff access required';
  end if;
  perform public.lock_circulation();
  select * into audit_row from public.inventory_audits where id=p_audit_id for update;
  if audit_row.id is null or audit_row.status<>'in_progress' then
    raise exception 'Inventory audit is not open';
  end if;

  update public.inventory_audit_items i set result=case
      when c.id is null then 'not_found'
      when c.status::text=snapshot.expected_status then 'not_found'
      else 'status_changed' end
    from public.inventory_audit_items snapshot
    left join public.book_copies c on c.id=snapshot.copy_id
    where i.id=snapshot.id and snapshot.audit_id=p_audit_id and snapshot.result='not_scanned'
      and snapshot.expected_status is not null
      and (audit_row.location_scope is null or btrim(snapshot.expected_location)=audit_row.location_scope);

  select jsonb_build_object(
    'expected_copies',count(*) filter(where expected_status is not null and (audit_row.location_scope is null or btrim(expected_location)=audit_row.location_scope)),
    'found',count(*) filter(where result='found'),
    'wrong_location',count(*) filter(where result='wrong_location'),
    'status_changed',count(*) filter(where result='status_changed'),
    'multiple_mismatches',count(*) filter(where result='multiple_mismatches'),
    'not_found',count(*) filter(where result='not_found'),
    'not_in_snapshot',count(*) filter(where result='not_in_snapshot'),
    'unknown_barcode',count(*) filter(where result='unknown_barcode')
  ) into result_summary
  from public.inventory_audit_items where audit_id=p_audit_id;

  update public.inventory_audits set status='completed', completed_by=auth.uid(), completed_at=now(), summary=result_summary where id=p_audit_id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values(auth.uid(), 'inventory_audit_complete', 'inventory_audit', p_audit_id, result_summary);
  return result_summary;
end;
$$;
revoke all on function public.complete_inventory_audit(uuid) from public, anon;
grant execute on function public.complete_inventory_audit(uuid) to authenticated;

notify pgrst, 'reload schema';
