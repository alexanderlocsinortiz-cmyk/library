-- Simulate an existing auth profile created before migration 022 while its
-- originally submitted School ID is still recoverable from Auth metadata.
insert into auth.users (id, email, raw_user_meta_data)
values (
  '00000000-0000-0000-0000-000000000098',
  'registration-backfill@example.test',
  jsonb_build_object(
    'full_name', 'Registration Backfill Test',
    'registration_school_id', ' reg-claim-008 '
  )
);
