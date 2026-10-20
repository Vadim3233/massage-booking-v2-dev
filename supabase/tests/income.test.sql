begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(28);

-- Fixtures. Money is checked on dates in 2033 (to come) and 2020 (gone), which no other test uses.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000a901', 'authenticated', 'authenticated', 'income-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000a902', 'authenticated', 'authenticated', 'income-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a901');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000a1c1', 'Ines', 'Come');
-- A booking of £100 on p_date with its payment, and optionally a late fee.
create function pg_temp.b(p_n integer, p_date date, p_status text, p_method text, p_payment text, p_fee numeric default 0, p_fee_status text default 'none',
  p_refund_due numeric default 0, p_refunded numeric default null, p_start integer default 600) returns uuid language plpgsql as $$
declare v_id uuid := ('00000000-0000-4000-8000-0000000a' || lpad(p_n::text, 4, '0'))::uuid;
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, cancelled_at, late_fee_standard_gbp, late_fee_due_gbp, late_fee_status, refund_due_gbp)
  select v_id, 'INC-' || p_n, '00000000-0000-4000-8000-00000000a1c1', id, p_date, p_start, 60, p_status, 'test', '1 Test Road', name, 100, 100,
    case when p_status = 'cancelled' then now() end, p_fee, p_fee, p_fee_status, p_refund_due
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at, refunded_gbp, refunded_at)
  values (v_id, p_method, p_payment, 100, case when p_payment in ('paid', 'refunded') then now() end,
    p_refunded, case when p_payment = 'refunded' then now() end);
  return v_id;
end $$;
create function pg_temp.net(p_from date, p_to date) returns numeric language sql as $$ select coalesce(sum(net_gbp), 0) from public.income_lines(p_from, p_to) $$;

-- Each money rule, one week in 2033 (Monday 7 to Sunday 13 March).
select pg_temp.b(1, '2033-03-07', 'confirmed', 'bank_transfer', 'paid');                                   -- verified transfer: 100
select pg_temp.b(2, '2033-03-08', 'confirmed', 'cash', 'approved');                                        -- cash agreed, not received: 0
select pg_temp.b(3, '2033-03-08', 'completed', 'cash', 'paid', p_start => 780);                             -- cash received: 100
select pg_temp.b(4, '2033-03-09', 'cancelled', 'bank_transfer', 'refunded', 30, 'received', 0, 70);         -- paid, £30 kept, £70 refunded: 30
select pg_temp.b(5, '2033-03-10', 'cancelled', 'bank_transfer', 'rejected', 100, 'received');               -- unpaid, late fee paid later: 100
select pg_temp.b(6, '2033-03-11', 'confirmed', 'bank_transfer', 'awaiting_transfer');                      -- unpaid: 0
select pg_temp.b(7, '2033-03-12', 'cancelled', 'cash', 'paid', 100, 'received');                           -- paid, cancelled late, fee kept from payment: 100 (not 200)
select pg_temp.b(8, '2033-03-13', 'no_show', 'bank_transfer', 'paid', 100, 'due');                          -- prepaid no-show with a fee "due": 100 (not 200)
select pg_temp.b(9, '2033-03-14', 'confirmed', 'bank_transfer', 'paid');                                   -- the Monday after: next week
select is((select net_gbp from public.income_lines('2033-03-07', '2033-03-07')), 100.00, 'A verified bank transfer counts');
select is(pg_temp.net('2033-03-08', '2033-03-08'), 100.00, 'Cash received counts; cash agreed but not received does not');
select is((select (received_gbp, refund_gbp, net_gbp)::text from public.income_lines('2033-03-09', '2033-03-09')), '(100.00,70.00,30.00)', 'A refund sent is taken off');
select is((select (late_fee_gbp, net_gbp)::text from public.income_lines('2033-03-10', '2033-03-10')), '(100.00,100.00)', 'A late fee paid on an unpaid booking counts');
select is((select count(*)::int from public.income_lines('2033-03-11', '2033-03-11')), 0, 'An unpaid booking does not count');
select is(pg_temp.net('2033-03-12', '2033-03-12'), 100.00, 'A fee kept out of a payment is not counted twice');
select is(pg_temp.net('2033-03-13', '2033-03-13'), 100.00, 'A prepaid no-show with a fee still "due" is counted once');
-- An older refund recorded before amounts were kept: what was paid less the fee kept.
select pg_temp.b(10, '2033-03-15', 'cancelled', 'cash', 'refunded', 40, 'received', 0, null);
select is(pg_temp.net('2033-03-15', '2033-03-15'), 40.00, 'An older refund without an amount is worked out from the fee kept');

-- Periods: weeks run Monday to Sunday; months, calendar years and tax years (6 April to 5 April).
select results_eq($$select * from public.income_period('week', '2026-10-25')$$, $$values ('2026-10-19'::date, '2026-10-25'::date)$$, 'Sunday 25 Oct 2026 (clocks go back) ends the week from Monday 19th');
select results_eq($$select * from public.income_period('week', '2026-10-26')$$, $$values ('2026-10-26'::date, '2026-11-01'::date)$$, 'Monday 26th starts a new week');
select results_eq($$select * from public.income_period('month', '2026-10-25')$$, $$values ('2026-10-01'::date, '2026-10-31'::date)$$, 'October is the 1st to the 31st');
select results_eq($$select * from public.income_period('tax_year', '2027-04-05')$$, $$values ('2026-04-06'::date, '2027-04-05'::date)$$, '5 April 2027 is the last day of tax year 2026/27');
select results_eq($$select * from public.income_period('tax_year', '2027-04-06')$$, $$values ('2027-04-06'::date, '2028-04-05'::date)$$, '6 April 2027 starts tax year 2027/28');
select results_eq($$select * from public.income_period('year', '2027-04-06')$$, $$values ('2027-01-01'::date, '2027-12-31'::date)$$, 'A calendar year is January to December');
-- An appointment's own London date decides its period, so one at 00:30 on Monday 26 Oct belongs to the week from Monday 26th.
select pg_temp.b(11, '2033-03-21', 'confirmed', 'cash', 'paid', p_start => 30);
select is(pg_temp.net('2033-03-14', '2033-03-20'), 140.00, 'A booking at 00:30 on Monday belongs to the new week, not the one before');

-- The Admin's summary and rows; nobody else can see them.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a902","role":"authenticated"}', true);
select throws_ok($$select public.admin_income_summary('week', '2033-03-09')$$, '42501', 'Admin authorization required', 'A client cannot see income');
select throws_ok($$select * from public.admin_income_rows('2033-03-01', '2033-03-31')$$, '42501', 'Admin authorization required', 'nor its rows');
select throws_ok($$select * from public.admin_money_owed()$$, '42501', 'Admin authorization required', 'nor money owed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a901","role":"authenticated"}', true);
create temporary table s as select public.admin_income_summary('week', '2033-03-09') as j;
select is((select (j->>'total_gbp')::numeric from s), 530.00, 'The week''s income: 100 + 100 + 30 + 100 + 100 + 100');
select is((select (j->>'bank_gbp')::numeric + (j->>'cash_gbp')::numeric from s), 530.00, 'split into bank transfer and cash');
select is((select (j->>'bookings')::int from s), 6, 'Six bookings brought money');
select is((select jsonb_array_length(j->'bars') from s), 7, 'A week has a bar for each day');
select is((select (j->>'upcoming')::boolean from s), true, 'A period still to come is marked as upcoming');
select is((select (j->>'change_percent') from s), null, 'With nothing the week before, there is no comparison');
select is((select (j->>'still_to_come_gbp')::numeric from s), 200.00, 'Still to come: the unpaid transfer and the agreed cash, never in the total');
select is((select count(*)::int from public.admin_income_rows('2033-03-07', '2033-03-13')), 6, 'The six bookings behind the total, for the list and the CSV');
reset role;
-- Once paid, a booking moves from "still to come" into income.
update public.booking_payments set status = 'paid', paid_at = now() where booking_id = '00000000-0000-4000-8000-0000000a0006';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a901","role":"authenticated"}', true);
select is((select (j->>'total_gbp')::numeric || '/' || (j->>'still_to_come_gbp')::numeric from (select public.admin_income_summary('week', '2033-03-09') j) x), '630.00/100.00', 'Once paid it moves from still to come into income');
reset role;

-- Money owed to you: appointments that have happened with money missing.
select pg_temp.b(21, '2020-05-04', 'completed', 'cash', 'approved');
select pg_temp.b(22, '2020-05-05', 'confirmed', 'bank_transfer', 'awaiting_transfer');
select pg_temp.b(23, '2020-05-06', 'cancelled', 'bank_transfer', 'rejected', 100, 'due');
select pg_temp.b(24, '2020-05-07', 'no_show', 'bank_transfer', 'paid', 100, 'due');
select pg_temp.b(25, '2020-05-08', 'completed', 'cash', 'paid');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a901","role":"authenticated"}', true);
select results_eq($$select date, reason, amount_gbp from public.admin_money_owed() where date between '2020-05-01' and '2020-05-31' order by date$$,
  $$values ('2020-05-04'::date, 'cash not marked received'::text, 100.00::numeric), ('2020-05-05', 'transfer not received', 100.00), ('2020-05-06', 'late fee unpaid', 100.00)$$,
  'Cash not received, a transfer not received and a late fee unpaid are owed; a paid no-show and a paid booking are not');
reset role;

select * from finish();
rollback;
