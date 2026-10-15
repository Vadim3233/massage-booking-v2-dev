begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(29);

-- ---------------------------------------------------------------------------------------------
-- Fixtures. Dates are far ahead and "now" is passed in, so nothing here depends on today's date or weekday.
-- ---------------------------------------------------------------------------------------------
insert into public.clients(id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000d201', 'Rita', 'Reminder', 'rita@example.test');

create function pg_temp.new_booking(p_id uuid, p_date date, p_start integer, p_status text default 'confirmed', p_email text default 'rita@example.test') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp,
    booking_email_snapshot, created_at, cancelled_at, cancelled_by_actor_type)
  select p_id, 'REM-' || p_id, '00000000-0000-4000-8000-00000000d201', id, p_date, p_start, 60, p_status,
    'test', '10 Quiet Street', 'London', 'SW1A 1AA', name, 85, 85, p_email, now() - interval '3 days',
    case when p_status = 'cancelled' then now() end, case when p_status = 'cancelled' then 'admin' end
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp)
  values (p_id, case when p_status = 'awaiting_payment_verification' then 'bank_transfer' else 'cash' end,
          case p_status when 'confirmed' then 'approved' when 'cancelled' then 'rejected' else 'awaiting_verification' end, 85);
end;
$$;
-- A client email already sent about a booking, written as the real trigger would, then dated as the test needs.
create function pg_temp.emailed(p_booking uuid, p_at timestamptz) returns void language plpgsql as $$
declare v_event uuid;
begin
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload) values ('booking.cash_approved', 'booking', p_booking, '{}') returning id into v_event;
  update public.notification_deliveries set created_at = p_at where event_id = v_event;
end;
$$;
create function pg_temp.reminder_rows(p_booking uuid) returns table(channel text, audience text, recipient text, title text, body text, status text, link_path text) language sql as $$
  select d.channel, d.audience, d.recipient, d.title, d.body, d.status, d.link_path
    from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
   where e.aggregate_id = $1 and e.event_type = 'booking.reminder' order by d.channel, d.audience;
$$;

-- 2031-05-05 is a Monday in British Summer Time (UTC+1).
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d301', date '2031-05-05', 870);                                -- 14:30, the one checked in detail
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d302', date '2031-05-05', 600);                                -- 10:00, exactly an hour after 09:00
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d303', date '2031-05-05', 599);                                -- 09:59, inside the hour
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d304', date '2031-05-05', 960, 'awaiting_payment_verification'); -- not confirmed
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d305', date '2031-05-05', 1020, 'cancelled');                  -- cancelled
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d306', date '2031-05-05', 1080, 'confirmed', null);            -- no email address
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d307', date '2031-05-06', 870);                                -- tomorrow
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d308', date '2031-05-05', 1140);                               -- emailed this morning
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d309', date '2031-05-05', 1170);                               -- emailed yesterday
select pg_temp.emailed('00000000-0000-4000-8000-00000000d308', timestamptz '2031-05-05 07:30:00+01');
select pg_temp.emailed('00000000-0000-4000-8000-00000000d309', timestamptz '2031-05-04 18:00:00+01');

-- ---------------------------------------------------------------------------------------------
-- Who can run it
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'plan_day_of_reminders', array['timestamp with time zone'], 'The reminder planner exists');
select ok(has_function_privilege('service_role', 'public.plan_day_of_reminders(timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.plan_day_of_reminders(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.plan_day_of_reminders(timestamptz)', 'EXECUTE'), 'Only the sender (the service role) can run it, never a browser');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'plan_day_of_reminders'),
  'It runs as a definer with an empty search path');

-- ---------------------------------------------------------------------------------------------
-- The time of day
-- ---------------------------------------------------------------------------------------------
select is(public.plan_day_of_reminders(timestamptz '2031-05-05 07:59:00+01'), 0, 'Nothing is sent before 08:00 in the morning');
select is((select count(*)::integer from public.event_outbox where event_type = 'booking.reminder'), 0, 'And nothing is recorded either');

-- ---------------------------------------------------------------------------------------------
-- Who is reminded, at 09:00
-- ---------------------------------------------------------------------------------------------
select is(public.plan_day_of_reminders(timestamptz '2031-05-05 09:00:00+01'), 3, 'At 09:00 three clients are reminded');
select results_eq($$select aggregate_id::text from public.event_outbox where event_type = 'booking.reminder' order by aggregate_id::text$$,
  $$values ('00000000-0000-4000-8000-00000000d301'::text), ('00000000-0000-4000-8000-00000000d302'), ('00000000-0000-4000-8000-00000000d309')$$,
  'They are the confirmed appointments today that are at least an hour away and were not emailed about this morning');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d302')), 1, 'An appointment exactly an hour away is reminded');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d303')), 0, 'An appointment inside the hour is not');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d304')), 0, 'A booking still waiting for payment is not');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d305')), 0, 'A cancelled booking is not');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d306')), 0, 'A booking with no email address is not');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d307')), 0, 'Tomorrow''s appointment is not reminded today');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d308')), 0, 'A client emailed about the booking this morning is not reminded as well');
select is((select count(*)::integer from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d309')), 1, 'A client emailed about it yesterday is reminded');

-- ---------------------------------------------------------------------------------------------
-- What the email says
-- ---------------------------------------------------------------------------------------------
select results_eq($$select channel, audience, recipient, title, status, link_path from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d301')$$,
  $$values ('email'::text, 'client'::text, 'rita@example.test'::text, 'Your appointment is today'::text, 'pending'::text, '/account?booking=00000000-0000-4000-8000-00000000d301'::text)$$,
  'It is one client email, queued for the sender, linking to the booking');
select is((select body from pg_temp.reminder_rows('00000000-0000-4000-8000-00000000d301')),
  E'Hi Rita, a quick reminder: your appointment is today at 14:30, at 10 Quiet Street, London, SW1A 1AA. I''m looking forward to seeing you!\n\nYou can see or change your booking here: {link}\n\nWarm wishes,\nVad',
  'It says who, when and where, in the owner''s own words, and ends as the other emails do');
select is((select deduplication_key from public.event_outbox where event_type = 'booking.reminder' and aggregate_id = '00000000-0000-4000-8000-00000000d301'),
  'booking.reminder:00000000-0000-4000-8000-00000000d301:2031-05-05', 'The reminder is recorded once per booking and date');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.reminder'), 3,
  'There is one delivery for each reminder, and none for the Admin');

-- ---------------------------------------------------------------------------------------------
-- Never twice
-- ---------------------------------------------------------------------------------------------
select is(public.plan_day_of_reminders(timestamptz '2031-05-05 09:00:00+01'), 0, 'Running it again sends nothing more');
select is((select count(*)::integer from public.event_outbox where event_type = 'booking.reminder'), 3, 'And records nothing more');

-- ---------------------------------------------------------------------------------------------
-- Morning means 08:00 London time, in summer and in winter
-- ---------------------------------------------------------------------------------------------
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d311', date '2031-07-01', 870);
select is(public.plan_day_of_reminders(timestamptz '2031-07-01 06:59:00+00'), 0, 'In summer, 07:59 in London is too early');
select is(public.plan_day_of_reminders(timestamptz '2031-07-01 07:00:00+00'), 1, 'In summer, 08:00 in London is 07:00 UTC, and the reminder goes');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d312', date '2031-12-01', 870);
select is(public.plan_day_of_reminders(timestamptz '2031-12-01 07:59:00+00'), 0, 'In winter, 07:59 in London is 07:59 UTC, still too early');
select is(public.plan_day_of_reminders(timestamptz '2031-12-01 08:00:00+00'), 1, 'In winter, 08:00 in London is 08:00 UTC, and the reminder goes');

-- ---------------------------------------------------------------------------------------------
-- The time can be changed in the settings
-- ---------------------------------------------------------------------------------------------
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d321', date '2031-08-04', 870);
insert into public.business_settings(key, value) values ('client_reminder_minutes', '600');
select is(public.plan_day_of_reminders(timestamptz '2031-08-04 09:00:00+01'), 0, 'With the reminder time set to 10:00, 09:00 is too early');
select is(public.plan_day_of_reminders(timestamptz '2031-08-04 10:00:00+01'), 1, 'And at 10:00 it goes');

-- ---------------------------------------------------------------------------------------------
-- It leaves the rest of the sender alone
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'booking.reminder' and d.audience = 'admin'), 0, 'The Admin is never alerted about a reminder');
select ok((select p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'plan_event_notifications') not like '%booking.reminder%',
  'The event trigger was not changed to know about reminders');

select * from finish();
rollback;
