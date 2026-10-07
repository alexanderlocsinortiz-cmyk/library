-- Read-only summary to run before migration 010 on a verified staging backup.
-- Member profiles and any staff profiles with circulation history become
-- records, but no physical card numbers are inferred. Reconcile counts against
-- the school's card list before applying the migration.
with borrower_profiles as (
  select p.* from public.profiles p
  where p.role='member'
    or exists(select 1 from public.loans l where l.member_id=p.id)
    or exists(select 1 from public.reservations r where r.member_id=p.id)
)
select
  count(*) as profile_rows_to_preserve_as_library_members,
  count(*) filter (where role='member') as patron_login_profiles,
  count(*) filter (where role in ('librarian','administrator')) as staff_profiles_with_circulation_history,
  count(*) as records_requiring_verified_library_card,
  count(*) filter (where school_id is not null and not exists (
    select 1 from public.school_id_invitations i where lower(i.school_id)=lower(borrower_profiles.school_id)
      and i.purpose='signup' and i.consumed_at is not null
  )) as legacy_school_ids_requiring_ownership_review
from borrower_profiles;

select
  (select count(*) from public.loans) as existing_loan_rows_preserved,
  (select count(*) from public.reservations) as existing_reservation_rows_preserved;
