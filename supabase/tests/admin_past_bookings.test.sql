begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- An Admin, someone who is not, two clients with an address and an email each, one treatment and one area.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000d901', 'authenticated', 'authenticated', 'past-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000d902', 'authenticated', 'authenticated', 'past-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d901');
insert into public.clients(id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000d911', 'Pia', 'Past', 'pia.past@example.test'),
  ('00000000-0000-4000-8000-00000000d915', 'Cam', 'Counted', 'cam.counted@example.test');
insert into public.client_addresses(id, client_id, address_line_1, city, postcode, is_default) values
  ('00000000-0000-4000-8000-00000000d912', '00000000-0000-4000-8000-00000000d911', '2 Test Street', 'London', 'SW3 1AB', true),
  ('00000000-0000-4000-8000-00000000d916', '00000000-0000-4000-8000-00000000d915', '3 Test Street', 'London', 'SW3 1AC', true);
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000d913', 'past-bookings-treatment', 'Past bookings treatment', true, 991);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active)
values ('00000000-0000-4000-8000-00000000d913', 60, 85, true), ('00000000-0000-4000-8000-00000000d913', 90, 115, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order)
values ('00000000-0000-4000-8000-00000000d914', 'past-bookings-area', 'Past bookings area', true, 12, 0, 991);

create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
create function pg_temp.as_admin() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d901","role":"authenticated"}', true); $$;
-- The way a booking is asked for: how many days from today (negative is the past), the start, whether it is "past", how it is paid, how long, for whom.
create function pg_temp.request(p_offset integer, p_start integer, p_past boolean default null, p_payment text default 'bank_received', p_minutes integer default 60,
  p_client uuid default '00000000-0000-4000-8000-00000000d911', p_address uuid default '00000000-0000-4000-8000-00000000d912') returns jsonb language sql as $$
  select jsonb_build_object('client_id', p_client, 'saved_address_id', p_address, 'service_area_id', '00000000-0000-4000-8000-00000000d914',
    'sessions', jsonb_build_array(jsonb_build_object('service_id', '00000000-0000-4000-8000-00000000d913', 'duration_minutes', p_minutes, 'recipient_name', 'Pia')),
    'enhancement_ids', '[]'::jsonb, 'date', pg_temp.day(p_offset), 'start_minutes', p_start, 'payment_arrangement', p_payment)
  || case when p_past is null then '{}'::jsonb else jsonb_build_object('past', p_past) end;
$$;
-- An appointment put straight into the diary, for the checks on what a day's list shows.
create function pg_temp.appointment(p_offset integer, p_start integer, p_minutes integer default 60, p_status text default 'completed') returns void language sql as $$
  insert into public.bookings(booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, total_gbp)
  select 'PST-' || gen_random_uuid(), '00000000-0000-4000-8000-00000000d911', a.id, pg_temp.day(p_offset), p_start, p_minutes, p_status, 'test',
    '2 Test Street', 'London', 'SW3 1AB', a.name, 85, 85 from public.service_areas a where a.id = '00000000-0000-4000-8000-00000000d914';
$$;
-- What the Admin's cancel and move commands need to know about a booking: when it and its payment were last changed.
create function pg_temp.bv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = $1; $$;
create function pg_temp.pv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.booking_payments where booking_id = $1; $$;
create function pg_temp.working(p_offset integer, p_open boolean, p_from integer, p_to integer) returns void language sql as $$
  insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes)
  values (pg_temp.day(p_offset), p_open, case when p_open then p_from end, case when p_open then p_to end, 'flexible', null)
  on conflict (date) do update set available = excluded.available, start_minutes = excluded.start_minutes, end_minutes = excluded.end_minutes, start_mode = 'flexible', fixed_start_minutes = null;
$$;
-- Days 30 and 31 ahead are ordinary working days (for the checks that a booking made as before is unchanged, and a move to the future); five days ago was a day off.
select pg_temp.working(30, true, 480, 1200);
select pg_temp.working(31, true, 480, 1200);
select pg_temp.working(-5, false, null, null);
-- The half hour that has just begun, in London (kept so that an hour's appointment from it still ends by midnight). The database sits on UTC and
-- London is an hour ahead in summer, so a check that forgot the time zone would be an hour out for part of every day.
create function pg_temp.cur() returns integer language sql as $$
  select least((floor((extract(hour from (clock_timestamp() at time zone 'Europe/London')) * 60 + extract(minute from (clock_timestamp() at time zone 'Europe/London'))) / 30) * 30)::integer, 1380);
$$;
-- A start on today that an hour's appointment from the half hour that has just begun can never overlap, whatever the hour (for the time a client holds).
create function pg_temp.hold_start() returns integer language sql as $$ select case when pg_temp.cur() >= 720 then 360 else 1320 end; $$;

-- ---------------------------------------------------------------------------------------------
-- Who may ask
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'admin_past_booking_times', array['date', 'integer']);
select ok(not has_function_privilege('anon', 'public.admin_past_booking_times(date,integer)', 'EXECUTE'), 'Anonymous callers cannot ask for the times of a past day');
select ok(has_function_privilege('authenticated', 'public.admin_past_booking_times(date,integer)', 'EXECUTE'), 'A signed-in caller can (and is then checked as the Admin)');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_past_booking_times', 'admin_create_booking', 'admin_create_series', 'plan_event_notifications')
    and not coalesce(p.prosecdef and p.proconfig @> array['search_path=""'], false)), 'These are definers with an empty search path');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d902","role":"authenticated"}', true);
select throws_ok($$select public.admin_past_booking_times(pg_temp.day(-3), 60)$$, '42501', 'Admin authorization required', 'Someone who is not the Admin is refused');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d901","role":"authenticated","is_anonymous":true}', true);
select throws_ok($$select public.admin_past_booking_times(pg_temp.day(-3), 60)$$, '42501', 'Admin authorization required', 'A guest session is refused');
select pg_temp.as_admin();
select throws_ok($$select public.admin_past_booking_times(pg_temp.day(-3), 45)$$, '22023', 'Booking duration is invalid', 'An odd length is refused');
select throws_ok($$select public.admin_past_booking_times(pg_temp.day(1), 60)$$, '22023', 'Choose a date within the last 365 days', 'A day that has not come yet is refused');
select throws_ok($$select public.admin_past_booking_times(pg_temp.day(-366), 60)$$, '22023', 'Choose a date within the last 365 days', 'More than a year back is refused');
select lives_ok($$select public.admin_past_booking_times(pg_temp.day(-365), 60)$$, 'A year back is fine');
select lives_ok($$select public.admin_past_booking_times(pg_temp.day(0), 60)$$, 'So is today');
select throws_ok($$select public.admin_booking_times(pg_temp.day(-3), 60)$$, '22023', 'Choose a date within the next 365 days', 'The list for new bookings still refuses a day that has gone');

-- ---------------------------------------------------------------------------------------------
-- The times of a past day: day -3 has one appointment, 10:00 to 11:00
-- ---------------------------------------------------------------------------------------------
select pg_temp.appointment(-3, 600);
create temporary table t_day as select public.admin_past_booking_times(pg_temp.day(-3), 60) as j;
create function pg_temp.slot(p_start integer) returns jsonb language sql as $$ select s from t_day, jsonb_array_elements(j->'slots') s where (s->>'start')::integer = p_start; $$;
select is((select jsonb_array_length(j->'booked') from t_day), 1, 'It lists what was in the diary that day');
select results_eq($$select (j->'booked'->0->>'start')::integer, (j->'booked'->0->>'end')::integer, j->'booked'->0->>'label', j->'booked'->0->>'kind' from t_day$$,
  $$values (600, 660, 'Pia Past'::text, 'booking'::text)$$, 'With its start, end and who it was for');
select is((pg_temp.slot(600)->>'clash')::boolean, true, '10:00 overlaps the appointment');
select is((pg_temp.slot(570)->>'clash')::boolean, true, 'So does 09:30');
select is((pg_temp.slot(540)->>'clash')::boolean, false, '09:00 ends as it starts: no overlap');
select is((pg_temp.slot(660)->>'clash')::boolean, false, 'And 11:00 starts as it ends: no overlap');
select ok((select bool_and(not (s->>'usual')::boolean) from t_day, jsonb_array_elements(j->'slots') s), 'No time on a day that has gone is a usual time');
select ok(pg_temp.slot(360) is not null and pg_temp.slot(1380) is not null and pg_temp.slot(330) is null and pg_temp.slot(1410) is null, 'The day runs from 06:00 to the last hour that can finish by midnight');
select is((select jsonb_array_length(j->'slots') from t_day), 35, 'Every half hour of it');
select is((public.admin_past_booking_times(pg_temp.day(-5), 60)->'working'->>'open')::boolean, false, 'A day that was a day off says so');
select ok((select count(*) > 20 from jsonb_array_elements(public.admin_past_booking_times(pg_temp.day(-5), 60)->'slots')), 'and still lists its times');
select ok(not exists (
  select 1 from jsonb_array_elements(public.admin_past_booking_times(pg_temp.day(0), 60)->'slots') s
  where (pg_temp.day(0) + make_interval(mins => (s->>'start')::integer)) at time zone 'Europe/London' > clock_timestamp()), 'Today lists only times that have already begun');
select is((select coalesce(max((s->>'start')::integer), -1) from jsonb_array_elements(public.admin_past_booking_times(pg_temp.day(0), 60)->'slots') s),
  case when pg_temp.cur() >= 360 then pg_temp.cur() else -1 end,
  'and lists them right up to the half hour that has just begun (nothing at all before 06:00)');

-- ---------------------------------------------------------------------------------------------
-- Recording an appointment that has already happened, and paid for
-- ---------------------------------------------------------------------------------------------
create temporary table t_bank as select * from public.admin_create_booking(pg_temp.request(-2, 600, true, 'bank_received'), '00000000-0000-4000-8000-00000000d921');
select results_eq($$select booking_status, payment_status from t_bank$$, $$values ('completed'::text, 'paid'::text)$$, 'Paid by bank transfer, it is recorded as completed');
select results_eq($$select b.booking_status, b.date = pg_temp.day(-2), b.start_minutes, b.created_by_actor_type from public.bookings b join t_bank t on t.booking_id = b.id$$,
  $$values ('completed'::text, true, 600, 'admin'::text)$$, 'On the day and time given, made by the Admin');
select results_eq($$select p.method, p.status, p.paid_at is not null, p.verified_at is not null, p.verified_by from public.booking_payments p join t_bank t on t.booking_id = p.booking_id$$,
  $$values ('bank_transfer'::text, 'paid'::text, true, true, '00000000-0000-0000-0000-00000000d901'::uuid)$$, 'The payment is paid and verified, and by whom');
select results_eq($$select (p.paid_at at time zone 'Europe/London') = (pg_temp.day(-2)::timestamp + interval '10 hours'), p.verified_at > p.paid_at, p.verified_at <= clock_timestamp()
  from public.booking_payments p join t_bank t on t.booking_id = p.booking_id$$, $$values (true, true, true)$$,
  'It is dated the day and time of the appointment, so a receipt for it reads right, while the Admin''s check of it is dated when she recorded it');
select results_eq($$select from_status, to_status from public.booking_status_events e join t_bank t on t.booking_id = e.booking_id where e.entity = 'booking' order by e.occurred_at, e.id$$,
  $$values (null::text, 'confirmed'::text), ('confirmed'::text, 'completed'::text)$$, 'The history shows it made confirmed and then completed, through the one step the guard allows');
select results_eq($$select e.event_type, (e.payload->>'past')::boolean from public.event_outbox e join t_bank t on t.booking_id = e.aggregate_id order by e.event_type$$,
  $$values ('booking.completed'::text, null::boolean), ('booking.created'::text, true)$$, 'The events say it was created as a past booking, and that it was completed');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id join t_bank t on t.booking_id = e.aggregate_id), 0,
  'Nobody is emailed or alerted about it, the client or the Admin');
select is((select booking_id from public.admin_create_booking(pg_temp.request(-2, 600, true, 'bank_received'), '00000000-0000-4000-8000-00000000d921')), (select booking_id from t_bank),
  'Sending the same request again answers with the same booking');
select is((select count(*)::integer from public.event_outbox e join t_bank t on t.booking_id = e.aggregate_id), 2, 'and does not make its events twice');
create temporary table t_cash as select * from public.admin_create_booking(pg_temp.request(-4, 600, true, 'cash_received'), '00000000-0000-4000-8000-00000000d922');
select results_eq($$select b.booking_status, p.method, p.status from t_cash t join public.bookings b on b.id = t.booking_id join public.booking_payments p on p.booking_id = b.id$$,
  $$values ('completed'::text, 'cash'::text, 'paid'::text)$$, 'Paid in cash is completed too');
select results_eq($$select (p.paid_at at time zone 'Europe/London') = (pg_temp.day(-4)::timestamp + interval '10 hours'), p.verified_at is null from public.booking_payments p join t_cash t on t.booking_id = p.booking_id$$,
  $$values (true, true)$$, 'and dated the day of the appointment as well (cash is not "verified" by anyone, as before)');

-- ---------------------------------------------------------------------------------------------
-- Not paid yet: it stays confirmed
-- ---------------------------------------------------------------------------------------------
create temporary table t_unpaid as select * from public.admin_create_booking(pg_temp.request(-6, 600, true, 'bank_pending'), '00000000-0000-4000-8000-00000000d923');
select results_eq($$select b.booking_status, p.method, p.status from t_unpaid t join public.bookings b on b.id = t.booking_id join public.booking_payments p on p.booking_id = b.id$$,
  $$values ('confirmed'::text, 'bank_transfer'::text, 'awaiting_transfer'::text)$$, 'Not paid yet, it stays confirmed with the payment waiting');
select is((select count(*)::integer from public.event_outbox e join t_unpaid t on t.booking_id = e.aggregate_id where e.event_type = 'booking.completed'), 0, 'and is not completed');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id join t_unpaid t on t.booking_id = e.aggregate_id), 0, 'No email or alert for it either');
-- Not paid yet, but to be paid in cash: the cash is waiting, so when it comes it is recorded as cash.
create temporary table t_cash_unpaid as select * from public.admin_create_booking(pg_temp.request(-8, 600, true, 'cash_appointment'), '00000000-0000-4000-8000-00000000d924');
select results_eq($$select b.booking_status, p.method, p.status from t_cash_unpaid t join public.bookings b on b.id = t.booking_id join public.booking_payments p on p.booking_id = b.id$$,
  $$values ('confirmed'::text, 'cash'::text, 'approved'::text)$$, 'Not paid yet, to be paid in cash, stays confirmed with the cash waiting');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id join t_cash_unpaid t on t.booking_id = e.aggregate_id), 0, 'and nobody is told about it');

-- ---------------------------------------------------------------------------------------------
-- What happens to it afterwards, while it is still in the past, is not announced to the client either: they were never told it existed
-- ---------------------------------------------------------------------------------------------
select public.admin_cancel_booking((select booking_id from t_cash_unpaid), gen_random_uuid(), pg_temp.bv((select booking_id from t_cash_unpaid)),
  pg_temp.pv((select booking_id from t_cash_unpaid)), 'Recorded by mistake', 'admin');
select is((select b.booking_status from public.bookings b join t_cash_unpaid t on t.booking_id = b.id), 'cancelled', 'One recorded by mistake and not paid can be cancelled again');
select is((select count(*)::integer from public.event_outbox e join t_cash_unpaid t on t.booking_id = e.aggregate_id where e.event_type = 'booking.cancelled'), 1, 'the cancellation itself is recorded');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id join t_cash_unpaid t on t.booking_id = e.aggregate_id), 0,
  'but the client is not emailed that it was cancelled, because they never knew of it');
-- Moved to a time still to come, it is an appointment the client should hear about.
create temporary table t_moved as select * from public.admin_create_booking(pg_temp.request(-9, 600, true, 'bank_pending'), '00000000-0000-4000-8000-00000000d925');
select public.admin_reschedule_booking((select booking_id from t_moved), gen_random_uuid(), pg_temp.bv((select booking_id from t_moved)), pg_temp.day(31),
  (select min(a.start_minutes) from public.compute_booking_availability(pg_temp.day(31), 60, clock_timestamp(), 60, null, null) a), 'admin');
select results_eq($$select d.audience, d.channel, d.title from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id join t_moved t on t.booking_id = e.aggregate_id$$,
  $$values ('client'::text, 'email'::text, 'Your appointment has moved'::text)$$, 'Moved to a time still to come, the client is told, as for any appointment');

-- ---------------------------------------------------------------------------------------------
-- What she can and cannot record
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.admin_create_booking(pg_temp.request(1, 600, true), gen_random_uuid())$$, '22023',
  'That time has not happened yet. Turn off "It has already happened" to book it.', 'A time that has not come is not recorded as past');
select throws_ok($$select public.admin_create_booking(pg_temp.request(-366, 600, true), gen_random_uuid())$$, '22023', 'Choose a date within the last 365 days', 'More than a year back is refused');
select lives_ok($$select public.admin_create_booking(pg_temp.request(-365, 600, true), gen_random_uuid())$$, 'A year back is fine');
select throws_ok($$select public.admin_create_booking(pg_temp.request(-2, 1410, true), gen_random_uuid())$$, '22023', 'That appointment would run past midnight. Choose an earlier time.', 'A past appointment cannot run past midnight');
select lives_ok($$select public.admin_create_booking(pg_temp.request(-2, 1380, true), gen_random_uuid())$$, 'but one that ends at midnight is fine');
select throws_ok($$select public.admin_create_booking(pg_temp.request(-2, 600, true) || '{"any_time": true}', gen_random_uuid())$$, '22023', 'Unsupported booking fields', 'Past and any time are different things');
select throws_ok($$select public.admin_create_booking(pg_temp.request(-2, 780, true) || '{"past": "yes"}', gen_random_uuid())$$, '22023', 'Unsupported booking fields', 'It has to be yes or no');
select throws_ok($$select public.admin_create_booking(pg_temp.request(-2, 570, true), gen_random_uuid())$$, 'PT409',
  'That time overlaps another appointment, so it cannot be recorded. Choose another time.', 'Never on top of another appointment (09:30 overlaps the 10:00 one)');
select lives_ok($$select public.admin_create_booking(pg_temp.request(-2, 660, true), gen_random_uuid())$$, 'Straight after one is fine');
select lives_ok($$select public.admin_create_booking(pg_temp.request(-5, 600, true), gen_random_uuid())$$, 'A day that was a day off can be recorded: working hours do not apply to what has happened');
insert into public.calendar_blocks(kind, date, start_minutes, end_minutes, title) values ('personal_event', pg_temp.day(-7), 600, 660, 'Dentist');
select lives_ok($$select public.admin_create_booking(pg_temp.request(-7, 600, true), gen_random_uuid())$$, 'and so can a time that was blocked');
select throws_ok($$select public.admin_create_series(pg_temp.request(-9, 600, true), null, gen_random_uuid())$$, '22023', 'A repeat cannot start with an appointment that has already happened', 'A repeating booking is never started in the past');
-- Today. A client who is part-way through booking holds a time: recording a past appointment today waits, as unusual times do.
insert into public.booking_holds(id, date, start_minutes, treatment_duration_minutes, status, expires_at, client_key)
values ('00000000-0000-4000-8000-00000000d931', pg_temp.day(0), pg_temp.hold_start(), 60, 'active', clock_timestamp() + interval '10 minutes', 'past-bookings-test-hold-0001');
select throws_ok($$select public.admin_create_booking(pg_temp.request(0, pg_temp.cur(), true), gen_random_uuid())$$, 'PT409', 'A client is in the middle of booking that day. Try again in a few minutes.',
  'While a client is booking that day it waits a few minutes');
select is((public.admin_past_booking_times(pg_temp.day(0), 60)->>'client_booking')::boolean, true, 'and the list of that day says a client is booking');
select results_eq($$select (b->>'start')::integer, (b->>'end')::integer, b->>'label', b->>'kind' from jsonb_array_elements(public.admin_past_booking_times(pg_temp.day(0), 60)->'booked') b where (b->>'start')::integer = pg_temp.hold_start()$$,
  $$values (pg_temp.hold_start(), pg_temp.hold_start() + 60, null::text, 'hold'::text)$$, 'and lists the time held for them, as a hold with no name');
update public.booking_holds set expires_at = clock_timestamp() - interval '1 minute' where id = '00000000-0000-4000-8000-00000000d931';
select is((public.admin_past_booking_times(pg_temp.day(0), 60)->>'client_booking')::boolean, false, 'Once the hold has expired the list no longer says so');
-- What has begun can be recorded and what has not cannot, whatever the hour: the half hour that has just begun goes through, the next one is refused.
-- (The database sits on UTC and London is an hour ahead in summer, so a check that forgot the time zone would be wrong for an hour or more of every day.)
select case when pg_temp.cur() + 30 <= 1380
  then throws_ok($$select public.admin_create_booking(pg_temp.request(0, pg_temp.cur() + 30, true), gen_random_uuid())$$, '22023',
    'That time has not happened yet. Turn off "It has already happened" to book it.', 'The next half hour has not begun, so it cannot be recorded as past')
  else skip(1, 'after 23:00 there is no later half hour that fits in the day') end;
select lives_ok($$select public.admin_create_booking(pg_temp.request(0, pg_temp.cur(), true), gen_random_uuid())$$, 'The half hour that has just begun can be recorded (once the hold has expired)');
select ok((select p.paid_at <= clock_timestamp() and p.paid_at >= clock_timestamp() - interval '2 days' from public.booking_payments p join public.bookings b on b.id = p.booking_id
  where b.date = pg_temp.day(0) and p.status = 'paid'), 'One paid and recorded for earlier today is dated at its own time, never in the future');

-- ---------------------------------------------------------------------------------------------
-- Everything made as before is as before
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.admin_create_booking(pg_temp.request(-3, 780), gen_random_uuid())$$, '22023', 'Choose a date within the next 365 days',
  'Without "past" a day that has gone is refused exactly as before');
select throws_ok($$select public.admin_create_booking(pg_temp.request(0, 0), gen_random_uuid())$$, 'PT409', 'This time is no longer available. Choose another time.',
  'and so is a time earlier today');
select throws_ok($$select public.admin_create_booking(pg_temp.request(0, 0) || '{"any_time": true}', gen_random_uuid())$$, 'PT409', 'That time is in the past. Choose another time.', 'and so is one from the unusual-times list');
create temporary table t_future as select * from public.admin_create_booking(pg_temp.request(30, (select min(a.start_minutes) from public.admin_booking_availability(pg_temp.day(30), 60) a), null, 'bank_pending'), gen_random_uuid());
select results_eq($$select booking_status, payment_status from t_future$$, $$values ('confirmed'::text, 'awaiting_transfer'::text)$$, 'A booking for the future is confirmed as before');
select results_eq($$select d.title, d.audience, d.channel from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id join t_future t on t.booking_id = e.aggregate_id$$,
  $$values ('Your appointment is booked'::text, 'client'::text, 'email'::text)$$, 'and the client is emailed, as before');
select is((select e.payload ? 'past' from public.event_outbox e join t_future t on t.booking_id = e.aggregate_id where e.event_type = 'booking.created'), false, 'The event of a booking for the future has no "past" in it');
create temporary table t_future_cash as select * from public.admin_create_booking(pg_temp.request(31, (select min(a.start_minutes) from public.admin_booking_availability(pg_temp.day(31), 60) a), null, 'cash_received'), gen_random_uuid());
select ok((select abs(extract(epoch from (p.paid_at - clock_timestamp()))) < 120 from public.booking_payments p join t_future_cash t on t.booking_id = p.booking_id),
  'A booking for the future that is paid is dated now, as before (only something that has already happened is dated the day of the appointment)');
-- Only one recorded after the fact is kept quiet. One made in the usual way that has since begun (and was never completed) is announced as before.
update public.bookings set date = pg_temp.day(-20) where id = (select booking_id from t_future);
select public.admin_cancel_booking((select booking_id from t_future), gen_random_uuid(), pg_temp.bv((select booking_id from t_future)), pg_temp.pv((select booking_id from t_future)), 'Did not go ahead', 'admin');
select results_eq($$select d.title, d.channel from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id join t_future t on t.booking_id = e.aggregate_id
    where e.event_type = 'booking.cancelled' and d.audience = 'client'$$,
  $$values ('Your appointment has been cancelled'::text, 'email'::text)$$, 'An appointment made in the usual way that has since begun still tells the client when it is cancelled, as before');

-- ---------------------------------------------------------------------------------------------
-- It counts: a visit, what was paid, and a receipt. Cam has two paid appointments and one not paid yet.
-- ---------------------------------------------------------------------------------------------
select public.admin_create_booking(pg_temp.request(-10, 600, true, 'bank_received', 60, '00000000-0000-4000-8000-00000000d915', '00000000-0000-4000-8000-00000000d916'), gen_random_uuid());
select public.admin_create_booking(pg_temp.request(-12, 720, true, 'cash_received', 60, '00000000-0000-4000-8000-00000000d915', '00000000-0000-4000-8000-00000000d916'), gen_random_uuid());
select public.admin_create_booking(pg_temp.request(-14, 600, true, 'bank_pending', 60, '00000000-0000-4000-8000-00000000d915', '00000000-0000-4000-8000-00000000d916'), gen_random_uuid());
create temporary table t_summary as select public.admin_client_summary('00000000-0000-4000-8000-00000000d915') s;
select is((select (s->>'completed_visits')::integer from t_summary), 2, 'The two recorded as paid are two visits for the client, and the unpaid one is not');
select is((select (s->>'paid_gbp')::numeric from t_summary), (select sum(b.total_gbp) from public.bookings b where b.client_id = '00000000-0000-4000-8000-00000000d915' and b.booking_status = 'completed'),
  'and what they paid is counted');
select is((select (s->>'last_visit')::date from t_summary), pg_temp.day(-10), 'The last visit is the later of the two');
select is((select (s->>'upcoming')::integer from t_summary), 0, 'None of them is upcoming');
select lives_ok($$select public.admin_save_receipt_details('{"name":"VadMassage","phone":"07700 900123"}')$$, 'Her receipt details are saved');
select lives_ok($$select public.admin_issue_receipt((select b.id from public.bookings b where b.client_id = '00000000-0000-4000-8000-00000000d915' and b.booking_status = 'completed' order by b.date desc limit 1))$$,
  'A booking recorded as completed and paid can have a receipt');
select throws_ok($$select public.admin_issue_receipt((select b.id from public.bookings b where b.client_id = '00000000-0000-4000-8000-00000000d915' and b.booking_status = 'confirmed' limit 1))$$, 'PT409', null,
  'and the one not paid yet cannot');

select * from finish();
rollback;
