-- Gift voucher records (Vadim, 19 Nov 2026; plan: https://claude.ai/artifact/KfwynGRBr3YFvahkernxEj, ADR-108).
--
-- In plain words:
--   1. Every voucher keeps a History, written the moment anything happens to it (and filled in once from the dates already saved for
--      the vouchers made before this): bought or made, transfer said, paid, receipt made, emailed, reminder, booked, moved, booking
--      cancelled (voucher back, or used up), marked used, not used after all, more time, details changed, refund asked, refund sent,
--      money arrived after a cancel, cancelled. Vadim's own changes also show in Alerts › Gifts.
--   2. The buyer gets a receipt (its own numbers, GV-2026-0001…), made by itself when the voucher is paid. It shows only the last four
--      letters of the code. A refund keeps the receipt and stamps it REFUNDED.
--   3. The person who uses a voucher gets a normal treatment receipt, which says how much the voucher paid and how much they paid.
--   4. Income counts a voucher's money once, at what the buyer paid: on the session's day when it is booked with (also when the session
--      is cancelled late and the voucher is used up), on the day Vadim marks it used without a booking, or on its last day when it ends
--      unused. A refunded or never-paid voucher never counts. The Income figures also say what was sold, used, ended, refunded and is held.
--   5. Every voucher stays in More › Gift vouchers (cancelled ones no longer drop out after 30 days); "Refunded, cancel it" records the
--      amount; "Money arrived after all" for a gift cancelled before the money was seen.
--   6. Emails to the buyer carry the link back to their own gift page.
--   7. A "Give the gift of calm" card on the booking page, with a switch to hide it.
--
-- Safe to run more than once (create or replace, if not exists, on conflict do nothing).
-- Undo: see ADR-108 in docs/DECISIONS.md.

-- ---------------------------------------------------------------------------------------------
-- 1. New columns and tables
-- ---------------------------------------------------------------------------------------------
alter table public.gift_vouchers add column if not exists refund_gbp numeric(10,2);
alter table public.gift_vouchers drop constraint if exists gift_vouchers_refund_valid;
alter table public.gift_vouchers add constraint gift_vouchers_refund_valid check (refund_gbp is null or refund_gbp >= 0);
-- A refund already sent before this was the full price.
update public.gift_vouchers set refund_gbp = price_gbp where refunded_at is not null and refund_gbp is null and paid_at is not null;
update public.gift_vouchers set refund_gbp = 0 where refunded_at is not null and refund_gbp is null and paid_at is null;
-- Before this, "Refunded, cancel it" on a paid voucher only cancelled it: those were full refunds (dated when they were cancelled).
update public.gift_vouchers set refunded_at = updated_at, refund_requested_at = updated_at, refund_gbp = price_gbp
where status = 'cancelled' and paid_at is not null and refunded_at is null and refund_requested_at is null;

create table if not exists public.gift_voucher_history (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null references public.gift_vouchers(id) on delete cascade,
  at timestamptz not null default clock_timestamp(),
  kind text not null,
  -- 'buyer', 'admin', 'client' (the person booking) or 'system'
  actor text not null default 'system',
  words text not null,
  details jsonb not null default '{}'::jsonb
);
create index if not exists gift_voucher_history_voucher on public.gift_voucher_history(voucher_id, at);
alter table public.gift_voucher_history enable row level security;
revoke all on table public.gift_voucher_history from public, anon, authenticated;
grant select, insert, update, delete on table public.gift_voucher_history to service_role;

create table if not exists public.gift_receipt_counters (year integer primary key, last_number integer not null);
alter table public.gift_receipt_counters enable row level security;
revoke all on table public.gift_receipt_counters from public, anon, authenticated;
grant select, insert, update, delete on table public.gift_receipt_counters to service_role;

create table if not exists public.gift_voucher_receipts (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null unique references public.gift_vouchers(id) on delete restrict,
  receipt_number text not null unique,
  issued_at timestamptz not null default clock_timestamp(),
  snapshot jsonb not null constraint gift_voucher_receipts_snapshot_is_object check (jsonb_typeof(snapshot) = 'object')
);
alter table public.gift_voucher_receipts enable row level security;
revoke all on table public.gift_voucher_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.gift_voucher_receipts to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Small helpers
-- ---------------------------------------------------------------------------------------------
create or replace function public.gift_day_words(p_at timestamptz)
returns text language sql stable set search_path = '' as $$ select trim(to_char(p_at at time zone 'Europe/London', 'FMDD Mon YYYY')) $$;
create or replace function public.gift_session_words(p_date date, p_start integer)
returns text language sql immutable set search_path = '' as $$
  select trim(to_char(p_date, 'FMDD Mon YYYY')) || ', ' || lpad((p_start / 60)::text, 2, '0') || ':' || lpad((p_start % 60)::text, 2, '0')
$$;
-- The last day a voucher can be used (its end is the last second of that London day).
create or replace function public.gift_last_day(p_expires timestamptz)
returns date language sql stable set search_path = '' as $$ select ((p_expires - interval '1 second') at time zone 'Europe/London')::date $$;
revoke all on function public.gift_day_words(timestamptz), public.gift_session_words(date, integer), public.gift_last_day(timestamptz) from public, anon, authenticated;

-- One line of a voucher's History. Vadim's own changes that nothing else records also go to Alerts › Gifts (read, so they never count as new).
create or replace function public.gift_history_add(p_voucher uuid, p_kind text, p_actor text, p_words text, p_details jsonb default '{}'::jsonb,
  p_alert boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_event uuid;
begin
  insert into public.gift_voucher_history(voucher_id, kind, actor, words, details) values (p_voucher, p_kind, coalesce(p_actor, 'system'), p_words, coalesce(p_details, '{}'::jsonb));
  if p_alert then
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('gift.' || p_kind, 'gift_voucher', p_voucher, 'gift.' || p_kind || ':' || p_voucher::text || ':' || clock_timestamp()::text,
      jsonb_build_object('gift_voucher_id', p_voucher, 'actor_type', coalesce(p_actor, 'system'), 'words', p_words) || coalesce(p_details, '{}'::jsonb))
    on conflict (deduplication_key) do nothing returning id into v_event;
    if v_event is not null then
      insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at, read_at)
      values (v_event, 'in_app', 'admin', 'admin', p_words, p_words, '/admin/gifts', 'sent', clock_timestamp(), clock_timestamp());
    end if;
  end if;
end; $$;
revoke all on function public.gift_history_add(uuid, text, text, text, jsonb, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The History, written as it happens
-- ---------------------------------------------------------------------------------------------
create or replace function public.gift_history_on_voucher()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor text := public.activity_actor();
  b record;
  v_changed text[] := '{}';
begin
  if v_actor = 'client' and auth.uid() is null then v_actor := 'buyer'; end if;
  if tg_op = 'INSERT' then
    if new.created_by = 'admin' then
      perform public.gift_history_add(new.id, 'made', 'admin', format('Made by you: %s for %s, %s', public.gift_words(new.minutes, new.people), new.recipient_name, public.notification_money(new.price_gbp)));
    else
      perform public.gift_history_add(new.id, 'bought', 'buyer', format('Bought online by %s: %s for %s, %s', new.buyer_name, public.gift_words(new.minutes, new.people), new.recipient_name, public.notification_money(new.price_gbp)));
    end if;
    if new.paid_at is not null then
      perform public.gift_history_add(new.id, 'paid', 'admin', format('Paid %s, %s', public.notification_money(new.price_gbp), case when new.payment_method = 'cash' then 'cash' else 'bank transfer' end));
    end if;
    return null;
  end if;

  if new.transfer_declared_at is not null and old.transfer_declared_at is null then
    perform public.gift_history_add(new.id, 'transfer_said', 'buyer', 'Buyer said the transfer is made');
  end if;
  if new.paid_at is not null and old.paid_at is null then
    perform public.gift_history_add(new.id, 'paid', 'admin', format('Paid %s, %s', public.notification_money(new.price_gbp), case when new.payment_method = 'cash' then 'cash' else 'bank transfer' end));
  end if;
  if new.recipient_sent_at is not null and old.recipient_sent_at is null then
    perform public.gift_history_add(new.id, 'emailed', 'system', format('Emailed to %s', coalesce(new.recipient_email, new.recipient_name)));
  end if;
  if new.reminder_sent_at is not null and old.reminder_sent_at is null then
    perform public.gift_history_add(new.id, 'reminder', 'system', 'Reminder sent: a month left');
  end if;

  -- Booked with, used without a booking, given back, or "not used after all".
  if new.status = 'used' and old.status is distinct from 'used' then
    if new.booking_id is not null then
      select bk.booking_reference, bk.date, bk.start_minutes, nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') as who into b
        from public.bookings bk left join public.clients c on c.id = bk.client_id where bk.id = new.booking_id;
      perform public.gift_history_add(new.id, 'booked', case when v_actor = 'admin' then 'admin' else 'client' end,
        format('Booked by %s for %s (%s)', coalesce(b.who, 'a client'), public.gift_session_words(b.date, b.start_minutes), b.booking_reference),
        jsonb_build_object('booking_id', new.booking_id));
    else
      perform public.gift_history_add(new.id, 'marked_used', 'admin', 'Marked used by you', '{}'::jsonb, true);
    end if;
  elsif old.status = 'used' and new.status = 'ready' then
    if current_setting('app.gift_not_used', true) = '1' or old.booking_id is null then
      perform public.gift_history_add(new.id, 'not_used', 'admin', format('Not used after all: can be used until %s', public.gift_london_date(new.expires_at)), '{}'::jsonb, true);
    else
      select bk.booking_reference into b from public.bookings bk where bk.id = old.booking_id;
      perform public.gift_history_add(new.id, 'back', case when v_actor = 'buyer' then 'client' else v_actor end,
        format('Booking %s cancelled in good time: voucher can be used again, until %s', coalesce(b.booking_reference, ''), public.gift_london_date(new.expires_at)),
        jsonb_build_object('booking_id', old.booking_id));
    end if;
  end if;

  -- More time (not when it came back from a booking, which may add time by itself).
  if new.expires_at is distinct from old.expires_at and old.expires_at is not null and old.paid_at is not null and new.status = old.status then
    perform public.gift_history_add(new.id, 'extended', 'admin',
      format('More time: %s → %s', public.gift_london_date(old.expires_at), public.gift_london_date(new.expires_at)), '{}'::jsonb, true);
  end if;

  if new.recipient_name is distinct from old.recipient_name then v_changed := v_changed || format('for: %s → %s', old.recipient_name, new.recipient_name); end if;
  if new.from_name is distinct from old.from_name then v_changed := v_changed || format('from: %s → %s', old.from_name, new.from_name); end if;
  if new.message is distinct from old.message then v_changed := v_changed || 'message'::text; end if;
  if new.recipient_email is distinct from old.recipient_email then v_changed := v_changed || format('email: %s → %s', coalesce(old.recipient_email, 'none'), coalesce(new.recipient_email, 'none')); end if;
  if new.send_at is distinct from old.send_at and old.send_at is not null then v_changed := v_changed || format('emailed on: %s → %s', public.gift_day_words(old.send_at), public.gift_day_words(new.send_at)); end if;
  if cardinality(v_changed) > 0 then
    perform public.gift_history_add(new.id, 'changed', 'admin', 'Details changed: ' || array_to_string(v_changed, '; '), '{}'::jsonb, true);
  end if;

  -- Cancelled, refund asked, refund sent, money arrived after a cancel.
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if v_actor = 'buyer' or v_actor = 'client' then
      perform public.gift_history_add(new.id, case when new.refund_requested_at is not null then 'refund_asked' else 'buyer_cancelled' end, 'buyer',
        case when new.paid_at is not null then format('Buyer asked for a refund of %s: code stopped', public.notification_money(new.price_gbp))
             when new.refund_requested_at is not null then 'Buyer cancelled after saying the transfer was made: refund owed if the money arrives'
             else 'Buyer cancelled before paying' end);
    elsif new.refunded_at is null then
      perform public.gift_history_add(new.id, 'cancelled', v_actor, case when new.paid_at is null then 'Cancelled: not paid' else 'Cancelled by you' end);
    end if;
  end if;
  if new.refund_requested_at is not null and old.refund_requested_at is null and old.status = 'cancelled' then
    perform public.gift_history_add(new.id, 'money_arrived', 'admin', format('Money arrived after the cancel: %s to send back', public.notification_money(new.price_gbp)), '{}'::jsonb, true);
  end if;
  if new.refunded_at is not null and old.refunded_at is null then
    perform public.gift_history_add(new.id, 'refunded', 'admin',
      case when coalesce(new.refund_gbp, 0) > 0 and new.refund_gbp < new.price_gbp
             then format('Refund sent: %s (%s kept)', public.notification_money(new.refund_gbp), public.notification_money(new.price_gbp - new.refund_gbp))
           when coalesce(new.refund_gbp, 0) > 0 then format('Refund sent: %s', public.notification_money(new.refund_gbp))
           when new.paid_at is not null then 'Cancelled by you, nothing sent back'
           else 'Cleared: the money never came' end, jsonb_build_object('refund_gbp', coalesce(new.refund_gbp, 0)));
  end if;
  return null;
end; $$;
revoke all on function public.gift_history_on_voucher() from public, anon, authenticated;
drop trigger if exists gift_vouchers_history on public.gift_vouchers;
create trigger gift_vouchers_history after insert or update on public.gift_vouchers for each row execute function public.gift_history_on_voucher();

-- A booking made with a voucher: moved, cancelled late (voucher used up) or missed. Named to run after bookings_gift_voucher_back,
-- so a booking cancelled in good time has already given its voucher back (and the voucher's own line says so).
create or replace function public.gift_history_on_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_actor text := public.activity_actor();
begin
  if new.gift_voucher_id is null then return null; end if;
  select * into v from public.gift_vouchers g where g.id = new.gift_voucher_id;
  if not found or v.booking_id is distinct from new.id then return null; end if;
  if (new.date, new.start_minutes) is distinct from (old.date, old.start_minutes) and new.booking_status not in ('cancelled', 'no_show') then
    perform public.gift_history_add(v.id, 'moved', v_actor, format('Session moved: %s → %s', public.gift_session_words(old.date, old.start_minutes), public.gift_session_words(new.date, new.start_minutes)),
      jsonb_build_object('booking_id', new.id));
  end if;
  if new.booking_status in ('cancelled', 'no_show') and old.booking_status is distinct from new.booking_status and v.status = 'used' then
    perform public.gift_history_add(v.id, 'used_up', v_actor,
      case when new.booking_status = 'no_show' then format('Session %s missed: voucher used', new.booking_reference)
           else format('Booking %s cancelled late: voucher used up', new.booking_reference) end, jsonb_build_object('booking_id', new.id));
  end if;
  return null;
end; $$;
revoke all on function public.gift_history_on_booking() from public, anon, authenticated;
drop trigger if exists bookings_zz_gift_history on public.bookings;
create trigger bookings_zz_gift_history after update of date, start_minutes, booking_status on public.bookings
  for each row when (new.gift_voucher_id is not null) execute function public.gift_history_on_booking();

-- "Not used after all" tells the History it was Vadim (from 20261216100000_gift_voucher_fixes.sql, otherwise unchanged).
create or replace function public.admin_mark_gift_used(p_voucher_id uuid, p_used boolean default true)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  if p_used then
    update public.gift_vouchers g set status = 'used', used_at = clock_timestamp() where g.id = p_voucher_id and g.status = 'ready' returning * into v;
  else
    -- Only once its booking is cancelled or missed, so one voucher never pays for two bookings.
    if exists (select 1 from public.gift_vouchers g join public.bookings b on b.id = g.booking_id
               where g.id = p_voucher_id and b.booking_status not in ('cancelled', 'no_show')) then
      raise exception 'This voucher''s booking is still on. Cancel the booking first.' using errcode = 'PT409';
    end if;
    perform set_config('app.gift_not_used', '1', true);
    update public.gift_vouchers g set status = 'ready', used_at = null, booking_id = null,
           expires_at = greatest(g.expires_at, public.gift_end_of_day(clock_timestamp() + interval '30 days'))
     where g.id = p_voucher_id and g.status = 'used' returning * into v;
    perform set_config('app.gift_not_used', '', true);
  end if;
  if not found then raise exception 'That voucher can''t be changed now.' using errcode = 'PT409'; end if;
  return v;
end; $$;

-- The History of the vouchers made before this, from the dates already saved (once: only for a voucher with no History yet).
do $$
declare g public.gift_vouchers%rowtype; b record;
begin
  for g in select * from public.gift_vouchers x where not exists (select 1 from public.gift_voucher_history h where h.voucher_id = x.id) order by x.created_at loop
    insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values
      (g.id, g.created_at, case when g.created_by = 'admin' then 'made' else 'bought' end, case when g.created_by = 'admin' then 'admin' else 'buyer' end,
       case when g.created_by = 'admin' then format('Made by you: %s for %s, %s', public.gift_words(g.minutes, g.people), g.recipient_name, public.notification_money(g.price_gbp))
            else format('Bought online by %s: %s for %s, %s', g.buyer_name, public.gift_words(g.minutes, g.people), g.recipient_name, public.notification_money(g.price_gbp)) end,
       '{"backfilled": true}');
    if g.transfer_declared_at is not null then
      insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, g.transfer_declared_at, 'transfer_said', 'buyer', 'Buyer said the transfer is made', '{"backfilled": true}');
    end if;
    if g.paid_at is not null then
      insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, g.paid_at, 'paid', 'admin',
        format('Paid %s, %s', public.notification_money(g.price_gbp), case when g.payment_method = 'cash' then 'cash' else 'bank transfer' end), '{"backfilled": true}');
    end if;
    if g.recipient_sent_at is not null then
      insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, g.recipient_sent_at, 'emailed', 'system', format('Emailed to %s', g.recipient_email), '{"backfilled": true}');
    end if;
    if g.reminder_sent_at is not null then
      insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, g.reminder_sent_at, 'reminder', 'system', 'Reminder sent: a month left', '{"backfilled": true}');
    end if;
    if g.status = 'used' and g.booking_id is not null then
      select bk.booking_reference, bk.date, bk.start_minutes, nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') as who into b
        from public.bookings bk left join public.clients c on c.id = bk.client_id where bk.id = g.booking_id;
      insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, coalesce(g.used_at, g.updated_at), 'booked', 'client',
        format('Booked by %s for %s (%s)', coalesce(b.who, 'a client'), public.gift_session_words(b.date, b.start_minutes), b.booking_reference),
        jsonb_build_object('booking_id', g.booking_id, 'backfilled', true));
    elsif g.status = 'used' then
      insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, coalesce(g.used_at, g.updated_at), 'marked_used', 'admin', 'Marked used by you', '{"backfilled": true}');
    end if;
    if g.status = 'cancelled' then
      -- Refunded by Vadim himself ("Refunded, cancel it"): asked and sent at the same moment, so only the refund line below.
      if g.refund_requested_at is not null and g.refund_requested_at is not distinct from g.refunded_at then
        null;
      elsif g.refund_requested_at is not null then
        insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, g.refund_requested_at, 'refund_asked', 'buyer',
          case when g.paid_at is not null then format('Buyer asked for a refund of %s: code stopped', public.notification_money(g.price_gbp))
               else 'Buyer cancelled after saying the transfer was made: refund owed if the money arrives' end, '{"backfilled": true}');
      else
        insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, g.updated_at, 'cancelled', 'admin',
          case when g.paid_at is null then 'Cancelled: not paid' else 'Cancelled by you' end, '{"backfilled": true}');
      end if;
      if g.refunded_at is not null then
        insert into public.gift_voucher_history(voucher_id, at, kind, actor, words, details) values (g.id, g.refunded_at, 'refunded', 'admin',
          case when coalesce(g.refund_gbp, 0) > 0 then format('Refund sent: %s', public.notification_money(g.refund_gbp)) else 'Cleared: the money never came' end,
          jsonb_build_object('refund_gbp', coalesce(g.refund_gbp, 0), 'backfilled', true));
      end if;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. The buyer's receipt (GV-YYYY-NNNN)
-- ---------------------------------------------------------------------------------------------
-- What the voucher's money paid for, as lines that add up to what the buyer paid (one line when a price was typed by hand).
create or replace function public.gift_receipt_lines(v public.gift_vouchers)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_lines jsonb;
begin
  v_lines := jsonb_build_array(jsonb_build_object('label',
      initcap(left(public.gift_words(v.minutes, v.people), 1)) || substr(public.gift_words(v.minutes, v.people), 2)
        || case when v.people = 2 then format(' (2 × %s)', public.notification_money(v.massage_price_gbp)) else '' end,
      'amount', v.massage_price_gbp * v.people))
    || case when v.travel_cover_gbp > 0 then jsonb_build_array(jsonb_build_object('label',
         case v.travel_choice when 'area' then 'Travel and congestion charge, ' || coalesce(v.service_area_name, 'their area')
              when 'upto' then 'Travel and congestion charge, up to ' || public.notification_money(v.travel_cover_gbp)
              else 'Travel and congestion charge, any area' end, 'amount', v.travel_cover_gbp)) else '[]'::jsonb end
    || case when coalesce(v.enhancements_gbp, 0) > 0 then jsonb_build_array(jsonb_build_object('label',
         coalesce(nullif(array_to_string(v.enhancement_names, ', '), ''), 'Extras'), 'amount', v.enhancements_gbp)) else '[]'::jsonb end;
  -- A shorter word in "a 90-minute massage" → "A 90-minute massage".
  v_lines := jsonb_set(v_lines, '{0,label}', to_jsonb(regexp_replace(v_lines#>>'{0,label}', '^a ', 'A ')));
  if (select sum((l->>'amount')::numeric) from jsonb_array_elements(v_lines) l) <> v.price_gbp then
    v_lines := jsonb_build_array(jsonb_build_object('label', 'Gift voucher: ' || public.gift_words(v.minutes, v.people), 'amount', v.price_gbp));
  end if;
  return v_lines;
end; $$;

create or replace function public.gift_receipt_snapshot(v public.gift_vouchers)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_details jsonb;
begin
  select value into v_details from public.business_settings where key = 'receipt_details';
  if v_details is null or nullif(btrim(v_details->>'name'), '') is null then
    raise exception 'Save your receipt details first' using errcode = 'PT409';
  end if;
  return jsonb_build_object(
    'kind', 'gift_voucher',
    'business', v_details,
    'billed_to', left(coalesce(public.receipt_clean_text(v.buyer_name, false, false), 'Buyer'), 120),
    'buyer_email', v.buyer_email,
    'reference', v.payment_reference,
    'voucher', jsonb_build_object('for', left(coalesce(public.receipt_clean_text(v.recipient_name, false, false), ''), 120),
      'from', left(coalesce(public.receipt_clean_text(v.from_name, false, false), ''), 120),
      'gift', public.gift_words(v.minutes, v.people), 'code_end', right(v.code, 4), 'expires_at', v.expires_at),
    'lines', public.gift_receipt_lines(v),
    'total', v.price_gbp,
    'payment', jsonb_build_object('method', v.payment_method, 'paid_at', v.paid_at, 'amount', v.price_gbp));
end; $$;

-- One receipt per paid voucher, numbered in order. Calling it again gives the receipt already made.
create or replace function public.issue_gift_receipt(p_voucher_id uuid)
returns public.gift_voucher_receipts language plpgsql security definer set search_path = '' as $$
declare r public.gift_voucher_receipts%rowtype; v public.gift_vouchers%rowtype; v_snapshot jsonb; v_number integer; v_text text;
  v_year integer := extract(year from (clock_timestamp() at time zone 'Europe/London'))::integer;
begin
  perform pg_advisory_xact_lock(42421, 0);
  select * into r from public.gift_voucher_receipts x where x.voucher_id = p_voucher_id;
  if found then return r; end if;
  select * into v from public.gift_vouchers g where g.id = p_voucher_id;
  if not found then raise exception 'That voucher was not found.' using errcode = '22023'; end if;
  if v.paid_at is null then raise exception 'A receipt is made once the voucher is paid.' using errcode = 'PT409'; end if;
  v_snapshot := public.gift_receipt_snapshot(v);
  insert into public.gift_receipt_counters(year, last_number) values (v_year, 1)
  on conflict (year) do update set last_number = public.gift_receipt_counters.last_number + 1 returning last_number into v_number;
  v_text := 'GV-' || v_year || '-' || lpad(v_number::text, 4, '0');
  insert into public.gift_voucher_receipts(voucher_id, receipt_number, snapshot)
  values (v.id, v_text, v_snapshot || jsonb_build_object('number', v_text, 'issued_on', (clock_timestamp() at time zone 'Europe/London')::date))
  returning * into r;
  perform public.gift_history_add(v.id, 'receipt', 'system', 'Receipt ' || v_text || ' made');
  return r;
end; $$;

-- What a voucher receipt now stands for: paid, refunded (with the amount and day) or cancelled.
create or replace function public.gift_receipt_json(r public.gift_voucher_receipts)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('number', r.receipt_number, 'issued_at', r.issued_at, 'snapshot', r.snapshot,
    'standing', jsonb_build_object(
      'status', case when g.refunded_at is not null and coalesce(g.refund_gbp, 0) > 0 then 'refunded'
                     when g.refunded_at is not null then 'cancelled'
                     when g.status = 'cancelled' and g.refund_requested_at is not null then 'refund_due'
                     when g.status = 'cancelled' then 'cancelled' else 'paid' end,
      'refunded_at', g.refunded_at, 'refunded_gbp', g.refund_gbp))
  from public.gift_vouchers g where g.id = r.voucher_id;
$$;

-- Made by itself when a voucher is paid (marked paid, or made already paid). A receipt that cannot be made (no Receipt details yet)
-- never holds up the payment: Vadim can make it later with the Receipt button.
create or replace function public.gift_auto_receipt()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.paid_at is not null and (tg_op = 'INSERT' or old.paid_at is null) then
    begin
      perform public.issue_gift_receipt(new.id);
    exception when others then
      raise warning 'Gift receipt for % not made: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end; $$;
drop trigger if exists gift_vouchers_receipt on public.gift_vouchers;
create trigger gift_vouchers_receipt after insert or update of paid_at on public.gift_vouchers for each row execute function public.gift_auto_receipt();

-- Vadim: the receipt (made now if it was not made yet).
create or replace function public.admin_gift_receipt(p_voucher_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_booking_admin();
  return public.gift_receipt_json(public.issue_gift_receipt(p_voucher_id));
end; $$;

-- The buyer, from their own gift page (its private key is the only way in).
create or replace function public.get_gift_receipt(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  select * into v from public.gift_vouchers g where g.buyer_token = p_token;
  if not found or p_token is null then raise exception 'That link doesn''t work. Please message Vadim.' using errcode = 'PT404'; end if;
  if v.paid_at is null then raise exception 'The receipt is ready once your payment has arrived.' using errcode = 'PT409'; end if;
  return public.gift_receipt_json(public.issue_gift_receipt(v.id));
end; $$;

revoke all on function public.gift_receipt_lines(public.gift_vouchers), public.gift_receipt_snapshot(public.gift_vouchers), public.issue_gift_receipt(uuid),
  public.gift_receipt_json(public.gift_voucher_receipts), public.gift_auto_receipt() from public, anon, authenticated;
revoke all on function public.admin_gift_receipt(uuid) from public, anon;
grant execute on function public.admin_gift_receipt(uuid) to authenticated;
revoke all on function public.get_gift_receipt(uuid) from public;
grant execute on function public.get_gift_receipt(uuid) to anon, authenticated;

-- Receipts for the vouchers already paid.
do $$
declare g record;
begin
  for g in select x.id from public.gift_vouchers x where x.paid_at is not null
             and not exists (select 1 from public.gift_voucher_receipts r where r.voucher_id = x.id) order by x.paid_at loop
    begin
      perform public.issue_gift_receipt(g.id);
    exception when others then
      raise warning 'Gift receipt for % not made: %', g.id, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. A treatment receipt for a session a gift voucher paid for (receipt_message from 20261117100000_receipt_pdf.sql,
-- build_receipt_snapshot from 20261219100000_extend_session.sql). Before, the receipt maker refused
-- any booking where the client paid less than the price. Now the voucher's part is allowed for, and the receipt says what it paid.
-- ---------------------------------------------------------------------------------------------
create or replace function public.receipt_message(p_snapshot jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select public.receipt_strip_link(concat_ws(E'\n',
    'Receipt ' || (p_snapshot->>'number'),
    'Issued ' || to_char((p_snapshot->>'issued_on')::date, 'FMDD FMMonth YYYY'),
    '',
    nullif(p_snapshot#>>'{business,name}', ''),
    nullif(concat_ws(' · ', nullif(p_snapshot#>>'{business,phone}', ''), nullif(p_snapshot#>>'{business,email}', ''), nullif(p_snapshot#>>'{business,website}', '')), ''),
    nullif(p_snapshot#>>'{business,address}', ''),
    '',
    'Received from: ' || (p_snapshot->>'billed_to'),
    'Booking reference: ' || (p_snapshot->>'reference'),
    'Appointment: ' || to_char((p_snapshot#>>'{appointment,date}')::date, 'FMDay FMDD FMMonth YYYY') || ' at '
      || lpad(((p_snapshot#>>'{appointment,start_minutes}')::integer / 60)::text, 2, '0') || ':' || lpad(((p_snapshot#>>'{appointment,start_minutes}')::integer % 60)::text, 2, '0')
      || ' (' || (p_snapshot#>>'{appointment,duration_minutes}') || ' minutes)',
    '',
    (select string_agg((l.value->>'label') || ': ' || public.notification_money((l.value->>'amount')::numeric), E'\n' order by l.ordinality)
       from jsonb_array_elements(p_snapshot->'lines') with ordinality l(value, ordinality)),
    case when p_snapshot ? 'gift' then
      'Total: ' || public.notification_money((p_snapshot->>'total')::numeric) || E'\n'
      || 'Paid with gift voucher' || coalesce(' (ending ' || (p_snapshot#>>'{gift,code_end}') || ')', '') || ': ' || public.notification_money(greatest((p_snapshot->>'total')::numeric - coalesce((p_snapshot#>>'{payment,amount}')::numeric, 0), 0)) || E'\n'
      || 'Paid by you: ' || public.notification_money(coalesce((p_snapshot#>>'{payment,amount}')::numeric, 0))
    else 'Total paid: ' || public.notification_money((p_snapshot->>'total')::numeric) end,
    -- Nothing paid by the client (the voucher paid it all): no "Paid by bank transfer" line.
    case when p_snapshot ? 'gift' and coalesce((p_snapshot#>>'{payment,amount}')::numeric, 0) = 0 then null else
    'Paid by ' || case p_snapshot#>>'{payment,method}' when 'bank_transfer' then 'bank transfer' when 'cash' then 'cash'
        else replace(coalesce(p_snapshot#>>'{payment,method}', 'payment'), '_', ' ') end
      || ' on ' || to_char(((p_snapshot#>>'{payment,paid_at}')::timestamptz at time zone 'Europe/London')::date, 'FMDD FMMonth YYYY') || '.' end,
    case when nullif(p_snapshot#>>'{business,practitioner_name}', '') is not null then
      E'\nPractitioner: ' || concat_ws(', ', p_snapshot#>>'{business,practitioner_name}', nullif(p_snapshot#>>'{business,practitioner_title}', ''))
      || concat_ws(', ', E'\n' || nullif(p_snapshot#>>'{business,association}', ''),
           'membership number ' || nullif(p_snapshot#>>'{business,membership_number}', '')) end,
    case when nullif(btrim(p_snapshot->>'note'), '') is not null then E'\n' || (p_snapshot->>'note') end,
    case when nullif(btrim(p_snapshot#>>'{business,closing}'), '') is not null then E'\n' || (p_snapshot#>>'{business,closing}') end
  ));
$$;

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
  -- A booking a gift voucher paid for, in part or in full: the client paid the rest (20261221100000). The voucher never pays more than
  -- the booking: after Edit booking made it cheaper than the voucher (90 → 60 minutes), the voucher pays all of it.
  if p.amount_gbp + least(coalesce(b.gift_covered_gbp, 0), b.total_gbp) <> b.total_gbp then
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
    'payment', jsonb_build_object('method', p.method, 'paid_at', p.paid_at, 'amount', p.amount_gbp))
    || case when coalesce(b.gift_covered_gbp, 0) > 0 then jsonb_build_object('gift', jsonb_build_object('covered', least(b.gift_covered_gbp, b.total_gbp),
         'code_end', (select right(g.code, 4) from public.gift_vouchers g where g.id = b.gift_voucher_id))) else '{}'::jsonb end;
end;
$function$;


-- Extra time refreshes the receipt only when the payment matches the booking: for a gift session, the voucher's part counts too
-- (copied from 20261219100000_extend_session.sql; only the amount check changed).
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
  if r.id is null or b.balance_due_gbp > 0 or p.status is distinct from 'paid'
     or p.amount_gbp + least(coalesce(b.gift_covered_gbp, 0), b.total_gbp) <> b.total_gbp then return; end if;
  v_fresh := public.build_receipt_snapshot(b.id);
  insert into public.booking_receipt_revisions(receipt_id, revision, snapshot, edited_by) values (r.id, r.edit_count + 1, r.snapshot, auth.uid());
  update public.booking_receipts set snapshot = r.snapshot || jsonb_build_object('appointment', v_fresh->'appointment', 'treatments', v_fresh->'treatments',
      'lines', v_fresh->'lines', 'total', v_fresh->'total', 'payment', v_fresh->'payment')
      || case when v_fresh ? 'gift' then jsonb_build_object('gift', v_fresh->'gift') else '{}'::jsonb end,
    edited_at = clock_timestamp(), edited_by = auth.uid(), edit_count = r.edit_count + 1
  where id = r.id;
end;
$$;
revoke all on function public.extension_refresh_receipt(uuid) from public, anon, authenticated;

-- Receipts for gift sessions already paid (a £0 one is "paid" the moment it is booked), as Mark paid would have made them.
do $$
declare x record;
begin
  for x in select b.id from public.bookings b join public.booking_payments p on p.booking_id = b.id
            where b.gift_voucher_id is not null and coalesce(b.gift_covered_gbp, 0) > 0 and p.status = 'paid' and b.booking_status in ('confirmed', 'completed')
              and not exists (select 1 from public.booking_receipts r where r.booking_id = b.id) order by b.date loop
    begin
      perform public.issue_receipt(x.id, null);
    exception when others then
      raise warning 'Receipt for booking % not made: %', x.id, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Income: a voucher's money counted once (from 20261109100000_income.sql and 20261218100000_income_owed_gaps.sql)
-- ---------------------------------------------------------------------------------------------
-- One line per booking with money, as before, now with what a gift voucher paid for it (the price the buyer paid, counted on the
-- session's day, also when it was cancelled late or missed and the voucher was used up), plus one line for a voucher Vadim marked used
-- without a booking (on that day) and one for a voucher that ended unused (on its last day). gift_gbp is the voucher part of a line.
-- income_lines gains two columns, so it and admin_income_rows are made again.
drop function if exists public.admin_income_rows(date, date);
drop function if exists public.income_lines(date, date);
create function public.income_lines(p_from date, p_to date)
returns table (booking_id uuid, date date, start_minutes integer, booking_reference text, client_name text, method text, booking_status text,
  received_gbp numeric, refund_gbp numeric, late_fee_gbp numeric, net_gbp numeric, gift_gbp numeric, gift_voucher_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with money as (
    select b.id, b.date, b.start_minutes, b.booking_reference, b.booking_status, p.method,
      nullif(btrim(concat_ws(' ', btrim(c.first_name), nullif(btrim(c.last_name), ''))), '') as client_name,
      case when p.status in ('paid', 'refunded') then p.amount_gbp else 0 end as paid_gbp,
      case when p.status = 'refunded'
        then coalesce(p.refunded_gbp, greatest(p.amount_gbp - case when b.late_fee_status = 'received' then b.late_fee_due_gbp else 0 end, 0))
        else 0 end as refund_gbp,
      case when b.late_fee_status = 'received' and coalesce(p.status, '') not in ('paid', 'refunded') then b.late_fee_due_gbp else 0 end as late_fee_gbp,
      coalesce(g.price_gbp, 0) as gift_gbp, g.id as gift_id
    from public.bookings b
    left join public.booking_payments p on p.booking_id = b.id
    left join public.clients c on c.id = b.client_id
    left join public.gift_vouchers g on g.booking_id = b.id and g.status = 'used'
    where b.date between p_from and p_to
  )
  select * from (
    select id, date, start_minutes, booking_reference, client_name, method, booking_status,
      paid_gbp + late_fee_gbp + gift_gbp, refund_gbp, late_fee_gbp, paid_gbp + late_fee_gbp + gift_gbp - refund_gbp, gift_gbp, gift_id
    from money
    where paid_gbp > 0 or late_fee_gbp > 0 or gift_gbp > 0
    union all
    select null::uuid, (g.used_at at time zone 'Europe/London')::date, null::integer, g.payment_reference, g.recipient_name, 'gift_voucher', 'gift_used',
      g.price_gbp, 0::numeric, 0::numeric, g.price_gbp, g.price_gbp, g.id
    from public.gift_vouchers g
    where g.status = 'used' and g.booking_id is null and g.paid_at is not null and g.used_at is not null
      and (g.used_at at time zone 'Europe/London')::date between p_from and p_to
    union all
    select null::uuid, public.gift_last_day(g.expires_at), null::integer, g.payment_reference, g.recipient_name, 'gift_voucher', 'gift_ended',
      g.price_gbp, 0::numeric, 0::numeric, g.price_gbp, g.price_gbp, g.id
    from public.gift_vouchers g
    where g.status = 'ready' and g.paid_at is not null and g.expires_at <= clock_timestamp()
      and public.gift_last_day(g.expires_at) between p_from and p_to
    union all
    -- Cancelled with only part (or none) of the money sent back: what was kept counts on the day of the refund.
    select null::uuid, (g.refunded_at at time zone 'Europe/London')::date, null::integer, g.payment_reference, g.recipient_name, 'gift_voucher', 'gift_kept',
      g.price_gbp, coalesce(g.refund_gbp, 0), 0::numeric, g.price_gbp - coalesce(g.refund_gbp, 0), g.price_gbp - coalesce(g.refund_gbp, 0), g.id
    from public.gift_vouchers g
    where g.status = 'cancelled' and g.paid_at is not null and g.refunded_at is not null and coalesce(g.refund_gbp, 0) < g.price_gbp
      and (g.refunded_at at time zone 'Europe/London')::date between p_from and p_to
  ) lines
  order by 2, 3 nulls last;
$$;
revoke all on function public.income_lines(date, date) from public, anon, authenticated;

create function public.admin_income_rows(p_from date, p_to date)
returns table (booking_id uuid, date date, start_minutes integer, booking_reference text, client_name text, method text, booking_status text,
  received_gbp numeric, refund_gbp numeric, late_fee_gbp numeric, net_gbp numeric, gift_gbp numeric, gift_voucher_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_booking_admin();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose up to a year' using errcode = '22023';
  end if;
  return query select * from public.income_lines(p_from, p_to);
end;
$$;
revoke all on function public.admin_income_rows(date, date) from public, anon;
grant execute on function public.admin_income_rows(date, date) to authenticated;

-- The Gift vouchers box on Income, for one period: money in from vouchers paid (sold), vouchers used and ended unused (both in the
-- total), refunds sent, voucher sessions still to come this period, and what is held now for vouchers not used yet.
create or replace function public.income_gift_figures(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sold_gbp', coalesce((select sum(g.price_gbp) from public.gift_vouchers g where g.paid_at is not null
                 and (g.paid_at at time zone 'Europe/London')::date between p_from and p_to), 0),
    'sold_count', (select count(*) from public.gift_vouchers g where g.paid_at is not null and (g.paid_at at time zone 'Europe/London')::date between p_from and p_to),
    'used_gbp', coalesce((select sum(l.gift_gbp) from public.income_lines(p_from, p_to) l where l.booking_status is distinct from 'gift_ended' and l.booking_status is distinct from 'gift_kept'), 0),
    'kept_gbp', coalesce((select sum(l.gift_gbp) from public.income_lines(p_from, p_to) l where l.booking_status = 'gift_kept'), 0),
    'ended_gbp', coalesce((select sum(l.gift_gbp) from public.income_lines(p_from, p_to) l where l.booking_status = 'gift_ended'), 0),
    'refunded_gbp', coalesce((select sum(g.refund_gbp) from public.gift_vouchers g where g.refunded_at is not null
                 and (g.refunded_at at time zone 'Europe/London')::date between p_from and p_to), 0),
    'held_gbp', coalesce((select sum(g.price_gbp) from public.gift_vouchers g left join public.bookings b on b.id = g.booking_id
                 where g.paid_at is not null and (
                   (g.status = 'ready' and g.expires_at > clock_timestamp())
                   or (g.status = 'used' and b.id is not null and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp())
                   or (g.status = 'cancelled' and g.refund_requested_at is not null and g.refunded_at is null))), 0),
    'held_count', (select count(*) from public.gift_vouchers g left join public.bookings b on b.id = g.booking_id
                 where g.paid_at is not null and (
                   (g.status = 'ready' and g.expires_at > clock_timestamp())
                   or (g.status = 'used' and b.id is not null and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp())
                   or (g.status = 'cancelled' and g.refund_requested_at is not null and g.refunded_at is null))));
$$;
revoke all on function public.income_gift_figures(date, date) from public, anon, authenticated;

create or replace function public.admin_income_summary(p_kind text, p_anchor date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
  v_prev_from date;
  v_prev_to date;
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_total numeric;
  v_previous numeric;
  v_count integer;
  v_result jsonb;
begin
  perform public.require_booking_admin();
  if p_anchor is null or p_kind is null or p_kind not in ('week', 'month', 'year', 'tax_year') then
    raise exception 'Unknown period' using errcode = '22023';
  end if;
  select period_from, period_to into v_from, v_to from public.income_period(p_kind, p_anchor);
  select period_from, period_to into v_prev_from, v_prev_to from public.income_period(p_kind, v_from - 1);
  select coalesce(sum(net_gbp), 0), count(*) filter (where net_gbp > 0 and booking_id is not null) into v_total, v_count from public.income_lines(v_from, v_to);
  select coalesce(sum(net_gbp), 0) into v_previous from public.income_lines(v_prev_from, v_prev_to);
  select jsonb_build_object(
    'kind', p_kind, 'from', v_from, 'to', v_to, 'previous_from', v_prev_from, 'previous_to', v_prev_to,
    'upcoming', v_from > v_today,
    'total_gbp', v_total,
    'previous_gbp', v_previous,
    'change_percent', case when v_previous > 0 then round((v_total - v_previous) / v_previous * 100) end,
    -- Bank and cash: what clients paid that way. Gift vouchers used or ended: their own figure (the money came when they were bought).
    'bank_gbp', coalesce((select sum(net_gbp - gift_gbp) from public.income_lines(v_from, v_to) where method = 'bank_transfer'), 0),
    'cash_gbp', coalesce((select sum(net_gbp - gift_gbp) from public.income_lines(v_from, v_to) where method = 'cash'), 0),
    'gift_gbp', coalesce((select sum(gift_gbp) from public.income_lines(v_from, v_to)), 0),
    'gifts', public.income_gift_figures(v_from, v_to),
    'bookings', v_count,
    'average_gbp', case when v_count > 0 then round(coalesce((select sum(net_gbp) from public.income_lines(v_from, v_to) where booking_id is not null), 0) / v_count, 2) end,
    -- Bars: the days of a week, the weeks (Monday to Sunday) of a month, the months of a year, each kept within the period.
    'bars', (select jsonb_agg(jsonb_build_object('from', s, 'to', e,
        'total_gbp', coalesce((select sum(net_gbp) from public.income_lines(s, e)), 0))
        || (select public.income_hour_figures(sum(w.work_minutes)::integer, sum(w.travel_minutes)::integer, sum(w.earned_gbp))
            from public.income_work_lines(v_from, v_to) w where w.date between s and e) order by s)
      from (
        select greatest(g::date, v_from) as s,
          least(case p_kind when 'week' then g::date when 'month' then g::date + 6 else (g + interval '1 month')::date - 1 end, v_to) as e
        from generate_series(
          case p_kind when 'week' then v_from when 'month' then v_from - (extract(isodow from v_from)::integer - 1) else date_trunc('month', v_from)::date end,
          v_to,
          case p_kind when 'week' then interval '1 day' when 'month' then interval '7 days' else interval '1 month' end) g
      ) buckets),
    -- Days: only for a month, the calendar's squares.
    'days', case when p_kind = 'month' then (select jsonb_agg(jsonb_build_object('date', d,
        'received_gbp', coalesce((select sum(net_gbp) from public.income_lines(d, d)), 0),
        'to_come_gbp', case when d >= v_today then coalesce((
            select sum(t.to_come_gbp) from public.income_to_come_lines(d, d) t), 0) else 0 end) order by d)
      from generate_series(v_from, v_to, interval '1 day') g(d0) cross join lateral (select g.d0::date as d) x) end,
    'hours', (select public.income_hour_figures(sum(work_minutes)::integer, sum(travel_minutes)::integer, sum(earned_gbp)) from public.income_work_lines(v_from, v_to))
      || jsonb_build_object('areas', coalesce((select jsonb_agg(a.figures || jsonb_build_object('name', a.area)
            order by (a.figures->>'per_hour_gbp')::numeric desc nulls last, a.area)
          from (select area, public.income_hour_figures(sum(work_minutes)::integer, sum(travel_minutes)::integer, sum(earned_gbp)) as figures
                from public.income_work_lines(v_from, v_to) group by area) a), '[]'::jsonb)),
    'owed_count', (select count(distinct booking_id) from public.money_owed_lines()),
    -- Still to come (Upcoming): income_to_come_lines from today to the end of the period. Never part of the total.
    'still_to_come_gbp', case when v_to >= v_today then coalesce((
        select sum(t.to_come_gbp) from public.income_to_come_lines(greatest(v_from, v_today), v_to) t), 0) end)
  into v_result;
  return v_result;
end;
$$;

revoke all on function public.admin_income_summary(text, date) from public, anon;
grant execute on function public.admin_income_summary(text, date) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. More › Gift vouchers: every voucher, always, with its History and receipt
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_gift_vouchers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_booking_admin();
  return coalesce((select jsonb_agg(to_jsonb(g) - 'buyer_token' || jsonb_build_object(
      'code_shown', public.gift_code_shown(g.code),
      'expired', g.status = 'ready' and g.expires_at <= clock_timestamp(),
      'refund_to_send', g.refund_requested_at is not null and g.refunded_at is null,
      'receipt_number', (select r.receipt_number from public.gift_voucher_receipts r where r.voucher_id = g.id),
      'history', coalesce((select jsonb_agg(jsonb_build_object('at', h.at, 'kind', h.kind, 'actor', h.actor, 'words', h.words) order by h.at, h.id)
                  from public.gift_voucher_history h where h.voucher_id = g.id), '[]'::jsonb),
      'booking', (select jsonb_build_object('id', b.id, 'date', b.date, 'start_minutes', b.start_minutes, 'status', b.booking_status,
                    'reference', b.booking_reference,
                    'started', ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp(),
                    'client_name', btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')))
                  from public.bookings b left join public.clients c on c.id = b.client_id where b.id = g.booking_id))
    order by case when g.refund_requested_at is not null and g.refunded_at is null then -1
                  else case g.status when 'awaiting_payment' then 0 when 'ready' then 1 when 'used' then 2 else 3 end end, g.created_at desc)
    from public.gift_vouchers g), '[]'::jsonb);
end; $$;

-- "Refund sent" (from 20261217100000_gift_buyer_cancel.sql): now keeps the amount (the price, or nothing when the money never came).
create or replace function public.admin_gift_refund_sent(p_voucher_id uuid, p_money_came boolean default true)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  update public.gift_vouchers g set refunded_at = clock_timestamp(), refund_gbp = case when p_money_came then g.price_gbp else 0 end
  where g.id = p_voucher_id and g.status = 'cancelled' and g.refund_requested_at is not null and g.refunded_at is null returning * into v;
  if not found then raise exception 'That refund has already been recorded.' using errcode = 'PT409'; end if;
  if not p_money_came then return v; end if;
  perform public.gift_notify(v, 'refund_sent', null, null, v.buyer_email, 'Your gift voucher refund is on its way',
    format('Hi %s,', split_part(btrim(v.buyer_name), ' ', 1)) || E'\n\n'
      || format('I''ve sent your %s back to the account it came from (reference %s). It usually arrives within a few hours.', public.notification_money(v.price_gbp), v.payment_reference),
    null, 'gift.refund_sent:' || v.id::text);
  return v;
end; $$;

-- "Refunded, cancel it" on a paid voucher that has not been used: Vadim says how much he sent back (0 for a voucher he gave free and is
-- taking back). The code stops working; the buyer is emailed when money was sent and there is an email to send it to.
create or replace function public.admin_gift_refunded(p_voucher_id uuid, p_amount numeric)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_now timestamptz := clock_timestamp();
begin
  perform public.require_booking_admin();
  select * into v from public.gift_vouchers g where g.id = p_voucher_id for update;
  if not found then raise exception 'That voucher was not found.' using errcode = '22023'; end if;
  if v.status = 'used' then raise exception 'That voucher has already been used, so it can''t be refunded here. Press "Not used after all" first if it wasn''t.' using errcode = 'PT409'; end if;
  if v.status <> 'ready' then raise exception 'Only a paid voucher can be refunded.' using errcode = 'PT409'; end if;
  if p_amount is null or p_amount < 0 or p_amount > v.price_gbp then
    raise exception '%', format('Enter the amount you sent back, from £0 to %s.', public.notification_money(v.price_gbp)) using errcode = '22023';
  end if;
  update public.gift_vouchers g set status = 'cancelled', refund_requested_at = v_now, refunded_at = v_now, refund_gbp = round(p_amount, 2)
  where g.id = v.id returning * into v;
  update public.notification_deliveries d set read_at = v_now
  where d.channel = 'in_app' and d.read_at is null
    and d.event_id in (select e.id from public.event_outbox e where e.aggregate_type = 'gift_voucher' and e.aggregate_id = v.id);
  perform public.gift_notify(v, 'refund_sent', null, null, case when p_amount > 0 then v.buyer_email end, 'Your gift voucher refund is on its way',
    format('Hi %s,', split_part(btrim(v.buyer_name), ' ', 1)) || E'\n\n'
      || format('I''ve sent %s back to you for the gift voucher for %s (reference %s). The voucher''s code no longer works.',
           public.notification_money(p_amount), v.recipient_name, v.payment_reference),
    null, 'gift.refund_sent:' || v.id::text);
  return v;
end; $$;

-- The buyer cancelled before Vadim saw their money, without saying they had sent it, and then it arrived: it becomes a refund to send.
create or replace function public.admin_gift_money_arrived(p_voucher_id uuid)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  update public.gift_vouchers g set refund_requested_at = clock_timestamp()
  where g.id = p_voucher_id and g.status = 'cancelled' and g.paid_at is null and g.refund_requested_at is null returning * into v;
  if not found then raise exception 'That voucher already has a refund recorded.' using errcode = 'PT409'; end if;
  return v;
end; $$;

revoke all on function public.admin_gift_vouchers(), public.admin_gift_refund_sent(uuid, boolean), public.admin_gift_refunded(uuid, numeric),
  public.admin_gift_money_arrived(uuid), public.admin_mark_gift_used(uuid, boolean) from public, anon;
grant execute on function public.admin_gift_vouchers(), public.admin_gift_refund_sent(uuid, boolean), public.admin_gift_refunded(uuid, numeric),
  public.admin_gift_money_arrived(uuid), public.admin_mark_gift_used(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. The buyer: their gift page link in every email to them, and their receipt on the page
-- ---------------------------------------------------------------------------------------------
-- As 20261214100000_gift_vouchers.sql, plus: an email to the buyer about their purchase ends with the link to their own gift page
-- ({site} is the app's address, filled in when the email is sent).
create or replace function public.gift_notify(p_voucher public.gift_vouchers, p_kind text, p_admin_title text, p_admin_body text,
  p_client_email text, p_client_title text, p_client_body text, p_client_link text, p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_event uuid; v_body text := p_client_body;
begin
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('gift.' || p_kind, 'gift_voucher', p_voucher.id, coalesce(p_dedupe, 'gift.' || p_kind || ':' || p_voucher.id::text || ':' || clock_timestamp()::text),
          jsonb_build_object('gift_voucher_id', p_voucher.id))
  on conflict (deduplication_key) do nothing
  returning id into v_event;
  if v_event is null then return null; end if;
  if p_admin_title is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (v_event, 'in_app', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts', 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'telegram', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts'),
           (v_event, 'email', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts');
  end if;
  if p_client_title is not null and nullif(btrim(coalesce(p_client_email, '')), '') is not null then
    if p_kind in ('bought', 'ready', 'refund_requested', 'refund_sent') and lower(btrim(p_client_email)) = lower(coalesce(p_voucher.buyer_email, '')) then
      v_body := v_body || E'\n\n' || case p_kind
        when 'bought' then 'Your gift page, to say you''ve paid or to cancel: '
        when 'ready' then 'Your receipt and your gift page: '
        else 'Your gift page: ' end || '{site}/gift?t=' || p_voucher.buyer_token::text;
    end if;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'email', 'client', btrim(p_client_email), p_client_title, v_body || E'\n\nWarm wishes,\nVadim', p_client_link);
  end if;
  return v_event;
end; $$;
revoke all on function public.gift_notify(public.gift_vouchers, text, text, text, text, text, text, text, text) from public, anon, authenticated;

-- The buyer's page (from 20261217100000_gift_buyer_cancel.sql), plus whether there is a receipt and how much was refunded.
create or replace function public.get_my_gift_purchase(p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', g.status, 'reference', g.payment_reference, 'amount', g.price_gbp, 'recipient_name', g.recipient_name,
    'minutes', g.minutes, 'people', g.people, 'transfer_declared', g.transfer_declared_at is not null, 'delivery', g.delivery,
    'recipient_email', g.recipient_email, 'send_at', g.send_at,
    'code', case when g.status in ('ready', 'used') then public.gift_code_shown(g.code) end,
    'bank', case when g.status = 'awaiting_payment' then (select value from public.business_settings where key = 'bank_details') end,
    'refund_until', g.created_at + interval '14 days',
    'can_refund', g.status = 'ready' and g.created_by is distinct from 'admin' and g.created_at + interval '14 days' > clock_timestamp(),
    'made_by_vadim', g.created_by = 'admin',
    'refund_requested', g.refund_requested_at is not null,
    'refunded', g.refunded_at is not null,
    'refund_gbp', g.refund_gbp,
    'receipt', g.paid_at is not null)
  from public.gift_vouchers g where g.buyer_token = p_token;
$$;

-- The buyer's own cancel (from 20261217100000_gift_buyer_cancel.sql): not for a voucher Vadim made himself, whose buyer may have been
-- emailed the link to their page for the receipt.
create or replace function public.gift_buyer_cancel(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_now timestamptz := clock_timestamp(); v_refund boolean;
begin
  select * into v from public.gift_vouchers g where g.buyer_token = p_token for update;
  if not found then raise exception 'That link doesn''t work. Please message Vadim.' using errcode = 'PT404'; end if;
  if v.status = 'cancelled' then return public.get_my_gift_purchase(p_token); end if;
  -- A voucher Vadim made himself (paid him in cash, or given free) is changed or refunded by him, not from this page.
  if v.created_by = 'admin' and v.status <> 'cancelled' then
    raise exception 'Please message Vadim to change or cancel this voucher.' using errcode = 'PT409';
  end if;
  if v.status = 'used' then
    raise exception 'This voucher has already been used, so it can''t be refunded.' using errcode = 'PT409';
  end if;
  if v.status = 'ready' and v.created_at + interval '14 days' <= v_now then
    raise exception 'Refunds are possible within 14 days of buying, and that time has passed. Please message Vadim if something has gone wrong.' using errcode = 'PT409';
  end if;

  -- Money may be on its way (they said they sent it) or has arrived (paid): a refund is owed.
  v_refund := v.status = 'ready' or v.transfer_declared_at is not null;
  update public.gift_vouchers g set status = 'cancelled', refund_requested_at = case when v_refund then v_now end
  where g.id = v.id returning * into v;

  if v_refund then
    perform public.gift_notify(v, 'refund_requested',
      format('%s asked for a gift voucher refund', v.buyer_name),
      format('%s, reference %s, for %s.', public.notification_money(v.price_gbp), v.payment_reference, v.recipient_name)
        || case when v.paid_at is null then ' You had not marked it paid yet: if the money arrives, send it back.' else '' end
        || ' The code no longer works. Send the money back to the account it came from, then press Refund sent in More › Gift vouchers.',
      v.buyer_email, 'Your gift voucher is cancelled',
      format('Hi %s,', split_part(btrim(v.buyer_name), ' ', 1)) || E'\n\n'
        || format('Your gift voucher for %s is cancelled, as you asked. ', v.recipient_name)
        || case when v.paid_at is null
             then format('If your transfer of %s has already left your account, I''ll send it back to the account it came from as soon as it arrives.', public.notification_money(v.price_gbp))
             else format('I''ll send your %s back to the account it came from within 3 working days, and email you when it''s on its way.', public.notification_money(v.price_gbp)) end,
      null, 'gift.refund_requested:' || v.id::text);
  else
    perform public.gift_notify(v, 'buyer_cancelled',
      format('%s cancelled a gift voucher before paying', v.buyer_name),
      format('%s, reference %s, for %s. Nothing to do, unless that money arrives after all.', public.notification_money(v.price_gbp), v.payment_reference, v.recipient_name),
      null, null, null, null, 'gift.buyer_cancelled:' || v.id::text);
  end if;
  return public.get_my_gift_purchase(p_token);
end; $$;

-- "Cancel" on a paid voucher (the old "Refunded, cancel it", still on screen until the app is updated) records a full refund, so a paid
-- voucher is never cancelled without saying what happened to its money (from 20261220110000_activity_gift_cancel.sql).
create or replace function public.admin_cancel_gift_voucher(p_voucher_id uuid)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  select * into v from public.gift_vouchers g where g.id = p_voucher_id;
  if found and v.status = 'ready' and v.paid_at is not null then
    return public.admin_gift_refunded(p_voucher_id, v.price_gbp);
  end if;
  update public.gift_vouchers g set status = 'cancelled' where g.id = p_voucher_id and g.status in ('awaiting_payment', 'ready') returning * into v;
  if not found then raise exception 'That voucher has already been used, so it can''t be cancelled.' using errcode = 'PT409'; end if;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('gift.cancelled', 'gift_voucher', v.id, 'gift.cancelled:' || v.id::text,
    jsonb_build_object('gift_voucher_id', v.id, 'actor_type', 'admin', 'actor_id', auth.uid(), 'from_status', 'ready'))
  on conflict (deduplication_key) do nothing;
  update public.notification_deliveries d set read_at = clock_timestamp()
  where d.channel = 'in_app' and d.read_at is null
    and d.event_id in (select e.id from public.event_outbox e where e.aggregate_type = 'gift_voucher' and e.aggregate_id = v.id);
  return v;
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 9. "Give a gift" on the booking page, with a switch (More › Gift vouchers) to hide it. Shown while vouchers are on sale.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_gift_banner()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.gift_setting_on() and coalesce((select (value #>> '{}')::boolean from public.business_settings where key = 'gift_banner_on'), true);
$$;
create or replace function public.admin_set_gift_banner(p_on boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_booking_admin();
  insert into public.business_settings(key, value) values ('gift_banner_on', to_jsonb(coalesce(p_on, true)))
  on conflict (key) do update set value = excluded.value;
  return coalesce(p_on, true);
end; $$;
revoke all on function public.get_gift_banner(), public.admin_set_gift_banner(boolean) from public;
grant execute on function public.get_gift_banner() to anon, authenticated;
revoke all on function public.admin_set_gift_banner(boolean) from anon;
grant execute on function public.admin_set_gift_banner(boolean) to authenticated;
