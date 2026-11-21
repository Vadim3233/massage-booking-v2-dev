-- "Remove travel fee" on a booking already made (Vadim, 21 Nov 2026).
--
-- The client switch "No travel fee" (20261122100000_no_travel_fee.sql) only reaches bookings made after it is switched on. Fash booked first,
-- then Vadim switched it on, and the booking kept its £20. The rules Vadim agreed (thread "Apply no travel fee to existing bookings"):
--   * Only Vadim, on a booking still to happen (awaiting payment, awaiting cash approval, awaiting the transfer check, or confirmed; not once
--     the appointment has started) that has a travel fee. The congestion charge stays.
--   * The money follows the Edit booking rules (20261204100000_edit_booking_services.sql). Not paid yet: the amount to pay drops by the fee.
--     Paid, or a transfer the client says was sent: the fee first comes off anything still to pay, then the rest becomes a refund to send
--     (bookings.refund_due_gbp, "Refund to send" / Record refund sent, as now). The free-cancellation hours do not matter: it is his choice.
--   * A receipt already made is corrected (keeping what it said before) once nothing is still to pay.
--   * A gift voucher booking: the fee comes off what the client pays. When the voucher itself paid for the travel, or nothing would be left to
--     pay, it is refused (a voucher has no balance to put money back on).
--   * The client gets an email (and the Telegram copy) unless Vadim unticks it. The booking's History says "Travel fee removed".
--   * On the client page, while "No travel fee" is on, the client's upcoming bookings that still have a travel fee are listed with
--     "Remove from these bookings" (the screens call admin_remove_travel_fee once for each).
--
-- Safe to apply before the new screens are live: nothing live calls the new function, and the History filter only gains a new event name.
--
-- To take this back: drop the functions admin_remove_travel_fee and travel_fee_removed_notify, and run activity_money_types from
-- 20261220100000_activity_record.sql again.

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
  elsif p.status in ('paid', 'awaiting_verification') then
    v_money := 'There is nothing more to pay.';
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
    v_body || E'\n\nSee your booking: {link}' || E'\n\nWarm wishes,\nVadim', '/account?booking=' || b.id::text);
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
  r public.booking_receipts%rowtype;
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
  v_fresh jsonb;
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

  v_fee := b.travel_fee_gbp;
  v_total := b.total_gbp - v_fee;
  v_gift := coalesce(b.gift_covered_gbp, 0);
  v_held := p.status in ('paid', 'awaiting_verification');
  -- A gift voucher's part cannot shrink: there is nowhere to put that money back.
  if v_gift > v_total then
    raise exception 'The gift voucher already paid for the travel on this booking, so the travel fee stays.' using errcode = '22023';
  end if;
  v_balance := coalesce(b.balance_due_gbp, 0);
  if v_held then
    -- Paid or sent: the fee first comes off anything still to pay, the rest is a refund to send.
    v_from_balance := least(v_balance, v_fee);
    v_balance := v_balance - v_from_balance;
    v_refund := v_fee - v_from_balance;
    v_amount := greatest(p.amount_gbp - v_refund, 0);
  else
    v_amount := p.amount_gbp - v_fee;
    if v_amount <= 0 then
      raise exception 'Without the travel fee there would be nothing left to pay. Please change this booking by hand.' using errcode = '22023';
    end if;
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

  -- A receipt already made is corrected to match (once nothing is still to pay), keeping what it said before.
  if p.status = 'paid' and v_balance = 0 then
    select * into r from public.booking_receipts x where x.booking_id = b.id for update;
    if found then
      v_fresh := public.build_receipt_snapshot(b.id);
      insert into public.booking_receipt_revisions(receipt_id, revision, snapshot, edited_by) values (r.id, r.edit_count + 1, r.snapshot, auth.uid());
      update public.booking_receipts set snapshot = r.snapshot || jsonb_build_object('appointment', v_fresh->'appointment', 'treatments', v_fresh->'treatments',
          'lines', v_fresh->'lines', 'total', v_fresh->'total', 'payment', v_fresh->'payment'),
        edited_at = v_now, edited_by = auth.uid(), edit_count = r.edit_count + 1
      where id = r.id;
    end if;
  end if;

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
