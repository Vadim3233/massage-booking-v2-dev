-- Gift vouchers, second step (Vadim, 15 Nov 2026). Mockup: /mnt/project-files/gift-vouchers/mockups/areas-extras.png
--
-- What it does, in plain words:
--   * "Where do they live?" is now a few one-tap cards built from the areas' charges: Just the massage, a card for each lower charge
--     ('upto': covers up to that amount, e.g. congestion £18 for Mayfair and Westminster), and Everything included (the highest).
--   * Extras (enhancements such as Extra strong) can be added to a voucher and paid for with it; booking with it picks them and the voucher pays them.
--   * The buyer ticks the terms: a home visit in Vadim's areas, 12 months, refundable within 14 days if unused (Vadim's rule, 15 Nov 2026).
--   * A late change to a gift booking (inside the free-cancellation hours): the late fee is only ever on what the client paid themselves (never on
--     what the voucher paid); cancelling late uses the voucher up (it is not given back); moving it late is not possible online (message Vadim).
--     Earlier than that, cancelling gives the voucher back as before. Vadim can still give a voucher back by hand (Not used after all).
--   * A gift booking cannot be moved online to a day after its voucher ends (or after its current day, if that is later).
--
-- Changes: gift_vouchers gains enhancement_ids, enhancement_names, enhancements_gbp, terms_accepted_at, and travel_choice 'upto'.
-- buy_gift_voucher gains p_travel_cover, p_enhancement_ids, p_terms (the 14-argument one is dropped). get_gift_options lists the extras.
-- get_gift_voucher and check_gift_code return the extras. New gift_extras_cover; quote_gift_booking and finalize_client_booking (from
-- 20261214100000_gift_vouchers.sql) add it. The late fee base leaves out gift_covered_gbp in late_fee callers: admin_late_fee_preview
-- (20261011100000), apply_booking_cancellation (20261204100000), change_fee_gbp and get_my_change_terms (20261017100000), client_cancel_booking
-- (20261012100000). client_reschedule_booking (20261017100000) and gift_voucher_back (20261214100000) gain the gift rules.
-- Safe to run again: every function is create or replace, columns use if not exists.
--
-- Undo: put back the functions from the migrations named above, drop the 17-argument buy_gift_voucher and gift_extras_cover, recreate the
-- 14-argument buy_gift_voucher from 20261214100000_gift_vouchers.sql, and drop the four new columns.

-- ---------------------------------------------------------------------------------------------
-- 1. The voucher keeps its extras, the buyer's tick, and 'upto' as a travel choice
-- ---------------------------------------------------------------------------------------------
alter table public.gift_vouchers add column if not exists enhancement_ids uuid[] not null default '{}';
alter table public.gift_vouchers add column if not exists enhancement_names text[] not null default '{}';
alter table public.gift_vouchers add column if not exists enhancements_gbp numeric(10,2) not null default 0;
alter table public.gift_vouchers add column if not exists terms_accepted_at timestamptz;
alter table public.gift_vouchers drop constraint if exists gift_vouchers_travel_choice_valid;
alter table public.gift_vouchers add constraint gift_vouchers_travel_choice_valid check (travel_choice in ('area', 'all', 'none', 'upto'));
alter table public.gift_vouchers drop constraint if exists gift_vouchers_enhancements_valid;
alter table public.gift_vouchers add constraint gift_vouchers_enhancements_valid check (enhancements_gbp >= 0);

-- ---------------------------------------------------------------------------------------------
-- 2. The buying page also lists the extras
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_gift_options()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'on', public.gift_setting_on(),
    'months', public.gift_months(),
    'all_areas_cover', public.gift_all_areas_cover(),
    'lengths', coalesce((select jsonb_agg(jsonb_build_object('minutes', m, 'price', public.gift_massage_price(m)) order by m)
                 from (select distinct p.duration_minutes m from public.services s join public.service_duration_prices p on p.service_id = s.id
                        where s.active and p.active) d where public.gift_massage_price(m) is not null), '[]'::jsonb),
    'areas', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
                 'travel', coalesce(a.travel_surcharge_gbp, 0), 'congestion', coalesce(a.congestion_fee_gbp, 0)) order by a.display_order, a.name)
                 from public.service_areas a where a.active), '[]'::jsonb),
    'enhancements', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'description', e.description, 'price', e.price_gbp)
                 order by e.display_order, e.name) from public.enhancements e where e.active), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Buying: the 'upto' cards, the extras and the terms tick
-- ---------------------------------------------------------------------------------------------
drop function if exists public.buy_gift_voucher(integer, integer, text, uuid, text, text, text, text, text, text, timestamptz, text, text, text);
create or replace function public.buy_gift_voucher(
  p_minutes integer, p_people integer, p_travel_choice text, p_service_area_id uuid, p_design text,
  p_recipient_name text, p_from_name text, p_message text, p_delivery text, p_recipient_email text, p_send_at timestamptz,
  p_buyer_name text, p_buyer_email text, p_buyer_phone text,
  p_travel_cover numeric default null, p_enhancement_ids uuid[] default '{}'::uuid[], p_terms boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_price numeric(10,2);
  v_cover numeric(10,2) := 0;
  v_area public.service_areas%rowtype;
  v_code text;
  v public.gift_vouchers%rowtype;
  v_email text := lower(nullif(btrim(coalesce(p_buyer_email, '')), ''));
  v_to_email text := lower(nullif(btrim(coalesce(p_recipient_email, '')), ''));
  v_bank text := public.gift_bank_text();
  v_ids uuid[] := '{}';
  v_names text[] := '{}';
  v_extras numeric(10,2) := 0;
  v_wanted uuid[] := array(select distinct x from unnest(coalesce(p_enhancement_ids, '{}'::uuid[])) x where x is not null);
begin
  if not public.gift_setting_on() then
    raise exception 'Gift vouchers are not on sale right now. Please message Vadim.' using errcode = '22023';
  end if;
  if p_people not in (1, 2) then raise exception 'A voucher is for one or two people.' using errcode = '22023'; end if;
  v_price := public.gift_massage_price(p_minutes);
  if v_price is null then raise exception '%', format('There is no %s-minute massage to give. Please choose another length.', p_minutes) using errcode = '22023'; end if;
  if not coalesce(p_terms, false) then raise exception 'Please tick the box to say you understand the voucher terms.' using errcode = '22023'; end if;
  if p_travel_choice not in ('area', 'all', 'none', 'upto') then raise exception 'Choose where they live.' using errcode = '22023'; end if;
  if p_travel_choice = 'area' then
    select * into v_area from public.service_areas a where a.id = p_service_area_id and a.active;
    if not found then raise exception 'Please choose their area again.' using errcode = '22023'; end if;
    v_cover := coalesce(v_area.travel_surcharge_gbp, 0) + coalesce(v_area.congestion_fee_gbp, 0);
  elsif p_travel_choice = 'all' then
    v_cover := public.gift_all_areas_cover();
  elsif p_travel_choice = 'upto' then
    -- One of the cards between "Just the massage" and "Everything included": the charge of some area, below the highest.
    if p_travel_cover is null or p_travel_cover <= 0 or p_travel_cover >= public.gift_all_areas_cover()
       or not exists (select 1 from public.service_areas a where a.active and coalesce(a.travel_surcharge_gbp, 0) + coalesce(a.congestion_fee_gbp, 0) = p_travel_cover) then
      raise exception 'Please choose where they live again.' using errcode = '22023';
    end if;
    v_cover := p_travel_cover;
  end if;
  -- The extras, at today's prices, for each person.
  select coalesce(array_agg(e.id order by e.display_order, e.name), '{}'), coalesce(array_agg(e.name order by e.display_order, e.name), '{}'), coalesce(sum(e.price_gbp), 0)
    into v_ids, v_names, v_extras
    from public.enhancements e where e.active and e.id = any(v_wanted);
  if cardinality(v_ids) <> cardinality(v_wanted) then raise exception 'Please choose the extras again.' using errcode = '22023'; end if;
  v_extras := v_extras * p_people;
  if nullif(btrim(coalesce(p_recipient_name, '')), '') is null then raise exception 'Who is the voucher for?' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_from_name, '')), '') is null then raise exception 'Who is it from?' using errcode = '22023'; end if;
  if length(btrim(p_recipient_name)) > 60 or length(btrim(p_from_name)) > 60 then raise exception 'Please make the names shorter.' using errcode = '22023'; end if;
  if length(coalesce(p_message, '')) > 400 then raise exception 'Please make the message shorter (400 letters at most).' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_buyer_name, '')), '') is null then raise exception 'Please add your name.' using errcode = '22023'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please add your email, so I can send you the voucher.' using errcode = '22023'; end if;
  if coalesce(p_delivery, 'self') not in ('self', 'email') then raise exception 'Choose how the voucher should arrive.' using errcode = '22023'; end if;
  if p_delivery = 'email' then
    if v_to_email is null or v_to_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please add their email, so the voucher can reach them.' using errcode = '22023'; end if;
    if p_send_at is null then raise exception 'Choose the day it should arrive.' using errcode = '22023'; end if;
    if p_send_at > clock_timestamp() + interval '1 year' then raise exception 'Please choose a day within the next year.' using errcode = '22023'; end if;
  end if;
  -- A few at a time from one email, and not a flood from everyone: a voucher waiting for payment is only a request.
  if (select count(*) from public.gift_vouchers g where g.buyer_email = v_email and g.status = 'awaiting_payment' and g.created_at > clock_timestamp() - interval '1 day') >= 5
     or (select count(*) from public.gift_vouchers g where g.status = 'awaiting_payment' and g.created_at > clock_timestamp() - interval '1 hour') >= 40 then
    raise exception 'There are already several vouchers waiting for payment. Please message Vadim and he will help.' using errcode = '22023';
  end if;

  v_code := public.new_gift_code();
  insert into public.gift_vouchers(code, payment_reference, minutes, people, massage_price_gbp, travel_cover_gbp, travel_choice, service_area_id,
    service_area_name, price_gbp, recipient_name, from_name, message, design, delivery, recipient_email, send_at, buyer_name, buyer_email, buyer_phone,
    enhancement_ids, enhancement_names, enhancements_gbp, terms_accepted_at)
  values (v_code, 'GIFT-' || left(public.new_gift_code(), 5), p_minutes, p_people, v_price, v_cover, p_travel_choice, v_area.id, v_area.name,
    v_price * p_people + v_cover + v_extras, btrim(p_recipient_name), btrim(p_from_name), nullif(btrim(coalesce(p_message, '')), ''),
    coalesce(p_design, 'christmas_night'), coalesce(p_delivery, 'self'), case when p_delivery = 'email' then v_to_email end,
    case when p_delivery = 'email' then p_send_at end, btrim(p_buyer_name), v_email, nullif(btrim(coalesce(p_buyer_phone, '')), ''),
    v_ids, v_names, v_extras, clock_timestamp())
  returning * into v;

  perform public.gift_notify(v, 'bought',
    format('New gift voucher: %s by bank transfer', public.notification_money(v.price_gbp)),
    format('%s is buying %s for %s. Reference %s.', v.buyer_name, public.gift_words(v.minutes, v.people), v.recipient_name, v.payment_reference)
      || E'\n' || 'Mark it paid in More › Gift vouchers when the money arrives.',
    v.buyer_email,
    'Your gift voucher: one last step',
    format('Thank you, %s! To finish, please transfer %s', split_part(btrim(v.buyer_name), ' ', 1), public.notification_money(v.price_gbp))
      || case when v_bank is not null then E':\n\n' || v_bank || E'\nReference: ' || v.payment_reference else format(' with the reference %s.', v.payment_reference) end
      || E'\n\n' || format('As soon as it arrives I will send you the voucher for %s.', v.recipient_name),
    null, 'gift.bought:' || v.id::text);

  return jsonb_build_object('token', v.buyer_token, 'reference', v.payment_reference, 'amount', v.price_gbp,
    'bank', (select value from public.business_settings where key = 'bank_details'));
end; $$;
revoke all on function public.buy_gift_voucher(integer, integer, text, uuid, text, text, text, text, text, text, timestamptz, text, text, text, numeric, uuid[], boolean) from public;
grant execute on function public.buy_gift_voucher(integer, integer, text, uuid, text, text, text, text, text, text, timestamptz, text, text, text, numeric, uuid[], boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. The voucher page and the booking's code check name the extras (and the booking picks them)
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_gift_voucher(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'code', public.gift_code_shown(g.code),
    'state', case when g.status = 'ready' and g.expires_at <= clock_timestamp() then 'expired'
                  when g.status = 'awaiting_payment' then 'waiting' else g.status end,
    'minutes', g.minutes, 'people', g.people, 'recipient_name', g.recipient_name, 'from_name', g.from_name, 'message', g.message,
    'design', g.design, 'travel_choice', g.travel_choice, 'travel_cover', g.travel_cover_gbp, 'area_name', g.service_area_name,
    'expires_at', g.expires_at, 'delivery', g.delivery, 'extras', to_jsonb(g.enhancement_names))
  from public.gift_vouchers g where g.code = public.gift_code_clean(p_code) and g.status <> 'cancelled';
$$;
create or replace function public.check_gift_code(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  v := public.usable_gift_voucher(p_code, null);
  return jsonb_build_object('code', public.gift_code_shown(v.code), 'minutes', v.minutes, 'people', v.people, 'from_name', v.from_name,
    'recipient_name', v.recipient_name, 'travel_cover', v.travel_cover_gbp, 'travel_choice', v.travel_choice, 'area_name', v.service_area_name,
    'expires_at', v.expires_at, 'enhancement_ids', to_jsonb(v.enhancement_ids), 'extras', to_jsonb(v.enhancement_names));
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 5. What a voucher pays for the extras it was bought with: those chosen for the booking, at today's prices, never more than was paid
-- ---------------------------------------------------------------------------------------------
create or replace function public.gift_extras_cover(v public.gift_vouchers, p_enhancement_ids uuid[], p_enhancements_total numeric)
returns numeric language sql stable set search_path = '' as $$
  select least(coalesce(v.enhancements_gbp, 0), coalesce(p_enhancements_total, 0),
    coalesce((select sum(e.price_gbp) from public.enhancements e where e.id = any(coalesce(v.enhancement_ids, '{}')) and e.id = any(coalesce(p_enhancement_ids, '{}'))), 0) * v.people);
$$;
revoke all on function public.gift_extras_cover(public.gift_vouchers, uuid[], numeric) from public, anon, authenticated;

create or replace function public.quote_gift_booking(p_gift_code text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[] default '{}'::uuid[])
returns table(service_area_name text, primary_service_id uuid, treatment_duration_minutes integer, service_subtotal_gbp numeric, enhancements_total_gbp numeric,
  travel_fee_gbp numeric, congestion_fee_gbp numeric, total_gbp numeric, gift_covered_gbp numeric, to_pay_gbp numeric)
language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; q record; v_cover numeric(10,2);
begin
  v := public.usable_gift_voucher(p_gift_code, p_sessions);
  select * into q from public.compute_client_booking_quote(p_service_area_id, p_sessions, coalesce(p_enhancement_ids, '{}'::uuid[]));
  v_cover := least(q.total_gbp, public.gift_cover_for(v, p_sessions, q.travel_fee_gbp, q.congestion_fee_gbp)
    + public.gift_extras_cover(v, coalesce(p_enhancement_ids, '{}'::uuid[]), q.enhancements_total_gbp));
  return query select q.service_area_name, q.primary_service_id, q.treatment_duration_minutes, q.service_subtotal_gbp, q.enhancements_total_gbp,
    q.travel_fee_gbp, q.congestion_fee_gbp, q.total_gbp, v_cover, (q.total_gbp - v_cover)::numeric(10,2);
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Booking with a voucher: it also pays its extras (20261214100000's finalize_client_booking, with that one line changed)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_client_booking(p_hold_id uuid, p_hold_token uuid, p_hold_client_key text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[], p_saved_address_id uuid, p_address_line_1 text, p_address_line_2 text, p_city text, p_postcode text, p_entry_instructions text, p_client_note text, p_payment_method text, p_idempotency_key text, p_address text DEFAULT NULL::text, p_offer_code text DEFAULT NULL::text, p_gift_code text DEFAULT NULL::text)
 RETURNS TABLE(booking_id uuid, booking_reference text, booking_status text, payment_status text, total_gbp numeric, payment_reference text, saved_address_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := now();
  v_london_today date := (now() at time zone 'Europe/London')::date;
  v_london_now_minutes integer := (
    extract(hour from now() at time zone 'Europe/London')::integer * 60
    + extract(minute from now() at time zone 'Europe/London')::integer
  );
  v_user_id uuid := auth.uid();
  v_client public.clients%rowtype;
  v_hold public.booking_holds%rowtype;
  v_address public.client_addresses%rowtype;
  v_quote record;
  v_command public.command_requests%rowtype;
  v_command_id uuid;
  v_event_id uuid;
  v_scope text;
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text;
  v_enhancement_ids uuid[] := coalesce(p_enhancement_ids, '{}'::uuid[]);
  v_sorted_enhancement_ids text;
  v_booking_id uuid;
  v_booking_reference text;
  v_booking_status text;
  v_payment_status text;
  v_payment_reference text;
  v_is_returning boolean := false;
  v_active_future_count integer := 0;
  v_is_default_address boolean := false;
  v_address_text text;
  v_session jsonb;
  v_session_id uuid;
  v_service_id uuid;
  v_duration integer;
  v_recipient_name text;
  v_position integer := 0;
  v_unit_price numeric(10,2);
  v_service_name text;
  v_preference_ids uuid[];
  v_preference_count integer;
  v_enhancement_id uuid;
  v_enhancement public.enhancements%rowtype;
  -- A special-price offer (Vadim's link for one free time), or none.
  v_offer public.slot_offers%rowtype;
  v_offer_code text := upper(nullif(btrim(coalesce(p_offer_code, '')), ''));
  -- A gift voucher (20261214100000): what it pays and what is left to pay.
  v_gift public.gift_vouchers%rowtype;
  v_gift_code text := public.gift_code_clean(p_gift_code);
  v_gift_covered numeric(10,2) := 0;
  v_to_pay numeric(10,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if public.is_booking_admin() then
    raise exception 'Admin accounts must use the Admin booking contract'
      using errcode = '42501';
  end if;

  select c.*
  into v_client
  from public.clients c
  where c.auth_user_id = v_user_id
  for update;

  if not found then
    raise exception 'Client account is not activated'
      using errcode = '42501';
  end if;

  if not v_client.online_booking_enabled then
    raise exception 'Online booking is disabled for this client'
      using errcode = '42501';
  end if;

  if length(v_idempotency_key) < 8 or length(v_idempotency_key) > 200 then
    raise exception 'A valid idempotency key is required'
      using errcode = '22023';
  end if;

  if p_payment_method not in ('bank_transfer', 'cash') then
    raise exception 'Payment method must be bank_transfer or cash'
      using errcode = '22023';
  end if;

  if p_hold_id is null
     or p_hold_token is null
     or btrim(coalesce(p_hold_client_key, '')) = '' then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  select string_agg(e_id::text, ',' order by e_id::text)
  into v_sorted_enhancement_ids
  from unnest(v_enhancement_ids) e_id;

  v_scope := 'client-finalize:' || v_client.id::text;
  v_fingerprint := md5(concat_ws(
    '|',
    p_hold_id::text,
    p_hold_token::text,
    btrim(p_hold_client_key),
    p_service_area_id::text,
    p_sessions::text,
    coalesce(v_sorted_enhancement_ids, ''),
    coalesce(p_saved_address_id::text, ''),
    coalesce(btrim(p_address_line_1), ''),
    coalesce(btrim(p_address_line_2), ''),
    coalesce(btrim(p_city), ''),
    coalesce(upper(btrim(p_postcode)), ''),
    coalesce(btrim(p_entry_instructions), ''),
    coalesce(btrim(p_client_note), ''),
    p_payment_method,
    btrim(p_address),
    coalesce(v_offer_code, ''),
    coalesce(v_gift_code, '')
  ));

  perform pg_advisory_xact_lock(
    hashtext(v_scope || ':' || v_idempotency_key)
  );

  select cr.*
  into v_command
  from public.command_requests cr
  where cr.scope = v_scope
    and cr.idempotency_key = v_idempotency_key
  for update;

  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Idempotency key was already used for a different request'
        using errcode = '22023';
    end if;

    if v_command.status = 'succeeded' and v_command.result_reference is not null then
      return query
      select
        b.id,
        b.booking_reference,
        b.booking_status,
        bp.status,
        bp.amount_gbp,
        bp.payment_reference,
        b.saved_address_id
      from public.bookings b
      join public.booking_payments bp on bp.booking_id = b.id
      where b.id = v_command.result_reference::uuid;
      return;
    end if;

    raise exception 'Booking request is already in progress'
      using errcode = '40001';
  end if;

  select *
  into v_quote
  from public.compute_client_booking_quote(
    p_service_area_id,
    p_sessions,
    v_enhancement_ids
  );

  -- Match hold creation lock order: browser key first, then business date.
  perform pg_advisory_xact_lock(
    hashtext('booking-hold-client:' || btrim(p_hold_client_key))
  );

  select h.*
  into v_hold
  from public.booking_holds h
  where h.id = p_hold_id;

  if not found then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  perform pg_advisory_xact_lock(42420, hashtext(v_hold.date::text));

  select h.*
  into v_hold
  from public.booking_holds h
  where h.id = p_hold_id
  for update;

  if not found
     or v_hold.hold_token <> p_hold_token
     or v_hold.client_key is distinct from btrim(p_hold_client_key)
     or v_hold.status <> 'active'
     or v_hold.expires_at <= v_now
     or v_hold.treatment_duration_minutes <> v_quote.treatment_duration_minutes
     or v_hold.travel_buffer_minutes <> 60 then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  -- A special-price offer: the hold was made from the offer's link, and the offer is still open. Its price is the whole price (no travel fee,
  -- congestion charge or extras), for one person at the offer's length. A hold made from an offer can only be booked with it.
  if v_offer_code is not null or v_hold.slot_offer_id is not null then
    select o.* into v_offer from public.slot_offers o where o.id = v_hold.slot_offer_id for update;
    if not found or v_offer_code is null or v_offer.code <> v_offer_code then
      raise exception 'Time slot is no longer available'
        using errcode = '23P01';
    end if;
    if v_offer.status <> 'open' or v_offer.closes_at <= v_now then
      raise exception 'Sorry, this special time is no longer available.'
        using errcode = '23P01';
    end if;
    if jsonb_array_length(p_sessions) <> 1 or cardinality(v_enhancement_ids) > 0
       or v_offer.duration_minutes <> v_quote.treatment_duration_minutes
       or v_offer.date <> v_hold.date or v_offer.start_minutes <> v_hold.start_minutes then
      raise exception '%', format('This special price is for one person, %s minutes, with no extras.', v_offer.duration_minutes)
        using errcode = '22023';
    end if;
    v_quote.service_subtotal_gbp := v_offer.price_gbp;
    v_quote.enhancements_total_gbp := 0;
    -- The travel fee and congestion charge of the client's area are added only when Vadim ticked "Add travel fee" (20261210100000).
    if not v_offer.add_travel_fee then
      v_quote.travel_fee_gbp := 0;
      v_quote.congestion_fee_gbp := 0;
    end if;
    v_quote.total_gbp := v_offer.price_gbp + coalesce(v_quote.travel_fee_gbp, 0) + coalesce(v_quote.congestion_fee_gbp, 0);
  end if;

  -- A gift voucher pays one massage of its length for each of its people, and the travel fee and congestion charge up to what it covers.
  if v_gift_code is not null then
    if v_offer.id is not null then
      raise exception 'A gift voucher can''t be used with a special price.' using errcode = '22023';
    end if;
    v_gift := public.usable_gift_voucher(v_gift_code, p_sessions, true);
    v_gift_covered := least(v_quote.total_gbp, public.gift_cover_for(v_gift, p_sessions, v_quote.travel_fee_gbp, v_quote.congestion_fee_gbp)
      + public.gift_extras_cover(v_gift, v_enhancement_ids, v_quote.enhancements_total_gbp));
  end if;
  v_to_pay := v_quote.total_gbp - v_gift_covered;

  if v_hold.date < v_london_today then
    raise exception 'Booking date cannot be in the past'
      using errcode = '22023';
  end if;

  if v_hold.date > v_london_today + public.business_setting_int('booking_horizon_days', 40) then
    raise exception '%', format('Online appointments can currently be arranged up to %s days ahead. Please choose an earlier date.', public.business_setting_int('booking_horizon_days', 40))
      using errcode = '22023';
  end if;

  -- An offer has its own closing time (checked above) instead of the usual notice.
  if v_offer.id is null and ((v_hold.date + make_interval(mins => v_hold.start_minutes)) at time zone 'Europe/London') < clock_timestamp() + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120)) then
    raise exception '%', format('Online appointments need at least %s notice. Please choose a later time.', public.notice_text(public.business_setting_int('minimum_notice_minutes', 120)))
      using errcode = '23P01';
  end if;

  -- Serialize client booking-limit decisions.
  perform pg_advisory_xact_lock(
    hashtext('client-booking-limit:' || v_client.id::text)
  );

  -- A returning client has had a paid visit. Vadim rarely presses Complete, so a confirmed visit
  -- whose time has passed counts too (client_has_paid_visit, 20261212100000).
  v_is_returning := public.client_has_paid_visit(v_client.id);

  select count(*)::integer
  into v_active_future_count
  from public.bookings b
  join public.booking_payments bp on bp.booking_id = b.id
  where b.client_id = v_client.id
    and b.booking_status in (
      'awaiting_transfer',
      'awaiting_payment_verification',
      'awaiting_cash_approval',
      'confirmed'
    )
    and bp.status not in ('rejected', 'refunded')
    and (
      b.date > v_london_today
      or (
        b.date = v_london_today
        and b.start_minutes > v_london_now_minutes
      )
    );

  if not v_is_returning and v_active_future_count >= public.business_setting_int('new_client_booking_limit', 1) then
    raise exception 'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.'
      using errcode = '22023';
  end if;

  if v_is_returning and v_active_future_count >= public.business_setting_int('returning_client_booking_limit', 5) then
    raise exception '%', format('You already have %s upcoming appointments. Please manage one of those appointments before adding another.', public.count_word(public.business_setting_int('returning_client_booking_limit', 5)))
      using errcode = '22023';
  end if;

  -- Exclude the caller's own hold from the shared availability calculation.
  -- Any later error rolls this update back with the rest of the transaction.
  update public.booking_holds h
  set
    status = 'consumed',
    client_id = v_client.id
  where h.id = v_hold.id;

  -- An offer's time is one Vadim chose himself, so it need not be one of the usual times: it must only not overlap another appointment.
  if v_offer.id is not null then
    if public.admin_time_clash(v_hold.date, v_hold.start_minutes, v_hold.treatment_duration_minutes, v_now) then
      raise exception 'Sorry, this special time is no longer available.'
        using errcode = '23P01';
    end if;
  elsif not exists (
    select 1
    from public.compute_booking_availability(
      v_hold.date,
      v_hold.treatment_duration_minutes,
      v_now,
      v_hold.travel_buffer_minutes
    ) a
    where a.start_minutes = v_hold.start_minutes
  ) then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  if p_saved_address_id is not null then
    select a.*
    into v_address
    from public.client_addresses a
    where a.id = p_saved_address_id
      and a.client_id = v_client.id
    for update;

    if not found then
      raise exception 'Saved address is not available to this client'
        using errcode = '42501';
    end if;
  else
    -- The address as one text (the new screens), or put together from its parts (the old ones).
    v_address_text := public.clean_address(coalesce(p_address, concat_ws(', ', nullif(btrim(p_address_line_1), ''), nullif(btrim(p_address_line_2), ''),
      nullif(btrim(p_city), ''), upper(nullif(btrim(p_postcode), '')))));
    if p_address is not null then
      if v_address_text is null then
        raise exception 'A complete booking address is required'
          using errcode = '22023';
      end if;
    elsif nullif(btrim(p_address_line_1), '') is null
       or nullif(btrim(p_city), '') is null
       or nullif(btrim(p_postcode), '') is null then
      raise exception 'A complete booking address is required'
        using errcode = '22023';
    end if;
    if length(v_address_text) > 400 then
      raise exception 'That address is too long'
        using errcode = '22023';
    end if;

    select a.*
    into v_address
    from public.client_addresses a
    where a.client_id = v_client.id
      and a.normalized_address = lower(regexp_replace(v_address_text, '[^a-zA-Z0-9]+', '', 'g'))
    order by a.is_default desc, a.created_at
    limit 1;

    if not found then
      select not exists (
        select 1
        from public.client_addresses existing
        where existing.client_id = v_client.id
      )
      into v_is_default_address;

      insert into public.client_addresses (
        client_id,
        label,
        address,
        address_line_1,
        address_line_2,
        city,
        postcode,
        normalized_postcode,
        entry_instructions,
        is_default
      )
      values (
        v_client.id,
        case when v_is_default_address then 'Home' else 'Saved address' end,
        v_address_text,
        case when p_address is null then btrim(p_address_line_1) end,
        case when p_address is null then nullif(btrim(p_address_line_2), '') end,
        case when p_address is null then btrim(p_city) end,
        case when p_address is null then upper(btrim(p_postcode)) end,
        case when p_address is null then regexp_replace(upper(btrim(p_postcode)), '[^A-Z0-9]+', '', 'g') end,
        nullif(btrim(p_entry_instructions), ''),
        v_is_default_address
      )
      returning * into v_address;
    end if;
  end if;

  insert into public.command_requests (
    scope,
    idempotency_key,
    source_channel,
    actor_type,
    actor_id,
    command_type,
    request_fingerprint,
    status
  )
  values (
    v_scope,
    v_idempotency_key,
    'web',
    'client',
    v_user_id::text,
    'finalize_client_booking',
    v_fingerprint,
    'started'
  )
  returning id into v_command_id;

  v_booking_id := gen_random_uuid();
  v_booking_reference :=
    'VDM-'
    || to_char(v_now at time zone 'UTC', 'YYYYMMDDHH24MISS')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  if v_gift.id is not null and v_to_pay = 0 then
    -- Fully paid by the voucher: booked straight away, nothing to pay.
    v_booking_status := 'confirmed';
    v_payment_status := 'paid';
  elsif p_payment_method = 'bank_transfer' then
    v_booking_status := 'awaiting_transfer';
    v_payment_status := 'awaiting_transfer';
  else
    v_booking_status := 'awaiting_cash_approval';
    v_payment_status := 'awaiting_approval';
  end if;

  v_payment_reference := v_booking_reference;

  insert into public.bookings (
    id,
    booking_reference,
    client_id,
    saved_address_id,
    service_area_id,
    date,
    start_minutes,
    treatment_duration_minutes,
    travel_buffer_minutes,
    booking_status,
    source_channel,
    created_by_actor_type,
    created_by_actor_id,
    address_line_1_snapshot,
    address_line_2_snapshot,
    city_snapshot,
    postcode_snapshot,
    address_snapshot,
    entry_instructions_snapshot,
    service_area_name_snapshot,
    service_subtotal_gbp,
    enhancements_total_gbp,
    travel_fee_gbp,
    congestion_fee_gbp,
    total_gbp,
    booking_email_snapshot,
    payment_reservation_expires_at,
    client_note,
    slot_offer_id,
    gift_voucher_id,
    gift_covered_gbp
  )
  values (
    v_booking_id,
    v_booking_reference,
    v_client.id,
    v_address.id,
    p_service_area_id,
    v_hold.date,
    v_hold.start_minutes,
    v_quote.treatment_duration_minutes,
    v_hold.travel_buffer_minutes,
    v_booking_status,
    'web',
    'client',
    v_user_id::text,
    v_address.address_line_1,
    v_address.address_line_2,
    v_address.city,
    v_address.postcode,
    v_address.address,
    v_address.entry_instructions,
    v_quote.service_area_name,
    v_quote.service_subtotal_gbp,
    v_quote.enhancements_total_gbp,
    v_quote.travel_fee_gbp,
    v_quote.congestion_fee_gbp,
    v_quote.total_gbp,
    v_client.email,
    null,
    nullif(btrim(p_client_note), ''),
    v_offer.id,
    v_gift.id,
    v_gift_covered
  );

  if v_gift.id is not null then
    update public.gift_vouchers g set status = 'used', booking_id = v_booking_id, used_at = v_now where g.id = v_gift.id;
  end if;

  if v_offer.id is not null then
    update public.slot_offers o set status = 'booked', booking_id = v_booking_id, updated_at = v_now where o.id = v_offer.id;
  end if;

  for v_session in
    select value
    from jsonb_array_elements(p_sessions)
  loop
    v_position := v_position + 1;
    v_service_id := (v_session ->> 'service_id')::uuid;
    v_duration := (v_session ->> 'duration_minutes')::integer;
    v_recipient_name := nullif(btrim(v_session ->> 'recipient_name'), '');

    if v_recipient_name is not null and length(v_recipient_name) > 120 then
      raise exception 'Session recipient name is too long'
        using errcode = '22023';
    end if;

    select s.name, p.price_gbp
    into v_service_name, v_unit_price
    from public.services s
    join public.service_duration_prices p
      on p.service_id = s.id
    where s.id = v_service_id
      and s.active
      and p.duration_minutes = v_duration
      and p.active;

    if v_offer.id is not null then
      v_unit_price := v_offer.price_gbp;
    end if;

    insert into public.booking_sessions (
      booking_id,
      position,
      service_id,
      duration_minutes,
      service_name_snapshot,
      unit_price_gbp,
      recipient_name
    )
    values (
      v_booking_id,
      v_position,
      v_service_id,
      v_duration,
      v_service_name,
      v_unit_price,
      v_recipient_name
    )
    returning id into v_session_id;

    if v_session ? 'preference_ids' then
      if jsonb_typeof(v_session -> 'preference_ids') <> 'array' then
        raise exception 'Session preferences must be an array'
          using errcode = '22023';
      end if;

      select coalesce(array_agg(pref_id), '{}'::uuid[])
      into v_preference_ids
      from (
        select value::uuid as pref_id
        from jsonb_array_elements_text(v_session -> 'preference_ids')
      ) pref;

      select count(distinct pref_id)::integer
      into v_preference_count
      from unnest(v_preference_ids) pref_id;

      if v_preference_count <> cardinality(v_preference_ids) then
        raise exception 'Session preference selection contains duplicates'
          using errcode = '22023';
      end if;

      if (
        select count(*)::integer
        from public.session_preferences sp
        where sp.id = any(v_preference_ids)
          and sp.active
      ) <> cardinality(v_preference_ids) then
        raise exception 'Selected session preference is no longer available'
          using errcode = '22023';
      end if;

      if exists (
        select 1
        from public.session_preference_conflicts c
        where c.preference_id = any(v_preference_ids)
          and c.conflicting_preference_id = any(v_preference_ids)
      ) then
        raise exception 'Selected session preferences conflict'
          using errcode = '22023';
      end if;

      insert into public.booking_session_preferences (
        booking_session_id,
        preference_id,
        preference_label_snapshot,
        preference_category_snapshot
      )
      select
        v_session_id,
        sp.id,
        sp.label,
        sp.category
      from public.session_preferences sp
      where sp.id = any(v_preference_ids);
    end if;
  end loop;

  foreach v_enhancement_id in array v_enhancement_ids
  loop
    select e.*
    into v_enhancement
    from public.enhancements e
    where e.id = v_enhancement_id
      and e.active;

    insert into public.booking_enhancements (
      booking_id,
      enhancement_id,
      enhancement_name_snapshot,
      quantity,
      unit_price_gbp,
      duration_minutes_snapshot
    )
    values (
      v_booking_id,
      v_enhancement.id,
      v_enhancement.name,
      1,
      v_enhancement.price_gbp,
      0
    );
  end loop;

  insert into public.booking_payments (
    booking_id,
    method,
    status,
    amount_gbp,
    payment_reference,
    paid_at
  )
  values (
    v_booking_id,
    case when v_payment_status = 'paid' then 'bank_transfer' else p_payment_method end,
    v_payment_status,
    v_to_pay,
    v_payment_reference,
    case when v_payment_status = 'paid' then v_now end
  );

  insert into public.event_outbox (
    event_type,
    aggregate_type,
    aggregate_id,
    source_command_id,
    deduplication_key,
    payload
  )
  values (
    'booking.created',
    'booking',
    v_booking_id,
    v_command_id,
    'booking.created:' || v_booking_id::text,
    jsonb_build_object(
      'booking_id', v_booking_id,
      'booking_reference', v_booking_reference,
      'client_id', v_client.id,
      'booking_status', v_booking_status,
      'payment_status', v_payment_status,
      'date', v_hold.date,
      'start_minutes', v_hold.start_minutes,
      'total_gbp', v_quote.total_gbp,
      'gift_voucher_id', v_gift.id,
      'gift_covered_gbp', v_gift_covered,
      'to_pay_gbp', v_to_pay
    )
  )
  returning id into v_event_id;

  if v_gift.id is not null then
    perform public.gift_booking_messages(v_event_id, v_booking_id, v_gift, v_to_pay);
  end if;

  update public.command_requests cr
  set
    status = 'succeeded',
    result_reference = v_booking_id::text,
    completed_at = v_now
  where cr.id = v_command_id;

  return query
  select
    v_booking_id,
    v_booking_reference,
    v_booking_status,
    v_payment_status,
    v_to_pay::numeric(10,2),
    v_payment_reference,
    v_address.id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 7. The late fee is only ever on what the client paid themselves, never on what a gift voucher paid
-- ---------------------------------------------------------------------------------------------
-- admin_late_fee_preview (from 20261011100000_booking_lifecycle.sql)
create or replace function public.admin_late_fee_preview(p_booking_id uuid, p_initiated_by text)
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
  return public.late_fee_standard_gbp(b.total_gbp - coalesce(b.gift_covered_gbp, 0), b.date, b.start_minutes, b.created_at, clock_timestamp());
end;
$$;

-- apply_booking_cancellation (from 20261204100000_edit_booking_services.sql)
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
    else public.late_fee_standard_gbp(b.total_gbp - coalesce(b.gift_covered_gbp, 0), b.date, b.start_minutes, b.created_at, p_now) end;
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

-- change_fee_gbp (from 20261017100000_booking_rules_settings.sql)
CREATE OR REPLACE FUNCTION public.change_fee_gbp(b bookings, p_initiated_by text, p_now timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case
    when p_initiated_by = 'admin' then 0::numeric
    when b.late_fee_status <> 'none' then 0::numeric
    else public.late_fee_standard_gbp(b.total_gbp - coalesce(b.gift_covered_gbp, 0), b.date, b.start_minutes, b.created_at, p_now)
  end;
$function$;

-- client_cancel_booking (from 20261012100000_client_self_service.sql)
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
  v_fee := public.late_fee_standard_gbp(b.total_gbp - coalesce(b.gift_covered_gbp, 0), b.date, b.start_minutes, b.created_at, v_now);
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

-- get_my_change_terms (from 20261017100000_booking_rules_settings.sql)
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
    'cancel_fee_gbp', case when v_open then public.late_fee_standard_gbp(b.total_gbp - coalesce(b.gift_covered_gbp, 0), b.date, b.start_minutes, b.created_at, v_now) else 0 end,
    'reschedule_fee_gbp', case when v_open then public.change_fee_gbp(b, 'client', v_now) else 0 end,
    'total_gbp', b.total_gbp,
    -- A gift booking inside the free-cancellation hours: cancelling uses the voucher up, and it can't be moved online.
    'gift', b.gift_voucher_id is not null,
    'gift_late', v_open and b.gift_voucher_id is not null and public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now) > 0,
    'gift_ends', (select g.expires_at from public.gift_vouchers g where g.id = b.gift_voucher_id));
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. Moving a gift booking online (20261017100000's client_reschedule_booking, with the gift checks added)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.client_reschedule_booking(p_booking_id uuid, p_request_id uuid, p_new_date date, p_new_start_minutes integer, p_acknowledged_fee numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if p_new_date < v_today or p_new_date > v_today + public.business_setting_int('booking_horizon_days', 40) then
    raise exception '%', format('Online appointments can currently be arranged up to %s days ahead. Please choose another date.', public.business_setting_int('booking_horizon_days', 40)) using errcode = '22023';
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
  -- A gift booking: not moved online inside the free-cancellation hours, nor to a day after its voucher ends (or after its current day, if later).
  if b.gift_voucher_id is not null then
    if public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now) > 0 then
      raise exception '%', format('Within %s hours of the appointment, a booking paid with a gift voucher can''t be moved online. Please message Vadim.',
        public.business_setting_int('free_cancellation_hours', 24)) using errcode = '22023';
    end if;
    if p_new_date > greatest(b.date, (select (g.expires_at at time zone 'Europe/London')::date from public.gift_vouchers g where g.id = b.gift_voucher_id)) then
      raise exception '%', format('Your gift voucher ends on %s, so please choose a day before then.',
        (select public.gift_london_date(g.expires_at) from public.gift_vouchers g where g.id = b.gift_voucher_id)) using errcode = '22023';
    end if;
  end if;
  if not exists (
    select 1 from public.compute_booking_availability(p_new_date, b.treatment_duration_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
    where a.start_minutes = p_new_start_minutes
  ) or ((p_new_date + make_interval(mins => p_new_start_minutes)) at time zone 'Europe/London') < v_now + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120)) then
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
$function$;

-- ---------------------------------------------------------------------------------------------
-- 9. A cancelled gift booking gives its voucher back, unless the client cancelled it inside the free-cancellation hours (then it is used up,
--    like a paid session; Vadim can give it back by hand). When the late fee is switched off, the voucher always comes back.
-- ---------------------------------------------------------------------------------------------
create or replace function public.gift_voucher_back()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.gift_voucher_id is not null and new.booking_status = 'cancelled' and old.booking_status is distinct from 'cancelled' then
    if new.cancellation_initiated_by = 'client'
       and public.late_fee_standard_gbp(new.total_gbp, new.date, new.start_minutes, new.created_at, coalesce(new.cancelled_at, clock_timestamp())) > 0 then
      return null;
    end if;
    update public.gift_vouchers g set status = 'ready', booking_id = null, used_at = null where g.id = new.gift_voucher_id and g.status = 'used' and g.booking_id = new.id;
  end if;
  return null;
end; $$;
revoke all on function public.gift_voucher_back() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 10. More › Gift vouchers: each booking's status, so Vadim can give back a voucher whose booking was cancelled late
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_gift_vouchers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_booking_admin();
  return coalesce((select jsonb_agg(to_jsonb(g) - 'buyer_token' || jsonb_build_object(
      'code_shown', public.gift_code_shown(g.code),
      'expired', g.status = 'ready' and g.expires_at <= clock_timestamp(),
      'booking', (select jsonb_build_object('id', b.id, 'date', b.date, 'start_minutes', b.start_minutes, 'status', b.booking_status,
                    'client_name', btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')))
                  from public.bookings b left join public.clients c on c.id = b.client_id where b.id = g.booking_id))
    order by case g.status when 'awaiting_payment' then 0 when 'ready' then 1 when 'used' then 2 else 3 end, g.created_at desc)
    from public.gift_vouchers g
    where g.status <> 'cancelled' or g.updated_at > clock_timestamp() - interval '30 days'), '[]'::jsonb);
end; $$;
