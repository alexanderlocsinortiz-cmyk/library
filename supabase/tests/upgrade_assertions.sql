create function public.test_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end$$;
do $$
begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='books' and column_name='course_subject' and is_nullable='NO' and column_default is not null) then
    raise exception 'Course and subject catalog field was not installed';
  end if;
  if to_regclass('public.book_requests') is null or to_regclass('public.inventory_audits') is null or to_regclass('public.inventory_audit_items') is null then
    raise exception 'Interview request and inventory audit tables were not installed';
  end if;
  if to_regprocedure('public.record_book_request(text,text,text,uuid)') is null
     or to_regprocedure('public.update_book_request(uuid,text,text)') is null
     or to_regprocedure('public.start_inventory_audit()') is null
     or to_regprocedure('public.start_inventory_audit_for_shelf(text)') is null
     or to_regprocedure('public.scan_inventory_audit_copy(uuid,text,text)') is null
     or to_regprocedure('public.complete_inventory_audit(uuid)') is null then
    raise exception 'Interview request and inventory audit operations were not installed';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='inventory_audits' and column_name='location_scope') then
    raise exception 'Shelf-scoped inventory audit support was not installed';
  end if;
  if (select value from public.system_settings where key='loan_period_days') <> '3'::jsonb then
    raise exception 'Loan period was not migrated to the interview policy';
  end if;
  if not exists(select 1 from public.reservations where status='ready_for_pickup' and copy_id='10000000-0000-0000-0000-000000000001') then
    raise exception 'Legacy hold was not assigned';
  end if;
  if not exists(select 1 from public.book_copies where barcode='LEGACY-COPY' and status='reserved') then
    raise exception 'Legacy inventory was not reserved';
  end if;
  if not exists(select 1 from public.loans where status='returned' and fine_amount=6 and fine_daily_rate=2) then
    raise exception 'Legacy final fine was not reconciled';
  end if;
  if not exists(select 1 from public.profiles where school_id='OLD-123') then
    raise exception 'Legacy profile disappeared';
  end if;
  if not exists(select 1 from public.library_members where id='00000000-0000-0000-0000-000000000003' and auth_user_id is null and school_id='OLD-123') then
    raise exception 'Legacy profile was not preserved as an unlinked member record pending ownership verification';
  end if;
end;
$$;

-- Legacy accounts are not linked based on self-claimed School IDs. Staff can
-- link only after verifying the physical card and exact School ID match.
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_assert((select count(*)=0 from public.loans where member_id='00000000-0000-0000-0000-000000000003'),'unverified legacy account cannot read borrower history');
reset role;
update public.library_members set library_card_number='VERIFIED-OLD-123'
  where id='00000000-0000-0000-0000-000000000003';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.link_library_member_account('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000003');
reset role;
do $$begin
  if not exists(select 1 from public.library_members where id='00000000-0000-0000-0000-000000000003' and auth_user_id=id) then
    raise exception 'Staff could not link a verified legacy account';
  end if;
end;$$;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_assert((select count(*)=1 from public.loans where member_id='00000000-0000-0000-0000-000000000003'),'verified linked account regains only its own borrower history');
reset role;
