# Library Reservation System

React + Vite frontend with Supabase authentication, PostgreSQL, and Row Level Security.

## Local setup

```bash
npm install
Copy-Item .env.example .env.local
npm run dev
```

Add the Supabase project URL and publishable key to `.env.local`. For deployed builds, set `VITE_AUTH_REDIRECT_URL` to the deployed site's origin so confirmation links return there. Leave it blank locally to use the current browser origin. Add the deployed origin to Supabase Auth's allowed redirect URLs and set it as the Auth Site URL.

Anyone creating an online member account registers with a name, email, School ID, and password, then confirms control of that email through a Supabase link. The School ID is saved as registration information only; it is not checked against student or library records. No library card, PIN, or staff review is required for signup. Email confirmation does not prove student status; each account gets a separate email-only borrower record and does not inherit an existing member's loans or reservations. LMS identity matching can be added later. Staff still records physical checkouts and returns at the library desk, and member self-registration cannot create staff roles.

Local Supabase Auth enables email registration and confirmation in `supabase/config.toml`. On a hosted project, enable email sign-ups and email confirmations, add the app URL to the allowed redirect URLs, and keep staff account creation restricted to trusted administrators. Apply the migrations in order and deploy both authentication Edge Functions. Do not enable SMS authentication unless staff specifically need phone-based sign-in.

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
supabase/migrations/012_revoke_anonymous_rpc_execution.sql
supabase/migrations/013_card_pin_reservations.sql
supabase/migrations/014_member_email_registration.sql
supabase/migrations/015_walk_in_reservations.sql
supabase/migrations/016_activity_logs.sql
```

Apply all later migrations in filename order through `034_email_only_member_accounts.sql`; migration 034 is required for email-only account creation and online holds.

The `school-id-auth` Edge Function resolves a verified member School ID to that member's email account. The `email-auth` Edge Function records successful and failed email or phone login attempts server-side. Deploy them after applying the migrations:

```bash
supabase functions deploy school-id-auth
supabase functions deploy email-auth
```

The function uses Supabase server-side environment variables and must never be copied into browser code. School ID password recovery still requires a staff-issued invitation. See [REMEDIATION.md](REMEDIATION.md) before upgrading an existing database.

Registration flow: the person enters their name, email, School ID, and password, then clicks the Supabase confirmation link. The School ID is stored as an unverified registration detail and does not link the account to a student or borrower record. After confirmation, the database creates a separate provisional borrower record that can place online holds. Staff handles pickup, checkout, and return at the desk. The email proves mailbox control only; add LMS matching later if online accounts must be limited to enrolled students.

Staff accounts are provisioned by an administrator. Role changes must be performed by an administrator through the secured `change_member_role` workflow; direct browser profile updates are blocked.

To bootstrap the first administrator after creating an account, run this once in the Supabase SQL Editor with that user's ID:

```sql
update public.profiles
set role = 'administrator'
where id = 'USER_UUID_HERE';
```

## Current scope

- Three roles: Member, Librarian, Administrator
- Supabase Auth with email confirmation, optional member self-registration, and administrator-provisioned staff accounts
- Email-confirmed member accounts with separate email-only borrower records
- Separate staff-managed physical borrower records; LMS-based identity matching is deferred
- Role-aware dashboard foundation
- Catalog, copies, reservations, loans, notifications, administrator activity logs, and settings schema
- Baseline reservation, checkout, return, catalog-management, and role-management workflows
- Course and subject tags in public catalog search
- Staff-recorded acquisition requests for books the library does not own
- Barcode-based physical stock audits that report discrepancies without silently changing copy status
- Row Level Security policies

Migration 003 adds configurable loan limits, due dates, due-soon status, renewals, overdue refresh, fines, pickup expiry, in-app notifications, and lost/damaged workflows. The current **temporary defaults** are a 3-day loan period (configurable from 1 to 3 days), 5 active loans, 3 due-soon days, 1 renewal, a 3-day pickup hold, and no monetary fine. Keep these values until the librarian confirms the rules: the interview suggests 1–3 days but does not specify the maximum book count, fine amount, or hold expiry.

Administrators can change those values in User Management. The database remains the source of truth.

Migration 010 preserves existing loan and reservation IDs while moving borrower references from login profiles to `library_members`. It deliberately does not invent physical card numbers or trust unverified legacy School ID claims; staff must verify the real card before checkout and verify identity before linking an old account. It also enables anonymous catalog search while exposing only public catalog fields, copy availability, and shelf location.

Migration 011 adds course/subject tags for catalog search, a staff-only request queue for unowned titles, and a staff-only physical stock audit. Requests can move from new to reviewing, ordered, acquired, or declined. Audits snapshot shelf stock, record scanned locations, and flag unknown, missing, or changed records for staff review; they never mark a book lost automatically. The interview did not establish an email or student-account requirement, so requests are recorded by staff at the desk and can be linked to a cardholder without requiring an account.

Migration 012 removes Supabase's direct `anon` EXECUTE grants from public-schema functions and prevents new functions created by the migration role from inheriting `anon` or `PUBLIC` execution. Public catalog browsing continues through column-limited SELECT grants; privileged circulation and reporting RPCs are not public APIs.

Migration 013 adds account-free online holds. Staff verify the physical card, register the member, and optionally set a private 6–12 digit reservation PIN in Members. Give that PIN directly to the cardholder. They can search the public catalog, join the first-come-first-served queue when every copy is out or assigned, then use the card number and PIN under **Check or cancel a reservation** to see their queue place or pickup deadline and cancel a hold. Five incorrect PIN attempts temporarily lock online reservation access for 15 minutes. The PIN is stored as a bcrypt hash; it is not an email/password account. There are no reservation emails, so cardholders check the catalog for updates. Staff still scan the physical book at checkout and return; an online hold never marks a book borrowed or returned.

Migration 016 adds an administrator-only, append-only activity stream with server-side pagination and combined filters. Database triggers record committed catalog, member, reservation, borrowing, role, and settings changes. The authentication Edge Functions record successful and failed logins and password recovery changes; failed login identifiers are masked.

### Registration email verification and cleanup

Migration `025_registration_expiration_and_cleanup.sql` adds a server-controlled registration deadline (30 minutes by default), backend resend limits, an email-confirmation deadline guard, and a one-minute `pg_cron` cleanup job. Administrators can change the registration completion period in User Management; the allowed range is 5 to 1,440 minutes. Expired account removal uses the `registration-lifecycle` Edge Function and Supabase Auth Admin API. The cleanup rechecks email confirmation, legacy open assistance requests, member links, and all borrowing/reservation history before deletion. A successful or failed cleanup attempt is recorded in Activity Logs. Verified accounts and protected library records are retained.

Migration `030_cancel_pending_member_registration.sql` lets a member cancel an unconfirmed registration after proving the registration password. Migration `031_auth_email_link_audit.sql` updates staff recovery audit entries to record verification-email delivery accurately.


Migration `034_email_only_member_accounts.sql` removes School ID matching from self-service account creation. The School ID remains an unverified registration detail. Confirming the Supabase email link creates a separate provisional borrower record for online holds; it does not validate student status or attach the account to an existing physical borrower record. Unfinished manual-assistance requests are withdrawn and the old self-link and review RPCs are disabled. Staff still checks out books at the desk.

Unconfirmed member registrations that existed before migration 025 receive a fresh 30-minute transition window; the rollout does not immediately delete them. Only registrations with a stored School ID claim are assigned this deadline. Other pre-existing accounts are left intact for manual review.

The hosted project needs these settings in addition to applying the migration:

- In **Authentication → Providers → Email**, keep email signups and email confirmations enabled. In **Authentication → Email Templates → Confirm signup**, use `{{ .ConfirmationURL }}` so registration sends a clickable verification link; the checked-in `supabase/templates/confirmation.html` is the local template. Keep the email resend frequency at 60 seconds or longer. Password recovery still uses a six-digit code.
- If `registration-assistance` or `admin-verification-email` was previously deployed, remove those hosted Edge Functions; migration 034 disables their obsolete review and request RPCs.
- Deploy `registration-lifecycle` and set the Edge Function secret `REGISTRATION_CLEANUP_SECRET` to a freshly generated random value. Do not put this secret in `.env.local`, frontend code, or source control.
- Store the same cleanup secret and the project's base URL in Supabase Vault using the names `registration_cleanup_secret` and `supabase_project_url`. The migration schedules the cron call when `pg_cron`, `pg_net`, and Vault are available; the project must have those extensions enabled.

Deploy after applying database migrations:

```bash
npx supabase functions deploy registration-lifecycle
npx supabase secrets set REGISTRATION_CLEANUP_SECRET=<fresh-random-secret>
```

In the Supabase SQL Editor, save the same generated secret and project URL in Vault (replace the placeholders without committing the values):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'supabase_project_url');
select vault.create_secret('<same-fresh-random-secret>', 'registration_cleanup_secret');
```

The confirmation link expires independently. A link failure does not trigger deletion; only a registration past its server deadline enters cleanup, and previously approved legacy identity links remain protected until email verification is complete.

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
