begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

select ok(not has_function_privilege('anon', 'public.admin_create_series(jsonb,date,uuid)', 'EXECUTE'), 'Anonymous callers cannot make a repeat');
select ok(not has_function_privilege('authenticated', 'public.run_series_maintenance()', 'EXECUTE'), 'Signed-in users cannot run the repeat job');
select ok(has_function_privilege('service_role', 'public.run_series_maintenance()', 'EXECUTE'), 'The server can run the repeat job');
select ok(not has_function_privilege('authenticated', 'public.series_create_occurrence(uuid,date,boolean)', 'EXECUTE'), 'Making a session is internal');
select ok(not has_table_privilege('authenticated', 'public.booking_series', 'SELECT,INSERT,UPDATE,DELETE'), 'The browser has no direct access to repeats');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('refresh_series_holds', 'series_create_occurrence', 'run_series_maintenance', 'admin_create_series', 'admin_client_series',
    'admin_set_series_status', 'admin_skip_series_date', 'admin_unskip_series_date', 'plan_series_notifications', 'series_booking_changed')), 'Every repeat function is a definer with an empty search path');

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000f601', 'authenticated', 'authenticated', 'series-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000f602', 'authenticated', 'authenticated', 'series-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f601');
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
  select (clock_timestamp() at time zone 'Europe/London')::date + d, true, 0, 1440, 'flexible' from generate_series(0, 400) d
  on conflict (date) do update set available = true, start_minutes = 0, end_minutes = 1440, start_mode = 'flexible', fixed_start_minutes = null;
insert into public.clients(id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000f611', 'Reggie', 'Regular', 'reggie.regular@example.test'),
  ('00000000-0000-4000-8000-00000000f612', 'Dana', 'Dated', 'dana.dated@example.test');
insert into public.client_addresses(id, client_id, address_line_1, city, postcode, is_default) values
  ('00000000-0000-4000-8000-00000000f621', '00000000-0000-4000-8000-00000000f611', '1 Weekly Walk', 'London', 'SW3 1AA', true),
  ('00000000-0000-4000-8000-00000000f622', '00000000-0000-4000-8000-00000000f612', '2 Dated Drive', 'London', 'SW3 1AB', true);

create function pg_temp.request(p_client uuid, p_address uuid, p_offset integer, p_start integer default 600, p_payment text default 'bank_pending') returns jsonb language sql as $$
  select jsonb_build_object('client_id', p_client, 'saved_address_id', p_address, 'service_area_id', (select id from public.service_areas where slug = 'chelsea'),
    'sessions', jsonb_build_array(jsonb_build_object('service_id', (select id from public.services where slug = 'massage'), 'duration_minutes', 60, 'recipient_name', 'Reggie')),
    'enhancement_ids', '[]'::jsonb, 'date', (clock_timestamp() at time zone 'Europe/London')::date + p_offset, 'start_minutes', p_start,
    'payment_arrangement', p_payment, 'note', 'Weekly regular');
$$;
create function pg_temp.today_plus(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
create function pg_temp.bv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = $1; $$;
create function pg_temp.pv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.booking_payments where booking_id = $1; $$;

-- A signed-in client who is not the Admin cannot make a repeat.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f602","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from public.admin_create_series(pg_temp.request('00000000-0000-4000-8000-00000000f611', '00000000-0000-4000-8000-00000000f621', 10), null, gen_random_uuid())$$,
  '42501', 'Admin authorization required', 'A client cannot make a repeat');
select throws_ok($$select public.admin_client_series('00000000-0000-4000-8000-00000000f611')$$, '42501', 'Admin authorization required', 'A client cannot read repeats');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
create temp table made as select * from public.admin_create_series(pg_temp.request('00000000-0000-4000-8000-00000000f611', '00000000-0000-4000-8000-00000000f621', 10), null, '00000000-0000-4000-8000-00000000f631');
grant select on made to authenticated;
reset role;
select is((select count(*)::integer from made), 1, 'The first booking and the repeat are made together');
select is((select series_id from public.bookings where id = (select booking_id from made)), (select series_id from made), 'The first booking belongs to the repeat');
select results_eq($$select weekday::integer, start_minutes, treatment_duration_minutes, status, end_date from public.booking_series where id = (select series_id from made)$$,
  $$values (extract(isodow from pg_temp.today_plus(10))::integer, 600, 60, 'active', null::date)$$, 'The repeat records the weekday, time and length');
select is((select request->>'payment_arrangement' from public.booking_series where id = (select series_id from made)), 'bank_pending', 'Later sessions ask for a bank transfer');
set local role authenticated;
select is((select series_id from public.admin_create_series(pg_temp.request('00000000-0000-4000-8000-00000000f611', '00000000-0000-4000-8000-00000000f621', 10), null, '00000000-0000-4000-8000-00000000f631')), (select series_id from made), 'Sending the same request again returns the same repeat');
reset role;
select is((select count(*)::integer from public.booking_series), 1, 'A retry does not make a second repeat');

-- The weekly slot is held for every later week, up to a year ahead, and not on the booked day.
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made) and kind = 'series_hold'), 50, 'The slot is held for the next 50 weeks');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made) and date = pg_temp.today_plus(10)), 0, 'The booked day is not also held');
select ok(exists (select 1 from public.calendar_blocks where series_id = (select series_id from made) and date = pg_temp.today_plus(17) and start_minutes = 600 and end_minutes = 660 and title = 'Held for Reggie Regular (repeat)'), 'A hold covers the session time and names the client');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
select ok(not exists (select 1 from public.admin_booking_availability(pg_temp.today_plus(17), 60) a where a.start_minutes = 600), 'Nobody else is offered the held time');
select ok(exists (select 1 from public.admin_booking_availability(pg_temp.today_plus(17), 60) a where a.start_minutes = 840), 'Other times that day are still offered');
select ok(exists (select 1 from public.admin_booking_availability(pg_temp.today_plus(18), 60) a where a.start_minutes = 600), 'The same time on another weekday is still offered');
reset role;

-- The job makes no booking while the next session is far off, and is safe to repeat.
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'Nothing is due while the next session is more than a week away');

-- Widen the reminder window so the session in 17 days is due.
insert into public.business_settings(key, value) values ('series_payment_reminder_days', '20') on conflict (key) do update set value = '20';
select is((select public.run_series_maintenance()), '{"made": 1, "clashes": 0, "ended": 0}'::jsonb, 'The session now in the window is booked');
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'Running the job again makes nothing more');
select results_eq($$select b.booking_status, p.method, p.status, b.start_minutes, b.total_gbp > 0 from public.bookings b join public.booking_payments p on p.booking_id = b.id
    where b.series_id = (select series_id from made) and b.date = pg_temp.today_plus(17)$$,
  $$values ('confirmed'::text, 'bank_transfer'::text, 'awaiting_transfer'::text, 600, true)$$, 'The new session is booked, waiting for the bank transfer');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made) and date = pg_temp.today_plus(17)), 0, 'Its hold is released because the booking takes the slot');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
    where e.event_type = 'booking.series_due' and d.audience = 'client' and d.recipient = 'reggie.regular@example.test' and d.title = 'Time to pay for your next appointment'), 1, 'The client is asked to pay');
select ok((select d.body like '%bank transfer%' and d.body like '%booking page%' and d.body like '%more than 24 hours%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
    where e.event_type = 'booking.series_due' and d.audience = 'client'), 'The message explains how to pay and the free cancellation window');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
    where e.event_type = 'booking.series_due' and d.audience = 'admin' and d.recipient = 'admin-series'
      and e.aggregate_id in (select id from public.bookings where series_id = (select series_id from made))), 3, 'The Admin hears about it in the app, Telegram and email');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
    join public.bookings b on b.id = e.aggregate_id where e.event_type = 'booking.created' and b.series_id = (select series_id from made) and b.date = pg_temp.today_plus(17)), 0, 'The session is not also announced as an ordinary new booking');

-- A cancelled session is released and never made again.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_cancel_booking((select id from public.bookings where series_id = (select series_id from made) and date = pg_temp.today_plus(17)), gen_random_uuid(),
    pg_temp.bv((select id from public.bookings where series_id = (select series_id from made) and date = pg_temp.today_plus(17))),
    pg_temp.pv((select id from public.bookings where series_id = (select series_id from made) and date = pg_temp.today_plus(17))), 'Away that week', 'client', 0)$$, 'The Admin can cancel one session');
reset role;
select is((select reason from public.booking_series_skips where series_id = (select series_id from made) and date = pg_temp.today_plus(17)), 'cancelled', 'A cancelled session becomes a skipped date');
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'The cancelled session is not made again');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made) and date = pg_temp.today_plus(17)), 0, 'Its slot is not held again');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made)), 49, 'The other weeks stay held');

-- Skipping and putting back a date.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_skip_series_date((select series_id from made), pg_temp.today_plus(38))$$, 'A future date can be skipped');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made) and date = pg_temp.today_plus(38)), 0, 'A skipped date is released');
select throws_ok($$select public.admin_skip_series_date((select series_id from made), pg_temp.today_plus(10))$$, 'PT409', 'That session is already booked. Cancel the booking instead.', 'A booked session is cancelled, not skipped');
select lives_ok($$select public.admin_unskip_series_date((select series_id from made), pg_temp.today_plus(38))$$, 'A skipped date can be put back');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made) and date = pg_temp.today_plus(38)), 1, 'A date that is put back is held again');
select throws_ok($$select public.admin_unskip_series_date((select series_id from made), pg_temp.today_plus(17))$$, 'PT409', 'That date cannot be put back', 'A cancelled session cannot be put back as a skip');
select is((public.admin_client_series('00000000-0000-4000-8000-00000000f611')->0->>'status'), 'active', 'The Admin can list a client''s repeats');
select is((public.admin_client_series('00000000-0000-4000-8000-00000000f611')->0->'next_booking'->>'date')::date, pg_temp.today_plus(10), 'The listing shows the next booking');
select is(jsonb_array_length(public.admin_client_series('00000000-0000-4000-8000-00000000f611')->0->'skipped'), 1, 'The listing shows the skipped date');

-- Pause, resume and end.
select lives_ok($$select public.admin_set_series_status((select series_id from made), 'paused')$$, 'A repeat can be paused');
reset role;
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made)), 0, 'A paused repeat holds nothing');
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'A paused repeat makes no bookings');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_series_status((select series_id from made), 'active')$$, 'A repeat can be resumed');
reset role;
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made)), 49, 'Resuming holds the weeks again, without the cancelled and booked dates');

-- A time that is no longer free is skipped with an alert, never forced.
insert into public.calendar_blocks(kind, date, start_minutes, end_minutes, title) values ('blocked', pg_temp.today_plus(31), 600, 660, 'Dentist');
update public.business_settings set value = '40' where key = 'series_payment_reminder_days';
select is((select public.run_series_maintenance()), '{"made": 2, "clashes": 1, "ended": 0}'::jsonb, 'Two sessions are made and the one that clashes is reported');
select is((select count(*)::integer from public.bookings where series_id = (select series_id from made) and booking_status <> 'cancelled'), 3, 'The repeat has the first session and two more');
select is((select reason from public.booking_series_skips where series_id = (select series_id from made) and date = pg_temp.today_plus(31)), 'clash', 'The date that clashed is skipped');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made) and date = pg_temp.today_plus(31)), 0, 'It is no longer held');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
    where e.event_type = 'series.clash' and d.recipient = 'admin-series' and e.payload->>'client_id' = '00000000-0000-4000-8000-00000000f611'), 3, 'The Admin is told about the clash');
select is((select d.link_path from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'series.clash' and d.channel = 'in_app' and e.payload->>'client_id' = '00000000-0000-4000-8000-00000000f611'), '/admin/clients/00000000-0000-4000-8000-00000000f611', 'The alert opens the client');
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'A clash is reported once');

-- Moving a session releases its original date.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_reschedule_booking((select id from public.bookings where series_id = (select series_id from made) and date = pg_temp.today_plus(24)), gen_random_uuid(),
    pg_temp.bv((select id from public.bookings where series_id = (select series_id from made) and date = pg_temp.today_plus(24))), pg_temp.today_plus(25), 600, 'admin')$$, 'The Admin can move a session');
reset role;
select is((select reason from public.booking_series_skips where series_id = (select series_id from made) and date = pg_temp.today_plus(24)), 'moved', 'The original date is released');
select is((select public.run_series_maintenance()), '{"made": 0, "clashes": 0, "ended": 0}'::jsonb, 'The moved session is not made again');

-- Ending a repeat releases everything and cannot be undone.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_series_status((select series_id from made), 'ended')$$, 'A repeat can be ended');
select throws_ok($$select public.admin_set_series_status((select series_id from made), 'active')$$, 'PT409', 'This repeat has ended', 'An ended repeat cannot be restarted');
select throws_ok($$select public.admin_set_series_status((select series_id from made), 'sometimes')$$, '22023', 'Choose active, paused or ended', 'An unknown status is refused');
reset role;
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made)), 0, 'An ended repeat holds nothing');
select ok(exists (select 1 from public.bookings where series_id = (select series_id from made) and booking_status = 'confirmed'), 'Sessions already booked are left for the Admin to decide');

-- A repeat with an end date holds only the weeks up to it.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
create temp table made2 as select * from public.admin_create_series(pg_temp.request('00000000-0000-4000-8000-00000000f612', '00000000-0000-4000-8000-00000000f622', 12, 720, 'cash_appointment'), pg_temp.today_plus(26), gen_random_uuid());
grant select on made2 to authenticated;
select throws_ok($$select * from public.admin_create_series(pg_temp.request('00000000-0000-4000-8000-00000000f612', '00000000-0000-4000-8000-00000000f622', 13, 840), pg_temp.today_plus(5), gen_random_uuid())$$,
  '22023', 'The repeat cannot end before it starts', 'A repeat cannot end before it starts');
reset role;
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made2)), 2, 'Only the weeks up to the end date are held');
select is((select request->>'payment_arrangement' from public.booking_series where id = (select series_id from made2)), 'cash_appointment', 'A cash repeat stays cash');
update public.business_settings set value = '30' where key = 'series_payment_reminder_days';
select is((select public.run_series_maintenance()), '{"made": 2, "clashes": 0, "ended": 0}'::jsonb, 'The cash repeat makes its remaining sessions');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
    where e.event_type = 'booking.series_due' and d.audience = 'client' and d.recipient = 'dana.dated@example.test' and d.title = 'Your next regular appointment' and d.body like '%paid in cash%'), 2, 'A cash repeat is not asked for a transfer');
select is((select count(*)::integer from public.calendar_blocks where series_id = (select series_id from made2)), 0, 'Nothing is held once every session up to the end date is booked');

-- The reminder window is a setting the Admin can read and change.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f602","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_series_reminder_days(5)$$, '42501', 'Admin authorization required', 'A client cannot change the window');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f601","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_series_reminder_days(5)$$, 'The Admin can change the window');
select is(public.admin_series_reminder_days(), 5, 'The new window is read back');
select throws_ok($$select public.admin_set_series_reminder_days(0)$$, '22023', 'Choose between 1 and 30 days', 'Zero days is refused');
select throws_ok($$select public.admin_set_series_reminder_days(31)$$, '22023', 'Choose between 1 and 30 days', 'More than 30 days is refused');
reset role;
select ok(not has_function_privilege('anon', 'public.admin_set_series_reminder_days(integer)', 'EXECUTE'), 'Anonymous callers cannot change the window');

select * from finish();
rollback;
