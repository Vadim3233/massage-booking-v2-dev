-- Gift vouchers: fixes from the end-to-end check (Vadim, 15 Nov 2026). Thread "Check gift vouchers end to end for bugs".
--
-- What it fixes, in plain words:
--   1. A gift booking with something left to pay (a longer massage, the travel fee, an extra): Vadim could not mark the rest paid. Verify transfer,
--      Paid (after Confirm now, pay later), approve or decline cash and Cash received all stopped with "Payment amount needs review", because they
--      expected the client to pay the whole price. They now expect the price less what the voucher paid.
--   2. The client's "Your bookings" list said the whole price was still to pay ("£125 to pay by bank transfer") when only the top-up was.
--      list_my_bookings now also gives what is left to pay and what the voucher paid.
--   3. The recipient's "Your appointment is booked" email said "at ." with no address (it read the old address fields). It now names the address,
--      and Vadim's alert keeps the "outside your areas / no postcode" warning when there is one.
--   4. Vadim's "says the transfer is made" and "cash request" alerts named the whole price instead of what is actually being paid, and the cash
--      confirmation said "pay the full amount in cash": both now name the amount left to pay.
--   5. Changing a gift booking's address to another area (Admin, Edit address): the voucher's part is worked out again for the new area's travel
--      and congestion (up to what the voucher covers), and the client is asked for the rest only.
--   6. A no-show on a gift booking suggested a fee of the whole price, so a fully paid voucher booking showed the client "Late fee of £90 due".
--      The suggested fee is now only what the client paid themselves (as for a late cancellation).
--   7. A voucher now ends at the end of its last day (London time), the day printed on it, not at the time of day it was paid.
--   8. A voucher given back after a cancelled booking never comes back already ended: it has at least 30 days left.
--   9. More › Gift vouchers gains: give a voucher more time (any later day), and change its details (names, message, the person's email and the
--      day it is emailed, until it has been sent). Refunding a paid, unused voucher (14-day terms) uses the existing cancel.
--
-- Safe to run again: every function is create or replace; the one data update only moves an end time to the end of its own day.
-- Undo: put back the functions from the migrations named beside each one, and drop admin_extend_gift_voucher and admin_update_gift_voucher.

-- ---------------------------------------------------------------------------------------------
-- 1. admin_verify_bank_transfer (from 20261010100000_pending_until_admin_decides.sql): what the client pays is the price less what a gift voucher paid.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_verify_bank_transfer(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamp with time zone, p_payment_updated_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_verify_bank_transfer', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or p.method <> 'bank_transfer'
     or not ((b.booking_status = 'awaiting_payment_verification' and p.status = 'awaiting_verification')
          or (b.booking_status = 'awaiting_transfer' and p.status = 'awaiting_transfer')) then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp - coalesce(b.gift_covered_gbp, 0) then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_verify_bank_transfer',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='confirmed', payment_reservation_expires_at=null where id=b.id;
  update public.booking_payments set status='paid', verified_at=v_now, verified_by=auth.uid(), paid_at=v_now where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.bank_transfer_verified','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $function$;

-- ---------------------------------------------------------------------------------------------
-- 1. admin_approve_cash_request (from 20261007120000_admin_payment_review.sql): what the client pays is the price less what a gift voucher paid.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_approve_cash_request(
  p_booking_id uuid, p_request_id uuid,
  p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_approve_cash_request', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or not (b.booking_status = 'awaiting_cash_approval' and p.method = 'cash' and p.status = 'awaiting_approval') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp - coalesce(b.gift_covered_gbp, 0) then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_approve_cash_request',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='confirmed', payment_reservation_expires_at=null where id=b.id;
  update public.booking_payments set status='approved' where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.cash_approved','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 1. admin_reject_cash_request (from 20261007120000_admin_payment_review.sql): what the client pays is the price less what a gift voucher paid.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_reject_cash_request(
  p_booking_id uuid, p_request_id uuid,
  p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_reject_cash_request', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or not (b.booking_status = 'awaiting_cash_approval' and p.method = 'cash' and p.status = 'awaiting_approval') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp - coalesce(b.gift_covered_gbp, 0) then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_reject_cash_request',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='cancelled', cancelled_at=v_now, cancelled_by_actor_type='admin', cancelled_by_actor_id=auth.uid()::text, payment_reservation_expires_at=null where id=b.id;
  update public.booking_payments set status='rejected' where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.cash_rejected','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 1. admin_record_payment_received (from 20261007120000_admin_payment_review.sql): what the client pays is the price less what a gift voucher paid.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_record_payment_received(
  p_booking_id uuid, p_request_id uuid,
  p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_record_payment_received', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or not (b.booking_status in ('confirmed','completed') and p.method = 'cash' and p.status = 'approved') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp - coalesce(b.gift_covered_gbp, 0) then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_record_payment_received',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.booking_payments set status='paid', paid_at=v_now where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.cash_received','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 1. admin_record_bank_transfer_received (from 20261116100000_confirm_pay_later.sql): what the client pays is the price less what a gift voucher paid.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_record_bank_transfer_received(p_booking_id uuid,p_request_id uuid,p_booking_updated_at timestamptz,p_payment_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; p public.booking_payments%rowtype; c public.command_requests%rowtype;
  v_date date; v_now timestamptz; v_scope text:='admin-payment:' || auth.uid()::text; v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint:=md5(concat_ws('|','admin_record_bank_transfer_received',p_booking_id::text,extract(epoch from p_booking_updated_at)::text,extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests cr where cr.scope=v_scope and cr.idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at
    or p.updated_at is distinct from p_payment_updated_at or b.booking_status not in ('confirmed','completed')
    or p.method<>'bank_transfer' or p.status not in ('awaiting_transfer','awaiting_verification') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp - coalesce(b.gift_covered_gbp, 0) then raise exception 'Payment amount needs review' using errcode='22023'; end if;
  v_now:=clock_timestamp();
  update public.booking_payments set status='paid',paid_at=v_now,verified_at=v_now,verified_by=auth.uid() where id=p.id;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_record_bank_transfer_received',v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.bank_transfer_received','booking',b.id,c.id,'admin-payment:' || c.id::text,
      jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,'previous_payment_status',p.status,'payment_status','paid','booking_status',b.booking_status,'amount_gbp',p.amount_gbp));
  return b.id;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 2. list_my_bookings (from 20261204100000_edit_booking_services.sql): also what is left to pay, and what a gift voucher paid.
-- ---------------------------------------------------------------------------------------------
create or replace function public.list_my_bookings()
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
      'total_gbp', b.total_gbp, 'amount_gbp', p.amount_gbp, 'gift_covered_gbp', b.gift_covered_gbp, 'payment_method', p.method, 'payment_status', p.status,
      'late_fee_status', b.late_fee_status, 'late_fee_due_gbp', b.late_fee_due_gbp, 'refund_due_gbp', b.refund_due_gbp,
      'balance_due_gbp', b.balance_due_gbp,
      'pay_after_date', e.date, 'pay_after_start_minutes', e.start_minutes,
      'services', (select string_agg(s.service_name_snapshot, ', ' order by s.position) from public.booking_sessions s where s.booking_id = b.id)) as row
    from public.bookings b
    join public.clients c on c.id = b.client_id
    join public.booking_payments p on p.booking_id = b.id
    left join public.bookings e on e.id = b.pay_after_booking_id
    where c.auth_user_id = auth.uid()
    order by b.date desc, b.start_minutes desc limit 50) q), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. gift_booking_messages (from 20261214100000_gift_vouchers.sql): the address in the emails, and the area warning kept.
-- ---------------------------------------------------------------------------------------------
create or replace function public.gift_booking_messages(p_event uuid, p_booking uuid, v public.gift_vouchers, p_to_pay numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; v_name text; v_when text; v_where text; v_title text; v_body text;
begin
  select * into b from public.bookings where id = p_booking;
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
  v_name := coalesce(nullif(v_name, ''), 'A client');
  v_when := public.notification_when(b.date, b.start_minutes);
  v_where := coalesce(nullif(btrim(b.address_snapshot), ''), nullif(concat_ws(', ', b.address_line_1_snapshot, b.city_snapshot, b.postcode_snapshot), ''), 'your address');
  if p_to_pay = 0 then
    v_title := 'New booking with a gift voucher';
    v_body := format('%s: %s, %s minutes. Paid by the gift voucher from %s (%s). Nothing to pay, it is confirmed.',
      v_name, v_when, b.treatment_duration_minutes, v.from_name, public.gift_code_shown(v.code));
  else
    v_title := 'New booking request with a gift voucher';
    v_body := format('%s: %s, %s minutes. The gift voucher from %s pays %s, %s left to pay. Waiting for payment.',
      v_name, v_when, b.treatment_duration_minutes, v.from_name, public.notification_money(b.gift_covered_gbp), public.notification_money(p_to_pay));
  end if;
  -- A postcode outside every area, or none at all: Vadim is still told to look at it (20261118100000).
  if b.area_check = 'outside' then
    v_title := v_title || ', outside your areas';
    v_body := v_body || format(' %s is outside your areas: check it with them.', coalesce(public.address_postcode(b.address_snapshot), 'The postcode'));
  elsif b.area_check = 'no_postcode' then
    v_body := v_body || ' The address has no postcode, so check it with them.';
  end if;
  v_body := v_body || E'\n' || v_where;
  update public.notification_deliveries d set title = v_title, body = v_body
   where d.event_id = p_event and d.audience = 'admin';
  if p_to_pay = 0 and nullif(btrim(b.booking_email_snapshot), '') is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (p_event, 'email', 'client', btrim(b.booking_email_snapshot), 'Your appointment is booked',
      format('Your appointment is confirmed for %s (%s minutes) at %s.', v_when, b.treatment_duration_minutes, v_where)
      || E'\n' || format('Your gift voucher from %s pays for it, so there is nothing to pay.', v.from_name)
      || E'\n' || format('Reference: %s', b.booking_reference)
      || E'\n\nSee or change your booking: {link}\n\nWarm wishes,\nVadim', '/account?booking=' || b.id::text)
    on conflict do nothing;
  end if;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 4. plan_event_notifications (from 20261118100000_area_postcodes.sql): the amount actually being paid in the transfer and cash alerts.
-- ---------------------------------------------------------------------------------------------
create or replace function public.plan_event_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_bank jsonb;
  v_name text;
  v_email text;
  v_when text;
  v_total text;
  v_initiated text := new.payload->>'initiated_by';
  v_source text := new.payload->>'source';
  v_admin_title text;
  v_admin_body text;
  v_client_title text;
  v_client_body text;
  v_fee numeric := coalesce((new.payload->>'late_fee_due_gbp')::numeric, 0);
  v_refund numeric := coalesce((new.payload->>'refund_due_gbp')::numeric, 0);
  v_admin_link text;
  v_client_link text;
  v_where text;
  v_sign text := E'\n\nWarm wishes,\nVad';
begin
  if new.aggregate_type <> 'booking' then return null; end if;
  select * into b from public.bookings where id = new.aggregate_id;
  if not found then return null; end if;
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
  v_name := coalesce(nullif(v_name, ''), 'A client');
  v_email := nullif(btrim(b.booking_email_snapshot), '');
  v_when := public.notification_when(b.date, b.start_minutes);
  v_total := public.notification_money(b.total_gbp);
  v_admin_link := '/admin/bookings/' || b.id::text;
  v_client_link := '/account?booking=' || b.id::text;
  v_where := b.address_snapshot;

  case new.event_type
    when 'booking.created' then
      if new.payload ? 'actor_id' then
        v_client_title := 'Your appointment is booked';
        v_client_body := format('Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference);
      else
        v_admin_title := 'New booking request';
        v_admin_body := format('%s: %s, %s minutes, %s. Waiting for payment.', v_name, v_when, b.treatment_duration_minutes, v_total);
        -- A postcode outside every area, or no postcode at all: the client was told not to pay until the Admin has looked.
        if b.area_check = 'outside' then
          v_admin_title := 'New booking request, outside your areas';
          v_admin_body := format('%s: %s, %s minutes, %s. %s is outside your areas. The client will not pay until you confirm it.', v_name, v_when, b.treatment_duration_minutes, v_total, coalesce(public.address_postcode(b.address_snapshot), 'The postcode'));
        elsif b.area_check = 'no_postcode' then
          v_admin_title := 'New booking request, no postcode';
          v_admin_body := format('%s: %s, %s minutes, %s. The address has no postcode, so check it before you confirm. The client will not pay until you do.', v_name, v_when, b.treatment_duration_minutes, v_total);
        end if;
      end if;
    when 'booking.transfer_declared' then
      v_admin_title := format('%s says the transfer is made', v_name);
      v_admin_body := format('%s for %s. Check your bank, then verify the payment.', public.notification_money(coalesce((select x.amount_gbp from public.booking_payments x where x.booking_id = b.id), b.total_gbp)), v_when);
    when 'booking.cash_requested' then
      v_admin_title := format('%s would like to pay cash', v_name);
      v_admin_body := format('%s for %s. Approve the request when you are happy to.', public.notification_money(coalesce((select x.amount_gbp from public.booking_payments x where x.booking_id = b.id), b.total_gbp)), v_when);
    when 'booking.cancelled' then
      if v_source = 'client' then
        v_admin_title := format('%s cancelled', v_name);
        v_admin_body := format('%s (%s).', v_when, v_total) ||
          case when v_fee > 0 then format(' Late fee of %s recorded as due.', public.notification_money(v_fee)) else ' No late fee.' end ||
          case when v_refund > 0 then format(' Refund of %s to send.', public.notification_money(v_refund)) else '' end;
      end if;
      if v_initiated = 'client' then
        v_client_title := 'Your appointment is cancelled';
        v_client_body := format('I have cancelled your appointment for %s as you asked.', v_when) ||
          case when v_fee > 0 then format(E'\n\nBecause this was inside %s hours, a late fee of %s applies. I will be in touch about it.', public.business_setting_int('free_cancellation_hours', 24), public.notification_money(v_fee)) else '' end ||
          case when v_refund > 0 then format(E'\n\nA refund of %s is on its way to you.', public.notification_money(v_refund)) else '' end;
      else
        v_client_title := 'Your appointment has been cancelled';
        v_client_body := format('I am sorry, I have had to cancel your appointment for %s. Please get in touch if you would like to find another time.', v_when) ||
          case when v_refund > 0 then format(E'\n\nA refund of %s is on its way to you.', public.notification_money(v_refund)) else '' end;
      end if;
    when 'booking.pending_removed', 'booking.cash_rejected' then
      v_client_title := 'Your appointment request has been cancelled';
      v_client_body := format('I have not been able to confirm your appointment request for %s. If you think this is a mistake, or you would like to find another time, please get in touch.', v_when);
    when 'booking.rescheduled' then
      if v_source = 'client' then
        v_admin_title := format('%s moved their appointment', v_name);
        v_admin_body := format('From %s to %s (%s).', public.notification_when((new.payload->>'from_date')::date, (new.payload->>'from_start_minutes')::integer), v_when, v_total) ||
          case when v_fee > 0 then format(' Late fee of %s recorded as due.', public.notification_money(v_fee)) else '' end;
      end if;
      v_client_title := 'Your appointment has moved';
      v_client_body := format('Your appointment is now on %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
        case when v_initiated = 'client' and v_fee > 0 then format(E'\n\nBecause this change was inside %s hours, a late fee of %s applies. I will be in touch about it.', public.business_setting_int('free_cancellation_hours', 24), public.notification_money(v_fee)) else '' end;
    when 'booking.bank_transfer_verified', 'booking.cash_approved' then
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Thank you. Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
        case when new.event_type = 'booking.cash_approved' and coalesce(b.gift_covered_gbp, 0) > 0
          then format(E'\n\nYour gift voucher pays %s. Please pay the remaining %s in cash at your appointment.', public.notification_money(b.gift_covered_gbp), public.notification_money(coalesce((select x.amount_gbp from public.booking_payments x where x.booking_id = b.id), b.total_gbp)))
        when new.event_type = 'booking.cash_approved' then E'\n\nPlease pay the full amount in cash at your appointment.' else E'\n\nI have received your payment.' end;
    when 'booking.confirmed_payment_due' then
      -- Confirmed by the Admin before the money arrived ("Confirm, pay later"): the same confirmation, then what is still to pay and how.
      select * into p from public.booking_payments where booking_id = b.id;
      v_bank := (select s.value from public.business_settings s where s.key = 'bank_details');
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
        format(E'\n\nPayment of %s is still due. Please pay by bank transfer when you can, using the reference %s.', public.notification_money(coalesce(p.amount_gbp, b.total_gbp)), coalesce(p.payment_reference, b.booking_reference)) ||
        case when v_bank ? 'sort_code' and v_bank ? 'account_number' then
          format(E'\n\nAccount name: %s\nSort code: %s\nAccount number: %s', v_bank->>'account_name', v_bank->>'sort_code', v_bank->>'account_number')
            || case when v_bank ? 'bank_name' then format(E'\nBank: %s', v_bank->>'bank_name') else '' end
        else E'\n\nIf you need the bank details, just ask me.' end;
    when 'booking.address_changed' then
      v_client_title := 'Your appointment address has changed';
      v_client_body := format('I have updated the address for your appointment on %s. It is now:' || E'\n%s', v_when, v_where) ||
        case when (new.payload->>'previous_total_gbp')::numeric is distinct from b.total_gbp
          then format(E'\n\nWith the travel for this area, the price is now %s (it was %s).', v_total, public.notification_money((new.payload->>'previous_total_gbp')::numeric)) else '' end ||
        E'\n\nIf this is not right, please let me know.';
    when 'booking.refund_recorded' then
      v_client_title := 'Your refund has been sent';
      v_client_body := format('I have sent your refund of %s for the appointment on %s.', public.notification_money((new.payload->>'refunded_gbp')::numeric), v_when);
    else
      null;
  end case;

  -- A booking the Admin recorded after it had happened was never announced to the client, so nothing that happens to it while it is still in
  -- the past (cancelling it again, a payment arriving later) is announced to them either. Moved to a time still to come, it is an appointment
  -- the client should hear about, and then it is.
  if v_client_title is not null
     and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp()
     and exists (select 1 from public.event_outbox o
                 where o.aggregate_type = 'booking' and o.aggregate_id = b.id and o.event_type = 'booking.created'
                   and coalesce((o.payload->>'past')::boolean, false)) then
    v_client_title := null;
  end if;
  if v_admin_title is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (new.id, 'in_app', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'telegram', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link),
           (new.id, 'email', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link);
  end if;
  if v_client_title is not null and v_email is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'email', 'client', v_email, v_client_title, v_client_body || E'\n\nSee or change your booking: {link}' || v_sign, v_client_link);
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. admin_change_booking_address (from 20261122100000_no_travel_fee.sql): a gift booking asks only for what the voucher does not pay.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_change_booking_address(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz,
  p_address text, p_entry_instructions text, p_service_area_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; p public.booking_payments%rowtype; c public.command_requests%rowtype; a public.service_areas%rowtype;
  v_date date; v_now timestamptz; v_scope text := 'admin-booking-address:' || auth.uid()::text; v_fingerprint text;
  v_address text := public.clean_address(p_address); v_entry text := nullif(btrim(coalesce(p_entry_instructions, '')), '');
  v_travel numeric(10,2); v_congestion numeric(10,2); v_total numeric(10,2);
  -- A gift voucher's part (20261214100000): its travel part follows the new area, up to what the voucher covers.
  g public.gift_vouchers%rowtype; v_cover numeric(10,2); v_to_pay numeric(10,2);
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_service_area_id is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  if v_address is null then raise exception 'Please write the address.' using errcode='22023'; end if;
  if length(v_address) > 400 then raise exception 'That address is too long.' using errcode='22023'; end if;
  if v_entry is not null and length(v_entry) > 200 then raise exception 'Please keep the entry instructions under 200 characters.' using errcode='22023'; end if;
  v_fingerprint := md5(concat_ws('|','admin_change_booking_address',p_booking_id::text,extract(epoch from p_booking_updated_at)::text,v_address,coalesce(v_entry,''),p_service_area_id::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests cr where cr.scope=v_scope and cr.idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as the other booking commands.
  perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if b.booking_status not in ('awaiting_transfer','awaiting_payment_verification','awaiting_cash_approval','confirmed') then
    raise exception 'Only an appointment still to happen can have its address changed.' using errcode='22023';
  end if;
  select * into a from public.service_areas where id=p_service_area_id;
  -- The area it already has may have been hidden since; a new one must be in use.
  if not found or (not a.active and p_service_area_id is distinct from b.service_area_id) then
    raise exception 'That area is not available.' using errcode='22023';
  end if;
  -- The same area keeps the fees it was booked with (prices apply to new bookings only); another area brings its own.
  if p_service_area_id is not distinct from b.service_area_id then
    v_travel := b.travel_fee_gbp; v_congestion := b.congestion_fee_gbp;
  else
    -- A client with "No travel fee" pays none in the new area either.
    v_travel := case when exists(select 1 from public.clients cl where cl.id=b.client_id and cl.no_travel_fee) then 0 else a.travel_surcharge_gbp end;
    v_congestion := a.congestion_fee_gbp;
  end if;
  v_total := b.service_subtotal_gbp + b.enhancements_total_gbp + v_travel + v_congestion;
  v_cover := coalesce(b.gift_covered_gbp, 0);
  if b.gift_voucher_id is not null then
    select * into g from public.gift_vouchers where id = b.gift_voucher_id;
    if found then
      v_cover := least(v_total, greatest(v_cover - least(b.travel_fee_gbp + b.congestion_fee_gbp, g.travel_cover_gbp), 0)
        + least(v_travel + v_congestion, g.travel_cover_gbp));
    end if;
  end if;
  v_to_pay := v_total - v_cover;
  if v_to_pay is distinct from b.total_gbp - coalesce(b.gift_covered_gbp, 0) and p.id is not null and p.status not in ('awaiting_transfer','awaiting_approval','approved') then
    raise exception '%', format('The client has already paid or sent %s, so the price cannot change. Keep the area as %s, or sort out the difference with them first.',
      public.notification_money(coalesce(p.amount_gbp, b.total_gbp)), coalesce(b.service_area_name_snapshot, 'it is')) using errcode='22023';
  end if;
  v_now := clock_timestamp();
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_change_booking_address',v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set address_snapshot=v_address, address_line_1_snapshot=null, address_line_2_snapshot=null, city_snapshot=null,
    postcode_snapshot=public.address_postcode(v_address), entry_instructions_snapshot=v_entry,
    service_area_id=a.id, service_area_name_snapshot=a.name, travel_fee_gbp=v_travel, congestion_fee_gbp=v_congestion, total_gbp=v_total, gift_covered_gbp=v_cover,
    area_check=null
  where id=b.id;
  if p.id is not null and v_to_pay is distinct from p.amount_gbp then
    update public.booking_payments set amount_gbp=v_to_pay where id=p.id;
  end if;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.address_changed','booking',b.id,c.id,'admin-booking-address:' || c.id::text,
      jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'previous_address',b.address_snapshot,'previous_area',b.service_area_name_snapshot,
        'previous_total_gbp',b.total_gbp,'total_gbp',v_total));
  return b.id;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 6. admin_mark_no_show (from 20261011100000_booking_lifecycle.sql)
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_mark_no_show(
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
  -- The fee is on what the client paid themselves, never on what a gift voucher paid (as for a late cancellation, 20261215100000).
  v_fee := coalesce(p_fee_gbp, b.total_gbp - coalesce(b.gift_covered_gbp, 0));
  if v_fee < 0 or v_fee > b.total_gbp then
    raise exception 'The fee must be between zero and the appointment price' using errcode = '22023';
  end if;
  v_command := public.admin_finish_command('admin_mark_no_show', p_request_id, v_fingerprint, b.id);
  update public.bookings set booking_status = 'no_show', late_fee_standard_gbp = b.total_gbp - coalesce(b.gift_covered_gbp, 0),
    late_fee_due_gbp = v_fee, late_fee_status = case when v_fee > 0 then 'due' else 'waived' end where id = b.id;
  perform public.admin_lifecycle_event('booking.no_show', v_command, b.id, '{}'::jsonb);
  return b.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. A voucher ends at the end of its last day, London time: the day printed on it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.gift_end_of_day(p_at timestamptz)
returns timestamptz language sql stable set search_path = '' as $$
  select (((p_at at time zone 'Europe/London')::date + 1)::timestamp at time zone 'Europe/London') - interval '1 second';
$$;
revoke all on function public.gift_end_of_day(timestamptz) from public, anon, authenticated;
update public.gift_vouchers set expires_at = public.gift_end_of_day(expires_at)
 where expires_at is not null and expires_at <> public.gift_end_of_day(expires_at);

-- admin_mark_gift_paid (from 20261214100000_gift_vouchers.sql)
create or replace function public.admin_mark_gift_paid(p_voucher_id uuid, p_method text default 'bank_transfer')
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_now timestamptz := clock_timestamp();
begin
  perform public.require_booking_admin();
  if coalesce(p_method, '') not in ('bank_transfer', 'cash') then raise exception 'Choose bank transfer or cash.' using errcode = '22023'; end if;
  update public.gift_vouchers g set status = 'ready', payment_method = p_method, paid_at = v_now,
         expires_at = public.gift_end_of_day(v_now + make_interval(months => public.gift_months()))
   where g.id = p_voucher_id and g.status = 'awaiting_payment'
  returning * into v;
  if not found then
    select * into v from public.gift_vouchers where id = p_voucher_id;
    if not found then raise exception 'That voucher was not found.' using errcode = '22023'; end if;
    if v.status <> 'ready' then raise exception 'That voucher is not waiting for payment.' using errcode = 'PT409'; end if;
    return v;
  end if;
  perform public.gift_ready_messages(v);
  -- An emailed voucher whose day has come goes now (the sender picks it up within the minute).
  perform public.plan_gift_messages(v_now);
  select * into v from public.gift_vouchers where id = p_voucher_id;
  return v;
end; $$;

-- admin_make_gift_voucher (from 20261214100000_gift_vouchers.sql)
create or replace function public.admin_make_gift_voucher(p_minutes integer, p_people integer, p_travel_choice text, p_service_area_id uuid, p_design text,
  p_recipient_name text, p_from_name text, p_message text, p_buyer_name text, p_buyer_email text, p_method text, p_price_gbp numeric default null)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v_price numeric(10,2); v_cover numeric(10,2) := 0; v_area public.service_areas%rowtype; v public.gift_vouchers%rowtype; v_now timestamptz := clock_timestamp();
  v_code text;
begin
  perform public.require_booking_admin();
  if p_people not in (1, 2) then raise exception 'A voucher is for one or two people.' using errcode = '22023'; end if;
  v_price := public.gift_massage_price(p_minutes);
  if v_price is null then raise exception '%', format('There is no %s-minute massage. Choose another length.', p_minutes) using errcode = '22023'; end if;
  if coalesce(p_travel_choice, 'none') = 'area' then
    select * into v_area from public.service_areas a where a.id = p_service_area_id;
    v_cover := coalesce(v_area.travel_surcharge_gbp, 0) + coalesce(v_area.congestion_fee_gbp, 0);
  elsif p_travel_choice = 'all' then
    v_cover := public.gift_all_areas_cover();
  end if;
  if nullif(btrim(coalesce(p_recipient_name, '')), '') is null then raise exception 'Who is the voucher for?' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('bank_transfer', 'cash') then raise exception 'Choose bank transfer or cash.' using errcode = '22023'; end if;
  if p_price_gbp is not null and p_price_gbp < 0 then raise exception 'Enter a price in pounds, for example 90.' using errcode = '22023'; end if;
  v_code := public.new_gift_code();
  insert into public.gift_vouchers(code, payment_reference, minutes, people, massage_price_gbp, travel_cover_gbp, travel_choice, service_area_id,
    service_area_name, price_gbp, recipient_name, from_name, message, design, delivery, buyer_name, buyer_email, status, payment_method,
    paid_at, expires_at, created_by)
  values (v_code, 'GIFT-' || left(public.new_gift_code(), 5), p_minutes, p_people, v_price, v_cover, coalesce(p_travel_choice, 'none'), v_area.id, v_area.name,
    coalesce(p_price_gbp, v_price * p_people + v_cover), btrim(p_recipient_name), coalesce(nullif(btrim(coalesce(p_from_name, '')), ''), btrim(coalesce(p_buyer_name, 'Vadim'))),
    nullif(btrim(coalesce(p_message, '')), ''), coalesce(p_design, 'christmas_night'), 'self',
    coalesce(nullif(btrim(coalesce(p_buyer_name, '')), ''), coalesce(nullif(btrim(coalesce(p_from_name, '')), ''), 'In person')),
    lower(nullif(btrim(coalesce(p_buyer_email, '')), '')), 'ready', p_method, v_now, public.gift_end_of_day(v_now + make_interval(months => public.gift_months())), 'admin')
  returning * into v;
  if v.buyer_email is not null then perform public.gift_ready_messages(v); end if;
  return v;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 8. gift_voucher_back (from 20261215100000_gift_voucher_extras.sql): a voucher given back has at least 30 days left.
-- ---------------------------------------------------------------------------------------------
create or replace function public.gift_voucher_back()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.gift_voucher_id is not null and new.booking_status = 'cancelled' and old.booking_status is distinct from 'cancelled' then
    if new.cancellation_initiated_by = 'client'
       and public.late_fee_standard_gbp(new.total_gbp, new.date, new.start_minutes, new.created_at, coalesce(new.cancelled_at, clock_timestamp())) > 0 then
      return null;
    end if;
    update public.gift_vouchers g set status = 'ready', booking_id = null, used_at = null,
      expires_at = greatest(g.expires_at, public.gift_end_of_day(clock_timestamp() + interval '30 days')) where g.id = new.gift_voucher_id and g.status = 'used' and g.booking_id = new.id;
  end if;
  return null;
end; $$;

-- "Not used after all" in More › Gift vouchers (from 20261214100000_gift_vouchers.sql), with the same 30 days.
create or replace function public.admin_mark_gift_used(p_voucher_id uuid, p_used boolean default true)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  if p_used then
    update public.gift_vouchers g set status = 'used', used_at = clock_timestamp() where g.id = p_voucher_id and g.status = 'ready' returning * into v;
  else
    update public.gift_vouchers g set status = 'ready', used_at = null, booking_id = null,
           expires_at = greatest(g.expires_at, public.gift_end_of_day(clock_timestamp() + interval '30 days'))
     where g.id = p_voucher_id and g.status = 'used' returning * into v;
  end if;
  if not found then raise exception 'That voucher can''t be changed now.' using errcode = 'PT409'; end if;
  return v;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 9. More › Gift vouchers: more time, and changing a voucher's details
-- ---------------------------------------------------------------------------------------------
-- Give a voucher more time: it can be used until the end of the day chosen (London time). Works on an ended one too.
create or replace function public.admin_extend_gift_voucher(p_voucher_id uuid, p_until date)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
begin
  perform public.require_booking_admin();
  if p_until is null or p_until < v_today then raise exception 'Choose a day from today on.' using errcode = '22023'; end if;
  if p_until > v_today + 1100 then raise exception 'Choose a day within three years.' using errcode = '22023'; end if;
  update public.gift_vouchers g set expires_at = public.gift_end_of_day(p_until::timestamp at time zone 'Europe/London'),
         reminder_sent_at = case when p_until > (g.expires_at at time zone 'Europe/London')::date then null else g.reminder_sent_at end
   where g.id = p_voucher_id and g.status = 'ready'
  returning * into v;
  if not found then raise exception 'Only a paid voucher that has not been used can be given more time.' using errcode = 'PT409'; end if;
  return v;
end; $$;

-- Change a voucher's words or where it is emailed: names, message, and (until it has been sent) the person's email and day.
create or replace function public.admin_update_gift_voucher(p_voucher_id uuid, p_recipient_name text, p_from_name text, p_message text,
  p_recipient_email text default null, p_send_at timestamptz default null)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_email text := lower(nullif(btrim(coalesce(p_recipient_email, '')), ''));
begin
  perform public.require_booking_admin();
  select * into v from public.gift_vouchers g where g.id = p_voucher_id for update;
  if not found or v.status = 'cancelled' then raise exception 'That voucher was not found.' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_recipient_name, '')), '') is null then raise exception 'Who is the voucher for?' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_from_name, '')), '') is null then raise exception 'Who is it from?' using errcode = '22023'; end if;
  if length(btrim(p_recipient_name)) > 60 or length(btrim(p_from_name)) > 60 then raise exception 'Please make the names shorter.' using errcode = '22023'; end if;
  if length(coalesce(p_message, '')) > 400 then raise exception 'Please make the message shorter (400 letters at most).' using errcode = '22023'; end if;
  if v.delivery = 'email' and v.recipient_sent_at is null then
    if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please add their email, so the voucher can reach them.' using errcode = '22023'; end if;
    if p_send_at is null then raise exception 'Choose the day it should arrive.' using errcode = '22023'; end if;
  end if;
  update public.gift_vouchers g set recipient_name = btrim(p_recipient_name), from_name = btrim(p_from_name),
         message = nullif(btrim(coalesce(p_message, '')), ''),
         recipient_email = case when g.delivery = 'email' and g.recipient_sent_at is null then v_email else g.recipient_email end,
         send_at = case when g.delivery = 'email' and g.recipient_sent_at is null then p_send_at else g.send_at end
   where g.id = p_voucher_id
  returning * into v;
  return v;
end; $$;

revoke all on function public.admin_extend_gift_voucher(uuid, date), public.admin_update_gift_voucher(uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.admin_extend_gift_voucher(uuid, date), public.admin_update_gift_voucher(uuid, text, text, text, text, timestamptz) to authenticated;
