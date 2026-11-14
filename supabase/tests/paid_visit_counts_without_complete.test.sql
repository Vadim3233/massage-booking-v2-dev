begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(8);

-- A regular client whose past visits stay "confirmed" (Vadim rarely presses Complete) is still a returning client.
-- Fixtures: a client with an account, one past paid visit left confirmed, and one upcoming booking.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000f502', 'authenticated', 'authenticated', 'regular-client@example.test', now(), '{}', '{}', now(), now());
insert into public.clients(id, first_name, last_name, email, phone, auth_user_id)
  values ('00000000-0000-4000-8000-00000000f601', 'Rae', 'Regular', 'regular-client@example.test', '+44 7700 900902', '00000000-0000-0000-0000-00000000f502');
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000f621', 'regular-test-service', 'Regular Test Service', true, 991);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values ('00000000-0000-4000-8000-00000000f621', 60, 85, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order)
  values ('00000000-0000-4000-8000-00000000f631', 'regular-test-area', 'Regular Test Area', true, 0, 0, 991);

create function pg_temp.london_day(p_offset integer) returns date language sql as $$ select ((now() at time zone 'Europe/London')::date + p_offset); $$;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.london_day(d), true, 600, 1200, 'flexible' from unnest(array[8, 15]) d;
insert into public.business_settings(key, value) values ('new_client_booking_limit', '1'), ('booking_horizon_days', '40'), ('minimum_notice_minutes', '120')
  on conflict (key) do update set value = excluded.value;

create function pg_temp.visit(p_id uuid, p_status text, p_day integer, p_payment_status text) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  values (p_id, 'REG-' || right(p_id::text, 4), '00000000-0000-4000-8000-00000000f601', '00000000-0000-4000-8000-00000000f631',
    pg_temp.london_day(p_day), 600, 60, p_status, 'test', '1 Test Road', 'London', 'SW1A 1AA', 'Regular Test Area', 85, 85, 'regular-client@example.test');
  insert into public.booking_payments(booking_id, method, status, amount_gbp, payment_reference, paid_at)
    values (p_id, 'bank_transfer', p_payment_status, 85, 'REG-' || right(p_id::text, 4), case when p_payment_status = 'paid' then now() end);
end;
$$;
create function pg_temp.reserve(p_key text, p_date date) returns uuid language plpgsql as $$
declare h record; r record;
begin
  select * into h from public.create_booking_hold(p_date, 600, 60, 'regular-browser-' || p_key || '-0000000');
  select * into r from public.finalize_client_booking(h.hold_id, h.hold_token, 'regular-browser-' || p_key || '-0000000',
    '00000000-0000-4000-8000-00000000f631', '[{"service_id":"00000000-0000-4000-8000-00000000f621","duration_minutes":60}]',
    '{}', null, '1 Test Road', null, 'London', 'sw1a1aa', null, null, 'bank_transfer', 'regular-finalize-' || p_key);
  return r.booking_id;
end;
$$;

-- What counts as a paid visit.
select pg_temp.visit('00000000-0000-4000-8000-00000000f701', 'confirmed', -10, 'awaiting_transfer');
select is(public.client_has_paid_visit('00000000-0000-4000-8000-00000000f601'), false, 'A past visit not yet paid is not a paid visit');
select pg_temp.visit('00000000-0000-4000-8000-00000000f702', 'confirmed', 5, 'paid');
select is(public.client_has_paid_visit('00000000-0000-4000-8000-00000000f601'), false, 'A visit paid in advance but still to come is not a paid visit');
select pg_temp.visit('00000000-0000-4000-8000-00000000f703', 'no_show', -12, 'paid');
select is(public.client_has_paid_visit('00000000-0000-4000-8000-00000000f601'), false, 'A missed appointment is not a visit');
select pg_temp.visit('00000000-0000-4000-8000-00000000f704', 'confirmed', -7, 'paid');
select is(public.client_has_paid_visit('00000000-0000-4000-8000-00000000f601'), true, 'A past visit left confirmed and paid is a paid visit, without Complete');
select ok(not has_function_privilege('authenticated', 'public.client_has_paid_visit(uuid)', 'EXECUTE'), 'The test is still not callable from the browser');

-- The booking limit: the client already holds one upcoming booking (day 5), and the new-client limit is one.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f502', true);
set local role authenticated;
select lives_ok($$select pg_temp.reserve('second', pg_temp.london_day(8))$$, 'A regular client with a booking already can book another');
select is(public.my_cash_allowed(), true, 'and may choose cash');
reset role;

-- Without the past paid visit they are a new client again, and the one-booking limit applies.
delete from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000f704';
delete from public.bookings where id = '00000000-0000-4000-8000-00000000f704';
set local role authenticated;
select throws_ok($$select pg_temp.reserve('third', pg_temp.london_day(15))$$, '22023',
  'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.',
  'A new client is still limited to one upcoming booking');
reset role;

select * from finish();
rollback;
