# Provisional payment and confirmation

Local implementation on `codex/payment-confirmation-ux`. No remote migration or
deployment has been performed. V1 payment/cash screens were inspected for UX
reference; implementation uses the V2 adapters, state store and RPCs.

## Lifecycle

The progress structure is unchanged: Payment is step 6, Confirmation step 7.
Continuing from Your Details revalidates the price and calls the existing
`finalize_client_booking` contract. For bank transfer this atomically consumes
the verified hold, creates one provisional booking/payment, generates its
reference, snapshots the canonical client's email/address/sessions/price, and
sets booking and payment to `awaiting_transfer`. The deadline is 60 minutes.
The browser never invents a booking or reference before server success.

Payment reads the scoped server record and displays the appointment, address,
formatted UK postcode, canonical email, total, bank details and copy actions.
`I've made the bank transfer` calls `declare_my_bank_transfer`. It records the
declaration timestamp and moves to awaiting verification, never paid. The cash
substate uses `confirm_my_cash_booking` to convert the same provisional booking
to a cash request awaiting approval. It does not create another booking.
Both RPCs are authenticated, client-owned, locked and idempotent by booking ID.
The shared Confirmation component reads the server record and uses explicit
client-facing payment labels and the approved method-specific wording.

## Expiry and safety

`payment_reservation_expires_at` is authoritative. Expired, undeclared bank
reservations are excluded by the internal SQL availability calculation and the
client booking-limit calculation. No scheduled job is needed to release their
availability. Rows remain for audit with the original `awaiting_transfer` state;
`get_my_booking` returns the effective `reservation_expired` flag. Future admin
reports must account for the deadline, rather than interpreting the raw status
alone as an active reservation.

Once declared, a transfer remains occupied awaiting verification after the old
deadline. Cash confirmation clears the provisional expiry. Expired reservations
cannot be declared or converted to cash. The UI preserves the draft and allows
a new slot selection only after the server confirms expiry. It tells clients
who already transferred money to contact Vad before booking again.

The existing finalization idempotency payload is preserved before writes. A
successful replay resolves the original result even if the catalogue has since
changed. Payment actions are also persisted before sending, and uncertain
responses can be retried or resolved by reloading the canonical booking. Changing
methods is disabled while a payment action has an uncertain result.

Bookings, sessions, enhancements, preferences, owner-aware availability, pricing,
limits, guest identity and hold security continue through the existing contracts.
No browser direct database write or new payment-paid capability was introduced.
Existing awaiting-verification bookings are not changed to awaiting transfer.

## Migration and rollout

`20260929100000_provisional_payment_reservations.sql` adds the expiry/email/declaration
fields, extends status constraints, replaces the availability/finalization
functions and adds the scoped read/payment RPCs. Older migration files are unchanged.
Migration and frontend need a coordinated reviewed rollout: the old frontend does
not know how to declare a newly provisional transfer. Do not deploy either part
without approval. Real transfer verification, delivery of notifications and admin
approval remain separate capabilities. Until notification delivery exists,
the UI says Vad will contact the client rather than promising automated
confirmation emails or reminders.

## Validation

- Fresh local reset passed.
- pgTAP: 146/146 assertions in 10 files (21 payment reservation assertions).
- Vitest: 78/78 tests in 5 files, including real local Supabase RPC adapters.
- Playwright: 15/15 journeys in one file, including both guest payment methods,
  signed-in checkout, expired reservations, lost reservation/transfer responses,
  reload, canonical email/postcode and existing hold/owner-aware availability.
- Build, lint and `git diff --check` passed.
- Mobile payment screenshot inspected; generated artifacts
  remain ignored, not part of source changes.
- After the countdown presentation adjustment, build/lint and the affected
  provisional-payment browser journey passed again (1/1).

> **Update (ADR-019, `20261010100000_pending_until_admin_decides.sql`):** the 60-minute deadline described above was removed. A booking waiting for payment keeps its time until the Admin confirms or removes it, the client no longer sees a countdown or an "expired" screen, and `get_my_booking` no longer returns `reservation_expired`.
