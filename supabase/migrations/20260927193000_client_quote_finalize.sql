-- VAD Massage Booking V2
-- Public quote + atomic client booking finalization.
-- Pricing, fees, hold validation, booking limits, snapshots, payment state,
-- idempotency and outbox creation are server-authoritative.

alter table public.bookings
  add column client_note text;

alter table public.bookings
  add constraint bookings_client_note_length_valid
  check (client_note is null or length(client_note) <= 4000);

-- V1 selects enhancements once for the appointment, not once per guest/session.
-- Keep a booking-level snapshot table for the public flow.
create table public.booking_enhancements (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  enhancement_id uuid not null references public.enhancements(id) on delete restrict,
  enhancement_name_snapshot text not null,
  quantity integer not null default 1,
  unit_price_gbp numeric(10,2) not null,
  duration_minutes_snapshot integer not null default 0,
  created_at timestamptz not null default now(),

  unique (booking_id, enhancement_id),

  constraint booking_enhancements_name_not_blank
    check (length(btrim(enhancement_name_snapshot)) > 0),
  constraint booking_enhancements_quantity_positive
    check (quantity > 0),
  constraint booking_enhancements_price_nonnegative
    check (unit_price_gbp >= 0),
  constraint booking_enhancements_duration_nonnegative
    check (duration_minutes_snapshot >= 0)
);

create index booking_enhancements_enhancement_idx
  on public.booking_enhancements (enhancement_id);

alter table public.booking_enhancements enable row level security;

create policy "clients can read own booking enhancements"
on public.booking_enhancements
for select
to authenticated
using (
  exists (
    select 1
    from public.bookings b
    join public.clients c on c.id = b.client_id
    where b.id = booking_enhancements.booking_id
      and c.auth_user_id = auth.uid()
  )
);

create policy "admins can manage booking enhancements"
on public.booking_enhancements
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

revoke all on table public.booking_enhancements from anon;
grant select, insert, update, delete on table public.booking_enhancements to authenticated;

create or replace function public.compute_client_booking_quote(
  p_service_area_id uuid,
  p_sessions jsonb,
  p_enhancement_ids uuid[]
)
returns table (
  service_area_name text,
  primary_service_id uuid,
  treatment_duration_minutes integer,
  service_subtotal_gbp numeric(10,2),
  enhancements_total_gbp numeric(10,2),
  travel_fee_gbp numeric(10,2),
  congestion_fee_gbp numeric(10,2),
  total_gbp numeric(10,2)
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session jsonb;
  v_service_id uuid;
  v_first_service_id uuid;
  v_duration integer;
  v_price numeric(10,2);
  v_session_count integer := 0;
  v_duration_total integer := 0;
  v_service_total numeric(10,2) := 0;
  v_enhancement_total numeric(10,2) := 0;
  v_enhancement_ids uuid[] := coalesce(p_enhancement_ids, '{}'::uuid[]);
  v_enhancement_id uuid;
  v_area public.service_areas%rowtype;
begin
  if p_service_area_id is null then
    raise exception 'Service area is required'
      using errcode = '22023';
  end if;

  select a.*
  into v_area
  from public.service_areas a
  where a.id = p_service_area_id
    and a.active;

  if not found then
    raise exception 'Service area is not available for online booking'
      using errcode = '22023';
  end if;

  if p_sessions is null
     or jsonb_typeof(p_sessions) <> 'array'
     or jsonb_array_length(p_sessions) = 0
     or jsonb_array_length(p_sessions) > 4 then
    raise exception 'Booking sessions must contain between one and four sessions'
      using errcode = '22023';
  end if;

  for v_session in
    select value
    from jsonb_array_elements(p_sessions)
  loop
    v_session_count := v_session_count + 1;

    if jsonb_typeof(v_session) <> 'object' then
      raise exception 'Each booking session must be an object'
        using errcode = '22023';
    end if;

    if exists (
      select 1
      from jsonb_object_keys(v_session) supplied(key)
      where supplied.key not in (
        'service_id',
        'duration_minutes',
        'recipient_name',
        'preference_ids'
      )
    ) then
      raise exception 'Booking session contains unsupported fields'
        using errcode = '22023';
    end if;

    v_service_id := nullif(btrim(v_session ->> 'service_id'), '')::uuid;
    v_duration := nullif(v_session ->> 'duration_minutes', '')::integer;

    if v_service_id is null or v_duration not in (60, 90, 120) then
      raise exception 'Booking session service or duration is invalid'
        using errcode = '22023';
    end if;

    if v_first_service_id is null then
      v_first_service_id := v_service_id;
    elsif v_service_id <> v_first_service_id then
      raise exception 'Public booking sessions must use the selected treatment'
        using errcode = '22023';
    end if;

    select p.price_gbp
    into v_price
    from public.services s
    join public.service_duration_prices p
      on p.service_id = s.id
    where s.id = v_service_id
      and s.active
      and p.duration_minutes = v_duration
      and p.active;

    if not found then
      raise exception 'Selected treatment duration is no longer available'
        using errcode = '22023';
    end if;

    v_duration_total := v_duration_total + v_duration;
    v_service_total := v_service_total + v_price;
  end loop;

  if v_duration_total > 240 then
    raise exception 'The longest single booking is 240 minutes'
      using errcode = '22023';
  end if;

  if cardinality(v_enhancement_ids) <> (
    select count(distinct e_id)::integer
    from unnest(v_enhancement_ids) e_id
  ) then
    raise exception 'Enhancement selection contains duplicates'
      using errcode = '22023';
  end if;

  foreach v_enhancement_id in array v_enhancement_ids
  loop
    select e.price_gbp
    into v_price
    from public.enhancements e
    where e.id = v_enhancement_id
      and e.active;

    if not found then
      raise exception 'Selected enhancement is no longer available'
        using errcode = '22023';
    end if;

    -- V1 public booking intentionally treats enhancements as zero-duration
    -- appointment additions. They affect price, not the reserved treatment time.
    v_enhancement_total := v_enhancement_total + v_price;
  end loop;

  service_area_name := v_area.name;
  primary_service_id := v_first_service_id;
  treatment_duration_minutes := v_duration_total;
  service_subtotal_gbp := round(v_service_total, 2);
  enhancements_total_gbp := round(v_enhancement_total, 2);
  travel_fee_gbp := round(v_area.travel_surcharge_gbp, 2);
  congestion_fee_gbp := round(v_area.congestion_fee_gbp, 2);
  total_gbp := round(
    v_service_total
    + v_enhancement_total
    + v_area.travel_surcharge_gbp
    + v_area.congestion_fee_gbp,
    2
  );

  return next;
end;
$$;

create or replace function public.quote_client_booking(
  p_service_area_id uuid,
  p_sessions jsonb,
  p_enhancement_ids uuid[] default '{}'::uuid[]
)
returns table (
  service_area_name text,
  primary_service_id uuid,
  treatment_duration_minutes integer,
  service_subtotal_gbp numeric(10,2),
  enhancements_total_gbp numeric(10,2),
  travel_fee_gbp numeric(10,2),
  congestion_fee_gbp numeric(10,2),
  total_gbp numeric(10,2)
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select *
  from public.compute_client_booking_quote(
    p_service_area_id,
    p_sessions,
    p_enhancement_ids
  );
$$;

revoke all on function public.compute_client_booking_quote(uuid, jsonb, uuid[])
  from public;
revoke all on function public.compute_client_booking_quote(uuid, jsonb, uuid[])
  from anon;
revoke all on function public.compute_client_booking_quote(uuid, jsonb, uuid[])
  from authenticated;

revoke all on function public.quote_client_booking(uuid, jsonb, uuid[])
  from public;
grant execute on function public.quote_client_booking(uuid, jsonb, uuid[])
  to anon, authenticated;

create or replace function public.finalize_client_booking(
  p_hold_id uuid,
  p_hold_token uuid,
  p_hold_client_key text,
  p_service_area_id uuid,
  p_sessions jsonb,
  p_enhancement_ids uuid[],
  p_saved_address_id uuid,
  p_address_line_1 text,
  p_address_line_2 text,
  p_city text,
  p_postcode text,
  p_entry_instructions text,
  p_client_note text,
  p_payment_method text,
  p_idempotency_key text
)
returns table (
  booking_id uuid,
  booking_reference text,
  booking_status text,
  payment_status text,
  total_gbp numeric(10,2),
  payment_reference text,
  saved_address_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select *
  into v_quote
  from public.compute_client_booking_quote(
    p_service_area_id,
    p_sessions,
    v_enhancement_ids
  );

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
    v_booking_status := 'awaiting_payment_verification';
    v_payment_status := 'awaiting_verification';
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
$$;

revoke all on function public.finalize_client_booking(
  uuid, uuid, text, uuid, jsonb, uuid[], uuid,
  text, text, text, text, text, text, text, text
) from public;
revoke all on function public.finalize_client_booking(
  uuid, uuid, text, uuid, jsonb, uuid[], uuid,
  text, text, text, text, text, text, text, text
) from anon;
grant execute on function public.finalize_client_booking(
  uuid, uuid, text, uuid, jsonb, uuid[], uuid,
  text, text, text, text, text, text, text, text
) to authenticated;
