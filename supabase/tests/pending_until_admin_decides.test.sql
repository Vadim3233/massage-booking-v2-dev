begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(33);

-- Fixtures: an Admin, a client user, a client and one flexible working day per scenario.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000c001', 'authenticated', 'authenticated', 'pending-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000c002', 'authenticated', 'authenticated', 'pending-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c001');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000c101', 'Pending', 'Test');

create function pg_temp.london_day(p_offset integer) returns date language sql as $$
  select ((now() at time zone 'Europe/London')::date + p_offset);
$$;

insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.london_day(d), true, 600, 1200, 'flexible' from unnest(array[20, 21, 22, 23, 24, 40, 41, 200]) d;

create function pg_temp.new_booking(p_id uuid, p_status text, p_day integer, p_method text, p_payment_status text)
returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp)
  select p_id, 'PEND-' || p_id, '00000000-0000-4000-8000-00000000c101', id, pg_temp.london_day(p_day), 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp) values (p_id, p_method, p_payment_status, 85);
end;
$$;

select pg_temp.new_booking('00000000-0000-4000-8000-00000000d001', 'awaiting_transfer', 20, 'bank_transfer', 'awaiting_transfer');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d002', 'awaiting_payment_verification', 21, 'bank_transfer', 'awaiting_verification');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d003', 'awaiting_cash_approval', 22, 'cash', 'awaiting_approval');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d004', 'awaiting_transfer', 23, 'bank_transfer', 'awaiting_transfer');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d005', 'confirmed', 24, 'cash', 'approved');

create temp table versions as
  select b.id, b.updated_at as booking_version, p.updated_at as payment_version
  from public.bookings b join public.booking_payments p on p.booking_id = b.id
  where b.id::text like '00000000-0000-4000-8000-00000000d00%';
grant select on versions to authenticated, anon;

-- A booking waiting for payment holds its time, with no deadline of any kind.
select ok((select bool_and(payment_reservation_expires_at is null) from public.bookings where id::text like '00000000-0000-4000-8000-00000000d00%'),
  'Pending bookings carry no deadline');
select ok(not exists (select 1 from public.compute_booking_availability(pg_temp.london_day(20), 60, now() + interval '15 days', 60, null) where start_minutes = 600),
  'A pending transfer still holds its time 15 days later');
select ok(not exists (select 1 from public.get_booking_availability(pg_temp.london_day(20), 60) where start_minutes = 600),
  'Clients cannot take a time held by a pending transfer');

-- Horizon: 40 days for clients, none for the Admin availability computation.
select ok(exists (select 1 from public.get_booking_availability(pg_temp.london_day(40), 60)), 'Clients can see availability 40 days ahead');
select is((select count(*)::integer from public.get_booking_availability(pg_temp.london_day(41), 60)), 0, 'Clients see no availability 41 days ahead');
select lives_ok($$select * from public.create_booking_hold(pg_temp.london_day(40), 600, 60, 'pending-horizon-client-0001')$$, 'A client can hold a time 40 days ahead');
select throws_ok($$select * from public.create_booking_hold(pg_temp.london_day(41), 600, 60, 'pending-horizon-client-0002')$$,
  '22023', 'Online appointments can currently be arranged up to 40 days ahead. Please choose an earlier date.', 'A client cannot hold a time 41 days ahead');
select ok(exists (select 1 from public.compute_booking_availability(pg_temp.london_day(200), 60, now(), 60, null)),
  'The underlying availability calculation has no horizon (used by Admin booking)');

-- Command surface and privileges.
select has_function('public', 'admin_remove_pending_booking', array['uuid', 'uuid', 'timestamp with time zone', 'timestamp with time zone']);
select ok(not has_function_privilege('anon', 'public.admin_remove_pending_booking(uuid,uuid,timestamptz,timestamptz)', 'EXECUTE'), 'Anonymous callers cannot remove bookings');
select ok(has_function_privilege('authenticated', 'public.admin_remove_pending_booking(uuid,uuid,timestamptz,timestamptz)', 'EXECUTE'), 'Signed-in callers reach the command, which checks for Admin itself');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c002","role":"authenticated"}', true);
select throws_ok($$select public.admin_remove_pending_booking('00000000-0000-4000-8000-00000000d001', gen_random_uuid(), (select booking_version from versions where id = '00000000-0000-4000-8000-00000000d001'), (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d001'))$$,
  '42501', 'Admin authorization required', 'A client cannot remove a booking');
select throws_ok($$select * from public.admin_payment_review_queue(0)$$, '42501', 'Admin authorization required', 'A client cannot read the review queue');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c001","role":"authenticated"}', true);

-- The queue lists all three kinds of pending booking, and not confirmed ones.
select results_eq($$select id from public.admin_payment_review_queue(0) where id::text like '00000000-0000-4000-8000-00000000d00%' order by date$$,
  $$values ('00000000-0000-4000-8000-00000000d001'::uuid), ('00000000-0000-4000-8000-00000000d002'), ('00000000-0000-4000-8000-00000000d003'), ('00000000-0000-4000-8000-00000000d004')$$,
  'Review queue lists undeclared transfers, declared transfers and cash requests');

-- Removing an undeclared transfer.
create temp table remove_request as select gen_random_uuid() as id;
grant select on remove_request to authenticated;
select is(public.admin_remove_pending_booking('00000000-0000-4000-8000-00000000d001', (select id from remove_request),
  (select booking_version from versions where id = '00000000-0000-4000-8000-00000000d001'), (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d001')),
  '00000000-0000-4000-8000-00000000d001'::uuid, 'Admin can remove an undeclared transfer booking');
select is(public.admin_remove_pending_booking('00000000-0000-4000-8000-00000000d001', (select id from remove_request),
  (select booking_version from versions where id = '00000000-0000-4000-8000-00000000d001'), (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d001')),
  '00000000-0000-4000-8000-00000000d001'::uuid, 'Retrying the same request is safe');
reset role;
select results_eq($$select booking_status, cancelled_by_actor_type, cancelled_by_actor_id, cancelled_at is not null from public.bookings where id = '00000000-0000-4000-8000-00000000d001'$$,
  $$values ('cancelled'::text, 'admin'::text, '00000000-0000-0000-0000-00000000c001'::text, true)$$, 'Removal records a cancellation by the Admin');
select is((select status from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000d001'), 'rejected', 'Removal rejects the payment record');
select ok(exists (select 1 from public.get_booking_availability(pg_temp.london_day(20), 60) where start_minutes = 600), 'Removal releases the time');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000d001' and event_type = 'booking.pending_removed'), 1, 'One removal event despite the retry');
select results_eq($$select entity, from_status, to_status, actor_type from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000d001' and to_status in ('cancelled', 'rejected') order by entity$$,
  $$values ('booking'::text, 'awaiting_transfer'::text, 'cancelled'::text, 'admin'::text), ('payment', 'awaiting_transfer', 'rejected', 'admin')$$,
  'Removal is recorded in the status history');

-- Removing a declared transfer and a cash request; stale and confirmed bookings are refused.
set local role authenticated;
select lives_ok($$select public.admin_remove_pending_booking('00000000-0000-4000-8000-00000000d002', gen_random_uuid(),
  (select booking_version from versions where id = '00000000-0000-4000-8000-00000000d002'), (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d002'))$$,
  'Admin can remove a declared transfer booking');
select lives_ok($$select public.admin_remove_pending_booking('00000000-0000-4000-8000-00000000d003', gen_random_uuid(),
  (select booking_version from versions where id = '00000000-0000-4000-8000-00000000d003'), (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d003'))$$,
  'Admin can remove a cash request');
select throws_ok($$select public.admin_remove_pending_booking('00000000-0000-4000-8000-00000000d005', gen_random_uuid(),
  (select booking_version from versions where id = '00000000-0000-4000-8000-00000000d005'), (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d005'))$$,
  'PT409', 'Booking state changed', 'A confirmed booking cannot be removed this way');
select throws_ok($$select public.admin_remove_pending_booking('00000000-0000-4000-8000-00000000d004', gen_random_uuid(), now() - interval '1 day',
  (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d004'))$$,
  'PT409', 'Booking state changed', 'A stale booking version is refused');
select is((select count(*)::integer from public.admin_payment_review_queue(0) where id::text like '00000000-0000-4000-8000-00000000d00%'), 1, 'Only the untouched pending booking remains in the queue');

-- Confirming a transfer the client never declared.
select is(public.admin_verify_bank_transfer('00000000-0000-4000-8000-00000000d004', gen_random_uuid(),
  (select booking_version from versions where id = '00000000-0000-4000-8000-00000000d004'), (select payment_version from versions where id = '00000000-0000-4000-8000-00000000d004')),
  '00000000-0000-4000-8000-00000000d004'::uuid, 'Admin can confirm a transfer the client has not declared');
reset role;
select results_eq($$select b.booking_status, p.status, p.paid_at is not null, p.verified_by from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = '00000000-0000-4000-8000-00000000d004'$$,
  $$values ('confirmed'::text, 'paid'::text, true, '00000000-0000-0000-0000-00000000c001'::uuid)$$, 'The booking is confirmed and the payment recorded as paid');
select is((select transfer_declared_at from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000d004'), null, 'The client never declared, and the record does not pretend they did');
select results_eq($$select from_status, to_status from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000d004' and entity = 'booking' order by occurred_at, id$$,
  $$values (null::text, 'awaiting_transfer'::text), ('awaiting_transfer', 'confirmed')$$, 'The direct confirmation is in the status history');

-- The status guard still forbids moving a removed booking backwards.
select throws_ok($$update public.bookings set booking_status = 'confirmed', cancelled_at = null where id = '00000000-0000-4000-8000-00000000d001'$$,
  '22023', 'Booking status change not allowed: cancelled to confirmed', 'A removed booking stays removed');

-- Clients no longer receive any deadline fields.
select ok(not exists (
  select 1 from pg_proc where proname in ('get_my_booking', 'complete_client_payment', 'finalize_client_booking')
    and pronamespace = 'public'::regnamespace and prosrc like '%reservation_expired%'),
  'Client functions no longer mention a reservation deadline');
select ok(not exists (select 1 from pg_constraint where conname = 'bookings_transfer_expiry_required'), 'The deadline requirement constraint is gone');

select * from finish();
rollback;
