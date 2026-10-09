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
-- The production migration intentionally revokes implicit function execution.
-- Grant these test-only assertion helpers to the roles used below explicitly.
grant execute on function public.test_assert(boolean,text), public.test_denied(text,text) to anon,authenticated,service_role;
select public.test_assert(not has_function_privilege('anon','public.checkout_copy(uuid,uuid,timestamptz)'::regprocedure,'execute'),'anonymous role cannot execute staff checkout RPC');
select public.test_assert(not has_function_privilege('anon','public.return_loan(uuid)'::regprocedure,'execute'),'anonymous role cannot execute staff return RPC');
select public.test_assert(not has_function_privilege('anon','public.close_loan_with_status(uuid,public.loan_status)'::regprocedure,'execute'),'anonymous role cannot execute lost or damaged RPC');
select public.test_assert(not has_function_privilege('anon','public.library_analytics(timestamptz,timestamptz,text)'::regprocedure,'execute'),'anonymous role cannot execute staff analytics RPC');
select public.test_assert(not has_function_privilege('anon','public.reserve_book(uuid)'::regprocedure,'execute'),'anonymous role cannot execute member reservation RPC');
select public.test_assert(not has_function_privilege('anon','public.change_member_role(uuid,public.app_role)'::regprocedure,'execute'),'anonymous role cannot execute administrator role RPC');
select public.test_assert(not has_function_privilege('anon','public.reserve_book_by_card(text,text,uuid)'::regprocedure,'execute') and not has_function_privilege('authenticated','public.reserve_book_by_card(text,text,uuid)'::regprocedure,'execute'),'card/PIN cannot create reservations without a linked member account');
select public.test_assert(has_function_privilege('anon','public.card_reservation_status(text,text)'::regprocedure,'execute') and has_function_privilege('anon','public.cancel_card_reservation(text,text,uuid)'::regprocedure,'execute'),'anonymous cardholders can check and cancel only with card and PIN');
select public.test_assert(not has_function_privilege('anon','public.verify_library_card_reservation_pin(text,text)'::regprocedure,'execute'),'anonymous role cannot call the internal PIN verifier');
select public.test_assert(not has_function_privilege('anon','public.set_library_card_reservation_pin(uuid,text)'::regprocedure,'execute'),'anonymous role cannot set cardholder PINs');
create function public.test_default_anon_function_acl() returns integer language sql as $$select 1$$;
select public.test_assert(not has_function_privilege('anon','public.test_default_anon_function_acl()'::regprocedure,'execute'),'new public functions do not inherit anonymous or PUBLIC EXECUTE');
drop function public.test_default_anon_function_acl();
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'test-user-'||n||'@example.edu',now(),jsonb_build_object('full_name','User '||n) from generate_series(1,7) n;
insert into public.library_members(id,full_name,library_card_number,member_type,auth_user_id)
select id,full_name,'CARD-'||right(replace(id::text,'-',''),12),'student',id from public.profiles;
insert into public.books(id,title,author) values
 ('20000000-0000-0000-0000-000000000003','Accountless hold title','Author'),
 ('20000000-0000-0000-0000-000000000004','Acquisition request only','Author'),
 ('20000000-0000-0000-0000-000000000005','Linked account queue','Author'),
 ('20000000-0000-0000-0000-000000000006','Accountless online hold','Author');
select public.test_assert((select value='3'::jsonb from public.system_settings where key='loan_period_days'),'default loan period is three days');
update public.profiles set role='administrator', school_id=case
  when id='00000000-0000-0000-0000-000000000001' then 'TEMP-ADMIN-2026'
  else school_id end
where id in ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
update public.profiles set role='librarian', school_id='TEMP-LIBRARIAN-2026'
where id='00000000-0000-0000-0000-000000000007';
do $$
begin
  begin
    update public.profiles set school_id=' temp-admin-2026 '
    where id='00000000-0000-0000-0000-000000000002';
    raise exception 'Expected normalized profile School ID collision to be rejected';
  exception when unique_violation then
    null;
  end;

  update public.library_members set school_id='TEST-MEMBER-ID'
  where id='00000000-0000-0000-0000-000000000001';
  begin
    update public.library_members set school_id=' test-member-id '
    where id='00000000-0000-0000-0000-000000000002';
    raise exception 'Expected normalized library-member School ID collision to be rejected';
  exception when unique_violation then
    null;
  end;
end;
$$;
update public.library_members set auth_user_id=null
where auth_user_id in ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000007');
update auth.users set email=case
  when id='00000000-0000-0000-0000-000000000001' then 'temp-admin@example.edu'
  when id='00000000-0000-0000-0000-000000000007' then 'temp-librarian@example.edu'
  else email end
where id in ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000007');
insert into public.books(id,title,author) values ('20000000-0000-0000-0000-000000000001','Test book','Author'),('20000000-0000-0000-0000-000000000002','Queue race','Author');
update public.books set course_subject='Accounting, Business Management' where id='20000000-0000-0000-0000-000000000001';
insert into public.book_copies(id,book_id,barcode)
select ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'20000000-0000-0000-0000-000000000001','TEST-'||n from generate_series(1,12) n;
insert into public.book_copies(book_id,barcode,status) values ('20000000-0000-0000-0000-000000000003','WALKIN-HOLD-COPY','borrowed');
insert into public.book_copies(book_id,barcode,status) values ('20000000-0000-0000-0000-000000000005','LINKED-ACCOUNT-COPY','borrowed');
insert into public.book_copies(id,book_id,barcode,status) values ('10000000-0000-0000-0000-000000000013','20000000-0000-0000-0000-000000000006','CARD-HOLD-COPY','available');
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
select public.reserve_book('20000000-0000-0000-0000-000000000001') as linked_available_hold \gset
select public.test_assert((select r.status='waiting' and r.staff_approved_at is null
  and r.copy_id is null and exists (select 1 from public.book_copies c where c.book_id=r.book_id and c.status='available')
  from public.reservations r where r.id=:'linked_available_hold'), 'an available-copy request waits for staff approval before holding stock');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.staff_approve_reservation_request(:'linked_available_hold');
select public.test_assert((select status='ready_for_pickup' and staff_approved_at is not null
  and pickup_confirmed_at is null and pickup_expires_at is null
  from public.reservations where id=:'linked_available_hold'), 'approved request gets an assigned copy but is not yet reported ready');
select public.staff_confirm_reservation_pickup(:'linked_available_hold');
select public.test_assert((select pickup_confirmed_at is not null and pickup_expires_at>now()
  from public.reservations where id=:'linked_available_hold'), 'staff confirmation is what starts the pickup deadline');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.cancel_reservation(:'linked_available_hold');
select public.test_denied($q$select public.checkout_copy('10000000-0000-0000-0000-000000000001',auth.uid())$q$,'Only Librarians');
select public.test_denied('select public.process_circulation()','permission denied');
select public.test_denied('select public.allocate_pickup_holds(null)','permission denied');
select public.test_denied($q$select public.change_member_role(auth.uid(),'administrator')$q$,'Administrator');
select public.test_denied($q$select public.register_library_member('Blocked','BLOCKED-1',null,'student')$q$,'Staff access');
select public.test_denied($q$select public.staff_reserve_book('20000000-0000-0000-0000-000000000003',auth.uid())$q$,'Staff access');
select public.test_denied($q$select public.record_book_request('Unowned title')$q$,'Staff access');
select public.test_denied($q$select public.start_inventory_audit()$q$,'Staff access');
select public.test_denied($q$select public.start_inventory_audit_for_shelf('Fiction')$q$,'Staff access');
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
select public.set_library_card_reservation_pin(:'walkin_member','12345678');
reset role;
select public.test_assert((select pin_hash like '$2%' and crypt('12345678',pin_hash)=pin_hash from public.library_member_reservation_pins where member_id=:'walkin_member'),'reservation PIN is stored only as a bcrypt hash');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.register_library_member('Self Signup Student','CARD-SELF-SIGNUP','STU-SELF-SIGNUP','student') as self_signup_member \gset
select public.set_library_card_reservation_pin(:'self_signup_member','24681357');
reset role;
insert into auth.users(id,email,raw_user_meta_data) values(
  '00000000-0000-0000-0000-000000000008','self.signup@example.edu',
  '{"full_name":"Self Signup Student","registration_school_id":"STU-SELF-SIGNUP"}'
);
select public.test_assert((select school_id is null and role='member' from public.profiles where id='00000000-0000-0000-0000-000000000008'),'signup School ID is only an unverified claim until card verification');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000008';
select public.test_assert(not public.current_user_has_active_library_member(),'unconfirmed account has no active borrower record');
select public.test_denied($q$select public.complete_member_account_registration('STU-SELF-SIGNUP','CARD-SELF-SIGNUP','24681357')$q$,'permission denied');
reset role;
update auth.users set email_confirmed_at=now() where id='00000000-0000-0000-0000-000000000008';
set role service_role;
select public.test_assert(public.school_login_email('STU-SELF-SIGNUP') is null,'an unlinked School ID cannot resolve to a login email');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000008';
select public.test_denied($q$select public.complete_member_account_registration('STU-SELF-SIGNUP','CARD-SELF-SIGNUP','24681357')$q$,'permission denied');
select public.test_assert((select p.school_id is null and m.school_id is null and m.library_card_number is null and m.email_only and m.auth_user_id=p.id from public.profiles p join public.library_members m on m.auth_user_id=p.id where p.id='00000000-0000-0000-0000-000000000008'),'email confirmation creates a separate email-only borrower record without linking an ID or card');
select public.test_assert(public.current_user_has_active_library_member(),'email-confirmed account passes the member access gate');
select public.reserve_book('20000000-0000-0000-0000-000000000006') as email_only_available_hold \gset
select public.test_assert((select r.status='waiting' and r.staff_approved_at is null and r.copy_id is null
  and exists (select 1 from public.book_copies c where c.book_id=r.book_id and c.status='available')
  from public.reservations r where r.id=:'email_only_available_hold'), 'email-only member request waits for staff approval before holding a copy');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.staff_approve_reservation_request(:'email_only_available_hold');
select public.test_assert((select status='ready_for_pickup' and pickup_confirmed_at is null and pickup_expires_at is null
  from public.reservations where id=:'email_only_available_hold'), 'staff approval assigns a copy but does not yet tell the member to collect it');
select public.staff_confirm_reservation_pickup(:'email_only_available_hold');
select public.test_assert((select pickup_confirmed_at is not null and pickup_expires_at>now()
  from public.reservations where id=:'email_only_available_hold'), 'staff pickup confirmation starts its deadline');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000008';
select public.cancel_reservation(:'email_only_available_hold');
select public.test_denied($q$select public.reserve_book_by_card('CARD-SELF-SIGNUP','24681357','20000000-0000-0000-0000-000000000006')$q$,'permission denied');
reset role;
set role service_role;
select public.test_assert(public.school_login_email(' stu-self-signup ') is null,'School ID login does not resolve before staff links a verified member record');
select public.test_assert(public.school_login_email(' temp-admin-2026 ')='temp-admin@example.edu','administrator School ID resolves to its existing Auth email');
select public.test_assert(public.school_login_email('TEMP-LIBRARIAN-2026')='temp-librarian@example.edu','librarian School ID resolves without a borrower-member link');
select public.test_assert(public.school_login_email('NO-SUCH-ID-2026') is null,'unknown School ID never resolves to an account');
select public.test_assert(public.school_login_email('   ') is null,'blank School ID never resolves to an account');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000008';
select public.test_denied($q$select public.school_login_email('STU-SELF-SIGNUP')$q$,'permission denied');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.checkout_copy('10000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000003') as card_hold_loan \gset
select public.staff_reserve_book('20000000-0000-0000-0000-000000000006',:'walkin_member') as card_hold_reservation \gset
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_denied($q$select public.set_library_card_reservation_pin('00000000-0000-0000-0000-000000000003','87654321')$q$,'Staff access');
select public.test_denied($q$select public.set_library_card_reservation_pin('00000000-0000-0000-0000-000000000003','123')$q$,'Staff access');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
reset role;
set request.jwt.claim.sub = '';
set role anon;
select public.test_denied($q$select * from public.library_member_reservation_pins$q$,'permission denied');
select public.test_denied($q$select public.reserve_book_by_card('CARD-WALKIN-1','12345678','20000000-0000-0000-0000-000000000006')$q$,'permission denied');
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','12345678')->>'verified')::boolean and jsonb_array_length(public.card_reservation_status('CARD-WALKIN-1','12345678')->'reservations')=1,'cardholder can securely look up their active holds');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.return_loan(:'card_hold_loan');
select public.test_assert((select r.status='ready_for_pickup' and r.staff_approved_at is not null
  and r.pickup_confirmed_at is null and r.pickup_expires_at is null and c.status='reserved'
  from public.reservations r join public.book_copies c on c.id=r.copy_id
  where r.member_id=:'walkin_member' and r.book_id='20000000-0000-0000-0000-000000000006'),'return assigns a copy to a staff-approved hold but does not confirm pickup readiness');
select public.staff_confirm_reservation_pickup((select id from public.reservations where member_id=:'walkin_member' and book_id='20000000-0000-0000-0000-000000000006' and status='ready_for_pickup'));
select public.test_assert((select count(*)=0 from public.notifications where member_id=:'walkin_member'),'accountless pickup notification does not violate profile-keyed notifications');
reset role;
set role anon;
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','12345678')->'reservations'->0->>'status')='ready_for_pickup' and (public.card_reservation_status('CARD-WALKIN-1','12345678')->'reservations'->0->>'pickup_expires_at')::timestamptz>now(),'cardholder can see pickup status and deadline');
select public.test_assert((public.cancel_card_reservation('CARD-WALKIN-1','12345678',(select (hold->>'reservation_id')::uuid from jsonb_array_elements(public.card_reservation_status('CARD-WALKIN-1','12345678')->'reservations') hold))->>'verified')::boolean,'cardholder can cancel a hold');
select public.test_assert(jsonb_array_length(public.card_reservation_status('CARD-WALKIN-1','12345678')->'reservations')=0,'cardholder can cancel their hold');
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','00000000')->>'verified')::boolean is false,'first bad PIN is counted');
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','00000000')->>'verified')::boolean is false,'second bad PIN is counted');
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','00000000')->>'verified')::boolean is false,'third bad PIN is counted');
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','00000000')->>'verified')::boolean is false,'fourth bad PIN is counted');
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','00000000')->>'verified')::boolean is false,'fifth bad PIN is counted');
select public.test_assert((public.card_reservation_status('CARD-WALKIN-1','12345678')->>'verified')::boolean is false,'correct PIN is blocked during the temporary lockout');
reset role;
select public.test_assert((select status='available' from public.book_copies where id='10000000-0000-0000-0000-000000000013'),'cancelling a pickup hold releases its assigned copy');
update public.library_member_reservation_pins set failed_attempts=0,locked_until=null where member_id=:'walkin_member';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.test_denied(format('select public.set_library_card_reservation_pin(%L,%L)',:'walkin_member','123'),'Use a PIN');
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
insert into public.book_copies(book_id,barcode,status) values('20000000-0000-0000-0000-000000000002','QUEUE-A','borrowed'),('20000000-0000-0000-0000-000000000002','QUEUE-B','borrowed');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.reserve_book('20000000-0000-0000-0000-000000000002') as hold1 \gset
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000004';
select public.reserve_book('20000000-0000-0000-0000-000000000002') as hold2 \gset
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000005';
select public.reserve_book('20000000-0000-0000-0000-000000000002') as hold3 \gset
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_denied(format('select public.staff_approve_reservation_request(%L)',:'hold1'),'Only Librarians');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.staff_approve_reservation_request(:'hold1');
select public.staff_approve_reservation_request(:'hold2');
select public.staff_approve_reservation_request(:'hold3');
select public.test_assert((select count(*)=3 from public.reservations where id in (:'hold1',:'hold2',:'hold3') and status='waiting' and staff_approved_at is not null),'staff approval is required before copies are assigned');
reset role;
update public.book_copies set status='available' where barcode like 'QUEUE-%';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.promote_next_reservation('20000000-0000-0000-0000-000000000002');
select copy_id as assigned2 from public.reservations where id=:'hold2' \gset
select public.test_assert((select pickup_confirmed_at is null and pickup_expires_at is null from public.reservations where id=:'hold2'),'an assigned copy is not ready or expiring before staff confirmation');
select public.test_denied(format('select public.checkout_copy(%L,%L)',:'assigned2','00000000-0000-0000-0000-000000000004'),'must confirm the copy is ready');
select public.staff_confirm_reservation_pickup(:'hold2');
select public.test_assert((select pickup_confirmed_at is not null and pickup_expires_at is not null from public.reservations where id=:'hold2'),'staff confirmation starts the pickup window');
select public.test_denied(format('select public.checkout_copy(%L,%L)',:'assigned2','00000000-0000-0000-0000-000000000005'),'held');
select public.checkout_copy(:'assigned2','00000000-0000-0000-0000-000000000004') as pickup_loan \gset
select public.test_assert((select status='completed' from public.reservations where id=:'hold2'),'Second hold can check out first');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000005';
select public.test_denied(format('select public.cancel_reservation(%L)',:'hold1'),'Not allowed');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.cancel_reservation(:'hold1');
reset role;
select public.test_assert((select status='ready_for_pickup' and pickup_confirmed_at is null and pickup_expires_at is null from public.reservations where id=:'hold3'),'Cancellation assigns the next copy but still requires staff confirmation');
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.staff_confirm_reservation_pickup(:'hold3');
reset role;
update public.reservations set pickup_expires_at=now()-interval '1 second' where id=:'hold3';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
reset role;
update public.loans set due_at=now()-interval '1 second' where id=:'pickup_loan';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.refresh_circulation_statuses();
select public.test_assert((select status='expired' from public.reservations where id=:'hold3'),'Expiry processing');
select public.return_loan(:'pickup_loan');
select public.test_denied(format('select public.cancel_reservation(%L)',:'hold2'),'not active');
-- Last-admin and unauthenticated/missing-profile guards.
select public.change_member_role('00000000-0000-0000-0000-000000000002','librarian');
select public.test_denied($q$select public.change_member_role(auth.uid(),'member')$q$,'last active administrator');
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
insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values('00000000-0000-0000-0000-000000000020','verified.student@example.edu',now(),jsonb_build_object('school_id','STU-123','school_invitation',:'invite'));
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
select public.test_assert((select sum((day->>'returns')::integer)=4 from jsonb_array_elements(public.library_analytics(now()-interval '1 day',now()+interval '1 day')->'daily') day),'Analytics counts physical returns and excludes lost or damaged closures');
select public.test_assert((public.transaction_history('damaged',0,1)->>'total')::integer=1,'Searchable closure audit');
select public.test_assert(jsonb_array_length(public.transaction_history('',0,2)->'items')=2,'History is paginated');
select public.test_assert(
  (public.transaction_history(:'damaged_loan',0,6,'damaged','newest')->'items'->0->>'internal_copy_id')
    = (select copy_id::text from public.loans where id=:'damaged_loan')
  and (public.transaction_history(:'damaged_loan',0,6,'damaged','newest')->'items'->0->>'barcode')
    = (select c.barcode from public.loans l join public.book_copies c on c.id=l.copy_id where l.id=:'damaged_loan'),
  'Transaction history joins the linked physical copy and distinguishes barcode from internal ID'
);
select public.test_assert(
  public.transaction_history('',0,6,'damaged','newest')->>'total'='1'
  and jsonb_array_length(public.transaction_history('',0,6)->'items')<=6,
  'Transaction action filtering and six-row page limits are enforced'
);
select public.test_assert(
  (public.transaction_history(
    (select entity_id::text from public.audit_logs
      where entity_type='reservation' and action='cancel' and details->>'source'='card_pin'
      order by created_at desc limit 1),
    0,6,'cancel','newest')->'items'->0->>'actor_type')='member_self_service',
  'Card/PIN cancellations are attributed to a self-service member, not staff'
);
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000007';
select public.test_assert(jsonb_typeof(public.transaction_history('',0,6)->'items')='array',
  'Librarians can read transaction history under the existing staff permission');
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
update public.book_copies set status='borrowed' where barcode like 'QUEUE-%';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.reserve_book('20000000-0000-0000-0000-000000000002');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000005';
select public.reserve_book('20000000-0000-0000-0000-000000000002');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.staff_approve_reservation_request(id) from public.reservations where book_id='20000000-0000-0000-0000-000000000002' and status='waiting';
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
update public.book_copies set location='Shelf B' where barcode='TEST-8';
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

-- Shelf audits only count unscanned copies assigned to that shelf. Their
-- complete snapshot still lets a scan from another shelf be flagged.
select public.test_denied($q$select public.start_inventory_audit_for_shelf('Not a real shelf')$q$,'Choose a valid shelf');
select public.start_inventory_audit_for_shelf('Shelf A') as shelf_stock_audit \gset
select public.test_assert((select location_scope='Shelf A' from public.inventory_audits where id=:'shelf_stock_audit'),'shelf audit stores its selected location');
select public.test_assert((select count(*)=3 from public.inventory_audit_items where audit_id=:'shelf_stock_audit' and expected_status is not null and expected_location='Shelf A'),'shelf audit snapshots the full inventory but counts expected copies on the selected shelf');
select public.scan_inventory_audit_copy(:'shelf_stock_audit','TEST-1','Shelf A');
select public.scan_inventory_audit_copy(:'shelf_stock_audit','TEST-8','Shelf A');
select public.test_assert((select result='wrong_location' from public.inventory_audit_items where audit_id=:'shelf_stock_audit' and barcode='TEST-8'),'shelf audit flags a copy scanned outside its assigned shelf');
select public.complete_inventory_audit(:'shelf_stock_audit');
select public.test_assert((select status='completed' and summary->>'expected_copies'='3' and summary->>'found'='1' and summary->>'wrong_location'='1' and summary->>'not_found'='2' from public.inventory_audits where id=:'shelf_stock_audit'),'shelf audit summary only marks unscanned copies from the selected shelf missing');
reset role;

-- Walk-in reservations keep borrower details without requiring a member row or
-- Auth account, but only staff may create or edit them.
insert into public.books(id, title, author) values
  ('20000000-0000-0000-0000-000000000007', 'Walk-in reservation', 'Queue Author'),
  ('20000000-0000-0000-0000-000000000008', 'Mixed borrower queue', 'Queue Author'),
  ('20000000-0000-0000-0000-000000000009', 'Available walk-in reservation', 'Queue Author');
insert into public.book_copies(book_id, barcode, status) values
  ('20000000-0000-0000-0000-000000000007', 'WALKIN-STAFF-COPY', 'borrowed'),
  ('20000000-0000-0000-0000-000000000008', 'MIXED-QUEUE-COPY', 'borrowed'),
  ('20000000-0000-0000-0000-000000000009', 'AVAILABLE-WALKIN-COPY', 'available');
set role anon;
select public.test_denied($q$select public.staff_create_reservation('20000000-0000-0000-0000-000000000007',null,'visitor','Community Visitor',null,null,null,current_date,null,null)$q$,'permission denied');
reset role;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
select public.test_denied($q$select public.staff_create_reservation('20000000-0000-0000-0000-000000000007',null,'visitor','Community Visitor',null,null,null,current_date,null,null)$q$,'Staff access');
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.staff_create_reservation(
  '20000000-0000-0000-0000-000000000007', null, 'visitor', 'Community Visitor', 'VIS-001',
  '+63 912 345 6789', 'visitor@example.edu', current_date, current_date + 2, 'Front desk walk-in'
) as manual_walkin_reservation \gset
select public.test_assert((select member_id is null and borrower_type='visitor' and borrower_full_name='Community Visitor'
  and student_employee_id='VIS-001' and expected_pickup_date=current_date+2
  and created_by='00000000-0000-0000-0000-000000000001'
  from public.reservations where id=:'manual_walkin_reservation'), 'staff can create a fully detailed walk-in reservation without a library member or Auth account');
select public.test_denied($q$select public.staff_create_reservation('20000000-0000-0000-0000-000000000007',null,'visitor','Community Visitor','VIS-001','+63 912 345 6789','visitor@example.edu',current_date,current_date+2,'Front desk walk-in')$q$,'already has an active reservation');
select public.test_denied($q$select public.staff_create_reservation('20000000-0000-0000-0000-000000000007',null,'visitor','Other Visitor','VIS-002',null,'not-an-email',current_date,null,null)$q$,'valid email');
select public.test_denied($q$select public.staff_create_reservation('20000000-0000-0000-0000-000000000007',null,'visitor','Phone Visitor','VIS-PHONE','not a phone',null,current_date,null,null)$q$,'valid contact number');
select public.test_denied($q$select public.staff_create_reservation('20000000-0000-0000-0000-000000000007',null,'visitor','Other Visitor','VIS-002',null,null,current_date,current_date-1,null)$q$,'cannot be before');
select public.test_denied(format('update public.reservations set notes=''forbidden'' where id=%L', :'manual_walkin_reservation'),'permission denied');

-- A staff reservation for an available copy is immediately routed through the
-- shared FIFO allocator. A second borrower waits, then receives that same copy
-- only after the first reservation is cancelled.
select public.staff_create_reservation(
  '20000000-0000-0000-0000-000000000009', null, 'visitor', 'Available Visitor One', null,
  null, null, current_date, null, null
) as available_walkin_reservation \gset
select public.test_assert((select r.status='ready_for_pickup' and r.copy_id is not null and c.status='reserved'
  and r.staff_approved_at is not null and r.pickup_confirmed_at is null and r.pickup_expires_at is null
  from public.reservations r join public.book_copies c on c.id=r.copy_id where r.id=:'available_walkin_reservation'),
  'staff creation approves the walk-in request and assigns a copy, but still requires pickup confirmation');
select copy_id as available_walkin_copy from public.reservations where id=:'available_walkin_reservation' \gset
select public.staff_create_reservation(
  '20000000-0000-0000-0000-000000000009', null, 'visitor', 'Available Visitor Two', null,
  null, null, current_date, null, null
) as second_available_walkin_reservation \gset
select public.test_assert((select status='waiting' and copy_id is null from public.reservations where id=:'second_available_walkin_reservation')
  and (select count(*)=1 from public.reservations where book_id='20000000-0000-0000-0000-000000000009' and status='ready_for_pickup'),
  'an assigned physical copy is never assigned to a second active reservation');
select public.cancel_reservation(:'available_walkin_reservation');
select public.test_assert((select status='ready_for_pickup' and copy_id=:'available_walkin_copy'
  and pickup_confirmed_at is null and pickup_expires_at is null
  from public.reservations where id=:'second_available_walkin_reservation'),
  'cancelling the first reservation assigns the released copy to the next borrower in FIFO order');
select public.cancel_reservation(:'second_available_walkin_reservation');

-- Registered and walk-in borrowers share the same FIFO allocator. One physical
-- copy cannot be assigned to both, and checkout cannot bypass walk-in identity.
select public.staff_reserve_book('20000000-0000-0000-0000-000000000008',:'walkin_member') as registered_queue_reservation \gset
select public.staff_create_reservation(
  '20000000-0000-0000-0000-000000000008', null, 'student', 'Verified Student', 'STU-123',
  null, null, current_date, null, null
) as queued_walkin_reservation \gset
reset role;
update public.book_copies set status='available' where barcode='MIXED-QUEUE-COPY';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.promote_next_reservation('20000000-0000-0000-0000-000000000008');
select public.test_assert((select status='ready_for_pickup' from public.reservations where id=:'registered_queue_reservation')
  and (select status='waiting' from public.reservations where id=:'queued_walkin_reservation'), 'registered member remains ahead of the later walk-in request');
select public.test_assert((select count(*)=1 and count(distinct copy_id)=1 from public.reservations
  where book_id='20000000-0000-0000-0000-000000000008' and status='ready_for_pickup'), 'the shared allocator assigns the only copy once');
select public.cancel_reservation(:'registered_queue_reservation');
select public.test_assert((select status='ready_for_pickup' and copy_id is not null from public.reservations where id=:'queued_walkin_reservation'), 'cancellation releases the copy to the next walk-in in FIFO order');
select public.staff_confirm_reservation_pickup(:'queued_walkin_reservation');
select public.test_denied(format('select public.checkout_copy(%L,%L)',
  (select copy_id from public.reservations where id=:'queued_walkin_reservation'), :'linked_member'), 'held for the next reservation');
select public.test_denied(format('select public.staff_update_reservation(%L,%L,%L,%L,%L,NULL,NULL,NULL,current_date,NULL,NULL)',
  :'queued_walkin_reservation', '20000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000003', 'student', 'User 3'), 'do not match');
select public.staff_update_reservation(
  :'queued_walkin_reservation', '20000000-0000-0000-0000-000000000008', :'linked_member',
  'student', 'Verified Student', 'STU-123', null, null, current_date, null, null
);
select public.checkout_copy((select copy_id from public.reservations where id=:'queued_walkin_reservation'), :'linked_member') as walkin_checkout \gset
select public.test_assert((select status='completed' and member_id=:'linked_member' from public.reservations where id=:'queued_walkin_reservation')
  and exists(select 1 from public.loans where id=:'walkin_checkout' and member_id=:'linked_member'), 'checkout associates the borrower and is the only way to complete a ready reservation');

-- Expiry of a walk-in hold releases its copy without attempting a profile-only
-- notification, while leaving the reservation in the existing expired state.
select public.cancel_reservation(:'manual_walkin_reservation');
select public.staff_create_reservation(
  '20000000-0000-0000-0000-000000000007', null, 'visitor', 'Expiry Visitor', 'EXP-001',
  null, null, current_date, null, null
) as expiring_walkin_reservation \gset
reset role;
update public.book_copies set status='available' where barcode='WALKIN-STAFF-COPY';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.promote_next_reservation('20000000-0000-0000-0000-000000000007');
select public.staff_confirm_reservation_pickup(:'expiring_walkin_reservation');
reset role;
update public.reservations set pickup_expires_at=now()-interval '1 second' where id=:'expiring_walkin_reservation';
set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
select public.refresh_circulation_statuses();
select public.test_assert((select status='expired' from public.reservations where id=:'expiring_walkin_reservation')
  and (select status='available' from public.book_copies where barcode='WALKIN-STAFF-COPY'), 'walk-in expiry releases inventory and remains in the reservation history');
select public.test_assert(not has_function_privilege('anon','public.staff_update_reservation(uuid,uuid,uuid,text,text,text,text,text,date,date,text)'::regprocedure,'execute'), 'anonymous role cannot edit walk-in reservations');
reset role;
