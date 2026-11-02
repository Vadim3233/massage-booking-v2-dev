-- VAD Massage Booking V2
-- Follow-ups from an independent review of the security fixes (ADR-093).
--
-- 1. A late fee for moving a booking, taken on its own while the booking was still on, is recorded as such
--    (bookings.late_fee_paid_separately). If the client later cancels, that fee is not taken a second time out of the payment, and Income
--    keeps counting it.
-- 2. get_my_change_terms says when the cancel fee comes from an earlier late move (fee_from_late_move), so the page can word it truthfully.
-- 3. Income's "appointments owed money" counts appointments, not lines (an appointment can owe its payment and a late fee).
-- 4. A held time accepted at Reserve because it still fits (ADR-090) also needs blocked time kept clear of its travel time on both sides,
--    never looser than the times the booking page offers.
-- 5. Tables created later do not get TRUNCATE, TRIGGER, REFERENCES or MAINTAIN for anonymous or signed-in users (ADR-091).

alter table public.bookings add column if not exists late_fee_paid_separately boolean not null default false;

create or replace function public.admin_settle_late_fee(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz, p_action text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_date date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_settle_late_fee', p_booking_id::text, extract(epoch from p_booking_updated_at)::text, coalesce(p_action, '')));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_action is null or p_action not in ('received', 'waive') then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  if b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at or b.late_fee_status <> 'due' then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_command := public.admin_finish_command('admin_settle_late_fee', p_request_id, v_fingerprint, b.id);
  update public.bookings set
    late_fee_status = case p_action when 'received' then 'received' else 'waived' end,
    late_fee_due_gbp = case p_action when 'received' then late_fee_due_gbp else 0 end,
    -- A fee taken while the booking is still on (for moving it late) is money on top of the payment, not out of it.
    late_fee_paid_separately = (p_action = 'received' and b.booking_status not in ('cancelled', 'no_show'))
  where id = b.id;
  perform public.admin_lifecycle_event('booking.late_fee_settled', v_command, b.id, jsonb_build_object('action', p_action));
  return b.id;
end;
$$;

create or replace function public.apply_booking_cancellation(
  b public.bookings, p public.booking_payments, p_reason text, p_initiated_by text, p_fee_override numeric,
  p_actor_type text, p_actor_id text, p_now timestamptz
) returns table(out_standard numeric, out_fee numeric, out_refund numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_standard numeric(10,2);
  v_fee numeric(10,2);
  v_refund numeric(10,2) := 0;
  v_paid boolean := p.status = 'paid';
  -- A fee already taken (marked received) stays received when the same amount is kept.
  v_already_received boolean := b.late_fee_status = 'received';
  -- A fee already taken on its own (ADR-093) is not taken a second time out of the payment.
  v_separate numeric(10,2) := case when b.late_fee_status = 'received' and b.late_fee_paid_separately then coalesce(b.late_fee_due_gbp, 0) else 0 end;
begin
  v_standard := case when p_initiated_by = 'admin' then 0 else public.late_fee_on_cancel_gbp(b, p_now) end;
  v_fee := coalesce(p_fee_override, v_standard);
  if v_fee < 0 or v_fee > b.total_gbp then
    raise exception 'The fee must be between zero and the appointment price' using errcode = '22023';
  end if;
  if v_paid then
    v_refund := greatest(p.amount_gbp - greatest(v_fee - v_separate, 0), 0);
  elsif p.status in ('awaiting_transfer', 'awaiting_verification', 'awaiting_approval', 'approved') then
    update public.booking_payments set status = 'rejected' where id = p.id;
  end if;
  update public.bookings set booking_status = 'cancelled', cancelled_at = p_now, cancelled_by_actor_type = p_actor_type,
    cancelled_by_actor_id = p_actor_id, cancellation_reason = p_reason, cancellation_initiated_by = p_initiated_by,
    payment_reservation_expires_at = null, late_fee_standard_gbp = v_standard, late_fee_due_gbp = v_fee,
    late_fee_status = case when v_fee = 0 then (case when v_standard > 0 then 'waived' else 'none' end)
                           when v_paid or (v_already_received and v_fee <= coalesce(b.late_fee_due_gbp, 0)) then 'received'
                           else 'due' end,
    refund_due_gbp = v_refund
  where id = b.id;
  return query select v_standard, v_fee, v_refund;
end;
$$;

CREATE OR REPLACE FUNCTION public.get_my_change_terms(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype := public.client_booking_for_change(p_booking_id);
  v_now timestamptz := clock_timestamp();
  v_start timestamptz := (b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London';
  v_open boolean;
begin
  v_open := b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') and v_start > v_now;
  return jsonb_build_object(
    'can_change', v_open,
    'free_until', greatest(b.created_at + make_interval(mins => public.business_setting_int('grace_minutes', 60)), v_start - make_interval(hours => public.business_setting_int('free_cancellation_hours', 24))),
    'free_cancellation_hours', public.business_setting_int('free_cancellation_hours', 24),
    'cancel_fee_gbp', case when v_open then public.late_fee_on_cancel_gbp(b, v_now) else 0 end,
    'reschedule_fee_gbp', case when v_open then public.change_fee_gbp(b, 'client', v_now) else 0 end,
    -- The cancel fee comes from an earlier late move rather than from this date, so the page words it that way.
    'fee_from_late_move', v_open and b.late_fee_status in ('due', 'received') and coalesce(b.late_fee_due_gbp, 0) > 0
      and public.late_fee_standard_gbp(b.total_gbp, b.date, b.start_minutes, b.created_at, v_now) < coalesce(b.late_fee_due_gbp, 0),
    'total_gbp', b.total_gbp);
end;
$function$;

create or replace function public.income_lines(p_from date, p_to date)
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
      -- A late fee counts on its own unless it was kept out of the payment of a cancelled or missed booking (that money is already in the
      -- payment). A fee for moving a booking late that then went ahead is paid on top of the price, so it always counts on its own.
      case when b.late_fee_status = 'received'
        and (b.booking_status not in ('cancelled', 'no_show') or coalesce(p.status, '') not in ('paid', 'refunded') or b.late_fee_paid_separately)
        then b.late_fee_due_gbp else 0 end as late_fee_gbp
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
        'total_gbp', coalesce((select sum(net_gbp) from public.income_lines(s, e)), 0)) order by s)
      from (
        select greatest(g::date, v_from) as s,
          least(case p_kind when 'week' then g::date when 'month' then g::date + 6 else (g + interval '1 month')::date - 1 end, v_to) as e
        from generate_series(
          case p_kind when 'week' then v_from when 'month' then v_from - (extract(isodow from v_from)::integer - 1) else date_trunc('month', v_from)::date end,
          v_to,
          case p_kind when 'week' then interval '1 day' when 'month' then interval '7 days' else interval '1 month' end) g
      ) buckets),
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

create or replace function public.held_time_still_fits(p_date date, p_start integer, p_duration integer, p_buffer integer, p_now timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_available boolean;
  v_working_start integer;
  v_working_end integer;
begin
  select o.available, o.start_minutes, o.end_minutes into v_available, v_working_start, v_working_end
  from public.working_hours_overrides o where o.date = p_date;
  if not found then
    select w.available, w.start_minutes, w.end_minutes into v_available, v_working_start, v_working_end
    from public.working_hours w where w.weekday = extract(isodow from p_date)::smallint;
  end if;
  if not found or not v_available or p_start < v_working_start or p_start + p_duration > v_working_end then
    return false;
  end if;
  if exists (select 1 from public.calendar_blocks cb
             where cb.date = p_date and p_start - p_buffer < cb.end_minutes and p_start + p_duration + p_buffer > cb.start_minutes) then
    return false;
  end if;
  return not exists (
    select 1 from public.bookings b
    where b.date = p_date
      and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed')
      and p_start < b.start_minutes + b.treatment_duration_minutes + p_buffer
      and p_start + p_duration + p_buffer > b.start_minutes
    union all
    select 1 from public.booking_holds h
    where h.date = p_date and h.status = 'active' and h.expires_at > p_now
      and p_start < h.start_minutes + h.treatment_duration_minutes + p_buffer
      and p_start + p_duration + p_buffer > h.start_minutes
  );
end;
$$;

alter default privileges for role postgres in schema public revoke truncate, trigger, references, maintain on tables from anon, authenticated;
