\set ON_ERROR_STOP on
select public.test_assert(
  (select registration_school_id = 'REG-CLAIM-008' and school_id is null
   from public.profiles where id = '00000000-0000-0000-0000-000000000098'),
  'migration recovers the submitted School ID as an unverified claim without trusting it'
);

-- A new Auth signup must copy its School ID claim into the profile at creation.
insert into auth.users (id, email, raw_user_meta_data)
values (
  '00000000-0000-0000-0000-000000000099',
  'registration-trigger@example.test',
  jsonb_build_object(
    'full_name', 'Registration Trigger Test',
    'registration_school_id', 'new-claim-009'
  )
);
select public.test_assert(
  (select registration_school_id = 'NEW-CLAIM-009' and school_id is null
   from public.profiles where id = '00000000-0000-0000-0000-000000000099'),
  'new Auth signups copy only the unverified School ID claim'
);
select public.test_assert(
  public.school_login_email('NEW-CLAIM-009') is null,
  'an unverified registration claim cannot resolve to a School ID login account'
);
select public.test_assert(
  not has_column_privilege('anon', 'public.profiles', 'registration_school_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'registration_school_id', 'UPDATE'),
  'browser roles cannot edit the stored registration School ID claim'
);
select public.test_assert(
  not has_function_privilege('anon', 'public.school_login_email(text)'::regprocedure, 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.school_login_email(text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('service_role', 'public.school_login_email(text)'::regprocedure, 'EXECUTE'),
  'only the authentication service can resolve a School ID to an Auth account'
);
