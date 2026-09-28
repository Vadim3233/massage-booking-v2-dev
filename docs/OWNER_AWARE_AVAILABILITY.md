# Owner-aware booking availability

## Root cause

The public availability RPC previously accepted only date and duration. Its
internal Chain Mode query included all active holds, including the caller's own.
After a selection, an otherwise empty flexible day therefore returned only the
chain edges. `TimeStep` manually inserted the selected start, but could not restore
the genuine alternatives.

## Contract

`20260928190000_owner_aware_availability.sql` adds optional `p_hold_id`,
`p_hold_token` and `p_client_key` parameters to `get_booking_availability`.
Omitting all three preserves the existing public behavior. Partial identity
raises `22023`; an incorrect, expired, released or consumed identity raises
`42501`. All three must identify the same active, unexpired hold.

The internal five-argument `compute_booking_availability` accepts one excluded
hold UUID. It is not executable by public/anon/authenticated callers. The existing
three/four-argument internal entry points retain no-exclusion behavior for hold
creation, finalization and other scheduling writes. Only the validated public
RPC can pass an owner exclusion. Other holds, real bookings, calendar blocks,
working hours, travel buffers and notice rules keep their existing behavior.

The two-argument public function is replaced with a single signature with optional
arguments, avoiding PostgREST overload ambiguity while preserving old requests.
Apply this migration before releasing the frontend in a future approved rollout.

## Frontend

The booking store supplies its saved active hold and browser key through the API
adapter. Date & Time displays only the server response. It no longer manually
adds the selected start. Returning via Back, reload, and selecting a replacement
hold all fetch current owner-aware availability. Slot replacement continues to
use the existing atomic `create_booking_hold` flow.

Availability is advisory: another client can reserve a slot after it is shown.
The existing locked hold-creation/finalization RPCs remain authoritative for writes.
A stale identity from another tab produces a visible validation error rather than
excluding an unverified hold. No old slot-list cache or client-side scheduling
override was introduced.

## Local validation

- Fresh local Supabase reset succeeded.
- pgTAP: 125 assertions across 9 files, including 16 owner-aware assertions.
- Vitest: 70 tests across 4 files, including 10 real local HTTP adapter tests.
- Playwright: 10/10 passed, including guest/signed-in/extension and owner Back/reload coverage.
- Build, lint and `git diff --check` passed.

This migration is local only. No remote migration, merge to main or Vercel
deployment is part of this change.
