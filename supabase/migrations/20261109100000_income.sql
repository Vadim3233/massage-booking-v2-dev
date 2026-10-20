-- The Income screen (Vadim's change requests 3 and 4, 20 Oct 2026; docs/change-requests-2026-10-20.md). Read-only, Admin only.
-- Every money rule is here, in one place; the screen only shows what these functions return.
--   Income is money actually received: payments received (bank transfers verified, cash marked received), plus late fees received that were
--   not taken out of a payment, less refunds recorded as sent. Unpaid, still-waiting and agreed-but-not-received cash do not count.
--   Every amount belongs to the period of its appointment's date (London), not the day the money came.
-- Nothing here changes a booking or a payment.

-- One line per booking with money received, for any dates. Internal: only the Admin functions below call it.
create function public.income_lines(p_from date, p_to date)
returns table (booking_id uuid, date date, start_minutes integer, booking_reference text, client_name text, method text, booking_status text,
  received_gbp numeric, refund_gbp numeric, late_fee_gbp numeric, net_gbp numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with money as (
    select b.id, b.date, b.start_minutes, b.booking_reference, b.booking_status, p.method,
      nullif(btrim(concat_ws(' ', btrim(c.first_name), nullif(btrim(c.last_name), ''))), '') as client_name,
      case when p.status in ('paid', 'refunded') then p.amount_gbp else 0 end as paid_gbp,
      -- A refund sent: its recorded amount, or (for one recorded before amounts were kept) what was paid less the fee kept.
      case when p.status = 'refunded'
        then coalesce(p.refunded_gbp, greatest(p.amount_gbp - case when b.late_fee_status = 'received' then b.late_fee_due_gbp else 0 end, 0))
        else 0 end as refund_gbp,
      -- A late fee counts on its own only when it was not kept out of a payment (that money is already in the payment).
      case when b.late_fee_status = 'received' and coalesce(p.status, '') not in ('paid', 'refunded') then b.late_fee_due_gbp else 0 end as late_fee_gbp
    from public.bookings b
    left join public.booking_payments p on p.booking_id = b.id
    left join public.clients c on c.id = b.client_id
    where b.date between p_from and p_to
  )
  select id, date, start_minutes, booking_reference, client_name, method, booking_status,
    paid_gbp + late_fee_gbp, refund_gbp, late_fee_gbp, paid_gbp + late_fee_gbp - refund_gbp
  from money
  where paid_gbp > 0 or late_fee_gbp > 0
  order by date, start_minutes;
$$;
revoke all on function public.income_lines(date, date) from public, anon, authenticated;

create function public.require_booking_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.require_booking_admin() from public, anon, authenticated;

-- The period a date falls in: a week (Monday to Sunday), a month, a calendar year, or a UK tax year (6 April to 5 April).
create function public.income_period(p_kind text, p_anchor date)
returns table (period_from date, period_to date)
language sql
immutable
set search_path = ''
as $$
  select f, t from (select
    case p_kind
      when 'week' then p_anchor - (extract(isodow from p_anchor)::integer - 1)
      when 'month' then date_trunc('month', p_anchor)::date
      when 'year' then date_trunc('year', p_anchor)::date
      when 'tax_year' then make_date(extract(year from p_anchor)::integer - case when p_anchor < make_date(extract(year from p_anchor)::integer, 4, 6) then 1 else 0 end, 4, 6)
    end as f) s
  cross join lateral (select case p_kind
      when 'week' then f + 6
      when 'month' then (f + interval '1 month')::date - 1
      else (f + interval '1 year')::date - 1
    end as t) e
  where p_kind in ('week', 'month', 'year', 'tax_year');
$$;
revoke all on function public.income_period(text, date) from public, anon, authenticated;

-- Appointments that have happened with money still missing: transfers not received, cash not marked received, late fees unpaid.
create function public.money_owed_lines()
returns table (booking_id uuid, date date, start_minutes integer, client_name text, amount_gbp numeric, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.date, b.start_minutes,
    nullif(btrim(concat_ws(' ', btrim(c.first_name), nullif(btrim(c.last_name), ''))), ''),
    case when b.booking_status in ('cancelled', 'no_show') then b.late_fee_due_gbp else coalesce(p.amount_gbp, b.total_gbp) end,
    case
      when b.booking_status in ('cancelled', 'no_show') then 'late fee unpaid'
      when p.method = 'cash' then 'cash not marked received'
      else 'transfer not received'
    end
  from public.bookings b
  left join public.booking_payments p on p.booking_id = b.id
  left join public.clients c on c.id = b.client_id
  where ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp()
    and (
      (b.booking_status in ('confirmed', 'completed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
        and p.status in ('awaiting_transfer', 'awaiting_verification', 'awaiting_approval', 'approved'))
      -- A fee still due, unless the booking was paid (then it is in the payment already).
      or (b.booking_status in ('cancelled', 'no_show') and b.late_fee_status = 'due' and coalesce(p.status, '') not in ('paid', 'refunded'))
    )
  order by b.date desc, b.start_minutes desc;
$$;
revoke all on function public.money_owed_lines() from public, anon, authenticated;

-- The Income screen's figures for one period: the total and how it splits, the comparison with the period before, the bars, how many
-- appointments are owed money, and (for a period not yet over) the money still to come.
create function public.admin_income_summary(p_kind text, p_anchor date)
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
        'total_gbp', coalesce((select sum(net_gbp) from public.income_lines(s, e)), 0)) order by s)
      from (
        select greatest(g::date, v_from) as s,
          least(case p_kind when 'week' then g::date when 'month' then g::date + 6 else (g + interval '1 month')::date - 1 end, v_to) as e
        from generate_series(
          case p_kind when 'week' then v_from when 'month' then v_from - (extract(isodow from v_from)::integer - 1) else date_trunc('month', v_from)::date end,
          v_to,
          case p_kind when 'week' then interval '1 day' when 'month' then interval '7 days' else interval '1 month' end) g
      ) buckets),
    'owed_count', (select count(*) from public.money_owed_lines()),
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

-- The bookings behind a period's total, for the list and the accountant's CSV (a year at most).
create function public.admin_income_rows(p_from date, p_to date)
returns table (booking_id uuid, date date, start_minutes integer, booking_reference text, client_name text, method text, booking_status text,
  received_gbp numeric, refund_gbp numeric, late_fee_gbp numeric, net_gbp numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_booking_admin();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose up to a year' using errcode = '22023';
  end if;
  return query select * from public.income_lines(p_from, p_to);
end;
$$;

-- "Money owed to you": each appointment that has happened with money still missing, and what is missing.
create function public.admin_money_owed()
returns table (booking_id uuid, date date, start_minutes integer, client_name text, amount_gbp numeric, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_booking_admin();
  return query select * from public.money_owed_lines();
end;
$$;

revoke all on function public.admin_income_summary(text, date) from public, anon;
revoke all on function public.admin_income_rows(date, date) from public, anon;
revoke all on function public.admin_money_owed() from public, anon;
grant execute on function public.admin_income_summary(text, date) to authenticated;
grant execute on function public.admin_income_rows(date, date) to authenticated;
grant execute on function public.admin_money_owed() to authenticated;
