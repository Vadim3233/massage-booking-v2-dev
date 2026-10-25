-- VAD Massage Booking V2
-- Admin: choose any time when moving a booking.
--
-- Moving a booking offered only the usual times, the ones the booking page would offer a client. When the booking being moved is the only
-- one that day, the day looks empty once it is set aside, so the usual times shrink to the day's first-appointment time: a day that starts
-- at 12:00 offers 12:00 and nothing else, and the Admin could not move that booking to 17:30 even when the client had asked and she had
-- agreed. New booking has had "Show all times" for this since 20261024100000_admin_any_time.sql; moving a booking now has it too.
--
-- With "any time" the usual run of appointments, the gap between them, working hours, a day off and blocked time are set aside on purpose,
-- exactly as for a new booking. What is still refused: a time that overlaps another appointment, or one a client is in the middle of
-- booking (the booking being moved does not count against itself); a time that has begun; one that would run past midnight; a date more
-- than a year ahead; and any unusual time on a day when a client is part-way through booking (a hold lasts a few minutes), because it
-- could take away the time held for them.
--
-- Nothing changes without "any time": the usual times, the late fee, the history and the messages are all as before, and a call with the
-- six arguments the command had still works. Clients are not affected: they are still offered only the usual times.
--
-- Safe to apply before the new screen is live: the screen that is live today never sends the new argument.

-- ---------------------------------------------------------------------------------------------
-- 1. The overlap check can leave one booking out: the one being moved. (An inside helper. The calls that pass four arguments are unchanged.)
-- ---------------------------------------------------------------------------------------------
drop function public.admin_time_clash(date, integer, integer, timestamptz);
create function public.admin_time_clash(p_date date, p_start integer, p_duration integer, p_now timestamptz, p_exclude_booking_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.bookings b
       where b.date = p_date
         and b.id is distinct from p_exclude_booking_id
         and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed')
         and p_start < b.start_minutes + b.treatment_duration_minutes and b.start_minutes < p_start + p_duration)
    or exists (
      select 1 from public.booking_holds h
       where h.date = p_date and h.status = 'active' and h.expires_at > p_now
         and p_start < h.start_minutes + h.treatment_duration_minutes and h.start_minutes < p_start + p_duration);
$$;
revoke all on function public.admin_time_clash(date, integer, integer, timestamptz, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. All the times of one day, for "Show all times": it can now leave out the booking being moved, so that booking is not listed as in
-- the way, does not overlap itself, and the usual times are worked out as if it were not there.
-- ---------------------------------------------------------------------------------------------
drop function public.admin_booking_times(date, integer);
create function public.admin_booking_times(p_date date, p_treatment_duration_minutes integer, p_exclude_booking_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date;
  v_open boolean;
  v_from integer;
  v_to integer;
  v_usual integer[];
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  v_today := (v_now at time zone 'Europe/London')::date;
  if p_date is null or p_date < v_today or p_date > v_today + 365 then
    raise exception 'Choose a date within the next 365 days' using errcode = '22023';
  end if;
  if p_treatment_duration_minutes is null or p_treatment_duration_minutes not between 60 and 240 or mod(p_treatment_duration_minutes, 30) <> 0 then
    raise exception 'Booking duration is invalid' using errcode = '22023';
  end if;
  select o.available, o.start_minutes, o.end_minutes into v_open, v_from, v_to from public.working_hours_overrides o where o.date = p_date;
  if not found then
    select w.available, w.start_minutes, w.end_minutes into v_open, v_from, v_to from public.working_hours w where w.weekday = extract(isodow from p_date)::smallint;
  end if;
  v_usual := array(select a.start_minutes from public.compute_booking_availability(p_date, p_treatment_duration_minutes, v_now, 60, null, p_exclude_booking_id) a);
  return jsonb_build_object(
    'working', jsonb_build_object('open', coalesce(v_open, false), 'start', v_from, 'end', v_to),
    'buffer_minutes', 60,
    'client_booking', exists (select 1 from public.booking_holds h where h.date = p_date and h.status = 'active' and h.expires_at > v_now),
    'booked', coalesce((
      select jsonb_agg(jsonb_build_object('start', x.start_minutes, 'end', x.end_minutes, 'label', x.label, 'kind', x.kind) order by x.start_minutes, x.end_minutes)
      from (
        select b.start_minutes, b.start_minutes + b.treatment_duration_minutes as end_minutes,
               nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') as label, 'booking'::text as kind
          from public.bookings b join public.clients c on c.id = b.client_id
         where b.date = p_date and b.id is distinct from p_exclude_booking_id and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed')
        union all
        select h.start_minutes, h.start_minutes + h.treatment_duration_minutes, null::text, 'hold'::text
          from public.booking_holds h where h.date = p_date and h.status = 'active' and h.expires_at > v_now
      ) x), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object('start', cb.start_minutes, 'end', cb.end_minutes, 'title', coalesce(nullif(btrim(cb.title), ''), 'Blocked time'), 'series', cb.series_id is not null) order by cb.start_minutes, cb.end_minutes)
      from public.calendar_blocks cb where cb.date = p_date), '[]'::jsonb),
    'slots', coalesce((
      select jsonb_agg(jsonb_build_object('start', s.start_minutes, 'usual', s.start_minutes = any(v_usual),
               'clash', public.admin_time_clash(p_date, s.start_minutes, p_treatment_duration_minutes, v_now, p_exclude_booking_id)) order by s.start_minutes)
      from (select g as start_minutes from generate_series(360, 1440 - p_treatment_duration_minutes, 30) g
            union
            select u from unnest(v_usual) u) s
      where (p_date + make_interval(mins => s.start_minutes)) at time zone 'Europe/London' > v_now), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_booking_times(date, integer, uuid) from public, anon;
grant execute on function public.admin_booking_times(date, integer, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Moving a booking: the same command as before, with an optional "any time" (yes or no).
-- ---------------------------------------------------------------------------------------------
drop function public.admin_reschedule_booking(uuid, uuid, timestamptz, date, integer, text);
create function public.admin_reschedule_booking(
  p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz,
  p_new_date date, p_new_start_minutes integer, p_initiated_by text, p_any_time boolean default false
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
  v_fee numeric(10,2);
begin
  v_fingerprint := md5(concat_ws('|', 'admin_reschedule_booking', p_booking_id::text, extract(epoch from p_booking_updated_at)::text,
    coalesce(p_new_date::text, ''), coalesce(p_new_start_minutes::text, ''), coalesce(p_initiated_by, ''),
    -- Only "any time" adds to it (a missing part is skipped), so a request made without it is fingerprinted exactly as before.
    case when p_any_time is true then 'any_time' end));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_new_date is null or p_new_start_minutes is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if p_initiated_by is null or p_initiated_by not in ('client', 'admin') then
    raise exception 'Say who asked for the change' using errcode = '22023';
  end if;
  if p_new_date < v_today or p_new_date > v_today + 365 or p_new_start_minutes not between 0 and 1439 or mod(p_new_start_minutes, 30) <> 0 then
    raise exception 'Choose a date within the next 365 days and a 30-minute start' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  -- Lock both days in a fixed order so two moves between the same days cannot deadlock.
  perform pg_advisory_xact_lock(42420, hashtext(least(v_date, p_new_date)::text));
  if p_new_date <> v_date then perform pg_advisory_xact_lock(42420, hashtext(greatest(v_date, p_new_date)::text)); end if;
  select * into b from public.bookings where id = p_booking_id for update;
  if b.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at
     or b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  if p_any_time is true then
    -- The usual run of appointments, the gap between them, working hours, a day off and blocked time are set aside on purpose, as for a new
    -- booking with "any time". A double booking is not, nor a time that has begun, nor one that would run past midnight.
    if p_new_start_minutes + b.treatment_duration_minutes > 1440 then
      raise exception 'That appointment would run past midnight. Choose an earlier time.' using errcode = '22023';
    end if;
    if ((p_new_date + make_interval(mins => p_new_start_minutes)) at time zone 'Europe/London') <= v_now then
      raise exception 'That time is in the past. Choose another time.' using errcode = 'PT409';
    end if;
    -- The booking being moved does not count against itself.
    if public.admin_time_clash(p_new_date, p_new_start_minutes, b.treatment_duration_minutes, v_now, b.id) then
      raise exception 'That time overlaps another appointment, so it is not available. Choose another time.' using errcode = 'PT409';
    end if;
    -- A client who is part-way through booking has a time held for them, and it is only confirmed if it is still one of the usual times
    -- when they press Confirm. An appointment at an unusual time elsewhere that day could take that away, so unusual times wait until
    -- no client is booking that day (a hold lasts a few minutes).
    if exists (select 1 from public.booking_holds h where h.date = p_new_date and h.status = 'active' and h.expires_at > v_now) then
      raise exception 'A client is in the middle of booking that day. Try again in a few minutes.' using errcode = 'PT409';
    end if;
  elsif not exists (
    select 1 from public.compute_booking_availability(p_new_date, b.treatment_duration_minutes, v_now, b.travel_buffer_minutes, null, b.id) a
    where a.start_minutes = p_new_start_minutes
  ) or ((p_new_date + make_interval(mins => p_new_start_minutes)) at time zone 'Europe/London') <= v_now then
    raise exception 'This time is not available. Choose another time.' using errcode = 'PT409';
  end if;
  v_fee := public.change_fee_gbp(b, p_initiated_by, v_now);
  v_command := public.admin_finish_command('admin_reschedule_booking', p_request_id, v_fingerprint, b.id);
  perform public.apply_booking_reschedule(b, p_new_date, p_new_start_minutes, v_fee);
  perform public.admin_lifecycle_event('booking.rescheduled', v_command, b.id,
    jsonb_build_object('initiated_by', p_initiated_by, 'from_date', b.date, 'from_start_minutes', b.start_minutes,
      'to_date', p_new_date, 'to_start_minutes', p_new_start_minutes));
  return b.id;
end;
$$;
revoke all on function public.admin_reschedule_booking(uuid, uuid, timestamptz, date, integer, text, boolean) from public, anon;
grant execute on function public.admin_reschedule_booking(uuid, uuid, timestamptz, date, integer, text, boolean) to authenticated;
