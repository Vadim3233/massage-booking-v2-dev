-- The Admin does not have to give a reason when cancelling a booking. A reason that is given is still
-- trimmed and limited to 500 characters; without one the booking simply records none.
-- Same behaviour as before otherwise; create or replace keeps the existing grants.
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
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'A cancellation reason can be up to 500 characters' using errcode = '22023';
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
