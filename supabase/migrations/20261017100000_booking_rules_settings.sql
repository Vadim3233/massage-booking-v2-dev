-- VAD Massage Booking V2
-- Booking rules the Admin can change herself.
--
-- The numbers that used to be written into the booking functions now live in business_settings:
--   booking_horizon_days (40)          how far ahead clients can book
--   minimum_notice_minutes (120)       how much notice clients need
--   free_cancellation_hours (24)       free to cancel or change this long before the appointment
--   grace_minutes (60)                 and free for this long after booking, whatever the appointment time
--   new_client_booking_limit (1)       upcoming bookings a new client may hold
--   returning_client_booking_limit (5) upcoming bookings a returning client may hold
-- The defaults are the values in force before this change. A rule applies from the moment it is saved to
-- anything done after that; bookings already made and their recorded fees are not recalculated.

insert into public.business_settings(key, value) values
  ('booking_horizon_days', '40'), ('minimum_notice_minutes', '120'), ('free_cancellation_hours', '24'),
  ('grace_minutes', '60'), ('new_client_booking_limit', '1'), ('returning_client_booking_limit', '5')
on conflict (key) do nothing;

-- Internal readers. A missing or unusable value falls back to the default, so a rule can never break booking.
create function public.business_setting_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select case when jsonb_typeof(value) = 'number' and (value #>> '{}') ~ '^[0-9]{1,6}$' then (value #>> '{}')::integer end
    from public.business_settings where key = p_key), p_default);
$$;

create function public.notice_text(p_minutes integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_minutes >= 60 and p_minutes % 60 = 0 then (p_minutes / 60)::text || case when p_minutes = 60 then ' hour' else ' hours' end
              when p_minutes = 1 then '1 minute' else p_minutes::text || ' minutes' end;
$$;

create function public.count_word(p_count integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_count when 1 then 'one' when 2 then 'two' when 3 then 'three' when 4 then 'four' when 5 then 'five'
    when 6 then 'six' when 7 then 'seven' when 8 then 'eight' when 9 then 'nine' when 10 then 'ten' else p_count::text end;
$$;
revoke all on function public.business_setting_int(text, integer) from public, anon, authenticated;
revoke all on function public.notice_text(integer) from public, anon, authenticated;
revoke all on function public.count_word(integer) from public, anon, authenticated;

-- create_booking_hold: horizon and notice come from the settings
CREATE OR REPLACE FUNCTION public.create_booking_hold(p_date date, p_start_minutes integer, p_treatment_duration_minutes integer, p_client_key text)
 RETURNS TABLE(hold_id uuid, hold_token uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := now();
  v_client_key text := btrim(coalesce(p_client_key, ''));
  v_london_today date := (now() at time zone 'Europe/London')::date;
  v_london_now_minutes integer := (
    extract(hour from now() at time zone 'Europe/London')::integer * 60
    + extract(minute from now() at time zone 'Europe/London')::integer
  );
  v_existing_hold_id uuid;
  v_hold public.booking_holds%rowtype;
begin
  if (
    length(v_client_key) < 20
    or length(v_client_key) > 120
    or v_client_key !~ '^[A-Za-z0-9:_-]+$'
  ) then
    raise exception 'A valid booking hold client key is required'
      using errcode = '22023';
  end if;

  if p_date is null then
    raise exception 'Booking date is required' using errcode = '22023';
  end if;

  if p_date < v_london_today then
    raise exception 'Booking hold date cannot be in the past'
      using errcode = '22023';
  end if;

  if p_date > v_london_today + public.business_setting_int('booking_horizon_days', 40) then
    raise exception '%', format('Online appointments can currently be arranged up to %s days ahead. Please choose an earlier date.', public.business_setting_int('booking_horizon_days', 40))
      using errcode = '22023';
  end if;

  if p_start_minutes is null or p_start_minutes not between 0 and 1439 then
    raise exception 'Start time is invalid' using errcode = '22023';
  end if;

  if (
    p_treatment_duration_minutes is null
    or p_treatment_duration_minutes < 60
    or p_treatment_duration_minutes > 240
    or mod(p_treatment_duration_minutes, 30) <> 0
  ) then
    raise exception 'Booking hold duration is invalid'
      using errcode = '22023';
  end if;

  if p_start_minutes + p_treatment_duration_minutes > 1440 then
    raise exception 'Booking hold time range is invalid'
      using errcode = '22023';
  end if;

  if ((p_date + make_interval(mins => p_start_minutes)) at time zone 'Europe/London') < clock_timestamp() + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120)) then
    raise exception '%', format('Online appointments need at least %s notice. Please choose a later time.', public.notice_text(public.business_setting_int('minimum_notice_minutes', 120)))
      using errcode = '23P01';
  end if;

  -- A browser client key is the pre-auth idempotency identity. Serialize it so
  -- double-clicks/retries cannot create multiple simultaneous holds.
  perform pg_advisory_xact_lock(hashtext('booking-hold-client:' || v_client_key));

  -- Serialize scheduling writes by business date. Booking finalization,
  -- rescheduling and admin scheduling RPCs must take the same date lock.
  perform pg_advisory_xact_lock(42420, hashtext(p_date::text));

  select h.id
  into v_existing_hold_id
  from public.booking_holds h
  where h.client_key = v_client_key
    and h.status = 'active'
    and h.expires_at > v_now
    and h.date = p_date
    and h.start_minutes = p_start_minutes
    and h.treatment_duration_minutes = p_treatment_duration_minutes
    and h.travel_buffer_minutes = 60
  order by h.created_at desc
  limit 1
  for update;

  -- Retries keep the same token, deadline and extension allowance. They must
  -- not provide another way to renew a reservation indefinitely.
  if v_existing_hold_id is not null then
    return query select h.id, h.hold_token, h.expires_at
      from public.booking_holds h where h.id = v_existing_hold_id;
    return;
  end if;

  -- Own current hold must not block moving or refreshing the selection.
  update public.booking_holds as h
  set
    status = 'released',
    expires_at = least(h.expires_at, v_now)
  where h.client_key = v_client_key
    and h.status = 'active'
    and h.expires_at > v_now;

  if not exists (
    select 1
    from public.compute_booking_availability(
      p_date,
      p_treatment_duration_minutes,
      v_now,
      60
    ) a
    where a.start_minutes = p_start_minutes
  ) then
    raise exception 'Requested time is no longer available'
      using errcode = '23P01';
  end if;

  insert into public.booking_holds (
    client_id,
    client_key,
    hold_token,
    date,
    start_minutes,
    treatment_duration_minutes,
    travel_buffer_minutes,
    expires_at,
    status
  )
  values (
    null,
    v_client_key,
    gen_random_uuid(),
    p_date,
    p_start_minutes,
    p_treatment_duration_minutes,
    60,
    v_now + interval '20 minutes',
    'active'
  )
  returning * into v_hold;

  hold_id := v_hold.id;
  hold_token := v_hold.hold_token;
  expires_at := v_hold.expires_at;
  return next;
end;
$function$;

-- finalize_client_booking: horizon, notice and booking limits come from the settings
CREATE OR REPLACE FUNCTION public.finalize_client_booking(p_hold_id uuid, p_hold_token uuid, p_hold_client_key text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[], p_saved_address_id uuid, p_address_line_1 text, p_address_line_2 text, p_city text, p_postcode text, p_entry_instructions text, p_client_note text, p_payment_method text, p_idempotency_key text)
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
    p_payment_method
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

  if v_hold.date < v_london_today then
    raise exception 'Booking date cannot be in the past'
      using errcode = '22023';
  end if;

  if v_hold.date > v_london_today + public.business_setting_int('booking_horizon_days', 40) then
    raise exception '%', format('Online appointments can currently be arranged up to %s days ahead. Please choose an earlier date.', public.business_setting_int('booking_horizon_days', 40))
      using errcode = '22023';
  end if;

  if ((v_hold.date + make_interval(mins => v_hold.start_minutes)) at time zone 'Europe/London') < clock_timestamp() + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120)) then
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

  if not exists (
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
    if nullif(btrim(p_address_line_1), '') is null
       or nullif(btrim(p_city), '') is null
       or nullif(btrim(p_postcode), '') is null then
      raise exception 'A complete booking address is required'
        using errcode = '22023';
    end if;

    select a.*
    into v_address
    from public.client_addresses a
    where a.client_id = v_client.id
      and lower(a.address_line_1) = lower(btrim(p_address_line_1))
      and a.normalized_postcode = regexp_replace(
        upper(btrim(p_postcode)),
        '[^A-Z0-9]+',
        '',
        'g'
      )
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
        btrim(p_address_line_1),
        nullif(btrim(p_address_line_2), ''),
        btrim(p_city),
        upper(btrim(p_postcode)),
        regexp_replace(upper(btrim(p_postcode)), '[^A-Z0-9]+', '', 'g'),
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
    entry_instructions_snapshot,
    service_area_name_snapshot,
    service_subtotal_gbp,
    enhancements_total_gbp,
    travel_fee_gbp,
    congestion_fee_gbp,
    total_gbp,
    booking_email_snapshot,
    payment_reservation_expires_at,
    client_note
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
    v_address.entry_instructions,
    v_quote.service_area_name,
    v_quote.service_subtotal_gbp,
    v_quote.enhancements_total_gbp,
    v_quote.travel_fee_gbp,
    v_quote.congestion_fee_gbp,
    v_quote.total_gbp,
    v_client.email,
    null,
    nullif(btrim(p_client_note), '')
  );

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

-- get_booking_availability: horizon and notice come from the settings
CREATE OR REPLACE FUNCTION public.get_booking_availability(p_date date, p_treatment_duration_minutes integer, p_hold_id uuid DEFAULT NULL::uuid, p_hold_token uuid DEFAULT NULL::uuid, p_client_key text DEFAULT NULL::text)
 RETURNS TABLE(start_minutes integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_excluded_hold_id uuid;
  v_london_today date := (now() at time zone 'Europe/London')::date;
  v_london_now_minutes integer := (
    extract(hour from now() at time zone 'Europe/London')::integer * 60
    + extract(minute from now() at time zone 'Europe/London')::integer
  );
begin
  if p_date is null then
    raise exception 'Booking date is required' using errcode = '22023';
  end if;

  if (
    p_treatment_duration_minutes is null
    or p_treatment_duration_minutes < 60
    or p_treatment_duration_minutes > 240
    or mod(p_treatment_duration_minutes, 30) <> 0
  ) then
    raise exception 'Booking duration is invalid'
      using errcode = '22023';
  end if;

  if num_nonnulls(p_hold_id, p_hold_token, p_client_key) > 0 then
    if num_nonnulls(p_hold_id, p_hold_token, p_client_key) <> 3 then
      raise exception 'Hold ID, token and browser client key must be provided together'
        using errcode = '22023';
    end if;
    select h.id into v_excluded_hold_id
    from public.booking_holds h
    where h.id = p_hold_id
      and h.hold_token = p_hold_token
      and h.client_key = btrim(p_client_key)
      and h.status = 'active'
      and h.expires_at > v_now
    for share;
    if not found then
      raise exception 'Booking hold identity is invalid or no longer active'
        using errcode = '42501';
    end if;
  end if;

  if p_date < v_london_today or p_date > v_london_today + public.business_setting_int('booking_horizon_days', 40) then
    return;
  end if;

  return query
  select a.start_minutes
  from public.compute_booking_availability(
    p_date,
    p_treatment_duration_minutes,
    v_now,
    60,
    v_excluded_hold_id
  ) a
  where ((p_date + make_interval(mins => a.start_minutes)) at time zone 'Europe/London') >= clock_timestamp() + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120))
  order by a.start_minutes;
end;
$function$;

-- get_my_booking_availability: horizon and notice come from the settings
CREATE OR REPLACE FUNCTION public.get_my_booking_availability(p_booking_id uuid, p_date date)
 RETURNS TABLE(start_minutes integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype := public.client_booking_for_change(p_booking_id);
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
begin
  if p_date is null then raise exception 'Booking date is required' using errcode = '22023'; end if;
  if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
     or p_date < v_today or p_date > v_today + public.business_setting_int('booking_horizon_days', 40) then
    return;
  end if;
  return query
  select a.start_minutes from public.compute_booking_availability(p_date, b.treatment_duration_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
  where ((p_date + make_interval(mins => a.start_minutes)) at time zone 'Europe/London') >= v_now + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120))
  order by a.start_minutes;
end;
$function$;

-- client_reschedule_booking: horizon and notice come from the settings
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

-- get_my_change_terms: the free window comes from the settings
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
    'cancel_fee_gbp', case when v_open then public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now) else 0 end,
    'reschedule_fee_gbp', case when v_open then public.change_fee_gbp(b, 'client', v_now) else 0 end,
    'total_gbp', b.total_gbp);
end;
$function$;

-- late_fee_standard_gbp: the grace period and free window come from the settings
CREATE OR REPLACE FUNCTION public.late_fee_standard_gbp(p_total_gbp numeric, p_date date, p_start_minutes integer, p_created_at timestamp with time zone, p_at timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case
    when p_at < p_created_at + make_interval(mins => public.business_setting_int('grace_minutes', 60)) then 0::numeric
    when p_at >= ((p_date + make_interval(mins => p_start_minutes)) at time zone 'Europe/London') - make_interval(hours => public.business_setting_int('free_cancellation_hours', 24)) then p_total_gbp
    else 0::numeric
  end;
$function$;

-- change_fee_gbp: stable, because it depends on the settings
CREATE OR REPLACE FUNCTION public.change_fee_gbp(b bookings, p_initiated_by text, p_now timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case
    when p_initiated_by = 'admin' then 0::numeric
    when b.late_fee_status <> 'none' then 0::numeric
    else public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, p_now)
  end;
$function$;

-- plan_event_notifications: the fee wording follows the free window
CREATE OR REPLACE FUNCTION public.plan_event_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
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
  v_where := concat_ws(', ', b.address_line_1_snapshot, b.city_snapshot, b.postcode_snapshot);

  case new.event_type
    when 'booking.created' then
      if new.payload ? 'actor_id' then
        v_client_title := 'Your appointment is booked';
        v_client_body := format('Your appointment is confirmed for %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference);
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
      v_client_body := format('Your appointment is now on %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference) ||
        case when v_initiated = 'client' and v_fee > 0 then format(E'\n\nBecause this change was inside %s hours, a late fee of %s applies. I will be in touch about it.', public.business_setting_int('free_cancellation_hours', 24), public.notification_money(v_fee)) else '' end;
    when 'booking.bank_transfer_verified', 'booking.cash_approved' then
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Thank you. Your appointment is confirmed for %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference) ||
        case when new.event_type = 'booking.cash_approved' then E'\n\nPlease pay the full amount in cash at your appointment.' else E'\n\nI have received your payment.' end;
    when 'booking.refund_recorded' then
      v_client_title := 'Your refund has been sent';
      v_client_body := format('I have sent your refund of %s for the appointment on %s.', public.notification_money((new.payload->>'refunded_gbp')::numeric), v_when);
    else
      null;
  end case;

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

-- What the Admin sees and saves, and what the booking pages may know.
create function public.admin_booking_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'booking_horizon_days', public.business_setting_int('booking_horizon_days', 40),
    'minimum_notice_hours', public.business_setting_int('minimum_notice_minutes', 120) / 60,
    'free_cancellation_hours', public.business_setting_int('free_cancellation_hours', 24),
    'grace_minutes', public.business_setting_int('grace_minutes', 60),
    'new_client_booking_limit', public.business_setting_int('new_client_booking_limit', 1),
    'returning_client_booking_limit', public.business_setting_int('returning_client_booking_limit', 5));
end;
$$;

create function public.admin_save_booking_rules(p_rules jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_horizon integer; v_notice integer; v_free integer; v_grace integer; v_new integer; v_returning integer;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('booking_horizon_days', 'minimum_notice_hours', 'free_cancellation_hours', 'grace_minutes', 'new_client_booking_limit', 'returning_client_booking_limit')) then
    raise exception 'Those rules are not recognised' using errcode = '22023';
  end if;
  begin
    v_horizon := (p_rules->>'booking_horizon_days')::integer; v_notice := (p_rules->>'minimum_notice_hours')::integer;
    v_free := (p_rules->>'free_cancellation_hours')::integer; v_grace := (p_rules->>'grace_minutes')::integer;
    v_new := (p_rules->>'new_client_booking_limit')::integer; v_returning := (p_rules->>'returning_client_booking_limit')::integer;
  exception when others then
    raise exception 'Every rule needs a whole number' using errcode = '22023';
  end;
  if v_horizon is null or v_horizon not between 1 and 365 then raise exception 'Booking ahead must be between 1 and 365 days' using errcode = '22023'; end if;
  if v_notice is null or v_notice not between 0 and 72 then raise exception 'Notice must be between 0 and 72 hours' using errcode = '22023'; end if;
  if v_free is null or v_free not between 0 and 168 then raise exception 'The free cancellation window must be between 0 and 168 hours' using errcode = '22023'; end if;
  if v_grace is null or v_grace not between 0 and 240 then raise exception 'The grace period must be between 0 and 240 minutes' using errcode = '22023'; end if;
  if v_new is null or v_new not between 1 and 10 then raise exception 'A new client may hold between 1 and 10 bookings' using errcode = '22023'; end if;
  if v_returning is null or v_returning not between v_new and 20 then raise exception 'A returning client may hold as many as a new client, up to 20' using errcode = '22023'; end if;
  insert into public.business_settings(key, value, updated_by) values
    ('booking_horizon_days', to_jsonb(v_horizon), auth.uid()), ('minimum_notice_minutes', to_jsonb(v_notice * 60), auth.uid()),
    ('free_cancellation_hours', to_jsonb(v_free), auth.uid()), ('grace_minutes', to_jsonb(v_grace), auth.uid()),
    ('new_client_booking_limit', to_jsonb(v_new), auth.uid()), ('returning_client_booking_limit', to_jsonb(v_returning), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

-- The few rules the booking pages need to show correct wording and date limits. Nothing private.
create function public.get_booking_rules()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'booking_horizon_days', public.business_setting_int('booking_horizon_days', 40),
    'minimum_notice_hours', public.business_setting_int('minimum_notice_minutes', 120) / 60,
    'free_cancellation_hours', public.business_setting_int('free_cancellation_hours', 24),
    'grace_minutes', public.business_setting_int('grace_minutes', 60));
$$;

revoke all on function public.admin_booking_rules() from public, anon;
revoke all on function public.admin_save_booking_rules(jsonb) from public, anon;
revoke all on function public.get_booking_rules() from public;
grant execute on function public.admin_booking_rules() to authenticated;
grant execute on function public.admin_save_booking_rules(jsonb) to authenticated;
grant execute on function public.get_booking_rules() to anon, authenticated;
