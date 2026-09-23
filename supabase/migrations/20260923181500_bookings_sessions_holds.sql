-- VAD Massage Booking V2
-- Foundation migration 4: bookings, booking sessions, and booking holds.
-- Payments and finalization RPCs are added in later migrations.

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_reference text not null unique,
  client_id uuid not null references public.clients(id) on delete restrict,
  saved_address_id uuid references public.client_addresses(id) on delete set null,
  service_area_id uuid not null references public.service_areas(id) on delete restrict,
  date date not null,
  start_minutes integer not null,
  treatment_duration_minutes integer not null,
  travel_buffer_minutes integer not null default 60,
  booking_status text not null,
  source_channel text not null,
  created_by_actor_type text,
  created_by_actor_id text,

  address_line_1_snapshot text not null,
  address_line_2_snapshot text,
  city_snapshot text not null,
  postcode_snapshot text not null,
  entry_instructions_snapshot text,
  service_area_name_snapshot text not null,

  service_subtotal_gbp numeric(10,2) not null default 0,
  enhancements_total_gbp numeric(10,2) not null default 0,
  travel_fee_gbp numeric(10,2) not null default 0,
  congestion_fee_gbp numeric(10,2) not null default 0,
  total_gbp numeric(10,2) not null default 0,

  cancelled_at timestamptz,
  cancelled_by_actor_type text,
  cancelled_by_actor_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bookings_reference_not_blank
    check (length(btrim(booking_reference)) > 0),
  constraint bookings_start_minutes_valid
    check (start_minutes between 0 and 1439),
  constraint bookings_treatment_duration_positive
    check (treatment_duration_minutes > 0),
  constraint bookings_treatment_fits_same_day
    check (start_minutes + treatment_duration_minutes <= 1440),
  constraint bookings_travel_buffer_nonnegative
    check (travel_buffer_minutes >= 0),
  constraint bookings_status_valid
    check (
      booking_status in (
        'awaiting_payment_verification',
        'awaiting_cash_approval',
        'confirmed',
        'completed',
        'cancelled',
        'no_show'
      )
    ),
  constraint bookings_source_channel_not_blank
    check (length(btrim(source_channel)) > 0),
  constraint bookings_address_line_1_not_blank
    check (length(btrim(address_line_1_snapshot)) > 0),
  constraint bookings_city_not_blank
    check (length(btrim(city_snapshot)) > 0),
  constraint bookings_postcode_not_blank
    check (length(btrim(postcode_snapshot)) > 0),
  constraint bookings_service_area_snapshot_not_blank
    check (length(btrim(service_area_name_snapshot)) > 0),
  constraint bookings_money_nonnegative
    check (
      service_subtotal_gbp >= 0
      and enhancements_total_gbp >= 0
      and travel_fee_gbp >= 0
      and congestion_fee_gbp >= 0
      and total_gbp >= 0
    ),
  constraint bookings_cancel_metadata_consistent
    check (
      (booking_status = 'cancelled' and cancelled_at is not null)
      or
      (booking_status <> 'cancelled' and cancelled_at is null)
    )
);

create trigger bookings_set_updated_at
before update on public.bookings
for each row execute function public.set_updated_at();

create index bookings_date_start_idx
  on public.bookings (date, start_minutes);

create index bookings_client_date_idx
  on public.bookings (client_id, date desc, start_minutes desc);

create index bookings_status_date_idx
  on public.bookings (booking_status, date, start_minutes);

alter table public.bookings enable row level security;

create policy "clients can read own bookings"
on public.bookings
for select
to authenticated
using (
  exists (
    select 1
    from public.clients
    where clients.id = bookings.client_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "admins can manage bookings"
on public.bookings
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.booking_sessions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  position integer not null,
  service_id uuid not null references public.services(id) on delete restrict,
  duration_minutes integer not null,
  service_name_snapshot text not null,
  unit_price_gbp numeric(10,2) not null,
  recipient_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (booking_id, position),

  constraint booking_sessions_position_positive
    check (position >= 1),
  constraint booking_sessions_duration_supported
    check (duration_minutes in (60, 90, 120)),
  constraint booking_sessions_service_name_not_blank
    check (length(btrim(service_name_snapshot)) > 0),
  constraint booking_sessions_unit_price_nonnegative
    check (unit_price_gbp >= 0)
);

create trigger booking_sessions_set_updated_at
before update on public.booking_sessions
for each row execute function public.set_updated_at();

create index booking_sessions_booking_position_idx
  on public.booking_sessions (booking_id, position);

alter table public.booking_sessions enable row level security;

create policy "clients can read own booking sessions"
on public.booking_sessions
for select
to authenticated
using (
  exists (
    select 1
    from public.bookings
    join public.clients on clients.id = bookings.client_id
    where bookings.id = booking_sessions.booking_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "admins can manage booking sessions"
on public.booking_sessions
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.booking_holds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  date date not null,
  start_minutes integer not null,
  treatment_duration_minutes integer not null,
  travel_buffer_minutes integer not null default 60,
  expires_at timestamptz not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint booking_holds_start_minutes_valid
    check (start_minutes between 0 and 1439),
  constraint booking_holds_duration_positive
    check (treatment_duration_minutes > 0),
  constraint booking_holds_treatment_fits_same_day
    check (start_minutes + treatment_duration_minutes <= 1440),
  constraint booking_holds_travel_buffer_nonnegative
    check (travel_buffer_minutes >= 0),
  constraint booking_holds_status_valid
    check (status in ('active', 'consumed', 'released'))
);

create trigger booking_holds_set_updated_at
before update on public.booking_holds
for each row execute function public.set_updated_at();

create index booking_holds_date_time_expiry_idx
  on public.booking_holds (date, start_minutes, expires_at);

create index booking_holds_client_status_idx
  on public.booking_holds (client_id, status, expires_at);

alter table public.booking_holds enable row level security;

create policy "clients can read own booking holds"
on public.booking_holds
for select
to authenticated
using (
  exists (
    select 1
    from public.clients
    where clients.id = booking_holds.client_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "admins can manage booking holds"
on public.booking_holds
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

-- Critical client-side writes are intentionally not granted directly.
-- Later RPCs will own hold creation/release and booking finalization.

revoke all on table public.bookings from anon;
revoke all on table public.booking_sessions from anon;
revoke all on table public.booking_holds from anon;

grant select on table public.bookings to authenticated;
grant select on table public.booking_sessions to authenticated;
grant select on table public.booking_holds to authenticated;

grant insert, update, delete on table public.bookings to authenticated;
grant insert, update, delete on table public.booking_sessions to authenticated;
grant insert, update, delete on table public.booking_holds to authenticated;
