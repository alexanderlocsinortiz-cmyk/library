-- Match the interview's stated 1–3 day borrowing period.
insert into public.system_settings (key, value, description)
values ('loan_period_days', '3'::jsonb, 'Default loan period. Allowed range: 1–3 days.')
on conflict (key) do nothing;

update public.system_settings
set value = '3'::jsonb,
    description = 'Default loan period. Allowed range: 1–3 days.'
where key = 'loan_period_days'
  and case
    when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric > 3
    else true
  end;

create or replace function public.validate_circulation_setting() returns trigger
language plpgsql set search_path = public as $$
declare n numeric; min_value numeric; max_value numeric;
begin
  if new.key = 'notifications_enabled' then
    if jsonb_typeof(new.value) <> 'boolean' then raise exception 'Expected boolean'; end if;
    return new;
  end if;
  if new.key not in ('loan_period_days','max_active_loans','due_soon_days','max_renewals','pickup_hold_days','fine_per_day') then
    raise exception 'Unknown circulation setting';
  end if;
  if jsonb_typeof(new.value) <> 'number' then raise exception 'Expected number'; end if;
  n := (new.value #>> '{}')::numeric;
  min_value := case when new.key in ('loan_period_days','max_active_loans','pickup_hold_days') then 1 else 0 end;
  max_value := case
    when new.key = 'loan_period_days' then 3
    when new.key = 'fine_per_day' then 10000
    when new.key in ('max_renewals','max_active_loans') then 100
    else 365
  end;
  if n < min_value or n > max_value or (new.key <> 'fine_per_day' and n <> trunc(n))
    or (new.key = 'fine_per_day' and n <> round(n,2)) then raise exception 'Setting is outside allowed bounds'; end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end;
$$;
