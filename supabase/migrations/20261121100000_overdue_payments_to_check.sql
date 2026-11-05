-- To check also lists a booking that went ahead but has not been paid: confirmed (or completed), the appointment has finished, and the
-- payment is still a bank transfer not received or a cash payment not marked received. Before the appointment ends such a booking stays
-- out of the list, as before ("Confirm now, pay later" is not a question until the session has happened).
create or replace function public.admin_payment_review_queue(p_offset integer default 0)
returns setof public.bookings language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 10000 then
    raise exception 'Invalid page' using errcode='22023';
  end if;
  return query select b.* from public.bookings b
  join public.booking_payments p on p.booking_id=b.id
  where (b.booking_status='awaiting_transfer' and p.method='bank_transfer' and p.status='awaiting_transfer')
     or (b.booking_status='awaiting_payment_verification' and p.method='bank_transfer' and p.status='awaiting_verification')
     or (b.booking_status='awaiting_cash_approval' and p.method='cash' and p.status='awaiting_approval')
     or (b.booking_status in ('confirmed','completed')
         and ((p.method='bank_transfer' and p.status in ('awaiting_transfer','awaiting_verification'))
           or (p.method='cash' and p.status='approved'))
         and b.date + make_interval(mins => b.start_minutes + b.treatment_duration_minutes)
             <= (now() at time zone 'Europe/London'))
  order by b.date, b.start_minutes, b.id offset p_offset limit 51;
end; $$;
revoke all on function public.admin_payment_review_queue(integer) from public, anon;
grant execute on function public.admin_payment_review_queue(integer) to authenticated;
