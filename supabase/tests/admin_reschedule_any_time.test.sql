begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- An Admin, someone who is not, one client and the area a booking needs.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000c701', 'authenticated', 'authenticated', 'move-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000c702', 'authenticated', 'authenticated', 'move-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c701');
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000c801', 'Imogen', 'Frost', 'imogen.move@example.test');
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order)
values ('00000000-0000-4000-8000-00000000c804', 'move-any-time-area', 'Move any time area', true, 12, 0, 990);

create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
create function pg_temp.as_admin() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c701","role":"authenticated"}', true); $$;
-- An appointment put straight into the diary (created three days ago, so no grace period hides a late fee).
create function pg_temp.appointment(p_id uuid, p_offset integer, p_start integer, p_minutes integer default 60, p_status text default 'confirmed') returns void language sql as $$
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, total_gbp, created_at, cancelled_at)
  select p_id, 'MOVE-' || p_id, '00000000-0000-4000-8000-00000000c801', a.id, pg_temp.day(p_offset), p_start, p_minutes, p_status, 'test',
    '1 Test Street', 'London', 'SW3 1AA', a.name, 85, 85, now() - interval '3 days', case when p_status = 'cancelled' then now() end
  from public.service_areas a where a.id = '00000000-0000-4000-8000-00000000c804';
$$;
create function pg_temp.working(p_offset integer, p_open boolean, p_from integer, p_to integer, p_mode text default 'flexible', p_fixed integer default null) returns void language sql as $$
  insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes)
  values (pg_temp.day(p_offset), p_open, case when p_open then p_from end, case when p_open then p_to end, p_mode, p_fixed)
  on conflict (date) do update set available = excluded.available, start_minutes = excluded.start_minutes, end_minutes = excluded.end_minutes,
    start_mode = excluded.start_mode, fixed_start_minutes = excluded.fixed_start_minutes;
$$;
create function pg_temp.bv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = $1; $$;
-- Moving a booking the way the Admin's screen asks for it: a fresh request key and the booking as she last saw it.
create function pg_temp.move(p_id uuid, p_offset integer, p_start integer, p_any boolean default false, p_by text default 'admin') returns uuid language sql as $$
  select public.admin_reschedule_booking(p_id, gen_random_uuid(), pg_temp.bv(p_id), pg_temp.day(p_offset), p_start, p_by, p_any);
$$;
-- One half hour of one day from the Admin's list of all the times, optionally leaving out the booking that is being moved.
create function pg_temp.slot(p_offset integer, p_start integer, p_exclude uuid default null) returns jsonb language sql as $$
  select s from jsonb_array_elements(public.admin_booking_times(pg_temp.day(p_offset), 60, p_exclude)->'slots') s where (s->>'start')::integer = p_start;
$$;

-- Day 30: the day that was reported. Working 09:00-21:00, the first appointment at a set time (12:00), and one booking, at 12:00.
-- Day 31: 10:00-20:00 with two appointments, 10:00 and 12:00. Day 32: a day off. Day 33: 10:00-20:00 with a client part-way through booking 10:00.
-- Day 34: where a booking starts that will be moved to day 33. Day 35: two appointments, 10:00 and 12:00, for the list of times. Days 36 and 37: free working days.
select pg_temp.working(30, true, 540, 1260, 'fixed', 720);
select pg_temp.working(31, true, 600, 1200);
select pg_temp.working(32, false, null, null);
select pg_temp.working(33, true, 600, 1200);
select pg_temp.working(34, true, 600, 1200);
select pg_temp.working(35, true, 600, 1200);
select pg_temp.working(36, true, 600, 1200);
select pg_temp.working(37, true, 600, 1200);
select pg_temp.appointment('00000000-0000-4000-8000-00000000d101', 30, 720);
select pg_temp.appointment('00000000-0000-4000-8000-00000000d102', 31, 600);
select pg_temp.appointment('00000000-0000-4000-8000-00000000d103', 31, 720);
select pg_temp.appointment('00000000-0000-4000-8000-00000000d104', 34, 600);
select pg_temp.appointment('00000000-0000-4000-8000-00000000d105', 35, 600);
select pg_temp.appointment('00000000-0000-4000-8000-00000000d106', 35, 720);
select pg_temp.appointment('00000000-0000-4000-8000-00000000d107', 36, 600, 60, 'cancelled');
select pg_temp.appointment('00000000-0000-4000-8000-00000000d109', 37, 600, 60, 'awaiting_transfer');
-- Two bookings that start within 24 hours, for the late fee.
create function pg_temp.soon(p_id uuid) returns void language sql as $$
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, total_gbp, created_at)
  select p_id, 'MOVE-' || p_id, '00000000-0000-4000-8000-00000000c801', a.id, ((now() + interval '5 hours') at time zone 'Europe/London')::date,
    least((floor((extract(hour from (now() + interval '5 hours') at time zone 'Europe/London') * 60 + extract(minute from (now() + interval '5 hours') at time zone 'Europe/London')) / 30) * 30)::integer, 1380),
    60, 'confirmed', 'test', '1 Test Street', 'London', 'SW3 1AA', a.name, 85, 85, now() - interval '3 days' from public.service_areas a where a.id = '00000000-0000-4000-8000-00000000c804';
$$;
select pg_temp.soon('00000000-0000-4000-8000-00000000d108');
select pg_temp.soon('00000000-0000-4000-8000-00000000d10a');

-- ---------------------------------------------------------------------------------------------
-- The shape of the commands, and who may use them
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'admin_reschedule_booking', array['uuid', 'uuid', 'timestamp with time zone', 'date', 'integer', 'text', 'boolean']);
select hasnt_function('public', 'admin_reschedule_booking', array['uuid', 'uuid', 'timestamp with time zone', 'date', 'integer', 'text'], 'There is one move command, not two that could be confused');
select has_function('public', 'admin_booking_times', array['date', 'integer', 'uuid']);
select hasnt_function('public', 'admin_booking_times', array['date', 'integer'], 'There is one list of all the times, not two that could be confused');
select has_function('public', 'admin_time_clash', array['date', 'integer', 'integer', 'timestamp with time zone', 'uuid']);
select hasnt_function('public', 'admin_time_clash', array['date', 'integer', 'integer', 'timestamp with time zone'], 'There is one overlap check');
select ok(not has_function_privilege('anon', 'public.admin_reschedule_booking(uuid,uuid,timestamptz,date,integer,text,boolean)', 'EXECUTE'), 'Anonymous callers cannot move a booking');
select ok(has_function_privilege('authenticated', 'public.admin_reschedule_booking(uuid,uuid,timestamptz,date,integer,text,boolean)', 'EXECUTE'), 'A signed-in caller can (and is then checked as the Admin)');
select ok(not has_function_privilege('anon', 'public.admin_booking_times(date,integer,uuid)', 'EXECUTE'), 'Anonymous callers cannot ask for all the times');
select ok(has_function_privilege('authenticated', 'public.admin_booking_times(date,integer,uuid)', 'EXECUTE'), 'A signed-in caller can (and is then checked as the Admin)');
select ok(not has_function_privilege('authenticated', 'public.admin_time_clash(date,integer,integer,timestamptz,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_time_clash(date,integer,integer,timestamptz,uuid)', 'EXECUTE'), 'The overlap check is an inside helper, closed to outside callers');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_reschedule_booking', 'admin_booking_times', 'admin_time_clash')
    and not coalesce(p.prosecdef and p.proconfig @> array['search_path=""'], false)), 'These are definers with an empty search path');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c702","role":"authenticated"}', true);
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d101', 30, 1050, true)$$, '42501', 'Admin authorization required', 'Someone who is not the Admin cannot move a booking at any time');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d101', 30, 720)$$, '42501', 'Admin authorization required', 'Nor at a usual time');
select throws_ok($$select public.admin_booking_times(pg_temp.day(30), 60, '00000000-0000-4000-8000-00000000d101')$$, '42501', 'Admin authorization required', 'Nor look at all the times');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c701","role":"authenticated","is_anonymous":true}', true);
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d101', 30, 1050, true)$$, '42501', 'Admin authorization required', 'A guest session is refused too');
select pg_temp.as_admin();

-- ---------------------------------------------------------------------------------------------
-- What was reported: the only booking of a day that starts at a set time cannot be moved to another time of that day
-- ---------------------------------------------------------------------------------------------
select is((select array_agg(a.start_minutes order by a.start_minutes) from public.admin_booking_availability(pg_temp.day(30), 60, '00000000-0000-4000-8000-00000000d101') a), array[720],
  'The usual list for moving it is one time, 12:00: the day looks empty once the booking is set aside, and an empty day starts at its set time');
select is(public.admin_booking_times(pg_temp.day(30), 60, '00000000-0000-4000-8000-00000000d101')->'booked', '[]'::jsonb, 'The booking being moved is not listed as in the way');
select is((pg_temp.slot(30, 1050, '00000000-0000-4000-8000-00000000d101')->>'clash')::boolean, false, '17:30 is free for it');
select is((pg_temp.slot(30, 1050, '00000000-0000-4000-8000-00000000d101')->>'usual')::boolean, false, 'But it is not a usual time');
select is((pg_temp.slot(30, 720, '00000000-0000-4000-8000-00000000d101')->>'usual')::boolean, true, '12:00 is the usual start of that day');
select is((pg_temp.slot(30, 720, '00000000-0000-4000-8000-00000000d101')->>'clash')::boolean, false, 'The booking does not clash with itself');
select is((pg_temp.slot(30, 720)->>'clash')::boolean, true, 'Without saying which booking is being moved, 12:00 overlaps it, as before');
select is(jsonb_array_length(public.admin_booking_times(pg_temp.day(30), 60)->'booked'), 1, 'And it is listed, as before');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000d101', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000d101'), pg_temp.day(30), 1050, 'admin')$$,
  'PT409', 'This time is not available. Choose another time.', 'Without "any time" 17:30 is still refused, and a call with six arguments still works as it did');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d101', 30, 1050, false)$$, 'PT409', 'This time is not available. Choose another time.', 'Saying "not any time" is the same');
select set_config('test.version', pg_temp.bv('00000000-0000-4000-8000-00000000d101')::text, true);
set local role authenticated;
select is(public.admin_reschedule_booking('00000000-0000-4000-8000-00000000d101', '00000000-0000-4000-8000-00000000d1f1', current_setting('test.version')::timestamptz,
  pg_temp.day(30), 1050, 'admin', true), '00000000-0000-4000-8000-00000000d101'::uuid, 'With "any time" it moves to 17:30, as the signed-in Admin');
reset role;
select results_eq($$select date, start_minutes, booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000d101'$$,
  $$select pg_temp.day(30), 1050, 'confirmed'::text$$, 'It is a normal confirmed booking at the new time');
select results_eq($$select from_start_minutes, to_start_minutes, actor_type from public.booking_schedule_changes where booking_id = '00000000-0000-4000-8000-00000000d101'$$,
  $$values (720, 1050, 'admin'::text)$$, 'The move is in its history with the Admin as the actor');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000d101' and event_type = 'booking.rescheduled'), 1, 'One rescheduled event, so the client is told as for any move');
select is(public.admin_reschedule_booking('00000000-0000-4000-8000-00000000d101', '00000000-0000-4000-8000-00000000d1f1', current_setting('test.version')::timestamptz,
  pg_temp.day(30), 1050, 'admin', true), '00000000-0000-4000-8000-00000000d101'::uuid, 'Sending the same request again answers with the same booking');
select is((select count(*)::integer from public.booking_schedule_changes where booking_id = '00000000-0000-4000-8000-00000000d101'), 1, 'And moves nothing twice');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000d101', '00000000-0000-4000-8000-00000000d1f1', current_setting('test.version')::timestamptz, pg_temp.day(30), 1050, 'admin')$$,
  '22023', 'Request key reused', 'The same key with "any time" left out is a different request');
select is((select array_agg(a.start_minutes order by a.start_minutes) from public.compute_booking_availability(pg_temp.day(30), 60, clock_timestamp(), 60, null) a), array[930, 1170],
  'Clients are offered what they always are: an hour either side of the new run, nothing else');

-- ---------------------------------------------------------------------------------------------
-- What is still refused with "any time"
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 630, true)$$, 'PT409', 'That time overlaps another appointment, so it is not available. Choose another time.',
  'Never on top of another appointment (10:30 is inside the 10:00 one)');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 570, true)$$, 'PT409', 'That time overlaps another appointment, so it is not available. Choose another time.',
  'Nor partly over it (09:30 runs into the 10:00 one)');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 690, true)$$, 'A booking does not count against itself: 12:00 can move to 11:30, over its own old time');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 660, true)$$, 'Straight after another appointment is fine: no gap is needed');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 360, true)$$, 'So is a time before working hours');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 1380, true)$$, 'And one that ends exactly at midnight');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 1410, true)$$, '22023', 'That appointment would run past midnight. Choose an earlier time.', 'Never one that runs past midnight');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 31, 615, true)$$, '22023', 'Choose a date within the next 365 days and a 30-minute start', 'Starts stay on the half hour');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 366, 600, true)$$, '22023', 'Choose a date within the next 365 days and a 30-minute start', 'And within a year');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 0, 0, true)$$, 'PT409', 'That time is in the past. Choose another time.', 'Never a time that has begun');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 32, 600)$$, 'PT409', 'This time is not available. Choose another time.', 'A day off is refused unless she says so');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d103', 32, 600, true)$$, 'And accepted when she does');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d107', 36, 720, true)$$, 'PT409', 'Booking state changed', 'A cancelled booking cannot be moved, "any time" or not');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d109', 37, 900, true)$$, 'A booking waiting for its payment can be moved');
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000d109'), 'awaiting_transfer', 'And is still waiting for it');

-- ---------------------------------------------------------------------------------------------
-- A client who is part-way through booking
-- ---------------------------------------------------------------------------------------------
select * from public.create_booking_hold(pg_temp.day(33), 600, 60, 'move-any-time-hold-0001');
select is((pg_temp.slot(33, 630, '00000000-0000-4000-8000-00000000d104')->>'clash')::boolean, true, 'A time a client is in the middle of booking overlaps, whichever booking is being moved');
select is((public.admin_booking_times(pg_temp.day(33), 60, '00000000-0000-4000-8000-00000000d104')->>'client_booking')::boolean, true, 'The list says a client is booking that day');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d104', 33, 630, true)$$, 'PT409', 'That time overlaps another appointment, so it is not available. Choose another time.', 'Not over the time they are holding');
select throws_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d104', 33, 900, true)$$, 'PT409', 'A client is in the middle of booking that day. Try again in a few minutes.',
  'And not elsewhere that day either: it could take their held time away');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d104', 33, 720)$$, 'A usual time is still fine while a client is booking, as before');
update public.booking_holds set expires_at = clock_timestamp() - interval '1 minute' where date = pg_temp.day(33);
select is((public.admin_booking_times(pg_temp.day(33), 60, '00000000-0000-4000-8000-00000000d104')->>'client_booking')::boolean, false, 'Once the hold has expired no client is booking');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d104', 33, 900, true)$$, 'And unusual times work again');

-- ---------------------------------------------------------------------------------------------
-- The list of times can leave out the booking being moved
-- ---------------------------------------------------------------------------------------------
select is(jsonb_array_length(public.admin_booking_times(pg_temp.day(35), 60)->'booked'), 2, 'Both appointments are in the way when none is being moved');
select is((select array_agg((s->>'start')::integer order by (s->>'start')::integer) filter (where (s->>'usual')::boolean) from jsonb_array_elements(public.admin_booking_times(pg_temp.day(35), 60)->'slots') s), array[840],
  'And the only usual time is the one after the last');
select is((select array_agg(b->>'label') from jsonb_array_elements(public.admin_booking_times(pg_temp.day(35), 60, '00000000-0000-4000-8000-00000000d106')->'booked') b), array['Imogen Frost'],
  'Leaving out the 12:00 one lists only the 10:00 one, with its name');
select is((select array_agg((s->>'start')::integer order by (s->>'start')::integer) filter (where (s->>'usual')::boolean) from jsonb_array_elements(public.admin_booking_times(pg_temp.day(35), 60, '00000000-0000-4000-8000-00000000d106')->'slots') s), array[720],
  'The usual times are worked out as if it were not there: an hour after the 10:00 one');
select is((pg_temp.slot(35, 720, '00000000-0000-4000-8000-00000000d106')->>'clash')::boolean, false, 'Its own time is free for it');
select is((pg_temp.slot(35, 720, '00000000-0000-4000-8000-00000000d105')->>'clash')::boolean, true, 'But not when it is the other one that is being moved');
select is((select array_agg((s->>'start')::integer order by (s->>'start')::integer) filter (where (s->>'usual')::boolean) from jsonb_array_elements(public.admin_booking_times(pg_temp.day(35), 60, '00000000-0000-4000-8000-00000000d105')->'slots') s), array[600, 840],
  'Leaving out the 10:00 one, an hour before the 12:00 one is usual too');
select is(public.admin_booking_times(pg_temp.day(35), 60, gen_random_uuid()), public.admin_booking_times(pg_temp.day(35), 60), 'A booking that is not on the day changes nothing');
select is(public.admin_booking_times(pg_temp.day(35), 60, '00000000-0000-4000-8000-00000000d101'), public.admin_booking_times(pg_temp.day(35), 60), 'Nor does one on another day');

-- ---------------------------------------------------------------------------------------------
-- A move still charges what it always did
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d108', 36, 1050, true, 'client')$$, 'A client-requested move inside 24 hours is allowed at any time');
select lives_ok($$select pg_temp.move('00000000-0000-4000-8000-00000000d10a', 36, 1140, true, 'admin')$$, 'So is one the Admin decided herself');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000d108'$$,
  $$values (85.00::numeric, 'due'::text)$$, 'The first records the late fee as due');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000d10a'$$,
  $$values (0.00::numeric, 'none'::text)$$, 'The second never charges the client');

select * from finish();
rollback;
