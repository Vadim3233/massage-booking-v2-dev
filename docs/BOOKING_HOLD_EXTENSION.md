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

The hold runs invisibly during normal booking. In the original hold's final
60 seconds, an accessible modal offers Keep my time and Release time without
a ticking countdown. The page behind it is subdued and inert, with keyboard
focus kept inside the dialog. Extension updates
the draft only after a successful server response. Release and expiry preserve
the sessions, enhancements, preferences, contact/address details, notes and payment
choice, returning to time selection. The extension state survives reload and
suppresses any further warning for that hold. Network errors remain visible in
the modal for retry; a server rejection of a late extension returns to time
selection with a calm message.

The frontend reconciles the absolute server deadline on reload, navigation,
window focus, pageshow and visibility changes, in addition to its background
timer. Activity never renews a hold. Provisional payment reservations do not
show the pre-booking hold UI. This UX update requires no database migration.

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

## Hold UX verification (2026-10-05)

Frontend-only update: Vitest 83/83 across five files, including real local
Supabase RPC contracts; Playwright 23/23 across one file; lint, build and
`git diff --check` passed. The browser coverage includes the 60-second threshold,
keyboard focus wrapping, invisible normal holds, same-hold extension/retry,
release, real expiry, late server rejection, reload and resume without timer
ticks, plus existing guest/signed-in checkout and payment retry flows.
The mobile warning screenshot was visually inspected. Physical Android and
Safari were not tested. Run Vitest and Playwright sequentially: their local
fixtures currently share visible catalogue names and can collide if overlapped.
No database files changed; no reset, migration or deployment was performed.
