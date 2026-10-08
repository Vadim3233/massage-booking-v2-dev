# VAD Massage Booking V2 — Decision Log

Updated: 2026-09-23. These are design decisions and intended requirements; implementation status belongs in `APP_PLAN.md`. Add dated entries when a decision changes, retaining earlier context.

## ADR-001 — One booking core, separate interfaces

**Decision:** Keep one Supabase-backed booking system and shared server-side rules, with distinct client and admin experiences in the same repository initially.

**Reason:** A client, Vad and a future messaging agent must receive the same availability, pricing and booking outcomes. Separate navigation and permission boundaries serve each role without synchronizing independent calendars.

## ADR-002 — Booking authority resides in the backend

**Decision:** The backend owns slot calculation, quotes, eligibility, holds, booking creation and changes. Revalidate and reserve atomically when confirming a booking.

**Reason:** Browser and conversational interfaces cannot safely enforce rules or prevent two requests taking the same slot. Meaningful tests must cover boundaries and conflicts.

## ADR-003 — Clients, accounts and channels are distinct

**Decision:** A client record can exist without an online account, booking or Telegram/WhatsApp connection. A normalized phone can help find a client; confirm saved address and verify identity for sensitive actions.

**Reason:** Vad creates client records offline, and contact details can change or be shared.

## ADR-004 — Agent-ready API without immediate Meta dependency

**Decision:** Design controlled booking operations that the website, admin and future approved integrations can call. Grant a client-facing WhatsApp agent only its necessary actions; any personal assistant uses separate admin-scoped access. Verify Meta Business Agent, Muse and WhatsApp Business Platform capabilities before choosing an integration.

**Reason:** Product access and APIs can change. The booking system must remain usable and authoritative regardless of an AI provider.

## ADR-005 — Payment and appointment state are explicit

**Decision:** Bank transfer instructions, verification, booking hold and confirmed appointment are separate concepts. A quoted or requested session is not automatically a paid booking.

**Reason:** Manual payment verification and hold expiry must be represented accurately in the app and notifications.

## ADR-006 — Documentation stays with implementation

**Decision:** Keep `docs/APP_PLAN.md` for scope, behavior and roadmap, and `docs/DECISIONS.md` for reasons behind architectural choices. Read both before substantial V2 changes and update them in the same change when decisions or status shift.

**Reason:** Repository history is easier to inspect than decisions scattered across chats. Status must be supported by code and acceptance evidence.

## ADR-007 — External agents are interfaces, not booking systems

**Decision:** Website, Admin, WhatsApp and any future Meta/Muse agent must call the same authoritative booking operations. External agents may not implement their own availability, pricing, booking-limit or conflict logic and may not write booking tables directly.

**Reason:** This prevents channel-specific behavior drift and allows an agent provider to be changed without changing the booking rules.

## ADR-008 — Agent writes require confirmation, idempotency and audit

**Decision:** Agent-triggered create/reschedule/cancel actions require explicit client confirmation, an idempotency/request key and an auditable source/actor record. Webhook or tool retries must be safe to repeat without duplicate bookings or duplicate mutations.

**Reason:** Messaging platforms and AI/tool calls can retry or repeat requests. A booking system must not interpret repeated delivery as repeated intent.

## ADR-009 — Channel identity does not replace canonical client identity

**Decision:** `clients.id` is the canonical business identity. Auth user IDs, phone numbers, WhatsApp identities, Telegram connections and other channels link to it. Phone-number matching may help identify a returning client but is not sufficient authorization for sensitive reads or changes.

**Reason:** Phone numbers can change, be shared or be entered incorrectly. Client history and booking changes need a stable record and stronger authorization boundaries.

## ADR-010 — Build agent readiness now; integrate Meta/Muse later

**Decision:** V2 will include a channel-neutral, versioned integration boundary, separate permission scopes, source/actor audit, idempotent commands and committed-event notification hooks as part of the core architecture. Actual Meta/Muse/WhatsApp agent implementation remains deferred until the core booking journeys are reliable and the current provider capabilities are verified.

**Reason:** These boundaries are inexpensive to design into the clean rebuild but expensive to retrofit after the database and booking contracts are established. They also avoid making V2 dependent on a particular external AI product.


## ADR-011 — Bounded reads and on-demand Admin loading

**Decision:** Calendar and operational reads must be scoped to the date/data range needed by the current screen. Historical data loads separately. Analytics, detailed Settings, receipts/documents and similarly heavy secondary surfaces should be lazy-loaded when opened.

**Reason:** V1 repeatedly loaded all bookings and bundled heavy Admin surfaces into the initial workspace. That increased database traffic, render work and coupling without adding product value.

## ADR-012 — Canonical records over derived or duplicated browser business state

**Decision:** Supabase canonical records are the source of truth for clients, bookings, payments and settings. Admin client lists come from canonical client data, not reconstruction from booking history. Browser storage and React state may hold temporary UI/draft/cache state only and must not become an alternative business database.

**Reason:** V1 represented booking/client data in database columns, JSON notes, React state and browser storage at the same time. The resulting contradictions and stale compatibility layers were a major reliability problem.

## ADR-013 — Maintainability changes must target ownership, not cosmetic file splitting

**Decision:** V2 will use feature-scoped components, styles and modules, but file splitting alone is not treated as a performance optimization. Performance work focuses on bounded queries, reduced duplicate work, lazy loading and smaller active bundles. Dead or permanently disabled code is removed rather than hidden.

**Reason:** V1's very large App/Admin/CSS files made regression risk high, while some runtime cost came from data-loading and repeated calculations rather than file size itself.


## ADR-014 — One visit, separate session rows

**Decision:** A booking represents one visit to one address and start time. Each person's treatment is stored as a separate `booking_sessions` row. The booking stores the summed treatment duration, while pricing and session identity remain per session.

**Reason:** This preserves the V1 client experience while permanently preventing the old `2 × 60 = 1 × 120` modelling error. It also keeps travel buffer around the visit rather than between sessions inside the same visit.

## ADR-015 — Payment has one authoritative record per booking

**Decision:** V2 uses one authoritative booking-payment record linked one-to-one with the booking. Booking status and payment status remain separate state machines; payment state is not duplicated in a second order authority and booking JSON notes.

**Reason:** V1 could disagree across order state, booking state and notes. A single payment authority makes verification, cash approval, cancellation and refund history explicit.

## ADR-016 — Calendar blocking uses one canonical block model

**Decision:** Date-specific unavailable time and Admin personal events use one canonical calendar-block model with a type/kind field and optional personal-event presentation metadata.

**Reason:** Both concepts block availability. A single scheduling-block source simplifies availability queries while still allowing Admin to distinguish blocked time from named personal events.

## ADR-017 — Client draft, finalization and payment reference (2026-09-27)

**Decision:** Keep unfinished booking inputs and an in-flight finalization request in versioned session storage; keep only the opaque hold client key in local storage. An ambiguous transport failure locks the request for retry using the identical payload and idempotency key. Store only the returned booking ID for subsequent authenticated server reads, not a browser booking database.

**Reason:** Reloads and authentication redirects must preserve the draft without creating duplicate bookings. Confirmation requires a successful finalization result or an authenticated read of the canonical booking.

**Decision:** Public bank details use explicit `VITE_BANK_*` configuration, matching V1's configuration approach. Finalization supplies the payment reference; the UI does not invent it before booking creation. Bank-transfer submission remains awaiting verification, and cash remains awaiting approval. No notification-delivery claims are made from the browser.

**Reason:** The deployed V2 finalization contract returns the reference only after the atomic transaction. A client-side reference or preliminary order would restore the V1 architecture defect. Missing bank configuration is visible and prevents bank-transfer submission.

## ADR-018 — Status changes are guarded and recorded in the database (2026-10-09)

**Decision:** `bookings.booking_status` and `booking_payments.status` may only move along the allowed transitions defined in `20261009100000_booking_status_guard_and_audit.sql` (for example `cancelled`, `completed` and `no_show` are final, and cash must be approved before it is paid). Every booking or payment creation and status change is recorded in the append-only `booking_status_events` table with the acting user, actor type and role. Admins can read the history; nobody can edit or delete it.

**Reason:** Browser roles already cannot write these tables, but SECURITY DEFINER commands, the service role and manual SQL could still make an impossible change with no record. Tests and fixtures must now reach a state by a legal path or by inserting rows in that state. History starts at this migration and is not backfilled.

## ADR-019 — Bookings waiting for payment are decided by the Admin, never by a timer (2026-10-10)

**Decision:** Nothing is cancelled automatically. A bank-transfer or cash booking that is waiting for payment keeps its time until the Admin confirms the payment or removes the booking. Removal (`admin_remove_pending_booking`) records the booking as cancelled by the Admin and rejects its payment record; nothing is deleted and no fee is implied. The Admin may also confirm a transfer the client never declared, and the Payment Review list shows every booking that is waiting, with when it was booked. Clients are limited only by the existing active-booking limit (one for a new client, five for a returning client). Clients cannot list or hold times more than 40 days ahead and need two hours' notice; Admin booking has no horizon.

**Reason:** The business is built on loyalty and personal follow-up. A client who pays late must not lose their time or be double-booked, and the Admin decides when a booking will not be paid or attended. `bookings.payment_reservation_expires_at` is kept for history but is deprecated and always null. Automatic expiry or reminders could be added later as an explicit change.

## ADR-020 — First-use scope, build order and operating choices (2026-10-10)

**Decision (owner's answers):**
- **First use:** the owner alone enters her own bookings first; clients are opened up later. Start using the app as soon as the daily core works, and add the rest while using it.
- **Build order:** (1) daily core: finish Admin New Booking; confirm/cancel/reschedule/complete/no-show with recorded reasons and history; Agenda/Today; client self-cancel and reschedule; (2) alerts; (3) schedule control (working hours, days off, overrides, block time and personal events); (4) clients (search, profile, addresses, notes/preferences, history); (5) settings screens for services, prices, areas, bank details and booking/cancellation rules, because she wants to change everything herself and not through the database; (6) waitlist. Quick contact actions (call, WhatsApp, directions) come with the daily core. Analytics, receipts, finance, diagnostics and the WhatsApp assistant stay out of scope for now.
- **Alerts:** Telegram, email and in-app for new bookings and "I've paid" claims, each with a link to the exact booking, sent from committed events (outbox). Telegram reuses the existing bot (token entered by the owner as a secret, never committed). Email uses Resend from an address on vadmassage.com (DNS records needed).
- **Client changes:** clients cancel and reschedule themselves. Inside 24 hours it is still allowed online, but the full appointment fee is recorded as due (the Admin can reduce or waive it). A booking can be cancelled free within one hour of being made. Fees are recorded; money is collected outside the app.
- **Accounts:** unchanged (sign in with email or Google as part of booking), which self-service needs.
- **Hosting and data:** booking.vadmassage.com on Vercel; start fresh with no import from V1. Test mostly on iPhone Safari, then Android Chrome.

**Reason:** Keeps the launch to what is needed to run the diary, in an order that lets real use find problems early. Supersedes the open question in ADR-019 about reminders: alerts are in scope, automatic cancellation is not.

## ADR-021 — Booking lifecycle: late fees, refunds and how changes are made (2026-10-10)

**Decision:** The Admin completes, no-shows, cancels and reschedules bookings only through retry-safe commands (`admin_complete_booking`, `admin_mark_no_show`, `admin_cancel_booking`, `admin_reschedule_booking`, `admin_settle_late_fee`, `admin_record_refund`), each recorded in the status or schedule history.
- A cancellation or change is free more than 24 hours before the appointment and free for one hour after the booking was made, even for a same-day appointment. Exactly 24 hours before is not "more than 24 hours", so it is charged.
- Inside 24 hours a client-requested cancellation or change is still allowed. The full appointment price is recorded as a late fee due; the Admin may set any amount from zero to the full price (zero waives it, and the standard amount stays on record). A change the Admin makes on her own account never charges the client. A second late change does not add a second fee.
- A no-show records the full price as due unless the Admin chooses a lower amount.
- Money is collected outside the app. If a paid booking is cancelled, the fee is kept from the payment and the balance is recorded as a refund due until the Admin records it as sent.
- Rescheduling uses the same availability engine as booking, ignoring the booking being moved; the Admin cannot place a booking in a time the engine would refuse. Admin booking has no 40-day horizon (a 365-day sanity limit remains).
- The fee rule lives only in the database (`late_fee_standard_gbp`); screens ask `admin_late_fee_preview` and never repeat it.

**Reason:** These are the owner's answers (ADR-020 and follow-up): clients should not have to message her for routine changes, loyal clients are treated kindly, and every money-affecting outcome is visible and reversible by her decision. Client self-service cancel and reschedule will call the same rule and engine.

## ADR-022 — Clients manage their own bookings at /account (2026-10-11)

**Decision:** A signed-in client (including a guest on the same device) sees their bookings at `/account` and can cancel or change the time without messaging the Admin. The page asks the database for everything it shows: the terms (`get_my_change_terms`), the times (`get_my_booking_availability`), and the result (`client_cancel_booking`, `client_reschedule_booking`). Inside 24 hours the change is allowed, but the client must tick that they understand the exact late fee; the command sends that fee back, and if it no longer matches (the 24-hour mark passed while the page was open) it refuses and the client reviews again. Changes use the client booking rules: two hours' notice, 40 days ahead, the same availability engine. Errors shown to clients are a fixed set of kind sentences; technical messages are replaced.

**Reason:** The owner wants routine changes to happen without a message to her, with the fee rule applied consistently and visibly. The Admin is told through the same event stream as other changes (`booking.cancelled` and `booking.rescheduled` carry `initiated_by: client`).

## ADR-023 — Alerts are written by the database and delivered by a small sender (2026-10-11)

**Decision:** When a booking event is committed, the database writes the finished message (title, text, link to the exact record) into `notification_deliveries` for three destinations: an in-app alert for the Admin, a Telegram message and an email to her, and where relevant an email to the client. In-app alerts need nothing outside the database. `api/dispatch-notifications.js` delivers the Telegram and email rows, records success or failure, and retries failures after 2, 8, 18 and 32 minutes (five attempts). It runs only for a caller who holds `CRON_SECRET` and uses the server-side service key, which is never in the browser or repository. The Admin is alerted about new online bookings, "I've paid", cash requests and client cancellations or moves, never about her own actions. Clients are emailed when a booking is confirmed, cancelled, moved or refunded.

**Reason:** One tested place owns the wording and the rules for who hears what, so Telegram, email and the app never disagree. The in-app list works even if Telegram or email is down. A narrow, secret-protected sender keeps the powerful key off the client and makes delivery failures visible rather than silent. Setup steps that need the owner's accounts are in `docs/NOTIFICATIONS_SETUP.md`.

## ADR-024 — The Admin edits her own schedule, with warnings instead of silent clashes (2026-10-11)

**Decision:** Working hours (usual week), special days (days off or different hours for one date) and blocked time or personal events are edited from the Admin app, directly in their tables, which already allow only the Admin and enforce valid times. Before saving a day off, shorter hours or a block, the screen asks `admin_schedule_conflicts` which live bookings (pending or confirmed, including their travel allowance) it would clash with, shows them by name, and lets her save anyway. Existing appointments are never moved or cancelled automatically. Times are chosen in 30-minute steps to match the availability engine, and the start-and-end rules are checked on screen with plain sentences before the database checks them again. Blocks make the time unavailable for treatment and for the travel around it (the availability engine already treats blocks that way).

**Reason:** She wants to change her hours, take days off and block personal time without touching the database. A warning that names the booking is safer than refusing the change, because a day off or a dentist visit may be unavoidable, and safer than silently leaving a booking in an impossible slot.

## ADR-025 — The Admin manages clients from a directory and profile (2026-10-11)

**Decision:** `/admin/clients` searches the canonical client records (the existing bounded search: 20 best matches) and adds new clients with an address. A client's profile shows contact links, a summary (visits, money paid, upcoming, last visit, next appointment, late fees and refunds still due, all computed by `admin_client_summary` on the server), editable details, saved addresses (add, change, make default, remove), private notes, booking history (loaded in pages of 15), and a switch for online booking. "New booking" from a profile opens the booking wizard with that client already chosen. Editing a client goes through `admin_update_client`, which refuses an email or phone another client already uses, so records cannot silently duplicate. A client's record, their login account and their bookings stay separate things: editing contact details does not change a login, and removing an address never changes a past booking, which keeps its own copy.

**Reason:** The owner needs to look someone up, see what they owe and when they last came, and correct details without the database. Keeping the contact fields behind one checked command prevents duplicate clients, and keeping money and visit totals on the server avoids loading a whole booking history to add up a number.

## ADR-026 — Services, prices, areas, extras and bank details are edited in the app (2026-10-11)

**Decision:** The Admin edits treatments (with the three lengths and their prices), extras, and areas (travel surcharge and congestion charge) from More. She can add, change, hide or show, and reorder them. Prices and fees apply to new bookings only; existing bookings keep the price they were booked at (they store their own copy). Hiding an item removes it from what clients can choose but keeps it for history. A shown treatment must offer at least one length. New items get a plain web-safe name derived from their name, kept unique. Bank details are saved through `admin_save_bank_details` (name, optional bank, six-digit sort code, eight-digit account number, optional note) into the Admin-only `business_settings` table. Clients receive them only through `get_bank_details()`, and only when they hold a client record (guests included). The build-time `VITE_BANK_*` values remain as a fallback for when nothing is saved.

**Reason:** She wants to change her prices, areas and bank details without touching the database or redeploying. Keeping bank details out of a public table and behind a function that answers only signed-in clients limits who can see them, and the fallback keeps current behaviour working until she has entered her own.

## ADR-027 — The booking rules are settings the Admin can change (2026-10-11)

**Decision:** Six rules live in `business_settings` and are edited at More, Booking rules: how many days ahead clients can book (40), hours of notice (2), free-cancellation window (24 hours), grace period after booking (60 minutes), and how many upcoming bookings a new client (1) or returning client (5) may hold. The booking, availability, reschedule and fee functions read them through `business_setting_int`, which falls back to the default if a value is missing or unusable, so a bad setting can never break booking. A rule applies from the moment it is saved to anything done afterwards; bookings already made and fees already recorded are not recalculated. Notice is now an exact time comparison (the appointment must start at least that long from now, across midnight), so a notice longer than the rest of today works correctly. The booking pages read the few public numbers they need (days ahead, notice, free window, grace) from `get_booking_rules()` so the date picker limit and the wording ("up to 24 hours before…") follow the settings. Admin booking is not limited by the horizon or notice. Ranges are enforced by the database and checked on screen first.

**Reason:** The owner wants to change these rules herself without a developer. Keeping every use of a number behind one reader means the wording, the limits and the fees cannot drift apart.

## ADR-028 — A simple waitlist that never books by itself (2026-10-11)

**Decision:** When the day a client chooses has no suitable times, the booking page offers to take their name, phone or email, a time of day (any, morning, afternoon or evening), the treatment length and an optional note. Anyone may do this without signing in (they are choosing a date before sign-in); a request is limited per phone number or email (three open requests), overall (300 open), and the same person asking twice for the same day and length is one request. The Admin sees open requests at More, Waitlist, soonest day first, each with the times that could be booked for that person right now (computed by the same availability engine as booking, inside their preferred time of day), quick call, WhatsApp and email links, and a private note. She can record that she offered a time, mark it not answered, close it as booked or no longer needed, and book for a client straight from the request when they already have a client record. She is alerted (in the app, Telegram and email) when someone joins and when a booking is cancelled or removed on a day people are waiting for. Nothing is ever booked, offered or messaged to the client automatically.

**Reason:** The owner asked for a waitlist but a workable one. Anyone's contact is taken only when there is genuinely nothing free, matching the real availability rules shows her at a glance who she can help, and keeping every offer and booking in her hands matches how she works with clients.

## ADR-029 — Design polish: the brand's type, one set of colours, and a calmer progress line (2026-10-11)

**Decision:** Headings use Playfair Display and interface text uses Inter (loaded from Google Fonts with a Georgia and system-font fallback), as the brand calls for. Every colour used by the app's stylesheets is now a named value in `src/index.css` (`--ink`, `--green`, `--gold`, `--danger` and so on), so the look can be changed in one place. On a phone the eight-step list in the booking flow becomes one line ("Step 4 of 8 · Date & Time") and a thin progress bar; the full list stays for screen readers and for wider screens. The brand mark is a small monogram instead of plain letters. The tab icon, title and description are VadMassage's own rather than the project template's. Buttons give a small response to touch and hover, and all motion is switched off for people who ask for reduced motion. Admin page titles use the heading face. Unused template leftovers (`App.css`, three sample images) were removed because nothing imports them.

**Reason:** The first impression for a client should feel warm and personal, and the screens should look like one product. Fonts from Google send visitors' addresses to Google; if that is not acceptable they can be served from the site itself instead (noted in `GO_LIVE_CHECKLIST.md`).
