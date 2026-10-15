begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(27);

-- ---------------------------------------------------------------------------------------------
-- Fixtures. Dates are far ahead and "now" is passed in, so nothing here depends on today's date.
-- 2031-05-07 is a Wednesday, working 10:00 to 20:00, with the first appointment at 15:00 released at 17:00 the evening before.
-- ---------------------------------------------------------------------------------------------
create function pg_temp.times(p_date date, p_now timestamptz) returns integer[] language sql as $$
  select coalesce(array_agg(start_minutes order by start_minutes), array[]::integer[])
    from public.compute_booking_availability(p_date, 60, p_now, 60, null, null);
$$;
create function pg_temp.every_time() returns integer[] language sql as $$
  select array(select generate_series(600, 1140, 30));
$$;
create function pg_temp.set_day(p_date date, p_mode text, p_fixed integer, p_release integer) returns void language plpgsql as $$
begin
  delete from public.working_hours_overrides where date = p_date;
  insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes, anchor_release_minutes)
  values (p_date, true, 600, 1200, p_mode, p_fixed, p_release);
end;
$$;

select pg_temp.set_day(date '2031-05-07', 'fixed', 900, 1020);

-- ---------------------------------------------------------------------------------------------
-- The release, on a special day
-- ---------------------------------------------------------------------------------------------
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-04-30 12:00:00+01'), array[900], 'A week ahead, only the first appointment is offered');
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 16:59:00+01'), array[900], 'One minute before the release time on the evening before, still only the first appointment');
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 17:00:00+01'), pg_temp.every_time(), 'At the release time on the evening before, the day opens to every usual time');
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 23:00:00+01'), pg_temp.every_time(), 'And stays open through the night');
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-07 09:00:00+01'), pg_temp.every_time(), 'On the day itself it is open too, even though the first appointment is still ahead');
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-07 16:00:00+01'), pg_temp.every_time(), 'And after the first appointment has passed it is still every usual time (the booking page then takes off what is inside the notice period), instead of nothing');

-- A booking makes the day a chain, release or no release.
create function pg_temp.new_booking(p_id uuid, p_date date, p_start integer) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot, created_at)
  select p_id, 'REL-' || p_id, '00000000-0000-4000-8000-00000000e201', id, p_date, p_start, 60, 'confirmed',
    'test', '10 Quiet Street', 'London', 'SW1A 1AA', name, 85, 85, 'release@example.test', now() - interval '3 days'
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp) values (p_id, 'cash', 'approved', 85);
end;
$$;
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000e201', 'Rae', 'Release', 'release@example.test');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e301', date '2031-05-07', 900);
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 16:59:00+01'), array[780, 1020], 'Once someone has booked the first appointment, the day is built around the booking (before the release time)');
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 17:00:00+01'), array[780, 1020], 'And after the release time too: the release changes nothing on a day that has a booking');
delete from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000e301';
delete from public.bookings where id = '00000000-0000-4000-8000-00000000e301';
select is(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 17:00:00+01'), pg_temp.every_time(), 'If that booking is cancelled away, the released day is open again');

-- Blocked time is still respected on a released day.
insert into public.calendar_blocks(date, start_minutes, end_minutes, kind, title) values (date '2031-05-07', 840, 960, 'blocked', 'Dentist');
select ok(not (900 = any(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 17:00:00+01'))) and 600 = any(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 17:00:00+01'))
  and not (810 = any(pg_temp.times(date '2031-05-07', timestamptz '2031-05-06 17:00:00+01'))), 'A released day still leaves out blocked time, and keeps the rest');
delete from public.calendar_blocks where title = 'Dentist' and date = date '2031-05-07';

-- ---------------------------------------------------------------------------------------------
-- Without a release time, nothing changes
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_day(date '2031-05-14', 'fixed', 900, null);
select is(pg_temp.times(date '2031-05-14', timestamptz '2031-05-13 23:00:00+01'), array[900], 'With no release time the first appointment is kept until someone books');
select is(pg_temp.times(date '2031-05-14', timestamptz '2031-05-14 16:00:00+01'), array[900], 'And it is still the only time offered once it has passed, as before (the booking page then drops it, which is why no times are left)');
select pg_temp.set_day(date '2031-05-21', 'flexible', null, null);
select is(pg_temp.times(date '2031-05-21', timestamptz '2031-05-20 12:00:00+01'), pg_temp.every_time(), 'Any time in my hours is unaffected');

-- ---------------------------------------------------------------------------------------------
-- The usual week, and a special day replacing it
-- ---------------------------------------------------------------------------------------------
update public.working_hours set available = true, start_minutes = 600, end_minutes = 1200, start_mode = 'fixed', fixed_start_minutes = 900, anchor_release_minutes = 1020 where weekday = 3;
select is(pg_temp.times(date '2031-05-28', timestamptz '2031-05-27 16:59:00+01'), array[900], 'The usual week holds the first appointment before its release time (a Wednesday with no special day)');
select is(pg_temp.times(date '2031-05-28', timestamptz '2031-05-27 17:00:00+01'), pg_temp.every_time(), 'And releases it at the release time on the evening before');
select pg_temp.set_day(date '2031-06-04', 'fixed', 900, null);
select is(pg_temp.times(date '2031-06-04', timestamptz '2031-06-03 20:00:00+01'), array[900], 'A special day with no release time replaces the usual week''s release time too');

-- ---------------------------------------------------------------------------------------------
-- "The evening before" is London time, summer and winter
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_day(date '2031-03-31', 'fixed', 900, 1020);   -- the evening before is Sunday 30 March, the day the clocks go forward
select is(pg_temp.times(date '2031-03-31', timestamptz '2031-03-30 15:59:00+00'), array[900], 'When the clocks go forward, 15:59 UTC is 16:59 in London, still before the release');
select is(pg_temp.times(date '2031-03-31', timestamptz '2031-03-30 16:00:00+00'), pg_temp.every_time(), '17:00 in London is then 16:00 UTC, and the day opens');
select pg_temp.set_day(date '2031-10-27', 'fixed', 900, 1020);  -- the evening before is Sunday 26 October, the day the clocks go back
select is(pg_temp.times(date '2031-10-27', timestamptz '2031-10-26 16:59:00+00'), array[900], 'When the clocks go back, 16:59 UTC is 16:59 in London, still before the release');
select is(pg_temp.times(date '2031-10-27', timestamptz '2031-10-26 17:00:00+00'), pg_temp.every_time(), '17:00 in London is then 17:00 UTC, and the day opens');

-- ---------------------------------------------------------------------------------------------
-- What the tables accept
-- ---------------------------------------------------------------------------------------------
select throws_ok($$insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, anchor_release_minutes) values (date '2031-07-01', true, 600, 1200, 'flexible', 1020)$$,
  '23514', null, 'A release time needs a set first appointment (special day)');
select throws_ok($$insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes, anchor_release_minutes) values (date '2031-07-02', true, 600, 1200, 'fixed', 900, 1440)$$,
  '23514', null, 'A release time must be a time of day, not 24:00 (special day)');
select throws_ok($$insert into public.working_hours_overrides(date, available, anchor_release_minutes) values (date '2031-07-03', false, 1020)$$,
  '23514', null, 'A day off cannot have a release time (special day)');
select lives_ok($$insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes, anchor_release_minutes) values (date '2031-07-04', true, 600, 1200, 'fixed', 900, 0)$$,
  'Midnight is a valid release time (special day)');
select throws_ok($$update public.working_hours set start_mode = 'flexible', fixed_start_minutes = null, anchor_release_minutes = 1020 where weekday = 3$$,
  '23514', null, 'A release time needs a set first appointment (usual week)');
select throws_ok($$update public.working_hours set anchor_release_minutes = 1500 where weekday = 3$$, '23514', null, 'A release time must be a time of day (usual week)');
select lives_ok($$update public.working_hours set anchor_release_minutes = null where weekday = 3$$, 'A set first appointment can have no release time (usual week)');

select * from finish();
rollback;
