-- VAD Massage Booking V2
-- Booking lifecycle commands for the Admin: complete, no-show, cancel, reschedule, late fees and refunds.
--
-- Rules (owner's answers, ADR-020/021):
--   * Free to cancel or change more than 24 hours before the appointment; free for one hour after the
--     booking was made, whatever the appointment time.
--   * Inside 24 hours a client-requested cancellation or change is allowed, and the full appointment price
--     is recorded as a late fee due. The Admin may set any amount from zero to the full price.
--   * Money is collected outside the app. The database records what is owed and what has been settled.
--   * Every change goes through these commands (Admin only, retry-safe) and is recorded in the history
--     tables, so nothing is edited directly.

-- Availability can now ignore one booking, so a booking can be moved without blocking itself.
drop function public.compute_booking_availability(date, integer, timestamptz, integer, uuid);

CREATE OR REPLACE FUNCTION public.compute_booking_availability(p_date date, p_treatment_duration_minutes integer, p_now timestamp with time zone, p_travel_buffer_minutes integer, p_excluded_hold_id uuid, p_excluded_booking_id uuid)
 RETURNS TABLE(start_minutes integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_available boolean;
  v_working_start integer;
  v_working_end integer;
  v_start_mode text;
  v_fixed_start integer;
  v_chain_count integer;
  v_chain_start integer;
  v_chain_end integer;
  v_candidate integer;
begin
  if p_date is null then
    raise exception 'Booking date is required' using errcode = '22023';
  end if;

  if (
    p_treatment_duration_minutes is null
    or p_treatment_duration_minutes < 60
    or p_treatment_duration_minutes > 1440
    or mod(p_treatment_duration_minutes, 30) <> 0
  ) then
    raise exception 'Treatment duration must be at least 60 minutes and use 30-minute increments'
      using errcode = '22023';
  end if;

  if p_travel_buffer_minutes is null or p_travel_buffer_minutes < 0 then
    raise exception 'Travel buffer must be zero or greater'
      using errcode = '22023';
  end if;

  select
    o.available,
    o.start_minutes,
    o.end_minutes,
    o.start_mode,
    o.fixed_start_minutes
  into
    v_available,
    v_working_start,
    v_working_end,
    v_start_mode,
    v_fixed_start
  from public.working_hours_overrides o
  where o.date = p_date;

  if not found then
    select
      w.available,
      w.start_minutes,
      w.end_minutes,
      w.start_mode,
      w.fixed_start_minutes
    into
      v_available,
      v_working_start,
      v_working_end,
      v_start_mode,
      v_fixed_start
    from public.working_hours w
    where w.weekday = extract(isodow from p_date)::smallint;
  end if;

  if not found or not v_available then
    return;
  end if;

  select
    count(*)::integer,
    min(chain.start_minutes)::integer,
    max(chain.end_minutes)::integer
  into
    v_chain_count,
    v_chain_start,
    v_chain_end
  from (
    select
      b.start_minutes,
      b.start_minutes + b.treatment_duration_minutes as end_minutes
    from public.bookings b
    where b.date = p_date
      and b.id is distinct from p_excluded_booking_id
      and b.booking_status in (
        'awaiting_transfer',
        'awaiting_payment_verification',
        'awaiting_cash_approval',
        'confirmed',
        'completed'
      )

    union all

    select
      h.start_minutes,
      h.start_minutes + h.treatment_duration_minutes as end_minutes
    from public.booking_holds h
    where h.date = p_date
      and h.status = 'active'
      and h.expires_at > p_now
      and h.id is distinct from p_excluded_hold_id
  ) chain;

  if v_chain_count = 0 and v_start_mode = 'fixed' then
    v_candidate := v_fixed_start;

    if (
      v_candidate is not null
      and v_candidate >= v_working_start
      and v_candidate + p_treatment_duration_minutes <= v_working_end
      and not exists (
        select 1
        from public.calendar_blocks cb
        where cb.date = p_date
          and v_candidate < cb.end_minutes
          and v_candidate + p_treatment_duration_minutes > cb.start_minutes
      )
    ) then
      start_minutes := v_candidate;
      return next;
    end if;

    return;
  end if;

  if v_chain_count = 0 then
    return query
    select candidate
    from generate_series(
      v_working_start,
      v_working_end - p_treatment_duration_minutes,
      30
    ) as candidate
    where not exists (
      select 1
      from public.calendar_blocks cb
      where cb.date = p_date
        and candidate < cb.end_minutes
        and candidate + p_treatment_duration_minutes > cb.start_minutes
    )
    order by candidate;

    return;
  end if;

  v_candidate :=
    v_chain_start - p_travel_buffer_minutes - p_treatment_duration_minutes;

  if (
    v_candidate >= v_working_start
    and not exists (
      select 1
      from public.calendar_blocks cb
      where cb.date = p_date
        and v_candidate < cb.end_minutes
        and v_chain_start > cb.start_minutes
    )
  ) then
    start_minutes := v_candidate;
    return next;
  end if;

  v_candidate := v_chain_end + p_travel_buffer_minutes;

  if (
    v_candidate + p_treatment_duration_minutes <= v_working_end
    and not exists (
      select 1
      from public.calendar_blocks cb
      where cb.date = p_date
        and v_chain_end < cb.end_minutes
        and v_candidate + p_treatment_duration_minutes > cb.start_minutes
    )
  ) then
    start_minutes := v_candidate;
    return next;
  end if;
end;
$function$;

revoke all on function public.compute_booking_availability(date, integer, timestamptz, integer, uuid, uuid) from public, anon, authenticated;

-- The existing five-argument form keeps working for every current caller.
create function public.compute_booking_availability(
  p_date date, p_treatment_duration_minutes integer, p_now timestamptz, p_travel_buffer_minutes integer, p_excluded_hold_id uuid
) returns table(start_minutes integer)
language sql
security definer
set search_path = 'public', 'pg_temp'
as $$
  select a.start_minutes from public.compute_booking_availability(
    p_date, p_treatment_duration_minutes, p_now, p_travel_buffer_minutes, p_excluded_hold_id, null::uuid) a;
$$;
revoke all on function public.compute_booking_availability(date, integer, timestamptz, integer, uuid) from public, anon, authenticated;

drop function public.admin_booking_availability(date, integer);
CREATE OR REPLACE FUNCTION public.admin_booking_availability(p_date date, p_treatment_duration_minutes integer, p_exclude_booking_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(start_minutes integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_now timestamptz := clock_timestamp(); v_today date;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  v_today := (v_now at time zone 'Europe/London')::date;
  if p_date is null or p_date<v_today or p_date>v_today+365 then
    raise exception 'Choose a date within the next 365 days' using errcode='22023';
  end if;
  if p_treatment_duration_minutes is null or p_treatment_duration_minutes not between 60 and 240 or mod(p_treatment_duration_minutes,30)<>0 then
    raise exception 'Booking duration is invalid' using errcode='22023';
  end if;
  return query select a.start_minutes from public.compute_booking_availability(p_date,p_treatment_duration_minutes,v_now,60,null,p_exclude_booking_id) a
    where (p_date + make_interval(mins=>a.start_minutes)) at time zone 'Europe/London' > v_now
    order by a.start_minutes;
end; $function$;

revoke all on function public.admin_booking_availability(date, integer, uuid) from public, anon;
grant execute on function public.admin_booking_availability(date, integer, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Booking fields for cancellations, late fees and refunds.
-- Money is collected outside the app; these fields record what is owed and what has been settled.
-- ---------------------------------------------------------------------------------------------
alter table public.bookings
  add column cancellation_reason text,
  add column cancellation_initiated_by text,
  add column late_fee_standard_gbp numeric(10,2) not null default 0,
  add column late_fee_due_gbp numeric(10,2) not null default 0,
  add column late_fee_status text not null default 'none',
  add column refund_due_gbp numeric(10,2) not null default 0,
  add constraint bookings_cancellation_reason_valid
    check (cancellation_reason is null or length(btrim(cancellation_reason)) between 1 and 500),
  add constraint bookings_cancellation_initiated_by_valid
    check (cancellation_initiated_by is null or cancellation_initiated_by in ('client', 'admin')),
  add constraint bookings_late_fee_status_valid
    check (late_fee_status in ('none', 'due', 'waived', 'received')),
  add constraint bookings_late_fee_amounts_valid
    check (late_fee_standard_gbp >= 0 and late_fee_due_gbp >= 0 and late_fee_due_gbp <= total_gbp and refund_due_gbp >= 0),
  add constraint bookings_late_fee_status_matches_amount
    check ((late_fee_status in ('due', 'received')) = (late_fee_due_gbp > 0));

-- ---------------------------------------------------------------------------------------------
-- Append-only history of date/time changes (status changes are in booking_status_events).
-- ---------------------------------------------------------------------------------------------
create table public.booking_schedule_changes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null,
  from_date date not null,
  from_start_minutes integer not null,
  to_date date not null,
  to_start_minutes integer not null,
  actor_user_id uuid,
  actor_type text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint booking_schedule_changes_actor_type_valid check (actor_type in ('admin', 'client', 'system'))
);
create index booking_schedule_changes_booking_idx on public.booking_schedule_changes (booking_id, occurred_at);
alter table public.booking_schedule_changes enable row level security;
create policy "admins can read booking schedule changes" on public.booking_schedule_changes
  for select to authenticated using (public.is_booking_admin());
revoke all on table public.booking_schedule_changes from public;
revoke all on table public.booking_schedule_changes from anon;
revoke all on table public.booking_schedule_changes from authenticated;
grant select on table public.booking_schedule_changes to authenticated;

create trigger booking_schedule_changes_append_only
before update or delete on public.booking_schedule_changes
for each row execute function public.reject_booking_status_event_change();
create trigger booking_schedule_changes_no_truncate
before truncate on public.booking_schedule_changes
for each statement execute function public.reject_booking_status_event_change();

create function public.record_booking_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if new.date is not distinct from old.date and new.start_minutes is not distinct from old.start_minutes then
    return null;
  end if;
  insert into public.booking_schedule_changes
    (booking_id, from_date, from_start_minutes, to_date, to_start_minutes, actor_user_id, actor_type)
  values (new.id, old.date, old.start_minutes, new.date, new.start_minutes, v_actor,
    case when v_actor is null then 'system'
         when exists (select 1 from public.admin_users where user_id = v_actor) then 'admin' else 'client' end);
  return null;
end;
$$;
create trigger bookings_record_schedule_change
after update of date, start_minutes on public.bookings
for each row execute function public.record_booking_schedule_change();
revoke all on function public.record_booking_schedule_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The late fee rule. Free more than 24 hours before the appointment, and free for one hour after
-- the booking was made whatever the appointment time. Otherwise the full appointment price.
-- ---------------------------------------------------------------------------------------------
create function public.late_fee_standard_gbp(
  p_total_gbp numeric, p_date date, p_start_minutes integer, p_created_at timestamptz, p_at timestamptz
) returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_at < p_created_at + interval '1 hour' then 0::numeric
    when p_at >= ((p_date + make_interval(mins => p_start_minutes)) at time zone 'Europe/London') - interval '24 hours' then p_total_gbp
    else 0::numeric
  end;
$$;
revoke all on function public.late_fee_standard_gbp(numeric, date, integer, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Shared command plumbing: Admin check, retry safety (same request key returns the same result).
-- ---------------------------------------------------------------------------------------------
create function public.admin_begin_command(p_request_id uuid, p_fingerprint text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text := 'admin-lifecycle:' || coalesce(auth.uid()::text, '');
  c public.command_requests%rowtype;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests where scope = v_scope and idempotency_key = p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from p_fingerprint then
      raise exception 'Request key reused' using errcode = '22023';
    end if;
    if c.status = 'succeeded' then
      return c.result_reference::uuid;
    end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;
  return null;
end;
$$;

create function public.admin_finish_command(p_command_type text, p_request_id uuid, p_fingerprint text, p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id,
    command_type, request_fingerprint, status, result_reference, completed_at)
  values ('admin-lifecycle:' || auth.uid()::text, p_request_id::text, 'admin', 'admin', auth.uid()::text,
    p_command_type, p_fingerprint, 'succeeded', p_booking_id::text, clock_timestamp())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.admin_lifecycle_event(p_event_type text, p_command_id uuid, p_booking_id uuid, p_details jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, source_command_id, deduplication_key, payload)
  select p_event_type, 'booking', b.id, p_command_id, 'admin-lifecycle:' || p_command_id::text,
    jsonb_build_object('booking_id', b.id, 'actor_id', auth.uid(), 'booking_status', b.booking_status,
      'late_fee_status', b.late_fee_status, 'late_fee_due_gbp', b.late_fee_due_gbp, 'refund_due_gbp', b.refund_due_gbp) || p_details
  from public.bookings b where b.id = p_booking_id;
$$;

revoke all on function public.admin_begin_command(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_finish_command(text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_lifecycle_event(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- admin_complete_booking: a confirmed appointment that has started is marked completed.
-- ---------------------------------------------------------------------------------------------
create function public.admin_complete_booking(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_complete_booking', p_booking_id::text, extract(epoch from p_booking_updated_at)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  if b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at or b.booking_status <> 'confirmed' then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > v_now then
    raise exception 'The appointment has not started yet' using errcode = '22023';
  end if;
  v_command := public.admin_finish_command('admin_complete_booking', p_request_id, v_fingerprint, b.id);
  update public.bookings set booking_status = 'completed' where id = b.id;
  perform public.admin_lifecycle_event('booking.completed', v_command, b.id, '{}'::jsonb);
  return b.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_mark_no_show: a confirmed appointment that has started becomes a no-show. The full price
-- is recorded as the late fee unless the Admin chooses a lower amount (0 waives it).
-- ---------------------------------------------------------------------------------------------
create function public.admin_mark_no_show(
  p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_fee_gbp numeric default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_fee numeric(10,2);
begin
  v_fingerprint := md5(concat_ws('|', 'admin_mark_no_show', p_booking_id::text, extract(epoch from p_booking_updated_at)::text, coalesce(p_fee_gbp::text, 'standard')));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  if b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at or b.booking_status <> 'confirmed' then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > v_now then
    raise exception 'The appointment has not started yet' using errcode = '22023';
  end if;
  v_fee := coalesce(p_fee_gbp, b.total_gbp);
  if v_fee < 0 or v_fee > b.total_gbp then
    raise exception 'The fee must be between zero and the appointment price' using errcode = '22023';
  end if;
  v_command := public.admin_finish_command('admin_mark_no_show', p_request_id, v_fingerprint, b.id);
  update public.bookings set booking_status = 'no_show', late_fee_standard_gbp = b.total_gbp,
    late_fee_due_gbp = v_fee, late_fee_status = case when v_fee > 0 then 'due' else 'waived' end where id = b.id;
  perform public.admin_lifecycle_event('booking.no_show', v_command, b.id, '{}'::jsonb);
  return b.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_cancel_booking: cancel a pending or confirmed booking, with a reason and who asked for it.
-- The standard late fee applies to client-requested cancellations; the Admin may set any amount from
-- zero to the full price. Payment already received is kept as the fee and the rest becomes a refund due.
-- ---------------------------------------------------------------------------------------------
create function public.admin_cancel_booking(
  p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_payment_updated_at timestamptz,
  p_reason text, p_initiated_by text, p_fee_gbp numeric default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_standard numeric(10,2);
  v_fee numeric(10,2);
  v_refund numeric(10,2) := 0;
  v_paid boolean;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_cancel_booking', p_booking_id::text, extract(epoch from p_booking_updated_at)::text,
    extract(epoch from p_payment_updated_at)::text, coalesce(v_reason, ''), coalesce(p_initiated_by, ''), coalesce(p_fee_gbp::text, 'standard')));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'A cancellation reason of up to 500 characters is required' using errcode = '22023';
  end if;
  if p_initiated_by is null or p_initiated_by not in ('client', 'admin') then
    raise exception 'Say who asked for the cancellation' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at or p.updated_at is distinct from p_payment_updated_at
     or b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_standard := case when p_initiated_by = 'admin' then 0
    else public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now) end;
  v_fee := coalesce(p_fee_gbp, v_standard);
  if v_fee < 0 or v_fee > b.total_gbp then
    raise exception 'The fee must be between zero and the appointment price' using errcode = '22023';
  end if;
  v_paid := p.status = 'paid';
  v_command := public.admin_finish_command('admin_cancel_booking', p_request_id, v_fingerprint, b.id);
  if v_paid then
    v_refund := greatest(p.amount_gbp - v_fee, 0);
  elsif p.status in ('awaiting_transfer', 'awaiting_verification', 'awaiting_approval', 'approved') then
    update public.booking_payments set status = 'rejected' where id = p.id;
  end if;
  update public.bookings set booking_status = 'cancelled', cancelled_at = v_now, cancelled_by_actor_type = 'admin',
    cancelled_by_actor_id = auth.uid()::text, cancellation_reason = v_reason, cancellation_initiated_by = p_initiated_by,
    payment_reservation_expires_at = null, late_fee_standard_gbp = v_standard, late_fee_due_gbp = v_fee,
    late_fee_status = case when v_fee = 0 then (case when v_standard > 0 then 'waived' else 'none' end)
                           when v_paid then 'received' else 'due' end,
    refund_due_gbp = v_refund
  where id = b.id;
  perform public.admin_lifecycle_event('booking.cancelled', v_command, b.id,
    jsonb_build_object('initiated_by', p_initiated_by, 'standard_fee_gbp', v_standard));
  return b.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_reschedule_booking: move a pending or confirmed booking to another available time. The slot
-- is checked by the same availability engine as booking creation, ignoring this booking itself.
-- A client-requested change inside the late-fee window records the standard fee as due.
-- ---------------------------------------------------------------------------------------------
create function public.admin_reschedule_booking(
  p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz,
  p_new_date date, p_new_start_minutes integer, p_initiated_by text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_fee numeric(10,2) := 0;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_reschedule_booking', p_booking_id::text, extract(epoch from p_booking_updated_at)::text,
    coalesce(p_new_date::text, ''), coalesce(p_new_start_minutes::text, ''), coalesce(p_initiated_by, '')));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_new_date is null or p_new_start_minutes is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if p_initiated_by is null or p_initiated_by not in ('client', 'admin') then
    raise exception 'Say who asked for the change' using errcode = '22023';
  end if;
  if p_new_date < v_today or p_new_date > v_today + 365 or p_new_start_minutes not between 0 and 1439 or mod(p_new_start_minutes, 30) <> 0 then
    raise exception 'Choose a date within the next 365 days and a 30-minute start' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  -- Lock both days in a fixed order so two moves between the same days cannot deadlock.
  perform pg_advisory_xact_lock(42420, hashtext(least(v_date, p_new_date)::text));
  if p_new_date <> v_date then perform pg_advisory_xact_lock(42420, hashtext(greatest(v_date, p_new_date)::text)); end if;
  select * into b from public.bookings where id = p_booking_id for update;
  if b.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at
     or b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  if not exists (
    select 1 from public.compute_booking_availability(p_new_date, b.treatment_duration_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
    where a.start_minutes = p_new_start_minutes
  ) or ((p_new_date + make_interval(mins => p_new_start_minutes)) at time zone 'Europe/London') <= v_now then
    raise exception 'This time is not available. Choose another time.' using errcode = 'PT409';
  end if;
  if p_initiated_by = 'client' and b.late_fee_status = 'none' then
    v_fee := public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now);
  end if;
  v_command := public.admin_finish_command('admin_reschedule_booking', p_request_id, v_fingerprint, b.id);
  update public.bookings set date = p_new_date, start_minutes = p_new_start_minutes,
    late_fee_standard_gbp = case when v_fee > 0 then v_fee else late_fee_standard_gbp end,
    late_fee_due_gbp = case when v_fee > 0 then v_fee else late_fee_due_gbp end,
    late_fee_status = case when v_fee > 0 then 'due' else late_fee_status end
  where id = b.id;
  perform public.admin_lifecycle_event('booking.rescheduled', v_command, b.id,
    jsonb_build_object('initiated_by', p_initiated_by, 'from_date', b.date, 'from_start_minutes', b.start_minutes,
      'to_date', p_new_date, 'to_start_minutes', p_new_start_minutes));
  return b.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_settle_late_fee: mark a due fee as received, or waive it.
-- admin_record_refund: record that the refund owed on a cancelled, paid booking has been sent.
-- ---------------------------------------------------------------------------------------------
create function public.admin_settle_late_fee(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_action text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_date date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_settle_late_fee', p_booking_id::text, extract(epoch from p_booking_updated_at)::text, coalesce(p_action, '')));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_action is null or p_action not in ('received', 'waive') then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  if b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at or b.late_fee_status <> 'due' then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_command := public.admin_finish_command('admin_settle_late_fee', p_request_id, v_fingerprint, b.id);
  update public.bookings set
    late_fee_status = case p_action when 'received' then 'received' else 'waived' end,
    late_fee_due_gbp = case p_action when 'received' then late_fee_due_gbp else 0 end
  where id = b.id;
  perform public.admin_lifecycle_event('booking.late_fee_settled', v_command, b.id, jsonb_build_object('action', p_action));
  return b.id;
end;
$$;

create function public.admin_record_refund(
  p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_date date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_record_refund', p_booking_id::text, extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at or p.updated_at is distinct from p_payment_updated_at
     or b.booking_status <> 'cancelled' or p.status <> 'paid' or b.refund_due_gbp <= 0 then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_command := public.admin_finish_command('admin_record_refund', p_request_id, v_fingerprint, b.id);
  update public.booking_payments set status = 'refunded' where id = p.id;
  update public.bookings set refund_due_gbp = 0 where id = b.id;
  perform public.admin_lifecycle_event('booking.refund_recorded', v_command, b.id, jsonb_build_object('refunded_gbp', b.refund_due_gbp));
  return b.id;
end;
$$;

-- Browsers reach these only through authenticated sessions; each command checks for Admin itself.
revoke all on function public.admin_complete_booking(uuid, uuid, timestamptz) from public, anon;
revoke all on function public.admin_mark_no_show(uuid, uuid, timestamptz, numeric) from public, anon;
revoke all on function public.admin_cancel_booking(uuid, uuid, timestamptz, timestamptz, text, text, numeric) from public, anon;
revoke all on function public.admin_reschedule_booking(uuid, uuid, timestamptz, date, integer, text) from public, anon;
revoke all on function public.admin_settle_late_fee(uuid, uuid, timestamptz, text) from public, anon;
revoke all on function public.admin_record_refund(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_complete_booking(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.admin_mark_no_show(uuid, uuid, timestamptz, numeric) to authenticated;
grant execute on function public.admin_cancel_booking(uuid, uuid, timestamptz, timestamptz, text, text, numeric) to authenticated;
grant execute on function public.admin_reschedule_booking(uuid, uuid, timestamptz, date, integer, text) to authenticated;
grant execute on function public.admin_settle_late_fee(uuid, uuid, timestamptz, text) to authenticated;
grant execute on function public.admin_record_refund(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- admin_late_fee_preview: what the standard late fee would be if the booking were cancelled or moved
-- right now, so screens show the figure without repeating the rule. Admin only; changes nothing.
-- ---------------------------------------------------------------------------------------------
create function public.admin_late_fee_preview(p_booking_id uuid, p_initiated_by text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_initiated_by is null or p_initiated_by not in ('client', 'admin') then
    raise exception 'Say who asked for the change' using errcode = '22023';
  end if;
  select * into b from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  if p_initiated_by = 'admin' then return 0; end if;
  return public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, clock_timestamp());
end;
$$;
revoke all on function public.admin_late_fee_preview(uuid, text) from public, anon;
grant execute on function public.admin_late_fee_preview(uuid, text) to authenticated;
