-- VAD Massage Booking V2
-- Pending bookings wait for the Admin; nothing is cancelled automatically.
--
-- Until now an unpaid bank-transfer booking carried a 60-minute deadline: after it the time was
-- released in availability and the client could no longer confirm. From this migration a booking
-- that is awaiting payment keeps its time until the Admin confirms the payment or removes the
-- booking. Removing a booking records it as cancelled; nothing is deleted. Clients are still limited
-- by the existing active-booking limit (one for a new client, five for a returning client).
--
-- Also: clients cannot list or hold times more than 40 days ahead (finalization already enforced
-- it). Admin booking has no horizon. Minimum notice for clients is unchanged at 2 hours.
-- bookings.payment_reservation_expires_at is kept for history but is no longer written or read.

alter table public.bookings drop constraint bookings_transfer_expiry_required;
update public.bookings set payment_reservation_expires_at = null where payment_reservation_expires_at is not null;
comment on column public.bookings.payment_reservation_expires_at is
  'Deprecated: bank-transfer reservations no longer expire. Always null.';

-- Admin may confirm a transfer directly from awaiting_transfer (payment seen before the client pressed the button).
create or replace function public.guard_booking_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.booking_status is not distinct from old.booking_status then
    return new;
  end if;

  if not (
    (old.booking_status = 'awaiting_transfer'
      and new.booking_status in ('awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'cancelled'))
    or (old.booking_status = 'awaiting_payment_verification'
      and new.booking_status in ('confirmed', 'cancelled'))
    or (old.booking_status = 'awaiting_cash_approval'
      and new.booking_status in ('confirmed', 'cancelled'))
    or (old.booking_status = 'confirmed'
      and new.booking_status in ('completed', 'cancelled', 'no_show'))
  ) then
    raise exception 'Booking status change not allowed: % to %', old.booking_status, new.booking_status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

-- compute_booking_availability: a booking awaiting transfer always holds its time
CREATE OR REPLACE FUNCTION public.compute_booking_availability(p_date date, p_treatment_duration_minutes integer, p_now timestamp with time zone, p_travel_buffer_minutes integer, p_excluded_hold_id uuid)
 RETURNS TABLE(start_minutes integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_available boolean;
  v_working_start integer;
  v_working_end integer;
  v_start_mode text;
  v_fixed_start integer;
  v_chain_count integer;
  v_chain_start integer;
  v_chain_end integer;
  v_candidate integer;
begin
  if p_date is null then
    raise exception 'Booking date is required' using errcode = '22023';
  end if;

  if (
    p_treatment_duration_minutes is null
    or p_treatment_duration_minutes < 60
    or p_treatment_duration_minutes > 1440
    or mod(p_treatment_duration_minutes, 30) <> 0
  ) then
    raise exception 'Treatment duration must be at least 60 minutes and use 30-minute increments'
      using errcode = '22023';
  end if;

  if p_travel_buffer_minutes is null or p_travel_buffer_minutes < 0 then
    raise exception 'Travel buffer must be zero or greater'
      using errcode = '22023';
  end if;

  select
    o.available,
    o.start_minutes,
    o.end_minutes,
    o.start_mode,
    o.fixed_start_minutes
  into
    v_available,
    v_working_start,
    v_working_end,
    v_start_mode,
    v_fixed_start
  from public.working_hours_overrides o
  where o.date = p_date;

  if not found then
    select
      w.available,
      w.start_minutes,
      w.end_minutes,
      w.start_mode,
      w.fixed_start_minutes
    into
      v_available,
      v_working_start,
      v_working_end,
      v_start_mode,
      v_fixed_start
    from public.working_hours w
    where w.weekday = extract(isodow from p_date)::smallint;
  end if;

  if not found or not v_available then
    return;
  end if;

  select
    count(*)::integer,
    min(chain.start_minutes)::integer,
    max(chain.end_minutes)::integer
  into
    v_chain_count,
    v_chain_start,
    v_chain_end
  from (
    select
      b.start_minutes,
      b.start_minutes + b.treatment_duration_minutes as end_minutes
    from public.bookings b
    where b.date = p_date
      and b.booking_status in (
        'awaiting_transfer',
        'awaiting_payment_verification',
        'awaiting_cash_approval',
        'confirmed',
        'completed'
      )

    union all

    select
      h.start_minutes,
      h.start_minutes + h.treatment_duration_minutes as end_minutes
    from public.booking_holds h
    where h.date = p_date
      and h.status = 'active'
      and h.expires_at > p_now
      and h.id is distinct from p_excluded_hold_id
  ) chain;

  if v_chain_count = 0 and v_start_mode = 'fixed' then
    v_candidate := v_fixed_start;

    if (
      v_candidate is not null
      and v_candidate >= v_working_start
      and v_candidate + p_treatment_duration_minutes <= v_working_end
      and not exists (
        select 1
        from public.calendar_blocks cb
        where cb.date = p_date
          and v_candidate < cb.end_minutes
          and v_candidate + p_treatment_duration_minutes > cb.start_minutes
      )
    ) then
      start_minutes := v_candidate;
      return next;
    end if;

    return;
  end if;

  if v_chain_count = 0 then
    return query
    select candidate
    from generate_series(
      v_working_start,
      v_working_end - p_treatment_duration_minutes,
      30
    ) as candidate
    where not exists (
      select 1
      from public.calendar_blocks cb
      where cb.date = p_date
        and candidate < cb.end_minutes
        and candidate + p_treatment_duration_minutes > cb.start_minutes
    )
    order by candidate;

    return;
  end if;

  v_candidate :=
    v_chain_start - p_travel_buffer_minutes - p_treatment_duration_minutes;

  if (
    v_candidate >= v_working_start
    and not exists (
      select 1
      from public.calendar_blocks cb
      where cb.date = p_date
        and v_candidate < cb.end_minutes
        and v_chain_start > cb.start_minutes
    )
  ) then
    start_minutes := v_candidate;
    return next;
  end if;

  v_candidate := v_chain_end + p_travel_buffer_minutes;

  if (
    v_candidate + p_treatment_duration_minutes <= v_working_end
    and not exists (
      select 1
      from public.calendar_blocks cb
      where cb.date = p_date
        and v_chain_end < cb.end_minutes
        and v_candidate + p_treatment_duration_minutes > cb.start_minutes
    )
  ) then
    start_minutes := v_candidate;
    return next;
  end if;
end;
$function$;

-- finalize_client_booking: no transfer deadline, pending bookings always count toward the client limit
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

  if v_hold.date > v_london_today + 40 then
    raise exception 'Online appointments can currently be arranged up to 40 days ahead. Please choose an earlier date.'
      using errcode = '22023';
  end if;

  if (
    v_hold.date = v_london_today
    and v_hold.start_minutes < v_london_now_minutes + 120
  ) then
    raise exception 'Online appointments need at least 2 hours notice. Please choose a later time.'
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

  if not v_is_returning and v_active_future_count >= 1 then
    raise exception 'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.'
      using errcode = '22023';
  end if;

  if v_is_returning and v_active_future_count >= 5 then
    raise exception 'You already have five upcoming appointments. Please manage one of those appointments before adding another.'
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

-- get_my_booking: no reservation deadline in the client view
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
  'city_snapshot',b.city_snapshot,'postcode_snapshot',b.postcode_snapshot,
  'booking_sessions',(select coalesce(jsonb_agg(jsonb_build_object('position',s.position,'duration_minutes',s.duration_minutes,
    'recipient_name',s.recipient_name,'service_name_snapshot',s.service_name_snapshot) order by s.position),'[]'::jsonb)
    from public.booking_sessions s where s.booking_id=b.id),
  'booking_payments',jsonb_build_object('method',p.method,'status',p.status,'payment_reference',p.payment_reference,
    'transfer_declared_at',p.transfer_declared_at)
 ) into v_result from public.bookings b join public.clients c on c.id=b.client_id
 join public.booking_payments p on p.booking_id=b.id
 where b.id=p_booking_id and c.auth_user_id=auth.uid();
 if v_result is null then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 return v_result;
end; $function$;

-- complete_client_payment: a client can confirm their payment at any time while the booking is pending
CREATE OR REPLACE FUNCTION public.complete_client_payment(p_booking_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_client uuid; v_date date; v_booking public.bookings%rowtype; v_payment public.booking_payments%rowtype;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select c.id into v_client from public.clients c where c.auth_user_id=auth.uid() for update;
 select b.date into v_date from public.bookings b where b.id=p_booking_id and b.client_id=v_client;
 if not found then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
 select * into v_booking from public.bookings where id=p_booking_id for update;
 select * into v_payment from public.booking_payments where booking_id=p_booking_id for update;
 if p_action='bank_transfer' and v_payment.method='bank_transfer' and v_payment.transfer_declared_at is not null then
   return public.get_my_booking(p_booking_id);
 end if;
 if p_action='cash' and v_payment.method='cash' then
   return public.get_my_booking(p_booking_id);
 end if;
 if v_booking.booking_status <> 'awaiting_transfer' or v_payment.status <> 'awaiting_transfer' then
   raise exception 'This payment request can no longer be changed' using errcode='22023';
 end if;
 if p_action='bank_transfer' then
   update public.booking_payments set status='awaiting_verification',transfer_declared_at=clock_timestamp() where booking_id=p_booking_id;
   update public.bookings set booking_status='awaiting_payment_verification' where id=p_booking_id;
 elsif p_action='cash' then
   update public.booking_payments set method='cash',status='awaiting_approval' where booking_id=p_booking_id;
   update public.bookings set booking_status='awaiting_cash_approval',payment_reservation_expires_at=null where id=p_booking_id;
 else raise exception 'Invalid payment action' using errcode='22023'; end if;
 insert into public.event_outbox(event_type,aggregate_type,aggregate_id,deduplication_key,payload)
 values(case when p_action='cash' then 'booking.cash_requested' else 'booking.transfer_declared' end,
 'booking',p_booking_id,'client-payment:'||p_booking_id::text,jsonb_build_object('booking_id',p_booking_id,'method',p_action));
 return public.get_my_booking(p_booking_id);
end; $function$;

-- create_booking_hold: clients cannot hold a time more than 40 days ahead
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

  if p_date > v_london_today + 40 then
    raise exception 'Online appointments can currently be arranged up to 40 days ahead. Please choose an earlier date.'
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

  if (
    p_date = v_london_today
    and p_start_minutes < v_london_now_minutes + 120
  ) then
    raise exception 'Online appointments need at least 2 hours notice. Please choose a later time.'
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

-- get_booking_availability: no client availability more than 40 days ahead
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

  if p_date < v_london_today or p_date > v_london_today + 40 then
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
  where (
    p_date > v_london_today
    or a.start_minutes >= v_london_now_minutes + 120
  )
  order by a.start_minutes;
end;
$function$;

-- admin_verify_bank_transfer: also confirm a transfer the client has not yet declared
CREATE OR REPLACE FUNCTION public.admin_verify_bank_transfer(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamp with time zone, p_payment_updated_at timestamp with time zone)
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
  if p.amount_gbp is distinct from b.total_gbp then
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

-- admin_remove_pending_booking: Admin removes a booking that is still waiting for payment
CREATE OR REPLACE FUNCTION public.admin_remove_pending_booking(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamp with time zone, p_payment_updated_at timestamp with time zone)
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
  v_fingerprint := md5(concat_ws('|', 'admin_remove_pending_booking', p_booking_id::text,
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
     or not ((b.booking_status = 'awaiting_transfer' and p.status = 'awaiting_transfer')
          or (b.booking_status = 'awaiting_payment_verification' and p.status = 'awaiting_verification')
          or (b.booking_status = 'awaiting_cash_approval' and p.status = 'awaiting_approval')) then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_remove_pending_booking',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='cancelled', cancelled_at=v_now, cancelled_by_actor_type='admin', cancelled_by_actor_id=auth.uid()::text, payment_reservation_expires_at=null where id=b.id;
  update public.booking_payments set status='rejected' where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.pending_removed','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $function$;

-- The queue now lists every booking that is waiting for the Admin, including transfers the client has not declared.
create or replace function public.admin_payment_review_queue(p_offset integer default 0)
returns setof public.bookings language plpgsql security invoker set search_path = '' as $$
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
  order by b.date, b.start_minutes, b.id offset p_offset limit 51;
end; $$;

revoke all on function public.admin_remove_pending_booking(uuid,uuid,timestamptz,timestamptz) from public, anon;
grant execute on function public.admin_remove_pending_booking(uuid,uuid,timestamptz,timestamptz) to authenticated;
