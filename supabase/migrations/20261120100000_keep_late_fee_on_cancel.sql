-- VAD Massage Booking V2
-- A late fee already owed is kept when the client later cancels (ADR-084).
--
-- Before: a client moved a booking inside 24 hours (the full price recorded as a late fee due), then cancelled the new date more
-- than 24 hours ahead. The cancellation worked the fee out again from the new date only, found it free, and overwrote the fee owed
-- with nothing (and, on a paid booking, marked the whole payment as refund due). Now a client-asked cancellation charges the larger of
-- the fee it would cost on its own and the fee already owed. The Admin can still lower or waive it, and a cancellation the Admin
-- asks for is unchanged (no fee).

-- The fee a client-asked cancellation costs right now: the usual rule for this date, or the late fee already owed, whichever is more.
create function public.late_fee_on_cancel_gbp(b public.bookings, p_now timestamptz)
returns numeric
language sql
stable
set search_path = ''
as $$
  select least(b.total_gbp, greatest(
    public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, p_now),
    case when b.late_fee_status in ('due', 'received') then coalesce(b.late_fee_due_gbp, 0) else 0 end));
$$;
revoke all on function public.late_fee_on_cancel_gbp(public.bookings, timestamptz) from public, anon, authenticated;

create or replace function public.apply_booking_cancellation(
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
  -- A fee already taken (marked received) stays received when the same amount is kept.
  v_already_received boolean := b.late_fee_status = 'received';
begin
  v_standard := case when p_initiated_by = 'admin' then 0 else public.late_fee_on_cancel_gbp(b, p_now) end;
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
                           when v_paid or (v_already_received and v_fee <= coalesce(b.late_fee_due_gbp, 0)) then 'received'
                           else 'due' end,
    refund_due_gbp = v_refund
  where id = b.id;
  return query select v_standard, v_fee, v_refund;
end;
$$;

-- The client's own cancel: the fee they acknowledge is the same one the cancellation will record.
create or replace function public.client_cancel_booking(p_booking_id uuid, p_request_id uuid, p_acknowledged_fee numeric, p_reason text default null)
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
  v_fee := public.late_fee_on_cancel_gbp(b, v_now);
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

-- What the client is shown before cancelling: the same fee.
CREATE OR REPLACE FUNCTION public.get_my_change_terms(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype := public.client_booking_for_change(p_booking_id);
  v_now timestamptz := clock_timestamp();
  v_start timestamptz := (b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London';
  v_open boolean;
begin
  v_open := b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') and v_start > v_now;
  return jsonb_build_object(
    'can_change', v_open,
    'free_until', greatest(b.created_at + make_interval(mins => public.business_setting_int('grace_minutes', 60)), v_start - make_interval(hours => public.business_setting_int('free_cancellation_hours', 24))),
    'free_cancellation_hours', public.business_setting_int('free_cancellation_hours', 24),
    'cancel_fee_gbp', case when v_open then public.late_fee_on_cancel_gbp(b, v_now) else 0 end,
    'reschedule_fee_gbp', case when v_open then public.change_fee_gbp(b, 'client', v_now) else 0 end,
    'total_gbp', b.total_gbp);
end;
$function$;

-- What the Admin is shown when cancelling at the client's request: the same fee, which she can still lower or waive. (The existing
-- admin_late_fee_preview stays as it is for moving a booking, where a fee already owed means no second fee.)
create function public.admin_cancel_fee_preview(p_booking_id uuid, p_initiated_by text)
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
  return public.late_fee_on_cancel_gbp(b, clock_timestamp());
end;
$$;
revoke all on function public.admin_cancel_fee_preview(uuid, text) from public, anon;
grant execute on function public.admin_cancel_fee_preview(uuid, text) to authenticated;
