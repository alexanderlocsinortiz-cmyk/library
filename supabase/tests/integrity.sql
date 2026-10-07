\set ON_ERROR_STOP on
create function public.test_assert(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end$$;
create function public.test_denied(command text, expected text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if position(expected in sqlerrm) = 0 then raise exception 'Wrong error for %: %',command,sqlerrm; end if;
    return;
  end;
  raise exception 'Expected rejection: %',command;
end$$;
insert into auth.users(id,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,jsonb_build_object('full_name','User '||n) from generate_series(1,7) n;
insert into public.library_members(id,full_name,library_card_number,member_type,auth_user_id)
select id,full_name,'CARD-'||right(replace(id::text,'-',''),12),'student',id from public.profiles;
insert into public.books(id,title,author) values
 ('20000000-0000-0000-0000-000000000003','Accountless hold title','Author'),
 ('20000000-0000-0000-0000-000000000004','Acquisition request only','Author'),
 ('20000000-0000-0000-0000-000000000005','Linked account queue','Author');
select public.test_assert((select value='3'::jsonb from public.system_settings where key='loan_period_days'),'default loan period is three days');
update public.profiles set role='administrator' where id in ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
insert into public.books(id,title,author) values ('20000000-0000-0000-0000-000000000001','Test book','Author'),('20000000-0000-0000-0000-000000000002','Queue race','Author');
update public.books set course_subject='Accounting, Business Management' where id='20000000-0000-0000-0000-000000000001';
insert into public.book_copies(id,book_id,barcode)
select ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'20000000-0000-0000-0000-000000000001','TEST-'||n from generate_series(1,12) n;
insert into public.book_copies(book_id,barcode,status) values ('20000000-0000-0000-0000-000000000003','WALKIN-HOLD-COPY','maintenance');
insert into public.book_copies(book_id,barcode,status) values ('20000000-0000-0000-0000-000000000005','LINKED-ACCOUNT-COPY','maintenance');
set role anon;
select public.test_assert((select count(*)>=3 from public.books),'anonymous catalog title access');
select public.test_assert((select course_subject='Accounting, Business Management' from public.books where id='20000000-0000-0000-0000-000000000001'),'anonymous catalog can read course and subject tags');
select public.test_assert((select count(*)=1 from public.books where to_tsvector('simple',title||' '||author||' '||coalesce(category,'')||' '||course_subject) @@ plainto_tsquery('simple','business management')),'course and subject tags participate in catalog search');
select public.test_assert((select count(*)=12 from public.book_copies where book_id='20000000-0000-0000-0000-000000000001'),'anonymous copy availability access');
select public.test_denied($q$select barcode from public.book_copies limit 1$q$,'permission denied');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_denied($q$insert into public.reservations(book_id,member_id,status,created_at) values('20000000-0000-0000-0000-000000000001',auth.uid(),'ready_for_pickup','2000-01-01')$q$,'permission denied');
select public.test_denied($q$select public.reserve_book('20000000-0000-0000-0000-000000000001')$q$,'does not need');
select public.test_denied($q$select public.checkout_copy('10000000-0000-0000-0000-000000000001',auth.uid())$q$,'Only Librarians');
select public.test_denied('select public.process_circulation()','permission denied');
select public.test_denied('select public.allocate_pickup_holds(null)','permission denied');
select public.test_denied($q$select public.change_member_role(auth.uid(),'administrator')$q$,'Administrator');
select public.test_denied($q$select public.register_library_member('Blocked','BLOCKED-1',null,'student')$q$,'Staff access');
select public.test_denied($q$select public.staff_reserve_book('20000000-0000-0000-0000-000000000003',auth.uid())$q$,'Staff access');
select public.test_denied($q$select public.record_book_request('Unowned title')$q$,'Staff access');
select public.test_denied($q$select public.start_inventory_audit()$q$,'Staff access');
select public.test_denied($q$insert into public.book_requests(requested_title) values('Unauthorized request')$q$,'permission denied');
select public.test_denied($q$insert into public.inventory_audits default values$q$,'permission denied');
select public.test_denied($q$select public.link_library_member_account(auth.uid(),auth.uid())$q$,'Staff access');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.test_denied($q$update public.book_copies set status='available'$q$,'permission denied');
select public.test_denied($q$update public.loans set fine_amount=0$q$,'permission denied');
select public.test_denied($q$update public.reservations set status='completed'$q$,'permission denied');
select public.test_denied($q$update public.profiles set role='member'$q$,'permission denied');
select public.test_denied($q$update public.system_settings set value='-1' where key='max_active_loans'$q$,'bounds');
select public.test_denied($q$update public.system_settings set value='"5"' where key='max_active_loans'$q$,'number');
select public.test_denied($q$update public.system_settings set value='4' where key='loan_period_days'$q$,'bounds');
select public.test_denied($q$update public.library_members set full_name='forbidden' where id=auth.uid()$q$,'permission denied');
update public.system_settings set value='2' where key='loan_period_days';
select public.test_assert((select value='2'::jsonb from public.system_settings where key='loan_period_days'),'one to three day loan period is configurable');
update public.system_settings set value='3' where key='loan_period_days';
update public.system_settings set value='2' where key='fine_per_day';
select public.register_library_member('Walk-in Student','CARD-WALKIN-1',null,'student') as walkin_member \gset
select public.test_assert((select auth_user_id is null and library_card_number='CARD-WALKIN-1' from public.library_members where id=:'walkin_member'),'staff can register a borrower with no login');
select public.test_denied(format('select public.staff_reserve_book(%L,%L)','20000000-0000-0000-0000-000000000004',:'walkin_member'),'no physical copies');
select public.test_denied(format('select public.checkout_copy(%L,%L,%L)','10000000-0000-0000-0000-000000000009',:'walkin_member',now()+interval '4 days'),'exceeds the configured loan period');
select public.checkout_copy('10000000-0000-0000-0000-000000000009',:'walkin_member') as walkin_loan \gset
select public.test_assert((select member_id=:'walkin_member' and due_at<=now()+interval '3 days' from public.loans where id=:'walkin_loan'),'accountless borrower checkout uses the loan policy');
select public.return_loan(:'walkin_loan');
select public.staff_reserve_book('20000000-0000-0000-0000-000000000003',:'walkin_member') as walkin_hold \gset
select public.test_assert((select member_id=:'walkin_member' and status='waiting' from public.reservations where id=:'walkin_hold'),'staff can queue a cardholder without a login');
select public.test_denied(format('select public.update_library_member(%L,%L,%L,NULL,%L,false)',:'walkin_member','Walk-in Student','CARD-WALKIN-1','student'),'Resolve active loans and reservations');
select public.checkout_copy('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003') as returned_loan \gset
select public.checkout_copy('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003') as damaged_loan \gset
select public.checkout_copy('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000003') as lost_loan \gset
select public.checkout_copy('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003') as renewed_loan \gset
select public.renew_loan(:'renewed_loan');
select public.test_denied(format('select public.renew_loan(%L)',:'renewed_loan'),'renewal limit');
reset role;
-- Simulate overdue data without ever running the scheduled refresh first.
update public.loans set due_at=now()-interval '49 hours' where id in (:'returned_loan',:'damaged_loan',:'lost_loan');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
update public.system_settings set value='50' where key='fine_per_day';
select public.return_loan(:'returned_loan');
select public.close_loan_with_status(:'damaged_loan','damaged');
select public.close_loan_with_status(:'lost_loan','lost');
select public.test_assert((select count(*)=3 from public.loans where id in (:'returned_loan',:'damaged_loan',:'lost_loan') and fine_amount=6 and fine_daily_rate=2),'Final fines use checkout rate');
select public.test_assert((select status='damaged' from public.book_copies where id='10000000-0000-0000-0000-000000000002'),'Damaged enum mapping');
select public.test_assert((select status='lost' from public.book_copies where id='10000000-0000-0000-0000-000000000003'),'Lost enum mapping');
select public.test_assert((select count(*)=3 from public.audit_logs where action in ('return','damaged','lost') and details->>'fine_amount'='6.00'),'Closure audit fines');
select public.test_denied(format('select public.return_loan(%L)',:'returned_loan'),'already closed');
-- Queue fixture with two copies. All reservations use the member RPC.
reset role;
insert into public.book_copies(book_id,barcode,status) values('20000000-0000-0000-0000-000000000002','QUEUE-A','maintenance'),('20000000-0000-0000-0000-000000000002','QUEUE-B','maintenance');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.reserve_book('20000000-0000-0000-0000-000000000002') as hold1 \gset
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000004';
select public.reserve_book('20000000-0000-0000-0000-000000000002') as hold2 \gset
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000005';
select public.reserve_book('20000000-0000-0000-0000-000000000002') as hold3 \gset
reset role;
update public.book_copies set status='available' where barcode like 'QUEUE-%';


set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.promote_next_reservation('20000000-0000-0000-0000-000000000002');
select copy_id as assigned2 from public.reservations where id=:'hold2' \gset
select public.test_denied(format('select public.checkout_copy(%L,%L)',:'assigned2','00000000-0000-0000-0000-000000000005'),'held');
select public.checkout_copy(:'assigned2','00000000-0000-0000-0000-000000000004') as pickup_loan \gset
select public.test_assert((select status='completed' from public.reservations where id=:'hold2'),'Second hold can check out first');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000005';
select public.test_denied(format('select public.cancel_reservation(%L)',:'hold1'),'Not allowed');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.cancel_reservation(:'hold1');
reset role;
select public.test_assert((select status='ready_for_pickup' from public.reservations where id=:'hold3'),'Cancellation reassigns copy');
update public.reservations set pickup_expires_at=now()-interval '1 second' where id=:'hold3';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.refresh_circulation_statuses();
select public.test_assert((select status='expired' from public.reservations where id=:'hold3'),'Expiry processing');
select public.return_loan(:'pickup_loan');
select public.test_denied(format('select public.cancel_reservation(%L)',:'hold2'),'not active');
-- Last-admin and unauthenticated/missing-profile guards.
select public.change_member_role('00000000-0000-0000-0000-000000000002','librarian');
select public.test_denied($q$select public.change_member_role(auth.uid(),'member')$q$,'last administrator');
select public.change_member_role('00000000-0000-0000-0000-000000000002','administrator');
set request.jwt.claim.sub='99999999-0000-0000-0000-000000000001';
select public.test_denied($q$select public.reserve_book('20000000-0000-0000-0000-000000000002')$q$,'Only authenticated');
select public.test_denied($q$select public.return_loan(null)$q$,'Only Librarians');
-- Invitation consumption occurs atomically with Auth user insertion.
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.issue_school_id_invitation('STU-123','Verified Student') as invite \gset
reset role;
select public.test_denied($q$insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),'{"school_id":"STU-123"}')$q$,'staff invitation');
select public.register_library_member('Verified Student','CARD-STU-123','STU-123','student') as linked_member \gset
insert into auth.users(id,raw_app_meta_data) values('00000000-0000-0000-0000-000000000020',jsonb_build_object('school_id','STU-123','school_invitation',:'invite'));
select public.test_assert((select school_id='STU-123' and full_name='Verified Student' from public.profiles where id='00000000-0000-0000-0000-000000000020'),'Verified identity');
select public.test_assert((select auth_user_id='00000000-0000-0000-0000-000000000020' from public.library_members where id=:'linked_member'),'optional account links to its verified member record');
select public.test_denied(format('insert into auth.users(id,raw_app_meta_data) values(gen_random_uuid(),%L)',jsonb_build_object('school_id','STU-123','school_invitation',:'invite')),'Valid staff invitation');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000020';
select public.reserve_book('20000000-0000-0000-0000-000000000005') as linked_hold \gset
select public.test_assert((select member_id=:'linked_member' from public.reservations where id=:'linked_hold'),'self-service reservation uses the linked library member ID');
select public.test_assert((select count(*)=1 from public.my_reservation_positions() where id=:'linked_hold'),'linked account sees its queue position');
select public.cancel_reservation(:'linked_hold');
select public.test_assert((select status='cancelled' from public.reservations where id=:'linked_hold'),'linked account can cancel only its own hold');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.checkout_copy('10000000-0000-0000-0000-000000000007',:'linked_member') as linked_loan \gset
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000020';
select public.test_assert((select count(*)=1 from public.loans where id=:'linked_loan' and member_id=:'linked_member'),'linked account reads its loan through RLS');
select public.renew_loan(:'linked_loan');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.issue_school_id_invitation('STU-123','Verified Student','recovery') as recovery \gset
select public.test_denied('select public.consume_school_recovery(null,null)','permission denied');
reset role;
set role service_role;
select public.test_assert(public.consume_school_recovery('STU-123',:'recovery')='00000000-0000-0000-0000-000000000020','Verified recovery');
select public.test_denied(format('select public.consume_school_recovery(%L,%L)','STU-123',:'recovery'),'Invalid recovery');
select public.allow_school_auth('STU-123') from generate_series(1,10);
select public.test_assert(not public.allow_school_auth('STU-123'),'Auth throttling');
reset role;
-- Report results are computed in the database; terminal loss/damage is not a return.
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.test_assert((select sum((day->>'returns')::integer)=3 from jsonb_array_elements(public.library_analytics(now()-interval '1 day',now()+interval '1 day')->'daily') day),'Analytics counts physical returns and excludes lost or damaged closures');
select public.test_assert((public.transaction_history('damaged',0,1)->>'total')::integer=1,'Searchable closure audit');
select public.test_assert(jsonb_array_length(public.transaction_history('',0,2)->'items')=2,'History is paginated');
select public.test_denied('select public.scheduled_circulation()','permission denied');
reset role;
set role service_role;
select public.scheduled_circulation();
reset role;
select public.test_assert((select last_scheduled_success_at is not null from public.circulation_job_health),'Scheduled heartbeat');
begin;
insert into public.books(title,author,category) select 'Bulk book '||n,'Bulk author','Bulk category' from generate_series(1,1005) n;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.test_assert((select (category->>'count')::integer=1005 from jsonb_array_elements(public.library_analytics(now()-interval '1 day',now()+interval '1 day')->'categories') category where category->>'label'='Bulk category'),'Analytics includes over 1000 records');
rollback;
-- Leave waiting rows and available copies for concurrent promotion tests.
update public.book_copies set status='maintenance' where barcode like 'QUEUE-%';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.reserve_book('20000000-0000-0000-0000-000000000002');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000005';
select public.reserve_book('20000000-0000-0000-0000-000000000002');
reset role;
update public.book_copies set status='available' where barcode like 'QUEUE-%';

-- Staff-only acquisition requests capture demand even when a title has no copy.
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.record_book_request('Book Not Owned','Requested Author','Accounting',:'walkin_member') as acquisition_request \gset
select public.test_assert((select status='new' and member_id=:'walkin_member' and course_subject='Accounting' from public.book_requests where id=:'acquisition_request'),'staff can record a no-login member book request');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_assert((select count(*)=0 from public.book_requests),'members cannot read staff acquisition requests');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.update_book_request(:'acquisition_request','reviewing','Check course demand');
select public.update_book_request(:'acquisition_request','ordered','');
select public.update_book_request(:'acquisition_request','acquired','Added to collection');
select public.test_assert((select status='acquired' and closed_at is not null and staff_notes='Added to collection' from public.book_requests where id=:'acquisition_request'),'book request follows the allowed acquisition lifecycle');
select public.test_denied(format('select public.update_book_request(%L,%L,NULL)',:'acquisition_request','new'),'Invalid book request transition');
select public.test_assert((select count(*)=4 from public.audit_logs where entity_type='book_request' and entity_id=:'acquisition_request'),'book request creation and each status change are audited');

-- A stock audit reports discrepancies but never changes circulation status.
reset role;
update public.book_copies set location='Shelf A' where barcode in ('TEST-1','TEST-2','TEST-6');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.start_inventory_audit() as stock_audit \gset
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_assert((select count(*)=0 from public.inventory_audits),'members cannot read staff inventory audits');
select public.test_assert((select count(*)=0 from public.inventory_audit_items),'members cannot read staff inventory audit scans');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.scan_inventory_audit_copy(:'stock_audit','TEST-1','Shelf A');
select public.scan_inventory_audit_copy(:'stock_audit','TEST-2','Shelf B');
select public.scan_inventory_audit_copy(:'stock_audit','LOST-UNKNOWN-BARCODE','Shelf A');
select public.scan_inventory_audit_copy(:'stock_audit','TEST-3','Shelf A');
select public.test_denied(format('select public.scan_inventory_audit_copy(%L,%L,%L)',:'stock_audit','TEST-1','Shelf A'),'already scanned');
reset role;
update public.book_copies set status='maintenance' where barcode='TEST-6';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.complete_inventory_audit(:'stock_audit');
select public.test_assert((select result='found' from public.inventory_audit_items where audit_id=:'stock_audit' and barcode='TEST-1'),'correctly scanned copy is found');
select public.test_assert((select result='wrong_location' from public.inventory_audit_items where audit_id=:'stock_audit' and barcode='TEST-2'),'wrong shelf is flagged');
select public.test_assert((select result='unknown_barcode' from public.inventory_audit_items where audit_id=:'stock_audit' and barcode='LOST-UNKNOWN-BARCODE'),'unknown barcode is recorded');
select public.test_assert((select result='not_in_snapshot' from public.inventory_audit_items where audit_id=:'stock_audit' and barcode='TEST-3'),'lost copy is not incorrectly treated as shelf stock');
select public.test_assert((select result='status_changed' from public.inventory_audit_items where audit_id=:'stock_audit' and barcode='TEST-6'),'copy changed during audit is flagged for review');
select public.test_assert((select result='not_found' from public.inventory_audit_items where audit_id=:'stock_audit' and barcode='TEST-5'),'unscanned expected copy is flagged missing');
select public.test_assert((select status='completed' and summary->>'wrong_location'='1' and (summary->>'not_found')::integer>=1 from public.inventory_audits where id=:'stock_audit'),'completed audit stores a discrepancy summary');
select public.test_assert((select status='available' from public.book_copies where barcode='TEST-5'),'inventory audit does not automatically change a missing copy status');
select public.test_assert((select status='damaged' from public.book_copies where barcode='TEST-2'),'inventory audit does not change a damaged copy status');
select public.test_denied(format('select public.complete_inventory_audit(%L)',:'stock_audit'),'not open');
reset role;
