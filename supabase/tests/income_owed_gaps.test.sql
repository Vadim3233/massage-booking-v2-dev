begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(9);

-- 20261218100000_income_owed_gaps.sql: Paid, Overdue and Upcoming never miss money. Dates in 2034 (to come) and 2021 (gone).
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000a911', 'authenticated', 'authenticated', 'income-gaps-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000a912', 'authenticated', 'authenticated', 'income-gaps-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a911');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000a1c2', 'Gail', 'Gap');
-- A booking of £100 on p_date with its payment, and optionally a late fee.
create function pg_temp.b(p_n integer, p_date date, p_status text, p_method text, p_payment text, p_fee numeric default 0, p_fee_status text default 'none',
  p_refund_due numeric default 0, p_refunded numeric default null, p_start integer default 600) returns uuid language plpgsql as $$
declare v_id uuid := ('00000000-0000-4000-8000-0000000b' || lpad(p_n::text, 4, '0'))::uuid;
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, cancelled_at, late_fee_standard_gbp, late_fee_due_gbp, late_fee_status, refund_due_gbp)
  select v_id, 'GAP-' || p_n, '00000000-0000-4000-8000-00000000a1c2', id, p_date, p_start, 60, p_status, 'test', '1 Test Road', name, 100, 100,
    case when p_status = 'cancelled' then now() end, p_fee, p_fee, p_fee_status, p_refund_due
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at, refunded_gbp, refunded_at)
  values (v_id, p_method, p_payment, 100, case when p_payment in ('paid', 'refunded') then now() end,
    p_refunded, case when p_payment = 'refunded' then now() end);
  return v_id;
end $$;

create function pg_temp.owed(p_n integer) returns text language sql as $$
  select string_agg(reason || ' ' || amount_gbp, ', ' order by reason) from public.money_owed_lines()
  where booking_id = ('00000000-0000-4000-8000-0000000b' || lpad(p_n::text, 4, '0'))::uuid $$;
create function pg_temp.to_come(p_n integer) returns numeric language sql as $$
  select sum(to_come_gbp) from public.income_to_come_lines('2000-01-01', '2100-01-01')
  where booking_id = ('00000000-0000-4000-8000-0000000b' || lpad(p_n::text, 4, '0'))::uuid $$;

-- 1. A paid booking made longer: £30 extra still to pay.
select pg_temp.b(1, '2034-05-02', 'confirmed', 'bank_transfer', 'paid');
select pg_temp.b(2, '2021-05-03', 'confirmed', 'bank_transfer', 'paid');
update public.bookings set balance_due_gbp = 30 where id in ('00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000b0002');
select is(pg_temp.to_come(1), 30.00, 'Extra still to pay on a paid booking to come is Upcoming');
select is(pg_temp.owed(1), null, 'and not Overdue before the session');
select is(pg_temp.owed(2), 'extra not received 30.00', 'Once the session has started, the extra is Overdue');
select is(pg_temp.to_come(2), null, 'and no longer Upcoming');
select is((select net_gbp from public.income_lines('2021-05-03', '2021-05-03')), 100.00, 'Paid stays what was paid, until the extra is marked received');

-- 2. Part paid by gift voucher: £100 booking, £85 from the voucher, £15 for the client to pay.
select pg_temp.b(3, '2034-05-04', 'confirmed', 'bank_transfer', 'awaiting_transfer');
update public.bookings set gift_covered_gbp = 85 where id = '00000000-0000-4000-8000-0000000b0003';
update public.booking_payments set amount_gbp = 15 where booking_id = '00000000-0000-4000-8000-0000000b0003';
select is(pg_temp.to_come(3), 15.00, 'Upcoming counts only what the client pays, like Paid and Overdue');

-- 3. A late fee due on a booking cancelled before its date.
select pg_temp.b(4, '2034-05-05', 'cancelled', 'bank_transfer', 'rejected', 40, 'due');
select is(pg_temp.owed(4), 'late fee unpaid 40.00', 'A late fee is Overdue as soon as it is due, not only after the appointment time');
select is(pg_temp.to_come(4), null, 'and is never Upcoming');

-- Nothing else changes: an unpaid transfer to come is Upcoming at the booking's price.
select pg_temp.b(5, '2034-05-06', 'confirmed', 'bank_transfer', 'awaiting_transfer');
select is(pg_temp.to_come(5), 100.00, 'An unpaid booking to come is Upcoming at its price');

select * from finish();
rollback;
