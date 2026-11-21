-- "Remove travel fee" on a booking already made (Vadim, 21 Nov 2026).
--
-- The client switch "No travel fee" (20261122100000_no_travel_fee.sql) only reaches bookings made after it is switched on. Fash booked first,
-- then Vadim switched it on, and the booking kept its £20. The rules Vadim agreed (thread "Apply no travel fee to existing bookings"):
--   * Only Vadim, on a booking still to happen (awaiting payment, awaiting cash approval, awaiting the transfer check, or confirmed; not once
--     the appointment has started) that has a travel fee. The congestion charge stays.
--   * The money follows the Edit booking rules (20261204100000_edit_booking_services.sql). Not paid yet: the amount to pay drops by the fee.
--     Paid: the fee first comes off any extra still to pay, then the rest becomes a refund to send (bookings.refund_due_gbp, "Refund due" /
--     Record refund sent, as now). The free-cancellation hours do not matter: it is his choice.
--   * Money the client says they sent but Vadim has not checked yet (a transfer, or an extra still to pay) is checked first: a refund owed
--     on money that never arrives could not be cleared (fresh audit, 21 Nov 2026).
--   * A receipt already made is corrected (keeping what it said before) once nothing is still to pay; a receipt that cannot be rebuilt never
--     stops the price change.
--   * A gift voucher booking: the fee comes off what the client pays. When the voucher paid for any of the travel, or nothing would be left
--     to pay, it is refused (a voucher has no balance to put money back on).
--   * The client gets an email (and the Telegram copy) unless Vadim unticks it. The booking's History says "Travel fee removed".
--   * On the client page, while "No travel fee" is on, the client's upcoming bookings that still have a travel fee are listed with
--     "Remove from these bookings" (the screens call admin_remove_travel_fee once for each).
--
-- Safe to apply before the new screens are live: nothing live calls the new function, and the History filter only gains a new event name.
--
-- To take this back: drop the functions admin_remove_travel_fee and travel_fee_removed_notify, and run activity_money_types from
-- 20261220100000_activity_record.sql and mirror_client_email_to_telegram from 20261204100000_edit_booking_services.sql again.

-- ---------------------------------------------------------------------------------------------
-- 1. The client's message
-- ---------------------------------------------------------------------------------------------
create or replace function public.travel_fee_removed_notify(p_event uuid, p_booking_id uuid, p_fee numeric, p_previous_total numeric, p_refund numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_first text;
  v_money text;
  v_body text;
begin
  select * into b from public.bookings where id = p_booking_id;
  select * into p from public.booking_payments where booking_id = b.id;
  if nullif(btrim(b.booking_email_snapshot), '') is null then return; end if;
  select nullif(btrim(c.first_name), '') into v_first from public.clients c where c.id = b.client_id;
  if p_refund > 0 then
    v_money := format('You have already paid, so I will send %s back to you.', public.notification_money(p_refund));
  elsif b.balance_due_gbp > 0 then
    v_money := format('There is now %s still to pay.', public.notification_money(b.balance_due_gbp));
  elsif p.status = 'paid' then
    v_money := 'There is nothing more to pay.';
  elsif b.pay_after_booking_id is not null and p.status = 'awaiting_transfer' then
    v_money := format('The amount to pay for this session is now %s. As before, you pay it after your earlier session.', public.notification_money(p.amount_gbp));
  elsif p.method = 'cash' then
    v_money := format('The amount to pay in cash is now %s.', public.notification_money(p.amount_gbp));
  else
    v_money := format('The amount to pay by bank transfer is now %s, using the reference %s.', public.notification_money(p.amount_gbp),
      coalesce(p.payment_reference, b.booking_reference));
  end if;
  v_body := format('%s Good news: there is no travel fee for your appointment on %s. The price is now %s (it was %s).',
      coalesce('Hi ' || v_first || '!', 'Hello!'), public.notification_when(b.date, b.start_minutes),
      public.notification_money(b.total_gbp), public.notification_money(p_previous_total))
    || E'\n\n' || v_money;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
  values (p_event, 'email', 'client', btrim(b.booking_email_snapshot), 'No travel fee for your appointment',
    v_body || E'\n\nSee or change your booking: {link}' || E'\n\nWarm wishes,\nVadim', '/account?booking=' || b.id::text);
end;
$$;
revoke all on function public.travel_fee_removed_notify(uuid, uuid, numeric, numeric, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Remove the travel fee from one booking
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_remove_travel_fee(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz,
  p_notify_client boolean default true)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  g public.gift_vouchers%rowtype;
  v_now timestamptz := clock_timestamp();
  v_date date;
  v_fee numeric(10,2);
  v_total numeric(10,2);
  v_gift numeric(10,2);
  v_held boolean;
  v_from_balance numeric(10,2) := 0;
  v_refund numeric(10,2) := 0;
  v_amount numeric(10,2);
  v_balance numeric(10,2);
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_event uuid;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_remove_travel_fee', p_booking_id::text, extract(epoch from p_booking_updated_at)::text,
    coalesce(p_notify_client, true)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'The travel fee can only be removed from a booking still to happen.' using errcode = '22023';
  end if;
  if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= v_now then
    raise exception 'The appointment has already started, so its travel fee stays.' using errcode = '22023';
  end if;
  if coalesce(b.travel_fee_gbp, 0) <= 0 then
    raise exception 'This booking has no travel fee.' using errcode = '22023';
  end if;
  if p.id is null or p.status in ('rejected', 'refunded') then
    raise exception 'This booking has no payment to change.' using errcode = '22023';
  end if;
  if p.status = 'awaiting_verification' then
    raise exception 'The client says they sent the transfer. Check it first (Mark received), then remove the travel fee.' using errcode = '22023';
  end if;
  if b.balance_reported_at is not null and coalesce(b.balance_due_gbp, 0) > 0 then
    raise exception 'The client says they sent the extra still to pay. Mark it received first, then remove the travel fee.' using errcode = '22023';
  end if;

  v_fee := b.travel_fee_gbp;
  v_total := b.total_gbp - v_fee;
  v_gift := coalesce(b.gift_covered_gbp, 0);
  v_held := p.status = 'paid';
  -- A gift voucher's part cannot shrink: there is nowhere to put that money back. A voucher that paid for any of the travel keeps it.
  if b.gift_voucher_id is not null then
    select * into g from public.gift_vouchers where id = b.gift_voucher_id;
    if g.id is not null and least(b.travel_fee_gbp + b.congestion_fee_gbp, coalesce(g.travel_cover_gbp, 0)) > b.congestion_fee_gbp then
      raise exception 'The gift voucher already paid for the travel on this booking, so the travel fee stays.' using errcode = '22023';
    end if;
  end if;
  v_balance := coalesce(b.balance_due_gbp, 0);
  if v_held then
    -- Paid: the fee first comes off any extra still to pay, the rest is a refund to send.
    v_from_balance := least(v_balance, v_fee);
    v_balance := v_balance - v_from_balance;
    v_refund := v_fee - v_from_balance;
    v_amount := p.amount_gbp - v_refund;
  else
    v_amount := p.amount_gbp - v_fee;
  end if;
  if v_total - v_gift <= 0 or v_amount < 0 or (v_gift > 0 and v_amount + v_balance <= 0) then
    raise exception 'Without the travel fee there would be nothing left to pay. Please change this booking by hand.' using errcode = '22023';
  end if;

  v_command := public.admin_finish_command('admin_remove_travel_fee', p_request_id, v_fingerprint, b.id);
  update public.bookings set travel_fee_gbp = 0, total_gbp = v_total,
    refund_due_gbp = coalesce(refund_due_gbp, 0) + v_refund, balance_due_gbp = v_balance,
    balance_reported_at = case when v_balance = 0 then null else balance_reported_at end,
    late_fee_due_gbp = least(late_fee_due_gbp, v_total), late_fee_standard_gbp = least(late_fee_standard_gbp, v_total)
  where id = b.id;
  if p.amount_gbp is distinct from v_amount then
    update public.booking_payments set amount_gbp = v_amount where id = p.id;
  end if;

  -- A receipt already made is corrected to match (as for extra time: paid, nothing owed, amounts agree), keeping what it said before.
  -- A receipt that cannot be rebuilt never undoes the price change; it can still be corrected by hand.
  begin
    perform public.extension_refresh_receipt(b.id);
  exception when others then
    raise warning 'Receipt for booking % not corrected: %', b.id, sqlerrm;
  end;

  perform public.admin_lifecycle_event('booking.travel_fee_removed', v_command, b.id, jsonb_build_object('travel_fee_gbp', v_fee,
    'total_gbp', v_total, 'previous_total_gbp', b.total_gbp, 'amount_gbp', v_amount, 'refund_added_gbp', v_refund,
    'balance_due_gbp', v_balance, 'notify_client', coalesce(p_notify_client, true)));
  if coalesce(p_notify_client, true) then
    select o.id into v_event from public.event_outbox o where o.deduplication_key = 'admin-lifecycle:' || v_command::text;
    perform public.travel_fee_removed_notify(v_event, b.id, v_fee, b.total_gbp, v_refund);
  end if;
  return b.id;
end;
$$;
revoke all on function public.admin_remove_travel_fee(uuid, uuid, timestamptz, boolean) from public, anon;
grant execute on function public.admin_remove_travel_fee(uuid, uuid, timestamptz, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. History: "Travel fee removed" counts as a money line (the Money filter)
-- ---------------------------------------------------------------------------------------------
create or replace function public.activity_money_types()
returns text[] language sql immutable set search_path = '' as $$
  select array['booking.transfer_declared', 'booking.cash_requested', 'booking.bank_transfer_received', 'booking.bank_transfer_verified',
    'booking.cash_approved', 'booking.cash_rejected', 'booking.cash_received', 'booking.refund_recorded', 'booking.late_fee_settled',
    'booking.balance_received', 'booking.extra_reported', 'booking.payment_method_changed', 'booking.receipt_issued', 'booking.receipt_emailed',
    'booking.receipt_edited', 'booking.next_payment_due', 'booking.extended', 'booking.extension_removed', 'booking.pay_after_requested',
    'booking.travel_fee_removed'];
$$;
revoke all on function public.activity_money_types() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. The Telegram copy of the client's email: as 20261204100000_edit_booking_services.sql, with "Travel fee removed" added
-- ---------------------------------------------------------------------------------------------
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
    'booking.confirmed_pay_after', 'booking.next_payment_due', 'booking.services_changed',
    'booking.rescheduled', 'booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected', 'booking.refund_recorded',
    'booking.travel_fee_removed') then
    return null;
  end if;
  select b.client_id into v_client from public.bookings b where b.id = v_booking;
  if v_client is null then return null; end if;
  v_body := replace(replace(replace(new.body, E'\n\nSee or change your booking: {link}', ''), E'\n\nWarm wishes,\nVadim', ''), E'\n\nWarm wishes,\nVad', '')
    || case when v_event in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.confirmed_payment_due',
         'booking.confirmed_pay_after', 'booking.next_payment_due', 'booking.services_changed', 'booking.rescheduled', 'booking.travel_fee_removed')
         then E'\n\nTo change or cancel, use the link in your email, or contact Vadim.' else '' end;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
  select new.event_id, 'telegram_client', 'client', l.chat_id::text, new.title, v_body
  from public.client_telegram_links l
  where l.client_id = v_client and l.stopped_at is null
  on conflict (event_id, channel, recipient) do nothing;
  return null;
end;
$$;
revoke all on function public.mirror_client_email_to_telegram() from public, anon, authenticated;

notify pgrst, 'reload schema';
