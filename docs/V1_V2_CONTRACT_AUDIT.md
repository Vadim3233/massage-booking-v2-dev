# V1-to-V2 integration contract audit
Updated: 2026-10-06.

## Scope and evidence
Source audited at V2 main `14552fa4c7d464c881326289a9bd93fb14862b9e`. V1 reference: `d93f13cbdcb2129c17b35fa13dcc184502809eaf`.
Read all 19 V2 migrations, current booking state/API/history, active Admin/calendar API, and client/Admin E2E source. No live database verification or fresh test execution. Existing tests are coverage evidence, not a new pass result.

## Feature and contract matrix

| Feature | Actual V2 foundation | Integration action | Required regression |
| --- | --- | --- | --- |
| Admin authentication/recovery | AdminApp, recovery screens, is_booking_admin, existing RLS | Reuse; add stable internal record return destination | Login return, normal client denied, logout clears data |
| Agenda | Calendar.jsx already renders a chronological single-day timeline including bookings, travel, holds, blocks and free intervals | Extend to multi-day agenda; do not replace working single-day presentation | Cross-day navigation, status/expiry consistency, position restoration |
| Day/3-Day/Week/Month/Year | Day read implemented; calendarApi range capped at 31 days | Share presentation; bound ranges; Year occupancy/navigation through separate lightweight reads | Range limits, incomplete-result errors, DST, stale results |
| Weekly hours/date overrides | working_hours, working_hours_overrides; admin RLS | Purpose-specific validated configuration commands and UI; concurrent revision checks | Reload persistence, weekly edits preserve overrides, affected-booking warning |
| Blocks/personal events | calendar_blocks, admin RLS | One editor/command family with kind; no duplicate block table | Public availability excludes blocks; duration/conflict validation |
| FLEX/CHAIN/anchor release | Chain availability RPC/spec; settings fields are not proof of alternate modes | Inspect actual supported rules before exposing switches | JS/database parity for every exposed mode |
| Travel buffer/minimum notice | Scheduling/hold/finalization rules and booking snapshots | Establish configuration authority; no arbitrary global frontend toggle | Buffer overlap, zero buffer, bounds and existing-booking behaviour |
| Services/prices | services, service_duration_prices; active catalogue reads, quote_client_booking | Domain-owned editors/validated commands; deactivate referenced records | Client quotes refresh; historical prices unchanged |
| Coverage/fees | service_areas; authoritative quote snapshots | Single area editor reused by fee/coverage sections | Hidden areas, fee change, quote before confirm |
| Enhancements/preferences | enhancements, session_preferences/conflicts; booking snapshots | Safe editor/order/conflict commands; keep public enhancement scheduling impact zero | Conflicts, disabled choices, historical labels, quote parity |
| Clients/addresses/notes | clients, client_addresses, client_notes; admin RLS; activation identity rules | Canonical paginated directory/profile; no booking-derived pseudo-clients | Account-link protection, search, saved addresses, admin-only notes |
| Admin create/edit/reschedule/cancel/restore | Booking/session/payment tables and broad admin policies; no dedicated commands found in migrations | Implement narrow atomic audited commands; UI must not use broad direct mutation fallback | Actual frontend payloads, concurrent conflicts, two sessions retained, history |
| Pending/payment approval | booking_payments; client declare_my_bank_transfer / confirm_my_cash_booking only | Separate Admin transfer verification/cash approval/rejection/receipt commands | Approval is not receipt; duplicate action; cancellation preserves payment history |
| Waitlist | No waitlist table/offer command found in committed migrations | Add canonical request/offer model and secure acceptance before screens | Taken/expired offer, retry, state history and permissions |
| Telegram | No canonical Telegram connection/invitation implementation found in reviewed source tree | Secure expiring invitation/linking contracts; lazy UI | Ownership, expiry, reuse and exact links |
| Email/alerts | event_outbox and committed booking events exist; no delivery worker proved | Add authorized worker/provider adapter; deduplicate and expose truthful delivery state | Retry delivery, duplicate event, provider failure |
| Receipts/business/document settings | Target model only; no domain tables/editors found | Later versioned server configuration and historical document snapshots | Paid-state truth, issued document remains stable after template changes |
| Financial configuration | Target only | Later independent persisted settings; Analytics deferred | Permissions, validation, reload persistence |
| Security/System/info settings | Existing authorization; V1 pages often explanatory | Useful status/link pages; no fake permission or synchronization controls | No secrets, no frontend role granting |
| Analytics | Deferred | No dashboard/forecast/tax/performance work in current scope | Not a release dependency |

Table/RLS presence is not a completed business command. Proposed command names in master plan are not existing RPC evidence.

## Existing P0 safeguards — retain and extend

- Synchronous store busy guard; durable identical finalization payload on ambiguous transport errors; authenticated account guard.
- Database command idempotency and atomic finalization; existing real HTTP tests for repeat finalization/payment declaration.
- Hold release/replacement/expiry/extension and reload/resume recovery; pending ambiguous finalization survives hold expiry.
- Browser step/history/draft recovery and duration-change hold release.
- TimeStep ignores obsolete request completion through effect cleanup; Calendar ignores obsolete dates.
- Existing test source covers Back/reload, lost response, real expiry, owner-aware slots, payment retry and Admin access/range limits.

## Concrete gaps to fix before expanding UI

1. **Availability failure resembles genuine empty availability.** TimeStep sets slots=[] and loading=false on error, then also renders its no-suitable-times message. Add exclusive error/empty states and explicit retry.
2. **Availability refresh state lacks a query identity.** TimeStep does not set loading/reset slots on every effect fetch. Parent date-key remount mitigates date changes but owner/duration/auth-related refresh deserves a precise latest-query guard and regression test. Do not label this a proven stale-response exploit; effect cleanup already protects obsolete completions.
3. **Calendar in-flight deduplication is module-wide and keyed only by date.** Bind caches to authenticated user/session or component owner and clear on logout; test two accounts requesting the same date while an old request is pending.
4. **Exact Admin record routes are absent.** App only routes /admin and reset-password; details are selected local range state. Add authorized record resolution and internal post-login restoration before notification links.
5. **Operational mutations are absent.** Do not connect broad admin table RLS directly to generic forms. Define validated state transitions and audit/idempotency before write controls.
6. **Latest payment model exceeds old documentation.** Provisional reservations use awaiting_transfer and awaiting_payment; consult the newest provisional migration and actual paymentPresentation before writing status selectors. Do not use a simplified earlier state list as exhaustive.

## Next small implementation sequence

1. Fix availability error/empty/retry and query-context safety; run relevant unit/E2E regressions.
2. Scope Calendar request deduplication to identity; regression for logout/login while loading.
3. Admin routing/navigation and exact record resolver, without placeholder functional tabs.
4. Scheduling and catalogue configuration contracts, then real Settings controls.
5. Continue stages B–I in the master plan.

## Verification prerequisite
This fresh checkout has no node_modules and no provisioned local Supabase test stack. AGENTS.md explicitly prohibits automatic package installers. No dependencies were installed; no unit/E2E/build pass is claimed. Resolve the existing execution environment before shipping runtime changes. Source-only documentation can be reviewed now.
