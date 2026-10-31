begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(5);

-- A fee for moving a booking late, on a booking that went ahead, is owed on top of the price and counts in Income once received (ADR-089).
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000b901', 'authenticated', 'authenticated', 'late-move-admin@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000b901');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000b1c1', 'Lena', 'Moved');
-- A £100 booking, in the past (2019, a year no other test uses), with its payment and a £100 fee for moving it late.
create function pg_temp.b(p_n integer, p_status text, p_payment text, p_fee_status text, p_start integer) returns uuid language plpgsql as $$
declare v_id uuid := ('00000000-0000-4000-8000-0000000b' || lpad(p_n::text, 4, '0'))::uuid;
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, cancelled_at, late_fee_standard_gbp, late_fee_due_gbp, late_fee_status)
  select v_id, 'MOVE-' || p_n, '00000000-0000-4000-8000-00000000b1c1', id, '2019-06-03', p_start, 60, p_status, 'test', '1 Test Road', name, 100, 100,
    case when p_status = 'cancelled' then now() end, 100, 100, p_fee_status
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (v_id, 'bank_transfer', p_payment, 100, case when p_payment = 'paid' then now() end);
  return v_id;
end $$;
select pg_temp.b(1, 'completed', 'paid', 'due', 600);       -- went ahead, paid for, fee still owed
select pg_temp.b(2, 'completed', 'paid', 'received', 720);  -- went ahead, paid for, fee received: 200 in all
select pg_temp.b(3, 'cancelled', 'paid', 'received', 840);  -- cancelled, fee kept out of the payment: 100 (unchanged)

select results_eq($$select amount_gbp, reason from public.money_owed_lines() where booking_id = '00000000-0000-4000-8000-0000000b0001'$$,
  $$values (100.00::numeric, 'late fee unpaid'::text)$$, 'A late-move fee still owed on a booking that went ahead is in Money owed');
select is((select count(*)::integer from public.money_owed_lines() where booking_id in ('00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-0000000b0003')), 0,
  'A fee received is no longer owed');
select is((select net_gbp from public.income_lines('2019-06-03', '2019-06-03') where booking_id = '00000000-0000-4000-8000-0000000b0002'), 200.00::numeric,
  'A fee received on top of a paid booking that went ahead counts on its own');
select is((select net_gbp from public.income_lines('2019-06-03', '2019-06-03') where booking_id = '00000000-0000-4000-8000-0000000b0003'), 100.00::numeric,
  'A fee kept out of a cancelled booking''s payment is not counted twice');
select is((select net_gbp from public.income_lines('2019-06-03', '2019-06-03') where booking_id = '00000000-0000-4000-8000-0000000b0001'), 100.00::numeric,
  'A fee still owed is not counted yet');

select * from finish();
rollback;
