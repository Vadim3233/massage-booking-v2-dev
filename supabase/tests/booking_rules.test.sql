begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(43);

-- ---------------------------------------------------------------------------------------------
-- Fixtures: an Admin, a client with an account, a small catalogue and working days.
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000c901', 'authenticated', 'authenticated', 'rules-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000c902', 'authenticated', 'authenticated', 'rules-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c901');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000c911', '00000000-0000-0000-0000-00000000c902', 'Rina', 'Rules', 'rules-client@example.test', '+44 7700 900901');
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000c921', 'rules-test-service', 'Rules Test Service', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values ('00000000-0000-4000-8000-00000000c921', 60, 85, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values ('00000000-0000-4000-8000-00000000c931', 'rules-test-area', 'Rules Test Area', true, 0, 0, 990);

create function pg_temp.london_day(p_offset integer) returns date language sql as $$ select ((now() at time zone 'Europe/London')::date + p_offset); $$;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.london_day(d), true, 600, 1200, 'flexible' from unnest(array[1, 4, 8, 10, 11, 12, 13, 14, 15]) d;

create function pg_temp.set_rule(p_key text, p_value integer) returns void language sql as $$
  insert into public.business_settings(key, value) values ($1, to_jsonb($2)) on conflict (key) do update set value = excluded.value;
$$;
create function pg_temp.reserve(p_key text, p_date date, p_start integer default 600) returns uuid language plpgsql as $$
declare h record; r record;
begin
  select * into h from public.create_booking_hold(p_date, p_start, 60, 'rules-browser-' || p_key || '-0000000');
  select * into r from public.finalize_client_booking(h.hold_id, h.hold_token, 'rules-browser-' || p_key || '-0000000',
    '00000000-0000-4000-8000-00000000c931', '[{"service_id":"00000000-0000-4000-8000-00000000c921","duration_minutes":60}]',
    '{}', null, '1 Rules Road', null, 'London', 'sw1a1aa', null, null, 'bank_transfer', 'rules-finalize-' || p_key);
  return r.booking_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('business_setting_int', 'notice_text', 'count_word')
  and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'The internal readers are not callable from the browser');
select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_booking_rules', 'admin_save_booking_rules') and has_function_privilege('anon', p.oid, 'EXECUTE')), 'Anonymous callers cannot read or change the rules');
select ok(has_function_privilege('anon', 'public.get_booking_rules()', 'EXECUTE'), 'The booking pages can read the public wording and limits before sign-in');
select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('business_setting_int', 'admin_booking_rules', 'admin_save_booking_rules', 'get_booking_rules')
  and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'Every rule function is a definer with an empty search path');

-- ---------------------------------------------------------------------------------------------
-- Defaults, wording helpers
-- ---------------------------------------------------------------------------------------------
delete from public.business_settings where key in ('booking_horizon_days', 'minimum_notice_minutes', 'free_cancellation_hours', 'grace_minutes', 'new_client_booking_limit', 'returning_client_booking_limit');
select is(public.get_booking_rules(), '{"booking_horizon_days":40,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60}'::jsonb, 'With nothing saved the rules are the ones in force before settings existed');
select is(public.notice_text(120), '2 hours', 'Two hours reads as two hours');
select is(public.notice_text(60), '1 hour', 'One hour is singular');
select is(public.notice_text(90), '90 minutes', 'An odd amount is given in minutes');
select is(public.notice_text(0), '0 minutes', 'No notice reads sensibly');
select is(public.count_word(5), 'five', 'Five is a word');
select is(public.count_word(12), '12', 'Larger numbers stay digits');
insert into public.business_settings(key, value) values ('booking_horizon_days', '"forty"');
select is(public.get_booking_rules()->>'booking_horizon_days', '40', 'An unusable saved value falls back to the default rather than breaking booking');
delete from public.business_settings where key = 'booking_horizon_days';

-- ---------------------------------------------------------------------------------------------
-- The Admin's screen
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c902","role":"authenticated"}', true);
select throws_ok($$select public.admin_booking_rules()$$, '42501', 'Admin authorization required', 'A client cannot read the Admin view of the rules');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":10,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":1,"returning_client_booking_limit":5}')$$, '42501', 'Admin authorization required', 'A client cannot change the rules');
select is(public.get_booking_rules()->>'free_cancellation_hours', '24', 'A client can read the public wording');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c901","role":"authenticated"}', true);
select is(public.admin_booking_rules(), '{"booking_horizon_days":40,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":1,"returning_client_booking_limit":5}'::jsonb, 'The Admin sees every rule with its current value');

select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":0,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":1,"returning_client_booking_limit":5}')$$, '22023', 'Booking ahead must be between 1 and 365 days', 'Booking ahead has limits');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":366,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":1,"returning_client_booking_limit":5}')$$, '22023', 'Booking ahead must be between 1 and 365 days', 'Booking ahead has an upper limit');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":40,"minimum_notice_hours":73,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":1,"returning_client_booking_limit":5}')$$, '22023', 'Notice must be between 0 and 72 hours', 'Notice has limits');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":40,"minimum_notice_hours":2,"free_cancellation_hours":169,"grace_minutes":60,"new_client_booking_limit":1,"returning_client_booking_limit":5}')$$, '22023', 'The free cancellation window must be between 0 and 168 hours', 'The free window has limits');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":40,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":241,"new_client_booking_limit":1,"returning_client_booking_limit":5}')$$, '22023', 'The grace period must be between 0 and 240 minutes', 'The grace period has limits');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":40,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":0,"returning_client_booking_limit":5}')$$, '22023', 'A new client may hold between 1 and 10 bookings', 'A new client must be allowed at least one booking');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":40,"minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":3,"returning_client_booking_limit":2}')$$, '22023', 'A returning client may hold as many as a new client, up to 20', 'A returning client cannot be allowed fewer than a new one');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":"ten","minimum_notice_hours":2,"free_cancellation_hours":24,"grace_minutes":60,"new_client_booking_limit":1,"returning_client_booking_limit":5}')$$, '22023', 'Every rule needs a whole number', 'Text instead of a number is refused');
select throws_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":40,"surprise":1}')$$, '22023', 'Those rules are not recognised', 'Unknown rules are refused');
select is(public.admin_booking_rules()->>'booking_horizon_days', '40', 'Refused attempts change nothing');
select lives_ok($$select public.admin_save_booking_rules('{"booking_horizon_days":10,"minimum_notice_hours":72,"free_cancellation_hours":48,"grace_minutes":0,"new_client_booking_limit":2,"returning_client_booking_limit":6}')$$, 'The Admin can save new rules');
select is(public.admin_booking_rules(), '{"booking_horizon_days":10,"minimum_notice_hours":72,"free_cancellation_hours":48,"grace_minutes":0,"new_client_booking_limit":2,"returning_client_booking_limit":6}'::jsonb, 'They are shown back');
select is(public.get_booking_rules(), '{"booking_horizon_days":10,"minimum_notice_hours":72,"free_cancellation_hours":48,"grace_minutes":0}'::jsonb, 'The booking pages see the public ones');
reset role;
select is((select updated_by from public.business_settings where key = 'free_cancellation_hours'), '00000000-0000-0000-0000-00000000c901'::uuid, 'The change records who made it');

-- ---------------------------------------------------------------------------------------------
-- The rules in action (horizon 10 days, notice 72 hours, free window 48 hours, no grace, limits 2 and 6)
-- ---------------------------------------------------------------------------------------------
select ok(exists (select 1 from public.get_booking_availability(pg_temp.london_day(10), 60)), 'Day 10 is still offered');
select is((select count(*)::integer from public.get_booking_availability(pg_temp.london_day(11), 60)), 0, 'Day 11 is beyond the new horizon');
select throws_ok($$select * from public.create_booking_hold(pg_temp.london_day(11), 600, 60, 'rules-horizon-client-0001')$$, '22023',
  'Online appointments can currently be arranged up to 10 days ahead. Please choose an earlier date.', 'A hold beyond the horizon is refused, naming the new limit');
select is((select count(*)::integer from public.get_booking_availability(pg_temp.london_day(1), 60)), 0, 'Tomorrow is inside the 72 hours of notice, even though it is another day');
select ok(exists (select 1 from public.get_booking_availability(pg_temp.london_day(4), 60)), 'A few days away is outside the notice');
select throws_ok($$select * from public.create_booking_hold(pg_temp.london_day(1), 600, 60, 'rules-notice-client-00001')$$, '23P01',
  'Online appointments need at least 72 hours notice. Please choose a later time.', 'A hold inside the notice is refused, naming it');

-- The late fee rule follows the free window and the grace period.
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-01 12:00+00', timestamptz '2031-06-08 15:00+00'), 85::numeric, 'With a 48-hour window, about 42 hours before is charged');
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-01 12:00+00', timestamptz '2031-06-07 08:00+00'), 0::numeric, 'More than 48 hours before is free');
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-09 08:30+00', timestamptz '2031-06-09 08:31+00'), 85::numeric, 'With no grace period, even a minute after booking is charged inside the window');

-- Booking limits for a new client.
select pg_temp.set_rule('booking_horizon_days', 40);
select pg_temp.set_rule('minimum_notice_minutes', 120);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c902', true);
set local role authenticated;
select lives_ok($$select pg_temp.reserve('one', pg_temp.london_day(8))$$, 'A new client can make a first booking');
select lives_ok($$select pg_temp.reserve('two', pg_temp.london_day(10))$$, 'With a limit of two, a new client can make a second');
select throws_ok($$select pg_temp.reserve('three', pg_temp.london_day(12))$$, '22023', 'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.', 'A third is refused');
reset role;
select pg_temp.set_rule('new_client_booking_limit', 1);
set local role authenticated;
select throws_ok($$select pg_temp.reserve('four', pg_temp.london_day(13))$$, '22023', 'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.', 'Back at a limit of one, a client already holding two cannot add more');
reset role;

select * from finish();
rollback;
