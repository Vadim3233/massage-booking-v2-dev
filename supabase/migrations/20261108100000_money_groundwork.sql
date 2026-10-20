-- Money groundwork for the Income screen (Vadim's change requests 3 and 4, 20 Oct 2026; docs/change-requests-2026-10-20.md).
-- A refund now keeps how much was sent back and when (until now only "refunded" was kept, and the amount lived only in an event).
-- Nothing else about bookings, payments or availability changes.

alter table public.booking_payments
  add column refunded_gbp numeric(10,2),
  add column refunded_at timestamptz;

-- Refunds already recorded: the amount sent back is what was paid less the fee kept, and the time is when the payment became refunded.
update public.booking_payments p
set refunded_gbp = greatest(p.amount_gbp - case when b.late_fee_status = 'received' then b.late_fee_due_gbp else 0 end, 0),
    refunded_at = coalesce((select max(e.occurred_at) from public.booking_status_events e
                            where e.payment_id = p.id and e.entity = 'payment' and e.to_status = 'refunded'), p.updated_at)
from public.bookings b
where b.id = p.booking_id and p.status = 'refunded';

alter table public.booking_payments
  -- (Recording a refund always sets both; older refunds made outside it may have neither, so the Income screen falls back to paid less fee kept.)
  add constraint booking_payments_refund_amount_valid check (refunded_gbp is null or (refunded_gbp >= 0 and refunded_gbp <= amount_gbp));

CREATE OR REPLACE FUNCTION public.admin_record_refund(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamp with time zone, p_payment_updated_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_date date;
  v_fingerprint text;
  v_existing uuid;
  v_command uuid;
begin
  v_fingerprint := md5(concat_ws('|', 'admin_record_refund', p_booking_id::text, extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  v_existing := public.admin_begin_command(p_request_id, v_fingerprint);
  if v_existing is not null then return v_existing; end if;
  if p_booking_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  select date into v_date from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at or p.updated_at is distinct from p_payment_updated_at
     or b.booking_status <> 'cancelled' or p.status <> 'paid' or b.refund_due_gbp <= 0 then
    raise exception 'Booking state changed' using errcode = 'PT409';
  end if;
  v_command := public.admin_finish_command('admin_record_refund', p_request_id, v_fingerprint, b.id);
  -- How much went back and when are kept with the payment, for the Income screen.
  update public.booking_payments set status = 'refunded', refunded_gbp = b.refund_due_gbp, refunded_at = clock_timestamp() where id = p.id;
  update public.bookings set refund_due_gbp = 0 where id = b.id;
  perform public.admin_lifecycle_event('booking.refund_recorded', v_command, b.id, jsonb_build_object('refunded_gbp', b.refund_due_gbp));
  return b.id;
end;
$function$;
