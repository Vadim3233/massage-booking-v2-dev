# Booking hold continuation

Implemented locally on 2026-09-28. No remote migration or deployment performed.

`20260928180000_booking_hold_extension.sql` changes new holds to 20 minutes and adds
`booking_holds.extended_at` plus `extend_booking_hold(uuid, uuid, text)`.
The extension requires the existing hold ID, token and opaque browser key. It
uses the same browser/date/row lock order as finalization and checks the actual
clock after obtaining the locks. Only an active, unexpired hold can be extended.
The original deadline gains ten minutes, capped at creation plus thirty minutes.
Retries return the existing extended deadline; they never add another extension.
Same-slot create retries now retain the ID, token and deadline instead of renewing
the hold. Changing the selection still atomically replaces the prior hold.

The sticky countdown remains above every booking screen. At five minutes or
less, an unextended hold offers Keep my time and Release time. Extension updates
the draft only after a successful server response. Release and expiry preserve
the sessions, enhancements, preferences, contact/address details, notes and payment
choice, returning to time selection. The extension state survives reload.

An ambiguous finalization response retains its original durable request for an
idempotent retry, even after local expiry. It must not be discarded: the server
may already have created the booking. A definite slot rejection returns to time
selection without showing confirmation.

Existing holds keep their original expiry when the migration is eventually
applied; only newly created holds start with twenty minutes. Repeated explicit
release/new-selection actions remain the existing new-hold workflow; this is not
a per-browser rate limit.

Validation uses pgTAP, real local Supabase HTTP calls (including concurrent
extension requests), booking store tests and mobile-viewport Playwright journeys.
No remote Supabase credentials or production writes are used by these tests.

Validated: local reset passed; pgTAP 109/109 across eight files; Vitest 67/67
across four files (nine real HTTP adapter tests); Playwright 9/9, including guest
and signed-in checkout. Build, lint and `git diff --check` passed. After removing
the redundant guest loading-state update, build/lint and the guest browser test
were checked again (1/1 passed).
