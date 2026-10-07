# Correctness, security, and interview-workflow remediation (updated 2026-10-07)

The six priority defects have source fixes and local PostgreSQL regression coverage. This is not a production acceptance certificate: hosted Supabase Auth, PostgREST, pg_cron, browser workflows against a real backend, and backup restoration still require staging verification.

## Changes

- Migration 011 adds public course/subject search tags, a staff-only acquisition-request log for unowned titles, and a staff-only barcode stock audit. Request transitions are constrained and audited. Stock audits flag missing, unknown, misplaced, or status-changed copies for staff review and never mutate copy status; staff must investigate before recording loss or damage.
- The current 5-active-loan, no-monetary-fine, and 3-day pickup-hold values remain temporary, configurable defaults per the user's choice. The interview does not define those rules; a librarian must confirm them before live circulation. Its 1-to-3-day loan period is represented by a three-day default configurable from one to three days.

- Migration 003 now installs and maps loan/copy enums explicitly. Migration 005 also replaces the affected functions for existing installations.
- Members and staff cannot directly insert/update loans or reservations, change copy status, or forge audit rows. Staff can register copies using only catalog fields. Notifications permit only `read_at` updates.
- Holds allocate one physical copy per ready reservation in FIFO order (creation time, then UUID). Checkout honors the selected copy's assignee, completes that hold, and enforces the member limit. Cancellation and expiry release and reassign inventory. Adding a copy services the queue. Renewal is rejected when another reservation needs the title.
- Circulation operations use a shared transaction advisory lock, plus unique indexes. This intentionally favors predictable ordering over high write throughput. Revisit the locking granularity with measured contention before a large multi-branch rollout.
- Fines use the daily rate captured at checkout and elapsed 24-hour periods rounded up, with zero before the due time. Return, loss, and damage finalize the fine in the same transaction and audit the amount/rate/time. Amounts are capped at the existing column's maximum, 99,999,999.99.
- New borrower accounts are not part of the supported workflow. The app exposes no account creation, the School ID Edge Function rejects `sign-up`, and `supabase/config.toml` disables local public sign-ups. Disable **Allow new users to sign up** in the hosted Supabase Auth configuration too; otherwise direct Auth API calls can still create profiles. Existing accounts can sign in for compatibility.
- Recovery requires a separate staff-issued recovery invitation for a member account. Redeeming it changes the password and revokes other refresh sessions. Already-issued access tokens remain valid until their normal expiry. A failed Auth update consumes the recovery code; staff must verify the person and issue a replacement. Staff/administrator account recovery stays with the trusted Auth operator.
- Role changes are audited RPCs with a serialized last-administrator check. Circulation settings have database type/key/range validation. Missing or stale profile requests cannot restore another session's privileges in the UI.
- Migration 007 registers a five-minute pg_cron job where supported. An administrator health indicator checks its separate scheduled-success heartbeat; opening a staff page cannot make a broken scheduler appear healthy. Ordinary RPC errors now surface instead of being swallowed.
- Analytics aggregates in the database and counts only `returned` loans as returns. The audit history uses server-side search and pagination. Catalog, member, notification, and other collection screens fetch stable API pages and paginate displayed results; collection filters still operate in browser memory over the loaded collection. These screens need server-side filtering for very large datasets.
- Barcode checkout/return, member search, a checkout receipt, pickup copy/deadline/queue position, and searchable audit history are connected to the protected circulation actions.
- Migration 010 separates `library_members` from Auth profiles while preserving existing borrower UUIDs and loan/hold history. Staff register card holders, add them to owned-title FIFO queues, and circulate copies without borrower logins. Existing accounts link only after staff verifies the physical card and matching School ID. Unverified legacy School ID claims are not trusted automatically. Deactivation is blocked while a member has active loans or holds.
- The sign-in page offers account-free catalog browsing. Anonymous access is limited to book metadata and copy status/location; barcodes, condition, member records, and circulation actions remain protected. Holds for titles with no physical copies are rejected rather than creating an unfulfillable queue entry.
- Legacy profiles are imported with no invented library card numbers and no automatic Auth link unless a consumed signup invitation proves the School ID. Verify and enter each physical card in the Members screen before that record can be checked out. Run `supabase/tests/member_migration_impact_preview.sql` against a verified staging backup before applying migration 010.

## Apply safely

1. Take a backup and prove restoration into staging. Preserve the pre-upgrade database for comparison.
2. For a fresh database, apply migrations **001 through 011 in order**, stopping on the first failure. Apply each migration as a transaction. For a database that completed 004, apply **005 through 011**. Do not blindly rerun partially applied historical migrations: inspect the migration ledger and reconcile a partially applied 003 first. The linked project previously inspected has no reliable migration ledger and is not safe to update until its schema is reconciled.
3. Migration 005 moves old unassigned ready holds back to the waiting queue, then allocates real available copies. Review those assignments and notifications. Legacy dates may have been caller-controlled; investigate suspect queue priorities rather than assuming their old timestamps establish entitlement. Copies already marked reserved without a valid hold require inventory reconciliation.
4. Existing loans have no historical rate snapshot. Migration 005 adopts the policy rate at upgrade time and recalculates existing fines, including closed loans. Review and approve this financial reconciliation before applying to live records. New loans freeze their checkout rate; later policy edits do not change it.
   Run `psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/migration_impact_preview.sql` with a protected staging connection. Save its output. It reports loan rows and projected fines by status, holds that will be requeued/reassigned, all currently reserved copies, and suspiciously old active request timestamps. Investigate reserved inventory and old timestamps with library staff before applying; migration 005 had no prior copy-assignment field to prove which titles had valid holds. Age flags are leads for review, not proof of a forged request. The SQL is read-only and leaves the transaction rolled back.
5. Audit existing School ID accounts: the staff-managed workflow does not prove that old self-claimed identities belonged to the registrant. Verify them with the school and resolve suspicious claims through a trusted operator.
6. Disable public sign-ups in the hosted Supabase Auth configuration. Deploy the updated `school-id-auth` Edge Function if preserving legacy School ID sign-in or recovery; it rejects account creation. Deploy the frontend with it. Service credentials stay in Edge Function secrets only.
7. If pg_cron is unavailable, schedule `public.scheduled_circulation()` using a database operator or service-role RPC every five minutes. Never expose service credentials to the browser. The migration emits a warning rather than pretending an absent scheduler is configured.
8. Monitor `circulation_job_health.last_scheduled_success_at` externally and alert after 15 minutes without success. Inspect `cron.job_run_details` for job failures where pg_cron is used. The in-app banner is supplementary, not an external alerting service.

## Reproduce local verification

Use Node 22.12+ and PostgreSQL tools (`initdb`, `pg_ctl`, `psql`) on PATH, or set `PG_BIN` to their directory. The runner creates a new temporary cluster, uses no application credentials, and stops it in `finally`. It leaves logs/data in its printed temporary directory for diagnosis. It never connects to the configured application database.

```sh
npm ci
npm run lint
npm test
npm run test:db
npm run check:edge
npm run build
npm audit
```

Database coverage includes fresh migration installation, direct write denials, member/staff authorization, account-free member registration and checkout, verified optional account linking, public catalog column limits and course/subject search, acquisition-request transitions/audit history, physical stock-audit mismatches and non-mutating behavior, missing profiles, checkout/renewal/return/loss/damage, final rate snapshots, copy-specific pickup, cancellation/expiry, audit records, invitation reuse and recovery, throttling, settings validation, last-admin continuity, reporting beyond 1,000 records, and concurrent checkouts/loan limits/promotions/admin edits. Auth/profile race and API pagination tests run with Vitest. Deno checks the Edge Function types.

The PostgreSQL harness supplies minimal Supabase Auth stubs and Supabase-like grants. It does **not** emulate Auth HTTP behavior, RLS through PostgREST/JWT validation, pg_cron execution, or browser interaction. Run the updated TEST_PLAN against staging before rollout. No live deployment was performed during this remediation.

## Linked Supabase project check

On 2026-10-06, the authenticated CLI's read-only project listing showed one linked, active project named `library-reservation-system`, without an environment label that establishes it is staging. Read-only schema checks found `public.profiles`, but no migration ledger, School ID column, migration 003 policy getter, assigned-copy field, fine-rate snapshot, or installed pg_cron. The read-only impact preview stopped at the missing migration 003 function before returning application records. **No remote migration or data write was run.** This remote project is not a valid 004 staging fixture yet, and applying 005 or the full fresh-install chain to it without reconciling its untracked schema would fail or risk conflicting with existing objects. Identify the environment, take and restore a backup, and establish its migration history before any remote migration. Local fresh-install and 004-upgrade fixtures pass.
