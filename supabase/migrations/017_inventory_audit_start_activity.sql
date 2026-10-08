-- Inventory audit starts predate the activity stream and are written only to
-- audit_logs, so translate them without exposing their unfiltered details.
create function public.capture_inventory_audit_start_activity()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor_name text;
  v_actor_role text;
begin
  if new.action <> 'inventory_audit_start' then return new; end if;

  select a.actor_name, a.actor_role into v_actor_name, v_actor_role
    from public.activity_log_actor(new.actor_id) a;
  if new.actor_id is null then v_actor_name := 'System'; v_actor_role := 'system'; end if;

  insert into public.activity_logs (
    id, actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
    description, entity_type, entity_id, status, created_at
  ) values (
    new.id, new.actor_id, coalesce(v_actor_name, 'Unknown user'), coalesce(v_actor_role, 'unknown'),
    'inventory_audit_started', 'inventory', 'Started a stock audit.',
    new.entity_type, new.entity_id, 'success', new.created_at
  ) on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.capture_inventory_audit_start_activity() from public, anon, authenticated;

create trigger activity_legacy_inventory_audit_start
  after insert on public.audit_logs
  for each row execute function public.capture_inventory_audit_start_activity();

-- Backfill only this previously unsupported event. Keep the source audit row
-- intact and avoid copying arbitrary details JSON into the readable log.
insert into public.activity_logs (
  id, actor_user_id, actor_name_snapshot, actor_role_snapshot, action, module,
  description, entity_type, entity_id, status, created_at
)
select a.id, a.actor_id,
  coalesce(p.full_name, case when a.actor_id is null then 'System' else 'Former user' end),
  coalesce(p.role::text, case when a.actor_id is null then 'system' else 'unknown' end),
  'inventory_audit_started', 'inventory', 'Started a stock audit.',
  a.entity_type, a.entity_id, 'success', a.created_at
from public.audit_logs a
left join public.profiles p on p.id = a.actor_id
where a.action = 'inventory_audit_start'
on conflict (id) do nothing;
