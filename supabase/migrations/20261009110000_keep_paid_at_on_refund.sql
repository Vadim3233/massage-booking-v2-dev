-- VAD Massage Booking V2
-- A refunded payment keeps the date it was originally paid. Previously
-- booking_payments_paid_timestamp_consistent forced paid_at to null for every
-- status other than 'paid', so refunding erased the payment date.

alter table public.booking_payments
  drop constraint booking_payments_paid_timestamp_consistent;

alter table public.booking_payments
  add constraint booking_payments_paid_timestamp_consistent
    check (
      (status = 'paid' and paid_at is not null)
      or
      (status = 'refunded')
      or
      (status not in ('paid', 'refunded') and paid_at is null)
    );
