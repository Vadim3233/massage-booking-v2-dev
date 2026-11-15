-- Income: three gaps between Paid, Overdue and Upcoming closed (Vadim, 15 Nov 2026). Read-only, Admin only. Nothing here changes a booking or
-- a payment. Applies after 20261129100000_income_calendar_hourly.sql (this replaces admin_income_summary again, keeping all of it).
--
-- 1. Extra still to pay after a paid booking (or one whose transfer was sent, not yet verified) was changed to cost more
--    (bookings.balance_due_gbp, from Edit booking): it was in no bucket.
--    Now it is Upcoming before the session starts and Overdue ("extra not received") once it has started, until Vadim marks it received.
-- 2. A booking part paid by gift voucher: Upcoming counted the full price, while Paid and Overdue count only what the client pays. Upcoming
--    now counts the client's part too (the voucher money was taken when the voucher was bought).
-- 3. A late fee due on a booking cancelled early only showed as Overdue once the original appointment time had passed. A late fee is due
--    as soon as it is set, so it is Overdue straight away (still on the appointment's day).
--
-- To take this back: run money_owed_lines from 20261109100000_income.sql (with "create function" changed to "create or replace function")
-- and admin_income_summary from 20261129100000_income_calendar_hourly.sql again, then drop function public.income_to_come_lines(date, date).

-- Money still to come: one line per booking from p_from to p_to whose appointment has not started yet, going ahead, with money not paid
-- yet: what the client still pays (a voucher's part is not counted) plus any extra still to pay (also on a transfer sent but not yet
-- verified when the booking was changed), or only the extra on a booking already paid.
-- Internal: only admin_income_summary calls it.
create or replace function public.income_to_come_lines(p_from date, p_to date)
returns table (booking_id uuid, date date, to_come_gbp numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.date,
    case when p.status = 'paid' then b.balance_due_gbp
      else coalesce(p.amount_gbp, b.total_gbp - coalesce(b.gift_covered_gbp, 0)) + b.balance_due_gbp end
  from public.bookings b
  left join public.booking_payments p on p.booking_id = b.id
  where b.date between p_from and p_to
    and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp()
    and b.booking_status in ('confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
    and coalesce(p.status, '') <> 'refunded'
    and (coalesce(p.status, '') <> 'paid' or b.balance_due_gbp > 0);
$$;
revoke all on function public.income_to_come_lines(date, date) from public, anon, authenticated;

-- Money owed (Overdue): as 20261109100000_income.sql, plus the extra still to pay on a paid booking once its session has started, and a
-- late fee due from the moment it is set rather than from the appointment's time.
create or replace function public.money_owed_lines()
returns table (booking_id uuid, date date, start_minutes integer, client_name text, amount_gbp numeric, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.date, b.start_minutes,
    nullif(btrim(concat_ws(' ', btrim(c.first_name), nullif(btrim(c.last_name), ''))), ''),
    case
      when b.booking_status in ('cancelled', 'no_show') then b.late_fee_due_gbp
      when p.status = 'paid' then b.balance_due_gbp
      else coalesce(p.amount_gbp, b.total_gbp) + b.balance_due_gbp
    end,
    case
      when b.booking_status in ('cancelled', 'no_show') then 'late fee unpaid'
      when p.status = 'paid' then 'extra not received'
      when p.method = 'cash' then 'cash not marked received'
      else 'transfer not received'
    end
  from public.bookings b
  left join public.booking_payments p on p.booking_id = b.id
  left join public.clients c on c.id = b.client_id
  where (
      ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp()
      and b.booking_status in ('confirmed', 'completed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
      and (p.status in ('awaiting_transfer', 'awaiting_verification', 'awaiting_approval', 'approved')
        or (p.status = 'paid' and b.balance_due_gbp > 0))
    )
    -- A fee still due, unless the booking was paid (then it is in the payment already).
    or (b.booking_status in ('cancelled', 'no_show') and b.late_fee_status = 'due' and coalesce(p.status, '') not in ('paid', 'refunded'))
  order by b.date desc, b.start_minutes desc;
$$;
revoke all on function public.money_owed_lines() from public, anon, authenticated;

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
            select sum(t.to_come_gbp) from public.income_to_come_lines(d, d) t), 0) else 0 end) order by d)
      from generate_series(v_from, v_to, interval '1 day') g(d0) cross join lateral (select g.d0::date as d) x) end,
    'hours', (select public.income_hour_figures(sum(work_minutes)::integer, sum(travel_minutes)::integer, sum(earned_gbp)) from public.income_work_lines(v_from, v_to))
      || jsonb_build_object('areas', coalesce((select jsonb_agg(a.figures || jsonb_build_object('name', a.area)
            order by (a.figures->>'per_hour_gbp')::numeric desc nulls last, a.area)
          from (select area, public.income_hour_figures(sum(work_minutes)::integer, sum(travel_minutes)::integer, sum(earned_gbp)) as figures
                from public.income_work_lines(v_from, v_to) group by area) a), '[]'::jsonb)),
    'owed_count', (select count(distinct booking_id) from public.money_owed_lines()),
    -- Still to come (Upcoming): income_to_come_lines from today to the end of the period. Never part of the total.
    'still_to_come_gbp', case when v_to >= v_today then coalesce((
        select sum(t.to_come_gbp) from public.income_to_come_lines(greatest(v_from, v_today), v_to) t), 0) end)
  into v_result;
  return v_result;
end;
$$;
revoke all on function public.admin_income_summary(text, date) from public, anon;
grant execute on function public.admin_income_summary(text, date) to authenticated;
