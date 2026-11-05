-- Holding a time now needs a session, and one session can hold at most three times at once.
--
-- Why (security check, 4 Nov 2026): create_booking_hold could be called by anyone with no login. Its only identity was the browser key,
-- which the browser makes up itself, so a script could invent a new key for every free time and hold the whole calendar, 20 minutes at a
-- time, over and over. Nothing private leaks, but real clients would see no free times.
--
-- The fix: the caller must have a session, either a signed-in account or a guest (anonymous) session. The booking page now starts a quiet
-- guest session just before the first hold, so nothing changes for a visitor. A session is the thing Supabase can limit: anonymous
-- sign-ins are rate-limited per IP address (Authentication > Rate limits) and can be protected with a captcha. Each hold records the
-- session that made it, and one session may keep at most three active holds at once. A browser's own previous hold is still let go
-- first, exactly as before, so "choose a different time" always works, even at the limit. A normal visitor only ever has one.
--
-- Unchanged: the browser key rules, retries returning the same hold, extensions, release, availability, and finalising (an account that
-- signs in after a guest held the time still finalises with the browser key, as before).
--
-- Deploy order: the web app that starts a guest session before holding works with the OLD function too, so it goes FIRST (merge),
-- and this migration is applied AFTER it is live. Applied before it, logged-out visitors on the old page could not hold a time.

alter table public.booking_holds
  add column if not exists holder_user_id uuid;

comment on column public.booking_holds.holder_user_id is
  'The session (auth user, guest or account) that made the hold. Old holds and holds made before this column existed are null.';

create index if not exists booking_holds_holder_active_idx
  on public.booking_holds (holder_user_id, expires_at)
  where status = 'active';

create or replace function public.create_booking_hold(p_date date, p_start_minutes integer, p_treatment_duration_minutes integer, p_client_key text)
 returns table(hold_id uuid, hold_token uuid, expires_at timestamp with time zone)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_now timestamptz := now();
  v_client_key text := btrim(coalesce(p_client_key, ''));
  v_holder uuid := auth.uid();
  v_holder_others integer;
  v_london_today date := (now() at time zone 'Europe/London')::date;
  v_london_now_minutes integer := (
    extract(hour from now() at time zone 'Europe/London')::integer * 60
    + extract(minute from now() at time zone 'Europe/London')::integer
  );
  v_existing_hold_id uuid;
  v_hold public.booking_holds%rowtype;
begin
  -- New: a hold needs a session (a guest session is enough). The page starts one before holding.
  if v_holder is null then
    raise exception 'Please refresh the page and choose your time again.'
      using errcode = '42501';
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

  -- New: serialize per session too, so parallel calls with different keys cannot all pass the count below.
  -- Taken after the key lock and before the date lock; nothing else takes this lock, so the order cannot deadlock.
  perform pg_advisory_xact_lock(hashtext('booking-hold-holder:' || v_holder::text));

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

  -- New: one session may keep at most three active holds at once (this browser's own hold was let go just above).
  select count(*) into v_holder_others
  from public.booking_holds h
  where h.holder_user_id = v_holder
    and h.status = 'active'
    and h.expires_at > v_now
    and h.client_key is distinct from v_client_key;
  if v_holder_others >= 3 then
    raise exception 'You are already holding times in other windows. Please finish one of those bookings, or wait 20 minutes and try again.'
      using errcode = '23P01';
  end if;

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
    holder_user_id,
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
    v_holder,
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

-- Grants are unchanged (create or replace keeps them). Logged-out callers still reach the function, so an old open page gets the
-- "refresh the page" sentence above instead of a bare permission error.
