begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- Fixtures: an admin, a signed-in client with a phone, another client, and a day 5 days ahead worked 10:00 to 18:00 with a personal event 12:00 to 13:00.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000f901', 'authenticated', 'authenticated', 'visit-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000f902', 'authenticated', 'authenticated', 'sarah@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000f903', 'authenticated', 'authenticated', 'other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f901');
insert into public.clients(id, auth_user_id, first_name, last_name, phone) values
  ('00000000-0000-4000-8000-00000000f911', '00000000-0000-0000-0000-00000000f902', 'Sarah', 'Visit', '07700 900555'),
  ('00000000-0000-4000-8000-00000000f912', '00000000-0000-0000-0000-00000000f903', 'Olly', 'Other', null);

create function pg_temp.day(p_offset integer) returns date language sql as $$ select ((now() at time zone 'Europe/London')::date + p_offset); $$;
create function pg_temp.claims(p_user text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); $$;

update public.business_settings set value = '0' where key = 'minimum_notice_minutes';
delete from public.working_hours_overrides where date between pg_temp.day(4) and pg_temp.day(6);
delete from public.calendar_blocks where date between pg_temp.day(4) and pg_temp.day(6);
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
values (pg_temp.day(5), true, 600, 1080, 'flexible'), (pg_temp.day(6), false, null, null, 'flexible');
insert into public.calendar_blocks(date, start_minutes, end_minutes, kind, title) values (pg_temp.day(5), 720, 780, 'personal_event', 'Dentist');
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, travel_buffer_minutes)
select '00000000-0000-4000-8000-00000000f921', 'VISIT-1', '00000000-0000-4000-8000-00000000f911', id, pg_temp.day(5), 900, 60, 'confirmed',
  'test', '1 Test Road', 'London', 'SW1A 1AA', name, 90, 90, 60 from public.service_areas where slug = 'chelsea';

-- Access
select ok(has_function_privilege('anon', 'public.record_visit(uuid,text,jsonb)', 'EXECUTE'), 'Anyone on the booking page can log a step');
select ok(has_function_privilege('anon', 'public.wanted_times(date,integer)', 'EXECUTE') and has_function_privilege('anon', 'public.ask_for_time(date,integer,integer,text)', 'EXECUTE'), 'Anyone can see and ask for wanted times');
select ok(not has_function_privilege('anon', 'public.admin_visits(date,date)', 'EXECUTE') and not has_function_privilege('anon', 'public.admin_save_wanted_evening_hours(integer)', 'EXECUTE'), 'Anonymous callers cannot read visits or change the setting');
select ok(not has_table_privilege('anon', 'public.visit_events', 'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated', 'public.visit_events', 'SELECT,INSERT,UPDATE,DELETE'), 'Nobody reads or writes the log directly');
select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('record_visit', 'wanted_times', 'ask_for_time', 'admin_visits', 'admin_wanted_evening_hours', 'admin_save_wanted_evening_hours') and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'They are definers with an empty search path');

-- Wanted times: 10:00 to 18:00 plus two evening hours, a 60-minute treatment, never over the dentist
select is((select array_agg(start_minutes) from public.wanted_times(pg_temp.day(5), 60)),
  array[600, 630, 660, 780, 810, 840, 870, 900, 930, 960, 990, 1020, 1050, 1080, 1110, 1140], 'Working hours and two evening hours, without the personal event');
select is((select max(start_minutes) from public.wanted_times(pg_temp.day(5), 120)), 1080, 'A longer treatment must also end within the evening hours');
select is((select count(*)::integer from public.wanted_times(pg_temp.day(6), 60)), 0, 'Nothing on a day off');
select is((select count(*)::integer from public.wanted_times(pg_temp.day(-1), 60)), 0, 'Nothing on a past day');
select is((select count(*)::integer from public.wanted_times(pg_temp.day(5), 45)), 0, 'Nothing for an odd length');
update public.business_settings set value = '0' where key = 'wanted_evening_hours';
select is((select max(start_minutes) from public.wanted_times(pg_temp.day(5), 60)), 1020, 'With no evening hours, only the working hours');
update public.business_settings set value = '9' where key = 'wanted_evening_hours';
select is((select max(start_minutes) from public.wanted_times(pg_temp.day(5), 60)), 1140, 'The evening hours are never more than two');
update public.business_settings set value = '2' where key = 'wanted_evening_hours';

-- The setting
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000f902');
select throws_ok($$select public.admin_wanted_evening_hours()$$, '42501', 'Admin authorization required', 'A client cannot read the setting');
select throws_ok($$select public.admin_save_wanted_evening_hours(1)$$, '42501', 'Admin authorization required', 'A client cannot change the setting');
select pg_temp.claims('00000000-0000-0000-0000-00000000f901');
select is(public.admin_wanted_evening_hours(), 2, 'Two evening hours by default');
select lives_ok($$select public.admin_save_wanted_evening_hours(1)$$, 'The Admin can save 1 hour');
select is(public.admin_wanted_evening_hours(), 1, 'It is saved');
select throws_ok($$select public.admin_save_wanted_evening_hours(3)$$, '22023', 'Choose 0, 1 or 2 hours', 'More than two is refused');
select lives_ok($$select public.admin_save_wanted_evening_hours(2)$$, 'And back to 2');

-- Asking for a time
select pg_temp.claims('00000000-0000-0000-0000-00000000f902');
create temp table asked as select public.ask_for_time(pg_temp.day(5), 900, 60) as id;
grant select on asked to authenticated, anon;
select ok((select id is not null from asked), 'A signed-in client asks with one tap');
reset role;
select is((select row(contact_name, contact_phone, preferred_from_minutes, preferred_to_minutes, client_id)::text from public.waitlist_requests where id = (select id from asked)),
  row('Sarah Visit', '07700 900555', 900, 930, '00000000-0000-4000-8000-00000000f911'::uuid)::text, 'It is a waitlist request for that half hour, with her details');
select ok((select body like '%at 15:00, 60 minutes.' from public.notification_deliveries where recipient = 'admin-waitlist' and channel = 'in_app' order by created_at desc limit 1), 'The alert says which time she asked for');
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000f902');
select is(public.ask_for_time(pg_temp.day(5), 1050, 60), (select id from asked), 'Asking for another time that day is the same request');
reset role;
select is((select array[preferred_from_minutes, preferred_to_minutes] from public.waitlist_requests where id = (select id from asked)), array[900, 1080], 'Widened to cover both times');
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000f903');
select lives_ok($$select public.ask_for_time(pg_temp.day(5), 900, 60)$$, 'A client with no phone uses the account email');
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select throws_ok($$select public.ask_for_time(pg_temp.day(5), 900, 60)$$, '22023', 'Please add a phone number or email, so I can let you know.', 'Someone not signed in gives a phone or email');
select throws_ok($$select public.ask_for_time(pg_temp.day(5), 915, 60, 'a@example.test')$$, '22023', 'Please choose a time.', 'A time off the half hour is refused');
select lives_ok($$select public.ask_for_time(pg_temp.day(5), 960, 60, ' newperson@example.test ')$$, 'An email is enough');
reset role;
select is((select contact_name from public.waitlist_requests where contact_email = 'newperson@example.test'), 'Visitor', 'Named as a visitor');

-- Logging a visit
set local role anon;
select lives_ok($$select public.record_visit('00000000-0000-4000-8000-0000000fa001', 'opened', '{"step": 0}')$$, 'A visitor opens the page');
select lives_ok($$select public.record_visit('00000000-0000-4000-8000-0000000fa001', 'day', jsonb_build_object('date', pg_temp.day(5), 'free', 0, 'minutes', 60, 'secret', 'x', 'long', repeat('y', 80)))$$, 'Looks at a day');
select lives_ok($$select public.record_visit('00000000-0000-4000-8000-0000000fa001', 'nonsense', '{}')$$, 'An unknown step is ignored quietly');
select lives_ok($$select public.record_visit('00000000-0000-4000-8000-0000000fa001', 'booked', '{"booking_id": "00000000-0000-4000-8000-00000000f921"}')$$, 'A visitor cannot claim someone else''s booking');
reset role;
select is((select count(*)::integer from public.visit_events where visit_id = '00000000-0000-4000-8000-0000000fa001'), 2, 'Only the two real steps are kept');
select is((select detail from public.visit_events where visit_id = '00000000-0000-4000-8000-0000000fa001' and kind = 'day'),
  jsonb_build_object('date', pg_temp.day(5), 'free', 0, 'minutes', 60), 'Unknown and long details are dropped');
select is((select count(*)::integer from public.visit_events where visit_id = '00000000-0000-4000-8000-0000000fa001' and client_id is not null), 0, 'A visitor is not named');

set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000f902');
select public.record_visit('00000000-0000-4000-8000-0000000fa002', 'opened', '{}');
select public.record_visit('00000000-0000-4000-8000-0000000fa002', 'wanted', jsonb_build_object('date', pg_temp.day(5), 'start', 900, 'minutes', 60));
select public.record_visit('00000000-0000-4000-8000-0000000fa002', 'booked', '{"booking_id": "00000000-0000-4000-8000-00000000f921"}');
reset role;
select is((select array_agg(kind order by id) from public.visit_events where visit_id = '00000000-0000-4000-8000-0000000fa002'), array['opened', 'wanted', 'booked'], 'A client''s own booking counts');
select is((select count(distinct client_id)::integer from public.visit_events where visit_id = '00000000-0000-4000-8000-0000000fa002' and client_id = '00000000-0000-4000-8000-00000000f911'), 1, 'The client is named');

-- Old rows go after 90 days
insert into public.visit_events(visit_id, at, kind) values ('00000000-0000-4000-8000-0000000fa003', now() - interval '91 days', 'opened');
set local role anon;
select public.record_visit('00000000-0000-4000-8000-0000000fa004', 'opened', '{}');
reset role;
select is((select count(*)::integer from public.visit_events where visit_id = '00000000-0000-4000-8000-0000000fa003'), 0, 'A visit older than 90 days is deleted');

-- The Admin's list
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000f902');
select throws_ok($$select * from public.admin_visits(pg_temp.day(-7), pg_temp.day(0))$$, '42501', 'Admin authorization required', 'A client cannot read visits');
select pg_temp.claims('00000000-0000-0000-0000-00000000f901');
select throws_ok($$select * from public.admin_visits(pg_temp.day(-100), pg_temp.day(0))$$, '22023', 'Choose up to three months', 'At most three months at a time');
create temp table seen as select * from public.admin_visits(pg_temp.day(-7), pg_temp.day(0));
select ok((select count(*) >= 3 from seen), 'The visits of the last week are listed');
select is((select client_name from seen where visit_id = '00000000-0000-4000-8000-0000000fa002'), 'Sarah Visit', 'A signed-in visit carries the client''s name');
select is((select client_name from seen where visit_id = '00000000-0000-4000-8000-0000000fa001'), null, 'A visitor has none');
select is((select e->'detail'->>'status' from seen, jsonb_array_elements(events) e where visit_id = '00000000-0000-4000-8000-0000000fa002' and e->>'kind' = 'booked'), 'confirmed', 'A booked step carries the booking''s status');
select is((select jsonb_array_length(events) from seen where visit_id = '00000000-0000-4000-8000-0000000fa001'), 2, 'Each visit has its steps');

-- A cancelled booking names who wanted that part of the day
reset role;
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000f921';
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
values ('booking.cancelled', 'booking', '00000000-0000-4000-8000-00000000f921', 'test-visit-cancel', '{}');
select ok((select body like 'Sarah Visit wanted 15:00; Olly Other wanted 15:00; Visitor wanted 16:00. % waiting for %' from public.notification_deliveries
  where recipient = 'admin-waitlist' and channel = 'in_app' and title = 'A time may have opened up' order by created_at desc limit 1), 'The alert names who wanted that time');

select * from finish();
rollback;
