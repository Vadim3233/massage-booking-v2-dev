# Google Calendar sync brief (from Vadim, 2026-10-19)

Saved as Vadim sent it (Part B of the brief whose Part A is in `docs/admin-ui-notes.md`).

**Answers given on 2026-10-19 when the brief was checked against the code:**
- **Where it runs:** on Vercel, next to the existing email and Telegram sender (`api/dispatch-notifications.js`, called every minute by Supabase `pg_cron`), not in Supabase Edge Functions (the project has none, and no test set-up for them). Wherever the brief says "Edge Function", read "Vercel function"; the Google secrets go in Vercel's settings.
- **Nothing lapses:** since migration `20261010100000_pending_until_admin_decides.sql` a booking waiting for a bank transfer is never expired (`payment_reservation_expires_at` is not used, and there is no `expired` status). Such a booking stays in the calendar, marked ⏳, until Vadim confirms or removes it. The "lapsed" rows of §2.1 and the matching tests in §7 do not apply.

---

Project: VadMassage booking app (`massage-booking-v2-dev`, Supabase `jxmnfwoeqglnhruadbhp`; React frontend on Vercel; code on GitHub)
Owner: Vadim (sole therapist and admin)
Related: `claude/booking-audit-state-machines-plan.md` (state machines, staged plan, Stage 0 test harness)

---

### 1. Goal

Every booking automatically appears in a dedicated Google Calendar called **"VadMassage bookings"** in Vadim's main Google account. Why:

- Vadim can see his bookings on his phone with **no internet**. The Google Calendar app keeps an offline copy.
- Vadim will share this calendar with his wife as **free/busy only**, so she can see when he's working and roughly when he'll be home. He does that manually in Google Calendar settings; no code is needed for it.

**Google Calendar is display-only.** It is one-way: database → Google. Edits made in Google never change bookings. Our database stays the only source of truth.

---

### 2. Decisions (already made by Vadim)

#### 2.1 Which bookings appear

| Booking state | In calendar? | Event title |
|---|---|---|
| `confirmed` | Yes | `Massage – {First} {Last}` |
| `awaiting_transfer` (reservation **not** lapsed) | Yes | `⏳ Awaiting payment – {First} {Last}` |
| `awaiting_transfer` with `payment_reservation_expires_at` < now | **No** (remove) | — |
| `awaiting_payment_verification` | Yes | `⏳ Payment being checked – {First} {Last}` |
| `awaiting_cash_approval` | Yes | `⏳ Awaiting cash approval – {First} {Last}` |
| `completed` | Yes (history) | `✓ Massage – {First} {Last}` |
| `no_show` | Yes (history) | `No-show – {First} {Last}` |
| `cancelled`, `expired` | **No** (remove) | — |
| Booking holds | **Never** | — |

Past bookings stay in the calendar as history. Vadim wants to look back at what he's had.

Note: there is no expiry sweep yet (Stage 4a), so a lapsed `awaiting_transfer` booking keeps that status in the database. The sync must work out the **effective** state from the time, not just the status column (see §4.4).

#### 2.2 Event contents: minimal on purpose

- **Title:** as in §2.1.
- **Time:** treatment start to treatment end, `Europe/London`.
- **Description:** the treatments/sessions and total duration only, e.g. `Deep tissue 60 min + Sports 30 min · 90 min total`.
- **Do NOT include:** address, phone, email, prices, payment amounts, client notes, or internal IDs (beyond what's needed in the private extended properties, below).
- Store `booking_id` in `extendedProperties.private` so events can be traced. It isn't shown to anyone.

#### 2.3 Travel time

- After each booking event, create a separate event titled **`Travel`**.
- Its duration comes from that booking's own `bookings.travel_buffer_minutes` (60 today). **Do not hard-code 60.**
- If the buffer is 0 (future same-address work, Stage 8c), create no travel event.
- The travel event is removed whenever its booking is removed.
- Both booking and travel events are marked busy (`transparency: opaque`), so they show as busy on the free/busy share.

#### 2.4 Google account and calendar

- Vadim's main Google account, the one already on his phone.
- The system **creates its own secondary calendar** named "VadMassage bookings" and only touches that calendar.
- Use the narrowest scope that allows this. Preferred: `https://www.googleapis.com/auth/calendar.app.created`. It covers secondary calendars the app creates and their events, with no access to Vadim's other calendars. Verify this scope against current Google docs before relying on it.

---

### 3. Architecture

```
booking RPCs ──► event_outbox (already written today)
                     │
        pg_cron (every minute) ──► Edge Function `calendar-sync`
                     │                 ├─ claims outbox rows (FOR UPDATE SKIP LOCKED)
                     │                 ├─ for each affected booking: build DESIRED events from CURRENT db state
                     │                 └─ upsert / delete in Google Calendar
        pg_cron (every 15 min) ──► reconcile pass (catches lapsed reservations + anything missed)
```

This is effectively the **first consumer of the Stage 6 outbox worker**. Build it so that later consumers (e-mail/push notifications) can be added without rework.

#### 3.1 Key principles

1. **State-based, not event-based.** Outbox rows only say *which booking changed*. The worker always re-reads the booking's current state and makes Google match it. So order, duplicates and missed events don't matter.
2. **Failure isolation.** A Google outage or error must **never** block, roll back or alter any booking transaction. The sync runs in its own transactions, after the fact.
3. **Idempotent.** Running the same sync twice produces the same calendar, never duplicate events.
4. **No secrets in the client.** Google tokens live only on the server (Supabase Vault). The browser never sees them.

---

### 4. What to build

#### 4.1 Database (one migration)

- **`calendar_connection`** (single row): Google account email, calendar id, connected_at, status (`connected` / `needs_reconnect` / `disconnected`), last_success_at, last_error, last_error_at. The refresh token goes in **Supabase Vault**, referenced by id, not in a plain column.
- **`calendar_sync_events`**: `booking_id`, `kind` (`booking` | `travel`), `google_event_id`, `content_hash` (of the last pushed contents, to skip no-op updates), `synced_at`, plus a unique key on (`booking_id`, `kind`).
- **Per-consumer outbox delivery**: don't flip a single global "processed" flag on `event_outbox`. Other consumers will come later. Add a delivery table such as `outbox_deliveries(outbox_id, consumer, status, attempts, next_attempt_at, last_error)`, or an equivalent per-consumer cursor. Statuses: `pending`, `done`, `failed`, with backoff and `failed` after N attempts.
- **`calendar_desired_events(p_from date, p_to date)`**: a SECURITY DEFINER SQL function that returns exactly what the calendar *should* contain: booking id, kind, title, start, end, description, hash. **All the rules in §2 live here, in one place**, so they can be tested with pgTAP.
- **Privileges:** follow the Stage 2 rules. New tables get **no** grants to `anon`/`authenticated` (admin read access through a view or RPC if the admin screen needs it). Watch out for Supabase's default privileges giving new tables full access. Revoke explicitly and add the tables to the grant-matrix test.

#### 4.2 Edge Function `calendar-sync`

- It is called by pg_cron (via pg_net) every minute, and it's protected so only the scheduler or the service role can call it.
- It claims pending deliveries for this consumer with `FOR UPDATE SKIP LOCKED`, and collects the distinct `booking_id`s.
- For each booking, it compares `calendar_desired_events` (for that booking) against `calendar_sync_events`, then:
  - **insert** missing events;
  - **update** events whose hash changed;
  - **delete** events that should no longer exist.
- **Deterministic Google event ids:** for example `vm` + booking UUID hex without dashes + `b` (booking) or `t` (travel). Google allows lowercase a–v and 0–9, and that format fits. This makes inserts idempotent even if the mapping row is lost.
  - Handle the case where an id was previously deleted. Google keeps cancelled events, so re-inserting with the same id returns 409. In that case, update the event back to `status: confirmed`.
- Retry Google 429/5xx errors with backoff. Treat 401 or `invalid_grant` as "needs reconnect": set the connection status and stop trying until Vadim reconnects.
- It logs nothing sensitive (no tokens; client names only where needed for debugging).

#### 4.3 Connect / disconnect flow (admin only)

- Admin settings screen: a **"Connect Google Calendar"** button that starts Google OAuth (offline access, so we get a refresh token).
- The OAuth callback runs in an Edge Function and stores the refresh token in Vault. It creates the "VadMassage bookings" calendar if one doesn't exist yet (store its id), then triggers a **backfill**.
- The screen shows the connection status, the account email, the last successful sync, any last error in plain English, and a **"Resync now"** button.
- **Disconnect** revokes the token, clears it from Vault, and stops syncing. It leaves the calendar in place; Vadim can delete it himself.
- Only admins can reach any of this (use the existing admin check).

#### 4.4 Backfill and reconcile

- **Backfill** (on first connect, and from "Resync now"): sync all non-cancelled bookings, past and future.
- **Reconcile** (pg_cron every 15 minutes): run the same diff for a window of roughly the last 7 days to the next 60 days. This is what removes `awaiting_transfer` bookings whose payment window has lapsed, since nothing in the database fires an event when that happens. It also repairs anything missed, such as manual changes in the Google app.
- **Nightly full reconcile** across all bookings.

#### 4.5 Google Cloud setup (Vadim does this; write him step-by-step instructions)

- Create a Google Cloud project, enable the Calendar API, and set up the OAuth consent screen and OAuth client (web application, redirect URI = callback Edge Function).
- **Important:** while the consent screen is in "Testing" mode, Google refresh tokens expire after about 7 days. The app must be set to **"In production"**, or the sync will silently stop every week. For a single-user app, Google's "unverified app" warning on the one-time sign-in is acceptable; explain it to Vadim beforehand. Check the current Google policy for the chosen scope.
- Put the client id and secret in Supabase secrets, never in the repo or the frontend.

---

### 5. Out of scope

- Sharing with Vadim's wife. He does this himself in Google Calendar: Settings → the calendar → *Share with specific people* → **"See only free/busy (hide details)"**. Just include these steps in the handover notes.
- Address, phone, payment or notes in events.
- Two-way sync (Google → database).
- Clients' calendars or invites to clients.
- The native/offline app (Capacitor). That's a separate later project.
- Any change to booking behaviour, availability or state transitions.

---

### 6. Rules of engagement (same as the main plan)

- **Never run anything straight onto dev.** Work against a local stack (`supabase start`) or a Supabase branch first. Show Vadim the migration before applying it to dev.
- Stages 1 and 2 are drafted and tested but **not yet applied** to dev. This feature must not depend on them. Read the travel buffer from the booking row, not from `business_settings`. Do apply the Stage 2 privilege principles to the new tables.
- **The Stage 0 characterisation suites must pass unchanged.** This feature changes no booking behaviour.
- First, inspect what `event_outbox` actually contains today: which event types are written, by which RPCs, and with what payload. Report any booking change that writes **no** outbox row. Those paths rely on the reconcile pass, and the gap should be listed for later stages.
- One migration for the database part. Write a rollback script.

---

### 7. Tests

**pgTAP: `calendar_desired_events`**
- One assertion per row of the §2.1 table (status → present or absent, and the exact title).
- A lapsed `awaiting_transfer` is absent; an unlapsed one is present. Test at a boundary of ±1 minute, using a fixed "now".
- A travel event follows each booking, with the booking's own buffer. A buffer of 0 gives no travel event.
- Holds never appear.
- The description contains treatments and duration, and **contains no address, phone, email, price or notes**. Assert this explicitly against a fixture that has all of those fields filled in.
- London time is correct across the clocks change: the last Sunday in October 2026 is 25 Oct, so include bookings on 24, 25 and 26 Oct.

**Grant matrix**
- `anon` and `authenticated` (including admin) cannot read the token or write to any new table.

**Worker (Google API mocked)**
- New booking → one booking event plus one travel event.
- The same outbox row processed twice → still exactly one of each.
- Cancel → both deleted. Cancel then a re-run → no error.
- A deleted-then-recreated id (409 path) → recovered via update.
- Google 500 → retried with backoff, then `failed` after N attempts. **The booking row is untouched throughout.**
- `invalid_grant` → connection set to `needs_reconnect`, no further Google calls.
- Reconcile removes a lapsed `awaiting_transfer` event with no outbox row involved.

**Regression**
- All Stage 0 suites and race tests pass unchanged.

---

### 8. Deliverables

1. Migration plus rollback script.
2. Edge Functions: `calendar-sync`, the OAuth start and callback functions.
3. pg_cron jobs: every minute (worker), every 15 minutes (reconcile), nightly (full reconcile).
4. Admin settings UI: connect, status, resync, disconnect.
5. Tests as in §7, added to the existing harness.
6. A short handover note for Vadim in plain English: the Google Cloud setup steps, how to connect, how to share with his wife as free/busy, and what to do if the status says "needs reconnect".
7. (The brief as sent ends here.)
