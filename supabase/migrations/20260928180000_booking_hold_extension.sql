-- Twenty-minute pre-auth holds with one ten-minute extension.
-- Existing hold identities, tokens, browser keys and scheduling locks are retained.
alter table public.booking_holds add column extended_at timestamptz;

create or replace function public.create_booking_hold(
  p_date date,
  p_start_minutes integer,
  p_treatment_duration_minutes integer,
  p_client_key text
)
returns table (
  hold_id uuid,
  hold_token uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

create or replace function public.extend_booking_hold(
  p_hold_id uuid,
  p_hold_token uuid,
  p_client_key text
)
returns table (hold_id uuid, expires_at timestamptz, extension_used boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := btrim(coalesce(p_client_key, ''));
  v_hold public.booking_holds%rowtype;
  v_now timestamptz;
begin
  if p_hold_id is null or p_hold_token is null
     or length(v_key) not between 20 and 120
     or v_key !~ '^[A-Za-z0-9:_-]+$' then
    raise exception 'A valid booking hold ID, token and client key are required'
      using errcode = '22023';
  end if;

  -- Same lock order as creation/finalization: browser, date, then row.
  perform pg_advisory_xact_lock(hashtext('booking-hold-client:' || v_key));
  select h.* into v_hold from public.booking_holds h where h.id = p_hold_id;
  if not found then
    raise exception 'Booking hold was not found' using errcode = '22023';
  end if;
  if v_hold.hold_token <> p_hold_token or v_hold.client_key is distinct from v_key then
    raise exception 'Booking hold token is invalid' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_hold.date::text));
  select h.* into v_hold from public.booking_holds h where h.id = p_hold_id for update;
  v_now := clock_timestamp();
  if not found or v_hold.status <> 'active' or v_hold.expires_at <= v_now then
    raise exception 'Your time hold has expired or been released. Please choose a time again.'
      using errcode = '23P01';
  end if;
  if v_hold.hold_token <> p_hold_token or v_hold.client_key is distinct from v_key then
    raise exception 'Booking hold token is invalid' using errcode = '42501';
  end if;

  -- Idempotent retries recover a lost response without granting another extension.
  if v_hold.extended_at is null then
    update public.booking_holds h
    set expires_at = least(h.expires_at + interval '10 minutes', h.created_at + interval '30 minutes'),
        extended_at = v_now
    where h.id = v_hold.id
    returning h.* into v_hold;
  end if;
  return query select v_hold.id, v_hold.expires_at, true;
end;
$$;

revoke all on function public.extend_booking_hold(uuid, uuid, text) from public;
grant execute on function public.extend_booking_hold(uuid, uuid, text) to anon, authenticated;
