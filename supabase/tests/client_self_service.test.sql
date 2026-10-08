begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(62);

-- ---------------------------------------------------------------------------------------------
-- Fixtures: two clients with accounts, flexible working days, and bookings in different situations.
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000a101', 'authenticated', 'authenticated', 'self-one@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000a102', 'authenticated', 'authenticated', 'self-two@example.test', now(), '{}', '{}', now(), now());
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000a201', '00000000-0000-0000-0000-00000000a101', 'Self', 'One', 'self-one@example.test'),
  ('00000000-0000-4000-8000-00000000a202', '00000000-0000-0000-0000-00000000a102', 'Self', 'Two', 'self-two@example.test');

create function pg_temp.slot_date(p_offset interval) returns date language sql as $$
  select ((now() + p_offset) at time zone 'Europe/London')::date;
$$;
create function pg_temp.slot_start(p_offset interval) returns integer language sql as $$
  select (floor((extract(hour from (now() + p_offset) at time zone 'Europe/London') * 60
    + extract(minute from (now() + p_offset) at time zone 'Europe/London')) / 30) * 30)::integer;
$$;
create function pg_temp.new_booking(p_id uuid, p_client uuid, p_status text, p_offset interval, p_method text, p_payment text,
  p_created_ago interval default interval '3 days') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, created_at)
  select p_id, 'SELF-' || p_id, p_client, id, pg_temp.slot_date(p_offset), pg_temp.slot_start(p_offset), 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85, now() - p_created_ago
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, p_method, p_payment, 85, case when p_payment = 'paid' then now() end);
end;
$$;
create function pg_temp.set_claims(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.slot_date(interval '1 day' * d), true, 600, 1200, 'flexible' from unnest(array[0, 1, 5, 6, 7, 8, 9, 10, 40, 41]) d;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('get_my_change_terms', 'get_my_booking_availability', 'list_my_bookings', 'client_cancel_booking', 'client_reschedule_booking')
    and has_function_privilege('anon', p.oid, 'EXECUTE')), 'Anonymous callers cannot use any client booking command');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('change_fee_gbp', 'apply_booking_cancellation', 'apply_booking_reschedule', 'client_booking_for_change')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'The shared internals are not callable from the browser');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('get_my_change_terms', 'get_my_booking_availability', 'list_my_bookings', 'client_cancel_booking', 'client_reschedule_booking')
    and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'Client commands are definers with an empty search path');

-- ---------------------------------------------------------------------------------------------
-- Bookings: far away (pending and confirmed), inside 24 hours, just booked, started, someone else's
-- ---------------------------------------------------------------------------------------------
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '5 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a201', 'awaiting_transfer', interval '6 days', 'bank_transfer', 'awaiting_transfer');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b003', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b004', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '5 hours', 'cash', 'approved', interval '30 minutes');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b005', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '-3 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b006', '00000000-0000-4000-8000-00000000a202', 'confirmed', interval '7 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b007', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '8 days', 'bank_transfer', 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b008', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '5 hours', 'bank_transfer', 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b009', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '5 hours', 'cash', 'approved');

set local role authenticated;
select pg_temp.set_claims('00000000-0000-0000-0000-00000000a101');

-- ---------------------------------------------------------------------------------------------
-- Listing and terms
-- ---------------------------------------------------------------------------------------------
select is(jsonb_array_length(public.list_my_bookings()), 8, 'A client lists only their own bookings');
select ok(not (public.list_my_bookings() @> '[{"id":"00000000-0000-4000-8000-00000000b006"}]'::jsonb), 'Another client''s booking is not listed');
select ok((public.list_my_bookings()->0) ? 'booking_reference' and (public.list_my_bookings()->0) ? 'payment_status', 'Listing returns booking summaries with payment status');
select is(public.get_my_change_terms('00000000-0000-4000-8000-00000000b001')->>'can_change', 'true', 'A future booking can be changed');
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000b001')->>'cancel_fee_gbp')::numeric, 0::numeric, 'No fee well in advance');
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000b003')->>'cancel_fee_gbp')::numeric, 85::numeric, 'Full price inside 24 hours');
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000b003')->>'reschedule_fee_gbp')::numeric, 85::numeric, 'A move inside 24 hours also records the full price');
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000b004')->>'cancel_fee_gbp')::numeric, 0::numeric, 'Within an hour of booking there is no fee');
select is(public.get_my_change_terms('00000000-0000-4000-8000-00000000b005')->>'can_change', 'false', 'A started appointment cannot be changed online');
select ok((select (public.get_my_change_terms('00000000-0000-4000-8000-00000000b001')->>'free_until')::timestamptz
  = ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') - interval '24 hours' from public.bookings b where b.id = '00000000-0000-4000-8000-00000000b001'),
  'Free until 24 hours before the appointment');
select ok((select (public.get_my_change_terms('00000000-0000-4000-8000-00000000b004')->>'free_until')::timestamptz
  = b.created_at + interval '1 hour' from public.bookings b where b.id = '00000000-0000-4000-8000-00000000b004'),
  'A just-made booking is free until the end of its first hour');
select throws_ok($$select public.get_my_change_terms('00000000-0000-4000-8000-00000000b006')$$, '42501', 'Booking is not available to this client', 'A client cannot read terms for someone else''s booking');

-- ---------------------------------------------------------------------------------------------
-- Available times for changing a booking
-- ---------------------------------------------------------------------------------------------
select ok(exists (select 1 from public.get_my_booking_availability('00000000-0000-4000-8000-00000000b001', pg_temp.slot_date(interval '9 days'))), 'Times are offered on a free day');
select ok(exists (select 1 from public.get_my_booking_availability('00000000-0000-4000-8000-00000000b001', pg_temp.slot_date(interval '5 days')) where start_minutes = pg_temp.slot_start(interval '5 days') + 60 + 60),
  'On its own day the booking does not block itself');
select ok(not exists (select 1 from public.get_my_booking_availability('00000000-0000-4000-8000-00000000b001', pg_temp.slot_date(interval '0 days'))
  where ((pg_temp.slot_date(interval '0 days') + make_interval(mins => start_minutes)) at time zone 'Europe/London') < now() + interval '2 hours'),
  'Nothing is offered inside two hours of now');
select ok(exists (select 1 from public.get_my_booking_availability('00000000-0000-4000-8000-00000000b001', pg_temp.slot_date(interval '40 days'))), 'Forty days ahead is allowed');
select is((select count(*)::integer from public.get_my_booking_availability('00000000-0000-4000-8000-00000000b001', pg_temp.slot_date(interval '41 days'))), 0, 'Forty-one days ahead is not offered');
select throws_ok($$select * from public.get_my_booking_availability('00000000-0000-4000-8000-00000000b006', current_date + 9)$$, '42501', 'Booking is not available to this client', 'Times cannot be listed for someone else''s booking');

-- ---------------------------------------------------------------------------------------------
-- Cancel
-- ---------------------------------------------------------------------------------------------
create temp table req(name text primary key, id uuid);
insert into req select n, gen_random_uuid() from unnest(array['c1', 'c3', 'r1']) n;
grant select on req to authenticated;

select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000b001', (select id from req where name = 'c1'), 0, 'Plans changed')->>'booking_status', 'cancelled', 'A client can cancel a future booking');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000b001', (select id from req where name = 'c1'), 0, 'Plans changed')->>'booking_status', 'cancelled', 'Retrying the same request is safe');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b002', (select id from req where name = 'c1'), 0, 'Another booking, same key')$$, '22023', 'Request key reused', 'A request key cannot be reused for something else');
select lives_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b002', gen_random_uuid(), 0)$$, 'A pending booking can be cancelled, with the default reason');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b003', gen_random_uuid(), 0)$$,
  'PT409', 'The late fee has changed. Please review it and confirm again.', 'Cancelling inside 24 hours without acknowledging the fee is refused');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000b003', (select id from req where name = 'c3'), 85)->>'late_fee_due_gbp', '85.00', 'Acknowledging the fee inside 24 hours cancels and records it as due');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000b004', gen_random_uuid(), 0)->>'late_fee_status', 'none', 'A booking made within the hour cancels free even inside 24 hours');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b005', gen_random_uuid(), 0)$$, '22023', 'This appointment has already started. Please contact Vad.', 'A started appointment cannot be cancelled online');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b006', gen_random_uuid(), 0)$$, '42501', 'Booking is not available to this client', 'A client cannot cancel someone else''s booking');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b001', gen_random_uuid(), 0)$$, 'PT409', 'This booking can no longer be changed online. Please contact Vad.', 'A cancelled booking cannot be cancelled again');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b007', gen_random_uuid(), 0, repeat('x', 501))$$, '22023', 'Please keep the reason under 500 characters', 'A very long reason is refused');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000b008', gen_random_uuid(), 85)->>'refund_due_gbp', '0.00', 'A paid booking cancelled late keeps the fee and owes no refund');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000b007', gen_random_uuid(), 0)->>'refund_due_gbp', '85.00', 'A paid booking cancelled in good time is owed a full refund');
reset role;

select results_eq($$select booking_status, cancellation_initiated_by, cancelled_by_actor_type, cancelled_by_actor_id, cancellation_reason from public.bookings where id = '00000000-0000-4000-8000-00000000b001'$$,
  $$values ('cancelled'::text, 'client'::text, 'client'::text, '00000000-0000-0000-0000-00000000a101'::text, 'Plans changed'::text)$$, 'The cancellation records the client as the actor');
select is((select status from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000b001'), 'rejected', 'The unpaid payment is closed');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000b001' and event_type = 'booking.cancelled'), 1, 'One cancellation event despite the retry');
select results_eq($$select payload->>'initiated_by', payload->>'source' from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000b003' and event_type = 'booking.cancelled'$$,
  $$values ('client'::text, 'client'::text)$$, 'The event says the client did it, so the Admin can be told');
select results_eq($$select actor_type, to_status from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000b003' and entity = 'booking' and to_status = 'cancelled'$$,
  $$values ('client'::text, 'cancelled'::text)$$, 'The status history shows a client actor');

-- ---------------------------------------------------------------------------------------------
-- Reschedule
-- ---------------------------------------------------------------------------------------------
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b010', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '6 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000b012', '00000000-0000-4000-8000-00000000a201', 'confirmed', interval '5 hours', 'cash', 'approved');
set local role authenticated;
select pg_temp.set_claims('00000000-0000-0000-0000-00000000a101');
create temp table target as select pg_temp.slot_date(interval '9 days') as d, (select min(start_minutes) from public.get_my_booking_availability('00000000-0000-4000-8000-00000000b010', pg_temp.slot_date(interval '9 days'))) as m;
grant select on target to authenticated;

select is(public.client_reschedule_booking('00000000-0000-4000-8000-00000000b010', (select id from req where name = 'r1'), (select d from target), (select m from target), 0)->>'booking_status', 'confirmed', 'A client can move a far-off booking to an offered time');
select is(public.client_reschedule_booking('00000000-0000-4000-8000-00000000b010', (select id from req where name = 'r1'), (select d from target), (select m from target), 0)->>'booking_status', 'confirmed', 'Retrying the same move is safe');
select throws_ok($$select public.client_reschedule_booking('00000000-0000-4000-8000-00000000b010', gen_random_uuid(), pg_temp.slot_date(interval '41 days'), 600, 0)$$,
  '22023', 'Online appointments can currently be arranged up to 40 days ahead. Please choose another date.', 'A move beyond 40 days is refused');
select throws_ok($$select public.client_reschedule_booking('00000000-0000-4000-8000-00000000b010', gen_random_uuid(), pg_temp.slot_date(interval '9 days'), 615, 0)$$,
  '22023', 'Please choose a start time on the hour or half hour.', 'Only 30-minute starts are accepted');
select throws_ok($$select public.client_reschedule_booking('00000000-0000-4000-8000-00000000b010', gen_random_uuid(), pg_temp.slot_date(interval '9 days'), 1170, 0)$$,
  'PT409', 'This time is not available. Please choose another time.', 'A time outside the offered list is refused');
select throws_ok($$select public.client_reschedule_booking('00000000-0000-4000-8000-00000000b006', gen_random_uuid(), pg_temp.slot_date(interval '9 days'), 600, 0)$$,
  '42501', 'Booking is not available to this client', 'A client cannot move someone else''s booking');
select throws_ok($$select public.client_reschedule_booking('00000000-0000-4000-8000-00000000b011', gen_random_uuid(), pg_temp.slot_date(interval '10 days'), 600, 0)$$,
  'PT409', 'The late fee has changed. Please review it and confirm again.', 'A late move needs the fee acknowledged');
select is(public.client_reschedule_booking('00000000-0000-4000-8000-00000000b011', gen_random_uuid(), pg_temp.slot_date(interval '10 days'), 600, 85)->>'late_fee_due_gbp', '85.00', 'Acknowledging the fee moves the booking and records it as due');
select is(public.client_reschedule_booking('00000000-0000-4000-8000-00000000b012', gen_random_uuid(), pg_temp.slot_date(interval '10 days'), 720, 85)->>'late_fee_status', 'due', 'A second late booking is charged on its own');
select throws_ok($$select public.client_reschedule_booking('00000000-0000-4000-8000-00000000b005', gen_random_uuid(), pg_temp.slot_date(interval '10 days'), 840, 0)$$,
  '22023', 'This appointment has already started. Please contact Vad.', 'A started appointment cannot be moved online');
reset role;

select results_eq($$select date, start_minutes from public.bookings where id = '00000000-0000-4000-8000-00000000b010'$$,
  $$select d, m from target$$, 'The booking moved to the chosen time');
select results_eq($$select actor_type, to_start_minutes from public.booking_schedule_changes where booking_id = '00000000-0000-4000-8000-00000000b010'$$,
  $$select 'client'::text, m from target$$, 'The schedule history shows a client actor');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000b010' and event_type = 'booking.rescheduled'), 1, 'One rescheduled event despite the retry');
select results_eq($$select late_fee_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000b010'$$,
  $$values (0.00::numeric, 'none'::text)$$, 'A move in good time is free');

-- A second late change after a fee is already recorded adds nothing.
update public.bookings set date = pg_temp.slot_date(interval '5 hours'), start_minutes = pg_temp.slot_start(interval '5 hours') where id = '00000000-0000-4000-8000-00000000b011';
set local role authenticated;
select pg_temp.set_claims('00000000-0000-0000-0000-00000000a101');
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000b011')->>'reschedule_fee_gbp')::numeric, 0::numeric, 'Once a late fee is recorded, a further change adds no second fee');
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000b011')->>'cancel_fee_gbp')::numeric, 85::numeric, 'Cancelling is still quoted at the standard fee');
reset role;

-- ---------------------------------------------------------------------------------------------
-- The signed-out and the wrong signed-in user
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok($$select public.list_my_bookings()$$, '42501', 'Authentication required', 'A session without a user cannot list bookings');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000b009', gen_random_uuid(), 0)$$, '42501', 'Authentication required', 'A session without a user cannot cancel');
select pg_temp.set_claims('00000000-0000-0000-0000-00000000a102');
select is(jsonb_array_length(public.list_my_bookings()), 1, 'The second client sees only their own booking');
reset role;
set local role anon;
select throws_ok($$select public.list_my_bookings()$$, '42501', 'permission denied for function list_my_bookings', 'Anonymous role is denied');
reset role;

-- The Admin cancellation still works through the shared internals.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000a1ad', 'authenticated', 'authenticated', 'self-admin@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a1ad');
set local role authenticated;
select pg_temp.set_claims('00000000-0000-0000-0000-00000000a1ad');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000b009', gen_random_uuid(),
  (select updated_at from public.bookings where id = '00000000-0000-4000-8000-00000000b009'),
  (select updated_at from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000b009'), 'Admin check', 'client')$$, 'The Admin cancel command still works');
select lives_ok($$select public.admin_reschedule_booking('00000000-0000-4000-8000-00000000b006', gen_random_uuid(),
  (select updated_at from public.bookings where id = '00000000-0000-4000-8000-00000000b006'), pg_temp.slot_date(interval '6 days'), 840, 'admin')$$, 'The Admin reschedule command still works');
reset role;
select results_eq($$select late_fee_due_gbp, cancelled_by_actor_type from public.bookings where id = '00000000-0000-4000-8000-00000000b009'$$,
  $$values (85.00::numeric, 'admin'::text)$$, 'The Admin cancellation recorded the Admin as the actor and the fee');

select * from finish();
rollback;
