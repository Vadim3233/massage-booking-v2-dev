-- VAD Massage Booking V2
-- A day's schedule mode: Chain (as always) or Flexible.
--
-- Until now every day worked as a chain: once someone has booked, new bookings can only be added to the two ends of the day's run
-- of appointments, so the day stays in one block with no gaps. Each day can now be set to Flexible instead. A flexible day, once it
-- has appointments, offers every half-hour start that leaves room for the travel time on both sides of every other appointment,
-- gaps between appointments included. An empty day is not affected by the mode: it still follows its first appointment and release
-- time, so a flexible day with a first appointment at a set time offers only that time until someone books.
--
-- The mode is set where the hours are set: on a weekday of the usual week and on a special day. A special day replaces the usual
-- week for its date, mode included, so a special day that was saved without a mode is a chain day. Every existing day stays Chain.
-- The mode only means something on a working day; a day off keeps the default.

-- This builds on 20261030100000_anchor_release.sql: the availability function below also reads the release time. If that change has not been
-- applied yet, stop here with a plain message, rather than leave the booking page with a function that cannot run.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'working_hours' and column_name = 'anchor_release_minutes'
  ) then
    raise exception 'Apply 20261030100000_anchor_release.sql first: this change builds on it.';
  end if;
end;
$$;

alter table public.working_hours
  add column schedule_mode text not null default 'chain',
  add constraint working_hours_schedule_mode_valid check (schedule_mode in ('chain', 'flexible'));

alter table public.working_hours_overrides
  add column schedule_mode text not null default 'chain',
  add constraint working_hours_overrides_schedule_mode_valid check (schedule_mode in ('chain', 'flexible'));

-- The times offered for a day: the same function as before, with one new rule (the flexible branch, marked below). Its signature is
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
  v_schedule_mode text;
  v_first_end integer;
  v_item_starts integer[];
  v_item_ends integer[];
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
    o.anchor_release_minutes,
    o.schedule_mode
  into
    v_available,
    v_working_start,
    v_working_end,
    v_start_mode,
    v_fixed_start,
    v_release,
    v_schedule_mode
  from public.working_hours_overrides o
  where o.date = p_date;

  if not found then
    select
      w.available,
      w.start_minutes,
      w.end_minutes,
      w.start_mode,
      w.fixed_start_minutes,
      w.anchor_release_minutes,
      w.schedule_mode
    into
      v_available,
      v_working_start,
      v_working_end,
      v_start_mode,
      v_fixed_start,
      v_release,
      v_schedule_mode
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
    max(chain.end_minutes)::integer,
    min(chain.end_minutes)::integer,
    array_agg(chain.start_minutes order by chain.start_minutes, chain.end_minutes),
    array_agg(chain.end_minutes order by chain.start_minutes, chain.end_minutes)
  into
    v_chain_count,
    v_chain_start,
    v_chain_end,
    v_first_end,
    v_item_starts,
    v_item_ends
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

  -- A flexible day, once it has appointments: every half-hour start that leaves room for the travel on both sides of every other
  -- appointment is offered, gaps between appointments included, instead of only the two ends of the day's run. Blocked time may
  -- not overlap the treatment, nor the travel into it from the appointment before it, nor (when it would be the day's first
  -- appointment) the travel on to the appointment after it. These are the same checks as at the two ends of a chain below, so a
  -- flexible day always offers everything a chain day would. A day with no appointments was handled above, so a first appointment
  -- (and its release time) still decides an empty flexible day.
  if v_schedule_mode = 'flexible' then
    return query
    select candidate
    from generate_series(
      v_working_start,
      v_working_end - p_treatment_duration_minutes,
      30
    ) as candidate
    where not exists (
      select 1
      from unnest(v_item_starts, v_item_ends) as item(s, e)
      where candidate < item.e + p_travel_buffer_minutes
        and candidate + p_treatment_duration_minutes + p_travel_buffer_minutes > item.s
    )
    and not exists (
      select 1
      from public.calendar_blocks cb
      where cb.date = p_date
        and (
          (candidate < cb.end_minutes and candidate + p_treatment_duration_minutes > cb.start_minutes)
          or (candidate >= v_first_end and candidate - p_travel_buffer_minutes < cb.end_minutes and candidate > cb.start_minutes)
          or (candidate < v_first_end and v_chain_start - p_travel_buffer_minutes < cb.end_minutes and v_chain_start > cb.start_minutes)
        )
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
