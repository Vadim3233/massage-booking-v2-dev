begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(20);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000d101', 'authenticated', 'authenticated', 'sched-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000d102', 'authenticated', 'authenticated', 'sched-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d101');
insert into public.clients(id, first_name, last_name) values
  ('00000000-0000-4000-8000-00000000d201', 'Sasha', 'Schedule'),
  ('00000000-0000-4000-8000-00000000d202', 'Pat', 'Person');

create function pg_temp.booking(p_id uuid, p_client uuid, p_status text, p_start integer, p_minutes integer) returns void language sql as $$
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, travel_buffer_minutes,
    cancelled_at)
  select p_id, 'SCHED-' || p_id, p_client, id, date '2031-07-07', p_start, p_minutes, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85, 60, case when p_status = 'cancelled' then now() end
  from public.service_areas where slug = 'chelsea';
$$;

-- Bookings on one day: 10:00-11:00 confirmed, 14:00-15:30 pending, 17:00-18:00 cancelled, 19:00-20:00 completed.
select pg_temp.booking('00000000-0000-4000-8000-00000000d301', '00000000-0000-4000-8000-00000000d201', 'confirmed', 600, 60);
select pg_temp.booking('00000000-0000-4000-8000-00000000d302', '00000000-0000-4000-8000-00000000d202', 'awaiting_transfer', 840, 90);
select pg_temp.booking('00000000-0000-4000-8000-00000000d303', '00000000-0000-4000-8000-00000000d201', 'cancelled', 1020, 60);
select pg_temp.booking('00000000-0000-4000-8000-00000000d304', '00000000-0000-4000-8000-00000000d201', 'completed', 1140, 60);

select ok(not has_function_privilege('anon', 'public.admin_schedule_conflicts(date,integer,integer)', 'EXECUTE'), 'Anonymous callers cannot check conflicts');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where proname = 'admin_schedule_conflicts' and pronamespace = 'public'::regnamespace), 'The check is a definer with an empty search path');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d102","role":"authenticated"}', true);
select throws_ok($$select * from public.admin_schedule_conflicts(date '2031-07-07', 0, 1440)$$, '42501', 'Admin authorization required', 'A client cannot see other people''s bookings through it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d101","role":"authenticated"}', true);

select results_eq($$select client_name, start_minutes, booking_status from public.admin_schedule_conflicts(date '2031-07-07', 0, 1440)$$,
  $$values ('Sasha Schedule'::text, 600, 'confirmed'::text), ('Pat Person', 840, 'awaiting_transfer')$$, 'A whole day clashes with live bookings only, with the client named');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-07', 1020, 1080)), 0, 'A cancelled booking never clashes');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-07', 1140, 1200)), 0, 'A completed booking never clashes');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-07', 660, 720)), 1, 'Time right after a booking clashes, because travel time counts');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-07', 720, 780)), 0, 'Time clear of the booking and its travel allowance does not clash');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-07', 480, 600)), 1, 'Time running into the travel allowance before a booking clashes');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-07', 360, 480)), 0, 'Time well before does not clash');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-08', 0, 1440)), 0, 'Another day is empty');
select is((select count(*)::integer from public.admin_schedule_conflicts(date '2031-07-06', 0, 1440)), 0, 'A day before has no clash from the following day''s bookings') ;
select throws_ok($$select * from public.admin_schedule_conflicts(null, 0, 60)$$, '22023', 'Choose a valid date and time range', 'A missing date is refused');
select throws_ok($$select * from public.admin_schedule_conflicts(date '2031-07-07', 600, 600)$$, '22023', 'Choose a valid date and time range', 'An empty range is refused');
select throws_ok($$select * from public.admin_schedule_conflicts(date '2031-07-07', 0, 1441)$$, '22023', 'Choose a valid date and time range', 'A range past midnight is refused');
reset role;
set local role anon;
select throws_ok($$select * from public.admin_schedule_conflicts(date '2031-07-07', 0, 1440)$$, '42501', 'permission denied for function admin_schedule_conflicts', 'The anonymous role is refused');
reset role;

-- The Admin can edit her own schedule directly; nobody else can.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d101","role":"authenticated"}', true);
select lives_ok($$insert into public.calendar_blocks(kind, date, start_minutes, end_minutes, title) values ('personal_event', date '2031-07-09', 600, 660, 'Dentist')$$, 'The Admin can add a personal event');
select lives_ok($$insert into public.working_hours_overrides(date, available) values (date '2031-07-10', false)$$, 'The Admin can mark a day off');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d102","role":"authenticated"}', true);
select throws_ok($$insert into public.calendar_blocks(kind, date, start_minutes, end_minutes) values ('blocked', date '2031-07-09', 600, 660)$$, '42501', null, 'A client cannot block the Admin''s calendar');
update public.working_hours set available = false;
reset role;
select ok((select count(*) from public.working_hours where available) > 0, 'A client''s attempt to switch off every working day changes nothing');
reset role;

select * from finish();
rollback;
