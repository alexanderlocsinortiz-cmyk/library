# Library system review — 2026-10-06

> Historical review. Source fixes and local regression tests were added after this review. See [REMEDIATION.md](REMEDIATION.md) for implemented changes, migration behavior, and remaining staging gates. The original findings below describe the pre-fix system.

Verdict: not ready for production. Fix database installation, authorization, and circulation correctness before adding more dashboard features.

## Scope and evidence

Reviewed React screens, authentication, the School ID Edge Function, all four SQL migrations, and existing tests. Ran ESLint, Vitest, and the production build. Used a disposable PostgreSQL 18 database with minimal Supabase auth schema/function stubs to exercise migrations and selected database operations. No hosted database, live accounts, or production data were changed. Browser usability and deployed Supabase configuration were not verified.

The original migration 003 failed. To investigate subsequent functions, only a temporary copy of that migration was syntax-corrected. Application source and repository migrations remain unchanged. The temporary database server was stopped after testing.

## Fix first

### 1. P0 — Migration 003 fails to install (reproduced)

Source: `supabase/migrations/003_circulation_policies.sql:187`.

The overdue-notification expression does not close `greatest(...)` before the `to_char` format argument. PostgreSQL rejects the function definition with `unexpected end of function definition at end of input`, reported at line 231. A fresh installation cannot complete the migration chain. Depending on how it is applied, earlier statements may remain applied while later safeguards and functions are absent.

Fix the expression and test the entire migration chain from an empty database, with stop-on-error enabled. A frontend build cannot validate SQL migrations.

### 2. P1 — Members can create their own pickup priority (reproduced)

Source: `supabase/migrations/001_initial_schema.sql:190`.

The reservation INSERT policy checks ownership and member role, but permits caller-supplied status and creation time. In the local authenticated-role test, a member inserted `ready_for_pickup` with `created_at = '2000-01-01'`, even though the book had an available copy. This bypasses `reserve_book` and can take priority over legitimate reservations.

Remove direct member INSERT access and require the validated reservation function. Also narrow staff writes to loans, reservations, and copy status: the current broad policies allow direct writes that bypass circulation rules and audit logging.

### 3. P1 — Lost/damaged actions fail (reproduced)

Source: `supabase/migrations/003_circulation_policies.sql:465`.

`close_loan_with_status` assigns a `loan_status` enum directly to a `copy_status` column. PostgreSQL reports `column "status" is of type copy_status but expression is of type loan_status`. The transaction rolls back. Both supported closing statuses use this statement.

Use an explicit validated mapping or cast between enums. Test both outcomes and their audit records.

### 4. P1 — School IDs are self-claimed identities (source-confirmed)

Source: `supabase/functions/school-id-auth/index.ts:70`; `supabase/config.toml`.

An unauthenticated caller can submit a syntactically valid School ID and name; the function creates an immediately confirmed account with administrative credentials. There is no roster match, invitation, or ownership verification in this path. Someone can register another student's unused ID first. The function also has no application-level signup throttling, and there is no implemented password-recovery flow for these accounts.

Require verified enrollment or staff-issued invitations, add abuse controls, and implement a verified recovery process. Hashing the School ID into an internal email does not establish identity ownership. Gateway protections, if any, were not inspected.

### 5. P1 — Pickup holds do not reliably represent physical inventory (source-confirmed)

Sources: migration 003 functions `promote_next_reservation` and `checkout_copy`; `src/components/StaffViews.jsx:89`.

Promotion does not allocate a copy or check available inventory. Staff can mark any waiting request ready and mark it completed without checkout. Checkout checks only the earliest ready reservation for the title: with two available copies and two ready members, the second member is blocked until the first checks out. Cancelling a ready hold does not advance the next waiting request.

Allocate a specific copy to each ready hold atomically; enforce legal state transitions and queue order on the server. Complete reservations through checkout, and release/reassign holds on cancellation and expiry.

### 6. P1 — Final fines can be wrong (reproduced)

Source: `supabase/migrations/003_circulation_policies.sql:494`.

Returning a loan only changes its status and return timestamp. A local test with a due date three days earlier and a nonzero daily rate returned the loan with `fine_amount = 0.00`. After closure, the refresh function no longer updates that loan. A prior screen refresh is not a reliable settlement mechanism.

Calculate the final fine inside the return/closure transaction. Decide whether policy changes affect existing loans, and record the rate and calculation used.

## Reliability and accuracy improvements

- **Surface refresh failures.** Staff screens await `refresh_circulation_statuses` but ignore its returned `error`; their catch blocks do not handle ordinary returned RPC errors. Show refresh failures and avoid presenting stale overdue data as authoritative.
- **Correct analytics.** `AnalyticsSection.jsx:253` counts all rows with `returned_at`, while lost/damaged closure also sets that field. Filter actual returns or separate return and closure events.
- **Add pagination and database aggregates.** Catalog, member directory, and analytics fetch lists without paging. They can silently become incomplete at the configured API row limit. Transactions show only 25 records and notifications only 50, with no paging controls.
- **Protect administrator continuity.** Role changes are direct profile updates with no last-administrator invariant or audit entry. Enforce role changes in a server transaction and test self-demotion and concurrent changes.
- **Validate policy values on the server.** HTML minimums do not protect direct writes to settings. Enforce allowed keys, types, and sensible numeric bounds in the database.
- **Prevent stale auth profile results.** `auth.jsx` checks whether the component is mounted, but not whether a completed profile request still belongs to the current session. Add request/session version checks and an explicit profile-load error state.
- **Automate overdue/expiry processing.** The repository describes a scheduled job but does not configure one. Verify scheduling and alerting in the actual deployment; screen visits are not a dependable scheduler.
- **Update setup documentation.** `TEST_PLAN.md` lists only migrations 001–003, but profile lookup requires `school_id` from migration 004. The reservation UI also says pickup expiry is not recorded even though migration 003 adds it.
- **Clean verification scope.** ESLint scans generated coverage output and does not check the TypeScript Edge Function. Exclude generated output and add an Edge Function type check.

## Enhancements after correctness

1. Barcode-first checkout and return with member search, clear eligibility messages, and a transaction receipt.
2. Reservation queue position, assigned copy, pickup deadline, and clear cancellation/expiry feedback.
3. Searchable transaction and audit history with pagination and export.
4. Copy repair/recovery workflows, inventory reconciliation, and explicit fine payment/waiver records if money is collected.
5. Keyboard focus containment/restoration for dialogs, accessible chart data, and mobile workflow testing.

## Acceptance gates

- Fresh migrations install successfully in a Supabase test environment.
- Direct API tests prove members cannot forge holds, dates, other members' records, or staff actions.
- Database tests cover checkout, return, lost/damaged, renewal, fines, cancellation, expiry, and audit records.
- Concurrent tests cover two checkouts of one copy, the member loan limit, and competing reservation promotions.
- Browser tests complete the full member/librarian/administrator workflows with a real test backend.
- Verify School ID ownership/recovery, scheduled jobs, and backup restoration before rollout.

Verification results: production build passed; all five unit tests passed; ESLint reported zero errors and one warning in generated coverage output. The original migration chain failed at migration 003. Subsequent database reproductions used the temporary syntax-corrected copy described above.

The current five unit tests cover timeout handling and circulation display helpers only. Their success is not evidence that database permissions or circulation workflows work.
