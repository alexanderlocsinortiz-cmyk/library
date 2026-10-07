# Library System Pre-Testing Plan

Run the app with `npm run dev` and use a test Supabase project or test records.

## Authentication

- [ ] Browse the catalog without signing in.
- [ ] Confirm a person can be registered and checked out without creating an Auth account.
- [ ] Confirm an optional account is linked only to a verified library member record.
- [ ] Confirm a legacy School ID claim without a consumed staff invitation is not auto-linked to its borrower record.
- [ ] Sign out and sign back in.
- [ ] Confirm an invalid password is rejected.
- [ ] Confirm a valid session loads the dashboard.
- [ ] Confirm the Member role appears in the header.
- [ ] Confirm signing out returns to the login screen.

## Role navigation

- [ ] Member sees Dashboard, Catalog, My Books, Reservations, History, Notifications, and Profile.
- [ ] Member cannot see Reports or Transactions.
- [ ] Promote a test user to Librarian in Supabase.
- [ ] Librarian sees Dashboard, Catalog, Books, Copies, Members, Book Requests, Stock Audit, Reservations, Borrow / Return, Overdue, Reports, Transactions, and Profile.
- [ ] Promote a test user to Administrator in Supabase.
- [ ] Administrator sees the staff sections plus User Management.
- [ ] Confirm a role change takes effect after signing out and back in.

## Catalog

- [ ] Add at least three test books and physical copies in Supabase.
- [ ] Confirm the dashboard shows live catalog and availability counts.
- [ ] Confirm the dashboard quick action opens the Catalog.
- [ ] Confirm Member navigation shows Catalog, My Books, Reservations, History, Notifications, and Profile.
- [ ] Open a catalog book's details view.
- [ ] Sign out and browse the catalog without an account.
- [ ] Confirm public catalog access shows availability and shelf locations but not copy barcodes or condition.
- [ ] Filter by category, author, availability, and sort order.
- [ ] Confirm book and copy counts match Supabase.
- [ ] Open Catalog.
- [ ] Search by title.
- [ ] Search by author.
- [ ] Search by ISBN or category.
- [ ] Search by course or subject tag.
- [ ] Filter to available books.
- [ ] Filter to unavailable books.
- [ ] Confirm available copy counts match `book_copies` statuses.
- [ ] Confirm the empty state appears when no books match.
- [ ] Confirm database errors are shown as an error state.

## Member activity

- [ ] Confirm a Member sees only their own active loans and reservations on the dashboard.
- [ ] Confirm a Member can cancel their own waiting reservation.
- [ ] Confirm a Member cannot see staff metrics, Reports, or Transactions.

## Member pages

- [ ] Confirm My Books shows only active loans for the signed-in Member.
- [ ] Confirm History shows only closed loans and cannot be edited.
- [ ] Confirm Notifications shows only the signed-in Member's notifications.
- [ ] Confirm Profile never exposes a role-edit control to Members.

## Librarian catalog management

- [ ] Open Books as Librarian.
- [ ] Add a book title.
- [ ] Add a physical copy with a unique barcode.
- [ ] Confirm the new book and copy appear in the catalog.
- [ ] Confirm a Member cannot see Catalog Management.

## Reservation and circulation actions

- [ ] As staff, register a verified student or teacher with a unique physical library card number.
- [ ] Confirm an existing account without a verified card cannot be checked out.
- [ ] As staff, scan a member card and copy barcode to check out a copy to a person with no login.
- [ ] Confirm the loan is linked to the library member record, not an Auth requirement.
- [ ] As staff, add a card-verified member to the queue for an owned title with no available copies.
- [ ] Confirm a title with no physical copies cannot be put in the hold queue and staff sees the acquisition-request guidance.
- [ ] Confirm an optional account linked through a verified School ID can view only that member's loans and reservations.
- [ ] Link a legacy account only after staff verifies the physical card and matching School ID; confirm the action is audited.
- [ ] Confirm a duplicate active reservation is not created.
- [ ] As a Librarian, open Borrow / Return.
- [ ] Check out an available copy to a library member without an online account.
- [ ] Confirm the copy changes to `borrowed`.
- [ ] Confirm the loan appears in Transactions.
- [ ] Return the loan.
- [ ] Confirm the loan changes to `returned` and the copy becomes available.
- [ ] Confirm the due date is set automatically from the configured 1–3-day loan period.
- [ ] Confirm a Member cannot exceed the configured active-loan limit.
- [ ] Confirm a Member can renew an eligible loan only up to the configured renewal limit.
- [ ] Confirm an overdue loan cannot be renewed.
- [ ] Confirm a returned copy promotes the oldest waiting reservation to Ready for pickup.
- [ ] Confirm a ready reservation receives a pickup expiry date and later becomes Expired.
- [ ] Confirm overdue and reservation-expiry notifications appear in the Member Notifications page.
- [ ] Confirm staff can mark an active loan Lost or Damaged and the copy status changes with an audit record.

## Administrator tools

- [ ] Promote a test user to Administrator in Supabase SQL Editor.
- [ ] Sign out and sign back in as Administrator.
- [ ] Open User Management as Administrator.
- [ ] Change a test user between the three approved roles.
- [ ] Confirm the user signs in again before the new permissions appear.
- [ ] Change circulation policy values and confirm new checkout/renewal behavior uses them.

## Reports and transactions

- [ ] Open Reports as Librarian or Administrator.
- [ ] Confirm book and copy counts match the database.
- [ ] Confirm active loan and waiting reservation counts load.
- [ ] Open Transactions as Librarian or Administrator.
- [ ] Confirm the empty state appears when no loans exist.
- [ ] Add a controlled test loan and confirm it appears in the table.
- [ ] Confirm Members cannot access the staff sections.

## Staff operations

- [ ] Open Members and register a student or teacher with a unique card number.
- [ ] Search the directory by name, library card, or school ID.
- [ ] Update a card number or member status; confirm deactivation is blocked with active loans or holds.
- [ ] Confirm imported legacy account records show that their physical card needs verification.
- [ ] Open Books as Librarian.
- [ ] Add a book title and edit an existing title.
- [ ] Add a physical copy with a unique barcode.
- [ ] Delete a book with no loan history and confirm the deletion is audited.
- [ ] Confirm deletion is blocked when loan history or active reservations exist.
- [ ] Open Members and search by name, card number, or school ID.
- [ ] Open Reservations and filter active requests.
- [ ] Mark a waiting reservation ready for pickup.
- [ ] Complete a ready reservation.
- [ ] Open Overdue and confirm explicitly overdue loans appear.
- [ ] Add course and subject tags to a book; find it from the public catalog using those terms.
- [ ] Record a request for a title the library does not own, optionally linking a cardholder without an account.
- [ ] Move a request through new, reviewing, ordered, and acquired; confirm invalid transitions are rejected and all changes are audited.
- [ ] Start a stock audit, scan expected and unknown barcodes, and confirm correct, wrong-location, and missing-copy results.
- [ ] Change a copy's status during an audit and confirm it is flagged for review; verify an audit never changes a copy's circulation status.

## Responsive and visual checks

- [ ] Test at desktop width.
- [ ] Test at tablet width.
- [ ] Test at mobile width.
- [ ] Confirm the navigation can scroll horizontally on narrow screens.
- [ ] Confirm inputs and buttons remain usable on mobile.
- [ ] Confirm school red, navy, gold, white, and Montserrat styling loads.
- [ ] Confirm no text displays corrupted characters.

## Security checks

- [ ] Confirm `.env.local` is ignored by Git.
- [ ] Confirm only the publishable Supabase key is used in the browser.
- [ ] Confirm every application table has RLS enabled.
- [ ] Confirm Members can read only their own reservations, loans, and notifications.
- [ ] Confirm only Librarians and Administrators can manage catalog and circulation records.
- [ ] Confirm only Administrators can manage system settings and roles.
- [ ] Confirm the policy form cannot be used by Members or Librarians.

## Final acceptance gates

The current policy defaults are temporary and configurable. Keep them pending librarian confirmation. Before production use:

- [ ] Replace the dead Supabase URL with the real project URL.
- [ ] On a verified staging database, apply pending migrations in order through 011; reconcile its schema and take a restorable backup before production migration.
- [ ] Confirm the 3-day loan, 5 active-loan, 3-day pickup-hold, and no-monetary-fine temporary defaults with the librarian; the interview does not specify the maximum loan count, fine amount, or hold expiry.
- [ ] Confirm the five-minute circulation scheduler runs and its heartbeat is monitored externally; staff page visits are not a scheduler.
- [ ] Complete the live role, RLS, checkout, return, renewal, expiry, and notification scenarios above.

## Required database setup

Run these migrations in Supabase SQL Editor, in order:

- [ ] `supabase/migrations/001_initial_schema.sql`
- [ ] `supabase/migrations/002_circulation_actions.sql`
- [ ] `supabase/migrations/003_circulation_policies.sql`
- [ ] `supabase/migrations/004_school_id_auth.sql`
- [ ] `supabase/migrations/005_circulation_integrity.sql`
- [ ] `supabase/migrations/006_identity_and_administration.sql`
- [ ] `supabase/migrations/007_circulation_schedule.sql`
- [ ] `supabase/migrations/008_reporting.sql`
- [ ] `supabase/migrations/009_interview_loan_period.sql`
- [ ] `supabase/migrations/010_staff_managed_members.sql`
- [ ] `supabase/migrations/011_interview_workflows.sql`

Before migration 010 on a verified staging backup, review `supabase/tests/member_migration_impact_preview.sql`. It counts profiles that will become member records, physical cards that need verification, and legacy School IDs that lack an invitation-verification record.


## Remediation acceptance gates

Run `npm run test:db`, `npm test`, `npm run check:edge`, `npm run lint`, and `npm run build` first. Local SQL tests use Auth stubs; these checks require a real staging Supabase backend:

- [ ] Apply all migrations transactionally to a fresh Supabase project and an upgraded 004 fixture.
- [ ] Use member and staff JWTs through the REST API to attempt direct reservation/loan/copy-status/profile/audit writes; verify rejection.
- [ ] Try backdated/ready reservations, another member's cancellation, and unauthorized function calls.
- [ ] Confirm public sign-up is disabled in the hosted Supabase project and the School ID Edge Function rejects `sign-up`; recovery invitations remain single-use for legacy accounts.
- [ ] Issue and redeem a separate recovery invitation, verify the new password, old password rejection, other refresh session revocation, and documented access-token expiry behavior.
- [ ] Use two held copies for two members; check out the second member first. Reject collection by the wrong member and premature manual completion.
- [ ] Cancel and expire holds; verify the next waiting member receives a physical copy and notification.
- [ ] Return an overdue loan without a prior screen refresh. Verify its final fine and the recorded checkout-time rate after a policy change.
- [ ] Complete lost and damaged actions and verify copy status, finalized fine, and audit records.
- [ ] Attempt simultaneous checkout, loan-limit races, queue promotions, and last-admin demotions over separate HTTP sessions.
- [ ] Confirm the cron job actually runs, not just that it exists. Stop it and verify external alerting plus the admin stale-heartbeat warning.
- [ ] Test search and pagination with more than 1,000 books, members, events, and notifications; confirm analytics counts match SQL.
- [ ] Complete barcode checkout/return with a real scanner; verify member search, eligibility errors, receipt, pickup deadline, and searchable audit history.
- [ ] Complete member/librarian/administrator workflows on desktop and mobile with keyboard navigation.
- [ ] Restore a backup, review legacy School ID ownership and queue dates, and reconcile the migration-time fine recalculation before live rollout.
