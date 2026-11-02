begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(9);

-- The 2 Nov 2026 case, replayed. A chain day from 12:30 to 21:00 with a 2-hour booking at 17:30. A 90-minute treatment chains only at
-- 15:00 (15:00 + 90 min + 1 hour's travel = 17:30). A guest holds 15:00, signs up, and comes back in a tab that has lost the hold but
-- still has the browser key. Inside the 40-day horizon so the test does not rot as the calendar moves.
select set_config('test.day', ((now() at time zone 'Europe/London')::date + 30)::text, true);
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, schedule_mode)
values (current_setting('test.day')::date, true, 750, 1260, 'flexible', 'chain');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000c401', 'Andy', 'Already-Booked');
insert into public.bookings(booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot)
select 'OWN-HOLD-1', '00000000-0000-4000-8000-00000000c401', id, current_setting('test.day')::date, 1050, 120, 'confirmed',
  'test', '1 Test Road', 'London', 'SW1A 1AA', name from public.service_areas where slug = 'chelsea';

set local role anon;
select results_eq($q$select * from public.get_booking_availability(current_setting('test.day')::date, 90)$q$,
  $q$values (900)$q$, 'Before anyone holds: 15:00 is the one time that chains onto the 17:30 booking');
reset role;

create temp table guest_hold as select * from public.create_booking_hold(current_setting('test.day')::date, 900, 90, 'own-hold-browser-0000000001');
grant select on guest_hold to anon, authenticated;

set local role anon;
-- The bug: with only the browser key, her own hold used to count against her, and 12:30 (chained off her own hold) was offered.
select results_eq($q$select * from public.get_booking_availability(current_setting('test.day')::date, 90, null, null, 'own-hold-browser-0000000001')$q$,
  $q$values (900)$q$, 'The same browser, having lost track of its hold, still sees 15:00 and is not offered 12:30 chained off its own hold');
select results_eq($q$select * from public.get_booking_availability(current_setting('test.day')::date, 90, (select hold_id from guest_hold), (select hold_token from guest_hold), 'own-hold-browser-0000000001')$q$,
  $q$values (900)$q$, 'With the hold named, the same answer as with the key alone');
select results_eq($q$select * from public.get_booking_availability(current_setting('test.day')::date, 90)$q$,
  $q$values (750)$q$, 'Anyone else still sees 15:00 as taken (only 12:30, before the hold, chains)');
select results_eq($q$select * from public.get_booking_availability(current_setting('test.day')::date, 90, null, null, 'own-hold-browser-0000000002')$q$,
  $q$values (750)$q$, 'Another browser''s key does not leave out the guest''s hold');
select throws_ok($q$select * from public.get_booking_availability(current_setting('test.day')::date, 90, null, null, 'short')$q$,
  '22023', 'A valid booking hold client key is required', 'A malformed key is rejected');
select throws_ok($q$select * from public.get_booking_availability(current_setting('test.day')::date, 90, (select hold_id from guest_hold), null, 'own-hold-browser-0000000001')$q$,
  '22023', 'Hold ID, token and browser client key must be provided together', 'A hold ID without its token is still rejected');
reset role;

-- Every time offered to the browser can actually be held by it: picking the offered 15:00 again works, so the loop cannot happen.
select lives_ok($q$select * from public.create_booking_hold(current_setting('test.day')::date, 900, 90, 'own-hold-browser-0000000001')$q$,
  'The time the browser is offered can be held by it');
select is((select count(*)::integer from public.booking_holds where client_key = 'own-hold-browser-0000000001' and status = 'active'), 1,
  'Still exactly one active hold for the browser');

select * from finish();
rollback;
