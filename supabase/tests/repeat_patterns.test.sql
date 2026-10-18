begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- Who may call what.
select ok(not has_function_privilege('anon', 'public.admin_series_cancel_dates(uuid,date[],uuid)', 'EXECUTE'), 'Anonymous callers cannot cancel dates of a repeat');
select ok(not has_function_privilege('anon', 'public.admin_series_cancel_all_upcoming(uuid,uuid)', 'EXECUTE'), 'Anonymous callers cannot cancel a whole repeat');
select ok(has_function_privilege('authenticated', 'public.admin_series_cancel_dates(uuid,date[],uuid)', 'EXECUTE'), 'The Admin''s command can be called');
select ok(not has_function_privilege('authenticated', 'public.series_cancel_dates(uuid,date[],uuid)', 'EXECUTE'), 'The cancelling itself is internal');
select ok(not has_function_privilege('authenticated', 'public.series_dates(public.booking_series,date,date)', 'EXECUTE'), 'Working out a repeat''s dates is internal');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('series_cancel_dates', 'admin_series_cancel_dates', 'admin_series_cancel_all_upcoming')), 'The cancelling commands are definers with an empty search path');
select ok((select p.proconfig @> array['search_path=""'] from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'series_dates'), 'Working out the dates has an empty search path');

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000f701', 'authenticated', 'authenticated', 'patterns-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000f702', 'authenticated', 'authenticated', 'patterns-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f701');
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
  select (clock_timestamp() at time zone 'Europe/London')::date + d, true, 0, 1440, 'flexible' from generate_series(0, 400) d
  on conflict (date) do update set available = true, start_minutes = 0, end_minutes = 1440, start_mode = 'flexible', fixed_start_minutes = null;
insert into public.business_settings(key, value) values ('series_payment_reminder_days', '7') on conflict (key) do update set value = '7';
insert into public.clients(id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000f711', 'Pat', 'Pattern', 'pat.pattern@example.test'),
  ('00000000-0000-4000-8000-00000000f712', 'Nora', 'Nothing', 'nora.nothing@example.test'),
  ('00000000-0000-4000-8000-00000000f713', 'Mia', 'Monthly', 'mia.monthly@example.test'),
  ('00000000-0000-4000-8000-00000000f714', 'Cal', 'Cancel', 'cal.cancel@example.test'),
  ('00000000-0000-4000-8000-00000000f715', 'Dee', 'Dates', 'dee.dates@example.test');
insert into public.client_addresses(id, client_id, address_line_1, city, postcode, is_default)
  select ('00000000-0000-4000-8000-00000000f72' || n)::uuid, ('00000000-0000-4000-8000-00000000f71' || n)::uuid, n || ' Pattern Place', 'London', 'SW3 1A' || n, true from generate_series(1, 5) n;

create function pg_temp.today_plus(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
-- The request for client number p_n (1 to 5), on the day p_offset days from today, at p_start.
create function pg_temp.request(p_n integer, p_offset integer, p_start integer default 600, p_payment text default 'bank_pending') returns jsonb language sql as $$
  select jsonb_build_object('client_id', ('00000000-0000-4000-8000-00000000f71' || p_n)::uuid, 'saved_address_id', ('00000000-0000-4000-8000-00000000f72' || p_n)::uuid,
    'service_area_id', (select id from public.service_areas where slug = 'chelsea'),
    'sessions', jsonb_build_array(jsonb_build_object('service_id', (select id from public.services where slug = 'massage'), 'duration_minutes', 60, 'recipient_name', 'Pat')),
    'enhancement_ids', '[]'::jsonb, 'date', pg_temp.today_plus(p_offset), 'start_minutes', p_start, 'payment_arrangement', p_payment, 'note', null);
$$;
-- A repeat inserted directly, with fixed dates, to check the pattern alone.
create function pg_temp.series(p_first date, p_pattern text, p_every integer, p_month_week integer, p_dates date[], p_end date default null) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.booking_series(client_id, weekday, first_date, end_date, start_minutes, treatment_duration_minutes, request, pattern, every_weeks, month_week, custom_dates)
  values ('00000000-0000-4000-8000-00000000f711', extract(isodow from p_first)::integer, p_first, p_end, 600, 60, '{}', p_pattern, p_every, p_month_week, p_dates) returning id into v_id;
  return v_id;
end; $$;
create function pg_temp.dates_of(p_id uuid, p_from date, p_to date) returns text language sql as $$
  select coalesce(string_agg(d::text, ' ' order by d), '') from public.series_dates((select s from public.booking_series s where s.id = p_id), p_from, p_to) d;
$$;

-- ------------------------------------------------------------------------------------------------
-- What each pattern means (2027: 4 March is a Thursday)
-- ------------------------------------------------------------------------------------------------
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 1, null, null), '2027-03-01', '2027-03-31'), '2027-03-04 2027-03-11 2027-03-18 2027-03-25', 'Every week: every Thursday from the first');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 2, null, null), '2027-03-01', '2027-05-01'), '2027-03-04 2027-03-18 2027-04-01 2027-04-15 2027-04-29', 'Every 2 weeks: every other Thursday');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 3, null, null), '2027-03-01', '2027-05-10'), '2027-03-04 2027-03-25 2027-04-15 2027-05-06', 'Every 3 weeks: every third Thursday');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 4, null, null), '2027-03-01', '2027-05-10'), '2027-03-04 2027-04-01 2027-04-29', 'Every 4 weeks: every fourth Thursday');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'monthly', 1, 1, null), '2027-03-01', '2027-08-31'), '2027-03-04 2027-04-01 2027-05-06 2027-06-03 2027-07-01 2027-08-05', 'Monthly: the first Thursday of each month');
select is(pg_temp.dates_of(pg_temp.series('2027-03-11', 'monthly', 1, 2, null), '2027-03-01', '2027-08-31'), '2027-03-11 2027-04-08 2027-05-13 2027-06-10 2027-07-08 2027-08-12', 'Monthly: the second Thursday of each month');
select is(pg_temp.dates_of(pg_temp.series('2027-04-29', 'monthly', 1, 5, null), '2027-04-01', '2027-08-31'), '2027-04-29 2027-05-27 2027-06-24 2027-07-29 2027-08-26', 'Monthly: the last Thursday of each month, whether the month has four or five');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'dates', 1, null, array['2027-03-04', '2027-03-19', '2027-05-07']::date[], '2027-05-07'), '2027-01-01', '2027-12-31'), '2027-03-04 2027-03-19 2027-05-07', 'Dates chosen one by one: exactly those, whatever the weekday');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 1, null, null, '2027-03-18'), '2027-03-01', '2027-03-31'), '2027-03-04 2027-03-11 2027-03-18', 'A repeat with an end date stops on it');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 1, null, null), '2027-03-12', '2027-03-26'), '2027-03-18 2027-03-25', 'Only the dates between the two days are given');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 2, null, null), '2027-02-01', '2027-03-03'), '', 'Nothing before the first date');
select is(pg_temp.dates_of(pg_temp.series('2027-03-04', 'weeks', 2, null, null), '2027-03-05', '2027-03-17'), '', 'A gap between two dates is empty');

-- A pattern cannot be saved in a shape that means nothing.
select throws_ok($$select pg_temp.series('2027-03-04', 'monthly', 1, null, null)$$, '23514', null, 'Monthly needs the week of the month');
select throws_ok($$select pg_temp.series('2027-03-04', 'monthly', 1, 6, null)$$, '23514', null, 'The week of the month is 1 to 5');
select throws_ok($$select pg_temp.series('2027-03-04', 'weeks', 13, null, null)$$, '23514', null, 'A gap of more than 12 weeks is refused');
select throws_ok($$select pg_temp.series('2027-03-04', 'weeks', 0, null, null)$$, '23514', null, 'A gap of no weeks is refused');
select throws_ok($$select pg_temp.series('2027-03-04', 'dates', 1, null, null)$$, '23514', null, 'Chosen dates need dates');
select throws_ok($$select pg_temp.series('2027-03-04', 'dates', 1, null, '{}')$$, '23514', null, 'Chosen dates cannot be an empty list');
select throws_ok($$select pg_temp.series('2027-03-04', 'weeks', 1, null, array['2027-03-04']::date[])$$, '23514', null, 'A weekly repeat has no list of dates');
select throws_ok($$select pg_temp.series('2027-03-04', 'yearly', 1, null, null)$$, '23514', null, 'An unknown pattern is refused');
-- Those were only to look at the dates: take them away, so that they take no part in what follows.
delete from public.booking_series;

-- ------------------------------------------------------------------------------------------------
-- Making a repeat with a pattern
-- ------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f702","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from public.admin_create_series(pg_temp.request(1, 10), null, gen_random_uuid(), '{"kind":"weeks","every_weeks":2}')$$, '42501', 'Admin authorization required', 'A client cannot make a repeat, whatever its pattern');
select throws_ok($$select public.admin_series_cancel_dates(gen_random_uuid(), array[pg_temp.today_plus(20)], gen_random_uuid())$$, '42501', 'Admin authorization required', 'A client cannot cancel dates of a repeat');
select throws_ok($$select public.admin_series_cancel_all_upcoming(gen_random_uuid(), gen_random_uuid())$$, '42501', 'Admin authorization required', 'A client cannot cancel a whole repeat');
reset role;

-- Each repeat on its own weekday, so that none of them takes another's time.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
create temp table biweekly as select * from public.admin_create_series(pg_temp.request(1, 10), null, '00000000-0000-4000-8000-00000000f731', '{"kind":"weeks","every_weeks":2}');
grant select on biweekly to authenticated;
create temp table monthly as select * from public.admin_create_series(pg_temp.request(3, 11), null, '00000000-0000-4000-8000-00000000f732', '{"kind":"monthly"}');
grant select on monthly to authenticated;
create temp table chosen as select * from public.admin_create_series(pg_temp.request(5, 12), null, '00000000-0000-4000-8000-00000000f733',
  jsonb_build_object('kind', 'dates', 'dates', jsonb_build_array(pg_temp.today_plus(15), pg_temp.today_plus(22), pg_temp.today_plus(57))));
grant select on chosen to authenticated;
reset role;

select results_eq($$select pattern, every_weeks::integer, month_week, custom_dates from public.booking_series where id = (select series_id from biweekly)$$,
  $$values ('weeks'::text, 2, null::smallint, null::date[])$$, 'Every 2 weeks is recorded');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from biweekly) and kind = 'series_hold'), 25, 'An every-other-week slot is held for the next 25 sessions');
select ok(exists (select 1 from public.calendar_blocks where series_id = (select series_id from biweekly) and date = pg_temp.today_plus(24)), 'The slot two weeks after the first is held');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from biweekly) and date in (pg_temp.today_plus(17), pg_temp.today_plus(31))), 0, 'The weeks in between are not held');
select is((select count(*)::integer from public.bookings where series_id = (select series_id from biweekly)), 1, 'The first booking is made with the repeat');

select results_eq($$select pattern, every_weeks::integer, month_week::integer, custom_dates from public.booking_series where id = (select series_id from monthly)$$,
  $$select 'monthly'::text, 1, least((extract(day from pg_temp.today_plus(11))::integer - 1) / 7 + 1, 5), null::date[]$$, 'Monthly is recorded with the week of the month of the first booking');
select ok((select count(*) between 10 and 12 from public.calendar_blocks where series_id = (select series_id from monthly)), 'A monthly slot is held for the next eleven or so months');
select ok((select bool_and(extract(isodow from cb.date) = extract(isodow from pg_temp.today_plus(11))
                           and case when m.month_week = 5 then extract(month from cb.date + 7) <> extract(month from cb.date)
                                    else (extract(day from cb.date)::integer - 1) / 7 + 1 = m.month_week end)
          from public.calendar_blocks cb join public.booking_series m on m.id = cb.series_id where m.id = (select series_id from monthly)), 'Every held date is the same weekday, in the same week of its month');

select results_eq($$select pattern, every_weeks::integer, month_week, cardinality(custom_dates), end_date from public.booking_series where id = (select series_id from chosen)$$,
  $$select 'dates'::text, 1, null::smallint, 4, pg_temp.today_plus(57)$$, 'Chosen dates are recorded with the first booking, and the last one ends the repeat');
select results_eq($$select date from public.calendar_blocks where series_id = (select series_id from chosen) order by date$$,
  $$select pg_temp.today_plus(15) union all select pg_temp.today_plus(22) union all select pg_temp.today_plus(57)$$, 'Only the chosen dates are held');
select is(pg_temp.dates_of((select series_id from chosen), pg_temp.today_plus(0), pg_temp.today_plus(100)),
  pg_temp.today_plus(12)::text || ' ' || pg_temp.today_plus(15)::text || ' ' || pg_temp.today_plus(22)::text || ' ' || pg_temp.today_plus(57)::text, 'The first booking and the chosen dates are the repeat');

-- A retry makes nothing more, and a pattern that is wrong makes nothing at all.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select is((select series_id from public.admin_create_series(pg_temp.request(1, 10), null, '00000000-0000-4000-8000-00000000f731', '{"kind":"weeks","every_weeks":2}')), (select series_id from biweekly), 'A retry returns the same repeat');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"yearly"}')$$, '22023', 'Choose how often it repeats', 'An unknown kind is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"weeks","every_weeks":0}')$$, '22023', 'Choose between 1 and 12 weeks', 'No gap is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"weeks","every_weeks":13}')$$, '22023', 'Choose between 1 and 12 weeks', 'More than 12 weeks is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"weeks","every_weeks":"x"}')$$, '22023', 'Choose between 1 and 12 weeks', 'A gap that is not a number is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"dates"}')$$, '22023', 'Choose between 1 and 59 dates', 'Chosen dates need a list');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"dates","dates":[]}')$$, '22023', 'Choose between 1 and 59 dates', 'The list cannot be empty');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"dates","dates":"2027-01-01"}')$$, '22023', 'Choose between 1 and 59 dates', 'The list must be a list');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), jsonb_build_object('kind', 'dates', 'dates', (select jsonb_agg(pg_temp.today_plus(14 + n)) from generate_series(1, 60) n)))$$,
  '22023', 'Choose between 1 and 59 dates', 'More than 59 dates are refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"dates","dates":["next tuesday"]}')$$, '22023', 'Choose real dates', 'A date that is not a date is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"dates","dates":["2027-02-30"]}')$$, '22023', 'Choose real dates', 'A day that is not on the calendar is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), jsonb_build_object('kind', 'dates', 'dates', jsonb_build_array(pg_temp.today_plus(14))))$$,
  '22023', 'Choose dates after the first booking, within three years', 'The first booking''s own day is not an extra date');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), jsonb_build_object('kind', 'dates', 'dates', jsonb_build_array(pg_temp.today_plus(13))))$$,
  '22023', 'Choose dates after the first booking, within three years', 'A date before the first booking is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), jsonb_build_object('kind', 'dates', 'dates', jsonb_build_array(pg_temp.today_plus(1200))))$$,
  '22023', 'Choose dates after the first booking, within three years', 'A date beyond three years is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), pg_temp.today_plus(40), gen_random_uuid(), jsonb_build_object('kind', 'dates', 'dates', jsonb_build_array(pg_temp.today_plus(20))))$$,
  '22023', 'Dates chosen one by one have no end date', 'Chosen dates have no end date');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), jsonb_build_object('kind', 'weeks', 'dates', jsonb_build_array(pg_temp.today_plus(20))))$$,
  '22023', 'Choose how often it repeats', 'A list of dates only goes with chosen dates');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '{"kind":"weeks","colour":"red"}')$$, '22023', 'Choose how often it repeats', 'An unknown field is refused');
select throws_ok($$select * from public.admin_create_series(pg_temp.request(2, 14), null, gen_random_uuid(), '[]')$$, '22023', 'Choose how often it repeats', 'A pattern that is not an object is refused');
reset role;
select is((select count(*)::integer from public.bookings where client_id = '00000000-0000-4000-8000-00000000f712'), 0, 'None of the refused repeats made a booking');
select is((select count(*)::integer from public.booking_series where client_id = '00000000-0000-4000-8000-00000000f712'), 0, 'Or a repeat');

-- Every week stays the default: with no pattern (the repeats made before this change, and the old three-argument calls) or an empty one.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
create temp table weekly as select * from public.admin_create_series(pg_temp.request(2, 13), null, gen_random_uuid(), '{}');
grant select on weekly to authenticated;
reset role;
select results_eq($$select pattern, every_weeks::integer, month_week, custom_dates from public.booking_series where id = (select series_id from weekly)$$, $$values ('weeks'::text, 1, null::smallint, null::date[])$$, 'An empty pattern is every week, as it always was');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from weekly)), 50, 'And holds 50 weeks');

-- ------------------------------------------------------------------------------------------------
-- The daily job makes the booking for any pattern when it is due
-- ------------------------------------------------------------------------------------------------
-- A repeat every 2 weeks that started ten days ago: its next session is four days from now.
create temp table direct as select pg_temp.series(pg_temp.today_plus(-10), 'weeks', 2, null, null) as id;
update public.booking_series set client_id = '00000000-0000-4000-8000-00000000f712', created_by = '00000000-0000-0000-0000-00000000f701',
  request = pg_temp.request(2, 0) - 'date' - 'start_minutes' where id = (select id from direct);
select is((select public.run_series_maintenance()), '{"made": 1, "clashes": 0, "ended": 0}'::jsonb, 'A repeat every 2 weeks is booked when its next date is within the week');
select is((select date from public.bookings where series_id = (select id from direct)), pg_temp.today_plus(4), 'It is the date two weeks after the one ten days ago, not a weekly one');
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'And only once');

-- ------------------------------------------------------------------------------------------------
-- What the Admin sees
-- ------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->>'pattern', 'weeks', 'The listing says the pattern');
select is((public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->>'every_weeks')::integer, 2, 'And the gap');
select is(jsonb_array_length(public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->'upcoming'), 12, 'It lists the next twelve dates');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->'upcoming'->0->>'state', 'booked', 'The first is booked');
select is((public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->'upcoming'->0->>'date')::date, pg_temp.today_plus(10), 'On the first booking''s date');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->'upcoming'->1->>'state', 'held', 'The next is only held');
select is((public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->'upcoming'->1->>'date')::date, pg_temp.today_plus(24), 'Two weeks later');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f715')->0->'upcoming'->3->>'state', 'held', 'A chosen date is held');
select is(jsonb_array_length(public.admin_client_series('00000000-0000-4000-8000-00000000f715')->0->'upcoming'), 4, 'A repeat of chosen dates lists just its dates');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f713')->0->>'pattern', 'monthly', 'A monthly repeat says so');
select is((public.admin_client_series('00000000-0000-4000-8000-00000000f713')->0->>'month_week')::integer, least((extract(day from pg_temp.today_plus(11))::integer - 1) / 7 + 1, 5), 'With the week of the month');
select throws_ok($$select public.admin_skip_series_date((select series_id from biweekly), pg_temp.today_plus(17))$$, '22023', 'That date is not one of this repeat''s dates', 'A date that is not one of the repeat''s cannot be skipped');
select throws_ok($$select public.admin_skip_series_date(gen_random_uuid(), pg_temp.today_plus(24))$$, 'P0002', 'Repeat unavailable', 'Nor can a date of a repeat that is not there');
select lives_ok($$select public.admin_skip_series_date((select series_id from biweekly), pg_temp.today_plus(24))$$, 'A date can still be skipped');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->'upcoming'->1->>'state', 'skipped', 'And is then listed as skipped');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f711')->0->'upcoming'->1->>'reason', 'skipped', 'With why');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f715')->0->>'upcoming_booked', '1', 'One booking is still to come');
select lives_ok($$select public.admin_set_series_status((select series_id from chosen), 'paused')$$, 'A repeat can be paused');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f715')->0->'upcoming'->1->>'state', 'paused', 'The dates of a paused repeat are shown as paused, not held');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f715')->0->'upcoming'->0->>'state', 'booked', 'But what is booked stays booked');
select lives_ok($$select public.admin_set_series_status((select series_id from chosen), 'active')$$, 'And it can be resumed');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f715')->0->'upcoming'->1->>'state', 'held', 'When the dates are held again');
reset role;

-- ------------------------------------------------------------------------------------------------
-- Cancelling what is coming
-- ------------------------------------------------------------------------------------------------
-- Cal's weekly repeat has a session that is done, one tomorrow at midnight (inside the 24 hours, where a client would be charged, and paid),
-- one next week (not paid yet), one the week after (cash), and the weeks after that still only held.
create function pg_temp.booking(p_series uuid, p_offset integer, p_start integer, p_status text, p_method text, p_pay text) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot, series_id)
  select v_id, 'PAT-' || v_id, '00000000-0000-4000-8000-00000000f714', a.id, pg_temp.today_plus(p_offset), p_start, 60, p_status,
    'test', '4 Pattern Place', 'London', 'SW3 1A4', a.name, 90, 90, 'cal.cancel@example.test', p_series from public.service_areas a where a.slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at) values (v_id, p_method, p_pay, 90, case when p_pay = 'paid' then now() end);
  return v_id;
end; $$;
create temp table cal as select pg_temp.series(pg_temp.today_plus(-6), 'weeks', 1, null, null) as id;
grant select on cal to authenticated;
update public.booking_series set client_id = '00000000-0000-4000-8000-00000000f714', created_by = '00000000-0000-0000-0000-00000000f701',
  request = pg_temp.request(4, 0) - 'date' - 'start_minutes' where id = (select id from cal);
create temp table cal_bookings as select
  pg_temp.booking((select id from cal), -6, 600, 'completed', 'bank_transfer', 'paid') as done_id,
  pg_temp.booking((select id from cal), 1, 0, 'confirmed', 'bank_transfer', 'paid') as paid_id,
  pg_temp.booking((select id from cal), 8, 600, 'awaiting_transfer', 'bank_transfer', 'awaiting_transfer') as unpaid_id,
  pg_temp.booking((select id from cal), 15, 600, 'confirmed', 'cash', 'approved') as cash_id;
select public.refresh_series_holds((select id from cal));
select is((select count(*)::integer from public.calendar_blocks where series_id = (select id from cal) and date = pg_temp.today_plus(22)), 1, 'The weeks after the booked ones are held');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f714')->0->>'upcoming_booked', '3', 'Three bookings are still to come');
select results_eq($$select t.x->>'state' from jsonb_array_elements(public.admin_client_series('00000000-0000-4000-8000-00000000f714')->0->'upcoming') with ordinality t(x, n) where t.n <= 5 order by t.n$$,
  $$values ('booked'::text), ('booked'), ('booked'), ('held'), ('held')$$, 'The first three dates are booked and the ones after only held');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_series_cancel_dates((select id from cal), array[]::date[], gen_random_uuid())$$, '22023', 'Choose between 1 and 60 dates', 'No dates is refused');
select throws_ok($$select public.admin_series_cancel_dates((select id from cal), null, gen_random_uuid())$$, '22023', 'Choose between 1 and 60 dates', 'No list is refused');
select throws_ok($$select public.admin_series_cancel_dates((select id from cal), array[pg_temp.today_plus(-1)], gen_random_uuid())$$, '22023', 'Only dates still to come can be cancelled', 'A day that has gone cannot be cancelled');
select throws_ok($$select public.admin_series_cancel_dates((select id from cal), array[pg_temp.today_plus(2)], gen_random_uuid())$$, '22023', 'That date is not one of this repeat''s dates', 'A date that is not the repeat''s is refused');
select throws_ok($$select public.admin_series_cancel_dates(gen_random_uuid(), array[pg_temp.today_plus(22)], gen_random_uuid())$$, 'P0002', 'Repeat unavailable', 'An unknown repeat is refused');
create temp table first_cancel as select public.admin_series_cancel_dates((select id from cal), array[pg_temp.today_plus(1), pg_temp.today_plus(22)], '00000000-0000-4000-8000-00000000f741') as result;
grant select on first_cancel to authenticated;
reset role;
select is((select result from first_cancel), '{"cancelled": 1, "skipped": 1}'::jsonb, 'One booked date was cancelled and one held date skipped');
select results_eq($$select booking_status, cancellation_initiated_by, late_fee_status, late_fee_due_gbp::numeric, refund_due_gbp::numeric from public.bookings where id = (select paid_id from cal_bookings)$$,
  $$values ('cancelled'::text, 'admin'::text, 'none'::text, 0::numeric, 90::numeric)$$, 'The booking inside 24 hours is cancelled with no late fee, and what was paid is a refund to send');
select is((select booking_status from public.bookings where id = (select unpaid_id from cal_bookings)), 'awaiting_transfer', 'A booking that was not asked about is untouched');
select is((select reason from public.booking_series_skips where series_id = (select id from cal) and date = pg_temp.today_plus(1)), 'cancelled', 'The cancelled booking''s date is skipped as cancelled');
select is((select reason from public.booking_series_skips where series_id = (select id from cal) and date = pg_temp.today_plus(22)), 'skipped', 'The held date is skipped');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select id from cal) and date = pg_temp.today_plus(22)), 0, 'And no longer held');
select results_eq($$select d.title, d.channel from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
    where e.event_type = 'booking.cancelled' and d.audience = 'client' and e.aggregate_id = (select paid_id from cal_bookings)$$,
  $$values ('Your appointment has been cancelled'::text, 'email'::text)$$, 'The client is told about the booking that was cancelled');
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'booking.cancelled' and e.aggregate_id = (select unpaid_id from cal_bookings)), 0, 'And about nothing else');

-- The same request again changes nothing; the same key for something else is refused.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_series_cancel_dates((select id from cal), array[pg_temp.today_plus(1), pg_temp.today_plus(22)], '00000000-0000-4000-8000-00000000f741'), '{"repeated": true}'::jsonb, 'A retry answers that it was already done');
select throws_ok($$select public.admin_series_cancel_dates((select id from cal), array[pg_temp.today_plus(8)], '00000000-0000-4000-8000-00000000f741')$$, '22023', 'Request key reused', 'The same request key for other dates is refused');
reset role;
select is((select count(*)::integer from public.bookings where series_id = (select id from cal) and booking_status = 'cancelled'), 1, 'The retry cancelled nothing more');

-- A booked date and a held one, in one go.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_series_cancel_dates((select id from cal), array[pg_temp.today_plus(8), pg_temp.today_plus(29)], gen_random_uuid()), '{"cancelled": 1, "skipped": 1}'::jsonb, 'Several dates at once');
reset role;
select results_eq($$select booking_status, late_fee_status, refund_due_gbp::numeric from public.bookings where id = (select unpaid_id from cal_bookings)$$, $$values ('cancelled'::text, 'none'::text, 0::numeric)$$, 'An unpaid booking is cancelled with nothing to refund');
select is((select status from public.booking_payments where booking_id = (select unpaid_id from cal_bookings)), 'rejected', 'Its payment is closed');
select is((select booking_status from public.bookings where id = (select cash_id from cal_bookings)), 'confirmed', 'The date not named is untouched');

-- All that is upcoming, and the repeat ends.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_series_cancel_all_upcoming(gen_random_uuid(), gen_random_uuid())$$, 'P0002', 'Repeat unavailable', 'An unknown repeat is refused');
create temp table all_cancel as select public.admin_series_cancel_all_upcoming((select id from cal), '00000000-0000-4000-8000-00000000f742') as result;
grant select on all_cancel to authenticated;
reset role;
select is((select result from all_cancel), '{"cancelled": 1, "skipped": 0}'::jsonb, 'The one booking still to come was cancelled');
select is((select booking_status from public.bookings where id = (select cash_id from cal_bookings)), 'cancelled', 'The cash booking is cancelled');
select is((select status from public.booking_payments where booking_id = (select cash_id from cal_bookings)), 'rejected', 'And its payment closed');
select is((select booking_status from public.bookings where id = (select done_id from cal_bookings)), 'completed', 'A session that has happened is left as it is');
select results_eq($$select status, ended_at is not null from public.booking_series where id = (select id from cal)$$, $$values ('ended'::text, true)$$, 'The repeat has ended');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select id from cal)), 0, 'Nothing is held any more');
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'The daily job makes nothing for an ended repeat');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_series_cancel_all_upcoming((select id from cal), '00000000-0000-4000-8000-00000000f742'), '{"repeated": true}'::jsonb, 'A retry answers that it was already done');
select throws_ok($$select public.admin_series_cancel_all_upcoming((select id from cal), gen_random_uuid())$$, 'PT409', 'This repeat has ended', 'An ended repeat cannot be ended again');
select throws_ok($$select public.admin_series_cancel_dates((select id from cal), array[pg_temp.today_plus(36)], gen_random_uuid())$$, 'PT409', 'This repeat has ended', 'Or have dates cancelled');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
set local role authenticated;
select is(jsonb_array_length(public.admin_client_series('00000000-0000-4000-8000-00000000f714')->0->'upcoming'), 0, 'An ended repeat has no dates still to come');
select is(public.admin_client_series('00000000-0000-4000-8000-00000000f714')->0->>'upcoming_booked', '0', 'And no bookings');
reset role;
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'booking.cancelled'
    and e.aggregate_id in ((select paid_id from cal_bookings), (select unpaid_id from cal_bookings), (select cash_id from cal_bookings))), 3, 'Each cancellation is recorded once, like any cancellation by the Admin');
select results_eq($$select distinct e.payload->>'initiated_by' from public.event_outbox e where e.event_type = 'booking.cancelled'
    and e.aggregate_id in ((select paid_id from cal_bookings), (select unpaid_id from cal_bookings), (select cash_id from cal_bookings))$$,
  $$values ('admin'::text)$$, 'All of them on the Admin''s own account');

select * from finish();
rollback;
