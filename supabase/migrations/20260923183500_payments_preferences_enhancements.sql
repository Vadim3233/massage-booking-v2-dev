-- VAD Massage Booking V2
-- Foundation migration 5: authoritative booking payment plus per-session
-- preferences and enhancements.
-- Client-side mutation remains RPC-only; direct writes are Admin-only via RLS.

create table public.booking_payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  method text not null,
  status text not null,
  amount_gbp numeric(10,2) not null,
  payment_reference text,
  admin_notes text,
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint booking_payments_method_valid
    check (method in ('bank_transfer', 'cash')),
  constraint booking_payments_status_valid
    check (
      status in (
        'awaiting_verification',
        'awaiting_approval',
        'approved',
        'paid',
        'rejected',
        'refunded'
      )
    ),
  constraint booking_payments_amount_nonnegative
    check (amount_gbp >= 0),
  constraint booking_payments_method_status_valid
    check (
      (
        method = 'bank_transfer'
        and status in ('awaiting_verification', 'paid', 'rejected', 'refunded')
      )
      or
      (
        method = 'cash'
        and status in ('awaiting_approval', 'approved', 'paid', 'rejected', 'refunded')
      )
    ),
  constraint booking_payments_paid_timestamp_consistent
    check (
      (status = 'paid' and paid_at is not null)
      or
      (status <> 'paid' and paid_at is null)
    ),
  constraint booking_payments_verification_consistent
    check (
      (verified_at is null and verified_by is null)
      or
      (verified_at is not null and verified_by is not null)
    )
);

create trigger booking_payments_set_updated_at
before update on public.booking_payments
for each row execute function public.set_updated_at();

create index booking_payments_status_created_idx
  on public.booking_payments (status, created_at);

alter table public.booking_payments enable row level security;

create policy "clients can read own booking payment"
on public.booking_payments
for select
to authenticated
using (
  exists (
    select 1
    from public.bookings
    join public.clients on clients.id = bookings.client_id
    where bookings.id = booking_payments.booking_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "admins can manage booking payments"
on public.booking_payments
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.booking_session_preferences (
  booking_session_id uuid not null references public.booking_sessions(id) on delete cascade,
  preference_id uuid not null references public.session_preferences(id) on delete restrict,
  preference_label_snapshot text not null,
  preference_category_snapshot text not null,
  created_at timestamptz not null default now(),

  primary key (booking_session_id, preference_id),

  constraint booking_session_preferences_label_not_blank
    check (length(btrim(preference_label_snapshot)) > 0),
  constraint booking_session_preferences_category_not_blank
    check (length(btrim(preference_category_snapshot)) > 0)
);

create index booking_session_preferences_preference_idx
  on public.booking_session_preferences (preference_id);

alter table public.booking_session_preferences enable row level security;

create policy "clients can read own booking session preferences"
on public.booking_session_preferences
for select
to authenticated
using (
  exists (
    select 1
    from public.booking_sessions
    join public.bookings on bookings.id = booking_sessions.booking_id
    join public.clients on clients.id = bookings.client_id
    where booking_sessions.id = booking_session_preferences.booking_session_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "admins can manage booking session preferences"
on public.booking_session_preferences
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.booking_session_enhancements (
  id uuid primary key default gen_random_uuid(),
  booking_session_id uuid not null references public.booking_sessions(id) on delete cascade,
  enhancement_id uuid not null references public.enhancements(id) on delete restrict,
  enhancement_name_snapshot text not null,
  quantity integer not null default 1,
  unit_price_gbp numeric(10,2) not null,
  duration_minutes_snapshot integer not null default 0,
  created_at timestamptz not null default now(),

  unique (booking_session_id, enhancement_id),

  constraint booking_session_enhancements_name_not_blank
    check (length(btrim(enhancement_name_snapshot)) > 0),
  constraint booking_session_enhancements_quantity_positive
    check (quantity > 0),
  constraint booking_session_enhancements_price_nonnegative
    check (unit_price_gbp >= 0),
  constraint booking_session_enhancements_duration_nonnegative
    check (duration_minutes_snapshot >= 0)
);

create index booking_session_enhancements_enhancement_idx
  on public.booking_session_enhancements (enhancement_id);

alter table public.booking_session_enhancements enable row level security;

create policy "clients can read own booking session enhancements"
on public.booking_session_enhancements
for select
to authenticated
using (
  exists (
    select 1
    from public.booking_sessions
    join public.bookings on bookings.id = booking_sessions.booking_id
    join public.clients on clients.id = bookings.client_id
    where booking_sessions.id = booking_session_enhancements.booking_session_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "admins can manage booking session enhancements"
on public.booking_session_enhancements
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

-- Direct client-side writes remain intentionally unavailable.
-- Finalization/payment RPCs will calculate authoritative amounts and create or
-- transition these records atomically.

revoke all on table public.booking_payments from anon;
revoke all on table public.booking_session_preferences from anon;
revoke all on table public.booking_session_enhancements from anon;

grant select on table public.booking_payments to authenticated;
grant select on table public.booking_session_preferences to authenticated;
grant select on table public.booking_session_enhancements to authenticated;

grant insert, update, delete on table public.booking_payments to authenticated;
grant insert, update, delete on table public.booking_session_preferences to authenticated;
grant insert, update, delete on table public.booking_session_enhancements to authenticated;
