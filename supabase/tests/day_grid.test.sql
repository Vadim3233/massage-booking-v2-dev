begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- Fixtures, in a week of March 2031 (Mon 3 to Sun 9)
-- Monday: usual 14:30 to 21:00, a booking 16:00 to 17:00 with an hour's travel either side, a dentist at 19:00 to 19:30 and a client
-- holding 20:00 to 20:30. Tuesday: usual 10:00 to 20:00 with a first appointment at 12:00. Wednesday: usually not worked.
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000e101', 'authenticated', 'authenticated', 'grid-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000e102', 'authenticated', 'authenticated', 'grid-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e101');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000e111', 'Andreas', 'Grid'),
  ('00000000-0000-4000-8000-00000000e112', 'Holly', 'Hold');
update public.working_hours set available = true, start_minutes = 870, end_minutes = 1260, start_mode = 'flexible', fixed_start_minutes = null,
  anchor_release_minutes = null, schedule_mode = 'chain' where weekday = 1;
update public.working_hours set available = true, start_minutes = 600, end_minutes = 1200, start_mode = 'fixed', fixed_start_minutes = 720,
  anchor_release_minutes = null, schedule_mode = 'chain' where weekday = 2;
update public.working_hours set available = false, start_minutes = null, end_minutes = null, start_mode = 'flexible', fixed_start_minutes = null,
  anchor_release_minutes = null where weekday = 3;
delete from public.working_hours_overrides where date between '2031-03-03' and '2031-03-09';
delete from public.calendar_blocks where date between '2031-03-03' and '2031-03-09';

insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, travel_buffer_minutes)
select '00000000-0000-4000-8000-00000000e121', 'GRID-1', '00000000-0000-4000-8000-00000000e111', id, date '2031-03-03', 960, 60, 'confirmed',
  'test', '1 Test Road', 'London', 'SW1A 1AA', name, 90, 90, 60
from public.service_areas where slug = 'chelsea';
insert into public.calendar_blocks(kind, title, date, start_minutes, end_minutes) values ('blocked', 'Dentist', '2031-03-03', 1140, 1170);
-- A holiday from Sunday into Monday morning is one block over two days, so it is not the grid's own either.
insert into public.calendar_blocks(group_id, kind, title, date, start_minutes, end_minutes)
values ('00000000-0000-4000-8000-00000000e131', 'blocked', null, '2031-03-02', 600, 1440),
       ('00000000-0000-4000-8000-00000000e131', 'blocked', null, '2031-03-03', 0, 600);
insert into public.booking_holds(client_id, date, start_minutes, treatment_duration_minutes, travel_buffer_minutes, expires_at)
values ('00000000-0000-4000-8000-00000000e112', '2031-03-03', 1200, 30, 30, now() + interval '10 minutes');

create temp table grid_cells(m integer);
grant all on grid_cells to authenticated;
-- Monday's usual open half hours, 14:30 to 20:30, less the dentist at 19:00.
insert into grid_cells select g from generate_series(870, 1230, 30) g where g <> 1140;

-- ---------------------------------------------------------------------------------------------
-- Who may ask
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_day_grid(date)', 'EXECUTE'), 'Anonymous callers cannot read the grid');
select ok(not has_function_privilege('anon', 'public.admin_save_day_grid(date,integer[],boolean)', 'EXECUTE'), 'Anonymous callers cannot save the grid');
select ok(not has_function_privilege('authenticated', 'public.day_grid(date)', 'EXECUTE'), 'The inner function is not open to callers');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e102","role":"authenticated"}', true);
select throws_ok($$select * from public.admin_day_grid('2031-03-03')$$, '42501', 'Admin authorization required', 'A client cannot read the grid');
select throws_ok($$select public.admin_save_day_grid('2031-03-03', '{}')$$, '42501', 'Admin authorization required', 'A client cannot save the grid');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e101","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Reading a day
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::integer from public.admin_day_grid('2031-03-03')), 48, 'A day is 48 half hours');
select results_eq($$select start_minutes from public.admin_day_grid('2031-03-03') where open order by 1$$,
  $$select m from grid_cells order by 1$$, 'Open time is the working hours less blocked time');
select results_eq($$select start_minutes, locked, label from public.admin_day_grid('2031-03-03') where locked is not null and start_minutes >= 840 order by 1$$,
  $$values (900, 'travel'::text, null::text), (930, 'travel', null), (960, 'booking', 'Andreas Grid'), (990, 'booking', 'Andreas Grid'),
           (1020, 'travel', null), (1050, 'travel', null), (1140, 'block', 'Dentist')$$,
  'A booking, its travel time and named blocked time are locked, with their names');
select is((select count(*)::integer from public.admin_day_grid('2031-03-03') where locked = 'block' and label = 'Blocked time' and start_minutes < 600), 20,
  'A block that runs in from another day is locked too');
select results_eq($$select start_minutes from public.admin_day_grid('2031-03-03') where held$$, $$values (1200)$$, 'A client holding a time shows as held');
select is((select booking_id from public.admin_day_grid('2031-03-03') where start_minutes = 960), '00000000-0000-4000-8000-00000000e121'::uuid,
  'A booking half hour names its booking');
select results_eq($$select start_minutes, open from public.admin_day_grid('2031-03-03') where start_minutes in (840, 1260)$$,
  $$values (840, false), (1260, false)$$, 'Time outside the hours is closed');

-- ---------------------------------------------------------------------------------------------
-- Saving: closing the first half hour and 18:00 to 19:00
-- ---------------------------------------------------------------------------------------------
select is(public.admin_save_day_grid('2031-03-03', (select array_agg(m) from grid_cells where m not in (870, 1080, 1110))),
  '{"saved": true, "available": true, "start_minutes": 900, "end_minutes": 1260}'::jsonb, 'Saving reports the new hours');
select results_eq($$select available, start_minutes, end_minutes, start_mode, schedule_mode from public.admin_day_hours('2031-03-03', '2031-03-03')$$,
  $$values (true, 900, 1260, 'flexible'::text, 'chain'::text)$$, 'The booking engine now reads 15:00 to 21:00 for the day');
select results_eq($$select start_minutes, end_minutes, kind, title from public.calendar_blocks where date = '2031-03-03' and group_id <> '00000000-0000-4000-8000-00000000e131' order by 1$$,
  $$values (1080, 1140, 'blocked'::text, null::text), (1140, 1170, 'blocked', 'Dentist')$$,
  'The closed run is one plain block, and the dentist is left as it was');
select is((select count(*)::integer from public.calendar_blocks where group_id = '00000000-0000-4000-8000-00000000e131'), 2, 'The two-day holiday is left as it was');
select results_eq($$select start_minutes from public.admin_day_grid('2031-03-03') where open order by 1$$,
  $$select m from grid_cells where m not in (870, 1080, 1110) order by 1$$, 'Reading the day again shows exactly what was saved');

-- Saving again replaces the grid's own blocked time.
delete from grid_cells where m in (870, 1110);
select is((public.admin_save_day_grid('2031-03-03', (select array_agg(m) from grid_cells)))->>'saved', 'true', 'Opening 18:00 again saves');
select results_eq($$select start_minutes, end_minutes from public.calendar_blocks where date = '2031-03-03' and title is null and group_id <> '00000000-0000-4000-8000-00000000e131'$$,
  $$values (1110, 1140)$$, 'Only 18:30 to 19:00 is blocked now');
select is((select count(*)::integer from public.working_hours_overrides where date = '2031-03-03'), 1, 'The day has one special day row');

-- ---------------------------------------------------------------------------------------------
-- What the grid cannot change
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.admin_save_day_grid('2031-03-03', (select array_agg(m) from grid_cells where m <> 900))$$, '55000',
  'This day changed while you were editing it. Look at it again before saving.', 'Travel time before a booking cannot be closed');
select throws_ok($$select public.admin_save_day_grid('2031-03-03', (select array_agg(m) from grid_cells where m <> 960))$$, '55000',
  'This day changed while you were editing it. Look at it again before saving.', 'A booking cannot be closed');
select throws_ok($$select public.admin_save_day_grid('2031-03-03', (select array_agg(m) from grid_cells) || 1140)$$, '55000',
  'This day changed while you were editing it. Look at it again before saving.', 'Named blocked time cannot be opened from the grid');
select is((select count(*)::integer from public.calendar_blocks where date = '2031-03-03' and title is null and group_id <> '00000000-0000-4000-8000-00000000e131'), 1,
  'A refused save changes nothing');

-- ---------------------------------------------------------------------------------------------
-- Time a client is in the middle of booking is asked about first
-- ---------------------------------------------------------------------------------------------
select is(public.admin_save_day_grid('2031-03-03', (select array_agg(m) from grid_cells where m <> 1200)), '{"saved": false, "held": [1200]}'::jsonb,
  'Closing held time saves nothing and names the time');
select is((select end_minutes from public.admin_day_hours('2031-03-03', '2031-03-03')), 1260, 'Nothing changed while asking');
select is((public.admin_save_day_grid('2031-03-03', (select array_agg(m) from grid_cells where m <> 1200), true))->>'saved', 'true', 'Closing it anyway saves');
select ok(exists (select 1 from public.calendar_blocks where date = '2031-03-03' and start_minutes = 1200 and end_minutes = 1230 and title is null),
  'The held half hour is blocked');

-- ---------------------------------------------------------------------------------------------
-- Day off, opening a day off, and the first appointment
-- ---------------------------------------------------------------------------------------------
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, schedule_mode, note)
values ('2031-03-06', true, 600, 1200, 'flexible', 'flexible', 'Long day');
insert into public.calendar_blocks(kind, date, start_minutes, end_minutes) values ('blocked', '2031-03-06', 720, 780);
select is(public.admin_save_day_grid('2031-03-06', '{}'), '{"saved": true, "available": false}'::jsonb, 'Closing every half hour makes a day off');
select results_eq($$select available, note from public.working_hours_overrides where date = '2031-03-06'$$, $$values (false, 'Long day'::text)$$,
  'The day off keeps its note');
select is((select count(*)::integer from public.calendar_blocks where date = '2031-03-06'), 0, 'The grid''s blocked time goes with it');

select is((public.admin_save_day_grid('2031-03-05', array[600, 630, 660]))->>'end_minutes', '690', 'A usual day off can be opened for a few hours');
select results_eq($$select available, start_minutes, end_minutes, source from public.admin_day_hours('2031-03-05', '2031-03-05')$$,
  $$values (true, 600, 690, 'special'::text)$$, 'It becomes a special day');

select is((public.admin_save_day_grid('2031-03-04', (select array_agg(g) from generate_series(660, 1170, 30) g)))->>'start_minutes', '660',
  'A day with a first appointment keeps it when its time stays open');
select results_eq($$select start_mode, fixed_start_minutes from public.admin_day_hours('2031-03-04', '2031-03-04')$$, $$values ('fixed'::text, 720)$$,
  'The first appointment is kept');
select throws_ok($$select public.admin_save_day_grid('2031-03-04', (select array_agg(g) from generate_series(780, 1170, 30) g))$$, '22023',
  'Your first appointment is set for 12:00, which would not be working time. Change it in Day settings first.',
  'Closing the first appointment''s time is refused with a reason');

-- ---------------------------------------------------------------------------------------------
-- Mistakes
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.admin_save_day_grid('2020-01-06', '{}')$$, '22023', 'This day has passed, so its hours cannot be changed', 'A past day is refused');
select throws_ok($$select public.admin_save_day_grid('2031-03-05', array[615])$$, '22023', 'Each time must be on the hour or half hour', 'A time off the half hour is refused');
select throws_ok($$select public.admin_save_day_grid('2031-03-05', array[1440])$$, '22023', 'Each time must be on the hour or half hour', 'A time past the day is refused');
select throws_ok($$select public.admin_save_day_grid('2031-03-05', null)$$, '22023', 'Choose a date and the times you are working', 'No times at all is refused');

reset role;
select * from finish();
rollback;
