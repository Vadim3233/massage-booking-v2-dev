-- Income: a calendar for the month and "Your hour" (Vadim, 6 Nov 2026). Read-only, Admin only. Nothing here changes a booking or a payment.
-- Numbered after 20261128100000_review_follow_ups.sql (PR #90), which also replaces admin_income_summary: this version keeps that change
-- (owed_count counts each booking once) and must be the last one applied.
-- admin_income_summary keeps every figure it had and adds:
--   days:  for a month, one entry per day: money received for that day's appointments, and money still to come from appointments later
--          that day that are going ahead and not yet paid (the same rule as still_to_come_gbp).
--   hours: what an hour of work earned. Only appointments that went ahead and brought money count (a late fee from a cancellation took no
--          time, so it is left out of this figure). Work is each appointment's treatment time. Travel is the travel time set on each
--          appointment (usually 1 hour), counted once for the journey to it, plus once more for the journey home after the last one of the day.
--          areas: the same, split by the appointment's area, best paying first.
--   bars:  each bar also carries its own work and travel minutes and the money they earned, so the Year view can show each month's hourly rate.

-- One line per appointment that went ahead and brought money, with its time. Internal: only admin_income_summary calls it.
create function public.income_work_lines(p_from date, p_to date)
returns table (booking_id uuid, date date, area text, work_minutes integer, travel_minutes integer, earned_gbp numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with worked as (
    select l.booking_id, l.date, b.start_minutes, btrim(b.service_area_name_snapshot) as area,
      b.treatment_duration_minutes as work, b.travel_buffer_minutes as travel, l.net_gbp
    from public.income_lines(p_from, p_to) l
    join public.bookings b on b.id = l.booking_id
    where l.booking_status not in ('cancelled', 'no_show') and l.net_gbp > 0
  )
  select booking_id, date, area, work,
    travel + case when row_number() over (partition by date order by start_minutes desc, booking_id) = 1 then travel else 0 end,
    net_gbp
  from worked;
$$;
revoke all on function public.income_work_lines(date, date) from public, anon, authenticated;

-- An hourly figure from minutes and money: null when no time was worked.
create function public.income_hour_figures(p_work integer, p_travel integer, p_earned numeric)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('work_minutes', coalesce(p_work, 0), 'travel_minutes', coalesce(p_travel, 0), 'earned_gbp', coalesce(p_earned, 0),
    'per_hour_gbp', case when coalesce(p_work, 0) + coalesce(p_travel, 0) > 0
      then round(coalesce(p_earned, 0) / ((p_work + p_travel) / 60.0), 2) end);
$$;
revoke all on function public.income_hour_figures(integer, integer, numeric) from public, anon, authenticated;

create or replace function public.admin_income_summary(p_kind text, p_anchor date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
  v_prev_from date;
  v_prev_to date;
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_total numeric;
  v_previous numeric;
  v_count integer;
  v_result jsonb;
begin
  perform public.require_booking_admin();
  if p_anchor is null or p_kind is null or p_kind not in ('week', 'month', 'year', 'tax_year') then
    raise exception 'Unknown period' using errcode = '22023';
  end if;
  select period_from, period_to into v_from, v_to from public.income_period(p_kind, p_anchor);
  select period_from, period_to into v_prev_from, v_prev_to from public.income_period(p_kind, v_from - 1);
  select coalesce(sum(net_gbp), 0), count(*) filter (where net_gbp > 0) into v_total, v_count from public.income_lines(v_from, v_to);
  select coalesce(sum(net_gbp), 0) into v_previous from public.income_lines(v_prev_from, v_prev_to);
  select jsonb_build_object(
    'kind', p_kind, 'from', v_from, 'to', v_to, 'previous_from', v_prev_from, 'previous_to', v_prev_to,
    'upcoming', v_from > v_today,
    'total_gbp', v_total,
    'previous_gbp', v_previous,
    'change_percent', case when v_previous > 0 then round((v_total - v_previous) / v_previous * 100) end,
    'bank_gbp', coalesce((select sum(net_gbp) from public.income_lines(v_from, v_to) where method = 'bank_transfer'), 0),
    'cash_gbp', coalesce((select sum(net_gbp) from public.income_lines(v_from, v_to) where method = 'cash'), 0),
    'bookings', v_count,
    'average_gbp', case when v_count > 0 then round(v_total / v_count, 2) end,
    -- Bars: the days of a week, the weeks (Monday to Sunday) of a month, the months of a year, each kept within the period.
    'bars', (select jsonb_agg(jsonb_build_object('from', s, 'to', e,
        'total_gbp', coalesce((select sum(net_gbp) from public.income_lines(s, e)), 0))
        || (select public.income_hour_figures(sum(w.work_minutes)::integer, sum(w.travel_minutes)::integer, sum(w.earned_gbp))
            from public.income_work_lines(v_from, v_to) w where w.date between s and e) order by s)
      from (
        select greatest(g::date, v_from) as s,
          least(case p_kind when 'week' then g::date when 'month' then g::date + 6 else (g + interval '1 month')::date - 1 end, v_to) as e
        from generate_series(
          case p_kind when 'week' then v_from when 'month' then v_from - (extract(isodow from v_from)::integer - 1) else date_trunc('month', v_from)::date end,
          v_to,
          case p_kind when 'week' then interval '1 day' when 'month' then interval '7 days' else interval '1 month' end) g
      ) buckets),
    -- Days: only for a month, the calendar's squares.
    'days', case when p_kind = 'month' then (select jsonb_agg(jsonb_build_object('date', d,
        'received_gbp', coalesce((select sum(net_gbp) from public.income_lines(d, d)), 0),
        'to_come_gbp', case when d >= v_today then coalesce((
            select sum(b.total_gbp) from public.bookings b left join public.booking_payments p on p.booking_id = b.id
            where b.date = d
              and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp()
              and b.booking_status in ('confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
              and coalesce(p.status, '') not in ('paid', 'refunded')), 0) else 0 end) order by d)
      from generate_series(v_from, v_to, interval '1 day') g(d0) cross join lateral (select g.d0::date as d) x) end,
    'hours', (select public.income_hour_figures(sum(work_minutes)::integer, sum(travel_minutes)::integer, sum(earned_gbp)) from public.income_work_lines(v_from, v_to))
      || jsonb_build_object('areas', coalesce((select jsonb_agg(a.figures || jsonb_build_object('name', a.area)
            order by (a.figures->>'per_hour_gbp')::numeric desc nulls last, a.area)
          from (select area, public.income_hour_figures(sum(work_minutes)::integer, sum(travel_minutes)::integer, sum(earned_gbp)) as figures
                from public.income_work_lines(v_from, v_to) group by area) a), '[]'::jsonb)),
    'owed_count', (select count(distinct booking_id) from public.money_owed_lines()),
    -- Still to come: appointments from now to the end of the period that are going ahead and not yet paid. Never part of the total.
    'still_to_come_gbp', case when v_to >= v_today then coalesce((
        select sum(b.total_gbp) from public.bookings b left join public.booking_payments p on p.booking_id = b.id
        where b.date between greatest(v_from, v_today) and v_to
          and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp()
          and b.booking_status in ('confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
          and coalesce(p.status, '') not in ('paid', 'refunded')), 0) end)
  into v_result;
  return v_result;
end;
$$;
revoke all on function public.admin_income_summary(text, date) from public, anon;
grant execute on function public.admin_income_summary(text, date) to authenticated;
