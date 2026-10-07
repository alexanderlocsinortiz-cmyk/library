create function public.library_analytics(p_start timestamptz,p_end timestamptz,p_timezone text default 'Asia/Manila') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not coalesce(public.is_staff(),false) then raise exception 'Staff access required'; end if;
  if p_start is null or p_end is null or p_end <= p_start or p_end-p_start > interval '370 days' then raise exception 'Invalid date range'; end if;
  with events as (
    select (checked_out_at at time zone p_timezone)::date as day,member_id,1 as loans,0 as returns
      from public.loans where checked_out_at >= p_start and checked_out_at < p_end
    union all
    select (returned_at at time zone p_timezone)::date,member_id,0,1
      from public.loans where status='returned' and returned_at >= p_start and returned_at < p_end
  ), daily as (
    select day, sum(loans) as loans,sum(returns) as returns,array_agg(distinct member_id) as members
      from events group by day
  ), categories as (
    select coalesce(nullif(trim(category),''),'Uncategorized') as label,count(*) as count from public.books group by 1
  ) select jsonb_build_object(
    'daily',coalesce((select jsonb_agg(to_jsonb(daily) order by day) from daily),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(to_jsonb(categories) order by count desc,label) from categories),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.library_analytics(timestamptz,timestamptz,text) from public;
grant execute on function public.library_analytics(timestamptz,timestamptz,text) to authenticated;

create function public.transaction_history(p_query text default '',p_page integer default 0,p_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not coalesce(public.is_staff(),false) then raise exception 'Staff access required'; end if;
  if p_page is null or p_page < 0 or p_page > 1000000 or p_size is null or p_size not between 1 and 100 or length(p_query)>200 then raise exception 'Invalid page'; end if;
  with history as (
    select a.id,a.created_at,a.action,a.entity_type,a.entity_id,a.details,
      p.full_name as member_name,p.school_id,b.title,c.barcode,actor.full_name as actor_name
    from public.audit_logs a
    left join public.loans l on a.entity_type='loan' and l.id=a.entity_id
    left join public.reservations r on a.entity_type='reservation' and r.id=a.entity_id
    left join public.book_copies c on c.id=coalesce(l.copy_id,r.copy_id)
    left join public.books b on b.id=coalesce(c.book_id,r.book_id)
    left join public.profiles p on p.id=coalesce(l.member_id,r.member_id)
    left join public.profiles actor on actor.id=a.actor_id
  ), filtered as (
    select * from history where strpos(lower(concat_ws(' ',action,member_name,school_id,title,barcode,entity_id::text)),lower(coalesce(p_query,'')))>0
  ) select jsonb_build_object('total',(select count(*) from filtered),'items',coalesce((
    select jsonb_agg(to_jsonb(page) order by created_at desc,id desc)
      from (select * from filtered order by created_at desc,id desc limit p_size offset p_page*p_size) page
  ),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.transaction_history(text,integer,integer) from public;
grant execute on function public.transaction_history(text,integer,integer) to authenticated;

-- Queue positions reveal counts only, never another member's identity.
create function public.my_reservation_positions() returns table(id uuid,queue_position bigint)
language sql stable security definer set search_path = public as $$
  select r.id,(select count(*) from public.reservations q where q.book_id=r.book_id and q.status='waiting'
    and (q.created_at,q.id)<=(r.created_at,r.id))
  from public.reservations r where r.member_id=auth.uid() and r.status='waiting';
$$;
revoke all on function public.my_reservation_positions() from public;
grant execute on function public.my_reservation_positions() to authenticated;
