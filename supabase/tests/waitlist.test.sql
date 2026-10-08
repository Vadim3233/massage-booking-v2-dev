begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(54);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000d901', 'authenticated', 'authenticated', 'wait-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000d902', 'authenticated', 'authenticated', 'wait-one@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000d903', 'authenticated', 'authenticated', 'wait-two@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d901');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000d911', '00000000-0000-0000-0000-00000000d902', 'Wendy', 'Waiting', 'wait-one@example.test');

create function pg_temp.day(p_offset integer) returns date language sql as $$ select ((now() at time zone 'Europe/London')::date + p_offset); $$;
create function pg_temp.claims(p_user text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); $$;
create function pg_temp.new_booking(p_id uuid, p_day integer, p_start integer, p_status text default 'confirmed') returns void language sql as $$
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'WAIT-' || p_id, '00000000-0000-4000-8000-00000000d911', id, pg_temp.day(p_day), p_start, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85, 'wait-one@example.test' from public.service_areas where slug = 'chelsea';
$$;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.day(d), true, 600, 1200, 'flexible' from unnest(array[3, 5, 6, 7, 8, 9]) d;

select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_waitlist', 'admin_update_waitlist', 'plan_waitlist_notifications') and has_function_privilege('anon', p.oid, 'EXECUTE')), 'Anonymous callers cannot read or change the waitlist');
select ok(has_function_privilege('anon', 'public.join_waitlist(date,integer,integer,integer,text,text,text,text)', 'EXECUTE'), 'Anyone may ask to join, before signing in');
select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('join_waitlist', 'admin_waitlist', 'admin_update_waitlist', 'plan_waitlist_notifications') and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'They are definers with an empty search path');
select ok(not has_table_privilege('authenticated', 'public.waitlist_requests', 'INSERT,UPDATE,DELETE,TRUNCATE') and not has_table_privilege('anon', 'public.waitlist_requests', 'SELECT'), 'Browsers cannot write the waitlist table or read it publicly');

-- Joining
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000d902');
create temp table joined as select public.join_waitlist(pg_temp.day(5), 0, 1440, 60, ' Wendy Waiting ', '07700 900123', ' Wendy@Example.test ', 'Any day this week please') as id;
grant select on joined to authenticated;
select ok((select id is not null from joined), 'A client can join the waitlist');
select is(public.join_waitlist(pg_temp.day(5), 0, 1440, 60, 'Wendy Waiting', '07700 900123', 'wendy@example.test'), (select id from joined), 'Asking again for the same day and length is the same request');
select throws_ok($$select public.join_waitlist(pg_temp.day(-1), 0, 1440, 60, 'W', '07700900123', null)$$, '22023', 'Please choose a day within the dates you can book.', 'A day in the past is refused');
select throws_ok($$select public.join_waitlist(pg_temp.day(60), 0, 1440, 60, 'W', '07700900123', null)$$, '22023', 'Please choose a day within the dates you can book.', 'A day beyond the booking horizon is refused');
select throws_ok($$select public.join_waitlist(pg_temp.day(6), 0, 1440, 45, 'W', '07700900123', null)$$, '22023', 'Please choose a treatment length.', 'An odd length is refused');
select throws_ok($$select public.join_waitlist(pg_temp.day(6), 900, 600, 60, 'W', '07700900123', null)$$, '22023', 'Please choose a time of day.', 'A backwards time range is refused');
select throws_ok($$select public.join_waitlist(pg_temp.day(6), 0, 1440, 60, '  ', '07700900123', null)$$, '22023', 'Please enter your name.', 'A name is required');
select throws_ok($$select public.join_waitlist(pg_temp.day(6), 0, 1440, 60, 'W', null, null)$$, '22023', 'Please enter a phone number or an email address.', 'Some contact detail is required');
select throws_ok($$select public.join_waitlist(pg_temp.day(6), 0, 1440, 60, 'W', '123', null)$$, '22023', 'That phone number does not look right.', 'A short phone number is refused');
select throws_ok($$select public.join_waitlist(pg_temp.day(6), 0, 1440, 60, 'W', null, 'nope')$$, '22023', 'That email address does not look right.', 'A bad email is refused');
select throws_ok($$select public.join_waitlist(pg_temp.day(6), 0, 1440, 60, 'W', '07700900123', null, repeat('x', 501))$$, '22023', 'Please keep your note under 500 characters.', 'A very long note is refused');
select lives_ok($$select public.join_waitlist(pg_temp.day(6), 600, 720, 90, 'Wendy Waiting', '07700 900123', null)$$, 'A second day is fine');
select lives_ok($$select public.join_waitlist(pg_temp.day(7), 0, 1440, 60, 'Wendy Waiting', '07700 900123', null)$$, 'A third day is fine');
select throws_ok($$select public.join_waitlist(pg_temp.day(8), 0, 1440, 60, 'Wendy Waiting', '07700 900123', null)$$, '22023', 'You are already on the waitlist for a few days. Please contact Vad if you need something else.', 'A fourth day for the same person is refused');
select pg_temp.claims('00000000-0000-0000-0000-00000000d903');
select throws_ok($$select public.join_waitlist(pg_temp.day(8), 0, 1440, 60, 'Someone Else', '(07700) 900-123', null)$$, '22023', 'You are already on the waitlist for a few days. Please contact Vad if you need something else.', 'The same phone number from another session is limited too');
select lives_ok($$select public.join_waitlist(pg_temp.day(8), 0, 1440, 60, 'Xavier Waiting', null, 'xavier@example.test')$$, 'A different person can join');
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select lives_ok($$select public.join_waitlist(pg_temp.day(9), 0, 1440, 60, 'Gina Guest', null, 'gina@example.test')$$, 'Someone not signed in can join');
select is(public.join_waitlist(pg_temp.day(9), 0, 1440, 60, 'Gina Guest', null, ' GINA@example.test '), public.join_waitlist(pg_temp.day(9), 0, 1440, 60, 'Gina Guest', null, 'gina@example.test'), 'Asking again is the same request, however the email is typed');
reset role;
select is((select created_by from public.waitlist_requests where contact_email = 'gina@example.test'), null, 'A guest request has no account behind it');
select is((select count(*)::integer from public.waitlist_requests where contact_email = 'gina@example.test'), 1, 'It is stored once');
select results_eq($$select client_id, contact_email, contact_phone, status from public.waitlist_requests where id = (select id from joined)$$,
  $$values ('00000000-0000-4000-8000-00000000d911'::uuid, 'wendy@example.test', '07700 900123', 'active')$$, 'A signed-in client is linked to their record, with the email tidied');
select is((select client_id from public.waitlist_requests where contact_name = 'Xavier Waiting'), null, 'A guest has no client record to link');
select is((select count(*)::integer from public.event_outbox where event_type = 'waitlist.joined'), 5, 'Each new request is one event, and refused ones leave none');

-- Alerts
select results_eq($$select d.channel, d.audience, d.recipient from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'waitlist.joined' and e.aggregate_id = (select id from joined) order by 1$$,
  $$values ('email'::text, 'admin'::text, 'admin-waitlist'::text), ('in_app', 'admin', 'admin-waitlist'), ('telegram', 'admin', 'admin-waitlist')$$, 'The Admin is alerted in the app, on Telegram and by email');
select is((select d.title from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'waitlist.joined' and e.aggregate_id = (select id from joined) and d.channel = 'in_app'), 'Someone joined the waitlist', 'With a plain title');
select ok((select d.body like 'Wendy Waiting: % any time, 60 minutes.' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'waitlist.joined' and e.aggregate_id = (select id from joined) and d.channel = 'in_app'), 'Saying who, when and for how long');
select is((select d.link_path from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'waitlist.joined' and e.aggregate_id = (select id from joined) and d.channel = 'telegram'), '/admin/waitlist', 'And linking to the waitlist');

-- The Admin's list
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000d902');
select throws_ok($$select * from public.admin_waitlist()$$, '42501', 'Admin authorization required', 'A client cannot read the list');
select throws_ok($$select public.admin_update_waitlist(gen_random_uuid(), 'closed')$$, '42501', 'Admin authorization required', 'A client cannot change a request');
select is((select count(*)::integer from public.waitlist_requests), 0, 'A client cannot read the table, even their own request');
select pg_temp.claims('00000000-0000-0000-0000-00000000d901');
select is((select count(*)::integer from public.admin_waitlist()), 5, 'The Admin sees every open request');
select is((select requested_date from public.admin_waitlist() limit 1), pg_temp.day(5), 'Soonest day first');
select ok((select available_times @> array[600, 630, 1140] and cardinality(available_times) = 19 from public.admin_waitlist() where id = (select id from joined)), 'On an empty working day, every start time in the window is available');
select results_eq($$select available_times from public.admin_waitlist() where requested_date = pg_temp.day(6) and duration_minutes = 90$$,
  $$select array(select generate_series(600, 690, 30))$$, 'Only starts inside the person''s preferred window are listed, and the treatment must fit the day');
reset role;

-- A booking on that day narrows the matches; cancelling it opens them again.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d921', 5, 600);
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000d901');
select is((select available_times from public.admin_waitlist() where id = (select id from joined)), array[720], 'With a booking that day only the time after it, allowing for travel, is a match');
reset role;
select is((select count(*)::integer from public.notification_deliveries where recipient = 'admin-waitlist' and title = 'A time may have opened up'), 0, 'No alert yet');
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload) values ('booking.cancelled', 'booking', '00000000-0000-4000-8000-00000000d921', '{"initiated_by":"client","source":"client"}');
select results_eq($$select d.channel, d.body from public.notification_deliveries d where d.recipient = 'admin-waitlist' and d.title = 'A time may have opened up' order by 1$$,
  $$select c, format('1 person is waiting for %s. Open the waitlist to see who could be booked.', to_char(pg_temp.day(5), 'FMDy FMDD FMMon')) from unnest(array['email', 'in_app', 'telegram']) c$$, 'Cancelling a booking on a day someone is waiting for alerts the Admin');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d922', 3, 600);
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload) values ('booking.cancelled', 'booking', '00000000-0000-4000-8000-00000000d922', '{"initiated_by":"client","source":"client"}');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.aggregate_id = '00000000-0000-4000-8000-00000000d922' and d.recipient = 'admin-waitlist'), 0, 'Nobody waiting for that day means no extra alert');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.aggregate_id = '00000000-0000-4000-8000-00000000d921' and d.recipient = 'admin'), 3, 'The usual client-cancelled alert is unaffected');

-- Acting on a request
set local role authenticated;
select pg_temp.claims('00000000-0000-0000-0000-00000000d901');
select lives_ok($$select public.admin_update_waitlist((select id from joined), 'offered', 'Offered 12:00 by message')$$, 'The Admin can record that she offered a time');
select results_eq($$select status, admin_note, offered_at is not null from public.waitlist_requests where id = (select id from joined)$$, $$values ('offered'::text, 'Offered 12:00 by message'::text, true)$$, 'It is recorded');
select lives_ok($$select public.admin_update_waitlist((select id from joined), 'reopen')$$, 'She can reopen it if they did not reply');
select results_eq($$select status, offered_at is null, admin_note from public.waitlist_requests where id = (select id from joined)$$, $$values ('active'::text, true, 'Offered 12:00 by message'::text)$$, 'Reopening clears the offer and keeps her note');
select lives_ok($$select public.admin_update_waitlist((select id from joined), 'booked')$$, 'She can close it as booked');
select results_eq($$select status, close_reason, closed_at is not null from public.waitlist_requests where id = (select id from joined)$$, $$values ('closed'::text, 'booked'::text, true)$$, 'The reason is kept');
select throws_ok($$select public.admin_update_waitlist((select id from joined), 'offered')$$, 'PT409', 'This request is already closed', 'A closed request cannot be changed again');
select throws_ok($$select public.admin_update_waitlist((select id from joined), 'explode')$$, '22023', 'Choose what to do with this request', 'An unknown action is refused');
select throws_ok($$select public.admin_update_waitlist(gen_random_uuid(), 'closed')$$, 'P0002', 'Request unavailable', 'An unknown request is refused');
select is((select count(*)::integer from public.admin_waitlist()), 4, 'Closed requests leave the main list');
select is((select count(*)::integer from public.admin_waitlist(true) where status = 'closed'), 1, 'But can be listed when asked for');
reset role;

select * from finish();
rollback;
