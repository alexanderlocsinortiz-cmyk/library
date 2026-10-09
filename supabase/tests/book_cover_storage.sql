\set ON_ERROR_STOP on

select public.test_assert(
  (select public and file_size_limit = 5242880
    and allowed_mime_types = array['image/jpeg','image/png','image/webp']
   from storage.buckets where id = 'book-covers'),
  'cover storage is public for reads and restricted to supported image types and five megabytes'
);

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into storage.objects (bucket_id, name)
values ('book-covers', '20000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg');
update public.books
set cover_image_path = '20000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg'
where id = '20000000-0000-0000-0000-000000000001';
select public.test_denied(
  $q$insert into storage.objects(bucket_id,name) values('book-covers','20000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.svg')$q$,
  'row-level security'
);
reset role;

set role anon;
select public.test_assert(
  (select count(*) = 1 from storage.objects where bucket_id = 'book-covers'),
  'anonymous catalog visitors can read cover objects'
);
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000007';
insert into storage.objects (bucket_id, name)
values ('book-covers', '20000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png');
update public.books
set cover_image_path = '20000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png'
where id = '20000000-0000-0000-0000-000000000001';
select public.test_assert(
  (select cover_image_path like '%/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png'
   from public.books where id='20000000-0000-0000-0000-000000000001'),
  'librarians can attach stored cover images to book records'
);
select public.test_denied(
  $q$insert into storage.objects(bucket_id,name) values('book-covers','20000000-0000-0000-0000-000000000001/cccccccc-cccc-cccc-cccc-cccccccccccc.svg')$q$,
  'row-level security'
);
update public.books
set cover_image_path = '20000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg'
where id = '20000000-0000-0000-0000-000000000001';
delete from storage.objects
where bucket_id='book-covers'
  and name='20000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png';
select public.test_assert(
  (select count(*) = 1 from storage.objects where bucket_id = 'book-covers'),
  'librarians can remove stored cover images'
);
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select public.test_denied(
  $q$insert into storage.objects(bucket_id,name) values('book-covers','20000000-0000-0000-0000-000000000001/dddddddd-dddd-dddd-dddd-dddddddddddd.webp')$q$,
  'row-level security'
);
reset role;
