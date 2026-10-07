# Admin shell and payment review (local implementation, 2026-10-07)

Branch: `codex/admin-payment-review`, based on `origin/main` at `14552fa`.
This slice is not deployed. Hosted Supabase and production are unchanged.

## Audit of the existing contracts

The authoritative migrations are the identity, booking/session, payment, command/outbox foundations and `20260929100000_provisional_payment_reservations.sql`.

Booking states: `awaiting_transfer`, `awaiting_payment_verification`, `awaiting_cash_approval`, `confirmed`, `completed`, `cancelled`, `no_show`.
Payment methods: `bank_transfer`, `cash`.
Bank payment states: `awaiting_transfer`, `awaiting_verification`, `paid`, `rejected`, `refunded`.
Cash payment states: `awaiting_approval`, `approved`, `paid`, `rejected`, `refunded`.
There is no separate cash-request table. `booking_payments` is the payment authority.

Existing client transitions:
- Finalization creates `awaiting_transfer` booking/payment for bank transfer, or `awaiting_cash_approval` / `awaiting_approval` for cash.
- `declare_my_bank_transfer` delegates to private `complete_client_payment`: unexpired `awaiting_transfer` becomes `awaiting_payment_verification` / `awaiting_verification`. Declaration is not receipt.
- `confirm_my_cash_booking` delegates to the same private helper: unexpired `awaiting_transfer` becomes `awaiting_cash_approval` / cash `awaiting_approval`.
- Expiry applies to provisional `awaiting_transfer`; an old reservation timestamp does not expire a declared transfer awaiting verification.
- Scheduling includes pending verification, pending cash approval, confirmed and completed bookings, plus unexpired provisional transfers. Cancelled records do not occupy time.

No Admin payment mutation RPC existed. Existing `is_booking_admin()` checks `admin_users` against `auth.uid()`. RLS prevented non-admin writes, but the original Admin policies and table grants allowed direct Admin writes. The new migration revokes authenticated INSERT/UPDATE/DELETE/TRUNCATE on bookings and payments; SECURITY DEFINER client commands and trusted local fixtures retain their paths. Related read policies are unchanged.

## New narrow contracts

`20261007120000_admin_payment_review.sql` defines:

| RPC | Required booking/payment pair | Result |
| --- | --- | --- |
| `admin_verify_bank_transfer` | awaiting_payment_verification / bank_transfer awaiting_verification | confirmed / paid; verification actor/time and receipt time |
| `admin_approve_cash_request` | awaiting_cash_approval / cash awaiting_approval | confirmed / approved; no receipt timestamp |
| `admin_reject_cash_request` | awaiting_cash_approval / cash awaiting_approval | cancelled / rejected; cancellation actor/time; scheduling releases it |
| `admin_record_payment_received` | confirmed or completed / cash approved | booking unchanged / paid with receipt time |

Each mutation accepts booking ID, request UUID and the two observed `updated_at` versions. It checks non-anonymous Admin authorization, uses the existing business-date advisory lock before booking/payment row locks, checks both versions and required state pair, and rejects inconsistent payment totals. No arbitrary state or JSON update argument exists.

Successful command audit and outbox event commit in the same transaction as the update. Audit identifies actor, channel and operation; the outbox links the command and records before/after states. A same-key, same-request retry returns the original booking ID without another update/event; reuse for a different request fails. Different-key stale or concurrent actions return HTTP 409. Failed transactions do not leave partial business/audit/event writes.

`admin_payment_review_queue` uses existing RLS plus an explicit Admin gate, selects only the two actionable pending state pairs, and returns at most 51 records ordered by date/start/id. UI pages contain 50 and use the final row only to indicate another page. Offset is validated (0–10000). Approved cash does not remain in Review; actual receipt is available in exact booking details. Page refresh is needed when concurrent queue changes shift offset pages.

## Interface and ownership

- `/admin`: existing Calendar with compact Calendar/Review/Clients/More navigation. Clients is explicitly unavailable; More offers a Settings placeholder and sign-out.
- `/admin/review`: independently owned pending queue with explicit refresh and paging.
- `/admin/bookings/:bookingId`: exact, authorized record; deep-link path remains through sign-in and reload. From Calendar/Review, browser history preserves the background and Back destination.
- `/admin/reset-password`: unchanged entry point and recovery flow.
- Review and exact booking destinations are lazy loaded. In-flight reads are deduplicated; no global business store or all-history scan.
- All four payment actions require an identifying confirmation. Reject explains cancellation and time release. Requests disable repeat submission; no optimistic payment status. Errors are mapped to safe text; conflicts refetch current data.
- Mobile navigation uses four bottom destinations; desktop uses a compact top row. Existing palette, type, focus ring, 44px targets, Calendar hierarchy and details panel are retained. No animation/package/framework migration.
- Existing `/admin/(.*)` Vercel rewrite already covers all destinations; `vercel.json` is unchanged.

## Review/release boundaries

The initial draft migration was tested through a clean local Supabase rebuild; the audit also applied the final privilege-revocation delta locally without resetting data. Do not deploy the UI against hosted Supabase without separately reviewing and authorizing the database release. No hosted migration, deployment, commit or push is part of this slice.

Receipt is supported for approved cash on confirmed/completed bookings only; cancelled, rejected and no-show cases need separate product rules. Refunds, booking completion, Clients, Settings, realtime subscriptions and notification delivery workers are outside this slice. Events are enqueued, not sent directly.

## Validation evidence (final audit run)

Commands ran sequentially, using installed tools and local Supabase only:
- `npm test`: 102/102 across 8 files (18.16 seconds). An initial sandboxed attempt could not write the Supabase CLI telemetry file; the authorized local run passed. No test assertions were weakened.
- `npm run lint`: passed, no warnings in the final run.
- `npm run build`: passed, 94 modules transformed.
- `npx --no-install playwright test`: 73/73 (3.3 minutes), including existing Calendar, client booking and password recovery, plus the new payment-review compatibility/retry/race cases.
- `npx --no-install supabase test db`: 163/163 across 11 SQL files, local database only.
- Responsive assertions passed at 320, 360, 390, 412 and 1280px. Mobile Review/confirmation and desktop Review screenshots were inspected; long fixture names wrap without page overflow.
- `git diff --check`: passed; untracked files also checked separately. Nothing staged, committed, pushed, merged or deployed.

The audit used the previously rebuilt local schema and applied only the final TRUNCATE revocation delta locally. No new clean reset was required or performed during this audit. Physical-device and Safari checks were not performed.

## Release-readiness audit (2026-10-07)

Audit base verified locally: HEAD and origin/main both `14552fa4c7d464c881326289a9bd93fb14862b9e`, branch `codex/admin-payment-review`. The existing uncommitted implementation was preserved. No commit, push, deployment or hosted operation was performed.

### Findings and narrowly scoped fixes

- **P0:** none found in the audited payment transitions.
- **P1, fixed:** the inherited authenticated TRUNCATE grants survived the draft INSERT/UPDATE/DELETE revocation. A local catalog query returned true for both tables. TRUNCATE bypasses RLS at the SQL privilege level, although the current PostgREST endpoints do not expose it. The draft now also revokes TRUNCATE; local SQL assertions guard this boundary.
- **P1, fixed:** the client confirmation page continued promising confirmation/attendance after Admin cash rejection and pending verification after confirmation/payment. It now presents confirmed, completed or cancelled outcomes using the authoritative returned booking status and retains the stored payment summary. Pending-request behaviour is unchanged.
- **P2, fixed:** a slow manual read could overwrite the result of a newer post-mutation refresh. Exact booking and Review reads now use monotonically increasing request versions. An end-to-end delayed-read test covers the details race.
- **P2, deferred:** offset pagination can shift as other Admins resolve reviews. Refresh and Previous page provide recovery; server predicates/version checks prevent an incorrect payment operation. Stable cursor pagination would be a separate improvement.
- **Informational:** historical bank records without a transfer-declaration timestamp remain verifiable when their booking/payment pair is eligible. Provisional awaiting_transfer records are never Admin-actionable. Receipt on no-show/cancelled bookings, refunds, notification delivery and additional settings remain outside this slice.

The only audit modifications outside the primary implementation scope are `src/client/booking/components/ConfirmationStep.jsx` and `tests/e2e/booking.spec.js`. The existing client component owns the misleading message; no Admin-only fix can change it. The additional browser cases exercise real client bookings followed by real Admin commands and reload, without changing client booking/payment business rules.

### Security and concurrency assessment

Mutation RPCs authorize a non-anonymous Admin before either command replay or data access, have empty fixed search paths and fully qualified application tables, and accept only typed IDs/version arguments. Queue execution is security-invoker, explicitly gated and subject to existing RLS. Authenticated direct booking/payment INSERT/UPDATE/DELETE/TRUNCATE is denied; no column-level INSERT/UPDATE grants bypass that denial. Command/outbox tables remain server managed. Existing client SECURITY DEFINER wrappers continue to work; no browser service-role credential was added.

The command-key advisory lock precedes the existing business-date advisory lock, followed by booking and payment row locks. All four functions follow the same order. The Admin path does not acquire a client-row lock, so it does not introduce a reverse client/date lock dependency. Expected versions and state predicates are checked under row locks. Command record, booking/payment updates and outbox insert are one transaction. Identical retries return the original result; competing different commands produce one success and one conflict. Revocation of Admin membership also blocks replay of a previously successful command. A lost browser response after a real committed mutation can be retried without another command/event.

Pending cash approval and bank verification continue to occupy time. Rejecting cash changes the booking to cancelled, so the existing availability predicate releases its time. Approval/verification preserve occupancy and remove provisional expiry. Cash receipt leaves confirmed/completed booking state unchanged. Existing hold creation/finalization use the same business-date lock and are unchanged. No new cancellation engine or state was introduced.

### Compatibility, deployment order and recovery

Whole-repository state and mutation searches covered application code, SQL history, tests and docs. The repository baseline client uses fixed SECURITY DEFINER RPCs, not direct booking/payment DML; its contracts and response shape remain unchanged. The old read-only Calendar still uses permitted SELECT. No staged database compatibility migration is needed for the inspected baseline.

**Production qualification:** the actual currently deployed frontend SHA, hosted migration ledger, grants and schema drift were not inspected in this local-only audit. `origin/main` is a verified repository baseline, not proof of the live deployment. Hosted approval remains conditional on a read-only comparison confirming that baseline/contracts and the expected prior migrations (including provisional payment reservations). Older pre-provisional frontends are not covered by this compatibility conclusion.

Recommended controlled sequence, requiring separate approval:
1. Confirm deployed frontend identity and hosted schema/grants against the audited baseline; confirm recoverable backup and target environment. Stop on unexplained drift.
2. Apply the reviewed database migration first. It adds RPCs and tightens unused direct privileges; it does not rewrite or delete existing business rows. Leave new Admin commands unused until the corrected frontend is deployed.
3. Deploy the audited frontend, including the client status correction. Verify client booking, recovery, denied Admin access and review reads before enabling operational payment decisions. Keep already-open old client pages in mind: they display a snapshot until reload.

If frontend release fails before Admin use, the old baseline can continue against the new DB without direct-write grants. After decisions have been recorded, retain the corrected client confirmation component when rolling back Admin UI; returning wholesale to the old confirmation copy reintroduces the fixed misleading cancellation message. Safest recovery is to disable/revert the new Admin entry points while retaining this compatibility fix and leave the additive DB functions, restrictive grants, payment records, audit and outbox intact. If command execution must be suspended, a separately approved narrow EXECUTE revocation can disable the four new mutation RPCs. Do not restore broad direct writes, reverse real receipts, delete audit/outbox records, or reset the database as a rollback. Future event delivery workers must understand these new event types before consuming them.

Physical-device and Safari validation remains outstanding. Local browser evidence is Microsoft Edge/Chromium viewport emulation only.


### Audit change inventory

Previously uncommitted implementation files additionally changed by this audit:
- `docs/ADMIN_PAYMENT_REVIEW.md`, `docs/APP_PLAN.md`: findings, compatibility, release and recovery guidance.
- `src/admin/BookingDestination.jsx`, `src/admin/PaymentReview.jsx`: ignore superseded reads.
- `src/admin/paymentReview.integration.test.js`: invalid-state matrix, completed cash, concurrent identical commands, stale payment versions and revoked authorization.
- `supabase/migrations/20261007120000_admin_payment_review.sql`: add TRUNCATE revocation only.
- `supabase/tests/admin_payment_review.test.sql`: column/table mutation privileges and function security-mode/search-path assertions.
- `tests/e2e/adminReview.spec.js`: committed-response loss/retry, browser Back/Forward, revoked authorization and delayed-read ordering.

Existing tracked files newly changed by this audit: `src/client/booking/components/ConfirmationStep.jsx` and `tests/e2e/booking.spec.js`, for the client status defect and its three real-database browser cases. No entirely new repository file was created by this audit. The other pre-existing implementation changes were preserved without further edits. Package files, Vercel rewrites, V1 and hosted systems were untouched.
