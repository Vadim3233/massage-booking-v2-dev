begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(22);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000d601', 'authenticated', 'authenticated', 'range-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000d602', 'authenticated', 'authenticated', 'range-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d601');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000d611', 'Robin', 'Range');

-- A confirmed booking on 5 Aug 2031 at 10:00 for an hour (with a 60 minute travel allowance either side).
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, travel_buffer_minutes)
select '00000000-0000-4000-8000-00000000d621', 'RANGE-1', '00000000-0000-4000-8000-00000000d611', id, date '2031-08-05', 600, 60, 'confirmed',
  'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85, 60
from public.service_areas where slug = 'chelsea';

select ok(not has_function_privilege('anon', 'public.admin_save_block_range(uuid,text,text,text,date,integer,date,integer)', 'EXECUTE'), 'Anonymous callers cannot save a block');
select ok(not has_function_privilege('anon', 'public.admin_block_range_conflicts(date,integer,date,integer)', 'EXECUTE'), 'Anonymous callers cannot check range conflicts');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d602","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_block_range(null, 'blocked', 'Holiday', null, date '2031-08-04', 840, date '2031-08-06', 600)$$, '42501', 'Admin authorization required', 'A client cannot block the calendar');
select throws_ok($$select * from public.admin_block_range_conflicts(date '2031-08-04', 0, date '2031-08-06', 1440)$$, '42501', 'Admin authorization required', 'A client cannot see bookings through the range check');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d601","role":"authenticated"}', true);

-- One block over three days: the first day from 14:00, a whole middle day, the last day until 10:00.
create temp table made as select public.admin_save_block_range(null, 'blocked', 'Holiday', 'Away', date '2031-08-04', 840, date '2031-08-06', 600) as id;
grant all on made to authenticated;
select results_eq($$select date, start_minutes, end_minutes from public.calendar_blocks where group_id = (select id from made) order by date$$,
  $$values (date '2031-08-04', 840, 1440), (date '2031-08-05', 0, 1440), (date '2031-08-06', 0, 600)$$, 'A three day block becomes one row per day with the right hours');
select is((select count(distinct group_id)::integer from public.calendar_blocks where title = 'Holiday'), 1, 'All the days share one group');
select is((select count(*)::integer from public.calendar_blocks where group_id = (select id from made) and title = 'Holiday' and notes = 'Away' and kind = 'blocked' and created_by = '00000000-0000-0000-0000-00000000d601'), 3, 'Title, notes, kind and author are kept on every day');

-- A single part-day block, and a personal event.
select lives_ok($$select public.admin_save_block_range(null, 'blocked', null, null, date '2031-09-01', 720, date '2031-09-01', 780)$$, 'A couple of hours in one day can be blocked');
select results_eq($$select start_minutes, end_minutes from public.calendar_blocks where date = date '2031-09-01'$$, $$values (720, 780)$$, 'The part-day block keeps its hours');
select lives_ok($$select public.admin_save_block_range(null, 'personal_event', 'Wedding', null, date '2031-09-05', 0, date '2031-09-06', 1440)$$, 'A personal event can run over whole days');
select is((select count(*)::integer from public.calendar_blocks where title = 'Wedding'), 2, 'A two day event has two rows');

-- Changing a block replaces all its days.
select is(public.admin_save_block_range((select id from made), 'blocked', 'Holiday', null, date '2031-08-04', 0, date '2031-08-04', 1440), (select id from made), 'Changing a block keeps its group');
select is((select count(*)::integer from public.calendar_blocks where group_id = (select id from made)), 1, 'A shorter block leaves only its new days');
select is((select count(*)::integer from public.calendar_blocks where date in (date '2031-08-05', date '2031-08-06') and title = 'Holiday'), 0, 'The days that are no longer blocked are free again');

-- Mistakes are refused with a plain message.
select throws_ok($$select public.admin_save_block_range(null, 'blocked', null, null, date '2031-08-06', 600, date '2031-08-05', 900)$$, '22023', 'The end must be after the start', 'An end before the start is refused');
select throws_ok($$select public.admin_save_block_range(null, 'blocked', null, null, date '2031-08-06', 600, date '2031-08-06', 600)$$, '22023', 'The end must be after the start', 'An empty block is refused');
select throws_ok($$select public.admin_save_block_range(null, 'blocked', null, null, date '2031-08-06', 600, date '2033-08-06', 900)$$, '22023', 'A block can cover up to a year', 'A block longer than a year is refused');
select throws_ok($$select public.admin_save_block_range(null, 'personal_event', '  ', null, date '2031-08-06', 600, date '2031-08-06', 900)$$, '22023', 'Give the personal event a name', 'A personal event needs a name');
select throws_ok($$select public.admin_save_block_range(gen_random_uuid(), 'blocked', null, null, date '2031-08-06', 600, date '2031-08-06', 900)$$, 'P0002', 'Blocked time unavailable', 'A block that does not exist cannot be changed');

-- Clashes with live bookings, day by day, travel allowance included.
select results_eq($$select date, client_name, start_minutes from public.admin_block_range_conflicts(date '2031-08-04', 840, date '2031-08-06', 600)$$,
  $$values (date '2031-08-05', 'Robin Range'::text, 600)$$, 'A multi-day block shows the booking it covers');
select is((select count(*)::integer from public.admin_block_range_conflicts(date '2031-08-05', 720, date '2031-08-05', 780)), 0, 'Time clear of the booking and its travel allowance does not clash');
select is((select count(*)::integer from public.admin_block_range_conflicts(date '2031-08-04', 0, date '2031-08-05', 570)), 1, 'A block ending inside the travel allowance before a booking clashes');

reset role;
select * from finish();
rollback;
