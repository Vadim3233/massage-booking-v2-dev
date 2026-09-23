# VAD Massage Booking V2 — Database Model

Updated: 2026-09-23.

This is the target V2 database model. It is a design specification, not evidence that the tables or RPCs already exist. Implement it through committed Supabase migrations and contract tests.

## 1. Core model

The database represents four different concepts separately:

- **Client** — the person/business record Vad knows.
- **Booking** — one visit to one address at one start time.
- **Session** — one person's treatment inside that booking.
- **Payment** — the payment state for that booking.

Example:

```
Client
  └─ Booking: 14:00 at one address
       ├─ Session 1: Massage, 60 min
       ├─ Session 2: Massage, 60 min
       └─ Payment
```

The booking reserves 120 treatment minutes, but the two sessions remain separate. `2 × 60` must never become `1 × 120`.

Travel buffer applies around the whole booking visit, not between sessions inside it.

## 2. Identity

### `admin_users`

Purpose: explicit Admin authorization.

Suggested columns:

- `user_id uuid primary key` → `auth.users.id`
- `created_at timestamptz`

Do not infer Admin rights from email addresses in frontend code.

### `clients`

Purpose: canonical business client.

Suggested columns:

- `id uuid primary key`
- `auth_user_id uuid null unique` → `auth.users.id`
- `first_name text`
- `last_name text`
- `email text`
- `normalized_email text`
- `phone text`
- `normalized_phone text`
- `online_booking_enabled boolean default true`
- `created_at timestamptz`
- `updated_at timestamptz`

Rules:

- Admin can create a client without an Auth account.
- Registration can link an Auth account to one canonical client.
- Phone/WhatsApp is a lookup clue, not the canonical identity.
- Clients never submit arbitrary `clients.id` values in public booking commands; server-side identity resolution derives it.

### `client_addresses`

Purpose: reusable saved addresses.

Suggested columns:

- `id uuid primary key`
- `client_id uuid not null` → `clients.id`
- `label text`
- `address_line_1 text`
- `address_line_2 text`
- `city text`
- `postcode text`
- `normalized_postcode text`
- `entry_instructions text`
- `is_default boolean default false`
- timestamps

Use a partial unique index so a client has at most one default address.

### `client_notes`

Purpose: Admin notes without mixing them into profile data.

Suggested columns:

- `id uuid primary key`
- `client_id uuid not null`
- `author_user_id uuid`
- `note text`
- `created_at timestamptz`

## 3. Service catalogue and pricing

### `services`

- `id uuid primary key`
- `slug text unique`
- `name text`
- `short_description text`
- `long_description text`
- `active boolean`
- `display_order integer`
- optional presentation metadata

### `service_duration_prices`

One authoritative price row per service/duration.

- `id uuid primary key`
- `service_id uuid not null`
- `duration_minutes integer not null`
- `price_gbp numeric(10,2) not null`
- `active boolean`
- unique `(service_id, duration_minutes)`

The browser and agent may display prices, but booking finalization recalculates them from this table.

### `enhancements`

- `id uuid primary key`
- `name text`
- `description text`
- `price_gbp numeric(10,2)`
- `duration_minutes integer default 0`
- `active boolean`
- `display_order integer`

### `session_preferences`

- `id uuid primary key`
- `label text`
- `category text`
- `active boolean`
- `display_order integer`

### `session_preference_conflicts`

- `preference_id uuid`
- `conflicting_preference_id uuid`
- primary key on both IDs

This replaces duplicated conflict arrays.

## 4. Coverage and fees

### `service_areas`

- `id uuid primary key`
- `slug text unique`
- `name text`
- `active boolean`
- `travel_surcharge_gbp numeric(10,2) default 0`
- `congestion_fee_gbp numeric(10,2) default 0`
- `display_order integer`

Later postcode/coverage rules can link to the area instead of being duplicated in bookings.

## 5. Scheduling configuration

Times are stored as minutes from midnight for the local business day. Business timezone is Europe/London.

### `working_hours`

Weekly defaults.

Suggested columns:

- `weekday smallint primary key` — ISO 1–7
- `available boolean`
- `start_minutes integer`
- `end_minutes integer`
- `start_mode text` — `flexible` or `fixed`
- `fixed_start_minutes integer null`
- optional release-rule fields if that V1 behavior is retained
- timestamps

### `working_hours_overrides`

Date-specific replacement/override.

- `date date primary key`
- `available boolean`
- `start_minutes integer`
- `end_minutes integer`
- `start_mode text`
- `fixed_start_minutes integer null`
- timestamps

The availability service resolves the effective day configuration before calling the Chain Mode rules.

### `calendar_blocks`

One table for Admin blocked time and personal events.

Suggested columns:

- `id uuid primary key`
- `date date not null`
- `start_minutes integer not null`
- `end_minutes integer not null`
- `kind text` — `blocked` or `personal_event`
- `title text null`
- `notes text null`
- `color_key text null`
- `created_by uuid`
- timestamps

Both kinds block public availability. Personal-event metadata is only presentation/admin context.

This intentionally avoids separate overlapping blocking tables.

## 6. Holds

### `booking_holds`

Purpose: temporary reservation while a booking is being completed.

Suggested columns:

- `id uuid primary key`
- `client_id uuid not null`
- `date date not null`
- `start_minutes integer not null`
- `treatment_duration_minutes integer not null`
- `travel_buffer_minutes integer not null`
- `expires_at timestamptz not null`
- `status text` — `active`, `consumed`, `released`
- `created_at timestamptz`

Rules:

- only active, unexpired holds block availability
- finalization validates ownership and expiry again
- consuming the hold happens in the same transaction that creates the booking
- failed finalization must not leave a partially created booking/payment
- public booking hold creation is rate-limited

Useful index:

- `(date, start_minutes, expires_at)` for active hold checks

## 7. Bookings

### `bookings`

One row = one visit.

Suggested columns:

- `id uuid primary key`
- `booking_reference text not null unique`
- `client_id uuid not null`
- `saved_address_id uuid null`
- `service_area_id uuid not null`
- `date date not null`
- `start_minutes integer not null`
- `treatment_duration_minutes integer not null`
- `travel_buffer_minutes integer not null default 60`
- `booking_status text not null`
- `source_channel text not null` — e.g. `web`, `admin`, later `whatsapp_agent`
- `created_by_actor_type text`
- `created_by_actor_id text null`
- immutable address snapshot fields:
  - `address_line_1_snapshot`
  - `address_line_2_snapshot`
  - `city_snapshot`
  - `postcode_snapshot`
  - `entry_instructions_snapshot`
  - `service_area_name_snapshot`
- authoritative money snapshots:
  - `service_subtotal_gbp`
  - `enhancements_total_gbp`
  - `travel_fee_gbp`
  - `congestion_fee_gbp`
  - `total_gbp`
- cancellation metadata:
  - `cancelled_at`
  - `cancelled_by_actor_type`
  - `cancelled_by_actor_id`
- timestamps

Why keep snapshots:

Client address, service name and prices may change later. Historical bookings must still display what was actually booked and charged.

Do not store a second competing booking object inside a JSON notes field.

Useful indexes:

- `(date, start_minutes)`
- `(client_id, date desc)`
- partial/filtered index for active future booking states where useful

### `booking_sessions`

One row per treatment/person inside a booking.

- `id uuid primary key`
- `booking_id uuid not null`
- `position integer not null`
- `service_id uuid not null`
- `duration_minutes integer not null`
- `service_name_snapshot text not null`
- `unit_price_gbp numeric(10,2) not null`
- optional `recipient_name text`
- unique `(booking_id, position)`

The sum of session durations must equal `bookings.treatment_duration_minutes` when the booking is finalized.

### `booking_session_preferences`

- `booking_session_id uuid`
- `preference_id uuid`
- `preference_label_snapshot text`
- primary key on booking session + preference

### `booking_enhancements`

- `id uuid primary key`
- `booking_id uuid not null`
- `enhancement_id uuid not null`
- `name_snapshot text`
- `price_gbp numeric(10,2)`
- `duration_minutes integer`

## 8. Payments

### `booking_payments`

One authoritative payment record per booking.

Suggested columns:

- `id uuid primary key`
- `booking_id uuid not null unique`
- `method text not null` — `bank_transfer`, `cash`
- `payment_status text not null`
- `amount_due_gbp numeric(10,2) not null`
- `reference text`
- `client_reported_at timestamptz null`
- `verified_at timestamptz null`
- `received_at timestamptz null`
- `approved_at timestamptz null`
- `rejected_at timestamptz null`
- `updated_by uuid null`
- timestamps

Do not duplicate payment status in another order object and a booking row.

Booking status and payment status are intentionally separate.

## 9. Status state machines

### Booking statuses

Initial target:

- `awaiting_payment_verification`
- `awaiting_cash_approval`
- `confirmed`
- `completed`
- `cancelled`
- `no_show`

Examples:

- bank transfer submitted → booking `awaiting_payment_verification`
- Admin verifies transfer → booking `confirmed`
- cash requested → booking `awaiting_cash_approval`
- Admin approves cash-on-arrival → booking `confirmed`
- cancellation does not automatically erase payment history

### Payment statuses

Initial target:

- `awaiting_verification`
- `cash_pending_approval`
- `cash_on_arrival`
- `paid`
- `refunded`
- `cancelled`
- `rejected`

The exact transition matrix must be implemented and tested before UI status controls are built.

## 10. Waitlist

### `waitlist_requests`

Suggested columns:

- `id uuid primary key`
- `client_id uuid not null`
- `service_id uuid`
- session/duration requirement
- date preference mode and values
- time preference mode and values
- flexibility minutes
- notes
- `status text`
- timestamps

Statuses retain the V1 concepts:

- joined/active
- offered
- accepted
- closed

### `waitlist_offers`

- `id uuid primary key`
- `waitlist_request_id uuid not null`
- offered date/time
- expiry if used
- status
- timestamps

Offers are history rows rather than destructive rewrites of the original request.

## 11. Messaging and integrations

### `telegram_connections`

Linked to canonical `client_id`.

### `telegram_invitations`

Linked to canonical `client_id`, with token, expiry and status.

### `command_requests`

Purpose: idempotency and audit for external/client/admin write commands.

Suggested columns:

- `id uuid primary key`
- `scope text not null`
- `idempotency_key text not null`
- `source_channel text not null`
- `actor_type text not null`
- `actor_id text null`
- `command_type text not null`
- `status text not null`
- `result_reference text null`
- timestamps
- unique `(scope, idempotency_key)`

This is especially important for future WhatsApp/webhook retries.

### `event_outbox`

Purpose: notifications originate from committed state.

Suggested columns:

- `id uuid primary key`
- `event_type text not null`
- `aggregate_type text not null`
- `aggregate_id uuid not null`
- `payload jsonb not null`
- `delivery_status text not null`
- `attempt_count integer default 0`
- `next_attempt_at timestamptz`
- `created_at timestamptz`
- `delivered_at timestamptz`

Email, Telegram and future WhatsApp notification workers consume this table.

## 12. Financial and document settings

These come later in the rebuild.

Do not block the booking-core schema on Analytics/receipt configuration.

When implemented:

- expenses should be canonical database rows
- financial settings should be database-backed
- receipt/document configuration should be database-backed
- Analytics reads canonical booking/payment/expense data and does not invent fallback revenue

## 13. RLS and authorization principles

### Client-safe access

Authenticated clients may:

- read/update their linked client profile where allowed
- read/manage their own saved addresses
- read their own bookings/sessions/payment state
- read their own waitlist requests
- call approved client RPCs

### Admin access

Admin role may read/manage operational records through Admin-safe policies/RPCs.

### Important write rule

Critical writes should go through validated RPCs rather than broad direct-table update policies.

Examples:

- finalizing a booking
- rescheduling
- cancellation
- payment verification
- cash approval/rejection
- Admin appointment creation

### Server/service-only

The following should not be directly writable by normal clients:

- `admin_users`
- `command_requests`
- `event_outbox`
- Admin notes
- payment verification fields
- pricing catalogue changes

## 14. Booking transaction contract

`finalize_client_booking` should execute one database transaction:

1. authenticate user
2. resolve canonical client
3. validate online-booking access/limits
4. validate idempotency key
5. lock and validate active hold
6. re-run scheduling conflict validation
7. validate service/session durations
8. calculate service prices
9. calculate area/travel/congestion fees
10. validate enhancements/preferences
11. create booking
12. create booking sessions
13. create preference/enhancement snapshot rows
14. create payment row
15. consume hold
16. write booking event/outbox rows
17. persist command result
18. return the finalized booking/quote

Any failure rolls the transaction back.

## 15. Proposed V2 booking operations

Names are targets and may be refined before SQL implementation:

### Client/read

- `get_public_booking_catalogue`
- `get_booking_availability`
- `quote_booking`
- `get_my_bookings`

### Client/write

- `create_booking_hold`
- `release_booking_hold`
- `finalize_client_booking`
- `reschedule_client_booking`
- `cancel_client_booking`
- waitlist create/cancel/accept operations

### Admin

- `get_admin_calendar_range`
- `create_admin_booking`
- `update_admin_booking`
- `cancel_admin_booking`
- `restore_admin_booking` if retained
- `verify_bank_transfer`
- `approve_cash_payment`
- `reject_cash_payment`

Keep contracts narrow. Do not recreate one universal JSON serializer for all operations.

## 16. Query/performance rules

Based on the V1 review:

- Admin Calendar loads a bounded visible date range, not all history.
- Client directory reads `clients`, not bookings-derived pseudo-clients.
- History loads separately from operational Calendar data.
- Use explicit selected columns rather than `select('*')` throughout UI code.
- Index date/client/status lookup paths before production.
- Analytics queries/loaders are separate from initial Admin Calendar loading.
- Browser caches are optional optimizations, never an authoritative fallback.

## 17. Migration order

Implement in small reviewable migrations.

1. common helpers / Admin role
2. clients
3. client addresses and notes
4. services and duration prices
5. enhancements and session preferences
6. service areas
7. working hours and date overrides
8. calendar blocks
9. bookings and booking sessions
10. booking session preferences/enhancements
11. booking holds
12. booking payments
13. waitlist
14. command/idempotency records
15. event outbox
16. RPCs and state transitions
17. final indexes/RLS hardening

Each migration phase gets database contract tests before the next critical layer depends on it.

## 18. First implementation slice

Do not create every table and every feature before proving the core.

First working vertical slice should include:

- Admin role
- clients
- client addresses
- services + duration prices
- service areas
- working hours
- calendar blocks
- bookings
- booking sessions
- holds
- payments
- `get_booking_availability`
- `create_booking_hold`
- `finalize_client_booking`
- My Bookings read
- bounded Admin Calendar read

Then prove one real bank-transfer booking from client selection through Admin visibility.

Waitlist, Telegram, Analytics, documents and financial features can follow after the core booking transaction is reliable.
