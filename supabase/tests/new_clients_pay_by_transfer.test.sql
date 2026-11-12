begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(12);

-- Fixtures: an Admin, a new client with a booking waiting for a transfer, and the same client's past visit (added later).
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000e501', 'authenticated', 'authenticated', 'cash-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e502', 'authenticated', 'authenticated', 'cash-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e501');
insert into public.clients(id, first_name, last_name, email, auth_user_id)
  values ('00000000-0000-4000-8000-00000000e601', 'Nina', 'New', 'cash-client@example.test', '00000000-0000-0000-0000-00000000e502');

create function pg_temp.new_booking(p_id uuid, p_status text, p_day integer, p_payment_status text) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'CASH-' || right(p_id::text, 4), '00000000-0000-4000-8000-00000000e601', id, (now() at time zone 'Europe/London')::date + p_day, 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 90, 90, 'cash-client@example.test'
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, payment_reference, paid_at)
    values (p_id, 'bank_transfer', p_payment_status, 90, 'CASH-' || right(p_id::text, 4), case when p_payment_status = 'paid' then now() end);
end;
$$;
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e701', 'awaiting_transfer', 6, 'awaiting_transfer');

select ok(not has_function_privilege('anon', 'public.my_cash_allowed()', 'EXECUTE'), 'Anonymous callers cannot ask');
select ok(not has_function_privilege('authenticated', 'public.client_may_pay_cash(uuid)', 'EXECUTE'), 'The inner test is not callable directly');

-- A new client.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e502","role":"authenticated"}', true);
select is(public.my_cash_allowed(), false, 'A new client may not choose cash');
select throws_ok($$select public.confirm_my_cash_booking('00000000-0000-4000-8000-00000000e701')$$, '22023',
  'For your first visit, please pay by bank transfer to secure your booking. Cash is welcome from your second visit.', 'Their switch to cash is refused');
select throws_ok($$select public.admin_client_payment_trust('00000000-0000-4000-8000-00000000e601')$$, '42501', 'Admin access required', 'A client cannot read the Admin view');
update public.clients set cash_trusted = true where id = '00000000-0000-4000-8000-00000000e601';
reset role;
select is((select cash_trusted from public.clients where id = '00000000-0000-4000-8000-00000000e601'), false, 'A client cannot make themselves Trusted');
select is((select method from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000e701'), 'bank_transfer', 'The booking still waits for a transfer');

-- The Admin sees a first booking, and marks the client Trusted.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e501","role":"authenticated"}', true);
select is(public.admin_client_payment_trust('00000000-0000-4000-8000-00000000e601'), '{"has_paid_visit": false, "trusted": false}'::jsonb, 'The Admin sees a new client');
update public.clients set cash_trusted = true where id = '00000000-0000-4000-8000-00000000e601';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e502","role":"authenticated"}', true);
select is(public.my_cash_allowed(), true, 'A Trusted client may choose cash');
select lives_ok($$select public.confirm_my_cash_booking('00000000-0000-4000-8000-00000000e701')$$, 'and their switch to cash goes through');

-- Not Trusted, but with a completed, paid visit: a returning client.
reset role;
update public.clients set cash_trusted = false where id = '00000000-0000-4000-8000-00000000e601';
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e702', 'completed', -10, 'paid');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e502","role":"authenticated"}', true);
select is(public.my_cash_allowed(), true, 'A returning client may choose cash');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e501","role":"authenticated"}', true);
select is(public.admin_client_payment_trust('00000000-0000-4000-8000-00000000e601')->'has_paid_visit', 'true'::jsonb, 'The Admin sees a returning client');

select * from finish();
rollback;
