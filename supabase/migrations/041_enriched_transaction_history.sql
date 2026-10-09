-- Enrich the circulation history view from its linked records. Existing audit
-- rows are read as-is; this migration does not rewrite historical events.

-- New events receive point-in-time values from the row written by the
-- circulation action immediately before its audit insert. Old audit rows are
-- deliberately left unchanged.
create or replace function public.capture_circulation_transaction_snapshot()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  loan_row public.loans%rowtype;
  reservation_row public.reservations%rowtype;
  queue_position bigint;
begin
  if new.entity_id is null then return new; end if;
  new.details := coalesce(new.details, '{}'::jsonb);

  if new.entity_type = 'loan' then
    select * into loan_row from public.loans where id = new.entity_id;
    if found then
      if new.action = 'checkout' then
        new.details := new.details || jsonb_build_object(
          'checkout_date', loan_row.checked_out_at,
          'due_at', loan_row.due_at,
          'status_at_event', loan_row.status::text
        );
      elsif new.action = 'return' then
        new.details := new.details || jsonb_build_object(
          'return_date', loan_row.returned_at,
          'due_at', loan_row.due_at,
          'overdue_at_return', case
            when loan_row.returned_at is not null and loan_row.due_at is not null
              then loan_row.returned_at > loan_row.due_at
            else null
          end,
          'fine_amount', loan_row.fine_amount,
          'status_at_event', loan_row.status::text
        );
      elsif new.action = 'renew' then
        new.details := new.details || jsonb_build_object(
          'due_at', loan_row.due_at,
          'status_at_event', loan_row.status::text
        );
      end if;
    end if;
  elsif new.entity_type = 'reservation' then
    select * into reservation_row from public.reservations where id = new.entity_id;
    if found then
      new.details := new.details || jsonb_build_object(
        'reservation_date', reservation_row.reservation_date,
        'status_at_event', reservation_row.status::text
      );
      if reservation_row.pickup_expires_at is not null then
        new.details := new.details || jsonb_build_object('pickup_expires_at', reservation_row.pickup_expires_at);
      end if;
      if new.action in ('reserve', 'reservation_approved', 'walk_in_reservation_create')
        and reservation_row.staff_approved_at is not null then
        select count(*) into queue_position
        from public.reservations queued
        where queued.book_id = reservation_row.book_id
          and queued.status = 'waiting'
          and queued.staff_approved_at is not null
          and (queued.created_at, queued.id) <= (reservation_row.created_at, reservation_row.id);
        new.details := new.details || jsonb_build_object('queue_position', queue_position);
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.capture_circulation_transaction_snapshot() from public, anon, authenticated;
drop trigger if exists capture_circulation_transaction_snapshot on public.audit_logs;
create trigger capture_circulation_transaction_snapshot
before insert on public.audit_logs
for each row execute function public.capture_circulation_transaction_snapshot();

drop function if exists public.transaction_history(text, integer, integer);

create function public.transaction_history(
  p_query text default '',
  p_page integer default 0,
  p_size integer default 6,
  p_action text default '',
  p_sort text default 'newest'
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Staff access required';
  end if;
  if p_page is null or p_page < 0 or p_page > 1000000
    or p_size is null or p_size not between 1 and 100
    or length(coalesce(p_query, '')) > 200
    or length(coalesce(p_action, '')) > 80
    or coalesce(p_sort, '') not in ('newest', 'oldest') then
    raise exception 'Invalid page or sort';
  end if;

  with events as (
    select a.*,
      case
        when a.details->>'copy_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (a.details->>'copy_id')::uuid
        else null
      end as logged_copy_id
    from public.audit_logs a
    where a.entity_type in ('loan', 'reservation')
  ), linked as (
    select e.id as transaction_id,
      e.action,
      e.created_at as transaction_at,
      e.entity_type,
      e.entity_id,
      e.details,
      l.id as loan_id,
      r.id as reservation_id,
      case when e.entity_type = 'loan' then l.member_id else r.member_id end as member_id,
      case
        when e.entity_type = 'loan' then l.copy_id
        else e.logged_copy_id
      end as event_copy_id,
      case
        when e.entity_type = 'loan' then c_loan.book_id
        else r.book_id
      end as book_id,
      case
        when e.entity_type = 'loan' then m_loan.full_name
        when r.member_id is null then nullif(btrim(r.borrower_full_name), '')
        else m_reservation.full_name
      end as member_name,
      case when e.entity_type = 'reservation' and r.member_id is null
        then 'walk_in_snapshot' else 'library_member_record' end as member_source,
      case
        when e.entity_type = 'loan' then l.status::text
        else r.status::text
      end as current_record_status,
      case when e.entity_type = 'loan' then coalesce(e.details->>'checkout_date', l.checked_out_at::text) else null end as checkout_date,
      case when e.entity_type = 'loan' then coalesce(e.details->>'due_at', l.due_at::text) else null end as due_date,
      case when e.entity_type = 'loan' then coalesce(e.details->>'return_date', l.returned_at::text) else null end as return_date,
      case when e.entity_type = 'loan' and jsonb_typeof(e.details->'overdue_at_return') = 'boolean'
        then (e.details->>'overdue_at_return')::boolean
        when e.entity_type = 'loan' and l.returned_at is not null and l.due_at is not null
          then l.returned_at > l.due_at
        else null end as overdue_at_return,
      case when e.entity_type = 'loan' then e.details->>'fine_amount' else null end as recorded_fine_amount,
      case when e.entity_type = 'reservation' then coalesce(nullif(e.details->>'reservation_date', '')::date, r.reservation_date) else null end as reservation_date,
      e.details->'queue_position' as recorded_queue_position,
      case
        when e.entity_type <> 'reservation' then null
        when e.details ? 'pickup_expires_at' then e.details->>'pickup_expires_at'
        when e.details ? 'pickup_deadline' then e.details->>'pickup_deadline'
        when e.action in ('pickup_ready', 'reservation_pickup_confirmed')
          and r.status = 'ready_for_pickup' then r.pickup_expires_at::text
        else null
      end as pickup_deadline,
      case
        when e.entity_type = 'reservation'
          and not (e.details ? 'pickup_expires_at' or e.details ? 'pickup_deadline')
          and e.action in ('pickup_ready', 'reservation_pickup_confirmed')
          and r.status = 'ready_for_pickup' and r.pickup_expires_at is not null then true
        else false
      end as pickup_deadline_is_current,
      case when e.entity_type = 'reservation'
        then coalesce(nullif(e.details->>'cancellation_reason', ''), nullif(e.details->>'reason', ''))
        else null end as cancellation_reason,
      e.actor_id,
      actor.full_name as linked_actor_name,
      actor.role::text as linked_actor_role,
      case
        when e.action in ('expired', 'pickup_ready', 'pickup_assigned_pending_confirmation')
          then 'system_automated'
        when e.details->>'source' = 'card_pin' and e.action in ('reserve', 'cancel')
          then 'member_self_service'
        when actor.role = 'administrator' then 'administrator'
        when actor.role = 'librarian' then 'librarian'
        when actor.role = 'member' then 'member_self_service'
        else 'not_recorded'
      end as actor_type,
      case
        when e.action in ('expired', 'pickup_ready', 'pickup_assigned_pending_confirmation')
          then 'System (Automated)'
        when e.details->>'source' = 'card_pin' and e.action in ('reserve', 'cancel')
          then 'Card/PIN self-service'
        when actor.role in ('administrator', 'librarian', 'member') then actor.full_name
        else null
      end as actor_name,
      case
        when e.entity_type = 'loan' then nullif(btrim(verified_profile.school_id), '')
        when r.member_id is not null then nullif(btrim(verified_reservation_profile.school_id), '')
        else null
      end as verified_school_id,
      e.details->>'status_at_event' as status_at_event
    from events e
    left join public.loans l on e.entity_type = 'loan' and l.id = e.entity_id
    left join public.book_copies c_loan on c_loan.id = l.copy_id
    left join public.library_members m_loan on m_loan.id = l.member_id
    left join public.profiles verified_profile on verified_profile.id = m_loan.auth_user_id
      and (
        verified_profile.library_identity_verified_at is not null
        or exists (
          select 1 from public.school_id_invitations invitation
          where lower(invitation.school_id) = lower(verified_profile.school_id)
            and invitation.purpose = 'signup' and invitation.consumed_at is not null
        )
      )
    left join public.reservations r on e.entity_type = 'reservation' and r.id = e.entity_id
    left join public.library_members m_reservation on m_reservation.id = r.member_id
    left join public.profiles verified_reservation_profile on verified_reservation_profile.id = m_reservation.auth_user_id
      and (
        verified_reservation_profile.library_identity_verified_at is not null
        or exists (
          select 1 from public.school_id_invitations invitation
          where lower(invitation.school_id) = lower(verified_reservation_profile.school_id)
            and invitation.purpose = 'signup' and invitation.consumed_at is not null
        )
      )
    left join public.profiles actor on actor.id = e.actor_id
  ), history as (
    select linked.*,
      b.title as book_title,
      c.barcode,
      case when c.id is not null then c.id else linked.event_copy_id end as internal_copy_id,
      (linked.details->>'queue_position') is not null as queue_position_was_recorded,
      case when linked.entity_type = 'reservation' and linked.status_at_event is not null
        then linked.status_at_event else linked.current_record_status end as reservation_status,
      (linked.entity_type = 'reservation' and linked.status_at_event is null) as reservation_status_is_current,
      (linked.entity_type = 'loan' and not (linked.details ? 'due_at')) as due_date_is_current,
      case when linked.entity_type = 'reservation'
        then coalesce(linked.details->>'pickup_expires_at', linked.details->>'pickup_deadline', linked.pickup_deadline)
        else null end as displayed_pickup_deadline
    from linked
    left join public.books b on b.id = linked.book_id
    left join public.book_copies c on c.id = linked.event_copy_id and c.book_id = linked.book_id
  ), filtered as (
    select * from history
    where (coalesce(p_action, '') = '' or action = p_action)
      and strpos(lower(concat_ws(' ', action, member_name, verified_school_id,
        book_title, barcode, internal_copy_id::text,
        entity_id::text, transaction_id::text, actor_name)), lower(coalesce(p_query, ''))) > 0
  ), page_rows as (
    select * from filtered
    order by
      case when p_sort = 'newest' then transaction_at end desc,
      case when p_sort = 'oldest' then transaction_at end asc,
      transaction_id desc
    limit p_size offset p_page * p_size
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'page', p_page,
    'page_size', p_size,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'transaction_id', transaction_id,
        'action', action,
        'transaction_at', transaction_at,
        'entity_type', entity_type,
        'entity_id', entity_id,
        'member_id', member_id,
        'member_name', member_name,
        'member_source', member_source,
        'verified_school_id', verified_school_id,
        'book_title', book_title,
        'barcode', barcode,
        'internal_copy_id', internal_copy_id,
        'actor_id', actor_id,
        'actor_name', actor_name,
        'actor_type', actor_type,
        'current_record_status', current_record_status,
        'checkout_date', checkout_date,
        'due_date', due_date,
        'due_date_is_current', due_date_is_current,
        'return_status', case when entity_type = 'loan' then current_record_status else null end,
        'return_date', return_date,
        'overdue_at_return', overdue_at_return,
        'recorded_fine_amount', recorded_fine_amount,
        'reservation_date', reservation_date,
        'queue_position', case when queue_position_was_recorded then details->'queue_position' else null end,
        'pickup_deadline', displayed_pickup_deadline,
        'pickup_deadline_is_current', pickup_deadline_is_current,
        'reservation_status', case when entity_type = 'reservation' then reservation_status else null end,
        'reservation_status_is_current', reservation_status_is_current,
        'cancellation_date', case when action = 'cancel' then transaction_at else null end,
        'cancellation_reason', cancellation_reason,
        'cancellation_actor_name', case when action = 'cancel' then actor_name else null end,
        'cancellation_actor_type', case when action = 'cancel' then actor_type else null end
      ) order by
        case when p_sort = 'newest' then transaction_at end desc,
        case when p_sort = 'oldest' then transaction_at end asc,
        transaction_id desc)
      from page_rows
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.transaction_history(text, integer, integer, text, text) from public, anon;
grant execute on function public.transaction_history(text, integer, integer, text, text) to authenticated;

notify pgrst, 'reload schema';
