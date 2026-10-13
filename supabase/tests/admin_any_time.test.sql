begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- An Admin, someone who is not, a client with an address, one treatment and one area.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000a701', 'authenticated', 'authenticated', 'any-time-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000a702', 'authenticated', 'authenticated', 'any-time-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a701');
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000a801', 'Amelia', 'Hart', 'amelia.anytime@example.test');
insert into public.client_addresses(id, client_id, address_line_1, city, postcode, is_default)
values ('00000000-0000-4000-8000-00000000a802', '00000000-0000-4000-8000-00000000a801', '1 Test Street', 'London', 'SW3 1AA', true);
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000a803', 'any-time-treatment', 'Any time treatment', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active)
values ('00000000-0000-4000-8000-00000000a803', 60, 85, true), ('00000000-0000-4000-8000-00000000a803', 90, 115, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order)
values ('00000000-0000-4000-8000-00000000a804', 'any-time-area', 'Any time area', true, 12, 0, 990);

create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
create function pg_temp.as_admin() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a701","role":"authenticated"}', true); $$;
-- The way a booking is asked for, with or without "any time".
create function pg_temp.request(p_offset integer, p_start integer, p_any boolean default null, p_minutes integer default 60) returns jsonb language sql as $$
  select jsonb_build_object('client_id', '00000000-0000-4000-8000-00000000a801', 'saved_address_id', '00000000-0000-4000-8000-00000000a802',
    'service_area_id', '00000000-0000-4000-8000-00000000a804',
    'sessions', jsonb_build_array(jsonb_build_object('service_id', '00000000-0000-4000-8000-00000000a803', 'duration_minutes', p_minutes, 'recipient_name', 'Amelia')),
    'enhancement_ids', '[]'::jsonb, 'date', pg_temp.day(p_offset), 'start_minutes', p_start, 'payment_arrangement', 'bank_pending')
  || case when p_any is null then '{}'::jsonb else jsonb_build_object('any_time', p_any) end;
$$;
-- An appointment put straight into the diary, for the checks on what clients are offered.
create function pg_temp.appointment(p_offset integer, p_start integer, p_minutes integer default 60) returns void language sql as $$
  insert into public.bookings(booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, total_gbp)
  select 'ANY-' || gen_random_uuid(), '00000000-0000-4000-8000-00000000a801', a.id, pg_temp.day(p_offset), p_start, p_minutes, 'confirmed', 'test',
    '1 Test Street', 'London', 'SW3 1AA', a.name, 85, 85 from public.service_areas a where a.id = '00000000-0000-4000-8000-00000000a804';
$$;
create function pg_temp.working(p_offset integer, p_open boolean, p_from integer, p_to integer, p_mode text default 'flexible', p_fixed integer default null) returns void language sql as $$
  insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes)
  values (pg_temp.day(p_offset), p_open, case when p_open then p_from end, case when p_open then p_to end, p_mode, p_fixed)
  on conflict (date) do update set available = excluded.available, start_minutes = excluded.start_minutes, end_minutes = excluded.end_minutes,
    start_mode = excluded.start_mode, fixed_start_minutes = excluded.fixed_start_minutes;
$$;
-- Day 20: a working day, 14:30 to 17:30. Day 21: a day off. Day 22: a fixed 14:30 start. Day 23 and 24: working days, 14:30 to 17:30. Day 25: open all day.
select pg_temp.working(20, true, 870, 1050);
select pg_temp.working(21, false, null, null);
select pg_temp.working(22, true, 870, 1050, 'fixed', 870);
select pg_temp.working(23, true, 870, 1050);
select pg_temp.working(24, true, 870, 1050);
select pg_temp.working(25, true, 0, 1440);
select pg_temp.working(26, true, 0, 1440);

-- ---------------------------------------------------------------------------------------------
-- What clients are offered must stay inside her working hours, however an appointment came to be outside them.
-- (This part uses appointments put straight into the diary, so it holds whatever created them.)
-- ---------------------------------------------------------------------------------------------
select pg_temp.appointment(23, 480);
select is((select count(*)::integer from public.compute_booking_availability(pg_temp.day(23), 60, clock_timestamp(), 60, null)), 0,
  'An appointment before her working hours does not open a time before them for anyone else');
select pg_temp.appointment(24, 1260);
select is((select count(*)::integer from public.compute_booking_availability(pg_temp.day(24), 60, clock_timestamp(), 60, null)), 0,
  'Nor does one after them');
select pg_temp.appointment(20, 870);
select is((select array_agg(start_minutes order by start_minutes) from public.compute_booking_availability(pg_temp.day(20), 60, clock_timestamp(), 60, null)), array[990],
  'An ordinary day is as before: after the 14:30 appointment and a gap of 60 minutes, 16:30');

-- ---------------------------------------------------------------------------------------------
-- Who may ask
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'admin_booking_times', array['date', 'integer']);
select ok(not has_function_privilege('anon', 'public.admin_booking_times(date,integer)', 'EXECUTE'), 'Anonymous callers cannot ask for all the times');
select ok(has_function_privilege('authenticated', 'public.admin_booking_times(date,integer)', 'EXECUTE'), 'A signed-in caller can (and is then checked as the Admin)');
select ok(not has_function_privilege('authenticated', 'public.admin_time_clash(date,integer,integer,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_time_clash(date,integer,integer,timestamptz)', 'EXECUTE'), 'The overlap check is an inside helper, closed to outside callers');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_booking_times', 'admin_time_clash', 'admin_create_booking', 'admin_create_series')
    and not coalesce(p.prosecdef and p.proconfig @> array['search_path=""'], false)), 'These are definers with an empty search path');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a702","role":"authenticated"}', true);
select throws_ok($$select public.admin_booking_times(pg_temp.day(20), 60)$$, '42501', 'Admin authorization required', 'Someone who is not the Admin is refused');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a701","role":"authenticated","is_anonymous":true}', true);
select throws_ok($$select public.admin_booking_times(pg_temp.day(20), 60)$$, '42501', 'Admin authorization required', 'A guest session is refused');
select pg_temp.as_admin();
select throws_ok($$select public.admin_booking_times(pg_temp.day(20), 45)$$, '22023', 'Booking duration is invalid', 'An odd length is refused');
select throws_ok($$select public.admin_booking_times(pg_temp.day(366), 60)$$, '22023', 'Choose a date within the next 365 days', 'A date too far ahead is refused');
select throws_ok($$select public.admin_booking_times(pg_temp.day(-1), 60)$$, '22023', 'Choose a date within the next 365 days', 'A day that has gone is refused');

-- ---------------------------------------------------------------------------------------------
-- All the times of a day: day 20 has one appointment, 14:30 to 15:30
-- ---------------------------------------------------------------------------------------------
create temporary table t_day as select public.admin_booking_times(pg_temp.day(20), 60) as j;
create function pg_temp.slot(p_start integer) returns jsonb language sql as $$ select s from t_day, jsonb_array_elements(j->'slots') s where (s->>'start')::integer = p_start; $$;
select is((select j->'working' from t_day), '{"open": true, "start": 870, "end": 1050}'::jsonb, 'It says what her working hours are that day');
select is((select jsonb_array_length(j->'booked') from t_day), 1, 'It lists what is already in the diary');
select results_eq($$select (j->'booked'->0->>'start')::integer, (j->'booked'->0->>'end')::integer, j->'booked'->0->>'label', j->'booked'->0->>'kind' from t_day$$,
  $$values (870, 930, 'Amelia Hart'::text, 'booking'::text)$$, 'With its start, end and who it is for');
select is((select (j->>'buffer_minutes')::integer from t_day), 60, 'And the gap she normally keeps between appointments');
select is((pg_temp.slot(900)->>'clash')::boolean, true, '15:00 overlaps the 14:30 appointment');
select is((pg_temp.slot(870)->>'clash')::boolean, true, 'So does the same time');
select is((pg_temp.slot(930)->>'clash')::boolean, false, '15:30 starts as the appointment ends: no overlap');
select is((pg_temp.slot(930)->>'usual')::boolean, false, 'But it is not one of the usual times');
select results_eq($$select (pg_temp.slot(960)->>'clash')::boolean, (pg_temp.slot(960)->>'usual')::boolean$$, $$values (false, false)$$, '16:00 does not overlap, and is not usual (a 30 minute gap)');
select results_eq($$select (pg_temp.slot(990)->>'clash')::boolean, (pg_temp.slot(990)->>'usual')::boolean$$, $$values (false, true)$$, '16:30 is the usual time');
select results_eq($$select (pg_temp.slot(1020)->>'clash')::boolean, (pg_temp.slot(1020)->>'usual')::boolean$$, $$values (false, false)$$, '17:00 (ending after hours) is allowed to be chosen');
select ok(pg_temp.slot(360) is not null and pg_temp.slot(1380) is not null, 'The day runs from 06:00 to the last hour that can finish by midnight');
select ok(pg_temp.slot(330) is null and pg_temp.slot(1410) is null, 'Nothing before 06:00, and nothing that would run past midnight');
select is((select array_agg((s->>'start')::integer order by (s->>'start')::integer) filter (where (s->>'usual')::boolean) from t_day, jsonb_array_elements(j->'slots') s),
  (select array_agg(a.start_minutes order by a.start_minutes) from public.admin_booking_availability(pg_temp.day(20), 60) a), 'The usual times in the list are exactly the ones the booking page shows today');
insert into public.calendar_blocks(kind, date, start_minutes, end_minutes, title) values ('personal_event', pg_temp.day(20), 960, 990, 'Dentist');
select is((select public.admin_booking_times(pg_temp.day(20), 60)->'blocks'), '[{"start": 960, "end": 990, "title": "Dentist", "series": false}]'::jsonb, 'Blocked time and personal events are listed with their names');
select is((select (j->>'client_booking')::boolean from t_day), false, 'No client is booking on a day with no hold');
-- A day off, and a day with a fixed start.
select is((select public.admin_booking_times(pg_temp.day(21), 60)->'working'->>'open')::boolean, false, 'A day off says it is not a working day');
select ok((select bool_and(not (s->>'usual')::boolean) and count(*) > 20 from jsonb_array_elements(public.admin_booking_times(pg_temp.day(21), 60)->'slots') s), 'A day off still lists the times, none of them usual');
select is((select array_agg((s->>'start')::integer order by (s->>'start')::integer) filter (where (s->>'usual')::boolean) from jsonb_array_elements(public.admin_booking_times(pg_temp.day(22), 60)->'slots') s), array[870], 'A day with a fixed start has that one usual time');
select lives_ok($$select public.admin_create_booking(pg_temp.request(22, 870), gen_random_uuid())$$, 'A day with a fixed start is booked at that start as before');
select is((select array_agg(start_minutes order by start_minutes) from public.compute_booking_availability(pg_temp.day(22), 60, clock_timestamp(), 60, null)), array[990],
  'And once there is an appointment it offers what any day does: an hour after it');
-- Today: nothing that has already begun.
select ok(not exists (
  select 1 from jsonb_array_elements(public.admin_booking_times(pg_temp.day(0), 60)->'slots') s
  where (pg_temp.day(0) + make_interval(mins => (s->>'start')::integer)) at time zone 'Europe/London' <= clock_timestamp()), 'Times that have already begun are not listed');
-- A client who is part-way through booking holds a time.
select * from public.create_booking_hold(pg_temp.day(25), 600, 60, 'any-time-test-hold-0001');
select is((select (s->>'clash')::boolean from jsonb_array_elements(public.admin_booking_times(pg_temp.day(25), 60)->'slots') s where (s->>'start')::integer = 630), true, 'A time a client is in the middle of booking overlaps too');
select is((select j->'booked'->0->>'kind' from (select public.admin_booking_times(pg_temp.day(25), 60) j) q), 'hold', 'And is listed as a hold, without a name');
select is((public.admin_booking_times(pg_temp.day(25), 60)->>'client_booking')::boolean, true, 'The list says a client is booking that day');

-- ---------------------------------------------------------------------------------------------
-- Making the booking
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.admin_create_booking(pg_temp.request(20, 960), gen_random_uuid())$$, 'PT409', 'This time is no longer available. Choose another time.', 'Without "any time" a 30 minute gap is still refused');
select throws_ok($$select public.admin_create_booking(pg_temp.request(20, 960, false), gen_random_uuid())$$, 'PT409', 'This time is no longer available. Choose another time.', 'Saying "not any time" is the same');
select throws_ok($$select public.admin_create_booking(pg_temp.request(20, 960, true) || '{"any_time": "yes"}', gen_random_uuid())$$, '22023', 'Unsupported booking fields', 'It has to be yes or no');
create temporary table t_tight as select * from public.admin_create_booking(pg_temp.request(20, 960, true), '00000000-0000-4000-8000-00000000b001');
select results_eq($$select b.start_minutes, b.travel_buffer_minutes, b.booking_status from public.bookings b join t_tight t on t.booking_id = b.id$$,
  $$values (960, 60, 'confirmed'::text)$$, 'With "any time" 16:00 is booked, even inside the gap and during a personal event, as an ordinary confirmed booking');
select is((select booking_id from public.admin_create_booking(pg_temp.request(20, 960, true), '00000000-0000-4000-8000-00000000b001')), (select booking_id from t_tight), 'Sending the same request again answers with the same booking');
select throws_ok($$select public.admin_create_booking(pg_temp.request(20, 900, true), gen_random_uuid())$$, 'PT409', 'That time overlaps another appointment, so it is not available. Choose another time.', 'But never on top of another appointment');
select throws_ok($$select public.admin_create_booking(pg_temp.request(20, 990, true), gen_random_uuid())$$, 'PT409', 'That time overlaps another appointment, so it is not available. Choose another time.', 'Including the one just made (16:30 starts before 17:00)');
select lives_ok($$select public.admin_create_booking(pg_temp.request(20, 1020, true), gen_random_uuid())$$, 'Straight after it is fine: no overlap, even outside working hours');
select lives_ok($$select public.admin_create_booking(pg_temp.request(21, 600, true), gen_random_uuid())$$, 'A day off can be booked on purpose');
select throws_ok($$select public.admin_create_booking(pg_temp.request(21, 600), gen_random_uuid())$$, 'PT409', 'This time is no longer available. Choose another time.', 'Not without saying so');
select throws_ok($$select public.admin_create_booking(pg_temp.request(25, 630, true), gen_random_uuid())$$, 'PT409', 'That time overlaps another appointment, so it is not available. Choose another time.', 'Not over a time a client is holding');
select throws_ok($$select public.admin_create_booking(pg_temp.request(25, 900, true), gen_random_uuid())$$, 'PT409', 'A client is in the middle of booking that day. Try again in a few minutes.',
  'And not elsewhere that day either while a client is booking: it could take their held time away');
select lives_ok($$select public.admin_create_booking(pg_temp.request(25, 720), gen_random_uuid())$$, 'A usual time is still fine while a client is booking, as before');
update public.booking_holds set expires_at = clock_timestamp() - interval '1 minute' where date = pg_temp.day(25);
select is((public.admin_booking_times(pg_temp.day(25), 60)->>'client_booking')::boolean, false, 'Once the hold has expired no client is booking');
select lives_ok($$select public.admin_create_booking(pg_temp.request(25, 570, true), gen_random_uuid())$$, 'An expired hold neither overlaps nor makes unusual times wait');
select lives_ok($$select public.admin_create_booking(pg_temp.request(25, 660, true), gen_random_uuid())$$, 'So unusual times work again');
select throws_ok($$select public.admin_create_booking(pg_temp.request(0, 0, true), gen_random_uuid())$$, 'PT409', 'That time is in the past. Choose another time.', 'Never a time that has passed');
select throws_ok($$select public.admin_create_booking(pg_temp.request(25, 1410, true), gen_random_uuid())$$, '22023', 'That appointment would run past midnight. Choose an earlier time.', 'Never one that would run past midnight');
select throws_ok($$select public.admin_create_booking(pg_temp.request(25, 1385, true), gen_random_uuid())$$, '22023', 'Booking date and a 30-minute start boundary are required', 'Starts stay on the half hour');
select throws_ok($$select public.admin_create_booking(pg_temp.request(366, 600, true), gen_random_uuid())$$, '22023', 'Choose a date within the next 365 days', 'And within a year');
select lives_ok($$select public.admin_create_booking(pg_temp.request(25, 1380, true), gen_random_uuid())$$, 'A booking that ends exactly at midnight is fine');
select lives_ok($$select public.admin_create_booking(pg_temp.request(25, 120, true, 90), gen_random_uuid())$$, 'Longer treatments work the same way');
select throws_ok($$select public.admin_create_series(pg_temp.request(25, 780, true), null, gen_random_uuid())$$, '22023', 'A repeat uses the usual times only', 'A repeating booking cannot be made at an unusual time');
select is((select count(*)::integer from public.bookings b where b.client_id = '00000000-0000-4000-8000-00000000a801' and b.date = pg_temp.day(25) and b.start_minutes = 780), 0, 'And nothing was made');
select throws_ok($$select public.admin_create_series(pg_temp.request(26, 600, false), null, gen_random_uuid())$$, '22023', 'A repeat uses the usual times only', 'Even "no" is refused for a repeat: it is not part of one');
select lives_ok($$select public.admin_create_series(pg_temp.request(26, 600), null, '00000000-0000-4000-8000-00000000b002')$$, 'A repeat from a usual time is made as before');
select is((select (b->>'series')::boolean from jsonb_array_elements(public.admin_booking_times(pg_temp.day(33), 60)->'blocks') b limit 1), true, 'The time kept free for a repeating client is marked as such');

select * from finish();
rollback;
