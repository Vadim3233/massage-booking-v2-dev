begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(8);

-- Fixtures, as in booking_lifecycle.test.sql.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000d001', 'authenticated', 'authenticated', 'money-admin@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d001');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000d101', 'Money', 'Test');
create function pg_temp.new_booking(p_id uuid, p_status text, p_method text, p_payment text, p_refund numeric, p_fee numeric) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, created_at,
    cancelled_at, refund_due_gbp, late_fee_due_gbp, late_fee_status)
  select p_id, 'MONEY-' || p_id, '00000000-0000-4000-8000-00000000d101', id, current_date + 3, 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 90, 90, now() - interval '3 days',
    case when p_status = 'cancelled' then now() end, p_refund, p_fee, case when p_fee > 0 then 'received' else 'none' end
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, p_method, p_payment, 90, case when p_payment = 'paid' then now() end);
end;
$$;
create function pg_temp.bv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = $1; $$;
create function pg_temp.pv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.booking_payments where booking_id = $1; $$;

select has_column('public', 'booking_payments', 'refunded_gbp', 'The refund amount is kept with the payment');
select has_column('public', 'booking_payments', 'refunded_at', 'and when it was sent');

-- A full refund (cancelled in good time) and a part refund (cancelled late with a £30 fee kept).
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d201', 'cancelled', 'bank_transfer', 'paid', 90, 0);
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d202', 'cancelled', 'cash', 'paid', 60, 30);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
select lives_ok($$select public.admin_record_refund('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000d201'), pg_temp.pv('00000000-0000-4000-8000-00000000d201'))$$,
  'Recording a refund sent works as before');
select lives_ok($$select public.admin_record_refund('00000000-0000-4000-8000-00000000d202', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000d202'), pg_temp.pv('00000000-0000-4000-8000-00000000d202'))$$,
  'and for a part refund');
reset role;
select results_eq($$select p.status, p.refunded_gbp, p.refunded_at is not null and p.refunded_at <= clock_timestamp(), b.refund_due_gbp from public.booking_payments p join public.bookings b on b.id = p.booking_id where b.id = '00000000-0000-4000-8000-00000000d201'$$,
  $$values ('refunded'::text, 90.00::numeric, true, 0.00::numeric)$$, 'It now keeps the amount sent back and when, and nothing is left to refund');
select results_eq($$select p.refunded_gbp, p.amount_gbp, b.late_fee_due_gbp, b.late_fee_status from public.booking_payments p join public.bookings b on b.id = p.booking_id where b.id = '00000000-0000-4000-8000-00000000d202'$$,
  $$values (60.00::numeric, 90.00::numeric, 30.00::numeric, 'received'::text)$$, 'A part refund keeps £60 sent back of the £90 paid, the £30 fee kept');
select throws_ok($$update public.booking_payments set refunded_gbp = 91 where booking_id = '00000000-0000-4000-8000-00000000d201'$$,
  '23514', null, 'A refund can never be more than was paid');
select ok(not has_column_privilege('anon', 'public.booking_payments', 'refunded_gbp', 'SELECT'), 'Visitors cannot read refunds');

select * from finish();
rollback;
