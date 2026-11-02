-- VAD Massage Booking V2
-- A fee for moving a booking late, on a booking that then went ahead, now shows in Money owed and counts in Income (ADR-089).
--
-- Before: Money owed listed late fees only for cancelled or missed bookings, and Income left out a fee marked received whenever the booking
-- was paid, assuming it had been kept out of the payment. That is only true when the booking was cancelled or missed: a booking that went
-- ahead keeps its whole payment for the appointment, so the fee for moving it late is extra money, owed and then received on top.

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
        and (b.booking_status not in ('cancelled', 'no_show') or coalesce(p.status, '') not in ('paid', 'refunded'))
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

create or replace function public.money_owed_lines()
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
  union all
  -- A fee for moving a booking late, on a booking that went ahead: it is owed on top of the price, paid or not.
  select b.id, b.date, b.start_minutes,
    nullif(btrim(concat_ws(' ', btrim(c.first_name), nullif(btrim(c.last_name), ''))), ''),
    b.late_fee_due_gbp, 'late fee unpaid'
  from public.bookings b
  left join public.clients c on c.id = b.client_id
  where ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp()
    and b.booking_status not in ('cancelled', 'no_show') and b.late_fee_status = 'due' and b.late_fee_due_gbp > 0
  order by 2 desc, 3 desc;
$$;
