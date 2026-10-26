-- Confirm a booking now, payment later (Vadim, 26 Oct 2026).
--
-- Some clients book by bank transfer and pay later. Until now a booking the client made stayed "Awaiting transfer" until the Admin either
-- recorded the money as arrived or cancelled it. From this migration the Admin can confirm the appointment while the payment stays open:
--   * admin_confirm_pay_later: booking awaiting_transfer or awaiting_payment_verification -> confirmed; the payment keeps its status
--     (awaiting_transfer or awaiting_verification). The client is told their appointment is confirmed and what is still to pay.
--   * admin_record_bank_transfer_received ("Mark paid") now also takes a confirmed booking whose client said the transfer was sent
--     (payment awaiting_verification), not only one still awaiting_transfer.
-- Booking and payment status changes stay within the existing guards (both moves were already allowed). Income already counts only paid money
-- and lists confirmed-but-unpaid appointments as still owed. Cash bookings are unchanged: approve now, mark cash received later.

-- ---------------------------------------------------------------------------------------------
-- 1. Confirm, pay later
-- ---------------------------------------------------------------------------------------------
create function public.admin_confirm_pay_later(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_payment_updated_at timestamptz)
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
  v_fingerprint:=md5(concat_ws('|','admin_confirm_pay_later',p_booking_id::text,extract(epoch from p_booking_updated_at)::text,extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests cr where cr.scope=v_scope and cr.idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as the other payment commands.
  perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at
    or p.updated_at is distinct from p_payment_updated_at or p.method<>'bank_transfer'
    or not ((b.booking_status='awaiting_transfer' and p.status='awaiting_transfer')
         or (b.booking_status='awaiting_payment_verification' and p.status='awaiting_verification')) then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  v_now:=clock_timestamp();
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_confirm_pay_later',v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='confirmed', payment_reservation_expires_at=null where id=b.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.confirmed_payment_due','booking',b.id,c.id,'admin-payment:' || c.id::text,
      jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,'previous_booking_status',b.booking_status,
        'booking_status','confirmed','payment_status',p.status,'amount_gbp',p.amount_gbp));
  return b.id;
end; $$;
revoke all on function public.admin_confirm_pay_later(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.admin_confirm_pay_later(uuid,uuid,timestamptz,timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Mark paid: also for a confirmed booking whose client said the transfer was sent
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
  if p.amount_gbp is distinct from b.total_gbp then raise exception 'Payment amount needs review' using errcode='22023'; end if;
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
-- 3. The client's email: confirmed, with what is still to pay and the bank details Vadim saved
-- ---------------------------------------------------------------------------------------------
-- As 20261110100000_people_sentence_emails.sql, with one new case, booking.confirmed_payment_due.
CREATE OR REPLACE FUNCTION public.plan_event_notifications()
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
      end if;
    when 'booking.transfer_declared' then
      v_admin_title := format('%s says the transfer is made', v_name);
      v_admin_body := format('%s for %s. Check your bank, then verify the payment.', v_total, v_when);
    when 'booking.cash_requested' then
      v_admin_title := format('%s would like to pay cash', v_name);
      v_admin_body := format('%s for %s. Approve the request when you are happy to.', v_total, v_when);
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
        case when new.event_type = 'booking.cash_approved' then E'\n\nPlease pay the full amount in cash at your appointment.' else E'\n\nI have received your payment.' end;
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
-- 4. The same message on Telegram, for a client who linked it
-- ---------------------------------------------------------------------------------------------
-- As 20261028100000_client_telegram.sql, with booking.confirmed_payment_due among the copied events.
create or replace function public.mirror_client_email_to_telegram()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text;
  v_booking uuid;
  v_client uuid;
  v_body text;
begin
  select e.event_type, e.aggregate_id into v_event, v_booking
  from public.event_outbox e where e.id = new.event_id and e.aggregate_type = 'booking';
  if v_event is null or v_event not in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.confirmed_payment_due',
    'booking.rescheduled', 'booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected', 'booking.refund_recorded') then
    return null;
  end if;
  select b.client_id into v_client from public.bookings b where b.id = v_booking;
  if v_client is null then return null; end if;
  v_body := replace(replace(new.body, E'\n\nSee or change your booking: {link}', ''), E'\n\nWarm wishes,\nVad', '')
    || case when v_event in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.confirmed_payment_due', 'booking.rescheduled')
         then E'\n\nTo change or cancel, use the link in your email, or contact Vad.' else '' end;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
  select new.event_id, 'telegram_client', 'client', l.chat_id::text, new.title, v_body
  from public.client_telegram_links l
  where l.client_id = v_client and l.stopped_at is null
  on conflict (event_id, channel, recipient) do nothing;
  return null;
end;
$$;
