-- VAD Massage Booking V2
-- Release a first appointment that nobody has booked.
--
-- A day whose first appointment is "at a set time" offers clients only that time until someone books. If nobody does, a client
-- who looks later sees no times at all once that time has passed, or is too close for the notice period, even though the day
-- has hours left. An optional release time fixes that: if nobody has booked the first appointment by that time on the day
-- before (London time), an empty day is offered as "any time in my hours" from then on. Once there is a booking, the day is
-- built around the bookings as always, so the release time changes nothing.
--
-- It is set where the first appointment is set: on a weekday of the usual week and on a special day. A special day replaces the
-- usual week for its date, release time included. It only goes with a set time, so a day with "any time in my hours" or a day
-- off cannot have one.

alter table public.working_hours
  add column anchor_release_minutes integer,
  add constraint working_hours_anchor_release_valid
    check (anchor_release_minutes is null or (start_mode = 'fixed' and anchor_release_minutes between 0 and 1439));

alter table public.working_hours_overrides
  add column anchor_release_minutes integer,
  add constraint working_hours_overrides_anchor_release_valid
    check (anchor_release_minutes is null or (start_mode = 'fixed' and anchor_release_minutes between 0 and 1439));

-- The times offered for a day: the same function as before, with one new rule (the release, marked below). Its signature is
-- unchanged, so the booking page, holds, rescheduling and the Admin's list of usual times all follow it.
CREATE OR REPLACE FUNCTION public.compute_booking_availability(p_date date, p_treatment_duration_minutes integer, p_now timestamp with time zone, p_travel_buffer_minutes integer, p_excluded_hold_id uuid, p_excluded_booking_id uuid)
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
  v_release integer;
  v_released boolean := false;
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
    o.fixed_start_minutes,
    o.anchor_release_minutes
  into
    v_available,
    v_working_start,
    v_working_end,
    v_start_mode,
    v_fixed_start,
    v_release
  from public.working_hours_overrides o
  where o.date = p_date;

  if not found then
    select
      w.available,
      w.start_minutes,
      w.end_minutes,
      w.start_mode,
      w.fixed_start_minutes,
      w.anchor_release_minutes
    into
      v_available,
      v_working_start,
      v_working_end,
      v_start_mode,
      v_fixed_start,
      v_release
    from public.working_hours w
    where w.weekday = extract(isodow from p_date)::smallint;
  end if;

  if not found or not v_available then
    return;
  end if;

  -- A first appointment that nobody has booked can be released the day before: from then on an empty day is offered as
  -- "any time in my hours". The release time is counted in London time, on the previous date.
  v_released := v_release is not null
    and p_now >= ((p_date - 1)::timestamp + make_interval(mins => v_release)) at time zone 'Europe/London';

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
      and b.id is distinct from p_excluded_booking_id
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

  if v_chain_count = 0 and v_start_mode = 'fixed' and not v_released then
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
    and v_candidate + p_treatment_duration_minutes <= v_working_end
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
    v_candidate >= v_working_start
    and v_candidate + p_treatment_duration_minutes <= v_working_end
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
