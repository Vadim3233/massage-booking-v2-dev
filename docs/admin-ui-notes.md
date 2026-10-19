# Admin UI notes (from Vadim, 2026-10-19)

Saved as Vadim sent it, together with `docs/google-calendar-sync-brief.md`. Both refer to `booking-audit-state-machines-plan.md` and the Stage 0 test harness (`booking-db-harness.zip`), which Vadim is sending separately.

## How to work

1. **First, save both documents into the repo** as `docs/admin-ui-notes.md` and `docs/google-calendar-sync-brief.md`, so they stay with the code.
2. **Do the work in this order, each as its own branch / pull request:**
   1. Part A §1 – working hours on every day in the Calendar tab.
   2. Part A §2 – clear money outcome when cancelling, plus "Mark refund sent".
   3. Part A §3 – the share button (WhatsApp client / Share…).
   4. Part B – Google Calendar sync. **Before building anything for it, send me the outbox report** from Part B §6: which event types exist, which functions write them, and any booking changes that write no outbox row. Then show me the migration for review.
3. **Safety rules for everything:**
   - Never apply a migration or write anything to the dev database without showing me first and getting my OK.
   - Test locally first (`supabase start` + `supabase test db`) or on a Supabase branch.
   - The Stage 0 characterisation suites and race tests must pass unchanged, before and after each change. Show me the results.
   - None of these changes may alter booking behaviour, availability or state transitions.
   - Keep business rules in the database or in one shared place, never copied into React screens.
   - Don't deploy to production. Tell me when something is ready, and I'll test it on my phone first.
4. **The "Note for the state-machine plan" at the end of Part A needs no code now.** Keep it for Stage 3. If you edit the state-machine plan, add the (`confirmed`, `awaiting_transfer`) combination as described.
5. **When each part is done, tell me in a few plain sentences:** what changed, what I should test, and anything I must do myself (for Part B: the Google Cloud setup steps).

If anything in these documents conflicts with what you find in the code, stop and ask me instead of guessing.

**Answers given on 2026-10-19 when the brief was checked against the code:** the Google Calendar sync runs on Vercel next to the existing email sender, not in Supabase Edge Functions; nothing lapses (a booking waiting for a bank transfer stays until Vadim confirms or removes it); "Mark refund sent" already exists as **Record refund** on the booking sheet and is to be put on the cancelled card in the Calendar as well.

---

# Part A – Admin UI notes

## 1. Calendar tab: show working hours on every day

- Every day in the Calendar list shows its working hours, not only days with special hours. This includes days with no bookings.
- Normal days show the regular hours from `working_hours`, e.g. "14:30–21:00".
- Days with special hours keep the highlighted "Special hours" style, so they still stand out from normal days.
- Days off (no working hours, or a holiday such as Christmas Holidays) show "Day off" or the holiday name.
- If a day has a fixed first appointment (`fixed_start_minutes`), keep showing "first appointment at HH:MM".
- Take each date's hours from the **same source the booking engine uses** (regular hours, overridden by special hours or blocks). Ideally do this through one read-only RPC that returns the effective hours for a date range. The calendar must never show different hours from what clients can actually book. Don't duplicate the rules in React.

## 2. Cancel screen: make the money outcome clear

Context: Vadim cancelled a paid booking (£90 bank transfer) with "No fee". He expected nothing further to happen, then saw "Cancelled · refund £90.00 to send" and thought it was a bug. The behaviour was correct; the wording didn't make it clear.

- Before confirming a cancellation, show the money outcome in plain words, for example:
  - paid booking, no fee: "No cancellation fee – Andreas gets a full £90 refund"
  - paid booking, late fee kept: "Late cancellation – you keep £X, refund £Y"
  - unpaid booking: "No money has been paid – nothing to refund"
- The cancelled card needs a **"Mark refund sent"** action that clears the "refund to send" reminder once the transfer is done (plan T13 `admin_record_refund`). If something like this already exists, make sure it's visible on the card.

## 3. Booking screen: share booking details (mainly to the client on WhatsApp)

- Put a **share icon in the top-right** of the booking detail screen, next to the date and time.
- Tapping it offers two actions:
  - **"WhatsApp client"**: opens WhatsApp straight to the client's chat (`https://wa.me/<number>?text=<encoded message>`). Convert the client's phone number to international format without `+`, spaces or a leading 0, e.g. `07700 900123` → `447700900123`. Hide this action if the booking has no usable phone number.
  - **"Share…"**: opens the phone's native share sheet (Web Share API `navigator.share`) so Vadim can pick WhatsApp, email, Messages and so on. Where the share sheet isn't available (desktop), copy the text to the clipboard and show a "Copied" confirmation. Later, in the native app (Capacitor), use the Share plugin; the button stays the same.
- **The message text is built in one place** (one formatter function or a read-only RPC), not assembled separately in each button. It uses WhatsApp-friendly plain text: `*bold*` with single asterisks, no markdown headers or HTML. Example:

  ```
  *Massage booking – Thu 29 Oct, 17:30–19:30*
  55 Altenburg Gardens, London SW11 1JH
  Deep tissue · 120 min · £120
  Payment: bank transfer – awaiting payment
  ```

- Include: date, time, full address, treatments, total duration, total price, and the payment status in plain words (paid / cash due at the appointment / awaiting bank transfer). If a bank transfer is still due, add the payment instructions the client already sees in the client app (same source, not a second copy of the bank details).
- **Never include:** Vadim's private notes, admin notes, the client's own phone number or email, internal IDs, or the booking history.
- Cancelled bookings: hide the share icon, or share a short "This booking has been cancelled" message instead. Pick one and keep it consistent.
- Vadim can still edit the text in WhatsApp before sending. No message is ever sent automatically.

## Note for the state-machine plan (Stage 3)

Admin-created bookings are currently created as booking `confirmed` with payment `awaiting_transfer` (bank) and no `payment_reservation_expires_at`. Example: Andreas, Thu 29 Oct 17:30, created by admin 19 Oct. This is intended. Vadim confirms the appointment and the client pays later. But the combined-state table in `booking-audit-state-machines-plan.md` §1.4 only allows `confirmed` with `paid` or `approved`.

Before building the Stage 3 guard trigger:
- add (`confirmed`, `awaiting_transfer`) as an allowed combination, at least for admin-created bookings;
- check the transitions from it: verify transfer → `paid`, cancel → `void`, and what happens at completion if still unpaid;
- check that the Google Calendar brief titles this as a normal confirmed booking (it does, because it keys on booking status).
