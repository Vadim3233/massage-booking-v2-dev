begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(34);

-- ---------------------------------------------------------------------------------------------
-- Fixtures. Dates are far ahead and "now" is passed in, so nothing here depends on today's date.
-- Every day works 10:00 to 20:00 (600 to 1200), treatments are 60 minutes and the travel between appointments is 60 minutes,
-- unless a test says otherwise. A "chain" day and a "flexible" day are always given exactly the same bookings and blocks.
-- ---------------------------------------------------------------------------------------------
create function pg_temp.times(p_date date, p_now timestamptz default timestamptz '2031-01-01 00:00:00+00', p_buffer integer default 60, p_excluded_booking uuid default null)
returns integer[] language sql as $$
  select coalesce(array_agg(start_minutes order by start_minutes), array[]::integer[])
    from public.compute_booking_availability(p_date, 60, p_now, p_buffer, null, p_excluded_booking);
$$;
create function pg_temp.range(p_from integer, p_to integer) returns integer[] language sql as $$
  select array(select generate_series(p_from, p_to, 30));
$$;
create function pg_temp.set_day(p_date date, p_mode text, p_start_mode text default 'flexible', p_fixed integer default null, p_release integer default null) returns void language plpgsql as $$
begin
  delete from public.working_hours_overrides where date = p_date;
  insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes, anchor_release_minutes, schedule_mode)
  values (p_date, true, 600, 1200, p_start_mode, p_fixed, p_release, p_mode);
end;
$$;
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000e401', 'Fleur', 'Xible', 'flexible@example.test');
create function pg_temp.new_booking(p_id uuid, p_date date, p_start integer) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot, created_at)
  select p_id, 'MOD-' || p_id, '00000000-0000-4000-8000-00000000e401', id, p_date, p_start, 60, 'confirmed',
    'test', '10 Quiet Street', 'London', 'SW1A 1AA', name, 85, 85, 'flexible@example.test', now() - interval '3 days'
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp) values (p_id, 'cash', 'approved', 85);
end;
$$;
create function pg_temp.book(p_date date, p_start integer) returns void language sql as $$
  select pg_temp.new_booking(gen_random_uuid(), p_date, p_start);
$$;
create function pg_temp.block(p_date date, p_start integer, p_end integer, p_title text) returns void language sql as $$
  insert into public.calendar_blocks(date, start_minutes, end_minutes, kind, title) values (p_date, p_start, p_end, 'blocked', p_title);
$$;

-- What a day set up without saying anything about the mode is.
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode) values (date '2031-05-05', true, 600, 1200, 'flexible');
select is((select schedule_mode from public.working_hours_overrides where date = date '2031-05-05'), 'chain', 'A day saved without a mode is a chain day, as every day has been');

-- ---------------------------------------------------------------------------------------------
-- One booking at 15:00: a chain day offers the two ends, a flexible day every time with room for the travel on both sides
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_day(date '2031-06-02', 'chain');
select pg_temp.set_day(date '2031-06-03', 'flexible');
select pg_temp.book(date '2031-06-02', 900);
select pg_temp.book(date '2031-06-03', 900);
select is(pg_temp.times(date '2031-06-02'), array[780, 1020], 'Chain: with a booking at 15:00 only the two ends are offered, 13:00 before it and 17:00 after it');
select is(pg_temp.times(date '2031-06-03'), pg_temp.range(600, 780) || pg_temp.range(1020, 1140), 'Flexible: every half hour with an hour of travel either side of the 15:00 booking, 10:00 to 13:00 and 17:00 to 19:00');
select ok(pg_temp.times(date '2031-06-02') <@ pg_temp.times(date '2031-06-03'), 'A flexible day always offers everything the chain day would');

-- ---------------------------------------------------------------------------------------------
-- The gap between two bookings
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_day(date '2031-06-09', 'chain');
select pg_temp.set_day(date '2031-06-10', 'flexible');
select pg_temp.book(date '2031-06-09', 600); select pg_temp.book(date '2031-06-09', 1080);
select pg_temp.book(date '2031-06-10', 600); select pg_temp.book(date '2031-06-10', 1080);
select is(pg_temp.times(date '2031-06-09'), array[]::integer[], 'Chain: bookings at 10:00 and 18:00 leave nothing, because the ends of the day are already used');
select is(pg_temp.times(date '2031-06-10'), pg_temp.range(720, 960), 'Flexible: the gap between them is offered, from an hour after the first ends to an hour before the second starts');

-- A gap that is exactly big enough
select pg_temp.set_day(date '2031-06-16', 'chain');
select pg_temp.set_day(date '2031-06-17', 'flexible');
select pg_temp.book(date '2031-06-16', 600); select pg_temp.book(date '2031-06-16', 840);
select pg_temp.book(date '2031-06-17', 600); select pg_temp.book(date '2031-06-17', 840);
select is(pg_temp.times(date '2031-06-16'), array[960], 'Chain: bookings at 10:00 and 14:00 leave only the time after the last one');
select is(pg_temp.times(date '2031-06-17'), array[720] || pg_temp.range(960, 1140), 'Flexible: a gap with exactly an hour of travel on each side is offered (12:00), as well as the times after the last booking');
select ok(pg_temp.times(date '2031-06-16') <@ pg_temp.times(date '2031-06-17'), 'And a flexible day again offers everything the chain day would');

-- ---------------------------------------------------------------------------------------------
-- Blocked time. It may not overlap the treatment, nor the travel into it from an appointment before it, nor (for the day's first
-- appointment) the travel on to the appointment after it: the same checks as at the ends of a chain.
-- ---------------------------------------------------------------------------------------------
-- A lunch (13:00 to 14:00) before the 15:00 booking
select pg_temp.set_day(date '2031-06-23', 'chain');
select pg_temp.set_day(date '2031-06-24', 'flexible');
select pg_temp.book(date '2031-06-23', 900); select pg_temp.block(date '2031-06-23', 780, 840, 'Lunch');
select pg_temp.book(date '2031-06-24', 900); select pg_temp.block(date '2031-06-24', 780, 840, 'Lunch');
select is(pg_temp.times(date '2031-06-23'), array[1020], 'Chain: the time before the booking is lost to the lunch');
select is(pg_temp.times(date '2031-06-24'), pg_temp.range(600, 720) || pg_temp.range(1020, 1140), 'Flexible: nothing that overlaps the lunch is offered (12:00 ends as it begins, so it is), the rest of the day is');
select ok(pg_temp.times(date '2031-06-23') <@ pg_temp.times(date '2031-06-24'), 'Still everything the chain day would offer');

-- A dentist (12:00 to 13:00) after the 10:00 booking: the travel to a later time may not run through it either
select pg_temp.set_day(date '2031-06-30', 'chain');
select pg_temp.set_day(date '2031-07-01', 'flexible');
select pg_temp.book(date '2031-06-30', 600); select pg_temp.block(date '2031-06-30', 720, 780, 'Dentist');
select pg_temp.book(date '2031-07-01', 600); select pg_temp.block(date '2031-07-01', 720, 780, 'Dentist');
select is(pg_temp.times(date '2031-06-30'), array[]::integer[], 'Chain: the dentist leaves no time after the 10:00 booking');
select is(pg_temp.times(date '2031-07-01'), pg_temp.range(840, 1140), 'Flexible: from 14:00, when the dentist has finished and there is an hour of travel before the treatment (13:00 and 13:30 would need the travel to run through the dentist)');

-- A gym (13:00 to 13:30) in the hour of travel before the 14:00 booking: nothing can be put before that booking
select pg_temp.set_day(date '2031-07-07', 'chain');
select pg_temp.set_day(date '2031-07-08', 'flexible');
select pg_temp.book(date '2031-07-07', 840); select pg_temp.block(date '2031-07-07', 780, 810, 'Gym');
select pg_temp.book(date '2031-07-08', 840); select pg_temp.block(date '2031-07-08', 780, 810, 'Gym');
select is(pg_temp.times(date '2031-07-07'), array[960], 'Chain: a new first appointment would need travel through the gym, so only the time after is offered');
select is(pg_temp.times(date '2031-07-08'), pg_temp.range(960, 1140), 'Flexible: the same, nothing before the 14:00 booking, because the new first appointment would need that travel');
select ok(pg_temp.times(date '2031-07-07') <@ pg_temp.times(date '2031-07-08'), 'Again everything the chain day would offer');

-- A dentist (10:00 to 11:00) before the first booking of the day: a block that ends as the treatment begins is fine, and nothing is travelled from
select pg_temp.set_day(date '2031-07-14', 'flexible');
select pg_temp.book(date '2031-07-14', 1080); select pg_temp.block(date '2031-07-14', 600, 660, 'Dentist');
select is(pg_temp.times(date '2031-07-14'), pg_temp.range(660, 960), 'Flexible: a treatment may start as a block ends when it is the first of the day, there is no travel into it from another appointment');

-- ---------------------------------------------------------------------------------------------
-- A client who is part-way through booking, and a booking that is being moved
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_day(date '2031-07-15', 'flexible');
insert into public.booking_holds(id, client_id, date, start_minutes, treatment_duration_minutes, expires_at, status)
values ('00000000-0000-4000-8000-00000000e501', '00000000-0000-4000-8000-00000000e401', date '2031-07-15', 900, 60, timestamptz '2031-12-31 00:00:00+00', 'active');
select is(pg_temp.times(date '2031-07-15'), pg_temp.range(600, 780) || pg_temp.range(1020, 1140), 'A time a client is holding counts as an appointment on a flexible day');
select pg_temp.set_day(date '2031-07-16', 'flexible');
insert into public.booking_holds(id, client_id, date, start_minutes, treatment_duration_minutes, expires_at, status)
values ('00000000-0000-4000-8000-00000000e502', '00000000-0000-4000-8000-00000000e401', date '2031-07-16', 900, 60, timestamptz '2030-12-31 00:00:00+00', 'active');
select is(pg_temp.times(date '2031-07-16'), pg_temp.range(600, 1140), 'A hold that has run out is not an appointment, so the day is empty');
select pg_temp.set_day(date '2031-07-17', 'flexible');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e601', date '2031-07-17', 900);
select is(pg_temp.times(date '2031-07-17', timestamptz '2031-01-01 00:00:00+00', 60, '00000000-0000-4000-8000-00000000e601'), pg_temp.range(600, 1140),
  'A booking being moved is not in its own way: without it the day is empty');

-- ---------------------------------------------------------------------------------------------
-- An empty flexible day still follows the first appointment and its release time
-- ---------------------------------------------------------------------------------------------
select pg_temp.set_day(date '2031-07-21', 'flexible', 'fixed', 900, null);
select is(pg_temp.times(date '2031-07-21'), array[900], 'An empty flexible day with a first appointment at a set time offers only that time');
select pg_temp.set_day(date '2031-07-22', 'flexible', 'fixed', 900, null);
select pg_temp.book(date '2031-07-22', 900);
select is(pg_temp.times(date '2031-07-22'), pg_temp.range(600, 780) || pg_temp.range(1020, 1140), 'Once someone has booked, the flexible day opens to every time with room for travel');
select pg_temp.set_day(date '2031-07-23', 'flexible', 'fixed', 900, 1020);
select is(pg_temp.times(date '2031-07-23', timestamptz '2031-07-22 16:59:00+01'), array[900], 'Before the release time the empty flexible day still offers only its first appointment');
select is(pg_temp.times(date '2031-07-23', timestamptz '2031-07-22 17:00:00+01'), pg_temp.range(600, 1140), 'And at the release time it opens to every usual time');

-- The travel time is the one passed in, not always an hour
select pg_temp.set_day(date '2031-07-28', 'flexible');
select pg_temp.book(date '2031-07-28', 900);
select is(pg_temp.times(date '2031-07-28', timestamptz '2031-01-01 00:00:00+00', 30), pg_temp.range(600, 810) || pg_temp.range(990, 1140), 'With half an hour of travel the room either side of the booking is half an hour');

-- ---------------------------------------------------------------------------------------------
-- The usual week, and a special day replacing it
-- ---------------------------------------------------------------------------------------------
update public.working_hours set available = true, start_minutes = 600, end_minutes = 1200, start_mode = 'flexible', fixed_start_minutes = null, anchor_release_minutes = null, schedule_mode = 'flexible' where weekday = 3;
update public.working_hours set available = true, start_minutes = 600, end_minutes = 1200, start_mode = 'flexible', fixed_start_minutes = null, anchor_release_minutes = null, schedule_mode = 'chain' where weekday = 4;
select pg_temp.book(date '2031-08-06', 900);   -- a Wednesday with no special day
select is(pg_temp.times(date '2031-08-06'), pg_temp.range(600, 780) || pg_temp.range(1020, 1140), 'A Wednesday follows the usual week, which is flexible');
select pg_temp.set_day(date '2031-08-13', 'chain');   -- a Wednesday with a special day
select pg_temp.book(date '2031-08-13', 900);
select is(pg_temp.times(date '2031-08-13'), array[780, 1020], 'A special day replaces the usual week''s mode, so a chain special day on a flexible Wednesday is a chain day');
select pg_temp.set_day(date '2031-08-07', 'flexible');   -- a Thursday with a special day
select pg_temp.book(date '2031-08-07', 900);
select is(pg_temp.times(date '2031-08-07'), pg_temp.range(600, 780) || pg_temp.range(1020, 1140), 'And a flexible special day on a chain Thursday is a flexible day');
select pg_temp.book(date '2031-08-14', 900);   -- a Thursday with no special day
select is(pg_temp.times(date '2031-08-14'), array[780, 1020], 'A Thursday with no special day follows the usual week, which is chain');

-- ---------------------------------------------------------------------------------------------
-- What the tables accept
-- ---------------------------------------------------------------------------------------------
select throws_ok($$insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, schedule_mode) values (date '2031-09-01', true, 600, 1200, 'flexible', 'loose')$$,
  '23514', null, 'A schedule mode has to be chain or flexible (special day)');
select throws_ok($$update public.working_hours set schedule_mode = 'loose' where weekday = 3$$, '23514', null, 'A schedule mode has to be chain or flexible (usual week)');
select lives_ok($$insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, schedule_mode) values (date '2031-09-02', true, 600, 1200, 'flexible', 'flexible')$$, 'Flexible is accepted (special day)');
select lives_ok($$update public.working_hours set schedule_mode = 'chain' where weekday = 3$$, 'Chain is accepted (usual week)');

select * from finish();
rollback;
