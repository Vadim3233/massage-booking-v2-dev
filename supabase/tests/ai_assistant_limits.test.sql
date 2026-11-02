begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(12);

-- An AI assistant's sign-in (its token carries client_id) cannot move or cancel bookings or change saved addresses (ADR-085).
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000e101', 'authenticated', 'authenticated', 'assistant-limits@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e102', 'authenticated', 'authenticated', 'assistant-blocked@example.test', now(), '{}', '{}', now(), now());
insert into public.clients(id, auth_user_id, first_name, last_name, email, online_booking_enabled) values
  ('00000000-0000-4000-8000-00000000e201', '00000000-0000-0000-0000-00000000e101', 'Assist', 'Limits', 'assistant-limits@example.test', true),
  ('00000000-0000-4000-8000-00000000e202', '00000000-0000-0000-0000-00000000e102', 'Assist', 'Blocked', 'assistant-blocked@example.test', false);
insert into public.client_addresses(id, client_id, address_line_1, city, postcode) values
  ('00000000-0000-4000-8000-00000000e401', '00000000-0000-4000-8000-00000000e201', '1 Test Road', 'London', 'SW1A 1AA'),
  ('00000000-0000-4000-8000-00000000e402', '00000000-0000-4000-8000-00000000e202', '2 Test Road', 'London', 'SW1A 1AA');
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, created_at)
select '00000000-0000-4000-8000-00000000e301', 'ASSIST-1', '00000000-0000-4000-8000-00000000e201', id,
  ((now() at time zone 'Europe/London') + interval '10 days')::date, 600, 60, 'confirmed', 'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85,
  now() - interval '3 days'
from public.service_areas where slug = 'chelsea';
insert into public.booking_payments(booking_id, method, status, amount_gbp) values ('00000000-0000-4000-8000-00000000e301', 'bank_transfer', 'awaiting_verification', 85);

select ok(not has_function_privilege('anon', 'public.request_is_ai_assistant()', 'EXECUTE'), 'Anonymous callers cannot use the assistant check');
select ok(not has_function_privilege('authenticated', 'public.refuse_ai_assistant_booking_change()', 'EXECUTE'), 'The trigger function is not callable');

-- The assistant's sign-in
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e101', 'role', 'authenticated', 'client_id', 'some-assistant')::text, true);
set local role authenticated;
select ok(public.request_is_ai_assistant(), 'A token with client_id is an assistant');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000e301', gen_random_uuid(), 0)$$,
  '42501', 'Please move or cancel this booking in the VadMassage app.', 'An assistant cannot cancel a booking');
select throws_ok($$insert into public.client_addresses(client_id, address_line_1, city, postcode) values ('00000000-0000-4000-8000-00000000e201', '3 Test Road', 'London', 'SW1A 1AA')$$,
  '42501', null, 'An assistant cannot add an address');
update public.client_addresses set address_line_1 = 'Changed' where id = '00000000-0000-4000-8000-00000000e401';
delete from public.client_addresses where id = '00000000-0000-4000-8000-00000000e401';
reset role;
select is((select address_line_1 from public.client_addresses where id = '00000000-0000-4000-8000-00000000e401'), '1 Test Road',
  'An assistant cannot change or delete an address');
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000e301'), 'confirmed', 'The booking is untouched');

-- The same client in the app
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e101', 'role', 'authenticated')::text, true);
set local role authenticated;
select ok(not public.request_is_ai_assistant(), 'The app''s own sign-in is not an assistant');
update public.client_addresses set address_line_1 = 'Changed in the app' where id = '00000000-0000-4000-8000-00000000e401';
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000e301', gen_random_uuid(), 0)->>'booking_status', 'cancelled',
  'The client can still cancel in the app');
reset role;
select is((select address_line_1 from public.client_addresses where id = '00000000-0000-4000-8000-00000000e401'), 'Changed in the app',
  'The client can still change an address in the app');

-- A client the Admin has stopped from booking online
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e102', 'role', 'authenticated')::text, true);
set local role authenticated;
update public.client_addresses set address_line_1 = 'Changed while blocked' where id = '00000000-0000-4000-8000-00000000e402';
delete from public.client_addresses where id = '00000000-0000-4000-8000-00000000e402';
select is((select count(*)::integer from public.client_addresses where id = '00000000-0000-4000-8000-00000000e402'), 1,
  'A blocked client cannot delete an address');
reset role;
select is((select address_line_1 from public.client_addresses where id = '00000000-0000-4000-8000-00000000e402'), '2 Test Road',
  'A blocked client cannot change an address');

select * from finish();
rollback;
