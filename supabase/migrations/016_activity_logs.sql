-- Administrator-only, append-only activity history. Existing audit_logs remain
-- intact and are copied into this readable activity stream during migration.
create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  actor_name_snapshot text not null,
  actor_role_snapshot text not null,
  action text not null,
  module text not null,
  description text not null,
  entity_type text,
  entity_id uuid,
  status text not null default 'success' check (status in ('success', 'failure')),
  old_values jsonb,
  new_values jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

alter table public.activity_logs enable row level security;
revoke all on public.activity_logs from anon, authenticated;
grant select on public.activity_logs to authenticated;
grant select, insert on public.activity_logs to service_role;
revoke update, delete, truncate, references, trigger on public.activity_logs from anon, authenticated, service_role;
create policy "administrators can view activity logs"
  on public.activity_logs for select to authenticated
  using (public.is_admin());

create index activity_logs_created_id on public.activity_logs (created_at desc, id desc);
create index activity_logs_role_created on public.activity_logs (actor_role_snapshot, created_at desc);
create index activity_logs_module_created on public.activity_logs (module, created_at desc);
create index activity_logs_action_created on public.activity_logs (action, created_at desc);
create index activity_logs_status_created on public.activity_logs (status, created_at desc);
create index activity_logs_search on public.activity_logs using gin (
  to_tsvector('simple', coalesce(actor_name_snapshot, '') || ' ' || description)
);

create function public.activity_log_actor(p_user_id uuid)
returns table(actor_name text, actor_role text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(p.full_name, case when p.id is null then 'Former user' else 'Library user' end),
         coalesce(p.role::text, 'unknown')
  from (select p_user_id as id) requested
  left join public.profiles p on p.id = requested.id;
$$;
revoke all on function public.activity_log_actor(uuid) from public, anon, authenticated;

create function public.capture_activity_row_change()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
  v_guest_actor_name text;
  v_action text;
  v_module text;
  v_description text;
  v_entity_type text := tg_table_name;
  v_entity_id uuid;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old_values jsonb;
  v_new_values jsonb;
  v_changed boolean := false;
begin
  if tg_table_name = 'books' then
    v_entity_id := case when tg_op = 'DELETE' then old.id else new.id end;
    if tg_op = 'INSERT' then
      v_action := 'book_added'; v_description := 'Added a book.'; v_changed := true;
    elsif tg_op = 'DELETE' then
      v_action := 'book_deleted'; v_description := 'Deleted a book.'; v_changed := true;
    elsif (old.title, old.author, old.isbn, old.category, old.publication_year, old.description, old.cover_url)
       is distinct from
       (new.title, new.author, new.isbn, new.category, new.publication_year, new.description, new.cover_url) then
      v_action := 'book_updated'; v_description := 'Updated a book record.'; v_changed := true;
    end if;
    v_module := 'books';
    if tg_op <> 'INSERT' then
      v_old_values := jsonb_build_object('title', old.title, 'author', old.author, 'category', old.category, 'publication_year', old.publication_year);
    end if;
    if tg_op <> 'DELETE' then
      v_new_values := jsonb_build_object('title', new.title, 'author', new.author, 'category', new.category, 'publication_year', new.publication_year);
    end if;
  elsif tg_table_name = 'book_copies' then
    v_entity_id := case when tg_op = 'DELETE' then old.id else new.id end;
    v_module := 'copies';
    if tg_op = 'INSERT' then
      v_action := 'copy_added'; v_description := 'Added a physical copy.'; v_changed := true;
    elsif tg_op = 'DELETE' then
      v_action := 'copy_removed'; v_description := 'Removed a physical copy.'; v_changed := true;
    elsif (old.book_id, old.barcode, old.location, old.condition)
       is distinct from (new.book_id, new.barcode, new.location, new.condition) then
      v_action := 'copy_updated'; v_description := 'Updated a physical copy.'; v_changed := true;
    end if;
    if tg_op <> 'INSERT' then
      v_old_values := jsonb_build_object('book_id', old.book_id, 'barcode', old.barcode, 'location', old.location, 'condition', old.condition);
    end if;
    if tg_op <> 'DELETE' then
      v_new_values := jsonb_build_object('book_id', new.book_id, 'barcode', new.barcode, 'location', new.location, 'condition', new.condition);
    end if;
  elsif tg_table_name = 'reservations' then
    v_entity_id := case when tg_op = 'DELETE' then old.id else new.id end;
    v_module := 'reservations';
    if tg_op = 'INSERT' then
      v_action := 'reservation_created'; v_description := 'Created a reservation.'; v_changed := true;
    elsif tg_op = 'DELETE' then
      v_action := 'reservation_removed'; v_description := 'Removed a reservation record.'; v_changed := true;
    elsif old.status is distinct from new.status then
      v_action := case new.status
        when 'cancelled' then 'reservation_cancelled'
        when 'completed' then 'reservation_completed'
        when 'expired' then 'reservation_expired'
        when 'ready_for_pickup' then 'reservation_ready'
        else 'reservation_updated' end;
      v_description := case v_action
        when 'reservation_cancelled' then 'Cancelled a reservation.'
        when 'reservation_completed' then 'Completed a reservation.'
        when 'reservation_expired' then 'Reservation expired.'
        when 'reservation_ready' then 'Marked a reservation ready for pickup.'
        else 'Updated a reservation.' end;
      v_changed := true;
    elsif (old.book_id, old.member_id, old.reservation_date, old.expected_pickup_date, old.notes)
       is distinct from (new.book_id, new.member_id, new.reservation_date, new.expected_pickup_date, new.notes) then
      v_action := 'reservation_updated'; v_description := 'Updated a reservation.'; v_changed := true;
    end if;
    if tg_op <> 'INSERT' then
      v_old_values := jsonb_build_object('status', old.status, 'book_id', old.book_id, 'reservation_date', old.reservation_date, 'expected_pickup_date', old.expected_pickup_date);
    end if;
    if tg_op <> 'DELETE' then
      v_new_values := jsonb_build_object('status', new.status, 'book_id', new.book_id, 'reservation_date', new.reservation_date, 'expected_pickup_date', new.expected_pickup_date);
    end if;
  elsif tg_table_name = 'loans' then
    v_entity_id := case when tg_op = 'DELETE' then old.id else new.id end;
    v_module := 'borrowing';
    if tg_op = 'INSERT' then
      v_action := 'book_borrowed'; v_description := 'Checked out a book.'; v_changed := true;
    elsif tg_op = 'DELETE' then
      v_action := 'borrowing_transaction_cancelled'; v_description := 'Removed a borrowing transaction.'; v_changed := true;
    elsif old.status is distinct from new.status then
      v_action := case new.status
        when 'returned' then 'book_returned'
        when 'overdue' then 'overdue_status_changed'
        else 'borrowing_status_changed' end;
      v_description := case v_action
        when 'book_returned' then 'Processed a book return.'
        when 'overdue_status_changed' then 'Changed the overdue status of a loan.'
        else 'Changed a borrowing transaction status.' end;
      v_changed := true;
    elsif old.due_at is distinct from new.due_at then
      v_action := 'due_date_updated'; v_description := 'Updated a loan due date.'; v_changed := true;
    end if;
    if tg_op <> 'INSERT' then
      v_old_values := jsonb_build_object('status', old.status, 'due_at', old.due_at);
    end if;
    if tg_op <> 'DELETE' then
      v_new_values := jsonb_build_object('status', new.status, 'due_at', new.due_at);
    end if;
  elsif tg_table_name = 'profiles' then
    v_entity_id := case when tg_op = 'DELETE' then old.id else new.id end;
    v_entity_type := 'account'; v_module := 'authentication';
    if tg_op = 'INSERT' then
      v_action := 'account_created'; v_description := 'Created an account.'; v_changed := true;
      if v_actor_id is null then v_actor_id := new.id; end if;
    elsif tg_op = 'DELETE' then
      v_action := 'account_deactivated'; v_description := 'Removed an account profile.'; v_changed := true;
    elsif old.role is distinct from new.role then
      v_action := 'user_role_changed'; v_description := 'Changed a user role.'; v_changed := true;
    elsif old.full_name is distinct from new.full_name then
      v_action := 'account_updated'; v_description := 'Updated account information.'; v_changed := true;
    end if;
    if tg_op <> 'INSERT' then v_old_values := jsonb_build_object('role', old.role); end if;
    if tg_op <> 'DELETE' then v_new_values := jsonb_build_object('role', new.role); end if;
  elsif tg_table_name = 'library_members' then
    v_entity_id := case when tg_op = 'DELETE' then old.id else new.id end;
    v_entity_type := 'library_member'; v_module := 'members';
    if tg_op = 'INSERT' then
      v_action := 'member_registered'; v_description := 'Registered a library member.'; v_changed := true;
    elsif tg_op = 'DELETE' then
      v_action := 'member_deactivated'; v_description := 'Removed a library member record.'; v_changed := true;
    elsif old.is_active is distinct from new.is_active and not new.is_active then
      v_action := 'member_deactivated'; v_description := 'Deactivated a library member account.'; v_changed := true;
    elsif (old.library_card_number is not null) is distinct from (new.library_card_number is not null) then
      v_action := 'card_verification_changed'; v_description := 'Changed library card verification.'; v_changed := true;
    elsif (old.full_name, old.school_id, old.member_type, old.is_active, old.auth_user_id)
       is distinct from (new.full_name, new.school_id, new.member_type, new.is_active, new.auth_user_id) then
      v_action := 'member_updated'; v_description := 'Updated member information.'; v_changed := true;
    end if;
    if tg_op <> 'INSERT' then
      v_old_values := jsonb_build_object('member_type', old.member_type, 'active', old.is_active, 'card_verified', old.library_card_number is not null);
    end if;
    if tg_op <> 'DELETE' then
      v_new_values := jsonb_build_object('member_type', new.member_type, 'active', new.is_active, 'card_verified', new.library_card_number is not null);
    end if;
  elsif tg_table_name = 'system_settings' then
    v_entity_id := null; v_entity_type := 'system_setting'; v_module := 'administration';
    if tg_op = 'INSERT' then
      v_action := 'system_setting_changed'; v_description := 'Added a circulation setting.'; v_changed := true;
      v_new_values := jsonb_build_object('key', new.key, 'value', new.value);
    elsif tg_op = 'DELETE' then
      v_action := 'system_setting_changed'; v_description := 'Removed a circulation setting.'; v_changed := true;
      v_old_values := jsonb_build_object('key', old.key, 'value', old.value);
    elsif old.value is distinct from new.value then
      v_action := 'system_setting_changed'; v_description := 'Changed a circulation setting.'; v_changed := true;
      v_old_values := jsonb_build_object('key', old.key, 'value', old.value);
      v_new_values := jsonb_build_object('key', new.key, 'value', new.value);
    end if;
  end if;

  if not v_changed then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  -- Card-and-PIN holds are authenticated without a Supabase session. The
  -- reservation member was validated by the server RPC, so snapshot that
  -- borrower for those create/cancel actions instead of mislabeling them System.
  if v_actor_id is null and tg_table_name = 'reservations' and tg_op <> 'DELETE'
    and v_action in ('reservation_created', 'reservation_cancelled') then
    select m.auth_user_id, m.full_name into v_actor_id, v_guest_actor_name
      from public.library_members m where m.id = new.member_id;
  end if;
  select a.actor_name, a.actor_role into v_actor_name, v_actor_role
    from public.activity_log_actor(v_actor_id) a;
  if v_actor_id is null then v_actor_name := 'System'; v_actor_role := 'system'; end if;
  if v_guest_actor_name is not null and v_actor_id is null then
    v_actor_name := v_guest_actor_name; v_actor_role := 'member';
  end if;
  if tg_table_name = 'profiles' and tg_op = 'INSERT' then
    if v_actor_id = new.id then
      v_actor_name := coalesce(new.full_name, 'New account'); v_actor_role := new.role::text;
    end if;
  end if;

  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, old_values, new_values
  ) values (
    v_actor_id, coalesce(v_actor_name, 'Unknown user'), coalesce(v_actor_role, 'unknown'),
    v_action, v_module, v_description, v_entity_type, v_entity_id,
    'success', v_old_values, v_new_values
  );
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.capture_activity_row_change() from public, anon, authenticated;

create trigger activity_books_change after insert or update or delete on public.books
  for each row execute function public.capture_activity_row_change();
create trigger activity_book_copies_change after insert or update or delete on public.book_copies
  for each row execute function public.capture_activity_row_change();
create trigger activity_reservations_change after insert or update or delete on public.reservations
  for each row execute function public.capture_activity_row_change();
create trigger activity_loans_change after insert or update or delete on public.loans
  for each row execute function public.capture_activity_row_change();
create trigger activity_profiles_change after insert or update or delete on public.profiles
  for each row execute function public.capture_activity_row_change();
create trigger activity_library_members_change after insert or update or delete on public.library_members
  for each row execute function public.capture_activity_row_change();
create trigger activity_system_settings_change after insert or update or delete on public.system_settings
  for each row execute function public.capture_activity_row_change();

create function public.capture_legacy_activity_log()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor_name text;
  v_actor_role text;
  v_module text;
  v_action text;
  v_description text;
  v_new_values jsonb;
begin
  -- Entity triggers are the source of truth for these workflows. This trigger
  -- only translates older RPC audit entries that have no corresponding row event.
  if new.action in (
    'checkout', 'return', 'renew', 'reserve', 'walk_in_reservation_create',
    'reservation_edit', 'cancel', 'expired', 'pickup_ready', 'role_change',
    'member_register', 'member_update', 'delete'
  ) then return new; end if;

  v_action := case new.action
    when 'issue_school_invitation' then 'account_permissions_updated'
    when 'consume_recovery' then 'recovery_invitation_consumed'
    when 'member_account_link' then 'account_updated'
    when 'reservation_pin_set' then 'reservation_access_pin_reset'
    when 'book_request_record' then 'book_request_recorded'
    when 'book_request_update' then 'book_request_updated'
    when 'inventory_audit_complete' then 'inventory_audit_completed'
    else null end;
  if v_action is null then return new; end if;

  v_module := case
    when new.entity_type = 'book_request' or new.entity_type = 'inventory_audit' then 'inventory'
    when new.entity_type = 'library_member' then 'members'
    when new.entity_type = 'reservation' then 'reservations'
    when new.action = 'consume_recovery' then 'authentication'
    else 'administration' end;
  v_description := case v_action
    when 'account_permissions_updated' then 'Issued an account invitation or recovery code.'
    when 'recovery_invitation_consumed' then 'Used an account recovery invitation.'
    when 'account_updated' then 'Linked a library member account.'
    when 'reservation_access_pin_reset' then 'Reset online reservation access.'
    when 'book_request_recorded' then 'Recorded a book request.'
    when 'book_request_updated' then 'Updated a book request.'
    when 'inventory_audit_completed' then 'Completed a stock audit.'
    else 'Updated an administrative record.' end;
  if new.action = 'role_change' then
    v_action := 'user_role_changed'; v_module := 'administration'; v_description := 'Changed a user role.';
    v_new_values := jsonb_build_object('from', new.details -> 'from', 'to', new.details -> 'to');
  elsif new.action = 'book_request_update' then
    v_new_values := jsonb_build_object('from_status', new.details -> 'from', 'to_status', new.details -> 'to');
  elsif new.action = 'issue_school_invitation' then
    v_new_values := jsonb_build_object('purpose', new.details -> 'purpose');
  end if;

  select a.actor_name, a.actor_role into v_actor_name, v_actor_role
    from public.activity_log_actor(new.actor_id) a;
  if new.actor_id is null then v_actor_name := 'System'; v_actor_role := 'system'; end if;
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, new_values, created_at
  ) values (
    new.actor_id, coalesce(v_actor_name, 'Unknown user'), coalesce(v_actor_role, 'unknown'),
    v_action, v_module, v_description, new.entity_type, new.entity_id,
    'success', v_new_values, new.created_at
  );
  return new;
end;
$$;
revoke all on function public.capture_legacy_activity_log() from public, anon, authenticated;
create trigger activity_legacy_audit_insert after insert on public.audit_logs
  for each row execute function public.capture_legacy_activity_log();

-- Preserve readable history from the existing audit stream. Do not copy its
-- arbitrary details JSON; older functions sometimes include unrelated values.
insert into public.activity_logs (
  id, actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
  description, entity_type, entity_id, status, old_values, new_values, created_at
)
select a.id, a.actor_id,
  coalesce(p.full_name, case when a.actor_id is null then 'System' else 'Former user' end),
  coalesce(p.role::text, case when a.actor_id is null then 'system' else 'unknown' end),
  mapped.action, mapped.module, mapped.description, a.entity_type, a.entity_id,
  'success', mapped.old_values, mapped.new_values, a.created_at
from public.audit_logs a
left join public.profiles p on p.id = a.actor_id
cross join lateral (
  select
    case
      when a.action = 'checkout' then 'book_borrowed'
      when a.action = 'return' then 'book_returned'
      when a.action = 'renew' then 'due_date_updated'
      when a.action = 'overdue' then 'overdue_status_changed'
      when a.action in ('reserve', 'walk_in_reservation_create') then 'reservation_created'
      when a.action = 'reservation_edit' then 'reservation_updated'
      when a.action = 'cancel' and a.entity_type = 'reservation' then 'reservation_cancelled'
      when a.action = 'expired' and a.entity_type = 'reservation' then 'reservation_expired'
      when a.action = 'pickup_ready' then 'reservation_ready'
      when a.action = 'role_change' then 'user_role_changed'
      when a.action = 'member_register' then 'member_registered'
      when a.action = 'member_update' and a.details ->> 'is_active' = 'false' then 'member_deactivated'
      when a.action = 'member_update' then 'member_updated'
      when a.action = 'delete' and a.entity_type = 'book' then 'book_deleted'
      when a.action = 'issue_school_invitation' then 'account_permissions_updated'
      when a.action = 'consume_recovery' then 'recovery_invitation_consumed'
      when a.action = 'member_account_link' then 'account_updated'
      when a.action = 'reservation_pin_set' then 'reservation_access_pin_reset'
      when a.action = 'book_request_record' then 'book_request_recorded'
      when a.action = 'book_request_update' then 'book_request_updated'
      when a.action = 'inventory_audit_complete' then 'inventory_audit_completed'
      else null
    end as action,
    case
      when a.entity_type in ('book_request', 'inventory_audit') then 'inventory'
      when a.entity_type = 'reservation' then 'reservations'
      when a.entity_type = 'loan' then 'borrowing'
      when a.entity_type = 'library_member' then 'members'
      when a.entity_type = 'book' then 'books'
      when a.action = 'consume_recovery' then 'authentication'
      else 'administration'
    end as module,
    case a.action
      when 'checkout' then 'Checked out a book.'
      when 'return' then 'Processed a book return.'
      when 'renew' then 'Updated a loan due date.'
      when 'overdue' then 'Changed the overdue status of a loan.'
      when 'reserve' then 'Created a reservation.'
      when 'walk_in_reservation_create' then 'Registered a walk-in reservation.'
      when 'reservation_edit' then 'Updated a reservation.'
      when 'cancel' then 'Cancelled a reservation.'
      when 'expired' then 'Reservation expired.'
      when 'pickup_ready' then 'Marked a reservation ready for pickup.'
      when 'role_change' then 'Changed a user role.'
      when 'member_register' then 'Registered a library member.'
      when 'member_update' then 'Updated member information.'
      when 'delete' then 'Deleted a book.'
      when 'issue_school_invitation' then 'Issued an account invitation or recovery code.'
      when 'consume_recovery' then 'Used an account recovery invitation.'
      when 'member_account_link' then 'Linked a library member account.'
      when 'reservation_pin_set' then 'Reset online reservation access.'
      when 'book_request_record' then 'Recorded a book request.'
      when 'book_request_update' then 'Updated a book request.'
      when 'inventory_audit_complete' then 'Completed a stock audit.'
      else 'Updated an administrative record.'
    end as description,
    case when a.action = 'role_change'
      then jsonb_build_object('from', a.details -> 'from', 'to', a.details -> 'to')
      when a.action = 'book_request_update'
      then jsonb_build_object('from_status', a.details -> 'from', 'to_status', a.details -> 'to')
      when a.action = 'issue_school_invitation'
      then jsonb_build_object('purpose', a.details -> 'purpose')
      else null end as new_values,
    null::jsonb as old_values
) mapped
where mapped.action is not null
on conflict (id) do nothing;

create function public.admin_activity_logs(
  p_search text default '',
  p_role text default '',
  p_module text default '',
  p_action text default '',
  p_start_date date default null,
  p_end_date date default null,
  p_status text default '',
  p_page integer default 0
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare result jsonb;
begin
  if not coalesce(public.is_admin(), false) then raise exception 'Administrator access required'; end if;
  if p_page is null or p_page < 0 or p_page > 100000
    or length(coalesce(p_search, '')) > 200
    or coalesce(p_role, '') not in ('', 'member', 'librarian', 'administrator', 'system', 'unknown')
    or coalesce(p_status, '') not in ('', 'success', 'failure')
    or (p_start_date is not null and p_end_date is not null and p_end_date < p_start_date)
    or (p_start_date is not null and p_end_date is not null and p_end_date - p_start_date > 3660) then
    raise exception 'Invalid activity log filters';
  end if;
  if coalesce(p_module, '') <> '' and not exists (select 1 from public.activity_logs where module = p_module) then
    raise exception 'Invalid activity module filter';
  end if;
  if coalesce(p_action, '') <> '' and not exists (select 1 from public.activity_logs where action = p_action) then
    raise exception 'Invalid activity type filter';
  end if;

  with filtered as (
    select a.id, a.actor_user_id, a.actor_name_snapshot, a.actor_role_snapshot,
      a.action, a.module, a.description, a.entity_type, a.entity_id, a.status,
      a.old_values, a.new_values, a.ip_address, a.created_at
    from public.activity_logs a
    where (coalesce(p_search, '') = '' or
      to_tsvector('simple', coalesce(a.actor_name_snapshot, '') || ' ' || a.description)
      @@ plainto_tsquery('simple', p_search))
      and (coalesce(p_role, '') = '' or a.actor_role_snapshot = p_role)
      and (coalesce(p_module, '') = '' or a.module = p_module)
      and (coalesce(p_action, '') = '' or a.action = p_action)
      and (coalesce(p_status, '') = '' or a.status = p_status)
      and (p_start_date is null or a.created_at >= (p_start_date::timestamp at time zone 'Asia/Manila'))
      and (p_end_date is null or a.created_at < ((p_end_date + 1)::timestamp at time zone 'Asia/Manila'))
  ),
  page_rows as (
    select * from filtered order by created_at desc, id desc limit 10 offset p_page * 10
  ),
  summary as (
    select count(*) as total,
      count(*) filter (where (created_at at time zone 'Asia/Manila')::date = (now() at time zone 'Asia/Manila')::date) as today,
      count(*) filter (where action = 'login_success' and status = 'success') as successful_logins,
      count(*) filter (where action = 'failed_login' and status = 'failure') as failed_logins
    from public.activity_logs
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'page', p_page,
    'page_size', 10,
    'records', coalesce((select jsonb_agg(to_jsonb(page_rows) order by created_at desc, id desc) from page_rows), '[]'::jsonb),
    'summary', (select to_jsonb(summary) from summary),
    'roles', coalesce((select jsonb_agg(role order by role) from (select distinct actor_role_snapshot as role from public.activity_logs) role_values), '[]'::jsonb),
    'modules', coalesce((select jsonb_agg(module order by module) from (select distinct module from public.activity_logs) module_values), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(action order by action) from (select distinct action from public.activity_logs) action_values), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_activity_logs(text, text, text, text, date, date, text, integer) from public, anon;
grant execute on function public.admin_activity_logs(text, text, text, text, date, date, text, integer) to authenticated;

create function public.record_activity_logout()
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor_name text; v_actor_role text;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  select a.actor_name, a.actor_role into v_actor_name, v_actor_role
    from public.activity_log_actor(auth.uid()) a;
  insert into public.activity_logs (
    actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status
  ) values (
    auth.uid(), coalesce(v_actor_name, 'Library user'), coalesce(v_actor_role, 'unknown'),
    'logout', 'authentication', 'Signed out.', 'account', auth.uid(), 'success'
  );
end;
$$;
revoke all on function public.record_activity_logout() from public, anon;
grant execute on function public.record_activity_logout() to authenticated;
