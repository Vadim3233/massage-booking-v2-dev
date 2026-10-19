begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- Fixtures (all inserted first: a role that is not the owner cannot insert some of them)
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000a901', 'authenticated', 'authenticated', 'addr-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000a902', 'authenticated', 'authenticated', 'addr-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a901');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000a911', '00000000-0000-0000-0000-00000000a902', 'Aria', 'Account', 'addr-client@example.test', '+44 7700 900911'),
  ('00000000-0000-4000-8000-00000000a912', null, 'Bea', 'Booked', 'addr-bea@example.test', null),
  ('00000000-0000-4000-8000-00000000a913', null, 'Cam', 'Keeps', null, null),
  ('00000000-0000-4000-8000-00000000a914', null, 'Cam', 'Joins', null, null);
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000a921', 'addr-test-service', 'Address Test Service', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values ('00000000-0000-4000-8000-00000000a921', 60, 85, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values ('00000000-0000-4000-8000-00000000a931', 'addr-test-area', 'Address Test Area', true, 0, 0, 990);
create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
  select pg_temp.day(d), true, 0, 1440, 'flexible' from generate_series(0, 30) d
  on conflict (date) do update set available = true, start_minutes = 0, end_minutes = 1440, start_mode = 'flexible', fixed_start_minutes = null;
insert into public.business_settings(key, value) values ('new_client_booking_limit', '20'), ('returning_client_booking_limit', '20')
  on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------------------------------------
-- Tidying an address
-- ---------------------------------------------------------------------------------------------
select is(public.clean_address(E'10 High Street\nLondon\nSW1A 1AA'), '10 High Street, London, SW1A 1AA', 'Line breaks become commas');
select is(public.clean_address(E'Flat 2\r\n5 Test Road\r\n\r\nLondon'), 'Flat 2, 5 Test Road, London', 'Windows line breaks and blank lines too');
select is(public.clean_address('  10 High   Street ,, London ,  '), '10 High Street, London', 'Spaces and doubled commas are tidied and the ends trimmed');
select is(public.clean_address('10 High Street, London SW1A 1AA'), '10 High Street, London SW1A 1AA', 'An address already on one line is left as it is');
select is(public.clean_address(E'Flat 2,\nLondon'), 'Flat 2, London', 'A comma at the end of a line is not doubled');
select is(public.clean_address(E'\t12 Test Road\t'), '12 Test Road', 'Tabs are spaces');
select is(public.clean_address('   '), null, 'Nothing but spaces is no address');
select is(public.clean_address(' , , '), null, 'Nothing but commas is no address');
select is(public.clean_address(null), null, 'No text is no address');
select is(public.clean_address('Rue de l''Église, Zürich'), 'Rue de l''Église, Zürich', 'Letters with accents are kept');

-- ---------------------------------------------------------------------------------------------
-- What the database looks like
-- ---------------------------------------------------------------------------------------------
select has_column('public', 'client_addresses', 'address', 'A saved address is one text');
select col_not_null('public', 'client_addresses', 'address', 'which every address has');
select col_not_null('public', 'client_addresses', 'normalized_address', 'with its letters-and-numbers form');
select has_column('public', 'bookings', 'address_snapshot', 'A booking keeps the address it was made for as one text');
select col_not_null('public', 'bookings', 'address_snapshot', 'which every booking has');
select col_is_null('public', 'client_addresses', 'address_line_1', 'The old street box is no longer required');
select col_is_null('public', 'client_addresses', 'city', 'nor the old city');
select col_is_null('public', 'client_addresses', 'postcode', 'nor the old postcode');
select col_is_null('public', 'bookings', 'address_line_1_snapshot', 'nor the old street on a booking');
select col_is_null('public', 'bookings', 'postcode_snapshot', 'nor the old postcode on a booking');
select ok(not has_function_privilege('anon', 'public.clean_address(text)', 'EXECUTE'), 'Anonymous callers cannot run the tidying');
select ok(has_function_privilege('authenticated', 'public.clean_address(text)', 'EXECUTE'), 'A signed-in client saving their own address can');
select ok(not has_function_privilege('anon', 'public.derive_booking_address_snapshot()', 'EXECUTE') and not has_function_privilege('authenticated', 'public.derive_booking_address_snapshot()', 'EXECUTE'),
  'The booking trigger function is not open to callers');
select ok(to_regprocedure('public.finalize_client_booking(uuid,uuid,text,uuid,jsonb,uuid[],uuid,text,text,text,text,text,text,text,text)') is null, 'The old 15-argument finalize is gone');
select ok(to_regprocedure('public.finalize_client_booking(uuid,uuid,text,uuid,jsonb,uuid[],uuid,text,text,text,text,text,text,text,text,text)') is not null, 'Replaced by one that also takes the address as one text');
select ok(not has_function_privilege('anon', 'public.finalize_client_booking(uuid,uuid,text,uuid,jsonb,uuid[],uuid,text,text,text,text,text,text,text,text,text)', 'EXECUTE'), 'Anonymous callers cannot finalize a booking');
select ok(has_function_privilege('authenticated', 'public.finalize_client_booking(uuid,uuid,text,uuid,jsonb,uuid[],uuid,text,text,text,text,text,text,text,text,text)', 'EXECUTE'), 'A signed-in client can');

-- ---------------------------------------------------------------------------------------------
-- A saved address: written as one text, or by an old screen in its parts
-- ---------------------------------------------------------------------------------------------
insert into public.client_addresses(id, client_id, address, is_default) values ('00000000-0000-4000-8000-00000000a941', '00000000-0000-4000-8000-00000000a912', E'Flat 3\n8 New Road\nLondon  SW1A 2AA', true);
select results_eq($$select address, normalized_address, address_line_1, city, postcode, normalized_postcode from public.client_addresses where id = '00000000-0000-4000-8000-00000000a941'$$,
  $$values ('Flat 3, 8 New Road, London SW1A 2AA'::text, 'flat38newroadlondonsw1a2aa'::text, null::text, null::text, null::text, null::text)$$,
  'An address written as one text is tidied, its letters-and-numbers form is kept and the old parts stay empty');
insert into public.client_addresses(id, client_id, address_line_1, address_line_2, city, postcode) values ('00000000-0000-4000-8000-00000000a942', '00000000-0000-4000-8000-00000000a912', ' 5 Old Street ', 'Flat 1', 'London', 'sw1a 3aa');
select results_eq($$select address, normalized_address, address_line_1, postcode, normalized_postcode from public.client_addresses where id = '00000000-0000-4000-8000-00000000a942'$$,
  $$values ('5 Old Street, Flat 1, London, SW1A 3AA'::text, '5oldstreetflat1londonsw1a3aa'::text, '5 Old Street'::text, 'SW1A 3AA'::text, 'SW1A3AA'::text)$$,
  'An old screen writing the parts gets the text put together from them, as before for the parts');
update public.client_addresses set city = 'Croydon' where id = '00000000-0000-4000-8000-00000000a942';
select is((select address from public.client_addresses where id = '00000000-0000-4000-8000-00000000a942'), '5 Old Street, Flat 1, Croydon, SW1A 3AA', 'An old screen changing a part changes the text');
update public.client_addresses set address = E'5 Old Street\nCroydon CR0 1AA' where id = '00000000-0000-4000-8000-00000000a942';
select results_eq($$select address, address_line_1, city, postcode, normalized_postcode from public.client_addresses where id = '00000000-0000-4000-8000-00000000a942'$$,
  $$values ('5 Old Street, Croydon CR0 1AA'::text, null::text, null::text, null::text, null::text)$$, 'Changing the text clears the old parts, which no longer describe it');
update public.client_addresses set entry_instructions = '  Ring twice ' where id = '00000000-0000-4000-8000-00000000a942';
select is((select address from public.client_addresses where id = '00000000-0000-4000-8000-00000000a942'), '5 Old Street, Croydon CR0 1AA', 'Changing only the instructions leaves the address alone');
select is((select entry_instructions from public.client_addresses where id = '00000000-0000-4000-8000-00000000a942'), 'Ring twice', 'and tidies them as before');
select throws_ok($$insert into public.client_addresses(client_id, address) values ('00000000-0000-4000-8000-00000000a912', '   ')$$, '23502', null, 'An address with nothing in it is refused');
select throws_ok($$insert into public.client_addresses(client_id, address) values ('00000000-0000-4000-8000-00000000a912', repeat('a', 401))$$, '23514', null, 'An address of more than 400 characters is refused');
select lives_ok($$insert into public.client_addresses(client_id, address) values ('00000000-0000-4000-8000-00000000a912', repeat('a', 400))$$, 'One of exactly 400 is allowed');

-- ---------------------------------------------------------------------------------------------
-- A booking row written straight: its address as one text, or only the old parts
-- ---------------------------------------------------------------------------------------------
create function pg_temp.raw_booking(p_id uuid, p_text text, p_line1 text, p_city text, p_postcode text) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_snapshot, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'ADR-' || p_id, '00000000-0000-4000-8000-00000000a912', id, pg_temp.day(20), 600, 60, 'confirmed', 'test', p_text, p_line1, p_city, p_postcode, name, 85, 85, 'addr-bea@example.test'
  from public.service_areas where slug = 'addr-test-area';
end; $$;
select pg_temp.raw_booking('00000000-0000-4000-8000-00000000a951', null, '4 Legacy Lane', 'London', 'sw1a 4aa');
select is((select address_snapshot from public.bookings where id = '00000000-0000-4000-8000-00000000a951'), '4 Legacy Lane, London, SW1A 4AA', 'A booking written with the old parts only gets the text put together from them');
select pg_temp.raw_booking('00000000-0000-4000-8000-00000000a952', E'Flat 9\n9 Text Road\nLondon', null, null, null);
select results_eq($$select address_snapshot, address_line_1_snapshot, postcode_snapshot from public.bookings where id = '00000000-0000-4000-8000-00000000a952'$$,
  $$values ('Flat 9, 9 Text Road, London'::text, null::text, null::text)$$, 'A booking written with the text only is tidied and keeps no old parts');
select throws_ok($$select pg_temp.raw_booking('00000000-0000-4000-8000-00000000a953', null, null, null, null)$$, '23502', null, 'A booking with no address at all is refused');
select throws_ok($$select pg_temp.raw_booking('00000000-0000-4000-8000-00000000a954', repeat('a', 401), null, null, null)$$, '23514', null, 'A booking address of more than 400 characters is refused by the table itself');
delete from public.bookings where id in ('00000000-0000-4000-8000-00000000a951', '00000000-0000-4000-8000-00000000a952');

-- ---------------------------------------------------------------------------------------------
-- The Admin adds a client
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a901","role":"authenticated"}', true);
set local role authenticated;
create temp table new_clients as select 'text'::text as kind, c.id from public.admin_create_client('{"first_name":"Cleo","address":"Flat 4\n12 Client Road\nLondon SW1A 5AA","entry_instructions":"Ring twice"}', gen_random_uuid()) c;
insert into new_clients select 'wins', c.id from public.admin_create_client('{"first_name":"Dina","address":"1 Wins Road","address_line_1":"2 Loses Road","city":"London","postcode":"SW1A 1AA"}', gen_random_uuid()) c;
insert into new_clients select 'legacy', c.id from public.admin_create_client('{"first_name":"Eli","address_line_1":"3 Old Road","city":"London","postcode":"sw1a 6aa"}', gen_random_uuid()) c;
insert into new_clients select 'blank', c.id from public.admin_create_client('{"first_name":"Fay","address":"   "}', gen_random_uuid()) c;
insert into new_clients select 'name', c.id from public.admin_create_client('{"first_name":"Gus"}', gen_random_uuid()) c;
grant select on new_clients to authenticated;
select throws_ok($$select * from public.admin_create_client('{"first_name":"Hal","entry_instructions":"Ring twice","address":""}', gen_random_uuid())$$, '22023', 'Address is required', 'Entry instructions need an address to belong to');
select throws_ok($$select * from public.admin_create_client(jsonb_build_object('first_name', 'Ivy', 'address', repeat('a', 401)), gen_random_uuid())$$, '22023', 'That address is too long', 'An address of more than 400 characters is refused');
select throws_ok($$select * from public.admin_create_client('{"first_name":"Jay","address_line_1":"4 Part Road"}', gen_random_uuid())$$, '22023', 'Address, city and postcode are required', 'The old parts still have to be complete');
select throws_ok($$select * from public.admin_create_client('{"first_name":"Kit","adress":"typo"}', gen_random_uuid())$$, '22023', 'Invalid client details', 'A misspelt field is still refused');
reset role;
select results_eq($$select a.address, a.address_line_1, a.entry_instructions, a.is_default from public.client_addresses a join new_clients n on n.id = a.client_id where n.kind = 'text'$$,
  $$values ('Flat 4, 12 Client Road, London SW1A 5AA'::text, null::text, 'Ring twice'::text, true)$$, 'A client added with an address as one text has it tidied, as their usual address, with the instructions');
select is((select a.address from public.client_addresses a join new_clients n on n.id = a.client_id where n.kind = 'wins'), '1 Wins Road', 'When both are given the text wins');
select results_eq($$select a.address, a.address_line_1, a.postcode from public.client_addresses a join new_clients n on n.id = a.client_id where n.kind = 'legacy'$$,
  $$values ('3 Old Road, London, SW1A 6AA'::text, '3 Old Road'::text, 'SW1A 6AA'::text)$$, 'A client added by an old screen with the parts has both, the text put together');
select is((select count(*)::integer from public.client_addresses a join new_clients n on n.id = a.client_id where n.kind in ('blank', 'name')), 0, 'A blank address, or none, makes a client with no address');
select is((select count(*)::integer from public.clients where first_name in ('Hal', 'Ivy', 'Jay', 'Kit')), 0, 'Nothing was made for the refused ones');

-- ---------------------------------------------------------------------------------------------
-- The Admin books an appointment
-- ---------------------------------------------------------------------------------------------
create function pg_temp.breq(p_saved uuid, p_address jsonb, p_offset integer) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('client_id', '00000000-0000-4000-8000-00000000a912', 'saved_address_id', p_saved, 'address', p_address,
    'service_area_id', '00000000-0000-4000-8000-00000000a931',
    'sessions', jsonb_build_array(jsonb_build_object('service_id', '00000000-0000-4000-8000-00000000a921', 'duration_minutes', 60, 'recipient_name', 'Bea')),
    'enhancement_ids', '[]'::jsonb, 'date', pg_temp.day(p_offset), 'start_minutes', 600, 'payment_arrangement', 'bank_pending', 'note', null));
$$;
set local role authenticated;
create temp table admin_bookings as select 'text'::text as kind, c.booking_id from public.admin_create_booking(pg_temp.breq(null, '{"address":"Flat 7\n7 Booked Road\nLondon SW1A 7AA","entry_instructions":"Side door"}', 10), gen_random_uuid()) c;
insert into admin_bookings select 'legacy', c.booking_id from public.admin_create_booking(pg_temp.breq(null, '{"address_line_1":"8 Legacy Road","city":"London","postcode":"sw1a 8aa"}', 11), gen_random_uuid()) c;
insert into admin_bookings select 'saved', c.booking_id from public.admin_create_booking(pg_temp.breq('00000000-0000-4000-8000-00000000a941', null, 12), gen_random_uuid()) c;
grant select on admin_bookings to authenticated;
select throws_ok($$select * from public.admin_create_booking(pg_temp.breq(null, '{"address":"  "}', 13), gen_random_uuid())$$, '22023', 'Address is required', 'A one-off address with nothing in it is refused');
select throws_ok($$select * from public.admin_create_booking(pg_temp.breq(null, jsonb_build_object('address', repeat('a', 401)), 13), gen_random_uuid())$$, '22023', 'That address is too long', 'One of more than 400 characters is refused');
select throws_ok($$select * from public.admin_create_booking(pg_temp.breq(null, '{"address_line_1":"9 Part Road"}', 13), gen_random_uuid())$$, '22023', 'Address, city and postcode are required', 'The old parts still have to be complete');
select throws_ok($$select * from public.admin_create_booking(pg_temp.breq('00000000-0000-4000-8000-00000000a941', '{"address":"1 Both Road"}', 13), gen_random_uuid())$$, '22023', 'Choose a saved address or a one-off address', 'A saved address and a one-off one together are still refused');
reset role;
select results_eq($$select b.address_snapshot, b.entry_instructions_snapshot, b.address_line_1_snapshot, b.saved_address_id from public.bookings b join admin_bookings a on a.booking_id = b.id where a.kind = 'text'$$,
  $$values ('Flat 7, 7 Booked Road, London SW1A 7AA'::text, 'Side door'::text, null::text, null::uuid)$$, 'A one-off address written as one text is kept as it was on the day, tidied, with its instructions');
select results_eq($$select b.address_snapshot, b.address_line_1_snapshot, b.postcode_snapshot from public.bookings b join admin_bookings a on a.booking_id = b.id where a.kind = 'legacy'$$,
  $$values ('8 Legacy Road, London, SW1A 8AA'::text, '8 Legacy Road'::text, 'SW1A 8AA'::text)$$, 'A one-off address in its old parts is put together');
select is((select b.address_snapshot from public.bookings b join admin_bookings a on a.booking_id = b.id where a.kind = 'saved'), 'Flat 3, 8 New Road, London SW1A 2AA', 'A saved address is copied onto the booking as its text');
select is((select count(*)::integer from public.bookings b join admin_bookings a on a.booking_id = b.id where b.address_snapshot is not null), 3, 'Every booking has its address');

-- ---------------------------------------------------------------------------------------------
-- A client books online
-- ---------------------------------------------------------------------------------------------
create function pg_temp.reserve(p_key text, p_date date, p_address text, p_line1 text default null, p_city text default null, p_postcode text default null,
  p_instructions text default null) returns uuid language plpgsql as $$
declare h record; r record;
begin
  select * into h from public.create_booking_hold(p_date, 600, 60, 'addr-browser-' || p_key || '-0000000');
  select * into r from public.finalize_client_booking(p_hold_id := h.hold_id, p_hold_token := h.hold_token, p_hold_client_key := 'addr-browser-' || p_key || '-0000000',
    p_service_area_id := '00000000-0000-4000-8000-00000000a931', p_sessions := '[{"service_id":"00000000-0000-4000-8000-00000000a921","duration_minutes":60}]',
    p_enhancement_ids := '{}', p_saved_address_id := null, p_address_line_1 := p_line1, p_address_line_2 := null, p_city := p_city, p_postcode := p_postcode,
    p_entry_instructions := p_instructions, p_client_note := null, p_payment_method := 'bank_transfer', p_idempotency_key := 'addr-finalize-' || p_key, p_address := p_address);
  return r.booking_id;
end; $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a902","role":"authenticated"}', true);
create temp table client_bookings as select 'first'::text as kind, pg_temp.reserve('one', pg_temp.day(14), E'Flat 5\n5 Client Road\nLondon sw1a 5aa', p_instructions := 'Gate code 1234') as booking_id;
insert into client_bookings select 'same', pg_temp.reserve('two', pg_temp.day(15), 'flat 5, 5 CLIENT road  london SW1A 5AA');
insert into client_bookings select 'other', pg_temp.reserve('three', pg_temp.day(16), '77 Other Avenue, London E1 6AN');
insert into client_bookings select 'old', pg_temp.reserve('four', pg_temp.day(17), null, '1 Old Road', 'London', 'sw1a1aa');
insert into client_bookings select 'both', pg_temp.reserve('five', pg_temp.day(18), '2 Wins Lane, London', '3 Loses Lane', 'London', 'SW1A 1AA');
grant select on client_bookings to authenticated;
select throws_ok($$select pg_temp.reserve('six', pg_temp.day(19), '   ')$$, '22023', 'A complete booking address is required', 'An address with nothing in it is refused');
select throws_ok($$select pg_temp.reserve('seven', pg_temp.day(19), repeat('a', 401))$$, '22023', 'That address is too long', 'One of more than 400 characters is refused');
select throws_ok($$select pg_temp.reserve('eight', pg_temp.day(19), null, '4 Part Road')$$, '22023', 'A complete booking address is required', 'The old parts still have to be complete');
select is((select public.get_my_booking((select booking_id from client_bookings where kind = 'first'))->>'address_snapshot'), 'Flat 5, 5 Client Road, London sw1a 5aa', 'The client sees the address of their booking as one text');
reset role;
select results_eq($$select b.address_snapshot, b.entry_instructions_snapshot, b.address_line_1_snapshot from public.bookings b join client_bookings c on c.booking_id = b.id where c.kind = 'first'$$,
  $$values ('Flat 5, 5 Client Road, London sw1a 5aa'::text, 'Gate code 1234'::text, null::text)$$, 'A first booking keeps the address as one text, with the way in');
select results_eq($$select a.address, a.address_line_1, a.label, a.is_default, a.entry_instructions from public.client_addresses a where a.client_id = '00000000-0000-4000-8000-00000000a911' and a.is_default$$,
  $$values ('Flat 5, 5 Client Road, London sw1a 5aa'::text, null::text, 'Home'::text, true, 'Gate code 1234'::text)$$, 'and saves it as their usual address, as Home');
select is((select count(*)::integer from public.client_addresses where client_id = '00000000-0000-4000-8000-00000000a911' and normalized_address = 'flat55clientroadlondonsw1a5aa'), 1,
  'The same address typed again, in other capitals, commas and spaces, is not saved twice');
select is((select b.saved_address_id from public.bookings b join client_bookings c on c.booking_id = b.id where c.kind = 'same'),
  (select b.saved_address_id from public.bookings b join client_bookings c on c.booking_id = b.id where c.kind = 'first'), 'and the second booking uses the saved one');
select results_eq($$select a.address, a.label, a.is_default from public.client_addresses a join public.bookings b on b.saved_address_id = a.id join client_bookings c on c.booking_id = b.id where c.kind = 'other'$$,
  $$values ('77 Other Avenue, London E1 6AN'::text, 'Saved address'::text, false)$$, 'A different address is saved next to it');
select results_eq($$select b.address_snapshot, b.address_line_1_snapshot, b.city_snapshot, b.postcode_snapshot from public.bookings b join client_bookings c on c.booking_id = b.id where c.kind = 'old'$$,
  $$values ('1 Old Road, London, SW1A1AA'::text, '1 Old Road'::text, 'London'::text, 'SW1A1AA'::text)$$, 'An old screen booking with the parts keeps them and gets the text put together');
select is((select b.address_snapshot from public.bookings b join client_bookings c on c.booking_id = b.id where c.kind = 'both'), '2 Wins Lane, London', 'When both are given the text wins');
select is((select count(*)::integer from public.client_addresses where client_id = '00000000-0000-4000-8000-00000000a911'), 4, 'Four different addresses were saved for four different places');

-- A request that is sent again with the same key is answered again; with another address it is not the same request.
create function pg_temp.replay(p_key text, p_date date, p_first text, p_second text) returns text language plpgsql as $$
declare h record; v_booking uuid; v_again uuid;
begin
  select * into h from public.create_booking_hold(p_date, 600, 60, 'addr-browser-' || p_key || '-0000000');
  select f.booking_id into v_booking from public.finalize_client_booking(p_hold_id := h.hold_id, p_hold_token := h.hold_token, p_hold_client_key := 'addr-browser-' || p_key || '-0000000',
    p_service_area_id := '00000000-0000-4000-8000-00000000a931', p_sessions := '[{"service_id":"00000000-0000-4000-8000-00000000a921","duration_minutes":60}]',
    p_enhancement_ids := '{}', p_saved_address_id := null, p_address_line_1 := null, p_address_line_2 := null, p_city := null, p_postcode := null,
    p_entry_instructions := null, p_client_note := null, p_payment_method := 'bank_transfer', p_idempotency_key := 'addr-finalize-' || p_key, p_address := p_first) f;
  begin
    select f.booking_id into v_again from public.finalize_client_booking(p_hold_id := h.hold_id, p_hold_token := h.hold_token, p_hold_client_key := 'addr-browser-' || p_key || '-0000000',
      p_service_area_id := '00000000-0000-4000-8000-00000000a931', p_sessions := '[{"service_id":"00000000-0000-4000-8000-00000000a921","duration_minutes":60}]',
      p_enhancement_ids := '{}', p_saved_address_id := null, p_address_line_1 := null, p_address_line_2 := null, p_city := null, p_postcode := null,
      p_entry_instructions := null, p_client_note := null, p_payment_method := 'bank_transfer', p_idempotency_key := 'addr-finalize-' || p_key, p_address := p_second) f;
    return case when v_again = v_booking then 'the same booking' else 'another booking' end;
  exception when sqlstate '22023' then
    return sqlerrm;
  end;
end; $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a902","role":"authenticated"}', true);
select is(pg_temp.replay('nine', pg_temp.day(21), '5 Replay Road, London', '5 Replay Road, London'), 'the same booking', 'The same request sent again is answered with the same booking');
select is(pg_temp.replay('ten', pg_temp.day(22), '5 Replay Road, London', '6 Other Road, London'), 'Idempotency key was already used for a different request', 'The same key with another address is not the same request');
reset role;

-- ---------------------------------------------------------------------------------------------
-- What clients are told: the address is the one text
-- ---------------------------------------------------------------------------------------------
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.bank_transfer_verified', 'booking', (select booking_id from client_bookings where kind = 'first'), 'addr-verified-1', '{}');
select ok((select d.body like '%Flat 5, 5 Client Road, London sw1a 5aa%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select booking_id from client_bookings where kind = 'first') and e.event_type = 'booking.bank_transfer_verified' and d.audience = 'client' and d.channel = 'email' limit 1),
  'The email confirming a booking a client made names the address as the one text');
select ok((select d.body like '%Flat 7, 7 Booked Road, London SW1A 7AA%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select booking_id from admin_bookings where kind = 'text') and e.event_type = 'booking.created' and d.audience = 'client' and d.channel = 'email' limit 1),
  'So does the one for a booking the Admin made');
select ok((select d.body like '%8 Legacy Road, London, SW1A 8AA%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select booking_id from admin_bookings where kind = 'legacy') and e.event_type = 'booking.created' and d.audience = 'client' and d.channel = 'email' limit 1),
  'A booking made with the old parts reads as before');
select is((select public.plan_day_of_reminders(((pg_temp.day(10)::timestamp + interval '8 hours 30 minutes') at time zone 'Europe/London')::timestamptz)), 1, 'The morning reminder is made for the booking that day');
select ok((select d.body like '%Flat 7, 7 Booked Road, London SW1A 7AA%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select booking_id from admin_bookings where kind = 'text') and e.event_type = 'booking.reminder' and d.audience = 'client' and d.channel = 'email' limit 1),
  'and it says where, with the one text');
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.series_due', 'booking', (select booking_id from admin_bookings where kind = 'text'), 'addr-series-due', '{}');
select ok((select d.body like '%Flat 7, 7 Booked Road, London SW1A 7AA%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select booking_id from admin_bookings where kind = 'text') and e.event_type = 'booking.series_due' and d.audience = 'client' and d.channel = 'email' limit 1),
  'and so does the message about the next session of a repeat');

-- ---------------------------------------------------------------------------------------------
-- Two profiles of one person are combined: the same address, however it was typed, is kept once
-- ---------------------------------------------------------------------------------------------
insert into public.client_addresses(id, client_id, address, is_default) values
  ('00000000-0000-4000-8000-00000000a961', '00000000-0000-4000-8000-00000000a913', 'Flat 6, 6 Merge Road, London SW1A 6AA', true),
  ('00000000-0000-4000-8000-00000000a962', '00000000-0000-4000-8000-00000000a914', E'flat 6\n6 merge road\nlondon sw1a 6aa', true),
  ('00000000-0000-4000-8000-00000000a963', '00000000-0000-4000-8000-00000000a914', 'Elsewhere 1, Paris', false);
update public.client_addresses set entry_instructions = 'Gate code 4321' where id = '00000000-0000-4000-8000-00000000a962';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a901","role":"authenticated"}', true);
select lives_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000a913', '00000000-0000-4000-8000-00000000a914', gen_random_uuid())$$, 'The Admin combines the two profiles');
reset role;
select is((select count(*)::integer from public.client_addresses where client_id = '00000000-0000-4000-8000-00000000a913'), 2, 'The kept profile has its own address and the one it did not have, not the same one twice');
select is((select entry_instructions from public.client_addresses where id = '00000000-0000-4000-8000-00000000a961'), 'Gate code 4321', 'and the way in the copy knew is kept on it');
select is((select count(*)::integer from public.client_addresses where id = '00000000-0000-4000-8000-00000000a962'), 0, 'The copy is gone');
select is((select address from public.client_addresses where id = '00000000-0000-4000-8000-00000000a963'), 'Elsewhere 1, Paris', 'The other address moved across as it was');

select * from finish();
rollback;
