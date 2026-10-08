begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(95);

-- ---------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000e001', 'authenticated', 'authenticated', 'life-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e002', 'authenticated', 'authenticated', 'life-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e001');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000e101', 'Life', 'Test');

-- A date and 30-minute start that fall p_offset from now, in London time.
create function pg_temp.slot_date(p_offset interval) returns date language sql as $$
  select ((now() + p_offset) at time zone 'Europe/London')::date;
$$;
create function pg_temp.slot_start(p_offset interval) returns integer language sql as $$
  select (floor((extract(hour from (now() + p_offset) at time zone 'Europe/London') * 60
    + extract(minute from (now() + p_offset) at time zone 'Europe/London')) / 30) * 30)::integer;
$$;

create function pg_temp.new_booking(p_id uuid, p_status text, p_offset interval, p_method text, p_payment text,
  p_created_ago interval default interval '3 days') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, created_at)
  select p_id, 'LIFE-' || p_id, '00000000-0000-4000-8000-00000000e101', id, pg_temp.slot_date(p_offset), pg_temp.slot_start(p_offset), 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85, now() - p_created_ago
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, p_method, p_payment, 85, case when p_payment = 'paid' then now() end);
end;
$$;
create function pg_temp.bv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = $1; $$;
create function pg_temp.pv(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.booking_payments where booking_id = $1; $$;

-- Working days used by the reschedule tests (flexible, 10:00-20:00).
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.slot_date(interval '1 day' * d), true, 600, 1200, 'flexible' from unnest(array[5, 6, 7, 8, 9, 10]) d;

-- ---------------------------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'admin_complete_booking', array['uuid', 'uuid', 'timestamp with time zone']);
select has_function('public', 'admin_cancel_booking', array['uuid', 'uuid', 'timestamp with time zone', 'timestamp with time zone', 'text', 'text', 'numeric']);
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('admin_complete_booking', 'admin_mark_no_show', 'admin_cancel_booking', 'admin_reschedule_booking', 'admin_settle_late_fee', 'admin_record_refund')
    and has_function_privilege('anon', p.oid, 'EXECUTE')), 'Anonymous callers cannot run any lifecycle command');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('admin_begin_command', 'admin_finish_command', 'admin_lifecycle_event', 'late_fee_standard_gbp', 'record_booking_schedule_change')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'Helpers are not callable from the browser');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'compute_booking_availability'
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'The raw availability calculation stays private in every form');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('admin_complete_booking', 'admin_mark_no_show', 'admin_cancel_booking', 'admin_reschedule_booking', 'admin_settle_late_fee', 'admin_record_refund')
    and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'Commands are definers with an empty search path');
select ok(not has_table_privilege('authenticated', 'public.booking_schedule_changes', 'INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('anon', 'public.booking_schedule_changes', 'SELECT'), 'Schedule history is not writable or public');

-- ---------------------------------------------------------------------------------------------
-- The late fee rule, with exact boundaries and a clock change
-- ---------------------------------------------------------------------------------------------
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-01 12:00+00', timestamptz '2031-06-09 12:00+00'), 85::numeric,
  '22 hours before a 10:00 summer appointment is inside 24 hours');
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-01 12:00+00', timestamptz '2031-06-09 09:01+00'), 85::numeric,
  'One minute inside 24 hours is charged');
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-01 12:00+00', timestamptz '2031-06-09 09:00+00'), 85::numeric,
  'Exactly 24 hours before is not more than 24 hours, so it is charged');
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-01 12:00+00', timestamptz '2031-06-09 08:59+00'), 0::numeric,
  'More than 24 hours before is free');
select is(public.late_fee_standard_gbp(85, date '2031-03-30', 600, timestamptz '2031-03-01 12:00+00', timestamptz '2031-03-29 08:59+00'), 0::numeric,
  'On the day the clocks go forward, 24 hours before 10:00 BST is 09:00 UTC the day before: earlier is free');
select is(public.late_fee_standard_gbp(85, date '2031-03-30', 600, timestamptz '2031-03-01 12:00+00', timestamptz '2031-03-29 09:00+00'), 85::numeric,
  'On the day the clocks go forward, exactly 24 hours before is charged');
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-09 08:30+00', timestamptz '2031-06-09 09:20+00'), 0::numeric,
  'Within one hour of booking is free even inside 24 hours');
select is(public.late_fee_standard_gbp(85, date '2031-06-10', 600, timestamptz '2031-06-09 08:30+00', timestamptz '2031-06-09 09:31+00'), 85::numeric,
  'After the one-hour grace the 24-hour rule applies');

-- ---------------------------------------------------------------------------------------------
-- Admin gating
-- ---------------------------------------------------------------------------------------------
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f001', 'confirmed', interval '-5 hours', 'cash', 'approved');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
select throws_ok($$select public.admin_complete_booking('00000000-0000-4000-8000-00000000f001', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f001'))$$,
  '42501', 'Admin authorization required', 'A client cannot complete a booking');
select throws_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f001', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f001'), pg_temp.pv('00000000-0000-4000-8000-00000000f001'), 'x', 'admin')$$,
  '42501', 'Admin authorization required', 'A client cannot cancel through the Admin command');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f001', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f001'), current_date + 5, 600, 'admin')$$,
  '42501', 'Admin authorization required', 'A client cannot reschedule through the Admin command');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Complete
-- ---------------------------------------------------------------------------------------------
create temp table req(name text primary key, id uuid);
insert into req select n, gen_random_uuid() from unnest(array['complete', 'cancel_a']) n;
grant select on req to authenticated;

create temp table complete_version as select pg_temp.bv('00000000-0000-4000-8000-00000000f001') as v;
grant select on complete_version to authenticated;
select is(public.admin_complete_booking('00000000-0000-4000-8000-00000000f001', (select id from req where name = 'complete'), (select v from complete_version)),
  '00000000-0000-4000-8000-00000000f001'::uuid, 'A started, confirmed appointment can be completed');
select is(public.admin_complete_booking('00000000-0000-4000-8000-00000000f001', (select id from req where name = 'complete'), (select v from complete_version)),
  '00000000-0000-4000-8000-00000000f001'::uuid, 'The same request with the same arguments is safe to retry');
reset role;
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000f001'), 'completed', 'The booking is completed');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000f001' and event_type = 'booking.completed'), 1, 'One completion event');
select results_eq($$select actor_type, from_status, to_status from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000f001' and to_status = 'completed'$$,
  $$values ('admin'::text, 'confirmed'::text, 'completed'::text)$$, 'The completion is in the status history with the Admin as actor');

select pg_temp.new_booking('00000000-0000-4000-8000-00000000f002', 'confirmed', interval '5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f003', 'awaiting_cash_approval', interval '-5 hours', 'cash', 'awaiting_approval');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select throws_ok($$select public.admin_complete_booking('00000000-0000-4000-8000-00000000f002', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f002'))$$,
  '22023', 'The appointment has not started yet', 'A future appointment cannot be completed');
select throws_ok($$select public.admin_complete_booking('00000000-0000-4000-8000-00000000f003', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f003'))$$,
  'PT409', 'Booking state changed', 'An unconfirmed booking cannot be completed');
select throws_ok($$select public.admin_complete_booking('00000000-0000-4000-8000-00000000f002', gen_random_uuid(), now() - interval '1 day')$$,
  'PT409', 'Booking state changed', 'A stale booking version is refused');

-- ---------------------------------------------------------------------------------------------
-- No-show
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f010', 'confirmed', interval '-5 hours', 'bank_transfer', 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f011', 'confirmed', interval '-5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f012', 'confirmed', interval '-5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f013', 'confirmed', interval '-5 hours', 'cash', 'approved');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select lives_ok($$select public.admin_mark_no_show('00000000-0000-4000-8000-00000000f010', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f010'))$$, 'A started appointment can be marked a no-show');
select lives_ok($$select public.admin_mark_no_show('00000000-0000-4000-8000-00000000f011', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f011'), 40)$$, 'The Admin can choose a lower fee');
select lives_ok($$select public.admin_mark_no_show('00000000-0000-4000-8000-00000000f012', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f012'), 0)$$, 'The Admin can waive the fee');
select throws_ok($$select public.admin_mark_no_show('00000000-0000-4000-8000-00000000f002', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f002'))$$,
  '22023', 'The appointment has not started yet', 'A future appointment cannot be a no-show');
select throws_ok($$select public.admin_mark_no_show('00000000-0000-4000-8000-00000000f013', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f013'), 999)$$,
  '22023', 'The fee must be between zero and the appointment price', 'A fee above the price is refused');
reset role;
select results_eq($$select booking_status, late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f010'$$,
  $$values ('no_show'::text, 85.00::numeric, 'due'::text)$$, 'By default the full price is recorded as due');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f011'$$,
  $$values (40.00::numeric, 'due'::text)$$, 'A reduced fee is recorded');
select results_eq($$select late_fee_due_gbp, late_fee_standard_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f012'$$,
  $$values (0.00::numeric, 85.00::numeric, 'waived'::text)$$, 'A waived fee remembers the standard amount');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Cancel
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f020', 'awaiting_transfer', interval '5 hours', 'bank_transfer', 'awaiting_transfer');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f021', 'awaiting_payment_verification', interval '3 days', 'bank_transfer', 'awaiting_verification');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f022', 'confirmed', interval '5 hours', 'cash', 'approved', interval '30 minutes');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f023', 'confirmed', interval '5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f024', 'confirmed', interval '5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f025', 'confirmed', interval '3 days', 'bank_transfer', 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f026', 'confirmed', interval '5 hours', 'bank_transfer', 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f027', 'confirmed', interval '5 hours', 'bank_transfer', 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f028', 'confirmed', interval '5 hours', 'cash', 'approved');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);

select is(public.admin_cancel_booking('00000000-0000-4000-8000-00000000f020', (select id from req where name = 'cancel_a'),
  pg_temp.bv('00000000-0000-4000-8000-00000000f020'), pg_temp.pv('00000000-0000-4000-8000-00000000f020'), 'Client changed their mind', 'client'),
  '00000000-0000-4000-8000-00000000f020'::uuid, 'Admin can cancel at a client''s request');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f021', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f021'), pg_temp.pv('00000000-0000-4000-8000-00000000f021'), 'Client cancelled', 'client')$$, 'A declared transfer booking can be cancelled well in advance');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f022', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f022'), pg_temp.pv('00000000-0000-4000-8000-00000000f022'), 'Booked by mistake', 'client')$$, 'Cancelling within the first hour is free');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f023', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f023'), pg_temp.pv('00000000-0000-4000-8000-00000000f023'), 'Admin unwell', 'admin')$$, 'The Admin can cancel for her own reasons');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f024', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f024'), pg_temp.pv('00000000-0000-4000-8000-00000000f024'), 'Late, but a loyal client', 'client', 20)$$, 'The Admin can set a lower fee');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f025', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f025'), pg_temp.pv('00000000-0000-4000-8000-00000000f025'), 'Early cancel of a paid booking', 'client')$$, 'A paid booking can be cancelled in good time');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f026', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f026'), pg_temp.pv('00000000-0000-4000-8000-00000000f026'), 'Late cancel of a paid booking', 'client')$$, 'A paid booking can be cancelled late');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f027', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f027'), pg_temp.pv('00000000-0000-4000-8000-00000000f027'), 'Late, part of the fee kept', 'client', 30)$$, 'A paid booking can be cancelled with a part fee');
select is(public.admin_cancel_booking('00000000-0000-4000-8000-00000000f020', (select id from req where name = 'cancel_a'),
  pg_temp.bv('00000000-0000-4000-8000-00000000f020'), pg_temp.pv('00000000-0000-4000-8000-00000000f020'), 'Client changed their mind', 'client'),
  '00000000-0000-4000-8000-00000000f020'::uuid, 'The same cancellation request is safe to retry');
select throws_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f028', (select id from req where name = 'cancel_a'), pg_temp.bv('00000000-0000-4000-8000-00000000f028'), pg_temp.pv('00000000-0000-4000-8000-00000000f028'), 'Different booking, same key', 'client')$$,
  '22023', 'Request key reused', 'A request key cannot be reused for different arguments');
select throws_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f028', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f028'), pg_temp.pv('00000000-0000-4000-8000-00000000f028'), '   ', 'client')$$,
  '22023', 'A cancellation reason of up to 500 characters is required', 'A reason is required');
select throws_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f028', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f028'), pg_temp.pv('00000000-0000-4000-8000-00000000f028'), 'Reason', 'somebody')$$,
  '22023', 'Say who asked for the cancellation', 'The requester must be client or admin');
select throws_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f028', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f028'), pg_temp.pv('00000000-0000-4000-8000-00000000f028'), 'Reason', 'client', 86)$$,
  '22023', 'The fee must be between zero and the appointment price', 'A fee above the price is refused');
select throws_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f001', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f001'), pg_temp.pv('00000000-0000-4000-8000-00000000f001'), 'Reason', 'client')$$,
  'PT409', 'Booking state changed', 'A completed booking cannot be cancelled');
select throws_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f028', gen_random_uuid(), now() - interval '1 day', pg_temp.pv('00000000-0000-4000-8000-00000000f028'), 'Reason', 'client')$$,
  'PT409', 'Booking state changed', 'A stale version is refused');
reset role;

select results_eq($$select booking_status, cancellation_initiated_by, cancelled_by_actor_type, late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f020'$$,
  $$values ('cancelled'::text, 'client'::text, 'admin'::text, 85.00::numeric, 'due'::text)$$, 'A client-requested cancellation inside 24 hours records the full fee as due');
select is((select cancellation_reason from public.bookings where id = '00000000-0000-4000-8000-00000000f020'), 'Client changed their mind', 'The reason is stored');
select is((select status from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000f020'), 'rejected', 'An unpaid payment is closed as rejected');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000f020' and event_type = 'booking.cancelled'), 1, 'Retrying produced one cancellation event');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f021'$$,
  $$values (0.00::numeric, 'none'::text)$$, 'Cancelling more than 24 hours ahead is free');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f022'$$,
  $$values (0.00::numeric, 'none'::text)$$, 'The one-hour grace beats the 24-hour rule');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f023'$$,
  $$values (0.00::numeric, 'none'::text)$$, 'A cancellation by the Admin never charges the client');
select results_eq($$select late_fee_due_gbp, late_fee_standard_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f024'$$,
  $$values (20.00::numeric, 85.00::numeric, 'due'::text)$$, 'A reduced fee keeps the standard amount for the record');
select results_eq($$select b.refund_due_gbp, p.status, b.late_fee_status from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = '00000000-0000-4000-8000-00000000f025'$$,
  $$values (85.00::numeric, 'paid'::text, 'none'::text)$$, 'A paid booking cancelled in good time is owed a full refund');
select results_eq($$select b.refund_due_gbp, b.late_fee_due_gbp, b.late_fee_status from public.bookings b where b.id = '00000000-0000-4000-8000-00000000f026'$$,
  $$values (0.00::numeric, 85.00::numeric, 'received'::text)$$, 'A paid booking cancelled late keeps the full price as the fee, with nothing to refund');
select results_eq($$select b.refund_due_gbp, b.late_fee_due_gbp, b.late_fee_status from public.bookings b where b.id = '00000000-0000-4000-8000-00000000f027'$$,
  $$values (55.00::numeric, 30.00::numeric, 'received'::text)$$, 'A part fee on a paid booking leaves the balance to refund');
select results_eq($$select actor_type, from_status, to_status from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000f020' and entity = 'booking' and to_status = 'cancelled'$$,
  $$values ('admin'::text, 'awaiting_transfer'::text, 'cancelled'::text)$$, 'The cancellation is in the status history');

-- ---------------------------------------------------------------------------------------------
-- Reschedule
-- ---------------------------------------------------------------------------------------------
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp)
select '00000000-0000-4000-8000-00000000f030', 'LIFE-F030', '00000000-0000-4000-8000-00000000e101', id, pg_temp.slot_date(interval '6 days'), 600, 60, 'confirmed',
  'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85 from public.service_areas where slug = 'chelsea';
insert into public.booking_payments(booking_id, method, status, amount_gbp) values ('00000000-0000-4000-8000-00000000f030', 'cash', 'approved', 85);

-- A booking alone on its day, a booking on another day to move, and one to move late.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f031', 'confirmed', interval '5 days', 'cash', 'approved');
update public.bookings set start_minutes = 600, date = pg_temp.slot_date(interval '5 days') where id = '00000000-0000-4000-8000-00000000f031';
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f032', 'awaiting_transfer', interval '7 days', 'bank_transfer', 'awaiting_transfer');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f033', 'confirmed', interval '5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f034', 'confirmed', interval '5 hours', 'cash', 'approved');

select ok(exists (select 1 from public.compute_booking_availability(pg_temp.slot_date(interval '5 days'), 60, now(), 60, null) where start_minutes = 720)
  and not exists (select 1 from public.compute_booking_availability(pg_temp.slot_date(interval '5 days'), 60, now(), 60, null) where start_minutes = 600),
  'With a booking on the day only the edge time is offered');
select ok(exists (select 1 from public.compute_booking_availability(pg_temp.slot_date(interval '5 days'), 60, now(), 60, null, '00000000-0000-4000-8000-00000000f031') where start_minutes = 600),
  'Ignoring that booking, its own time is available again');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select ok(exists (select 1 from public.admin_booking_availability(pg_temp.slot_date(interval '5 days'), 60, '00000000-0000-4000-8000-00000000f031') where start_minutes = 780),
  'Admin availability can ignore the booking being moved');
select ok(not exists (select 1 from public.admin_booking_availability(pg_temp.slot_date(interval '5 days'), 60) where start_minutes = 780),
  'Admin availability without that argument still counts every booking');

select is(public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f031', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f031'),
  pg_temp.slot_date(interval '5 days'), 780, 'admin'), '00000000-0000-4000-8000-00000000f031'::uuid, 'A booking can move within its own day, ignoring itself');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f032', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f032'), pg_temp.slot_date(interval '5 days'), 600, 'admin')$$,
  'PT409', 'This time is not available. Choose another time.', 'A time that clashes with another booking is refused');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f032', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f032'), pg_temp.slot_date(interval '6 days'), 900, 'admin')$$,
  'PT409', 'This time is not available. Choose another time.', 'A time in the middle of another day''s chain is refused');
select is(public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f032', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f032'),
  pg_temp.slot_date(interval '6 days'), 720, 'admin'), '00000000-0000-4000-8000-00000000f032'::uuid, 'A pending booking can move to the edge of another day''s chain');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f032', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f032'), pg_temp.slot_date(interval '8 days'), 615, 'admin')$$,
  '22023', 'Choose a date within the next 365 days and a 30-minute start', 'Only 30-minute starts are accepted');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f032', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f032'), current_date - 2, 600, 'admin')$$,
  '22023', 'Choose a date within the next 365 days and a 30-minute start', 'A date in the past is refused');
select throws_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f001', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f001'), pg_temp.slot_date(interval '8 days'), 600, 'admin')$$,
  'PT409', 'Booking state changed', 'A completed booking cannot be moved');
select lives_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f033', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f033'), pg_temp.slot_date(interval '9 days'), 600, 'client')$$, 'A client-requested move inside 24 hours is allowed');
select lives_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f034', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f034'), pg_temp.slot_date(interval '10 days'), 600, 'admin')$$, 'An Admin-requested move inside 24 hours is allowed');
reset role;
select results_eq($$select date, start_minutes from public.bookings where id = '00000000-0000-4000-8000-00000000f031'$$,
  $$select pg_temp.slot_date(interval '5 days'), 780$$, 'The booking was moved');
select results_eq($$select from_start_minutes, to_start_minutes, actor_type from public.booking_schedule_changes where booking_id = '00000000-0000-4000-8000-00000000f031' and to_start_minutes = 780$$,
  $$values (600, 780, 'admin'::text)$$, 'The move is in the schedule history with the Admin as actor');
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000f032'), 'awaiting_transfer', 'Moving a pending booking leaves it pending');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f033'$$,
  $$values (85.00::numeric, 'due'::text)$$, 'A client-requested late move records the late fee as due');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000f034'$$,
  $$values (0.00::numeric, 'none'::text)$$, 'An Admin-requested move never charges the client');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000f031' and event_type = 'booking.rescheduled'), 1, 'One rescheduled event');

-- A second late move does not stack another fee.
update public.bookings set date = pg_temp.slot_date(interval '5 hours'), start_minutes = pg_temp.slot_start(interval '5 hours') where id = '00000000-0000-4000-8000-00000000f033';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select lives_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000f033', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f033'), pg_temp.slot_date(interval '10 days'), 720, 'client')$$, 'A second late client move is allowed');
reset role;
select is((select late_fee_due_gbp from public.bookings where id = '00000000-0000-4000-8000-00000000f033'), 85.00::numeric, 'A second late move does not add a second fee');

-- ---------------------------------------------------------------------------------------------
-- Settling fees and refunds
-- ---------------------------------------------------------------------------------------------
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f040', 'confirmed', interval '3 days', 'bank_transfer', 'paid');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select lives_ok($$select public.admin_settle_late_fee('00000000-0000-4000-8000-00000000f020', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f020'), 'received')$$, 'A due fee can be marked received');
select lives_ok($$select public.admin_settle_late_fee('00000000-0000-4000-8000-00000000f024', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f024'), 'waive')$$, 'A due fee can be waived');
select throws_ok($$select public.admin_settle_late_fee('00000000-0000-4000-8000-00000000f020', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f020'), 'received')$$,
  'PT409', 'Booking state changed', 'A fee that is no longer due cannot be settled again');
select throws_ok($$select public.admin_settle_late_fee('00000000-0000-4000-8000-00000000f021', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f021'), 'maybe')$$,
  '22023', 'Missing command arguments', 'Only received or waive are accepted');
select lives_ok($$select public.admin_record_refund('00000000-0000-4000-8000-00000000f025', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f025'), pg_temp.pv('00000000-0000-4000-8000-00000000f025'))$$, 'A refund owed can be recorded as sent');
select throws_ok($$select public.admin_record_refund('00000000-0000-4000-8000-00000000f040', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-00000000f040'), pg_temp.pv('00000000-0000-4000-8000-00000000f040'))$$,
  'PT409', 'Booking state changed', 'No refund can be recorded where none is owed');
reset role;
select results_eq($$select late_fee_status, late_fee_due_gbp from public.bookings where id = '00000000-0000-4000-8000-00000000f020'$$,
  $$values ('received'::text, 85.00::numeric)$$, 'Received keeps the amount');
select results_eq($$select late_fee_status, late_fee_due_gbp, late_fee_standard_gbp from public.bookings where id = '00000000-0000-4000-8000-00000000f024'$$,
  $$values ('waived'::text, 0.00::numeric, 85.00::numeric)$$, 'Waived clears the amount and keeps the standard fee');
select results_eq($$select p.status, b.refund_due_gbp from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = '00000000-0000-4000-8000-00000000f025'$$,
  $$values ('refunded'::text, 0.00::numeric)$$, 'The payment is refunded and nothing remains owed');

-- ---------------------------------------------------------------------------------------------
-- Schedule history is append-only and Admin-readable only
-- ---------------------------------------------------------------------------------------------
select throws_ok($$update public.booking_schedule_changes set to_start_minutes = 0$$, '42501', 'Booking status history is append-only', 'Schedule history cannot be edited');
select throws_ok($$delete from public.booking_schedule_changes$$, '42501', 'Booking status history is append-only', 'Schedule history cannot be deleted');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
select is((select count(*)::integer from public.booking_schedule_changes), 0, 'Other users see no schedule history');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select ok((select count(*) from public.booking_schedule_changes) > 0, 'The Admin can read schedule history');
reset role;

select * from finish();
rollback;
