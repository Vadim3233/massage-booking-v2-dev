-- VAD Massage Booking V2
-- Stage 3: guard booking and payment status changes and keep an append-only audit trail.
--
-- Browser roles already cannot write bookings or booking_payments (see
-- 20261007120000_admin_payment_review.sql). This migration protects the remaining paths:
-- SECURITY DEFINER commands, the service role and manual SQL. It adds:
--   * an allowed-transition check on bookings.booking_status and booking_payments.status
--   * public.booking_status_events, an append-only history of every status change
-- Existing rows get no backfilled history; events start from this migration.

create table public.booking_status_events (
  id uuid primary key default gen_random_uuid(),
  entity text not null,
  booking_id uuid not null,
  payment_id uuid,
  from_status text,
  to_status text not null,
  actor_user_id uuid,
  actor_type text not null,
  actor_role text not null,
  occurred_at timestamptz not null default clock_timestamp(),

  constraint booking_status_events_entity_valid
    check (entity in ('booking', 'payment')),
  constraint booking_status_events_payment_matches_entity
    check ((entity = 'payment') = (payment_id is not null)),
  constraint booking_status_events_actor_type_valid
    check (actor_type in ('admin', 'client', 'system'))
);

-- No foreign key on purpose: history must outlive a deleted booking.
create index booking_status_events_booking_idx
  on public.booking_status_events (booking_id, occurred_at);

alter table public.booking_status_events enable row level security;

create policy "admins can read booking status events"
on public.booking_status_events
for select
to authenticated
using (public.is_booking_admin());

revoke all on table public.booking_status_events from public;
revoke all on table public.booking_status_events from anon;
revoke all on table public.booking_status_events from authenticated;
grant select on table public.booking_status_events to authenticated;

create function public.reject_booking_status_event_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Booking status history is append-only' using errcode = '42501';
end;
$$;

create trigger booking_status_events_append_only
before update or delete on public.booking_status_events
for each row execute function public.reject_booking_status_event_change();

create trigger booking_status_events_no_truncate
before truncate on public.booking_status_events
for each statement execute function public.reject_booking_status_event_change();

create function public.guard_booking_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.booking_status is not distinct from old.booking_status then
    return new;
  end if;

  if not (
    (old.booking_status = 'awaiting_transfer'
      and new.booking_status in ('awaiting_payment_verification', 'awaiting_cash_approval', 'cancelled'))
    or (old.booking_status = 'awaiting_payment_verification'
      and new.booking_status in ('confirmed', 'cancelled'))
    or (old.booking_status = 'awaiting_cash_approval'
      and new.booking_status in ('confirmed', 'cancelled'))
    or (old.booking_status = 'confirmed'
      and new.booking_status in ('completed', 'cancelled', 'no_show'))
  ) then
    raise exception 'Booking status change not allowed: % to %', old.booking_status, new.booking_status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create function public.guard_booking_payment_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'awaiting_transfer'
      and new.status in ('awaiting_verification', 'awaiting_approval', 'paid', 'rejected'))
    or (old.status = 'awaiting_verification'
      and new.status in ('paid', 'rejected'))
    or (old.status = 'awaiting_approval'
      and new.status in ('approved', 'rejected'))
    or (old.status = 'approved'
      and new.status in ('paid', 'rejected'))
    or (old.status = 'paid'
      and new.status = 'refunded')
  ) then
    raise exception 'Payment status change not allowed: % to %', old.status, new.status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create function public.record_booking_status_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text := coalesce((v_claims::jsonb) ->> 'role', session_user);
  v_actor_type text;
  v_from text;
  v_to text;
begin
  if tg_table_name = 'bookings' then
    v_to := new.booking_status;
    v_from := case when tg_op = 'UPDATE' then old.booking_status end;
  else
    v_to := new.status;
    v_from := case when tg_op = 'UPDATE' then old.status end;
  end if;

  if tg_op = 'UPDATE' and v_from is not distinct from v_to then
    return null;
  end if;

  v_actor_type := case
    when v_actor is null then 'system'
    when exists (select 1 from public.admin_users where user_id = v_actor) then 'admin'
    else 'client'
  end;

  if tg_table_name = 'bookings' then
    insert into public.booking_status_events
      (entity, booking_id, from_status, to_status, actor_user_id, actor_type, actor_role)
    values ('booking', new.id, v_from, v_to, v_actor, v_actor_type, v_role);
  else
    insert into public.booking_status_events
      (entity, booking_id, payment_id, from_status, to_status, actor_user_id, actor_type, actor_role)
    values ('payment', new.booking_id, new.id, v_from, v_to, v_actor, v_actor_type, v_role);
  end if;

  return null;
end;
$$;

create trigger bookings_guard_status_change
before update of booking_status on public.bookings
for each row execute function public.guard_booking_status_change();

create trigger booking_payments_guard_status_change
before update of status on public.booking_payments
for each row execute function public.guard_booking_payment_status_change();

create trigger bookings_record_status_event
after insert or update of booking_status on public.bookings
for each row execute function public.record_booking_status_event();

create trigger booking_payments_record_status_event
after insert or update of status on public.booking_payments
for each row execute function public.record_booking_status_event();

-- Trigger functions are never called directly.
revoke all on function public.reject_booking_status_event_change() from public, anon, authenticated;
revoke all on function public.guard_booking_status_change() from public, anon, authenticated;
revoke all on function public.guard_booking_payment_status_change() from public, anon, authenticated;
revoke all on function public.record_booking_status_event() from public, anon, authenticated;
