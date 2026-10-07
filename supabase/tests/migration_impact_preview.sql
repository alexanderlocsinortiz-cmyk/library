-- Read-only preview for a database that has migrations 001–004 applied.
-- Run before 005 against staging and save the output with the migration review.
begin transaction read only;

select 'fine_rate_at_migration' as item, public.get_setting_numeric('fine_per_day',0)::text as details;

select 'existing_loan_fine_reconciliation' as item, status::text as details,
       count(*) as rows,
       count(*) filter (where fine_amount is distinct from least(99999999.99,greatest(0,coalesce(ceil(extract(epoch from (
         case when status in ('returned','lost','damaged') then returned_at else now() end - due_at
       ))/86400),0))*public.get_setting_numeric('fine_per_day',0))) as fine_amounts_that_will_change,
       coalesce(sum(least(99999999.99,greatest(0,coalesce(ceil(extract(epoch from (
         case when status in ('returned','lost','damaged') then returned_at else now() end - due_at
       ))/86400),0))*public.get_setting_numeric('fine_per_day',0))),0)::numeric(14,2) as projected_fines
from public.loans
group by status
order by status;

select 'closed_loans_missing_closure_time' as item, count(*) as rows
from public.loans where status in ('returned','lost','damaged') and returned_at is null;

select 'queue_reassignment_by_book' as item, b.id as book_id, b.title,
       (select count(*) from public.reservations r where r.book_id=b.id and r.status='ready_for_pickup') as prior_ready,
       (select count(*) from public.reservations r where r.book_id=b.id and r.status='waiting') as prior_waiting,
       (select count(*) from public.book_copies c where c.book_id=b.id and c.status='available') as available_copies,
       least((select count(*) from public.reservations r where r.book_id=b.id and r.status in ('waiting','ready_for_pickup')),
             (select count(*) from public.book_copies c where c.book_id=b.id and c.status='available')) as expected_ready_after_backfill
from public.books b
where exists(select 1 from public.reservations r where r.book_id=b.id and r.status in ('waiting','ready_for_pickup'))
   or exists(select 1 from public.book_copies c where c.book_id=b.id and c.status='reserved')
order by b.title,b.id;

select 'reserved_inventory_review' as item, c.id as copy_id, c.book_id,
       b.title,c.barcode,c.location
from public.book_copies c join public.books b on b.id=c.book_id
where c.status='reserved'
order by b.title,c.barcode;

select 'suspiciously_old_active_reservation_timestamps' as item,
       count(*) filter(where created_at < now()-interval '90 days') as over_90_days,
       count(*) filter(where created_at < now()-interval '365 days') as over_365_days
from public.reservations where status in ('waiting','ready_for_pickup');

rollback;
