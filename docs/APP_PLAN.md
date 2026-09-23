# VAD Massage Booking V2 — App Plan

Updated: 2026-09-23. This is the product plan, not a claim that every feature is implemented. Check code, migrations and deployment before marking work done.

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
| V2 foundation | In progress, verify repository | Vite/React, Supabase connection and test runner; inspect existing files before changing status. |
| Scheduling engine | In progress | Boundary, anchor, before-chain, buffer, hold and conflict scenarios pass meaningful tests. |
| Data model and secure API | Planned | Canonical client/address/booking schema; migrations and role-limited operations; atomic hold and booking flow; agent-ready versioned contracts, audit source/actor and idempotency. |
| Client booking | Planned | Complete a real booking end to end on mobile, including back navigation and payment instructions. |
| Admin | Planned | Calendar, clients, manual bookings, payment and cancellation actions work end to end on mobile. |
| Reliability release gate | Planned | Exercise real booking, change, cancellation, duplicate request and failed-payment paths against a safe environment; inspect network/database errors. |
| Agent-ready integration boundary | Planned with V2 core | Channel-neutral API, canonical client/channel links, idempotency, actor/source audit, event outbox and separate client/admin scopes. No Meta dependency yet. |
| WhatsApp receptionist | Deferred | Verify Meta integration path, then answer FAQs using approved business content. |
| WhatsApp booking actions | Deferred | Read live availability and create bookings only after confirmed details; audit actions and hand off exceptions. |
| Private assistant | Deferred | Admin-scoped summaries first; changes require explicit authorization and audit trail. |

## Maintenance

Update this file when scope or status changes. Record significant architectural choices in `DECISIONS.md`. Link implementation PRs or commits and evidence before marking a roadmap item Done. Do not treat prior V1 production state as proof that V2 has implemented a feature.
