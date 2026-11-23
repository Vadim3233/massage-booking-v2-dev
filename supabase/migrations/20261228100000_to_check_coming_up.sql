-- To check from the moment a booking is confirmed (ADR-to-check-coming-up, 2026-11-23).
-- A confirmed booking with its bank transfer not received is listed straight away, not only once the session is over: before the session the
-- app shows it in a calm "Coming up · not paid yet" section (no badge); after it ends it needs the Admin as before. A transfer the client
-- says they made is listed at once, before or after the session. An extra still owed on a paid booking is listed from the start too.
-- Cash is unchanged: it is paid on the day, so it is listed only once the session is over and not marked received.
-- Safe to run more than once.
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
     -- Confirmed, bank transfer not received: from the moment it is confirmed.
     or (b.booking_status in ('confirmed','completed') and p.method='bank_transfer' and p.status in ('awaiting_transfer','awaiting_verification'))
     -- Confirmed, cash not marked received: once the session is over.
     or (b.booking_status in ('confirmed','completed') and p.method='cash' and p.status='approved'
         and b.date + make_interval(mins => b.start_minutes + b.treatment_duration_minutes)
             <= (now() at time zone 'Europe/London'))
     -- An extra still to pay on a paid booking (extra time, or a change that cost more): from the moment it is owed.
     or (b.booking_status in ('confirmed','completed') and p.status='paid' and b.balance_due_gbp > 0)
  order by b.date, b.start_minutes, b.id offset p_offset limit 51;
end; $$;
revoke all on function public.admin_payment_review_queue(integer) from public, anon;
grant execute on function public.admin_payment_review_queue(integer) to authenticated;
