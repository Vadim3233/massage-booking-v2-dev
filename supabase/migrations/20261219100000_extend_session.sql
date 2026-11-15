-- Extra time: a client asks to stay longer (Vadim, 15 Nov 2026). Rules page: https://claude.ai/artifact/HGN5X9hhYLp47QgBTYpuCQ
--
--   * Only Vadim adds extra time, from the session's start until 7 days after it, on a booking that went ahead (confirmed or completed).
--     +15 to +120 minutes in 15-minute steps, at most 2 extra hours on one booking, added to the end, never past midnight. It is for one person
--     of the booking (who stayed longer); the visit simply ends later.
--   * Price: his extra-time rate per hour (More › Services and prices › Extra time, a setting he can change any time), pro rata and rounded to
--     the nearest £1. With no rate saved it is that person's treatment's own 1-hour price. The screen suggests it; he can type another, or £0.
--     The booking's own price (a special offer, a gift voucher's part, travel, congestion) never changes: the extra is a line of its own.
--   * Money, by how the booking stands:
--       not paid yet (bank transfer or cash still to come): "bill", the extra is added to what is to pay, so one payment covers both;
--       paid: "cash" (received there and then, nothing owed), or "transfer" (still to pay: bookings.balance_due_gbp, the same "£X still to
--       pay" / "Mark extra received" as after Edit booking; the client is emailed the bill with the bank details), or "free";
--       a transfer the client says they sent but not yet checked: "transfer" or "free" (the first payment is checked as usual).
--   * The client can say "I've sent it" for the extra from their booking page (bookings.balance_reported_at); To check then lists it. To check
--     also lists any extra still to pay once the session is over (this also covers money owed after Edit booking).
--   * "Remove extra time" undoes one, as long as its money has not been received by transfer (a bill already paid stays).
--   * Edit booking (who, treatments, lengths) asks for the extra time to be removed first, so nothing is counted twice. Moving or cancelling
--     works as before.
--   * The receipt gets a line "Extra time, 30 minutes"; a receipt already made is corrected (keeping what it said before) once nothing is owed.
--
-- Safe before the new screens are live: nothing live calls the new functions, and the changed ones behave as before for a booking with no
-- extra time (no rows in booking_extensions, balance_reported_at null).
--
-- To take this back: drop the functions admin_extend_preview, admin_extend_booking, admin_remove_extension, admin_save_extra_time_rate,
-- extra_time_rate, extension_refresh_receipt, extension_notify, report_extra_sent, extra_sent_by_key; drop table booking_extensions and column
-- bookings.balance_reported_at; put back booking_change_plan (20261214100000_gift_vouchers.sql), admin_record_balance_received
-- (20261204100000_edit_booking_services.sql), admin_payment_review_queue (20261121100000_overdue_payments_to_check.sql), get_my_booking (as
-- now live) and build_receipt_snapshot (20261117100000_receipt_pdf.sql).

-- ---------------------------------------------------------------------------------------------
-- 1. The extra time on a booking
-- ---------------------------------------------------------------------------------------------
create table if not exists public.booking_extensions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  booking_session_id uuid references public.booking_sessions(id) on delete set null,
  -- Who and what it was for, as on the bill, kept even if the session is later changed.
  service_name_snapshot text not null,
  recipient_name text,
  minutes integer not null constraint booking_extensions_minutes_valid check (minutes between 15 and 120 and minutes % 15 = 0),
  price_gbp numeric(10,2) not null constraint booking_extensions_price_valid check (price_gbp >= 0 and price_gbp <= 1000),
  pay_by text not null constraint booking_extensions_pay_by_valid check (pay_by in ('bill', 'cash', 'transfer', 'free')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
create index if not exists booking_extensions_booking_idx on public.booking_extensions (booking_id, created_at);
alter table public.booking_extensions enable row level security;
drop policy if exists "admins can read booking extensions" on public.booking_extensions;
create policy "admins can read booking extensions" on public.booking_extensions for select to authenticated using (public.is_booking_admin());
drop policy if exists "clients can read own booking extensions" on public.booking_extensions;
create policy "clients can read own booking extensions" on public.booking_extensions for select to authenticated using (
  exists (select 1 from public.bookings b join public.clients c on c.id = b.client_id where b.id = booking_extensions.booking_id and c.auth_user_id = auth.uid()));
-- Written only through the functions below.
revoke all on table public.booking_extensions from public, anon, authenticated;
grant select on table public.booking_extensions to authenticated;
grant all on table public.booking_extensions to service_role;

-- When the client said they sent the extra still to pay (cleared once it is received).
alter table public.bookings add column if not exists balance_reported_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- 2. The extra-time rate (More › Services and prices › Extra time)
-- ---------------------------------------------------------------------------------------------
-- The hourly rate Vadim saved, or null to use each treatment's own 1-hour price.
create or replace function public.extra_time_rate()
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(s.value->>'hourly_gbp', '')::numeric(10,2) from public.business_settings s where s.key = 'extra_time_rate';
$$;
revoke all on function public.extra_time_rate() from public, anon, authenticated;

create or replace function public.admin_save_extra_time_rate(p_hourly_gbp numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_hourly_gbp is null then
    delete from public.business_settings where key = 'extra_time_rate';
    return;
  end if;
  if p_hourly_gbp <= 0 or p_hourly_gbp > 1000 then
    raise exception 'Enter an hourly price between £1 and £1,000' using errcode = '22023';
  end if;
  insert into public.business_settings(key, value, updated_by)
  values ('extra_time_rate', jsonb_build_object('hourly_gbp', round(p_hourly_gbp, 2)), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;
-- Vadim's rate (15 Nov 2026): £90 an hour, so +30 minutes is £45. He can change or clear it in More › Services and prices › Extra time.
insert into public.business_settings(key, value) values ('extra_time_rate', '{"hourly_gbp": 90}') on conflict (key) do nothing;
revoke all on function public.admin_save_extra_time_rate(numeric) from public, anon;
grant execute on function public.admin_save_extra_time_rate(numeric) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. What the Extend screen needs: can it be extended, each person's hourly price, how it is paid, what comes next that day
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_extend_preview(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_rate numeric(10,2) := public.extra_time_rate();
  v_reason text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  select * into b from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  select * into p from public.booking_payments where booking_id = b.id;
  v_reason := public.extension_refusal(b, p, v_now, v_today);
  return jsonb_build_object(
    'booking_id', b.id,
    'updated_at', b.updated_at,
    'refusal', v_reason,
    'extended_minutes', coalesce((select sum(e.minutes) from public.booking_extensions e where e.booking_id = b.id), 0),
    'end_minutes', b.start_minutes + b.treatment_duration_minutes,
    'rate', v_rate,
    'payment_method', p.method,
    'payment_status', p.status,
    -- Which ways the extra can be paid, in the order the screen offers them.
    'pay_by', public.extension_pay_choices(p),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'service_name', s.service_name_snapshot,
        'recipient_name', s.recipient_name, 'duration_minutes', s.duration_minutes,
        'hour_price', coalesce(v_rate, (select d.price_gbp from public.service_duration_prices d where d.service_id = s.service_id and d.duration_minutes = 60 and d.active),
          round(s.unit_price_gbp * 60 / s.duration_minutes, 2))) order by s.position)
      from public.booking_sessions s where s.booking_id = b.id), '[]'::jsonb),
    -- The next appointment that day, to warn about running into it (and offer a "running late" message).
    'next', (select jsonb_build_object('id', n.id, 'start_minutes', n.start_minutes, 'travel_buffer_minutes', n.travel_buffer_minutes,
        'first_name', c.first_name, 'phone', c.phone)
      from public.bookings n join public.clients c on c.id = n.client_id
      where n.date = b.date and n.id <> b.id and n.start_minutes >= b.start_minutes
        and n.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed')
      order by n.start_minutes limit 1));
end;
$$;
revoke all on function public.admin_extend_preview(uuid) from public, anon;
grant execute on function public.admin_extend_preview(uuid) to authenticated;

-- Why a booking cannot have extra time added now, or null.
create or replace function public.extension_refusal(b public.bookings, p public.booking_payments, p_now timestamptz, p_today date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when b.booking_status not in ('confirmed', 'completed') then 'Extra time can only be added to a session that went ahead.'
    when ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > p_now then 'The session has not started yet. To make it longer before then, use Edit booking.'
    when b.date < p_today - 7 then 'Extra time can be added up to 7 days after the session.'
    when p.id is null or p.status in ('rejected', 'refunded') then 'This booking has no payment to add extra time to.'
  end;
$$;
revoke all on function public.extension_refusal(public.bookings, public.booking_payments, timestamptz, date) from public, anon, authenticated;

-- How the extra can be paid: not paid yet, it goes on the bill; paid, cash there and then or a transfer still to come; a transfer the
-- client says they sent (not checked yet), a transfer still to come. Always free.
create or replace function public.extension_pay_choices(p public.booking_payments)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p.status = 'paid' then '["cash", "transfer", "free"]'::jsonb
    when p.status = 'awaiting_verification' then '["transfer", "free"]'::jsonb
    when p.status in ('awaiting_transfer', 'approved', 'awaiting_approval') then '["bill", "free"]'::jsonb
    else '[]'::jsonb
  end;
$$;
revoke all on function public.extension_pay_choices(public.booking_payments) from public, anon, authenticated;

-- A receipt already made is brought up to date (its old wording kept as a revision), once the booking is fully paid.
create or replace function public.extension_refresh_receipt(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  r public.booking_receipts%rowtype;
  v_fresh jsonb;
begin
  select * into b from public.bookings where id = p_booking_id;
  select * into p from public.booking_payments where booking_id = p_booking_id;
  select * into r from public.booking_receipts x where x.booking_id = p_booking_id for update;
  if r.id is null or b.balance_due_gbp > 0 or p.status is distinct from 'paid' or p.amount_gbp <> b.total_gbp then return; end if;
  v_fresh := public.build_receipt_snapshot(b.id);
  insert into public.booking_receipt_revisions(receipt_id, revision, snapshot, edited_by) values (r.id, r.edit_count + 1, r.snapshot, auth.uid());
  update public.booking_receipts set snapshot = r.snapshot || jsonb_build_object('appointment', v_fresh->'appointment', 'treatments', v_fresh->'treatments',
      'lines', v_fresh->'lines', 'total', v_fresh->'total', 'payment', v_fresh->'payment'),
    edited_at = clock_timestamp(), edited_by = auth.uid(), edit_count = r.edit_count + 1
  where id = r.id;
end;
$$;
revoke all on function public.extension_refresh_receipt(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. The client's message: the extra to pay by transfer (always sent when there is an email), or a thank-you with the bill (when ticked)
-- ---------------------------------------------------------------------------------------------
create or replace function public.extension_notify(p_event uuid, p_booking_id uuid, e public.booking_extensions)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_bank jsonb := (select s.value from public.business_settings s where s.key = 'bank_details');
  v_first text;
  v_lines text;
  v_body text;
  v_length text;
begin
  select * into b from public.bookings where id = p_booking_id;
  select * into p from public.booking_payments where booking_id = b.id;
  if nullif(btrim(b.booking_email_snapshot), '') is null then return; end if;
  select nullif(btrim(c.first_name), '') into v_first from public.clients c where c.id = b.client_id;
  v_length := case when b.treatment_duration_minutes % 60 = 0 then (b.treatment_duration_minutes / 60) || case when b.treatment_duration_minutes = 60 then ' hour' else ' hours' end
    when b.treatment_duration_minutes > 60 then (b.treatment_duration_minutes / 60) || ' h ' || (b.treatment_duration_minutes % 60) || ' min'
    else b.treatment_duration_minutes || ' minutes' end;
  -- The bill: each treatment, each extra time, then extras, travel and congestion as one line when there are any, and the total.
  v_lines := (select string_agg(l.line, E'\n' order by l.sort, l.pos) from (
      select 1 as sort, s.position as pos, format('%s, %s minutes%s: %s', s.service_name_snapshot, s.duration_minutes,
        coalesce(' (' || nullif(btrim(s.recipient_name), '') || ')', ''), public.notification_money(s.unit_price_gbp)) as line
        from public.booking_sessions s where s.booking_id = b.id
      union all
      select 2, extract(epoch from x.created_at)::integer, format('Extra time, %s minutes%s: %s', x.minutes,
        coalesce(' (' || nullif(btrim(x.recipient_name), '') || ')', ''), case when x.price_gbp = 0 then 'no charge' else public.notification_money(x.price_gbp) end)
        from public.booking_extensions x where x.booking_id = b.id
      union all
      select 3, 0, 'Extras, travel and charges: ' || public.notification_money(b.enhancements_total_gbp + b.travel_fee_gbp + b.congestion_fee_gbp)
        where b.enhancements_total_gbp + b.travel_fee_gbp + b.congestion_fee_gbp > 0
    ) l) || E'\n' || 'Total: ' || public.notification_money(b.total_gbp)
    || case when coalesce(b.gift_covered_gbp, 0) > 0 then E'\n' || 'Gift voucher: -' || public.notification_money(b.gift_covered_gbp) else '' end;

  v_body := format('%s Thank you for staying a little longer today. Your session was %s.', coalesce('Hi ' || v_first || '!', 'Hello!'), v_length)
    || E'\n\n' || v_lines;
  if e.pay_by = 'transfer' then
    v_body := v_body || format(E'\n\nThere is %s still to pay for the extra time. Please pay it by bank transfer, using the reference %s.',
        public.notification_money(b.balance_due_gbp), coalesce(p.payment_reference, b.booking_reference))
      || case when v_bank ? 'sort_code' and v_bank ? 'account_number' then
           format(E'\n\nAccount name: %s\nSort code: %s\nAccount number: %s', v_bank->>'account_name', v_bank->>'sort_code', v_bank->>'account_number')
             || case when v_bank ? 'bank_name' then format(E'\nBank: %s', v_bank->>'bank_name') else '' end
         else E'\n\nIf you need the bank details, just ask me.' end
      || E'\n\nOnce you have sent it, you can tell me on your booking page.';
  elsif e.pay_by = 'cash' then
    v_body := v_body || E'\n\nThe extra time was paid in cash. Thank you!';
  elsif e.pay_by = 'free' then
    v_body := v_body || E'\n\nThe extra time is on me.';
  elsif p.method = 'cash' then
    v_body := v_body || format(E'\n\nTo pay in cash: %s.', public.notification_money(p.amount_gbp));
  else
    v_body := v_body || format(E'\n\nTo pay by bank transfer: %s, using the reference %s.', public.notification_money(p.amount_gbp), coalesce(p.payment_reference, b.booking_reference));
  end if;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
  values (p_event, 'email', 'client', btrim(b.booking_email_snapshot),
    case when e.pay_by = 'transfer' then 'Your extra time' else 'Thank you for staying a little longer' end,
    v_body || E'\n\nSee your booking: {link}' || E'\n\nWarm wishes,\nVadim', '/account?booking=' || b.id::text);
end;
$$;
revoke all on function public.extension_notify(uuid, uuid, public.booking_extensions) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Add extra time
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_extend_booking(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_session_id uuid,
  p_minutes integer, p_price_gbp numeric, p_pay_by text, p_notify boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  s public.booking_sessions%rowtype;
  e public.booking_extensions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_date date;
  v_price numeric(10,2) := round(coalesce(p_price_gbp, -1), 2);
  v_pay_by text := p_pay_by;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_event uuid;
  v_refusal text;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_extend_booking', p_booking_id::text, extract(epoch from p_booking_updated_at)::text, p_session_id::text,
    p_minutes::text, v_price::text, p_pay_by, coalesce(p_notify, false)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_session_id is null or p_minutes is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if p_minutes not between 15 and 120 or p_minutes % 15 <> 0 then
    raise exception 'Choose 15 minutes to 2 hours of extra time.' using errcode = '22023';
  end if;
  if v_price < 0 or v_price > 1000 then
    raise exception 'Enter a price between £0 and £1,000.' using errcode = '22023';
  end if;
  -- No charge is £0, whatever was typed; £0 is no charge, whatever was chosen.
  if v_pay_by = 'free' then v_price := 0; elsif v_price = 0 then v_pay_by := 'free'; end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or b.updated_at is distinct from p_booking_updated_at then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_refusal := public.extension_refusal(b, p, v_now, v_today);
  if v_refusal is not null then raise exception '%', v_refusal using errcode = '22023'; end if;
  select * into s from public.booking_sessions where id = p_session_id and booking_id = b.id;
  if not found then raise exception 'Choose who stayed longer.' using errcode = '22023'; end if;
  if not public.extension_pay_choices(p) ? v_pay_by then
    raise exception 'That way of paying does not fit this booking. Please check it and try again.' using errcode = 'PT409';
  end if;
  if coalesce((select sum(x.minutes) from public.booking_extensions x where x.booking_id = b.id), 0) + p_minutes > 120 then
    raise exception 'A booking can have up to 2 hours of extra time in all.' using errcode = '22023';
  end if;
  if b.start_minutes + b.treatment_duration_minutes + p_minutes > 1440 then
    raise exception 'That would run past midnight. Choose less extra time.' using errcode = '22023';
  end if;

  v_command := public.admin_finish_command('admin_extend_booking', p_request_id, v_fingerprint, b.id);
  insert into public.booking_extensions(booking_id, booking_session_id, service_name_snapshot, recipient_name, minutes, price_gbp, pay_by, created_by)
  values (b.id, s.id, s.service_name_snapshot, s.recipient_name, p_minutes, v_price, v_pay_by, auth.uid())
  returning * into e;
  update public.bookings set treatment_duration_minutes = treatment_duration_minutes + p_minutes,
    total_gbp = total_gbp + v_price,
    balance_due_gbp = balance_due_gbp + case when v_pay_by = 'transfer' then v_price else 0 end,
    -- A new amount still to pay has not been sent yet, whatever was said about an earlier one.
    balance_reported_at = case when v_pay_by = 'transfer' then null else balance_reported_at end
  where id = b.id;
  if v_pay_by in ('bill', 'cash') and v_price > 0 then
    update public.booking_payments set amount_gbp = amount_gbp + v_price where id = p.id;
  end if;
  if v_pay_by in ('cash', 'free') then perform public.extension_refresh_receipt(b.id); end if;
  perform public.admin_lifecycle_event('booking.extended', v_command, b.id, jsonb_build_object('extension_id', e.id, 'minutes', p_minutes,
    'price_gbp', v_price, 'pay_by', v_pay_by, 'session_id', s.id, 'notify_client', v_pay_by = 'transfer' or coalesce(p_notify, false)));
  select o.id into v_event from public.event_outbox o where o.deduplication_key = 'admin-lifecycle:' || v_command::text;
  if v_pay_by = 'transfer' or coalesce(p_notify, false) then perform public.extension_notify(v_event, b.id, e); end if;
  return b.id;
end;
$$;
revoke all on function public.admin_extend_booking(uuid, uuid, timestamptz, uuid, integer, numeric, text, boolean) from public, anon;
grant execute on function public.admin_extend_booking(uuid, uuid, timestamptz, uuid, integer, numeric, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Remove extra time (a mistake, or the client should not pay it after all)
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_remove_extension(p_extension_id uuid, p_request_id uuid, p_booking_updated_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  e public.booking_extensions%rowtype;
  v_date date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_remove_extension', p_extension_id::text, extract(epoch from p_booking_updated_at)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_extension_id is null or p_booking_updated_at is null then raise exception 'Missing command arguments' using errcode = '22023'; end if;
  select x.date into v_date from public.booking_extensions e2 join public.bookings x on x.id = e2.booking_id where e2.id = p_extension_id;
  if not found then raise exception 'Booking state changed' using errcode = 'PT409'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into e from public.booking_extensions where id = p_extension_id for update;
  select * into b from public.bookings where id = e.booking_id for update;
  select * into p from public.booking_payments where booking_id = b.id for update;
  if e.id is null or b.updated_at is distinct from p_booking_updated_at then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  if b.booking_status not in ('confirmed', 'completed') then
    raise exception 'Extra time can only be changed on a session that went ahead.' using errcode = '22023';
  end if;
  if e.pay_by = 'transfer' and b.balance_due_gbp < e.price_gbp then
    raise exception 'The extra has already been received, so this extra time cannot be removed.' using errcode = '22023';
  end if;
  if e.pay_by = 'bill' and e.price_gbp > 0 and p.status not in ('awaiting_transfer', 'approved', 'awaiting_approval') then
    raise exception 'The bill with this extra time has already been paid, so it cannot be removed.' using errcode = '22023';
  end if;
  v_command := public.admin_finish_command('admin_remove_extension', p_request_id, v_fingerprint, b.id);
  delete from public.booking_extensions where id = e.id;
  update public.bookings set treatment_duration_minutes = greatest(treatment_duration_minutes - e.minutes, 1),
    total_gbp = greatest(total_gbp - e.price_gbp, 0),
    balance_due_gbp = case when e.pay_by = 'transfer' then balance_due_gbp - e.price_gbp else balance_due_gbp end,
    balance_reported_at = case when e.pay_by = 'transfer' and balance_due_gbp - e.price_gbp <= 0 then null else balance_reported_at end
  where id = b.id;
  if e.pay_by in ('bill', 'cash') and e.price_gbp > 0 then
    update public.booking_payments set amount_gbp = greatest(amount_gbp - e.price_gbp, 0) where id = p.id;
  end if;
  perform public.extension_refresh_receipt(b.id);
  perform public.admin_lifecycle_event('booking.extension_removed', v_command, b.id, jsonb_build_object('minutes', e.minutes, 'price_gbp', e.price_gbp, 'pay_by', e.pay_by));
  return b.id;
end;
$$;
revoke all on function public.admin_remove_extension(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.admin_remove_extension(uuid, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. The client: "I've sent the extra" (signed in, or from the private link in an email)
-- ---------------------------------------------------------------------------------------------
create or replace function public.report_extra_sent(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_name text;
  v_body text;
  v_event uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select x.* into b from public.bookings x join public.clients c on c.id = x.client_id
  where x.id = p_booking_id and (c.auth_user_id = auth.uid()
    or (c.id::text = coalesce(auth.jwt()->>'link_client', '') and x.id::text = coalesce(auth.jwt()->>'link_booking', '')))
  for update of x;
  if b.id is null then raise exception 'Booking is not available to this client' using errcode = '42501'; end if;
  if b.balance_due_gbp > 0 and b.booking_status in ('confirmed', 'completed') and b.balance_reported_at is null
     and exists (select 1 from public.booking_payments p where p.booking_id = b.id and p.status = 'paid') then
    update public.bookings set balance_reported_at = clock_timestamp() where id = b.id;
    select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
    v_name := format('%s says they sent the extra', coalesce(nullif(v_name, ''), 'A client'));
    v_body := format('%s for %s. Check your bank for the reference %s.', public.notification_money(b.balance_due_gbp),
      public.notification_when(b.date, b.start_minutes), coalesce((select p.payment_reference from public.booking_payments p where p.booking_id = b.id), b.booking_reference));
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('booking.extra_reported', 'booking', b.id, 'extra-reported:' || b.id::text || ':' || extract(epoch from clock_timestamp())::text,
      jsonb_build_object('booking_id', b.id, 'balance_due_gbp', b.balance_due_gbp))
    returning id into v_event;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (v_event, 'in_app', 'admin', 'admin', v_name, v_body, '/admin/bookings/' || b.id::text, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'telegram', 'admin', 'admin', v_name, v_body, '/admin/bookings/' || b.id::text);
  end if;
  return public.get_my_booking(p_booking_id);
end;
$$;
revoke all on function public.report_extra_sent(uuid) from public, anon;
grant execute on function public.report_extra_sent(uuid) to authenticated;

create or replace function public.extra_sent_by_key(p_booking_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_result jsonb;
begin
  perform public.booking_link_client(p_booking_id, p_key);
  v_result := public.report_extra_sent(p_booking_id);
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end;
$$;
revoke all on function public.extra_sent_by_key(uuid, text) from public;
grant execute on function public.extra_sent_by_key(uuid, text) to anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 8. Edit booking: a booking with extra time asks for it to be removed first.
CREATE OR REPLACE FUNCTION public.booking_change_plan(b bookings, p booking_payments, p_sessions jsonb, p_lower_price boolean, p_now timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- A gift voucher's part counts as money already held towards the booking (20261214100000).
  v_gift numeric(10,2) := coalesce(b.gift_covered_gbp, 0);
  v_amount numeric(10,2) := p.amount_gbp + coalesce(b.gift_covered_gbp, 0);
  v_refund numeric(10,2) := coalesce(b.refund_due_gbp, 0);
  v_balance numeric(10,2) := 0;
  v_back numeric(10,2);
  v_held boolean := p.status in ('paid', 'awaiting_verification');
begin
  -- Extra time (20261219100000) sits outside the treatments, so a change to who is coming or how long would count it twice: remove it first.
  if exists (select 1 from public.booking_extensions x where x.booking_id = b.id) then
    raise exception 'This booking has extra time. Remove the extra time first, then change the booking.' using errcode = '22023';
  end if;
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
    'amount_gbp', greatest(v_amount - v_gift, 0), 'previous_amount_gbp', p.amount_gbp,
    'refund_due_gbp', v_refund, 'previous_refund_due_gbp', coalesce(b.refund_due_gbp, 0),
    'balance_due_gbp', v_balance, 'previous_balance_due_gbp', coalesce(b.balance_due_gbp, 0));
end;
$function$;

-- 9. Mark extra received also clears "I've sent it".
CREATE OR REPLACE FUNCTION public.admin_record_balance_received(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  update public.bookings set balance_due_gbp = 0, balance_reported_at = null where id = b.id;
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
$function$;

-- 10. To check: an extra still to pay.
CREATE OR REPLACE FUNCTION public.admin_payment_review_queue(p_offset integer DEFAULT 0)
 RETURNS SETOF bookings
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 10000 then
    raise exception 'Invalid page' using errcode='22023';
  end if;
  return query select b.* from public.bookings b
  join public.booking_payments p on p.booking_id=b.id
  where (b.booking_status='awaiting_transfer' and p.method='bank_transfer' and p.status='awaiting_transfer')
     or (b.booking_status='awaiting_payment_verification' and p.method='bank_transfer' and p.status='awaiting_verification')
     or (b.booking_status='awaiting_cash_approval' and p.method='cash' and p.status='awaiting_approval')
     or (b.booking_status in ('confirmed','completed')
         and ((p.method='bank_transfer' and p.status in ('awaiting_transfer','awaiting_verification'))
           or (p.method='cash' and p.status='approved'))
         and b.date + make_interval(mins => b.start_minutes + b.treatment_duration_minutes)
             <= (now() at time zone 'Europe/London'))
     -- An extra still to pay on a paid booking (extra time, or a change that cost more): once the client says they sent it, or the session is over.
     or (b.booking_status in ('confirmed','completed') and p.status='paid' and b.balance_due_gbp > 0
         and (b.balance_reported_at is not null
           or b.date + make_interval(mins => b.start_minutes + b.treatment_duration_minutes) <= (now() at time zone 'Europe/London')))
  order by b.date, b.start_minutes, b.id offset p_offset limit 51;
end; $function$;

-- 11. The client's booking: the extra time on the bill, and where to pay an extra still owed.
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
  'late_fee_status',b.late_fee_status,'late_fee_due_gbp',b.late_fee_due_gbp,'refund_due_gbp',b.refund_due_gbp,'balance_due_gbp',b.balance_due_gbp,'balance_reported_at',b.balance_reported_at,
  'booking_extensions',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'minutes',x.minutes,'price_gbp',x.price_gbp,'pay_by',x.pay_by,
    'service_name_snapshot',x.service_name_snapshot,'recipient_name',x.recipient_name,'created_at',x.created_at) order by x.created_at),'[]'::jsonb)
    from public.booking_extensions x where x.booking_id=b.id),
  'extra_bank',case when b.balance_due_gbp > 0 and p.status='paid' then (select jsonb_build_object('account_name',s.value->>'account_name',
    'bank_name',s.value->>'bank_name','sort_code',s.value->>'sort_code','account_number',s.value->>'account_number')
    from public.business_settings s where s.key='bank_details') end,
  'cancelled_at',b.cancelled_at,
  'gift_covered_gbp',b.gift_covered_gbp,'gift_from',(select g.from_name from public.gift_vouchers g where g.id=b.gift_voucher_id),
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

-- 12. The receipt: a line for each extra time.
CREATE OR REPLACE FUNCTION public.build_receipt_snapshot(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.clients%rowtype;
  v_details jsonb;
  v_lines jsonb;
  v_extra jsonb;
  v_treatments jsonb;
  v_refusal text;
  v_travel_label text;
begin
  select * into b from public.bookings x where x.id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  select * into p from public.booking_payments x where x.booking_id = b.id;
  v_refusal := public.receipt_refusal(b, p, true);
  if v_refusal is not null then raise exception '%', v_refusal using errcode = 'PT409'; end if;
  select value into v_details from public.business_settings where key = 'receipt_details';
  if v_details is null or nullif(btrim(v_details->>'name'), '') is null then
    raise exception 'Save your receipt details first' using errcode = 'PT409';
  end if;
  -- Insurers ask for the practitioner and their register, so a receipt is never made without them.
  if nullif(btrim(v_details->>'practitioner_name'), '') is null or nullif(btrim(v_details->>'association'), '') is null
     or nullif(btrim(v_details->>'membership_number'), '') is null then
    raise exception 'Save your receipt details first' using errcode = 'PT409';
  end if;
  if p.amount_gbp <> b.total_gbp then
    raise exception 'The amount paid does not match the booking, so a receipt cannot be made' using errcode = 'PT409';
  end if;
  select * into c from public.clients x where x.id = b.client_id;

  -- What the Admin sees on the booking: each treatment and extra, then travel and congestion. If the booking's own subtotals disagree
  -- with those lines, the subtotals are used instead; if neither adds up to the total, no receipt is made rather than a wrong one.
  -- The words on each line come from names the Admin typed elsewhere, so they are tidied the same way as anything typed here.
  v_travel_label := left(coalesce(public.receipt_clean_text('Travel' || coalesce(', ' || nullif(btrim(b.service_area_name_snapshot), ''), ''), false, false), 'Travel'), 120);
  v_extra := coalesce((select jsonb_agg(jsonb_build_object('label', left(coalesce(public.receipt_clean_text(t.label, false, false), 'Treatment'), 120), 'amount', t.amount) order by t.sort, t.pos, t.label) from (
      select 1 as sort, s.position as pos, s.service_name_snapshot || ', ' || s.duration_minutes || ' minutes' as label, s.unit_price_gbp as amount
        from public.booking_sessions s where s.booking_id = b.id
      union all
      select 1, 100 + row_number() over (order by x.created_at)::integer, 'Extra time, ' || x.minutes || ' minutes' || coalesce(' (' || nullif(btrim(x.recipient_name), '') || ')', ''), x.price_gbp
        from public.booking_extensions x where x.booking_id = b.id      union all
      select 2, 0, e.enhancement_name_snapshot || case when e.quantity > 1 then ' × ' || e.quantity else '' end, e.unit_price_gbp * e.quantity
        from public.booking_enhancements e where e.booking_id = b.id
      union all
      select 2, s2.position, se.enhancement_name_snapshot || case when se.quantity > 1 then ' × ' || se.quantity else '' end, se.unit_price_gbp * se.quantity
        from public.booking_session_enhancements se join public.booking_sessions s2 on s2.id = se.booking_session_id where s2.booking_id = b.id
    ) t), '[]'::jsonb);
  v_lines := v_extra
    || case when b.travel_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', v_travel_label, 'amount', b.travel_fee_gbp)) else '[]'::jsonb end
    || case when b.congestion_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Congestion charge', 'amount', b.congestion_fee_gbp)) else '[]'::jsonb end;
  if (select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(v_lines) l) <> b.total_gbp then
    v_lines := (case when b.service_subtotal_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Treatment', 'amount', b.service_subtotal_gbp)) else '[]'::jsonb end)
      || coalesce((select jsonb_agg(jsonb_build_object('label', 'Extra time, ' || x.minutes || ' minutes', 'amount', x.price_gbp) order by x.created_at)
           from public.booking_extensions x where x.booking_id = b.id), '[]'::jsonb)
      || (case when b.enhancements_total_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Extras', 'amount', b.enhancements_total_gbp)) else '[]'::jsonb end)
      || (case when b.travel_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', v_travel_label, 'amount', b.travel_fee_gbp)) else '[]'::jsonb end)
      || (case when b.congestion_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Congestion charge', 'amount', b.congestion_fee_gbp)) else '[]'::jsonb end);
    if (select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(v_lines) l) <> b.total_gbp then
      raise exception 'The prices on this booking do not add up to its total, so a receipt cannot be made' using errcode = 'PT409';
    end if;
  end if;
  -- Each treatment as booked: its name, its length, and who it was for (when the booking names them), for the treatment section of the PDF.
  v_treatments := coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', left(coalesce(public.receipt_clean_text(s.service_name_snapshot, false, false), 'Treatment'), 120),
      'duration_minutes', s.duration_minutes,
      'recipient', left(public.receipt_clean_text(s.recipient_name, false, false), 120))) order by s.position)
    from public.booking_sessions s where s.booking_id = b.id), '[]'::jsonb);

  return jsonb_build_object(
    'business', v_details,
    'billed_to', left(coalesce(public.receipt_clean_text(concat_ws(' ', c.first_name, c.last_name), false, false), 'Client'), 120),
    'reference', b.booking_reference,
    'appointment', jsonb_build_object('date', b.date, 'start_minutes', b.start_minutes, 'duration_minutes', b.treatment_duration_minutes),
    'treatments', v_treatments,
    'lines', v_lines,
    'total', b.total_gbp,
    'payment', jsonb_build_object('method', p.method, 'paid_at', p.paid_at, 'amount', p.amount_gbp));
end;
$function$;
