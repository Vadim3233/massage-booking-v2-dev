# VAD Massage Booking V2 — App Plan

Updated: 2026-09-27. This is the product plan, not a claim that every feature is implemented. Check code, migrations and deployment before marking work done.

## Goal and architecture

One booking platform with one authoritative database, availability engine, pricing and booking rules. Provide separate client and admin interfaces, plus a narrowly scoped API for future messaging or private assistants. Keep client and admin views in one repository initially; different deployments can be considered later without duplicating booking logic.

Proposed entry points: `booking.vadmassage.com/` (booking), `/account` (client account), `/admin` (admin). Suggested code areas: `src/client`, `src/admin`, `src/shared`, and booking rules in a server-side core. Exact paths can adapt to the existing V2 code. All writes and privileged reads must be enforced server-side with authentication, authorization and database policies; hiding UI is insufficient.

## Client experience

- Simple login/register with email or Google; booking steps: area, treatment, duration, date/time, address/contact, payment, confirmation.
- Mobile browser Back returns through steps with entered data preserved; warn before leaving unfinished booking.
- My Bookings: upcoming, past and cancelled; show details and payment instructions. Reschedule or cancel only where rules permit.
- Returning clients can reuse saved contact details and confirmed addresses. The WhatsApp number is a lookup clue, not sole proof of identity for sensitive account changes.

## Admin experience

- Private mobile-friendly calendar with bookings, travel, holds, blocked time and working hours. Booking details must fit narrow screens.
- Client records exist independently of accounts, bookings and Telegram connections. Add/edit clients, addresses, notes and preferences; create appointments separately.
- Manage booking status, cancellation, payment verification, schedule and availability. Action failures must be visible; never show success before persistence succeeds.
- Telegram notifications link to the exact authenticated admin record and do not present expired holds as active after payment/confirmation.

## Booking core and data contracts

- One source of truth for clients, addresses, bookings, booking holds, service areas, schedule, blocked periods, price rules and payment state.
- Availability applies working hours, treatment duration, existing bookings/holds, blocked periods, travel buffer and chain scheduling. Treatment must start at or after opening and finish at or before closing. Recheck and reserve atomically before final creation to prevent double booking.
- Distinguish multiple sessions from a single long treatment (for example two 60-minute sessions must retain two line items). Return the final quote before confirmation.
- Provide versioned, validated operations such as `identify_client`, `get_availability`, `quote_booking`, `create_booking_hold`, `confirm_booking`, `get_booking`, `reschedule_booking`, `cancel_booking`, and admin day summaries. Names are proposed contracts, not evidence of existing RPCs.
- Bank transfer is the default payment route; cash may require approval. Payment verification and booking confirmation are distinct states. Avoid recording a transfer as paid solely because the client says it was sent.


## Performance and maintainability guardrails from the V1 review

The V1 code-level review identified efficiency problems caused mainly by repeated data loading, duplicated state and accumulated code. V2 should preserve the product while preventing those patterns from returning.

- **Bound Calendar reads by date range.** Admin Calendar must request only the visible/needed range. Historical data should load separately instead of fetching the entire booking history whenever the date changes.
- **Deduplicate initial requests.** Avoid multiple components independently requesting the same booking/client/settings data during initial render. Shared query/cache ownership should be explicit.
- **Use canonical client reads.** Admin Clients must read canonical client records rather than rebuilding the client directory from all bookings on every render.
- **Database is authoritative.** Do not maintain competing business records in database columns, JSON notes, React state and browser storage. Browser caches may accelerate reads but must be disposable and clearly staleable.
- **Lazy-load heavy Admin surfaces.** Analytics, detailed Settings, receipts/documents and other infrequent panels should load only when opened. Calendar, Clients, bookings and payments remain immediately accessible.
- **Separate Client/Admin presentation bundles where useful.** Keep styles and components feature-scoped; avoid rebuilding another giant shared stylesheet with successive override layers.
- **Remove dead code instead of hiding it.** Do not retain permanently disabled JSX, superseded helpers or unused large assets in V2.
- **Memoize only real derived work.** Expensive derived lists or summaries should be calculated from stable inputs and recomputed only when those inputs change. Prefer better data ownership over adding cache layers everywhere.
- **Do not confuse file splitting with performance.** Splitting large files is required for ownership, testing and maintainability; actual runtime performance comes from bounded reads, lazy loading, reduced duplication and smaller active bundles.
- **Keep rare technical controls out of the primary workflow.** Advanced scheduling/configuration belongs under Settings/advanced areas, while Calendar, Clients, bookings and payments remain the operational core.
- **Never trade reliability for lightness.** Security checks, booking holds, buffer/conflict validation, server revalidation and regression/integration tests are mandatory even if removing them would make the code appear smaller.

These are V2 design constraints, not a request to spend time cleaning V1. The old app remains a reference while V2 implements the same useful behavior with clean ownership.

## Agent interfaces — planned, not integrated

Client WhatsApp conversation → approved Meta/WhatsApp integration → restricted VAD Booking API → booking core. An assistant may gather missing information and explain options; the booking core supplies valid slots and prices. Confirm appointment details with the client before creation. Recognize returning clients by normalized phone number, confirm their saved address and use stronger checks before exposing private details or changing an existing booking.

A private assistant for Vad may query calendar summaries, gaps and outstanding payments through separate admin-scoped operations. Any future Muse connection depends on actual product integration support and authorization; it is not assumed to exist. Verify current Meta capabilities, regional availability, pricing, WhatsApp account requirements, consent, messaging rules and supported tool access before implementation. Both interfaces use the same booking core, with different permissions.

### Agent-readiness adjustments to build into V2 now

These are architecture requirements for V2 even though the Meta/Muse/WhatsApp agent itself remains deferred. They prevent another redesign later.

1. **Channel-neutral booking core.** Web client, Admin and future WhatsApp/agent interfaces must call the same server-side availability, pricing, hold, booking, reschedule and cancellation rules. No booking logic may live only inside React screens.
2. **Dedicated integration boundary.** Keep a narrow, versioned server/API layer for external channels. The agent must never write directly to booking tables or bypass the normal booking rules.
3. **Canonical client identity.** `clients.id` remains the business identity. Auth accounts, phone numbers, WhatsApp, Telegram and future channels link to that client; none of those channel identifiers becomes the primary client record.
4. **Phone-number linking with verification.** Store normalized phone numbers for lookup and channel matching, but do not treat possession of a WhatsApp number alone as proof of identity for private booking history, address changes, cancellation or other sensitive actions.
5. **Booking source and actor audit.** Record how each booking/change was created, for example `web`, `admin`, `whatsapp_agent`, plus the acting client/admin/integration and timestamps.
6. **Idempotent write actions.** Agent-triggered holds, bookings, reschedules and cancellations require an idempotency/request key so repeated messages, webhook retries or tool retries cannot create duplicate bookings or duplicate state changes.
7. **Conversation draft separate from booking.** An agent may collect intent such as area, treatment, duration, preferred date/time and address, but that draft is not a booking until the client explicitly confirms and the booking core successfully finalizes it.
8. **Server-authoritative quotes.** The agent may explain prices, but final service price, area fee, congestion fee, availability and booking eligibility must come from the same server-side quote/booking operations used by the website.
9. **Explicit confirmation before mutations.** Before creating, rescheduling or cancelling, the agent must present the important details and receive clear confirmation. Read-only questions do not require the same confirmation level.
10. **Separate permission scopes.** A client-facing WhatsApp agent receives only client-safe actions. A private assistant for Vad uses separate admin-scoped operations. Never reuse an admin credential or service-role secret in a client-facing agent.
11. **Stable tool contracts.** External-agent operations need small validated request/response schemas so Meta/Muse can be added or replaced without changing the booking database or business rules.
12. **Event/outbox notifications.** Telegram, email and future WhatsApp confirmations should be produced from committed booking/payment events, not optimistic browser or agent state. This also allows reliable retries.
13. **Human handoff.** The integration must be able to stop automation and hand the conversation to Vad when information is ambiguous, the request is outside policy, payment needs review, or the agent encounters an error.
14. **Privacy and minimum disclosure.** Agent responses should expose only the client information needed for the current task. Do not reveal another person's booking/address because a phone number or name appears to match.
15. **Rate limiting and abuse controls.** Public agent operations require limits and validation comparable to the web booking flow so automated messaging cannot spam holds or create speculative bookings.
16. **Agent integration tests.** When an agent is implemented, test it against the real V2 booking contracts: returning-client lookup, availability, quote, hold, confirmation, duplicate webhook/retry, reschedule, cancellation, invalid request and human handoff.
17. **Provider independence.** Do not put Meta- or Muse-specific concepts into the booking data model. The booking app must continue to work if the external AI provider changes or the integration is unavailable.

### Agent interaction model

The intended architecture is:

`Website client / Admin / WhatsApp agent -> controlled V2 operations -> shared booking core -> Supabase`

The WhatsApp agent is another interface, not another booking system. It may collect the same information conversationally that the website collects through screens, but the booking core remains the authority.

## Policies to encode and verify

- Session durations: 60, 90 and 120 minutes. Current prices and travel/congestion fees must be stored as configurable values; verify against the live website before release.
- Public cancellation: free within one hour of booking and up to 24 hours before appointment; within 24 hours, up to 100% may apply. Clarify exact precedence and exceptions before implementation.
- Online rescheduling stops 24 hours before; online cancellation within 24 hours is blocked. A two-hour grace rule for bookings made within 24 hours needs explicit acceptance cases.
- New clients cannot hold further future reservations until first appointment is completed and paid; returning clients may have up to five future appointments in a 40-day window. Verify these policy decisions before shipping.
- Travel buffer defaults to 60 minutes; same-address consecutive sessions can use zero. Availability must use real address/area and route assumptions.

## Roadmap

| Phase | Status | Deliverable and acceptance evidence |
| --- | --- | --- |
| V2 foundation | Core verified | Vite/React, linked Supabase project and Vitest/local Supabase test runners are working; fresh local database resets reproduce committed migrations. |
| Scheduling engine | Core verified | JavaScript Chain Mode tests and database availability/hold/public-discovery contract tests pass locally; public availability and holds use the shared server scheduling implementation. |
| Data model and secure API | Core verified | Canonical identity, public discovery, pre-auth holds, client activation, quote and atomic finalization are deployed through migration `20260927193000`; read-only migration status verified 2026-09-27. No remote changes made during the UI slice. |
| Client booking | First slice implemented locally | Area through server-backed Confirmation, email/Google authentication, saved addresses, distinct sessions, preferences, enhancements, authoritative quotes and retry-safe finalization. See `CLIENT_BOOKING_SLICE.md` for verification and release gaps. |
| Admin | Read-only Calendar slice verified locally | `/admin` lazy-loaded shell, email/password authentication with existing Admin authorization, bounded day Calendar and persisted booking details. Client management, manual bookings, editing, payment/cancellation actions and settings remain planned. |
| Reliability release gate | Planned | Exercise real booking, change, cancellation, duplicate request and failed-payment paths against a safe environment; inspect network/database errors. |
| Agent-ready integration boundary | Planned with V2 core | Channel-neutral API, canonical client/channel links, idempotency, actor/source audit, event outbox and separate client/admin scopes. No Meta dependency yet. |
| WhatsApp receptionist | Deferred | Verify Meta integration path, then answer FAQs using approved business content. |
| WhatsApp booking actions | Deferred | Read live availability and create bookings only after confirmed details; audit actions and hand off exceptions. |
| Private assistant | Deferred | Admin-scoped summaries first; changes require explicit authorization and audit trail. |

## Maintenance

Update this file when scope or status changes. Record significant architectural choices in `DECISIONS.md`. Link implementation PRs or commits and evidence before marking a roadmap item Done. Do not treat prior V1 production state as proof that V2 has implemented a feature.

## Admin Calendar foundation — 2026-10-05

The first Admin slice is read-only. `/admin` uses normal Supabase email/password sign-in, rejects anonymous sessions, and checks `is_booking_admin()`. Existing table RLS authorizes every read. No browser service-role key, new RPC, policy or migration is introduced.

`src/admin/calendarApi.js` owns the read boundary. The day view requests `date >= selectedDate AND date < nextDate`; API ranges are limited to 31 days. Booking relationships load with that bounded query. Separate bounded requests load blocks, date overrides and active holds (without tokens/client keys); working hours read only relevant weekdays. Requests exceeding the server row limit surface an error rather than silently presenting an incomplete calendar. No historical booking/client directory scan occurs.

The compact two-row header supports previous/next day, date selection, Today and explicit refresh. Cards and read-only details include canonical client contact, booking email snapshot, visit address, separate sessions, stored preferences/enhancements, payment/status, price components, source and timestamps. Expired provisional reservations remain visible with an expiry label and do not occupy informational gaps. Holds disappear locally at their recorded deadline. Gaps include travel buffers but are not bookable-slot recommendations. The existing server availability engine remains authoritative.

Data refreshes on date changes or explicit refresh; realtime updates are deferred. Details use the exact record in the loaded range snapshot, not an optimistic or fabricated record. The compact header remains sticky so date controls stay immediately accessible. Physical phone/Safari testing and Admin account provisioning are not included. No Admin write controls, analytics, settings, Telegram or client directory were added.

Validation (2026-10-05), run sequentially: `npm test` 91/91 across 7 files (including real local Supabase Admin RLS/range/relationship tests); `npm run lint` passed; `npm run build` passed; `npx playwright test` 30/30 (7 Admin cases plus all 23 existing client journeys); `npx supabase test db` 147/147 across 10 files; `git diff --check` passed. Browser tests cover 320/360/390/412px, persisted exact-record details, cancellation, bounded date navigation, denied access, login failure and query error/retry. A 320px details screenshot was inspected. Work is isolated on `codex/admin-calendar-foundation`, based on `733072e`; original uncommitted date-field edits and installed skills remain untouched in the original worktree. No deployment or remote database operation was performed.

## Admin shell and payment review — local slice, 2026-10-07

The next slice adds compact Admin navigation, an independently bounded `/admin/review` queue and authenticated `/admin/bookings/:bookingId` deep links. Four narrow Admin payment commands preserve separate approval and receipt semantics and write command/outbox records atomically. See [ADMIN_PAYMENT_REVIEW.md](ADMIN_PAYMENT_REVIEW.md) for the audited state machine, security changes, retry contracts and release boundaries. This is a local implementation with a draft migration, not a hosted/production release.

Release-readiness audit (2026-10-07): corrected retained TRUNCATE privileges, client confirmation messages after Admin decisions, and stale read ordering after payment actions. Added local security, transition, concurrency and browser compatibility coverage. Hosted migration remains pending explicit approval and verification of the actual deployed frontend/schema baseline. Physical-device/Safari validation remains outstanding. No release action was taken.
