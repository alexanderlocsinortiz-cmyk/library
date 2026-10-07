-- Supabase supports pg_cron. Bare PostgreSQL integration tests may not have it.
-- A deployment without this extension must configure an external service-role
-- worker and monitor circulation_job_health before admitting live traffic.
alter table public.circulation_job_health add column last_scheduled_success_at timestamptz;
create function public.scheduled_circulation() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.process_circulation();
  update public.circulation_job_health set last_scheduled_success_at = now() where singleton;
end;
$$;
revoke all on function public.scheduled_circulation() from public,anon,authenticated;
grant execute on function public.scheduled_circulation() to service_role;

do $$
begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('library-circulation-every-five-minutes','*/5 * * * *','select public.scheduled_circulation();');
  else
    raise warning 'pg_cron unavailable: configure a five-minute service-role circulation worker before rollout';
  end if;
end;
$$;
