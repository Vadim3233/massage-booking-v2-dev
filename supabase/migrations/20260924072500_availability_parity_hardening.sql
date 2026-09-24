-- VAD Massage Booking V2
-- Availability parity hardening.
-- Keep one parameterized scheduling implementation so database contract tests
-- can prove the same travel-buffer behavior as the JavaScript Chain Mode engine.

create or replace function public.compute_booking_availability(
  p_date date,
  p_treatment_duration_minutes integer,
  p_now timestamptz,
  p_travel_buffer_minutes integer
)
returns table (start_minutes integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- Preserve the original internal signature as a compatibility wrapper.
create or replace function public.compute_booking_availability(
  p_date date,
  p_treatment_duration_minutes integer,
  p_now timestamptz
)
returns table (start_minutes integer)
language sql
security definer
set search_path = public, pg_temp
as $$
  select a.start_minutes
  from public.compute_booking_availability(
    p_date,
    p_treatment_duration_minutes,
    p_now,
    60
  ) a
  order by a.start_minutes;
$$;

create or replace function public.get_booking_availability(
  p_date date,
  p_treatment_duration_minutes integer
)
returns table (start_minutes integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  return query
  select a.start_minutes
  from public.compute_booking_availability(
    p_date,
    p_treatment_duration_minutes,
    now(),
    60
  ) a
  order by a.start_minutes;
end;
$$;

revoke all on function public.compute_booking_availability(date, integer, timestamptz, integer)
  from public;
revoke all on function public.compute_booking_availability(date, integer, timestamptz, integer)
  from anon;
revoke all on function public.compute_booking_availability(date, integer, timestamptz, integer)
  from authenticated;

revoke all on function public.compute_booking_availability(date, integer, timestamptz)
  from public;
revoke all on function public.compute_booking_availability(date, integer, timestamptz)
  from anon;
revoke all on function public.compute_booking_availability(date, integer, timestamptz)
  from authenticated;

revoke all on function public.get_booking_availability(date, integer) from public;
revoke all on function public.get_booking_availability(date, integer) from anon;
grant execute on function public.get_booking_availability(date, integer) to authenticated;
