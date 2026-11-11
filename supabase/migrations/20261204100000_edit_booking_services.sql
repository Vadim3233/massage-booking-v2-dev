-- Changing a booking: who is coming, treatments, lengths, and the date and time, in one go (Vadim, 11 Nov 2026).
--
-- Until now a booking could only be moved. When a couple booked 2 x 1 hour and one of them could not come, nothing could make it
-- 1 person x 1 hour. The rules Vadim agreed (document "Changing a booking: the rules", 11 Nov 2026):
--   * One step changes who is coming (1 to 4 people), each person's treatment and length (60, 90 or 120 minutes, 4 hours in all), and the
--     date and time. Vadim can do it on any booking still to happen, even once it has started. A client can do it on their own booking
--     before it starts, including one Vadim has not confirmed yet.
--   * Times (chain mode): a client is offered only the times the booking page would offer for the new length, worked out as if the old
--     booking were not there; the start they have is kept when it still fits. A client cannot go below the area's minimum booking (unless
--     Vadim switched on "No minimum booking" for them). Vadim also has "Show all times" (any time that does not overlap anything).
--   * Price: people and treatments that do not change keep the price they were booked at; anything new or changed is priced from today's
--     price list; extras, travel and congestion stay as booked. More than the free-cancellation hours before (24, Booking rules), the
--     price follows the change both ways. Inside them it can go up but never below the price it had: less time, no money back. Vadim can
--     set that aside with "Lower the price anyway".
--   * Money: not paid yet, the amount to pay becomes the new price. Paid (or a transfer the client says was sent) and the price drops: the
--     payment now stands at the new price and the difference is a refund to send (bookings.refund_due_gbp). Paid and the price rises: the
--     difference is still to pay (new bookings.balance_due_gbp) until Vadim marks it received. A refund already sent is never undone.
--     A receipt already made is corrected to match (keeping what it said before), once nothing is still to pay.
--   * Messages: the client gets an email (and Telegram) with the new details and what it means for their money (Vadim can untick it
--     when he makes the change). Vadim gets an alert whenever a client changes something.
--
-- Also here: "Record refund sent" works on a booking that is going ahead; cancelling a booking adds to a refund already owed and clears
-- anything still to pay; recording a refund on a cancelled booking never records more than the payment as sent back.
--
-- Safe to apply before the new screens are live: nothing that is live calls the new functions, and the changed ones behave as before for
-- every booking that has never been changed this way (refund_due_gbp and balance_due_gbp are then 0).
--
-- To take this back: drop the functions admin_edit_booking, admin_preview_booking_change, admin_record_balance_received,
-- my_booking_change_preview, my_booking_change_times, change_my_booking, change_preview_by_key, change_times_by_key, change_by_key,
-- booking_change_plan, booking_apply_change, booking_change_notify; run apply_booking_cancellation from
-- 20261012100000_client_self_service.sql, admin_record_refund from 20261108100000_money_groundwork.sql, mirror_client_email_to_telegram,
-- get_my_booking and list_my_bookings from 20261202100000_pay_one_session_at_a_time.sql again; then drop the column bookings.balance_due_gbp.

-- ---------------------------------------------------------------------------------------------
-- 1. What is still to pay after a price went up on a paid booking
-- ---------------------------------------------------------------------------------------------
alter table public.bookings add column balance_due_gbp numeric(10,2) not null default 0,
  add constraint bookings_balance_due_nonnegative check (balance_due_gbp >= 0);
comment on column public.bookings.balance_due_gbp is
  'Extra still to pay after the booking was changed to cost more than was already paid. 0 when nothing is owed.';

-- ---------------------------------------------------------------------------------------------
-- 2. Cancelling: a refund already owed is added to, and nothing is left "still to pay"
-- ---------------------------------------------------------------------------------------------
-- As 20261012100000_client_self_service.sql, with b.refund_due_gbp added to the refund and balance_due_gbp cleared.
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
begin
  v_standard := case when p_initiated_by = 'admin' then 0
    else public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, p_now) end;
  v_fee := coalesce(p_fee_override, v_standard);
  if v_fee < 0 or v_fee > b.total_gbp then
    raise exception 'The fee must be between zero and the appointment price' using errcode = '22023';
  end if;
  if v_paid then
    v_refund := greatest(p.amount_gbp - v_fee, 0) + coalesce(b.refund_due_gbp, 0);
  elsif p.status in ('awaiting_transfer', 'awaiting_verification', 'awaiting_approval', 'approved') then
    update public.booking_payments set status = 'rejected' where id = p.id;
  end if;
  update public.bookings set booking_status = 'cancelled', cancelled_at = p_now, cancelled_by_actor_type = p_actor_type,
    cancelled_by_actor_id = p_actor_id, cancellation_reason = p_reason, cancellation_initiated_by = p_initiated_by,
    payment_reservation_expires_at = null, late_fee_standard_gbp = v_standard, late_fee_due_gbp = v_fee,
    late_fee_status = case when v_fee = 0 then (case when v_standard > 0 then 'waived' else 'none' end)
                           when v_paid then 'received' else 'due' end,
    refund_due_gbp = v_refund, balance_due_gbp = 0
  where id = b.id;
  return query select v_standard, v_fee, v_refund;
end;
$$;
revoke all on function public.apply_booking_cancellation(public.bookings, public.booking_payments, text, text, numeric, text, text, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Record refund sent: also for a booking going ahead whose price went down after it was paid
-- ---------------------------------------------------------------------------------------------
-- As 20261108100000_money_groundwork.sql for a cancelled booking (the amount recorded as sent back is never more than the payment). On a
-- booking going ahead the payment already stands at the lower price, so it stays paid and only the refund to send is cleared.
CREATE OR REPLACE FUNCTION public.admin_record_refund(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamp with time zone, p_payment_updated_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or b.booking_status = 'no_show' or p.status not in ('paid', 'awaiting_verification') or b.refund_due_gbp <= 0
     or (b.booking_status = 'cancelled' and p.status <> 'paid') then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_command := public.admin_finish_command('admin_record_refund', p_request_id, v_fingerprint, b.id);
  if b.booking_status = 'cancelled' then
    -- How much went back and when are kept with the payment, for the Income screen.
    update public.booking_payments set status = 'refunded', refunded_gbp = least(b.refund_due_gbp, p.amount_gbp), refunded_at = clock_timestamp() where id = p.id;
  end if;
  update public.bookings set refund_due_gbp = 0 where id = b.id;
  perform public.admin_lifecycle_event('booking.refund_recorded', v_command, b.id, jsonb_build_object('refunded_gbp', b.refund_due_gbp));
  return b.id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. Working out a change (inside only): the people, the price and the money, without writing anything
-- ---------------------------------------------------------------------------------------------
-- p_sessions: the people in order, each {"id": the session it was (left out for a new person), "service_id", "duration_minutes",
-- "recipient_name"}. p_lower_price: Vadim's "Lower the price anyway" (the price then follows the change even inside the window).
-- Refuses with a sentence the person can read when the people asked for cannot be booked.
create function public.booking_change_plan(b public.bookings, p public.booking_payments, p_sessions jsonb, p_lower_price boolean, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.booking_sessions%rowtype;
  v_item jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_ids uuid[] := '{}'::uuid[];
  v_id uuid;
  v_service uuid;
  v_duration integer;
  v_recipient text;
  v_name text;
  v_price numeric(10,2);
  v_position integer := 0;
  v_minutes integer := 0;
  v_list_sessions numeric(10,2) := 0;
  v_extras numeric(10,2);
  v_list_total numeric(10,2);
  v_total numeric(10,2);
  v_inside boolean;
  v_changed boolean := false;
  v_amount numeric(10,2) := p.amount_gbp;
  v_refund numeric(10,2) := coalesce(b.refund_due_gbp, 0);
  v_balance numeric(10,2) := 0;
  v_back numeric(10,2);
  v_held boolean := p.status in ('paid', 'awaiting_verification');
begin
  if p_sessions is null or jsonb_typeof(p_sessions) <> 'array' or octet_length(p_sessions::text) > 16000 then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if jsonb_array_length(p_sessions) not between 1 and 4 then
    raise exception 'A booking is for one to four people.' using errcode = '22023';
  end if;
  if (select count(*) from public.booking_sessions x where x.booking_id = b.id) <> jsonb_array_length(p_sessions) then v_changed := true; end if;
  for v_item in select value from jsonb_array_elements(p_sessions) loop
    v_position := v_position + 1;
    if jsonb_typeof(v_item) <> 'object' or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id', 'service_id', 'duration_minutes', 'recipient_name')) then
      raise exception 'Missing command arguments' using errcode = '22023';
    end if;
    begin
      v_id := nullif(v_item->>'id', '')::uuid;
      v_service := nullif(v_item->>'service_id', '')::uuid;
      v_duration := nullif(v_item->>'duration_minutes', '')::integer;
    exception when invalid_text_representation then
      raise exception 'Missing command arguments' using errcode = '22023';
    end;
    v_recipient := nullif(btrim(coalesce(v_item->>'recipient_name', '')), '');
    if v_service is null then raise exception 'Choose a treatment for each person.' using errcode = '22023'; end if;
    if v_duration is null or v_duration not in (60, 90, 120) then
      raise exception 'Choose 60, 90 or 120 minutes for each person.' using errcode = '22023';
    end if;
    if length(v_recipient) > 120 then raise exception 'Keep each name under 120 characters.' using errcode = '22023'; end if;
    s := null;
    if v_id is not null then
      if v_id = any(v_ids) then raise exception 'Missing command arguments' using errcode = '22023'; end if;
      select * into s from public.booking_sessions x where x.id = v_id and x.booking_id = b.id;
      if not found then raise exception 'Booking state changed' using errcode = 'PT409'; end if;
      v_ids := v_ids || v_id;
    end if;
    if s.id is not null and s.service_id = v_service and s.duration_minutes = v_duration then
      -- Unchanged: the price it was booked at.
      v_name := s.service_name_snapshot; v_price := s.unit_price_gbp;
    else
      select sv.name, d.price_gbp into v_name, v_price
        from public.services sv join public.service_duration_prices d on d.service_id = sv.id
       where sv.id = v_service and d.duration_minutes = v_duration and sv.active and d.active;
      if not found then
        raise exception '%', format('That treatment is not offered for %s minutes. Choose another length or treatment.', v_duration) using errcode = '22023';
      end if;
    end if;
    if s.id is null or s.service_id <> v_service or s.duration_minutes <> v_duration or s.position <> v_position
       or s.recipient_name is distinct from v_recipient then
      v_changed := true;
    end if;
    v_minutes := v_minutes + v_duration;
    v_list_sessions := v_list_sessions + v_price;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', v_id, 'service_id', v_service, 'duration_minutes', v_duration,
      'recipient_name', v_recipient, 'name', v_name, 'price', v_price));
  end loop;
  if v_minutes > 240 then raise exception 'One visit can be up to 4 hours in all.' using errcode = '22023'; end if;

  -- Extras chosen for a person who is removed go with them; extras for the visit, travel and congestion stay as booked.
  v_extras := greatest(b.enhancements_total_gbp - coalesce((select sum(se.unit_price_gbp * se.quantity) from public.booking_session_enhancements se
    join public.booking_sessions x on x.id = se.booking_session_id where x.booking_id = b.id and not (x.id = any(v_ids))), 0), 0);
  v_list_total := v_list_sessions + v_extras + b.travel_fee_gbp + b.congestion_fee_gbp;
  -- Inside the free-cancellation window (the same rule, grace period included, as a late fee): never below the price it has now.
  v_inside := public.late_fee_standard_gbp(1, b.date, b.start_minutes, b.created_at, p_now) > 0;
  v_total := case when v_inside and not coalesce(p_lower_price, false) then greatest(v_list_total, b.total_gbp) else v_list_total end;

  -- The money. Not paid yet: the amount to pay is the new price. Paid, or sent by transfer: the payment stands at what is held towards
  -- this booking; a lower price makes the rest a refund to send, a higher one first takes back a refund not yet sent, then the rest is
  -- still to pay.
  if p.id is not null and v_held then
    if v_total < v_amount then
      v_refund := v_refund + (v_amount - v_total); v_amount := v_total;
    elsif v_total > v_amount then
      v_back := least(v_refund, v_total - v_amount);
      v_refund := v_refund - v_back; v_amount := v_amount + v_back;
      v_balance := v_total - v_amount;
    end if;
  elsif p.id is not null then
    v_amount := v_total;
  end if;

  return jsonb_build_object('rows', v_rows, 'kept_ids', to_jsonb(v_ids), 'minutes', v_minutes, 'changed', v_changed,
    'service_subtotal_gbp', v_total - v_extras - b.travel_fee_gbp - b.congestion_fee_gbp, 'list_sessions_gbp', v_list_sessions,
    'enhancements_total_gbp', v_extras, 'list_total_gbp', v_list_total, 'total_gbp', v_total, 'previous_total_gbp', b.total_gbp,
    'inside_window', v_inside, 'price_kept', v_total > v_list_total,
    'free_cancellation_hours', public.business_setting_int('free_cancellation_hours', 24),
    'payment_method', p.method, 'payment_status', p.status, 'held', p.id is not null and v_held,
    'amount_gbp', v_amount, 'previous_amount_gbp', p.amount_gbp,
    'refund_due_gbp', v_refund, 'previous_refund_due_gbp', coalesce(b.refund_due_gbp, 0),
    'balance_due_gbp', v_balance, 'previous_balance_due_gbp', coalesce(b.balance_due_gbp, 0));
end;
$$;
revoke all on function public.booking_change_plan(public.bookings, public.booking_payments, jsonb, boolean, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Writing a change (inside only)
-- ---------------------------------------------------------------------------------------------
create function public.booking_apply_change(b public.bookings, p public.booking_payments, p_plan jsonb, p_date date, p_start integer, p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.booking_receipts%rowtype;
  v_item jsonb;
  v_position integer := 0;
  v_ids uuid[];
  v_total numeric(10,2) := (p_plan->>'total_gbp')::numeric;
  v_balance numeric(10,2) := (p_plan->>'balance_due_gbp')::numeric;
  v_fresh jsonb;
  v_editor uuid := case when public.is_booking_admin() then auth.uid() end;
begin
  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_ids from jsonb_array_elements_text(p_plan->'kept_ids') x;
  delete from public.booking_sessions x where x.booking_id = b.id and not (x.id = any(v_ids));
  -- Out of the way first, so the new order never meets the old one (each position is used once per booking).
  update public.booking_sessions x set position = x.position + 100 where x.booking_id = b.id;
  for v_item in select value from jsonb_array_elements(p_plan->'rows') loop
    v_position := v_position + 1;
    if v_item->>'id' is not null then
      update public.booking_sessions set position = v_position, service_id = (v_item->>'service_id')::uuid,
        duration_minutes = (v_item->>'duration_minutes')::integer, service_name_snapshot = v_item->>'name',
        unit_price_gbp = (v_item->>'price')::numeric, recipient_name = v_item->>'recipient_name'
      where id = (v_item->>'id')::uuid;
    else
      insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp, recipient_name)
      values (b.id, v_position, (v_item->>'service_id')::uuid, (v_item->>'duration_minutes')::integer, v_item->>'name',
        (v_item->>'price')::numeric, v_item->>'recipient_name');
    end if;
  end loop;
  update public.bookings set date = p_date, start_minutes = p_start, treatment_duration_minutes = (p_plan->>'minutes')::integer,
    service_subtotal_gbp = (p_plan->>'service_subtotal_gbp')::numeric, enhancements_total_gbp = (p_plan->>'enhancements_total_gbp')::numeric,
    total_gbp = v_total, late_fee_due_gbp = least(late_fee_due_gbp, v_total), late_fee_standard_gbp = least(late_fee_standard_gbp, v_total),
    refund_due_gbp = (p_plan->>'refund_due_gbp')::numeric, balance_due_gbp = v_balance
  where id = b.id;
  if p.id is not null and p.amount_gbp is distinct from (p_plan->>'amount_gbp')::numeric then
    update public.booking_payments set amount_gbp = (p_plan->>'amount_gbp')::numeric where id = p.id;
  end if;
  -- A receipt already made says what was paid for, so it is corrected too (once nothing is still to pay), keeping what it said before.
  -- Who it is for, the note and the business details stay as they were.
  if p.status = 'paid' and v_balance = 0 then
    select * into r from public.booking_receipts x where x.booking_id = b.id for update;
    if found then
      v_fresh := public.build_receipt_snapshot(b.id);
      insert into public.booking_receipt_revisions(receipt_id, revision, snapshot, edited_by) values (r.id, r.edit_count + 1, r.snapshot, v_editor);
      update public.booking_receipts set snapshot = r.snapshot || jsonb_build_object('appointment', v_fresh->'appointment', 'treatments', v_fresh->'treatments',
          'lines', v_fresh->'lines', 'total', v_fresh->'total', 'payment', v_fresh->'payment'),
        edited_at = p_now, edited_by = v_editor, edit_count = r.edit_count + 1
      where id = r.id;
    end if;
  end if;
end;
$$;
revoke all on function public.booking_apply_change(public.bookings, public.booking_payments, jsonb, date, integer, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. The messages about a change (inside only)
-- ---------------------------------------------------------------------------------------------
-- After the change is written. p_before: the booking as it was; p_plan: the change. To the client (email; the Telegram copy follows from
-- it) unless p_to_client is false or the appointment has begun; to Vadim when the client made it.
create function public.booking_change_notify(p_event uuid, p_before public.bookings, p_before_people text, p_plan jsonb, p_to_client boolean, p_by_client boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_bank jsonb;
  v_name text;
  v_when text;
  v_people text;
  v_money text := '';
  v_admin_money text := '';
  v_total numeric(10,2) := (p_plan->>'total_gbp')::numeric;
  v_prev numeric(10,2) := (p_plan->>'previous_total_gbp')::numeric;
  v_refund_added numeric(10,2) := (p_plan->>'refund_due_gbp')::numeric - (p_plan->>'previous_refund_due_gbp')::numeric;
  v_balance numeric(10,2) := (p_plan->>'balance_due_gbp')::numeric;
  v_hours integer := (p_plan->>'free_cancellation_hours')::integer;
  v_moved boolean;
  v_body text;
  v_sign text := E'\n\nWarm wishes,\nVadim';
begin
  select * into b from public.bookings where id = p_before.id;
  select * into p from public.booking_payments where booking_id = b.id;
  v_moved := b.date <> p_before.date or b.start_minutes <> p_before.start_minutes;
  v_when := public.notification_when(b.date, b.start_minutes);
  v_people := coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes');

  -- What it means for the client's money, in their words.
  if (p_plan->>'price_kept')::boolean then
    v_money := format(E'\n\nBecause this change is within %s hours of your appointment, the price stays %s', v_hours, public.notification_money(v_total))
      || case when p.status in ('paid', 'awaiting_verification') then ' and there is no refund for it.' else '.' end;
  elsif v_total is distinct from v_prev then
    v_money := format(E'\n\nThe price is now %s (it was %s).', public.notification_money(v_total), public.notification_money(v_prev));
  end if;
  if v_refund_added > 0 then
    v_money := v_money || format(' You have already paid, so I will send %s back to you.', public.notification_money(v_refund_added));
  end if;
  if v_balance > 0 and v_balance is distinct from (p_plan->>'previous_balance_due_gbp')::numeric then
    if p.method = 'cash' then
      v_money := v_money || format(E'\n\nPlease have the extra %s ready in cash at your appointment.', public.notification_money(v_balance));
    else
      v_bank := (select s.value from public.business_settings s where s.key = 'bank_details');
      v_money := v_money || format(E'\n\nPlease pay the extra %s by bank transfer, using the reference %s.', public.notification_money(v_balance), coalesce(p.payment_reference, b.booking_reference))
        || case when v_bank ? 'sort_code' and v_bank ? 'account_number' then
             format(E'\n\nAccount name: %s\nSort code: %s\nAccount number: %s', v_bank->>'account_name', v_bank->>'sort_code', v_bank->>'account_number')
               || case when v_bank ? 'bank_name' then format(E'\nBank: %s', v_bank->>'bank_name') else '' end
           else E'\n\nIf you need the bank details, just ask me.' end;
    end if;
  elsif p.method = 'cash' and p.status in ('approved', 'awaiting_approval') then
    v_money := v_money || format(E'\n\nPlease have the full %s ready in cash at your appointment.', public.notification_money(v_total));
  end if;

  if coalesce(p_to_client, true) and nullif(btrim(b.booking_email_snapshot), '') is not null
     and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp() then
    v_body := format('%s It is now on %s at %s.' || E'\n%s.\nReference: %s',
        case when p_by_client then 'Your appointment has been changed as you asked.' else 'I have updated your appointment.' end,
        v_when, b.address_snapshot, v_people, b.booking_reference)
      || case when v_moved then format(E'\n\nIt was on %s.', public.notification_when(p_before.date, p_before.start_minutes)) else '' end
      || v_money
      || E'\n\nIf this is not right, please let me know.';
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (p_event, 'email', 'client', btrim(b.booking_email_snapshot), 'Your appointment has been updated',
      v_body || E'\n\nSee or change your booking: {link}' || v_sign, '/account?booking=' || b.id::text);
  end if;

  if p_by_client then
    select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
    v_name := coalesce(nullif(v_name, ''), 'A client');
    v_admin_money := case when (p_plan->>'price_kept')::boolean then format(' Within %s hours, so the price stays %s.', v_hours, public.notification_money(v_total))
        when v_total is distinct from v_prev then format(' Price %s (was %s).', public.notification_money(v_total), public.notification_money(v_prev)) else '' end
      || case when v_refund_added > 0 then format(' Refund to send: %s.', public.notification_money(v_refund_added)) else '' end
      || case when v_balance > 0 then format(' Still to pay: %s.', public.notification_money(v_balance)) else '' end;
    v_body := format('Now %s: %s. Was %s: %s.', v_when, v_people, public.notification_when(p_before.date, p_before.start_minutes), p_before_people) || v_admin_money;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (p_event, 'in_app', 'admin', 'admin', format('%s changed their booking', v_name), v_body, '/admin/bookings/' || b.id::text, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (p_event, 'telegram', 'admin', 'admin', format('%s changed their booking', v_name), v_body, '/admin/bookings/' || b.id::text),
           (p_event, 'email', 'admin', 'admin', format('%s changed their booking', v_name), v_body, '/admin/bookings/' || b.id::text);
  end if;
end;
$$;
revoke all on function public.booking_change_notify(uuid, public.bookings, text, jsonb, boolean, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Vadim: preview and save
-- ---------------------------------------------------------------------------------------------
create function public.admin_preview_booking_change(p_booking_id uuid, p_sessions jsonb, p_lower_price boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  select * into b from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  select * into p from public.booking_payments where booking_id = b.id;
  return public.booking_change_plan(b, p, p_sessions, p_lower_price, clock_timestamp()) - 'rows' - 'kept_ids';
end;
$$;
revoke all on function public.admin_preview_booking_change(uuid, jsonb, boolean) from public, anon;
grant execute on function public.admin_preview_booking_change(uuid, jsonb, boolean) to authenticated;

-- p_new_date and p_new_start_minutes: both left out to keep the date and time. p_any_time: a time from "Show all times" that is not one of
-- the usual ones (as admin_reschedule_booking). p_notify_client: send the client the new details. p_lower_price: "Lower the price anyway".
create function public.admin_edit_booking(
  p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_sessions jsonb,
  p_new_date date default null, p_new_start_minutes integer default null, p_any_time boolean default false,
  p_notify_client boolean default true, p_lower_price boolean default false
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_event uuid;
  v_date date;
  v_target_date date;
  v_target_start integer;
  v_moved boolean;
  v_plan jsonb;
  v_minutes integer;
  v_before text;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_edit_booking', p_booking_id::text, extract(epoch from p_booking_updated_at)::text,
    coalesce(p_sessions::text, ''), coalesce(p_new_date::text, ''), coalesce(p_new_start_minutes::text, ''),
    coalesce(p_any_time, false)::text, coalesce(p_notify_client, true)::text, coalesce(p_lower_price, false)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or (p_new_date is null) <> (p_new_start_minutes is null) then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if p_new_date is not null and (p_new_date < v_today or p_new_date > v_today + 365 or p_new_start_minutes not between 0 and 1439 or mod(p_new_start_minutes, 30) <> 0) then
    raise exception 'Choose a date within the next 365 days and a 30-minute start' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  -- Lock both days in a fixed order (as moving a booking does), then the booking, then its payment.
  v_target_date := coalesce(p_new_date, v_date);
  perform pg_advisory_xact_lock(42420, hashtext(least(v_date, v_target_date)::text));
  if v_target_date <> v_date then perform pg_advisory_xact_lock(42420, hashtext(greatest(v_date, v_target_date)::text)); end if;
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'Only an appointment still to happen can be changed.' using errcode = '22023';
  end if;
  v_target_start := coalesce(p_new_start_minutes, b.start_minutes);
  v_moved := v_target_date <> b.date or v_target_start <> b.start_minutes;
  v_plan := public.booking_change_plan(b, p, p_sessions, p_lower_price, v_now);
  v_minutes := (v_plan->>'minutes')::integer;
  if not (v_plan->>'changed')::boolean and not v_moved and v_plan->>'total_gbp' = v_plan->>'previous_total_gbp' then
    raise exception 'Nothing has changed.' using errcode = '22023';
  end if;

  -- The time: a new one is checked as moving a booking checks it; the same one, made longer, must not run into anything.
  if v_moved then
    if ((v_target_date + make_interval(mins => v_target_start)) at time zone 'Europe/London') <= v_now then
      raise exception 'That time is in the past. Choose another time.' using errcode = 'PT409';
    end if;
    if p_any_time is true then
      if v_target_start + v_minutes > 1440 then
        raise exception 'That appointment would run past midnight. Choose an earlier time.' using errcode = '22023';
      end if;
      if public.admin_time_clash(v_target_date, v_target_start, v_minutes, v_now, b.id) then
        raise exception 'That time overlaps another appointment, so it is not available. Choose another time.' using errcode = 'PT409';
      end if;
      if exists (select 1 from public.booking_holds h where h.date = v_target_date and h.status = 'active' and h.expires_at > v_now) then
        raise exception 'A client is in the middle of booking that day. Try again in a few minutes.' using errcode = 'PT409';
      end if;
    elsif not exists (
      select 1 from public.compute_booking_availability(v_target_date, v_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
      where a.start_minutes = v_target_start
    ) then
      raise exception 'This time is not available. Choose another time.' using errcode = 'PT409';
    end if;
  elsif v_minutes > b.treatment_duration_minutes then
    if b.start_minutes + v_minutes > 1440 then
      raise exception 'That appointment would run past midnight. Choose an earlier time.' using errcode = '22023';
    end if;
    if public.admin_time_clash(b.date, b.start_minutes, v_minutes, v_now, b.id) then
      raise exception 'Made longer, it would run into another appointment. Choose another time as well.' using errcode = 'PT409';
    end if;
  end if;

  v_command := public.admin_finish_command('admin_edit_booking', p_request_id, v_fingerprint, b.id);
  v_before := coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes');
  perform public.booking_apply_change(b, p, v_plan, v_target_date, v_target_start, v_now);
  perform public.admin_lifecycle_event('booking.services_changed', v_command, b.id, jsonb_build_object(
    'source', 'admin', 'from_date', b.date, 'from_start_minutes', b.start_minutes, 'to_date', v_target_date, 'to_start_minutes', v_target_start,
    'previous_sessions', v_before, 'previous_total_gbp', b.total_gbp, 'total_gbp', v_plan->'total_gbp', 'price_kept', v_plan->'price_kept',
    'balance_due_gbp', v_plan->'balance_due_gbp', 'notify_client', coalesce(p_notify_client, true)));
  select o.id into v_event from public.event_outbox o where o.deduplication_key = 'admin-lifecycle:' || v_command::text;
  perform public.booking_change_notify(v_event, b, v_before, v_plan, coalesce(p_notify_client, true), false);
  return b.id;
end;
$$;
revoke all on function public.admin_edit_booking(uuid, uuid, timestamptz, jsonb, date, integer, boolean, boolean, boolean) from public, anon;
grant execute on function public.admin_edit_booking(uuid, uuid, timestamptz, jsonb, date, integer, boolean, boolean, boolean) to authenticated;

-- "Mark extra received": the extra still to pay has come in. The payment now stands at the full price, and a receipt already made is
-- corrected to match. No message goes to the client.
create function public.admin_record_balance_received(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  r public.booking_receipts%rowtype;
  v_date date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_fresh jsonb;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_record_balance_received', p_booking_id::text, extract(epoch from p_booking_updated_at)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null then raise exception 'Missing command arguments' using errcode = '22023'; end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or p.id is null or b.updated_at is distinct from p_booking_updated_at or b.balance_due_gbp <= 0
     or p.status <> 'paid' or b.booking_status not in ('confirmed', 'completed') then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_command := public.admin_finish_command('admin_record_balance_received', p_request_id, v_fingerprint, b.id);
  update public.booking_payments set amount_gbp = amount_gbp + b.balance_due_gbp where id = p.id;
  update public.bookings set balance_due_gbp = 0 where id = b.id;
  select * into r from public.booking_receipts x where x.booking_id = b.id for update;
  if found then
    v_fresh := public.build_receipt_snapshot(b.id);
    insert into public.booking_receipt_revisions(receipt_id, revision, snapshot, edited_by) values (r.id, r.edit_count + 1, r.snapshot, auth.uid());
    update public.booking_receipts set snapshot = r.snapshot || jsonb_build_object('appointment', v_fresh->'appointment', 'treatments', v_fresh->'treatments',
        'lines', v_fresh->'lines', 'total', v_fresh->'total', 'payment', v_fresh->'payment'),
      edited_at = clock_timestamp(), edited_by = auth.uid(), edit_count = r.edit_count + 1
    where id = r.id;
  end if;
  perform public.admin_lifecycle_event('booking.balance_received', v_command, b.id, jsonb_build_object('received_gbp', b.balance_due_gbp));
  return b.id;
end;
$$;
revoke all on function public.admin_record_balance_received(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.admin_record_balance_received(uuid, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. A client: preview, times, and save (signed in, or from the private link in an email)
-- ---------------------------------------------------------------------------------------------
-- A client may change a booking still to come, before it starts. The area's minimum booking applies to them unless Vadim switched it off.
create function public.client_change_check(b public.bookings, p_minutes integer)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.service_areas%rowtype;
begin
  if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'This booking can no longer be changed online. Please contact Vad.' using errcode = 'PT409';
  end if;
  if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp() then
    raise exception 'This appointment has already started. Please contact Vad.' using errcode = '22023';
  end if;
  if p_minutes is not null then
    select * into a from public.service_areas where id = b.service_area_id;
    if a.minimum_booking_minutes is not null and p_minutes < a.minimum_booking_minutes
       and not exists (select 1 from public.clients c where c.id = b.client_id and c.no_minimum_booking) then
      raise exception '%', format('In %s the minimum booking is %s in total. Please contact Vadim to make it shorter.',
        a.name, public.minimum_booking_words(a.minimum_booking_minutes)) using errcode = '22023';
    end if;
  end if;
end;
$$;
revoke all on function public.client_change_check(public.bookings, integer) from public, anon, authenticated;

create function public.my_booking_change_preview(p_booking_id uuid, p_sessions jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype := public.client_booking_for_change(p_booking_id);
  p public.booking_payments%rowtype;
  v_plan jsonb;
begin
  select * into p from public.booking_payments where booking_id = b.id;
  v_plan := public.booking_change_plan(b, p, p_sessions, false, clock_timestamp());
  perform public.client_change_check(b, (v_plan->>'minutes')::integer);
  return v_plan - 'rows' - 'kept_ids';
end;
$$;
revoke all on function public.my_booking_change_preview(uuid, jsonb) from public, anon;
grant execute on function public.my_booking_change_preview(uuid, jsonb) to authenticated;

-- The times a client can choose for a new length: the usual ones, worked out as if their booking were not there, as for moving it.
create function public.my_booking_change_times(p_booking_id uuid, p_date date, p_minutes integer)
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
  if p_date is null or p_minutes is null or p_minutes not between 60 and 240 or mod(p_minutes, 30) <> 0 then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
     or p_date < v_today or p_date > v_today + public.business_setting_int('booking_horizon_days', 40) then
    return;
  end if;
  return query
  select a.start_minutes from public.compute_booking_availability(p_date, p_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
  where ((p_date + make_interval(mins => a.start_minutes)) at time zone 'Europe/London') >= v_now + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120))
  order by a.start_minutes;
end;
$$;
revoke all on function public.my_booking_change_times(uuid, date, integer) from public, anon;
grant execute on function public.my_booking_change_times(uuid, date, integer) to authenticated;

-- p_acknowledged_total: the price the client was shown. If it is no longer right, nothing changes and they are asked to look again.
create function public.change_my_booking(p_booking_id uuid, p_request_id uuid, p_sessions jsonb, p_new_date date, p_new_start_minutes integer, p_acknowledged_total numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_fingerprint text;
  v_cmd public.command_requests%rowtype;
  v_command_id uuid;
  v_event uuid;
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_plan jsonb;
  v_minutes integer;
  v_before text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_booking_id is null or p_request_id is null or p_new_date is null or p_new_start_minutes is null or p_acknowledged_total is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if p_new_start_minutes not between 0 and 1439 or mod(p_new_start_minutes, 30) <> 0 then
    raise exception 'Please choose a start time on the hour or half hour.' using errcode = '22023';
  end if;
  v_scope := 'client-self-service:' || auth.uid()::text;
  v_fingerprint := md5(concat_ws('|', 'change_my_booking', p_booking_id::text, coalesce(p_sessions::text, ''), p_new_date::text, p_new_start_minutes::text, p_acknowledged_total::text));
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
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.date is distinct from v_date then
    raise exception 'This booking can no longer be changed online. Please contact Vad.' using errcode = 'PT409';
  end if;
  v_plan := public.booking_change_plan(b, p, p_sessions, false, v_now);
  v_minutes := (v_plan->>'minutes')::integer;
  perform public.client_change_check(b, v_minutes);
  if not (v_plan->>'changed')::boolean and p_new_date = b.date and p_new_start_minutes = b.start_minutes then
    raise exception 'Nothing has changed.' using errcode = '22023';
  end if;
  -- Chain mode: only a time the booking page would offer for the new length (as if this booking were not there), with the usual notice.
  if p_new_date > (v_now at time zone 'Europe/London')::date + public.business_setting_int('booking_horizon_days', 40)
     or not exists (
       select 1 from public.compute_booking_availability(p_new_date, v_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
       where a.start_minutes = p_new_start_minutes)
     or ((p_new_date + make_interval(mins => p_new_start_minutes)) at time zone 'Europe/London') < v_now + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120)) then
    raise exception 'This time is not available. Please choose another time.' using errcode = 'PT409';
  end if;
  if (v_plan->>'total_gbp')::numeric is distinct from p_acknowledged_total then
    raise exception 'The price has changed. Please check it and confirm again.' using errcode = 'PT409';
  end if;
  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type, request_fingerprint, status, result_reference, completed_at)
  values (v_scope, p_request_id::text, 'web', 'client', auth.uid()::text, 'change_my_booking', v_fingerprint, 'succeeded', b.id::text, v_now)
  returning id into v_command_id;
  v_before := coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes');
  perform public.booking_apply_change(b, p, v_plan, p_new_date, p_new_start_minutes, v_now);
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, source_command_id, deduplication_key, payload)
  values ('booking.services_changed', 'booking', b.id, v_command_id, 'client-self-service:' || v_command_id::text,
    jsonb_build_object('booking_id', b.id, 'actor_id', auth.uid(), 'source', 'client', 'from_date', b.date, 'from_start_minutes', b.start_minutes,
      'to_date', p_new_date, 'to_start_minutes', p_new_start_minutes, 'previous_sessions', v_before, 'previous_total_gbp', b.total_gbp,
      'total_gbp', v_plan->'total_gbp', 'price_kept', v_plan->'price_kept', 'refund_due_gbp', v_plan->'refund_due_gbp', 'balance_due_gbp', v_plan->'balance_due_gbp'))
  returning id into v_event;
  perform public.booking_change_notify(v_event, b, v_before, v_plan, true, true);
  return public.get_my_booking(b.id);
end;
$$;
revoke all on function public.change_my_booking(uuid, uuid, jsonb, date, integer, numeric) from public, anon;
grant execute on function public.change_my_booking(uuid, uuid, jsonb, date, integer, numeric) to authenticated;

-- The same three from the private link in an email (as 20261026100000_booking_access_link.sql does for the others).
create function public.change_preview_by_key(p_booking_id uuid, p_key text, p_sessions jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_sub text := current_setting('request.jwt.claim.sub', true); v_result jsonb;
begin
  perform public.booking_link_client(p_booking_id, p_key);
  v_result := public.my_booking_change_preview(p_booking_id, p_sessions);
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end; $$;
create function public.change_times_by_key(p_booking_id uuid, p_key text, p_date date, p_minutes integer)
returns table(start_minutes integer) language plpgsql security definer set search_path = '' as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  perform public.booking_link_client(p_booking_id, p_key);
  return query select a.start_minutes from public.my_booking_change_times(p_booking_id, p_date, p_minutes) a;
  perform public.booking_link_end(v_claims, v_sub);
end; $$;
create function public.change_by_key(p_booking_id uuid, p_key text, p_request_id uuid, p_sessions jsonb, p_new_date date, p_new_start_minutes integer, p_acknowledged_total numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_sub text := current_setting('request.jwt.claim.sub', true); v_result jsonb;
begin
  perform public.booking_link_client(p_booking_id, p_key);
  v_result := public.change_my_booking(p_booking_id, p_request_id, p_sessions, p_new_date, p_new_start_minutes, p_acknowledged_total);
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end; $$;
revoke all on function public.change_preview_by_key(uuid, text, jsonb) from public;
revoke all on function public.change_times_by_key(uuid, text, date, integer) from public;
revoke all on function public.change_by_key(uuid, text, uuid, jsonb, date, integer, numeric) from public;
grant execute on function public.change_preview_by_key(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.change_times_by_key(uuid, text, date, integer) to anon, authenticated;
grant execute on function public.change_by_key(uuid, text, uuid, jsonb, date, integer, numeric) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 9. What the client's pages read: also the session ids and treatments (to change them) and what is still to pay
-- ---------------------------------------------------------------------------------------------
-- As 20261202100000_pay_one_session_at_a_time.sql, with id, service_id and the booked price for each session, the payment's amount, and balance_due_gbp.
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
  'city_snapshot',b.city_snapshot,'postcode_snapshot',b.postcode_snapshot,'address_snapshot',b.address_snapshot,'area_check',b.area_check,
  'late_fee_status',b.late_fee_status,'late_fee_due_gbp',b.late_fee_due_gbp,'refund_due_gbp',b.refund_due_gbp,'balance_due_gbp',b.balance_due_gbp,
  'cancelled_at',b.cancelled_at,
  'booking_sessions',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'service_id',s.service_id,'position',s.position,'duration_minutes',s.duration_minutes,
    'recipient_name',s.recipient_name,'service_name_snapshot',s.service_name_snapshot,'unit_price_gbp',s.unit_price_gbp) order by s.position),'[]'::jsonb)
    from public.booking_sessions s where s.booking_id=b.id),
  'booking_payments',jsonb_build_object('method',p.method,'status',p.status,'payment_reference',p.payment_reference,
    'transfer_declared_at',p.transfer_declared_at,'amount_gbp',p.amount_gbp),
  'pay_after_session',(select jsonb_build_object('id',e.id,'date',e.date,'start_minutes',e.start_minutes,'booking_status',e.booking_status,
      'auto_confirm',public.auto_confirm_later_sessions())
    from public.bookings e where e.id=b.pay_after_booking_id),
  'earlier_session',case when b.pay_after_booking_id is null and b.booking_status='awaiting_transfer' and p.status='awaiting_transfer'
      and p.method='bank_transfer' and b.area_check is null then
    (select jsonb_build_object('id',e.id,'date',e.date,'start_minutes',e.start_minutes,'booking_status',e.booking_status,
      'auto_confirm',public.auto_confirm_later_sessions())
      from public.bookings e where e.id=public.earlier_session_to_pay_first(b.id)) end
 ) into v_result from public.bookings b join public.clients c on c.id=b.client_id
 join public.booking_payments p on p.booking_id=b.id
 where b.id=p_booking_id and (c.auth_user_id=auth.uid()
   or (c.id::text=coalesce(auth.jwt()->>'link_client','') and b.id::text=coalesce(auth.jwt()->>'link_booking','')));
 if v_result is null then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 return v_result;
end; $function$;

-- As 20261202100000_pay_one_session_at_a_time.sql, with balance_due_gbp.
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
      'total_gbp', b.total_gbp, 'payment_method', p.method, 'payment_status', p.status,
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
-- 10. The Telegram copy of the new client email
-- ---------------------------------------------------------------------------------------------
-- As 20261202100000_pay_one_session_at_a_time.sql, with booking.services_changed among the copied events.
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
    'booking.rescheduled', 'booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected', 'booking.refund_recorded') then
    return null;
  end if;
  select b.client_id into v_client from public.bookings b where b.id = v_booking;
  if v_client is null then return null; end if;
  v_body := replace(replace(replace(new.body, E'\n\nSee or change your booking: {link}', ''), E'\n\nWarm wishes,\nVadim', ''), E'\n\nWarm wishes,\nVad', '')
    || case when v_event in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.confirmed_payment_due',
         'booking.confirmed_pay_after', 'booking.next_payment_due', 'booking.services_changed', 'booking.rescheduled')
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
