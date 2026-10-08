\set ON_ERROR_STOP on

select public.test_assert(not has_function_privilege('anon', 'public.admin_activity_logs(text,text,text,text,date,date,text,integer)'::regprocedure, 'execute'), 'anonymous users cannot execute the activity log query');
select public.test_assert(not has_table_privilege('authenticated', 'public.activity_logs', 'insert, update, delete'), 'authenticated users cannot change activity records');

insert into public.audit_logs(actor_id, action, entity_type, details)
values ('00000000-0000-0000-0000-000000000001', 'inventory_audit_start', 'inventory_audit', '{}'::jsonb);
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'inventory_audit_started'), 'inventory audit starts are recorded without copying arbitrary details');

set role anon;
select public.test_denied('select id from public.activity_logs limit 1', 'permission denied');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select public.test_assert((select count(*) = 0 from public.activity_logs), 'members cannot view activity records through the table API');
select public.test_denied('select public.admin_activity_logs()', 'Administrator access required');
select public.test_denied('insert into public.activity_logs(actor_name_snapshot,actor_role_snapshot,action,module,description) values (''forged'',''administrator'',''login_success'',''authentication'',''forged'')', 'permission denied');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select public.test_assert((select count(*) > 0 from public.activity_logs), 'administrator can read generated activity records');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'book_added'), 'book additions are logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'member_registered'), 'member registration is logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'reservation_created'), 'reservation creation is logged by the database');
select public.test_assert((select actor_name_snapshot = 'Walk-in Student' and actor_role_snapshot = 'member'
  from public.activity_logs
  where action = 'reservation_created'
    and entity_id = (select id from public.reservations where book_id = '20000000-0000-0000-0000-000000000006' and member_id = (select id from public.library_members where library_card_number = 'CARD-WALKIN-1') order by created_at desc limit 1)),
  'card-and-PIN reservations snapshot the validated member as actor');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'reservation_cancelled'), 'reservation cancellation is logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'reservation_completed'), 'reservation completion is logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'reservation_expired'), 'reservation expiry is logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'book_borrowed'), 'checkout is logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'book_returned'), 'returns are logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'due_date_updated'), 'due date changes are logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'overdue_status_changed'), 'overdue status changes are logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'user_role_changed'), 'role changes are logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'system_setting_changed'), 'system setting changes are logged by the database');
select public.test_assert((select count(*) > 0 from public.activity_logs where action = 'copy_added'), 'physical copy additions are logged by the database');
select public.test_assert(not exists (
  select 1 from public.activity_logs a
  where coalesce(a.old_values::text, '') ~* '(password|token|secret|pin)'
    or coalesce(a.new_values::text, '') ~* '(password|token|secret|pin)'
), 'stored value snapshots do not expose password or PIN values');
select public.test_assert((public.admin_activity_logs())->>'total' is not null, 'administrator API returns paginated records');
select public.test_assert(jsonb_array_length((public.admin_activity_logs())->'records') <= 10, 'administrator API limits pages to ten rows');
select public.test_denied('update public.activity_logs set description = ''tampered''', 'permission denied');
select public.test_denied('delete from public.activity_logs', 'permission denied');
reset role;
