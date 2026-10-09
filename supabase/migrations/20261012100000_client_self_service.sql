-- VAD Massage Booking V2
-- Client self-service: see, cancel and reschedule one's own bookings.
--
-- A client may cancel or reschedule a pending or confirmed appointment that has not started. More than
-- 24 hours ahead (or within an hour of booking) it is free; inside 24 hours it is still allowed and the
-- full price is recorded as a late fee due, which the client must acknowledge before it is applied and
-- which the Admin can reduce or waive. Rescheduling follows the client booking rules: two hours' notice,
-- 40 days ahead, and the same availability engine as booking. Cancel and reschedule share their money
-- rules with the Admin commands through internal functions.

-- ---------------------------------------------------------------------------------------------
-- Shared internals. The Admin and the client commands both apply cancellations and moves through
-- these, so the money rules exist in one place. Callers have already checked who is asking, taken
-- the day locks and verified the booking state.
-- ---------------------------------------------------------------------------------------------
create function public.change_fee_gbp(b public.bookings, p_initiated_by text, p_now timestamptz)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_initiated_by = 'admin' then 0::numeric
    when b.late_fee_status <> 'none' then 0::numeric
    else public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, p_now)
  end;
$$;

create function public.apply_booking_cancellation(
  b public.bookings, p public.booking_payments, p_reason text, p_initiated_by text, p_fee_override numeric,
  p_actor_type text, p_actor_id text, p_now timestamptz
) returns table(out_standard numeric, out_fee numeric, out_refund numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_standard numeric(10,2);
  v_fee numeric(10,2);
  v_refund numeric(10,2) := 0;
  v_paid boolean := p.status = 'paid';
begin
  v_standard := case when p_initiated_by = 'admin' then 0
    else public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, p_now) end;
  v_fee := coalesce(p_fee_override, v_standard);
  if v_fee < 0 or v_fee > b.total_gbp then
    raise exception 'The fee must be between zero and the appointment price' using errcode = '22023';
  end if;
  if v_paid then
    v_refund := greatest(p.amount_gbp - v_fee, 0);
  elsif p.status in ('awaiting_transfer', 'awaiting_verification', 'awaiting_approval', 'approved') then
    update public.booking_payments set status = 'rejected' where id = p.id;
  end if;
  update public.bookings set booking_status = 'cancelled', cancelled_at = p_now, cancelled_by_actor_type = p_actor_type,
    cancelled_by_actor_id = p_actor_id, cancellation_reason = p_reason, cancellation_initiated_by = p_initiated_by,
    payment_reservation_expires_at = null, late_fee_standard_gbp = v_standard, late_fee_due_gbp = v_fee,
    late_fee_status = case when v_fee = 0 then (case when v_standard > 0 then 'waived' else 'none' end)
                           when v_paid then 'received' else 'due' end,
    refund_due_gbp = v_refund
  where id = b.id;
  return query select v_standard, v_fee, v_refund;
end;
$$;

create function public.apply_booking_reschedule(b public.bookings, p_new_date date, p_new_start_minutes integer, p_fee numeric)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.bookings set date = p_new_date, start_minutes = p_new_start_minutes,
    late_fee_standard_gbp = case when p_fee > 0 then p_fee else late_fee_standard_gbp end,
    late_fee_due_gbp = case when p_fee > 0 then p_fee else late_fee_due_gbp end,
    late_fee_status = case when p_fee > 0 then 'due' else late_fee_status end
  where id = b.id;
$$;

revoke all on function public.change_fee_gbp(public.bookings, text, timestamptz) from public, anon, authenticated;
revoke all on function public.apply_booking_cancellation(public.bookings, public.booking_payments, text, text, numeric, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.apply_booking_reschedule(public.bookings, date, integer, numeric) from public, anon, authenticated;

-- The Admin commands now delegate to the shared internals (behaviour unchanged).
create or replace function public.admin_cancel_booking(
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
  v_result record;
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
  v_command := public.admin_finish_command('admin_cancel_booking', p_request_id, v_fingerprint, b.id);
  select * into v_result from public.apply_booking_cancellation(b, p, v_reason, p_initiated_by, p_fee_gbp, 'admin', auth.uid()::text, v_now);
  perform public.admin_lifecycle_event('booking.cancelled', v_command, b.id,
    jsonb_build_object('initiated_by', p_initiated_by, 'standard_fee_gbp', v_result.out_standard));
  return b.id;
end;
$$;

create or replace function public.admin_reschedule_booking(
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
  v_fee numeric(10,2);
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
  v_fee := public.change_fee_gbp(b, p_initiated_by, v_now);
  v_command := public.admin_finish_command('admin_reschedule_booking', p_request_id, v_fingerprint, b.id);
  perform public.apply_booking_reschedule(b, p_new_date, p_new_start_minutes, v_fee);
  perform public.admin_lifecycle_event('booking.rescheduled', v_command, b.id,
    jsonb_build_object('initiated_by', p_initiated_by, 'from_date', b.date, 'from_start_minutes', b.start_minutes,
      'to_date', p_new_date, 'to_start_minutes', p_new_start_minutes));
  return b.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- What a client sees about one of their bookings: terms, available times, a list, and the booking
-- itself with any fee or refund. All of it comes from the database rules.
-- ---------------------------------------------------------------------------------------------
create or replace function public.client_booking_for_change(p_booking_id uuid)
returns public.bookings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select bk.* into b from public.bookings bk join public.clients c on c.id = bk.client_id
    where bk.id = p_booking_id and c.auth_user_id = auth.uid();
  if not found then raise exception 'Booking is not available to this client' using errcode = '42501'; end if;
  return b;
end;
$$;
revoke all on function public.client_booking_for_change(uuid) from public, anon, authenticated;

create function public.get_my_change_terms(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype := public.client_booking_for_change(p_booking_id);
  v_now timestamptz := clock_timestamp();
  v_start timestamptz := (b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London';
  v_open boolean;
begin
  v_open := b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') and v_start > v_now;
  return jsonb_build_object(
    'can_change', v_open,
    'free_until', greatest(b.created_at + interval '1 hour', v_start - interval '24 hours'),
    'cancel_fee_gbp', case when v_open then public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now) else 0 end,
    'reschedule_fee_gbp', case when v_open then public.change_fee_gbp(b, 'client', v_now) else 0 end,
    'total_gbp', b.total_gbp);
end;
$$;

create function public.get_my_booking_availability(p_booking_id uuid, p_date date)
returns table(start_minutes integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype := public.client_booking_for_change(p_booking_id);
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
begin
  if p_date is null then raise exception 'Booking date is required' using errcode = '22023'; end if;
  if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
     or p_date < v_today or p_date > v_today + 40 then
    return;
  end if;
  return query
  select a.start_minutes from public.compute_booking_availability(p_date, b.treatment_duration_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
  where ((p_date + make_interval(mins => a.start_minutes)) at time zone 'Europe/London') >= v_now + interval '2 hours'
  order by a.start_minutes;
end;
$$;

create function public.list_my_bookings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row order by (row->>'date') desc, (row->>'start_minutes')::integer desc) from (
    select jsonb_build_object('id', b.id, 'booking_reference', b.booking_reference, 'booking_status', b.booking_status,
      'date', b.date, 'start_minutes', b.start_minutes, 'treatment_duration_minutes', b.treatment_duration_minutes,
      'total_gbp', b.total_gbp, 'payment_method', p.method, 'payment_status', p.status,
      'late_fee_status', b.late_fee_status, 'late_fee_due_gbp', b.late_fee_due_gbp, 'refund_due_gbp', b.refund_due_gbp,
      'services', (select string_agg(s.service_name_snapshot, ', ' order by s.position) from public.booking_sessions s where s.booking_id = b.id)) as row
    from public.bookings b
    join public.clients c on c.id = b.client_id
    join public.booking_payments p on p.booking_id = b.id
    where c.auth_user_id = auth.uid()
    order by b.date desc, b.start_minutes desc limit 50) q), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Client commands. A client acknowledges the exact late fee they have been shown; if the fee
-- changes before they confirm (the 24-hour mark passes), they must review it again.
-- ---------------------------------------------------------------------------------------------
create function public.client_cancel_booking(p_booking_id uuid, p_request_id uuid, p_acknowledged_fee numeric, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'Cancelled by the client');
  v_fingerprint text;
  v_cmd public.command_requests%rowtype;
  v_date date;
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_now timestamptz := clock_timestamp();
  v_fee numeric(10,2);
  v_result record;
  v_command_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_booking_id is null or p_request_id is null or p_acknowledged_fee is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if length(v_reason) > 500 then raise exception 'Please keep the reason under 500 characters' using errcode = '22023'; end if;
  v_scope := 'client-self-service:' || auth.uid()::text;
  v_fingerprint := md5(concat_ws('|', 'client_cancel_booking', p_booking_id::text, p_acknowledged_fee::text, v_reason));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_cmd from public.command_requests where scope = v_scope and idempotency_key = p_request_id::text for update;
  if found then
    if v_cmd.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode = '22023'; end if;
    if v_cmd.status = 'succeeded' then return public.get_my_booking(p_booking_id); end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;
  b := public.client_booking_for_change(p_booking_id);
  v_date := b.date;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.date is distinct from v_date or b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'This booking can no longer be changed online. Please contact Vad.' using errcode = 'PT409';
  end if;
  if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= v_now then
    raise exception 'This appointment has already started. Please contact Vad.' using errcode = '22023';
  end if;
  v_fee := public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now);
  if v_fee is distinct from p_acknowledged_fee then
    raise exception 'The late fee has changed. Please review it and confirm again.' using errcode = 'PT409';
  end if;
  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type, request_fingerprint, status, result_reference, completed_at)
  values (v_scope, p_request_id::text, 'web', 'client', auth.uid()::text, 'client_cancel_booking', v_fingerprint, 'succeeded', b.id::text, v_now)
  returning id into v_command_id;
  select * into v_result from public.apply_booking_cancellation(b, p, v_reason, 'client', null, 'client', auth.uid()::text, v_now);
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, source_command_id, deduplication_key, payload)
  values ('booking.cancelled', 'booking', b.id, v_command_id, 'client-self-service:' || v_command_id::text,
    jsonb_build_object('booking_id', b.id, 'actor_id', auth.uid(), 'initiated_by', 'client', 'booking_status', 'cancelled',
      'late_fee_due_gbp', v_result.out_fee, 'refund_due_gbp', v_result.out_refund, 'source', 'client'));
  return public.get_my_booking(b.id);
end;
$$;

create function public.client_reschedule_booking(
  p_booking_id uuid, p_request_id uuid, p_new_date date, p_new_start_minutes integer, p_acknowledged_fee numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_fingerprint text;
  v_cmd public.command_requests%rowtype;
  v_date date;
  b public.bookings%rowtype;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_fee numeric(10,2);
  v_command_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_booking_id is null or p_request_id is null or p_new_date is null or p_new_start_minutes is null or p_acknowledged_fee is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if p_new_start_minutes not between 0 and 1439 or mod(p_new_start_minutes, 30) <> 0 then
    raise exception 'Please choose a start time on the hour or half hour.' using errcode = '22023';
  end if;
  if p_new_date < v_today or p_new_date > v_today + 40 then
    raise exception 'Online appointments can currently be arranged up to 40 days ahead. Please choose another date.' using errcode = '22023';
  end if;
  v_scope := 'client-self-service:' || auth.uid()::text;
  v_fingerprint := md5(concat_ws('|', 'client_reschedule_booking', p_booking_id::text, p_new_date::text, p_new_start_minutes::text, p_acknowledged_fee::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_cmd from public.command_requests where scope = v_scope and idempotency_key = p_request_id::text for update;
  if found then
    if v_cmd.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode = '22023'; end if;
    if v_cmd.status = 'succeeded' then return public.get_my_booking(p_booking_id); end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;
  b := public.client_booking_for_change(p_booking_id);
  v_date := b.date;
  perform pg_advisory_xact_lock(42420, hashtext(least(v_date, p_new_date)::text));
  if p_new_date <> v_date then perform pg_advisory_xact_lock(42420, hashtext(greatest(v_date, p_new_date)::text)); end if;
  select * into b from public.bookings where id = p_booking_id for update;
  if b.date is distinct from v_date or b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'This booking can no longer be changed online. Please contact Vad.' using errcode = 'PT409';
  end if;
  if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= v_now then
    raise exception 'This appointment has already started. Please contact Vad.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.compute_booking_availability(p_new_date, b.treatment_duration_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
    where a.start_minutes = p_new_start_minutes
  ) or ((p_new_date + make_interval(mins => p_new_start_minutes)) at time zone 'Europe/London') < v_now + interval '2 hours' then
    raise exception 'This time is not available. Please choose another time.' using errcode = 'PT409';
  end if;
  v_fee := public.change_fee_gbp(b, 'client', v_now);
  if v_fee is distinct from p_acknowledged_fee then
    raise exception 'The late fee has changed. Please review it and confirm again.' using errcode = 'PT409';
  end if;
  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type, request_fingerprint, status, result_reference, completed_at)
  values (v_scope, p_request_id::text, 'web', 'client', auth.uid()::text, 'client_reschedule_booking', v_fingerprint, 'succeeded', b.id::text, v_now)
  returning id into v_command_id;
  perform public.apply_booking_reschedule(b, p_new_date, p_new_start_minutes, v_fee);
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, source_command_id, deduplication_key, payload)
  values ('booking.rescheduled', 'booking', b.id, v_command_id, 'client-self-service:' || v_command_id::text,
    jsonb_build_object('booking_id', b.id, 'actor_id', auth.uid(), 'initiated_by', 'client', 'from_date', b.date, 'from_start_minutes', b.start_minutes,
      'to_date', p_new_date, 'to_start_minutes', p_new_start_minutes, 'late_fee_due_gbp', v_fee, 'source', 'client'));
  return public.get_my_booking(b.id);
end;
$$;

revoke all on function public.get_my_change_terms(uuid) from public, anon;
revoke all on function public.get_my_booking_availability(uuid, date) from public, anon;
revoke all on function public.list_my_bookings() from public, anon;
revoke all on function public.client_cancel_booking(uuid, uuid, numeric, text) from public, anon;
revoke all on function public.client_reschedule_booking(uuid, uuid, date, integer, numeric) from public, anon;
grant execute on function public.get_my_change_terms(uuid) to authenticated;
grant execute on function public.get_my_booking_availability(uuid, date) to authenticated;
grant execute on function public.list_my_bookings() to authenticated;
grant execute on function public.client_cancel_booking(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.client_reschedule_booking(uuid, uuid, date, integer, numeric) to authenticated;

-- get_my_booking also reports late fees, refunds and the cancellation time.
CREATE OR REPLACE FUNCTION public.get_my_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_result jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select jsonb_build_object(
  'id',b.id,'booking_reference',b.booking_reference,'booking_status',b.booking_status,
  'booking_email_snapshot',b.booking_email_snapshot,'date',b.date,'start_minutes',b.start_minutes,
  'treatment_duration_minutes',b.treatment_duration_minutes,'total_gbp',b.total_gbp,
  'service_area_name_snapshot',b.service_area_name_snapshot,
  'address_line_1_snapshot',b.address_line_1_snapshot,'address_line_2_snapshot',b.address_line_2_snapshot,
  'city_snapshot',b.city_snapshot,'postcode_snapshot',b.postcode_snapshot,
  'late_fee_status',b.late_fee_status,'late_fee_due_gbp',b.late_fee_due_gbp,'refund_due_gbp',b.refund_due_gbp,
  'cancelled_at',b.cancelled_at,
  'booking_sessions',(select coalesce(jsonb_agg(jsonb_build_object('position',s.position,'duration_minutes',s.duration_minutes,
    'recipient_name',s.recipient_name,'service_name_snapshot',s.service_name_snapshot) order by s.position),'[]'::jsonb)
    from public.booking_sessions s where s.booking_id=b.id),
  'booking_payments',jsonb_build_object('method',p.method,'status',p.status,'payment_reference',p.payment_reference,
    'transfer_declared_at',p.transfer_declared_at)
 ) into v_result from public.bookings b join public.clients c on c.id=b.client_id
 join public.booking_payments p on p.booking_id=b.id
 where b.id=p_booking_id and c.auth_user_id=auth.uid();
 if v_result is null then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 return v_result;
end; $function$;
