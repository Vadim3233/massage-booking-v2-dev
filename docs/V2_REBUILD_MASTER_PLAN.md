# V2 Rebuild Master Plan

## 1. Purpose

V2 is a clean rebuild of the existing VadMassage booking app.

The goal is **not** to invent a different product. The old app is the product specification and the source of lessons learned. We preserve the client and admin workflows that worked, but rebuild the data model, contracts, scheduling validation, and code organization so the system has one clear source of truth.

The old repository remains a read-only reference. V2 is implemented independently.

### Documentation hierarchy

- `docs/APP_PLAN.md` is the strategic product/architecture plan and includes agent-readiness requirements.
- `docs/DECISIONS.md` records durable architectural decisions and their reasons.
- `docs/DATABASE_MODEL.md` is the canonical target database/schema design.
- This file is the detailed V1-to-V2 rebuild/implementation plan.

Read these project documents before substantial architectural work. If they diverge, update the documents in the same change instead of creating another competing source of truth.

---

## 2. Sources reviewed

This plan is based on:

- the full public GitHub repository `Vadim3233/massage-booking-app`
- the existing V1 client booking screens and admin components
- V1 scheduling, booking, client-data, payment, waitlist, Telegram, email, settings, and analytics code
- the V1 Supabase migration history currently present in GitHub
- the September 2026 architecture/contract audit of production and local V1
- the existing development phase plan
- the current V2 repository and its Chain Mode tests

Important finding: V1 contains useful product behavior, but its repository, browser model, migrations, and live production contracts drifted apart. V2 must prevent that class of failure by design.

---

## 3. What we keep from V1

### Client account

Preserve the current account experience:

- email registration
- email confirmation
- email/password sign-in
- Google sign-in
- password recovery
- client access state / blocking
- client home
- My Bookings
- Account
- Terms of Service
- Privacy Notice

### Client booking journey

Preserve the V1 booking flow:

1. Area
2. Treatment
3. Duration
4. Date & Time
5. Review
6. Your Details
7. Payment
8. Confirmation

Do not redesign this flow unless a later product decision explicitly changes it.

#### Area

Preserve:

- active service-area list
- featured / additional areas
- travel surcharge
- congestion fee
- unavailable-area handling
- contact fallback when the location is outside the online-booking area

#### Treatment

Preserve:

- configurable service catalogue
- visible/hidden services
- title, description, and treatment presentation
- one selected treatment for the normal client booking flow

Do not carry V1 legacy service migrations into V2. V2 starts with one clean service catalogue.

#### Duration and multiple people

Preserve the V1 quantity model.

Examples:

- 1 × 60 minutes = one 60-minute session
- 2 × 60 minutes = two consecutive 60-minute sessions in one booking
- 60 + 90 = two consecutive sessions in one booking

A booking is one visit to one address. Sessions inside the booking are consecutive and have **no travel buffer between them**.

The booking's reserved treatment duration is the sum of its sessions.

`2 × 60` must remain distinct from `1 × 120` for pricing, session preferences, client display, analytics, and historical records.

#### Date & Time

Preserve:

- Chain / optimized availability
- working hours
- fixed/flexible first appointment behavior where retained
- date-specific overrides
- travel buffer
- booking holds
- minimum booking notice
- unavailable days
- waitlist entry point when no suitable time exists

V2's scheduling engine is the new implementation of these rules.

#### Review

Preserve:

- area/date/time/duration review
- edit links
- per-session summary
- per-session preferences
- free-text session note
- optional enhancements
- fee breakdown
- total price

#### Your Details

Preserve:

- full name
- email
- phone
- street address
- apartment/unit
- city
- postcode
- entry instructions
- additional notes
- reuse of saved client/address information where appropriate

#### Payment

Preserve the current business rules:

- bank transfer is primary
- cash is optional and requires approval
- pressing “I've made the bank transfer” does **not** mark the booking paid
- bank transfer remains awaiting verification until Admin verifies payment
- cash request remains under review until Admin approves it
- no fake card-payment flow

#### Confirmation

Preserve:

- booking reference
- appointment/session summary
- payment state
- bank-transfer details where applicable
- Telegram connection option
- My Bookings link
- immediate accidental-booking cancellation behavior where policy permits

### My Bookings

Preserve:

- Upcoming
- Past
- Cancelled
- booking details
- payment details
- Book Again
- rescheduling rules
- cancellation rules
- historical booking visibility after cancellation

### Waitlist

Preserve the V1 concepts:

- client request
- date preference
- time preference / range / no preference
- duration
- flexibility
- notes
- Active
- Offered
- Accepted
- Closed
- Admin slot matching
- Admin offer action
- client contact actions
- waitlist history

### Admin

Preserve the active V1 top-level areas:

- Calendar
- Clients
- Pending
- Waitlist
- Analytics
- Settings

#### Admin Calendar

Preserve:

- day/week/calendar navigation
- mobile-first compact calendar
- bookings
- travel blocks
- personal events
- appointment details
- create appointment
- edit appointment
- cancellation / restore/status actions
- payment actions
- working-hours controls
- date overrides
- weekly schedule
- admin override capability where intentionally allowed

#### Admin appointment creation

Preserve the useful V1 wizard behavior:

- select service/session(s)
- choose date/time
- select existing client
- create a new client
- review
- create
- personal event option

Client booking rules and Admin booking rules remain separate contracts.

#### Clients

Preserve:

- canonical client record independent of whether the client has an Auth account
- search/filter
- client profile
- phone/email/address
- notes
- appointment history
- total visits/spend summaries
- edit profile
- Book Appointment
- contact actions
- Telegram connection state/invitation

#### Pending / payment management

Preserve:

- bank-transfer verification
- cash approval/rejection
- paid state
- booking state
- clear payment history

Booking status and payment status are separate concepts.

#### Analytics

Preserve useful V1 analytics concepts:

- revenue
- expenses
- profit
- business target
- tax planning
- forecast
- booking volumes
- clients / repeat rate
- service performance
- area performance
- working efficiency
- travel vs treatment time
- CSV/export where still useful

Analytics must derive from canonical database records. It must not invent fallback revenue values.

#### Settings

Preserve active settings, but rebuild them around database-backed configuration.

Target settings groups:

- Scheduling & Availability
- Coverage Areas
- Services & Pricing
- Waitlist
- Payments
- Financial Settings
- Receipts & Documents
- Notifications
- Clients & Rebooking
- Security
- System

Do not automatically recreate V1 placeholder/stub settings just because a card existed.

### Notifications and documents

Preserve:

- Admin Telegram booking alerts
- payment alerts
- cancellation alerts
- waitlist alerts
- deep links to exact Admin records
- client Telegram connection
- transactional emails
- booking confirmation email
- cancellation email
- waitlist offer email
- receipt email
- configurable business/document details

Notifications should be triggered from finalized server state, not from optimistic browser state.

---

## 4. What went wrong in V1

V1's main problem was not a lack of features. It was accumulated architecture drift.

### 4.1 Monolithic files

The current old repository contains approximately:

- `src/App.jsx`: 326 KB
- `src/components/Admin/LiveAdminWorkspace.jsx`: 229 KB
- `src/styles/app.css`: 494 KB

Business rules, server calls, UI state, local persistence, booking logic, and rendering became interdependent.

V2 must never recreate this structure.

### 4.2 Multiple sources of truth

V1 mixed:

- React state
- localStorage
- Supabase tables
- JSON stored in `notes`
- duplicated booking fields
- compatibility fallbacks

Business data must have one authoritative source in V2: Supabase.

Local/session storage may hold only temporary UI state such as an unfinished booking draft or hold client key.

### 4.3 Frontend/database contract drift

The production-breaking V1 example was a shared serializer sending `client_id: null` to the normal client booking RPC even though the server rejected that key.

This happened because:

- Client create
- Admin create
- update

shared too much serialization code while their contracts were actually different.

V2 must use separate explicit contracts.

### 4.4 Non-atomic booking creation

V1 created an order first, then created the booking separately.

If booking creation failed:

- the order could already exist
- the booking did not exist
- the hold could remain active

V2 final booking creation must be a single atomic database transaction.

### 4.5 Duplicated payment authority

V1 could store payment state in both order and booking records.

V2 has one payment authority linked to the booking.

### 4.6 Browser-authoritative pricing

V1 accepted some price and fee values supplied from the browser.

V2 pricing is calculated and validated server-side from the configured service and area tables.

The browser may display an estimate, but it cannot decide the final amount.

### 4.7 Duplicated identity

V1 accumulated:

- Auth user ID
- canonical client ID
- client snapshots
- profile rows
- order client identity

V2 has one canonical `clients.id`.

An Auth user may link to a client through `clients.auth_user_id`.

Client booking RPCs derive the canonical client from the authenticated account. Clients never submit arbitrary canonical client IDs.

### 4.8 Duplicated booking/service representation

V1 represented the same information in several places such as:

- `service_id`
- `service`
- `service_name`
- `selected_services`
- `selected_durations`
- `notes.appBooking.items`

V2 uses normalized relational rows and only keeps deliberate immutable snapshots when history requires them.

### 4.9 Scheduling rules diverged

V1 preview, hold, create, update, and reschedule paths did not always apply identical buffer/conflict rules.

V2 defines one scheduling specification and proves parity between public availability and database validation.

### 4.10 Tests gave false confidence

V1 had many tests, but key tests used mocked RPCs or handcrafted payloads.

The production failure was therefore not caught.

V2 must include real integration tests against a production-equivalent local Supabase database.

### 4.11 Migration/repository drift

The old app accumulated reconciliation and repair migrations, and local/live state could be ahead of GitHub.

For V2:

- every schema change is committed first
- migrations are immutable after application
- a fresh `supabase db reset` must always reproduce the database
- production is never the only place where a schema fix exists

---

## 5. V2 architecture rules

These are non-negotiable.

### Rule 1 — V1 is a reference, not a code donor

Do not copy large V1 files into V2.

For every feature:

1. inspect V1 behavior
2. write the V2 requirement
3. write tests for the rule
4. implement the clean V2 module
5. compare the finished behavior with V1

### Rule 2 — Keep `App.jsx` thin

`App.jsx` should contain routing/layout composition only.

No booking calculations, Supabase payload construction, pricing calculations, payment-state logic, or Admin business rules belong in `App.jsx`.

### Rule 3 — Feature ownership

Each feature owns:

- UI
- state/hooks
- domain helpers
- API/repository adapter
- tests

A feature must not reach into another feature's private state.

### Rule 4 — Server is authoritative

The database/server decides:

- canonical client
- service validity
- duration validity
- price
- area fee
- congestion fee
- availability
- hold validity
- booking reference
- booking/payment state transitions

### Rule 5 — Separate RPC contracts

Never use one “universal booking serializer”.

Use separate contracts for:

- client availability
- booking hold
- client finalize
- Admin create
- Admin update
- client reschedule
- client cancel
- payment verification
- cash approval/rejection

### Rule 6 — Atomic finalization

One RPC must finalize a normal booking transaction:

1. authenticate client
2. resolve canonical client
3. validate booking access
4. validate hold
5. revalidate schedule
6. validate service/session selection
7. calculate authoritative price/fees
8. create booking
9. create booking sessions
10. create payment record
11. create enhancement/preference snapshots
12. consume hold
13. return finalized booking

Either all succeed or none succeed.

### Rule 7 — Explicit patch updates

Admin update operations must update only fields explicitly supplied.

Never serialize a full booking object and overwrite missing values with empty/null values.

### Rule 8 — No compatibility fallbacks in new code

V2 has one clean schema.

If the expected RPC/table/column is missing, fail loudly in development/testing. Do not silently query a legacy shape.

### Rule 9 — Notifications use committed records

Email/Telegram events are created from the finalized database result or an outbox/event row.

The browser must not be the authority for what notification was sent.

### Rule 10 — Tests are part of every feature

No feature is complete with UI alone.

---

## 6. Canonical V2 data model

The exact SQL will be implemented incrementally, but the model should remain conceptually stable.

### Identity

#### `clients`

Canonical business client.

Suggested fields:

- id
- auth_user_id nullable/unique
- first_name
- last_name
- phone
- email
- notes/flags only where appropriate
- online_booking_enabled
- created_at
- updated_at

Admin-created clients can exist without Auth.

#### `client_addresses`

- id
- client_id
- label
- address lines
- city
- postcode
- entry instructions
- default flag

Do not key addresses only to Auth user ID.

#### `client_notes`

Separate Admin notes with author/timestamp.

### Catalogue

#### `services`

- id
- name
- short description
- long description
- active
- display order
- visual metadata where needed

#### `service_duration_prices`

- service_id
- duration_minutes
- price
- active

Client-facing durations remain the configured 60/90/120 choices unless explicitly changed.

#### `enhancements`

- id
- name
- description
- price
- duration impact
- active
- display order

#### `session_preferences`

- id
- label
- category
- active
- display order

Conflicts can be stored in a relation rather than embedded duplicated arrays.

### Coverage

#### `service_areas`

- id
- name
- active
- travel surcharge
- congestion fee
- display order
- optional coverage rules/postcodes later

### Scheduling

#### `working_hours`

Weekly defaults.

#### `working_hours_overrides`

Date-specific overrides.

#### `blocked_periods`

Admin blocked time / unavailable intervals.

#### `personal_events`

Admin personal calendar items that reserve time.

#### `booking_holds`

- id
- owner/client
- date
- start
- reserved treatment duration
- travel buffer
- expires_at
- token/state

Expired holds never block availability.

### Booking

#### `bookings`

One visit to one address.

Suggested core fields:

- id
- booking_reference
- client_id
- date
- start_minutes
- treatment_duration_minutes
- travel_buffer_minutes
- address_id or immutable address snapshot
- service_area_id
- booking_status
- created_at
- cancelled_at
- cancelled_by
- cancellation_window

The booking stores the reserved visit window and historical snapshots needed to display the booking later.

#### `booking_sessions`

One row per person/session inside the visit.

Suggested fields:

- id
- booking_id
- position
- service_id
- duration_minutes
- unit_price
- optional person/display label
- service name snapshot if needed for permanent history

For a normal public booking, all sessions use the treatment selected on the Treatment step.

Example:

`2 × 60`:

- booking treatment duration = 120
- session 1 = 60
- session 2 = 60

There is no travel between the two session rows.

#### `booking_session_preferences`

- booking_session_id
- preference_id
- label snapshot

#### `booking_enhancements`

- booking_id
- enhancement_id
- name snapshot
- price snapshot
- duration snapshot

### Payment

#### `booking_payments`

One authoritative payment record for the booking.

Suggested fields:

- id
- booking_id unique
- method
- status
- amount
- reference
- reported_at
- verified_at
- received_at
- approved/rejected metadata where needed

Do not duplicate payment state in an unrelated “order” object unless a later requirement genuinely needs a separate order domain.

Booking status and payment status remain separate state machines.

### Waitlist

#### `waitlist_requests`

- id
- client_id
- service
- session/duration requirement
- date mode
- preferred date/range
- time mode
- preferred time/range
- flexibility
- notes
- status
- timestamps

#### `waitlist_offers`

Separate offer/history rows rather than overwriting the request.

### Messaging

#### `telegram_connections`
#### `telegram_invitations`

Canonical client linked.

### Financial / documents

Keep business configuration in explicit tables or one structured settings table per domain. Do not spread persistent business settings across localStorage.

---

## 7. Scheduling architecture

The current V2 Chain Mode engine is the scheduling specification.

Current tested V2 rules include:

- empty day with anchor
- empty day without anchor
- before-chain edge
- after-chain edge
- 90-minute edge behavior
- working-hours boundary
- multiple-booking outer chain boundaries
- internal gaps hidden
- blocked periods
- active holds
- expired holds

### Next scheduling test catalogue

Before UI/database booking work expands, build approximately 30–50 deterministic scheduling cases covering:

- 60/90/120-minute sessions
- multiple sessions such as 2×60 and 60+90
- first/last working-hour boundaries
- multiple bookings
- blocked periods
- active/expired holds
- personal events
- custom travel buffer
- zero travel buffer
- unavailable days
- weekly hours
- date overrides
- fixed first appointment
- flexible first appointment
- minimum booking notice
- same-day booking
- reschedule excluding the booking being moved
- cancelled/completed/non-blocking states
- simultaneous hold race

### Server parity

Public slot display and final booking validation must agree.

Use one canonical set of scheduling fixtures and run them against:

- the JavaScript scheduling specification
- the database availability/validation functions

A UI slot is never sufficient proof that the booking is valid. Finalization always rechecks under a database lock/transaction.

---

## 8. Clean client application structure

Suggested structure:

```
src/
  app/
    App.jsx
    routes.jsx

  features/
    auth/
    booking/
      components/
      hooks/
      bookingDraft.js
      bookingPricingView.js
      bookingApi.js
    scheduling/
      schedulingEngine.js
      schedulingFixtures.js
      schedulingApi.js
    clients/
    my-bookings/
    waitlist/
    payments/
    telegram/

    admin/
      shell/
      calendar/
      appointments/
      clients/
      pending/
      waitlist/
      analytics/
      settings/

  shared/
    components/
    formatting/
    validation/
    constants/

  lib/
    supabase/
      client.js
      errors.js
```

The exact names can evolve, but ownership boundaries should not.

---

## 9. Supabase contract strategy

### Read operations

Prefer small purpose-specific reads:

- client home/account
- service catalogue
- service areas
- availability
- My Bookings
- Admin calendar range
- Admin client profile
- pending payments
- waitlist

Do not use broad `select("*")` throughout the UI.

### Write operations

Use narrowly validated RPCs for important state transitions.

Examples:

- `create_booking_hold`
- `release_booking_hold`
- `finalize_client_booking`
- `create_admin_booking`
- `update_admin_booking`
- `reschedule_client_booking`
- `cancel_client_booking`
- `verify_booking_payment`
- `approve_cash_payment`
- `reject_cash_payment`

The exact names can change, but the separation must remain.

---

## 10. Status model

Define this once before building UI.

### Booking status examples

- awaiting_payment_verification
- awaiting_cash_approval
- confirmed
- completed
- cancelled
- no_show

### Payment status examples

- awaiting_verification
- cash_on_arrival
- paid
- cancelled/refunded where applicable

Do not make cancellation automatically erase payment history.

For example, a paid booking may later be cancelled; payment/refund status is a separate question.

All allowed state transitions should be documented and tested.

---

## 11. State and persistence rules

### Supabase

Authoritative for:

- clients
- addresses
- bookings
- sessions
- payments
- catalogue
- areas
- working schedule
- holds
- waitlist
- admin notes
- Telegram links
- financial data
- document settings

### Browser state only

Allowed for:

- current wizard step
- open/closed modals
- temporary unsaved booking draft
- scroll position
- temporary UI filters
- anonymous hold client key if still required

Never use localStorage as a fallback database.

---

## 12. Testing strategy

### Unit tests

Use Vitest auto-discovery.

Test:

- Chain Mode
- duration/session math
- price-display calculations
- state transition helpers
- cancellation policy timing
- booking access rules
- view-model formatting

Do not manually maintain one giant list of test filenames.

### Database contract tests

Run against a real local Supabase/Postgres schema built from migrations.

Must test actual payloads produced by the V2 frontend/repository modules.

Critical contract tests:

- client hold
- client finalization
- Admin create
- Admin update
- payment verification
- cash approval/rejection
- cancellation
- reschedule
- RLS ownership
- canonical client mapping

### End-to-end golden journeys

Use Playwright against the real test backend, not intercepted fake backend responses, for release-critical flows.

#### Golden client journey

1. register
2. confirm/sign in
3. choose area
4. choose treatment
5. choose session quantities
6. choose date/time
7. create hold
8. review/preferences/enhancements
9. enter details
10. choose bank transfer
11. finalize booking
12. verify DB booking/sessions/payment/hold
13. verify My Bookings
14. verify Admin Calendar
15. Admin verifies payment
16. verify client payment state
17. reschedule
18. verify both views
19. cancel
20. verify both views

#### Golden Admin journey

1. Admin sign-in
2. create canonical client
3. create booking
4. edit booking
5. change status/payment
6. add note
7. create personal event
8. cancel/restore as supported
9. verify calendar/client/pending views

### Migration tests

Every release must prove:

```
supabase db reset
npm test
npm run build
```

A brand-new database created only from committed V2 migrations must work.

---

## 13. Development order

Do not build every screen first and refactor later.

Architecture and tests are part of each phase.

### Phase 0 — Product reference and contracts

Status: in progress.

- inventory V1 features
- create this master plan
- keep V1 read-only
- define canonical entities
- define status/payment state machines
- create scheduling specification

### Phase 1 — Scheduling specification

Status: started.

- expand Chain Mode from current tests to 30–50 scenarios
- define working-hours/override model
- define blocking states
- define custom/zero travel behavior
- define multi-session reserved duration

Exit condition:

The scheduling rules are understandable from tests alone.

### Phase 2 — Clean Supabase foundation

Create one fresh V2 schema.

Order:

1. clients
2. addresses
3. services/prices
4. areas/fees
5. working hours/overrides/blocked periods
6. bookings
7. booking sessions
8. holds
9. payments
10. session preferences/enhancements
11. waitlist
12. notes/Telegram/financial/settings as needed

Add RLS and contract tests with each migration.

Exit condition:

A clean `supabase db reset` reproduces the whole V2 foundation.

### Phase 3 — One real client booking vertical slice

Build the existing V1 journey with minimal styling first:

Area → Treatment → Duration → Date & Time → Review → Details → Payment → Confirmation

The first objective is not every extra feature. It is one real booking that persists correctly.

Include:

- real service/area reads
- real schedule availability
- real hold
- atomic finalization
- bank transfer
- My Bookings visibility
- Admin visibility

Exit condition:

The real golden booking journey passes repeatedly without manual database repair.

### Phase 4 — Multi-session, preferences, enhancements, pricing

- quantity-based durations
- booking_sessions
- per-session preferences
- enhancements
- fee breakdown
- server-authoritative pricing

Regression requirement:

`2 × 60` can never become `1 × 120`.

### Phase 5 — Client account management

- saved profile
- saved addresses
- Book Again
- My Bookings
- reschedule
- cancel
- booking limits
- returning-client rules

### Phase 6 — Admin core

- Calendar
- Clients
- Pending
- appointment creation
- appointment edit/status
- payment verification
- personal events
- working schedule
- date overrides

Admin UI should be implemented as separate feature modules, not a new `LiveAdminWorkspace.jsx` monolith.

### Phase 7 — Waitlist and notifications

- waitlist client request
- Admin waitlist
- offers
- email
- Admin Telegram
- client Telegram linking
- authenticated Admin deep links

Use finalized database events/state for notifications.

### Phase 8 — Settings, analytics, financial, documents

Move only active V1 functionality.

Do not reintroduce placeholder settings.

### Phase 9 — UI parity and polish

Only after core journeys are stable:

- typography
- final visual styling
- animations
- compact Admin mobile header
- narrow viewport testing
- accessibility
- Android/system Back behavior
- browser history
- loading/error/empty states

### Phase 10 — Release verification

- real mobile devices
- Chrome/Safari/Android browser behavior
- production-equivalent Supabase
- fresh migration rebuild
- RLS review
- API protection
- notification tests
- performance
- backups/rollback plan
- old app remains live until V2 acceptance checklist passes

---

## 14. Definition of done for every feature

A feature is complete only when all relevant items exist:

- written behavior/rules
- database contract if persistent
- security/RLS rule
- frontend module
- error state
- loading state
- mobile behavior
- unit tests
- database integration test
- golden-path/E2E coverage where critical
- build passes
- no unrelated compatibility fallback

“Looks correct in the browser” is not completion.

---

## 15. Things we deliberately do NOT copy from V1

- the 326 KB App component
- the 229 KB Admin workspace component
- the 494 KB single CSS file
- sample bookings in production logic
- disabled/dead UI blocks
- localStorage as business-data persistence
- universal booking serializers
- direct-table fallbacks after RPC failure
- compatibility queries for columns that should exist
- duplicated service/location/payment representations
- browser-authoritative price calculation
- non-atomic order + booking creation
- manual test-file enumeration
- migration repair chains when a clean baseline can be created
- old service-catalogue migration baggage

---

## 16. Current V2 position

Already completed:

- clean Vite/React repository
- separate Supabase project
- Supabase client configuration
- Vitest
- first pure Chain Mode scheduling engine
- 11 passing scheduling tests covering the first chain/hold/blocked-period rules

The next development work should follow this plan rather than adding features ad hoc.

Immediate next sequence:

1. finish the scheduling test catalogue
2. define V2 canonical database schema and state machines
3. implement database scheduling/hold parity
4. build the first real client-booking vertical slice
5. prove the same booking appears correctly in Client and Admin views

---

## 17. Core principle

**Preserve the product. Replace the architecture.**

V1 tells us what clients and Admin need.

V2 must make each business concept exist once, each state transition explicit, each server contract narrow, and each critical journey provable by real integration tests.
