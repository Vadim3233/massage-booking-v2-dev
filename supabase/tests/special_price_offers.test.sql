begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- Fixtures: the Admin, two clients, a treatment (60 min £85, 90 min £110) and an area with a travel fee, a congestion charge and a 90-minute minimum.
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000c501', 'authenticated', 'authenticated', 'offer-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000c502', 'authenticated', 'authenticated', 'offer-client@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000c503', 'authenticated', 'authenticated', 'offer-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c501');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000c511', '00000000-0000-0000-0000-00000000c502', 'Olive', 'Offer', 'offer-client@example.test', '+44 7700 900511'),
  ('00000000-0000-4000-8000-00000000c512', '00000000-0000-0000-0000-00000000c503', 'Otto', 'Other', 'offer-other@example.test', '+44 7700 900512');
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000c521', 'offer-test-service', 'Offer Test Massage', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values
  ('00000000-0000-4000-8000-00000000c521', 60, 85, true), ('00000000-0000-4000-8000-00000000c521', 90, 110, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order, minimum_booking_minutes)
values ('00000000-0000-4000-8000-00000000c531', 'offer-test-area', 'Offer Test Area', true, 20, 15, 990, 90);
-- Only this treatment counts here, so "the usual price" is known.
update public.services set active = false where id <> '00000000-0000-4000-8000-00000000c521';
create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
-- Working hours that never offer 17:00 as a usual time (a set first appointment at 10:00), so only the offer can open it.
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
  select pg_temp.day(d), true, 600, 1200, 'flexible' from generate_series(0, 10) d
  on conflict (date) do update set available = true, start_minutes = 600, end_minutes = 1200, start_mode = 'flexible', fixed_start_minutes = null;
-- Three days' notice, so the offer's time two days ahead is inside the usual notice.
insert into public.business_settings(key, value) values ('new_client_booking_limit', '20'), ('returning_client_booking_limit', '20'), ('minimum_notice_minutes', '4320')
  on conflict (key) do update set value = excluded.value;

create function pg_temp.as_user(p_sub text) returns void language sql as $$
  select set_config('role', 'authenticated', true), set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.offer_closes() returns timestamptz language sql as $$ select ((pg_temp.day(2) + time '16:00') at time zone 'Europe/London'); $$;
-- The browser's hold id and token, which in the app the browser keeps (copied before booking, below).
create temp table browser_holds (id uuid, hold_token uuid, client_key text, created_at timestamptz);
grant select on browser_holds to authenticated;
create function pg_temp.book(p_code text, p_key text, p_sessions jsonb, p_request text) returns setof record language sql as $$
  select f.booking_id, f.total_gbp from public.finalize_client_booking(
    p_hold_id := (select h.id from browser_holds h where h.client_key = p_key order by h.created_at desc limit 1),
    p_hold_token := (select h.hold_token from browser_holds h where h.client_key = p_key order by h.created_at desc limit 1),
    p_hold_client_key := p_key, p_service_area_id := '00000000-0000-4000-8000-00000000c531', p_sessions := p_sessions, p_enhancement_ids := '{}'::uuid[],
    p_saved_address_id := null, p_address_line_1 := null, p_address_line_2 := null, p_city := null, p_postcode := null, p_entry_instructions := null,
    p_client_note := null, p_payment_method := 'bank_transfer', p_idempotency_key := p_request, p_address := '1 Offer Road, London', p_offer_code := p_code) f;
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_create_slot_offer(date,integer,integer,numeric,timestamptz)', 'EXECUTE'), 'A visitor cannot make an offer');
select ok(has_function_privilege('anon', 'public.get_slot_offer(text,text)', 'EXECUTE'), 'Anyone with the link can see the offer');
select ok(has_function_privilege('anon', 'public.create_offer_hold(text,text)', 'EXECUTE'), 'and hold its time before signing in');
select ok(not has_table_privilege('anon', 'public.slot_offers', 'SELECT'), 'Visitors cannot list offers');
select ok(to_regprocedure('public.finalize_client_booking(uuid,uuid,text,uuid,jsonb,uuid[],uuid,text,text,text,text,text,text,text,text,text,text)') is not null, 'Finalize takes an offer code');

select pg_temp.as_user('00000000-0000-0000-0000-00000000c502');
select throws_ok($$select public.admin_create_slot_offer(pg_temp.day(2), 1020, 60, 55, pg_temp.offer_closes())$$, '42501', 'Admin authorization required', 'A client cannot make an offer');
select is((select count(*)::int from public.slot_offers), 0, 'nor read any');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Making an offer
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c501');
select throws_ok($$select public.admin_create_slot_offer(pg_temp.day(2), 1020, 45, 55, pg_temp.offer_closes())$$, '22023', null, 'A length that is not on the half hour is refused');
select throws_ok($$select public.admin_create_slot_offer(pg_temp.day(2), 1020, 150, 55, pg_temp.offer_closes())$$, '22023', 'No treatment is offered at 150 minutes. Choose another length.', 'A length with no treatment is refused');
select throws_ok($$select public.admin_create_slot_offer(pg_temp.day(2), 1020, 60, 0, pg_temp.offer_closes())$$, '22023', 'Enter a price in pounds, for example 55.', 'A price must be more than nothing');
select throws_ok($$select public.admin_create_slot_offer(pg_temp.day(2), 1020, 60, 55, pg_temp.offer_closes() + interval '2 hours')$$, '22023', 'The offer must close by the time the appointment starts.', 'It must close by the start');
select throws_ok($$select public.admin_create_slot_offer(pg_temp.day(-1), 1020, 60, 55, now() + interval '1 hour')$$, '22023', 'That time has already started. Choose a later time.', 'A time in the past is refused');
create temp table made as select * from public.admin_create_slot_offer(pg_temp.day(2), 1020, 60, 55, pg_temp.offer_closes());
grant select on made to authenticated, anon;
select is((select price_gbp from made), 55.00, 'The Admin makes an offer at £55');
select is((select normal_price_gbp from made), 85.00, 'which remembers the usual £85');
select ok((select code ~ '^[A-HJKMNP-Z2-9]{6}$' from made), 'with a short code of letters and digits that are easy to read');
select is((select status from made), 'open', 'and it is open');
select throws_ok($$select public.admin_create_slot_offer(pg_temp.day(2), 990, 60, 50, pg_temp.offer_closes() - interval '1 hour')$$, 'PT409', 'There is already a special offer at that time. Tap it in the Calendar to change it.', 'A second offer overlapping it is refused');
select is((select count(*)::int from public.slot_offers), 1, 'The Admin can read offers (the Calendar)');
select is((select price_gbp from public.admin_update_slot_offer((select id from made), 60, pg_temp.offer_closes())), 60.00, 'and change the price');
select is((select price_gbp from public.admin_update_slot_offer((select id from made), 55, pg_temp.offer_closes())), 55.00, 'and back');
reset role;

-- ---------------------------------------------------------------------------------------------
-- The link
-- ---------------------------------------------------------------------------------------------
set local role anon;
select is((select state from public.get_slot_offer((select lower(code) from made))), 'open', 'The link opens the offer (any letter case)');
select is((select price_gbp from public.get_slot_offer((select code from made))), 55.00, 'at £55');
select is((select state from public.get_slot_offer('NOSUCH')), 'missing', 'A wrong code says so');
select is((select count(*)::int from public.create_offer_hold((select code from made), 'offer-browser-one-0000000000')), 1, 'A visitor holds the time');
select is((select state from public.get_slot_offer((select code from made), 'offer-browser-two-0000000000')), 'busy', 'Someone else sees it is being booked right now');
select is((select state from public.get_slot_offer((select code from made), 'offer-browser-one-0000000000')), 'open', 'The one holding it still sees it open');
select throws_ok($$select * from public.create_offer_hold((select code from made), 'offer-browser-two-0000000000')$$, '23P01', 'Sorry, this special time is no longer available.', 'and the other cannot hold it too');
select is((select count(*)::int from public.create_offer_hold((select code from made), 'offer-browser-one-0000000000')), 1, 'Holding again (a retry) keeps the same hold');
reset role;
select is((select count(*)::int from public.booking_holds where client_key = 'offer-browser-one-0000000000' and status = 'active'), 1, 'so there is still one');
select is((select slot_offer_id from public.booking_holds where client_key = 'offer-browser-one-0000000000' and status = 'active'), (select id from made), 'The hold knows its offer');

-- The price: all-in, whatever the area's fees.
set local role anon;
select is((select total_gbp from public.quote_offer_booking((select code from made), '00000000-0000-4000-8000-00000000c531', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60}]', '{}')), 55.00, 'The price is £55, with no travel fee or congestion charge');
select is((select travel_fee_gbp + congestion_fee_gbp from public.quote_offer_booking((select code from made), '00000000-0000-4000-8000-00000000c531', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60}]', '{}')), 0.00, 'shown as nothing extra');
select is((select total_gbp from public.quote_client_booking('00000000-0000-4000-8000-00000000c531', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60}]', '{}')), 120.00, 'The usual price there is still £85 + £20 + £15');
select throws_ok($$select * from public.quote_offer_booking((select code from made), '00000000-0000-4000-8000-00000000c531', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60},{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60}]', '{}')$$,
  '22023', 'This special price is for one person, 60 minutes, with no extras.', 'Two people are refused');
select throws_ok($$select * from public.quote_offer_booking((select code from made), '00000000-0000-4000-8000-00000000c531', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":90}]', '{}')$$,
  '22023', 'This special price is for one person, 60 minutes, with no extras.', 'Another length is refused');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Booking it
-- ---------------------------------------------------------------------------------------------
insert into browser_holds select id, hold_token, client_key, created_at from public.booking_holds where status = 'active';
select pg_temp.as_user('00000000-0000-0000-0000-00000000c502');
select throws_ok($$select * from pg_temp.book(null, 'offer-browser-one-0000000000', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60}]', 'offer-request-plain') as (id uuid, total numeric)$$,
  '23P01', 'Time slot is no longer available', 'The offer''s hold cannot be booked at the usual price without the offer');
select throws_ok($$select * from pg_temp.book((select code from made), 'offer-browser-one-0000000000', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60},{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60}]', 'offer-request-two') as (id uuid, total numeric)$$,
  '23P01', null, 'Two people do not fit the offer''s hold');
create temp table booked as select * from pg_temp.book((select code from made), 'offer-browser-one-0000000000', '[{"service_id":"00000000-0000-4000-8000-00000000c521","duration_minutes":60}]', 'offer-request-one') as (id uuid, total numeric);
select is((select total from booked), 55.00, 'The client books it for £55, inside the usual notice and under the area''s 90-minute minimum');
reset role;
select is((select total_gbp from public.bookings where id = (select id from booked)), 55.00, 'The booking is £55');
select is((select travel_fee_gbp + congestion_fee_gbp + enhancements_total_gbp from public.bookings where id = (select id from booked)), 0.00, 'with nothing on top');
select is((select unit_price_gbp from public.booking_sessions where booking_id = (select id from booked)), 55.00, 'and the session at £55 (receipts)');
select is((select amount_gbp from public.booking_payments where booking_id = (select id from booked)), 55.00, 'The payment asked for is £55');
select is((select slot_offer_id from public.bookings where id = (select id from booked)), (select id from made), 'The booking knows it came from the offer');
select is((select (date, start_minutes, booking_status) from public.bookings where id = (select id from booked)), (pg_temp.day(2), 1020, 'awaiting_transfer'::text), 'at the offer''s time, waiting for the transfer as usual');
select is((select (status, booking_id) from public.slot_offers where id = (select id from made)), ('booked'::text, (select id from booked)), 'The offer is now booked');
set local role anon;
select is((select state from public.get_slot_offer((select code from made))), 'taken', 'The link now says it has gone');
select throws_ok($$select * from public.create_offer_hold((select code from made), 'offer-browser-two-0000000000')$$, '23P01', 'Sorry, this special time is no longer available.', 'and nobody else can hold it');
reset role;

-- The client cannot change it online (it would be priced again).
select throws_ok($$select public.client_change_check((select b from public.bookings b where b.id = (select id from booked)), 60)$$, '22023',
  'This booking has a special price, so it can''t be changed online. Please message Vadim and he''ll sort it out.', 'A special-price booking cannot be changed online');

-- ---------------------------------------------------------------------------------------------
-- Stopping and closing
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c501');
create temp table second as select * from public.admin_create_slot_offer(pg_temp.day(3), 1020, 60, 50, now() + interval '1 day');
grant select on second to authenticated, anon;
select is((select status from public.admin_stop_slot_offer((select id from second))), 'stopped', 'The Admin stops an offer');
select throws_ok($$select public.admin_update_slot_offer((select id from second), 40, now() + interval '1 day')$$, 'PT409', 'That offer has already been booked or stopped.', 'A stopped offer cannot be changed');
create temp table third as select * from public.admin_create_slot_offer(pg_temp.day(4), 1020, 60, 50, now() + interval '1 day');
grant select on third to authenticated, anon;
reset role;
set local role anon;
select is((select state from public.get_slot_offer((select code from second))), 'closed', 'A stopped offer''s link says it has closed');
select throws_ok($$select * from public.create_offer_hold((select code from second), 'offer-browser-three-00000000')$$, '23P01', 'Sorry, this special time is no longer available.', 'and its time cannot be held');
reset role;
update public.slot_offers set closes_at = now() - interval '1 minute' where id = (select id from third);
set local role anon;
select is((select state from public.get_slot_offer((select code from third))), 'closed', 'An offer past its closing time has closed too');
reset role;

-- An ordinary booking that takes the time first: the link says it has gone.
select pg_temp.as_user('00000000-0000-0000-0000-00000000c501');
create temp table fourth as select * from public.admin_create_slot_offer(pg_temp.day(5), 1020, 60, 50, now() + interval '1 day');
grant select on fourth to authenticated, anon;
reset role;
insert into public.bookings (client_id, service_area_id, date, start_minutes, treatment_duration_minutes, travel_buffer_minutes, booking_status, source_channel,
  created_by_actor_type, address_snapshot, service_area_name_snapshot, service_subtotal_gbp, enhancements_total_gbp, travel_fee_gbp, congestion_fee_gbp, total_gbp, booking_reference)
values ('00000000-0000-4000-8000-00000000c512', '00000000-0000-4000-8000-00000000c531', pg_temp.day(5), 1020, 60, 60, 'confirmed', 'admin', 'admin', '2 Other Road',
  'Offer Test Area', 85, 0, 0, 0, 85, 'VDM-OFFER-TEST-1');
set local role anon;
select is((select state from public.get_slot_offer((select code from fourth))), 'taken', 'A time booked another way shows as gone');
reset role;

select * from finish();
rollback;
