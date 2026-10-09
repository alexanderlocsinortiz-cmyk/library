-- Runs against the disposable database created by scripts/test-db.mjs.
begin;

select public.test_assert(
  (select status = 'pending_email_verification'
      and started_at <= now()
      and expires_at > now()
      and expires_at <= now() + interval '31 minutes'
   from public.pending_member_registrations
   where user_id = '00000000-0000-0000-0000-000000000098'),
  'pre-existing unconfirmed registrations receive a transition grace period instead of being deleted at rollout'
);

insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data)
values (
  '00000000-0000-0000-0000-000000000090', 'expired.registration@example.edu', null,
  now() - interval '31 minutes',
  '{"full_name":"Expired Registration","registration_school_id":"REG-EXPIRE-090"}'::jsonb
);
select public.test_assert(
  (select status = 'pending_email_verification' and expires_at <= now()
   from public.pending_member_registrations where user_id = '00000000-0000-0000-0000-000000000090'),
  'new unconfirmed signup receives its deadline from Auth created_at and configured minutes'
);
select public.test_denied(
  $q$update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-000000000090'$q$,
  'Registration expired'
);
select public.test_assert(
  (select email_confirmed_at is null from auth.users where id = '00000000-0000-0000-0000-000000000090'),
  'an OTP cannot confirm a registration after its separate completion deadline'
);

set role service_role;
select public.test_assert(
  public.get_member_registration_status('expired.registration@example.edu', 'REG-EXPIRE-090')->>'status' = 'expired',
  'status lookup marks the expired signup without deleting it'
);
select public.test_assert(
  public.claim_expired_member_registration('00000000-0000-0000-0000-000000000090'),
  'service role can claim only a due, unconfirmed signup'
);
select public.test_denied(
  $q$insert into public.library_members (full_name, school_id, is_active) values ('Late Member Record', 'REG-EXPIRE-090', true)$q$,
  'safely cleaned up'
);
select public.test_denied(
  $q$update public.profiles set role = 'librarian' where id = '00000000-0000-0000-0000-000000000090'$q$,
  'safely cleaned up'
);
select public.test_assert(
  public.validate_member_registration_cleanup('00000000-0000-0000-0000-000000000090'),
  'final cleanup validation remains true only while account and library state still meet the safety rules'
);
select public.finish_expired_member_registration_cleanup(
  '00000000-0000-0000-0000-000000000090', false, 'test_transient_failure'
);
reset role;
select public.test_assert(
  (select status = 'expired' and cleanup_started_at is null and cleanup_attempts = 1
   from public.pending_member_registrations where user_id = '00000000-0000-0000-0000-000000000090'),
  'failed Admin API deletion releases the lease so a later scheduled run can retry'
);

insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data)
values (
  '00000000-0000-0000-0000-000000000091', 'verified.registration@example.edu', null,
  now(), '{"full_name":"Verified Registration","registration_school_id":"REG-VERIFY-091"}'::jsonb
);
update auth.users set email_confirmed_at = now()
where id = '00000000-0000-0000-0000-000000000091';
select public.test_assert(
  (select status = 'completed' and completed_at is not null
   from public.pending_member_registrations where user_id = '00000000-0000-0000-0000-000000000091'),
  'successful OTP confirmation completes the registration state automatically'
);
select public.test_assert(
  exists (select 1 from public.activity_logs
    where entity_id = '00000000-0000-0000-0000-000000000091'
      and action = 'registration_email_verified' and status = 'success'),
  'successful email verification is retained in the activity log'
);
set role service_role;
select public.test_assert(
  not public.claim_expired_member_registration('00000000-0000-0000-0000-000000000091'),
  'verified accounts can never be claimed for cleanup'
);
reset role;

insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data)
values (
  '00000000-0000-0000-0000-000000000092', 'assisted.registration@example.edu', null,
  now() - interval '31 minutes',
  '{"full_name":"Assisted Registration","registration_school_id":"REG-ASSIST-092"}'::jsonb
);
insert into public.member_verification_assistance_requests (
  user_id, full_name_snapshot, email_snapshot, school_id_snapshot
) values (
  '00000000-0000-0000-0000-000000000092', 'Assisted Registration',
  'assisted.registration@example.edu', 'REG-ASSIST-092'
);
set role service_role;
select public.test_assert(
  not public.claim_expired_member_registration('00000000-0000-0000-0000-000000000092'),
  'an account with a pending administrator-assistance request is protected from cleanup'
);
reset role;
update auth.users set email_confirmed_at = now()
where id = '00000000-0000-0000-0000-000000000092';
select public.test_assert(
  (select status = 'completed' from public.pending_member_registrations
   where user_id = '00000000-0000-0000-0000-000000000092'),
  'assisted users still must pass Auth OTP confirmation, which completes normally'
);

insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data)
values (
  '00000000-0000-0000-0000-000000000093', 'member.registration@example.edu', null,
  now() - interval '31 minutes',
  '{"full_name":"Existing Library Member","registration_school_id":"REG-MEMBER-093"}'::jsonb
);
insert into public.library_members (id, full_name, school_id, is_active, auth_user_id)
values (
  '00000000-0000-0000-0000-000000000193', 'Existing Library Member', 'REG-MEMBER-093', true,
  '00000000-0000-0000-0000-000000000093'
);
set role service_role;
select public.test_assert(
  public.get_member_registration_status('member.registration@example.edu', 'REG-MEMBER-093')->>'status' = 'expired_protected',
  'an expired Auth record linked to an active library member is reported as preserved'
);
select public.test_assert(
  not public.claim_expired_member_registration('00000000-0000-0000-0000-000000000093'),
  'cleanup never claims an existing active library member account'
);
reset role;
select public.test_assert(
  exists (select 1 from auth.users where id = '00000000-0000-0000-0000-000000000093'),
  'protected account remains present in Auth'
);

insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data)
values (
  '00000000-0000-0000-0000-000000000094', 'history.registration@example.edu', null,
  now() - interval '31 minutes',
  '{"full_name":"Borrowing History Member","registration_school_id":"REG-HISTORY-094"}'::jsonb
);
insert into public.library_members (id, full_name, school_id, is_active, auth_user_id)
values ('00000000-0000-0000-0000-000000000194', 'Borrowing History Member', 'REG-HISTORY-094', false, null);
insert into public.books (id, title, author)
values ('20000000-0000-0000-0000-000000000094', 'Registration Safety Test Title', 'Test Author');
insert into public.book_copies (id, book_id, barcode, status)
values ('10000000-0000-0000-0000-000000000094', '20000000-0000-0000-0000-000000000094', 'REG-HISTORY-COPY-094', 'available');
insert into public.loans (id, copy_id, member_id, due_at, returned_at, status)
values (
  '30000000-0000-0000-0000-000000000094', '10000000-0000-0000-0000-000000000094',
  '00000000-0000-0000-0000-000000000194', now() - interval '2 days', now() - interval '1 day', 'returned'
);
set role service_role;
select public.test_assert(
  public.get_member_registration_status('history.registration@example.edu', 'REG-HISTORY-094')->>'status' = 'expired_protected',
  'historical transactions protect their School ID owner even when the old library record is inactive and unlinked'
);
select public.test_assert(
  not public.claim_expired_member_registration('00000000-0000-0000-0000-000000000094'),
  'cleanup preserves accounts associated with returned loans through the School ID'
);
reset role;

set role authenticated;
select public.test_denied(
  $q$select * from public.pending_member_registrations$q$,
  'permission denied'
);
select public.test_denied(
  $q$select public.list_expired_member_registrations(100)$q$,
  'permission denied'
);
select public.test_denied(
  $q$select public.claim_expired_member_registration('00000000-0000-0000-0000-000000000090')$q$,
  'permission denied'
);
reset role;

select public.test_assert(
  exists (select 1 from public.activity_logs
    where entity_id = '00000000-0000-0000-0000-000000000090'
      and action = 'registration_expired_cleanup' and status = 'failure'),
  'failed cleanup attempts are audited without recording credentials'
);

rollback;
