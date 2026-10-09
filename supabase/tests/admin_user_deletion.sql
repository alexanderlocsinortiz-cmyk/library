\set ON_ERROR_STOP on

select public.test_assert(
  not has_function_privilege('anon', 'public.admin_user_deletion_preflight(uuid,uuid)'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'public.admin_user_deletion_preflight(uuid,uuid)'::regprocedure, 'execute'),
  'browser roles cannot call the account deletion preflight'
);
select public.test_assert(
  not has_function_privilege('anon', 'public.record_admin_user_deletion_failure(uuid,uuid)'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'public.record_admin_user_deletion_failure(uuid,uuid)'::regprocedure, 'execute'),
  'browser roles cannot finalize account deletion attempts'
);
select public.test_assert(
  not has_function_privilege('anon', 'public.admin_user_management_rows()'::regprocedure, 'execute')
  and has_function_privilege('authenticated', 'public.admin_user_management_rows()'::regprocedure, 'execute'),
  'only authenticated users can invoke the admin account RPC; its body enforces administrator role'
);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000901', 'delete-admin@example.edu', now(), '{"full_name":"Deletion Admin"}'),
  ('00000000-0000-0000-0000-000000000902', 'delete-safe@example.edu', null, '{"full_name":"Safe Delete","registration_school_id":"DELETE-SAFE-902"}'),
  ('00000000-0000-0000-0000-000000000903', 'delete-history@example.edu', now(), '{"full_name":"History Account","registration_school_id":"DELETE-HISTORY-903"}'),
  ('00000000-0000-0000-0000-000000000904', 'delete-assist@example.edu', null, '{"full_name":"Assisted Account","registration_school_id":"DELETE-ASSIST-904"}'),
  ('00000000-0000-0000-0000-000000000905', 'delete-race@example.edu', null, '{"full_name":"Race Account","registration_school_id":"DELETE-RACE-905"}'),
  ('00000000-0000-0000-0000-000000000906', 'delete-failure@example.edu', now(), '{"full_name":"Failure Account"}'),
  ('00000000-0000-0000-0000-000000000907', 'delete-other-admin@example.edu', now(), '{"full_name":"Other Administrator"}');
update public.profiles set role = 'administrator'
where id in ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000907');

insert into public.books (id, title, author)
values ('20000000-0000-0000-0000-000000000901', 'Deletion Guard Test', 'Library Test')
on conflict (id) do nothing;
insert into public.library_members (id, full_name, school_id, member_type, auth_user_id)
values
  ('00000000-0000-0000-0000-000000000903', 'History Account', 'DELETE-HISTORY-903', 'student', '00000000-0000-0000-0000-000000000903'),
  ('00000000-0000-0000-0000-000000000905', 'Race Account', 'DELETE-RACE-905', 'student', '00000000-0000-0000-0000-000000000905');
insert into public.reservations (
  book_id, member_id, borrower_type, borrower_full_name, student_employee_id, reservation_date
) values (
  '20000000-0000-0000-0000-000000000901',
  '00000000-0000-0000-0000-000000000903',
  'student', 'History Account', 'DELETE-HISTORY-903', current_date
);
insert into public.member_verification_assistance_requests (
  user_id, full_name_snapshot, email_snapshot, school_id_snapshot
) values (
  '00000000-0000-0000-0000-000000000904', 'Assisted Account',
  'delete-assist@example.edu', 'DELETE-ASSIST-904'
);
insert into public.activity_logs (
  actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module, description, entity_type, entity_id
) values (
  '00000000-0000-0000-0000-000000000905', 'Race Account', 'member', 'login_success',
  'authentication', 'Signed in successfully.', 'account', '00000000-0000-0000-0000-000000000905'
);

set role authenticated;
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000901';
select public.test_assert(
  (select count(*) from public.admin_user_management_rows()) >= 7,
  format('the administrator RPC returns actual profiles and safe Auth fields (received %s)', (select count(*) from public.admin_user_management_rows()))
);
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000902';
select public.test_denied(
  $q$select count(*) from public.admin_user_management_rows()$q$,
  'Administrator access required'
);
reset role;

set role service_role;
select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000901'
  )->>'code' = 'cannot_delete_self',
  'an administrator cannot delete the currently signed-in account'
);
select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000903'
  )->>'code' = 'library_history_exists',
  'accounts with reservation history are preserved'
);
with result as (select public.admin_user_deletion_preflight(
  '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000907'
) as value)
select public.test_assert(
  value->>'allowed' = 'true',
  format('an administrator can be deleted while another active administrator remains: %s', value)
) from result;
select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000907', '00000000-0000-0000-0000-000000000901'
  )->>'code' = 'admin_required',
  'an administrator already claimed for deletion cannot concurrently delete the remaining administrator'
);
select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000904'
  )->>'code' = 'verification_assistance_open',
  'accounts under active identity assistance are preserved'
);
select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902'
  )->>'allowed' = 'true',
  'an administrator may claim deletion of an unlinked account without history'
);
reset role;

select public.test_denied(
  $q$update public.profiles set role = 'librarian' where id = '00000000-0000-0000-0000-000000000902'$q$,
  'being deleted'
);
select public.test_denied(
  $q$insert into public.member_verification_assistance_requests (user_id, full_name_snapshot, email_snapshot, school_id_snapshot)
    values ('00000000-0000-0000-0000-000000000902', 'Safe Delete', 'delete-safe@example.edu', 'DELETE-SAFE-902')$q$,
  'being deleted'
);
reset role;
delete from auth.users where id = '00000000-0000-0000-0000-000000000902';
select public.test_assert(
  not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-000000000902')
  and not exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-000000000902'),
  'Auth and application profile are deleted together'
);
select public.test_assert(
  not exists (select 1 from public.pending_member_registrations where user_id = '00000000-0000-0000-0000-000000000902')
  and not exists (select 1 from public.registration_resend_limits where user_id = '00000000-0000-0000-0000-000000000902')
  and not exists (select 1 from public.admin_account_deletion_claims where target_user_id = '00000000-0000-0000-0000-000000000902'),
  'successful deletion removes only transient registration state and its claim'
);
select public.test_assert(
  exists (select 1 from public.activity_logs where action = 'user_account_deleted' and entity_id = '00000000-0000-0000-0000-000000000902' and status = 'success'),
  'successful account deletion is written to the immutable activity log'
);
select public.test_assert(
  exists (select 1 from public.activity_logs where action = 'login_success' and entity_id = '00000000-0000-0000-0000-000000000905'),
  'deleting one account does not remove historical activity records'
);

set role service_role;
select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000905'
  )->>'allowed' = 'true',
  'an unlinked account without history can be claimed'
);
reset role;
select public.test_denied(
  $q$insert into public.reservations (book_id, member_id, borrower_type, borrower_full_name, reservation_date)
    values ('20000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000905', 'student', 'Race Account', current_date)$q$,
  'being deleted'
);
set role service_role;
select public.record_admin_user_deletion_failure(
  '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000905'
);
select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000905'
  )->>'allowed' = 'true'
  and exists (select 1 from public.activity_logs where action = 'user_account_deletion_failed' and entity_id = '00000000-0000-0000-0000-000000000905' and status = 'failure'),
  'failed deletion releases the claim and records a failure'
);
select public.record_admin_user_deletion_failure(
  '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000905'
);
reset role;

select public.test_assert(
  public.admin_user_deletion_preflight(
    '00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-000000000906'
  )->>'code' = 'admin_required',
  'non-administrator identity cannot authorize deletion'
);

drop function public.test_assert(boolean, text);
drop function public.test_denied(text, text);
