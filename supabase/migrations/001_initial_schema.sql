-- Library Reservation System foundation
-- Business rules such as loan limits, fines, and pickup deadlines are intentionally
-- not hardcoded until requirements data has been gathered.

create extension if not exists pgcrypto;

create type public.app_role as enum ('member', 'librarian', 'administrator');
create type public.copy_status as enum ('available', 'reserved', 'borrowed', 'overdue', 'lost', 'damaged', 'maintenance');
create type public.reservation_status as enum ('waiting', 'ready_for_pickup', 'completed', 'cancelled', 'expired');
create type public.loan_status as enum ('borrowed', 'overdue', 'returned', 'lost', 'damaged');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role public.app_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text not null,
  isbn text,
  category text,
  description text,
  publication_year integer,
  cover_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.book_copies (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  barcode text not null unique,
  location text,
  condition text,
  status public.copy_status not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  status public.reservation_status not null default 'waiting',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index one_active_reservation_per_member_book
  on public.reservations (book_id, member_id)
  where status in ('waiting', 'ready_for_pickup');

create table public.loans (
  id uuid primary key default gen_random_uuid(),
  copy_id uuid not null references public.book_copies(id) on delete restrict,
  member_id uuid not null references public.profiles(id) on delete restrict,
  checked_out_by uuid references public.profiles(id) on delete set null,
  checked_out_at timestamptz not null default now(),
  due_at timestamptz,
  returned_at timestamptz,
  status public.loan_status not null default 'borrowed',
  created_at timestamptz not null default now()
);

create unique index one_open_loan_per_copy
  on public.loans (copy_id)
  where status in ('borrowed', 'overdue');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.system_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.current_user_role() in ('librarian', 'administrator');
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.current_user_role() = 'administrator';
$$;

alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.book_copies enable row level security;
alter table public.reservations enable row level security;
alter table public.loans enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.system_settings enable row level security;

create policy "members can view their profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_staff());

create policy "administrators can update profiles"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "authenticated users can search books"
  on public.books for select
  to authenticated
  using (true);

create policy "staff can manage books"
  on public.books for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "authenticated users can view copies"
  on public.book_copies for select
  to authenticated
  using (true);

create policy "staff can manage copies"
  on public.book_copies for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "members can view their reservations"
  on public.reservations for select
  to authenticated
  using (member_id = auth.uid() or public.is_staff());

create policy "members can create their reservations"
  on public.reservations for insert
  to authenticated
  with check (member_id = auth.uid() and public.current_user_role() = 'member');

create policy "staff can manage reservations"
  on public.reservations for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "members can view their loans"
  on public.loans for select
  to authenticated
  using (member_id = auth.uid() or public.is_staff());

create policy "staff can manage loans"
  on public.loans for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "members can view their notifications"
  on public.notifications for select
  to authenticated
  using (member_id = auth.uid() or public.is_staff());

create policy "members can mark their notifications read"
  on public.notifications for update
  to authenticated
  using (member_id = auth.uid())
  with check (member_id = auth.uid());

create policy "staff can view audit logs"
  on public.audit_logs for select
  to authenticated
  using (public.is_staff());

create policy "staff can create audit logs"
  on public.audit_logs for insert
  to authenticated
  with check (actor_id = auth.uid() and public.is_staff());

create policy "administrators can manage settings"
  on public.system_settings for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create index books_title_search on public.books using gin (to_tsvector('simple', title || ' ' || author));
create index book_copies_book_id on public.book_copies (book_id);
create index reservations_book_status on public.reservations (book_id, status, created_at);
create index loans_member_status on public.loans (member_id, status);
create index notifications_member_created on public.notifications (member_id, created_at desc);
