-- Representative 004 data: a ready hold with no assigned copy and a zero-fine late return.
insert into auth.users(id,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000001','{"full_name":"Administrator"}'),
 ('00000000-0000-0000-0000-000000000003','{"full_name":"Member","school_id":"OLD-123"}');
update public.profiles set role='administrator' where id='00000000-0000-0000-0000-000000000001';
update public.system_settings set value='2' where key='fine_per_day';
insert into public.books(id,title,author) values('20000000-0000-0000-0000-000000000001','Legacy title','Author');
insert into public.book_copies(id,book_id,barcode) values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','LEGACY-COPY');
insert into public.loans(copy_id,member_id,status,due_at,returned_at,fine_amount)
 values('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','returned',now()-interval '49 hours',now(),0);
insert into public.reservations(book_id,member_id,status,created_at)
 values('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','ready_for_pickup',now()-interval '1 day');
