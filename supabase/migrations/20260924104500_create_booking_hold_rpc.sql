-- VAD Massage Booking V2
-- Booking RPC foundation 2: pre-auth booking holds for the public booking flow.
-- V1 behavior preserved: a client may reserve the selected slot before the
-- "Your Details" step, using an opaque browser client key plus a hold token.

alter table public.booking_holds
  alter column client_id drop not null;

alter table public.booking_holds
  add column client_key text;

alter table public.booking_holds
  add column hold_token uuid;

update public.booking_holds
set hold_token = gen_random_uuid()
where hold_token is null;

alter table public.booking_holds
  alter column hold_token set default gen_random_uuid();

alter table public.booking_holds
  alter column hold_token set not null;

alter table public.booking_holds
  add constraint booking_holds_client_key_valid
  check (
    client_key is null
    or (
      length(client_key) between 20 and 120
      and client_key ~ '^[A-Za-z0-9:_-]+$'
    )
  );

create index booking_holds_client_key_active_idx
  on public.booking_holds (client_key, expires_at)
  where client_key is not null and status = 'active';

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

  -- Own current hold must not block moving or refreshing the selection.
  update public.booking_holds
  set
    status = 'released',
    expires_at = least(expires_at, v_now)
  where client_key = v_client_key
    and status = 'active'
    and expires_at > v_now;

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

  if v_existing_hold_id is not null then
    update public.booking_holds
    set
      client_id = null,
      client_key = v_client_key,
      hold_token = gen_random_uuid(),
      date = p_date,
      start_minutes = p_start_minutes,
      treatment_duration_minutes = p_treatment_duration_minutes,
      travel_buffer_minutes = 60,
      expires_at = v_now + interval '10 minutes',
      status = 'active'
    where id = v_existing_hold_id
    returning * into v_hold;
  else
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
      v_now + interval '10 minutes',
      'active'
    )
    returning * into v_hold;
  end if;

  hold_id := v_hold.id;
  hold_token := v_hold.hold_token;
  expires_at := v_hold.expires_at;
  return next;
end;
$$;

create or replace function public.release_booking_hold(
  p_hold_id uuid,
  p_hold_token uuid,
  p_client_key text
)
returns table (
  hold_id uuid,
  released boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client_key text := btrim(coalesce(p_client_key, ''));
  v_hold public.booking_holds%rowtype;
begin
  if p_hold_id is null or p_hold_token is null then
    raise exception 'Booking hold ID and token are required'
      using errcode = '22023';
  end if;

  if (
    length(v_client_key) < 20
    or length(v_client_key) > 120
    or v_client_key !~ '^[A-Za-z0-9:_-]+$'
  ) then
    raise exception 'A valid booking hold client key is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('booking-hold-client:' || v_client_key));

  select h.*
  into v_hold
  from public.booking_holds h
  where h.id = p_hold_id
  for update;

  if not found then
    raise exception 'Booking hold was not found'
      using errcode = '22023';
  end if;

  if (
    v_hold.hold_token <> p_hold_token
    or v_hold.client_key is distinct from v_client_key
  ) then
    raise exception 'Booking hold token is invalid'
      using errcode = '42501';
  end if;

  hold_id := v_hold.id;

  if v_hold.status <> 'active' or v_hold.expires_at <= now() then
    released := false;
    return next;
    return;
  end if;

  update public.booking_holds
  set
    status = 'released',
    expires_at = least(expires_at, now())
  where id = v_hold.id;

  released := true;
  return next;
end;
$$;

revoke all on function public.create_booking_hold(date, integer, integer, text)
  from public;
revoke all on function public.release_booking_hold(uuid, uuid, text)
  from public;

grant execute on function public.create_booking_hold(date, integer, integer, text)
  to anon, authenticated;
grant execute on function public.release_booking_hold(uuid, uuid, text)
  to anon, authenticated;
