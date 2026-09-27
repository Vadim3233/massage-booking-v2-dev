# Codex Handoff — VAD Massage Booking V2

Updated: 2026-09-27.

## Working principle

**Preserve the product. Replace the architecture.**

For any existing feature:
1. inspect V1 behavior first when needed,
2. turn behavior into explicit requirements/tests,
3. implement clean V2 architecture,
4. compare with V1 behavior,
5. do not invent new UX or business rules unless explicitly requested.

V1 reference repo: `Vadim3233/massage-booking-app`
V2 repo: `Vadim3233/massage-booking-v2-dev`
Local V2 path: `C:\Projects\massage-booking-app-v2`
Branch: `main`

## Remote database state

Supabase project ref: `jxmnfwoeqglnhruadbhp`

Confirmed Local = Remote migrations through:

- 20260923171500
- 20260923173500
- 20260923175500
- 20260923181500
- 20260923183500
- 20260923184500
- 20260924071000
- 20260924072500
- 20260924104500
- 20260926122500
- 20260927110000

**Do not push or deploy any new migration to remote Supabase without explicit user approval.**

The current new migration:
`20260927193000_client_quote_finalize.sql`

is committed in GitHub but is **not remote** yet, so it may still be edited while local tests are failing.

## Last verified green state before current migration

JavaScript:
- 2 test files
- 37/37 tests passed

Database:
- 4 test files
- 58/58 tests passed

Those counts were confirmed before adding the current quote/finalization migration.

## Current task

Finish and harden:

- server-authoritative client quote
- atomic `finalize_client_booking`
- session snapshots
- appointment-level enhancements
- payment state creation
- address snapshot/save
- booking hold consumption
- idempotency
- command audit
- outbox event
- first-time/returning-client future-booking limits

Relevant files:

- `supabase/migrations/20260927193000_client_quote_finalize.sql`
- `supabase/tests/client_quote_finalize.test.sql`

## Current failing test

Latest local command:

`npx supabase test db`

fails in:

`supabase/tests/client_quote_finalize.test.sql`

around line 450 with:

```
ERROR: syntax error at or near "$"
LINE 2:   $select * from public.create_booking_hold(
```

The current file contains:

```sql
select lives_ok(
  $select * from public.create_booking_hold(
    current_setting('test.finalize_date2')::date,
    600,
    60,
    'finalize-hold-client-key-0000002'
  )$$,
  'second pre-auth hold may exist before client booking-limit validation'
);
```

This is a malformed dollar quote. Fix it cleanly (for example with `$$...$$` or a tagged delimiter), then rerun the full database suite. Expect additional failures may appear once parsing proceeds; diagnose and fix them iteratively rather than assuming this is the only defect.

## Required validation loop

From `C:\Projects\massage-booking-app-v2`:

```powershell
git status
git pull
npx supabase db reset
npx supabase test db
npm test
```

Do not claim success until actual command output proves it.

The intended database target after this new test file is approximately:
- 5 database test files
- 77 tests total

But treat that as a target, not as a fact until pgTAP reports PASS.

## Important booking rules already established

- Client public flow: Area → Treatment → Duration → Date & Time → Review → Your Details → Payment → Confirmation.
- Public durations: 60 / 90 / 120 minutes.
- One Booking = one visit/date/address/payment/reservation.
- Booking may contain multiple Sessions.
- `2 × 60` must remain two 60-minute session rows, not become one 120-minute session.
- Public booking uses one selected treatment across the sessions in that visit.
- Default inter-booking travel buffer = 60 minutes.
- No travel buffer between sessions inside the same booking.
- Empty day without anchor: 30-minute start increments.
- Chain Mode exposes only outer-edge slots, not arbitrary internal gaps.
- Treatment must start at or after working-hours start and finish at or before working-hours end.
- Last treatment may finish exactly at working-hours end.
- Active unexpired holds block availability; expired holds do not.
- Public hold is pre-auth, uses opaque `client_key` + secret `hold_token`, lasts 10 minutes.
- Public same-day booking minimum notice = 120 minutes.
- Public booking window = up to 40 calendar days ahead.
- New client: max one active future appointment until first appointment is completed and paid.
- Returning client: max five future appointments.
- Bank transfer is not "paid" merely because client reports sending it; starts awaiting Admin verification.
- Cash request starts awaiting Admin approval.
- Final booking must revalidate hold, schedule, ownership, services, prices, fees and payment state server-side.
- Finalization should be atomic: all booking/session/payment/snapshots/hold/outbox/idempotency succeed or all roll back.
- Notifications must originate from committed database state/outbox, not optimistic browser events.

## V1 behavior discovered for enhancements

V1 public UI selects enhancements once for the appointment. They are not independently selected for each guest/session.

V1 public UI also maps public enhancements to zero duration for scheduling, even if the admin enhancement catalogue stores a duration value. Therefore the public quote/finalization contract should preserve that behavior unless the product decision changes.

## Security / architecture rules

- Browser must never be authoritative for price, fee, booking reference, client identity or payment status.
- Canonical client identity is `clients.id`; Auth/phone/WhatsApp/Telegram are linked identities/channels.
- Authenticated client must resolve server-side from `auth.uid()`.
- Do not accept arbitrary client IDs from public callers.
- Critical writes use validated RPCs.
- Admin/client/external-agent contracts remain separate.
- Use one shared scheduling specification across availability, holds, finalization, Admin create and reschedule.
- Do not introduce compatibility fallbacks that hide schema drift.
- Keep migrations reproducible with fresh `supabase db reset`.
- Do not change already-applied remote migrations. Add a new migration for fixes to already-remote schema.
- The current `20260927193000` migration is not remote yet, so it can be corrected directly until approved for push.

## Next action after all local tests pass

Stop and report:
- files changed,
- exact failures found/fixed,
- exact JS and SQL test results,
- whether fresh `supabase db reset` succeeds,
- `npx supabase migration list`,
- `npx supabase db push --dry-run` output.

Do **not** perform the real `supabase db push` or production deployment without explicit approval.
