begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- Fixtures: a usual week, two special days and a day away, in a week of March 2031 (Mon 3 to Sun 9)
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000d901', 'authenticated', 'authenticated', 'hours-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000d902', 'authenticated', 'authenticated', 'hours-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d901');
-- Monday 14:30 to 21:00; Tuesday 10:00 to 20:00 with a first appointment at 12:00, released at 18:00 the day before; Wednesday not worked;
-- Sunday not in the usual week at all.
update public.working_hours set available = true, start_minutes = 870, end_minutes = 1260, start_mode = 'flexible', fixed_start_minutes = null,
  anchor_release_minutes = null, schedule_mode = 'chain' where weekday = 1;
update public.working_hours set available = true, start_minutes = 600, end_minutes = 1200, start_mode = 'fixed', fixed_start_minutes = 720,
  anchor_release_minutes = 1080, schedule_mode = 'chain' where weekday = 2;
update public.working_hours set available = false, start_minutes = null, end_minutes = null, start_mode = 'flexible', fixed_start_minutes = null, anchor_release_minutes = null where weekday = 3;
delete from public.working_hours where weekday = 7;
delete from public.working_hours_overrides where date between '2031-03-03' and '2031-03-09';
delete from public.calendar_blocks where date between '2031-03-03' and '2031-03-09';
-- Thursday: special hours with a note. Friday: a day off called Christmas Holidays.
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, schedule_mode, note)
values ('2031-03-06', true, 600, 1320, 'flexible', 'flexible', 'Long day');
insert into public.working_hours_overrides(date, available, note) values ('2031-03-07', false, 'Christmas Holidays');
-- Tuesday is covered by a whole-day block.
insert into public.calendar_blocks(group_id, kind, title, date, start_minutes, end_minutes)
values (gen_random_uuid(), 'blocked', 'Away for a wedding', '2031-03-04', 0, 1440);

-- ---------------------------------------------------------------------------------------------
-- Who may ask
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_day_hours(date, date)', 'EXECUTE'), 'Anonymous callers cannot ask for the hours');
select ok(not has_function_privilege('anon', 'public.day_hours(date)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.day_hours(date)', 'EXECUTE'),
  'The inner function is not open to callers');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d902","role":"authenticated"}', true);
select throws_ok($$select * from public.admin_day_hours('2031-03-03', '2031-03-09')$$, '42501', 'Admin authorization required', 'A signed-in client cannot ask');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d901","role":"authenticated"}', true);
select throws_ok($$select * from public.admin_day_hours('2031-03-09', '2031-03-03')$$, '22023', 'Choose a range of dates of up to a year', 'A range back to front is refused');
select throws_ok($$select * from public.admin_day_hours('2031-01-01', '2032-06-01')$$, '22023', 'Choose a range of dates of up to a year', 'More than a year is refused');
create temp table week as select * from public.admin_day_hours('2031-03-03', '2031-03-09');
reset role;

-- ---------------------------------------------------------------------------------------------
-- What each day says
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::integer from week), 7, 'One row for every date, both ends included');
select results_eq($$select source, available, start_minutes, end_minutes, start_mode, note, away from week where date = '2031-03-03'$$,
  $$values ('usual'::text, true, 870, 1260, 'flexible'::text, null::text, null::text)$$, 'A usual Monday has the usual hours');
select results_eq($$select source, available, start_minutes, end_minutes, start_mode, fixed_start_minutes, anchor_release_minutes, away from week where date = '2031-03-04'$$,
  $$values ('usual'::text, true, 600, 1200, 'fixed'::text, 720, 1080, 'Away for a wedding'::text)$$, 'A Tuesday has its first appointment and release time, and the name of the block that covers the whole day');
select results_eq($$select source, available from week where date = '2031-03-05'$$, $$values ('usual'::text, false)$$, 'A weekday the usual week does not work is not worked');
select results_eq($$select source, available, start_minutes, end_minutes, schedule_mode, note from week where date = '2031-03-06'$$,
  $$values ('special'::text, true, 600, 1320, 'flexible'::text, 'Long day'::text)$$, 'Special hours replace the usual ones, with their note');
select results_eq($$select source, available, note from week where date = '2031-03-07'$$, $$values ('special'::text, false, 'Christmas Holidays'::text)$$,
  'A special day off keeps its name');
select results_eq($$select source, available, start_minutes from week where date = '2031-03-09'$$, $$values ('usual'::text, false, null::integer)$$,
  'A weekday missing from the usual week is a day off');
select is((select count(*)::integer from public.day_hours('2031-03-06')), 1, 'Exactly one row for a day, even with a special day and a usual one');

-- ---------------------------------------------------------------------------------------------
-- The booking engine agrees: no times on a day that is not worked, and every time offered inside the day's hours
-- ---------------------------------------------------------------------------------------------
create function pg_temp.offered(p_date date) returns setof integer language sql as $$
  select a.start_minutes from public.compute_booking_availability(p_date, 60, (p_date - 1)::timestamp at time zone 'Europe/London', 60, null, null) a;
$$;
select is((select count(*)::integer from pg_temp.offered('2031-03-05')), 0, 'Nothing is offered on the Wednesday that is not worked');
select is((select count(*)::integer from pg_temp.offered('2031-03-07')), 0, 'Nothing is offered on the special day off');
select is((select count(*)::integer from pg_temp.offered('2031-03-09')), 0, 'Nothing is offered on a day missing from the usual week');
select is((select count(*)::integer from pg_temp.offered('2031-03-04')), 0, 'Nothing is offered on a day covered by a block');
select ok((select count(*) > 0 and min(o) >= 870 and max(o) + 60 <= 1260 from pg_temp.offered('2031-03-03') o), 'On the Monday every time offered is inside 14:30 to 21:00');
select ok((select count(*) > 0 and min(o) >= 600 and max(o) + 60 <= 1320 from pg_temp.offered('2031-03-06') o), 'On the special Thursday every time offered is inside its special hours');
select ok((select bool_and(h.available = (exists (select 1 from pg_temp.offered(h.date)))) from week h where h.away is null),
  'For every day of the week, the Calendar''s "worked or not" matches whether the engine offers anything');

select * from finish();
rollback;
