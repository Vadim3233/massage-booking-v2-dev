-- Offers of a free time (Vadim, 12 Nov 2026): Vadim can tick "Add travel fee", so a client in an area with a travel fee or congestion
-- charge pays it on top of the offer's price, as on the usual booking page. Unticked (the default, and every offer made before), the
-- offer's price stays all-in. Changes 20261207100000_special_price_offers.sql: the offer keeps the choice, the Admin sets it, the link and
-- the price on the review screen show it, and finalize_client_booking charges it.

alter table public.slot_offers add column add_travel_fee boolean not null default false;

drop function public.admin_create_slot_offer(date, integer, integer, numeric, timestamptz);
drop function public.admin_update_slot_offer(uuid, numeric, timestamptz);
drop function public.get_slot_offer(text, text);

create function public.admin_create_slot_offer(p_date date, p_start_minutes integer, p_duration_minutes integer, p_price_gbp numeric, p_closes_at timestamptz, p_add_travel_fee boolean default false)
returns public.slot_offers language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_starts timestamptz; v_offer public.slot_offers%rowtype; v_normal numeric(10,2);
begin
  perform public.require_booking_admin();
  if p_date is null or p_start_minutes is null or p_duration_minutes is null or p_price_gbp is null or p_closes_at is null then
    raise exception 'Choose the time, the length, the price and when it stops being offered.' using errcode = '22023';
  end if;
  if p_start_minutes not between 0 and 1439 or mod(p_start_minutes, 30) <> 0 or p_duration_minutes not between 30 and 240
     or mod(p_duration_minutes, 30) <> 0 or p_start_minutes + p_duration_minutes > 1440 then
    raise exception 'Choose a start on the hour or half hour, and a length that ends before midnight.' using errcode = '22023';
  end if;
  v_normal := public.normal_price_for(p_duration_minutes);
  if v_normal is null then
    raise exception '%', format('No treatment is offered at %s minutes. Choose another length.', p_duration_minutes) using errcode = '22023';
  end if;
  if p_price_gbp <= 0 or p_price_gbp >= 10000 or p_price_gbp <> round(p_price_gbp, 2) then
    raise exception 'Enter a price in pounds, for example 55.' using errcode = '22023';
  end if;
  v_starts := (p_date + make_interval(mins => p_start_minutes)) at time zone 'Europe/London';
  if v_starts <= v_now then raise exception 'That time has already started. Choose a later time.' using errcode = '22023'; end if;
  if p_closes_at <= v_now then raise exception 'The offer would already be closed. Choose a later closing time.' using errcode = '22023'; end if;
  if p_closes_at > v_starts then raise exception 'The offer must close by the time the appointment starts.' using errcode = '22023'; end if;
  -- The same date lock as every booking and hold.
  perform pg_advisory_xact_lock(42420, hashtext(p_date::text));
  if public.admin_time_clash(p_date, p_start_minutes, p_duration_minutes, v_now) then
    raise exception 'That time overlaps an appointment, or a client is booking it right now. Choose another time.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.slot_offers o where o.date = p_date and o.status = 'open' and o.closes_at > v_now
               and p_start_minutes < o.start_minutes + o.duration_minutes and o.start_minutes < p_start_minutes + p_duration_minutes) then
    raise exception 'There is already a special offer at that time. Tap it in the Calendar to change it.' using errcode = 'PT409';
  end if;
  insert into public.slot_offers (code, date, start_minutes, duration_minutes, price_gbp, normal_price_gbp, closes_at, add_travel_fee)
  values (public.new_offer_code(), p_date, p_start_minutes, p_duration_minutes, p_price_gbp, v_normal, p_closes_at, coalesce(p_add_travel_fee, false))
  returning * into v_offer;
  return v_offer;
end; $$;

create function public.admin_update_slot_offer(p_offer_id uuid, p_price_gbp numeric, p_closes_at timestamptz, p_add_travel_fee boolean default null)
returns public.slot_offers language plpgsql security definer set search_path = '' as $$
declare v_offer public.slot_offers%rowtype; v_now timestamptz := clock_timestamp(); v_starts timestamptz;
begin
  perform public.require_booking_admin();
  select * into v_offer from public.slot_offers where id = p_offer_id;
  if not found then raise exception 'That offer was not found.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_offer.date::text));
  select * into v_offer from public.slot_offers where id = p_offer_id for update;
  if v_offer.status <> 'open' then raise exception 'That offer has already been booked or stopped.' using errcode = 'PT409'; end if;
  if p_price_gbp is null or p_price_gbp <= 0 or p_price_gbp >= 10000 or p_price_gbp <> round(p_price_gbp, 2) then
    raise exception 'Enter a price in pounds, for example 55.' using errcode = '22023';
  end if;
  v_starts := (v_offer.date + make_interval(mins => v_offer.start_minutes)) at time zone 'Europe/London';
  if p_closes_at is null or p_closes_at <= v_now then raise exception 'The offer would already be closed. Choose a later closing time.' using errcode = '22023'; end if;
  if p_closes_at > v_starts then raise exception 'The offer must close by the time the appointment starts.' using errcode = '22023'; end if;
  update public.slot_offers set price_gbp = p_price_gbp, closes_at = p_closes_at, add_travel_fee = coalesce(p_add_travel_fee, add_travel_fee), updated_at = v_now where id = p_offer_id returning * into v_offer;
  return v_offer;
end; $$;

create function public.get_slot_offer(p_code text, p_client_key text default null)
returns table (state text, date date, start_minutes integer, duration_minutes integer, price_gbp numeric, normal_price_gbp numeric, closes_at timestamptz, add_travel_fee boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_offer public.slot_offers%rowtype; v_now timestamptz := clock_timestamp(); v_key text := btrim(coalesce(p_client_key, ''));
begin
  select * into v_offer from public.slot_offers o where o.code = upper(btrim(coalesce(p_code, '')));
  if not found then return query select 'missing'::text, null::date, null::integer, null::integer, null::numeric, null::numeric, null::timestamptz, null::boolean; return; end if;
  return query select
    case
      when v_offer.status = 'booked' then 'taken'
      when v_offer.status <> 'open' or v_offer.closes_at <= v_now then 'closed'
      when exists (select 1 from public.bookings b where b.date = v_offer.date
          and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed')
          and v_offer.start_minutes < b.start_minutes + b.treatment_duration_minutes and b.start_minutes < v_offer.start_minutes + v_offer.duration_minutes) then 'taken'
      when exists (select 1 from public.booking_holds h where h.date = v_offer.date and h.status = 'active' and h.expires_at > v_now
          and h.client_key is distinct from nullif(v_key, '')
          and v_offer.start_minutes < h.start_minutes + h.treatment_duration_minutes and h.start_minutes < v_offer.start_minutes + v_offer.duration_minutes) then 'busy'
      else 'open' end,
    v_offer.date, v_offer.start_minutes, v_offer.duration_minutes, v_offer.price_gbp, v_offer.normal_price_gbp, v_offer.closes_at, v_offer.add_travel_fee;
end; $$;

create or replace function public.quote_offer_booking(p_offer_code text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[] default '{}'::uuid[])
returns table (service_area_name text, primary_service_id uuid, treatment_duration_minutes integer, service_subtotal_gbp numeric(10,2),
  enhancements_total_gbp numeric(10,2), travel_fee_gbp numeric(10,2), congestion_fee_gbp numeric(10,2), total_gbp numeric(10,2))
language plpgsql stable security definer set search_path = '' as $$
declare v_offer public.slot_offers%rowtype;
begin
  select * into v_offer from public.slot_offers o where o.code = upper(btrim(coalesce(p_offer_code, '')));
  if not found or v_offer.status <> 'open' or v_offer.closes_at <= clock_timestamp() then
    raise exception 'Sorry, this special time is no longer available.' using errcode = '23P01';
  end if;
  if jsonb_typeof(p_sessions) is distinct from 'array' or jsonb_array_length(p_sessions) <> 1 or coalesce(cardinality(p_enhancement_ids), 0) > 0
     or (p_sessions->0->>'duration_minutes')::integer is distinct from v_offer.duration_minutes then
    raise exception '%', format('This special price is for one person, %s minutes, with no extras.', v_offer.duration_minutes) using errcode = '22023';
  end if;
  return query select q.service_area_name, q.primary_service_id, q.treatment_duration_minutes, v_offer.price_gbp, 0::numeric(10,2),
      case when v_offer.add_travel_fee then q.travel_fee_gbp else 0 end::numeric(10,2),
      case when v_offer.add_travel_fee then q.congestion_fee_gbp else 0 end::numeric(10,2),
      (v_offer.price_gbp + case when v_offer.add_travel_fee then coalesce(q.travel_fee_gbp, 0) + coalesce(q.congestion_fee_gbp, 0) else 0 end)::numeric(10,2)
    from public.compute_client_booking_quote(p_service_area_id, p_sessions, '{}'::uuid[]) q;
end; $$;

revoke all on function public.admin_create_slot_offer(date, integer, integer, numeric, timestamptz, boolean) from public, anon;
revoke all on function public.admin_update_slot_offer(uuid, numeric, timestamptz, boolean) from public, anon;
revoke all on function public.get_slot_offer(text, text) from public;
grant execute on function public.admin_create_slot_offer(date, integer, integer, numeric, timestamptz, boolean) to authenticated;
grant execute on function public.admin_update_slot_offer(uuid, numeric, timestamptz, boolean) to authenticated;
grant execute on function public.get_slot_offer(text, text) to anon, authenticated;

-- (finalize_client_booking: the travel fee for an offer only when it was ticked)
CREATE OR REPLACE FUNCTION public.finalize_client_booking(p_hold_id uuid, p_hold_token uuid, p_hold_client_key text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[], p_saved_address_id uuid, p_address_line_1 text, p_address_line_2 text, p_city text, p_postcode text, p_entry_instructions text, p_client_note text, p_payment_method text, p_idempotency_key text, p_address text DEFAULT NULL::text, p_offer_code text DEFAULT NULL::text)
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
    coalesce(v_offer_code, '')
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
        b.total_gbp,
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

  select exists (
    select 1
    from public.bookings b
    join public.booking_payments bp on bp.booking_id = b.id
    where b.client_id = v_client.id
      and b.booking_status = 'completed'
      and bp.status = 'paid'
  )
  into v_is_returning;

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

  if p_payment_method = 'bank_transfer' then
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
    slot_offer_id
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
    v_offer.id
  );

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
    payment_reference
  )
  values (
    v_booking_id,
    p_payment_method,
    v_payment_status,
    v_quote.total_gbp,
    v_payment_reference
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
      'total_gbp', v_quote.total_gbp
    )
  );

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
    v_quote.total_gbp::numeric(10,2),
    v_payment_reference,
    v_address.id;
end;
$function$;
