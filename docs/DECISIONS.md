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
