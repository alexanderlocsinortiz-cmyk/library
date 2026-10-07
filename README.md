# Library Reservation System

React + Vite frontend with Supabase authentication, PostgreSQL, and Row Level Security.

## Local setup

```bash
npm install
Copy-Item .env.example .env.local
npm run dev
```

Add the Supabase project URL and publishable key to `.env.local`.

Students do not need email addresses or Supabase accounts. Staff register them as `library_members` with a verified card number and use the staff-operated desk workflow. Supabase Auth is reserved for staff who use the application. Public sign-up is disabled in local configuration; also turn off **Allow new users to sign up** in the hosted project's Auth general configuration. Existing accounts can still sign in. Create staff accounts administratively, then assign Librarian or Administrator roles through the app. Do not enable SMS authentication unless staff specifically need phone-based sign-in.

In Supabase SQL Editor, run:

```text
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_circulation_actions.sql
supabase/migrations/003_circulation_policies.sql
supabase/migrations/004_school_id_auth.sql
supabase/migrations/005_circulation_integrity.sql
supabase/migrations/006_identity_and_administration.sql
supabase/migrations/007_circulation_schedule.sql
supabase/migrations/008_reporting.sql
supabase/migrations/009_interview_loan_period.sql
supabase/migrations/010_staff_managed_members.sql
supabase/migrations/011_interview_workflows.sql
```

Existing School ID accounts can continue to sign in through the Edge Function. New School ID account creation is disabled. Deploy the function only if existing School ID sign-in or password recovery is still needed:

```bash
supabase functions deploy school-id-auth
```

The function uses Supabase server-side environment variables and must never be copied into browser code. Recovery invitations are only for legacy accounts and require staff identity verification. New borrowers do not receive accounts or invitations. See [REMEDIATION.md](REMEDIATION.md) before upgrading an existing database.

Students and teachers are registered by staff using their verified physical library card. They do not need an online account, email address, or invitation to search the public catalog or borrow at the desk. Existing accounts are retained for compatibility; old unverified School ID claims are not trusted automatically.

Staff accounts are provisioned by an administrator. Role changes must be performed by an administrator through the secured `change_member_role` workflow; direct browser profile updates are blocked.

To bootstrap the first administrator after creating an account, run this once in the Supabase SQL Editor with that user's ID:

```sql
update public.profiles
set role = 'administrator'
where id = 'USER_UUID_HERE';
```

## Current scope

- Three roles: Member, Librarian, Administrator
- Supabase Auth foundation
- Profile creation for administratively provisioned staff accounts
- Separate staff-managed borrower records with physical library card numbers and optional account links
- Role-aware dashboard foundation
- Catalog, copies, reservations, loans, notifications, audit logs, and settings schema
- Baseline reservation, checkout, return, catalog-management, and role-management workflows
- Course and subject tags in public catalog search
- Staff-recorded acquisition requests for books the library does not own
- Barcode-based physical stock audits that report discrepancies without silently changing copy status
- Row Level Security policies

Migration 003 adds configurable loan limits, due dates, due-soon status, renewals, overdue refresh, fines, pickup expiry, in-app notifications, and lost/damaged workflows. The current **temporary defaults** are a 3-day loan period (configurable from 1 to 3 days), 5 active loans, 3 due-soon days, 1 renewal, a 3-day pickup hold, and no monetary fine. Keep these values until the librarian confirms the rules: the interview suggests 1–3 days but does not specify the maximum book count, fine amount, or hold expiry.

Administrators can change those values in User Management. The database remains the source of truth.

Migration 010 preserves existing loan and reservation IDs while moving borrower references from login profiles to `library_members`. It deliberately does not invent physical card numbers or trust unverified legacy School ID claims; staff must verify the real card before checkout and verify identity before linking an old account. It also enables anonymous catalog search while exposing only public catalog fields, copy availability, and shelf location.

Migration 011 adds course/subject tags for catalog search, a staff-only request queue for unowned titles, and a staff-only physical stock audit. Requests can move from new to reviewing, ordered, acquired, or declined. Audits snapshot shelf stock, record scanned locations, and flag unknown, missing, or changed records for staff review; they never mark a book lost automatically. The interview did not establish an email or student-account requirement, so requests are recorded by staff at the desk and can be linked to a cardholder without requiring an account.

## Pre-testing checklist

Completed:

- [x] React + Vite foundation
- [x] Supabase client and environment configuration
- [x] Staff-only Supabase Auth sign-in
- [x] Three roles: Member, Librarian, Administrator
- [x] Role-aware navigation and protected database policies
- [x] School color and Montserrat typography treatment
- [x] Responsive dashboard layout
- [x] Live role-aware dashboard metrics and quick actions
- [x] Member loan and reservation activity panels with reservation cancellation
- [x] Member navigation for Catalog, My Books, Reservations, History, Notifications, and Profile
- [x] Book details view with filters, sorting, copy counts, and reservation action
- [x] Librarian member directory, reservation monitoring, and overdue monitoring
- [x] Catalog search screen with live availability counts
- [x] Staff report summary counts
- [x] Staff transaction history screen
- [x] Baseline reservation queue action
- [x] Baseline checkout and return actions
- [x] Librarian catalog management screen
- [x] Administrator role-management screen
- [x] Loading, empty, and error states for live screens
- [x] Production build verification

Still blocked by requirements data or additional implementation:

- [x] Safeguarded librarian catalog CRUD screens
- [x] Reservation queue ordering, pickup, and expiry rules
- [x] Borrow renewal, overdue, lost, and damaged workflows
- [x] In-app notification automation and delivery setting
- [x] Administrator user and role management screens
- [x] Configurable loan and reservation policies
- [ ] Final acceptance testing with real circulation scenarios

The remaining items should not be marked complete until the library rules and gathered data are approved.

Use [TEST_PLAN.md](TEST_PLAN.md) for the pre-testing verification checklist.

## Overdue refresh

Migration 007 configures `scheduled_circulation()` every five minutes when pg_cron is available. Otherwise configure a service-role worker. Monitor its scheduled-success heartbeat and alert after 15 minutes without success. Staff screens also refresh circulation, but screen visits are not the scheduler. See [REMEDIATION.md](REMEDIATION.md) for rollout and verification steps.
