-- VAD Massage Booking V2
-- Holding a time needs a session (ADR-086).
--
-- Before: anyone with the public key could hold a time with a made-up browser key and no limit, so a script could hold every free time
-- for the next 40 days and keep renewing, and real clients would see nothing free. Now a hold needs a session (a signed-in client, or the
-- guest session the booking page starts quietly before holding), each session holds one time at most, and guest sessions are
-- rate-limited by Supabase Auth (30 an hour per address by default). Extending, releasing and reading times are unchanged.

alter table public.booking_holds add column if not exists holder_user_id uuid references auth.users(id) on delete set null;
create index if not exists booking_holds_active_holder_idx on public.booking_holds(holder_user_id) where status = 'active';

-- create_booking_hold: as before (20261017100000_booking_rules_settings.sql), plus the session rule.
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
  v_user uuid := auth.uid();
begin
  -- A time is held for a session (a signed-in client, or a guest session the booking page starts quietly). Guest sessions are
  -- rate-limited by Supabase Auth, so nobody can hold every free time from one computer without signing in.
  if v_user is null then
    raise exception 'Please refresh the page and choose your time again.' using errcode = '42501';
  end if;

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

  -- Own current hold must not block moving or refreshing the selection. One session holds one time at most, whatever browser key
  -- it sends.
  update public.booking_holds as h
  set
    status = 'released',
    expires_at = least(h.expires_at, v_now)
  where (h.client_key = v_client_key or h.holder_user_id = v_user)
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
    status,
    holder_user_id
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
    'active',
    v_user
  )
  returning * into v_hold;

  hold_id := v_hold.id;
  hold_token := v_hold.hold_token;
  expires_at := v_hold.expires_at;
  return next;
end;
$function$;

revoke all on function public.create_booking_hold(date, integer, integer, text) from public, anon;
grant execute on function public.create_booking_hold(date, integer, integer, text) to authenticated, service_role;
