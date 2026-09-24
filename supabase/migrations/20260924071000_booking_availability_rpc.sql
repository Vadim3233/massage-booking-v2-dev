-- VAD Massage Booking V2
-- Booking RPC foundation 1: one shared server-side availability calculation.
-- Public/client callers receive slot start minutes only; calendar block metadata
-- remains private.

create or replace function public.compute_booking_availability(
  p_date date,
  p_treatment_duration_minutes integer,
  p_now timestamptz
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
  v_travel_buffer constant integer := 60;
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

  -- A date-specific override replaces the weekly default when present.
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

  -- Chain Mode uses confirmed/pending bookings plus active, unexpired holds.
  -- Cancelled/no-show rows do not occupy the public chain.
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

  -- Empty day with a fixed start: expose only that anchor.
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

  -- Empty flexible day: every 30-minute treatment start that fits working
  -- hours and does not overlap a calendar block.
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

  -- Existing chain: expose only the two outside edges.
  -- Before = treatment -> travel -> existing chain.
  v_candidate :=
    v_chain_start - v_travel_buffer - p_treatment_duration_minutes;

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

  -- After = existing chain -> travel -> treatment.
  v_candidate := v_chain_end + v_travel_buffer;

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

revoke all on function public.compute_booking_availability(date, integer, timestamptz)
  from public;
revoke all on function public.compute_booking_availability(date, integer, timestamptz)
  from anon;
revoke all on function public.compute_booking_availability(date, integer, timestamptz)
  from authenticated;

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
    now()
  ) a
  order by a.start_minutes;
end;
$$;

revoke all on function public.get_booking_availability(date, integer) from public;
revoke all on function public.get_booking_availability(date, integer) from anon;
grant execute on function public.get_booking_availability(date, integer) to authenticated;
