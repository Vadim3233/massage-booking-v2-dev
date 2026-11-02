-- A client's own held time never blocks the client.
--
-- What happened (2 Nov 2026): a guest held Thursday 15:00, signed up, and came back in a new tab. The new tab had the same browser key
-- (localStorage) but not the hold (sessionStorage), so get_booking_availability counted her own 15:00 hold as someone else's and offered
-- 12:30, chained off it. Pressing 12:30 called create_booking_hold, which first lets go of that browser's own holds, after which 12:30 no
-- longer chained onto anything and was refused; the refusal rolled back, the hold came back, and every attempt went round the same loop.
--
-- The fix: the times offered and the time a hold is checked against must leave out the same thing. get_booking_availability now accepts
-- the browser key on its own, and leaves out that browser's active hold, exactly as create_booking_hold does before it checks.
-- The browser key is a random secret kept in that browser; knowing it only lets someone see the times as that browser would.
--
-- Deploy order: apply this migration BEFORE the web app that sends the key on its own; the old function rejects a key without a hold.

create or replace function public.get_booking_availability(
  p_date date,
  p_treatment_duration_minutes integer,
  p_hold_id uuid default null::uuid,
  p_hold_token uuid default null::uuid,
  p_client_key text default null::text
)
returns table(start_minutes integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_excluded_hold_id uuid;
  v_client_key text := nullif(btrim(coalesce(p_client_key, '')), '');
  v_london_today date := (now() at time zone 'Europe/London')::date;
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

  -- A hold ID and token still only come with the browser key that made them.
  if num_nonnulls(p_hold_id, p_hold_token) > 0 and (num_nonnulls(p_hold_id, p_hold_token) <> 2 or v_client_key is null) then
    raise exception 'Hold ID, token and browser client key must be provided together'
      using errcode = '22023';
  end if;

  if v_client_key is not null and (
    length(v_client_key) < 20
    or length(v_client_key) > 120
    or v_client_key !~ '^[A-Za-z0-9:_-]+$'
  ) then
    raise exception 'A valid booking hold client key is required'
      using errcode = '22023';
  end if;

  if p_hold_id is not null then
    -- Unchanged: a named hold must still be this browser's and still be active.
    select h.id into v_excluded_hold_id
    from public.booking_holds h
    where h.id = p_hold_id
      and h.hold_token = p_hold_token
      and h.client_key = v_client_key
      and h.status = 'active'
      and h.expires_at > v_now
    for share;
    if not found then
      raise exception 'Booking hold identity is invalid or no longer active'
        using errcode = '42501';
    end if;
  elsif v_client_key is not null then
    -- New: the browser key alone leaves out that browser's own hold, even when the page has lost track of which hold it was.
    -- create_booking_hold keeps at most one active hold per key, so there is only one to leave out.
    select h.id into v_excluded_hold_id
    from public.booking_holds h
    where h.client_key = v_client_key
      and h.status = 'active'
      and h.expires_at > v_now
    order by h.created_at desc
    limit 1;
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
