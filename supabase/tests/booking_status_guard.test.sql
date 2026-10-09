begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(37);

-- Structure and privileges.
select has_table('public', 'booking_status_events', 'History table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.booking_status_events'::regclass), 'History has RLS enabled');
select ok(not has_table_privilege('authenticated', 'public.booking_status_events', 'INSERT,UPDATE,DELETE,TRUNCATE'), 'Signed-in users cannot write history');
select ok(not has_table_privilege('anon', 'public.booking_status_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'), 'Anonymous users have no history access');
select ok(has_table_privilege('authenticated', 'public.booking_status_events', 'SELECT'), 'Signed-in users can read history subject to the Admin policy');
select ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('guard_booking_status_change', 'guard_booking_payment_status_change', 'record_booking_status_event', 'reject_booking_status_event_change')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
), 'Trigger functions are not callable by browser roles');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where proname = 'record_booking_status_event' and pronamespace = 'public'::regnamespace), 'Recorder is a definer with an empty search path');

-- Fixtures.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000009001', 'authenticated', 'authenticated', 'status-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000009002', 'authenticated', 'authenticated', 'status-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-000000009001');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-000000009001', 'Status', 'Test');

create temporary table fx_area as select id, name from public.service_areas where slug = 'chelsea';

create function pg_temp.new_booking(p_id uuid, p_status text)
returns void language sql as $$
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, payment_reservation_expires_at)
  select p_id, 'GUARD-' || p_id, '00000000-0000-4000-8000-000000009001', id, '2031-05-05', 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name,
    case when p_status = 'awaiting_transfer' then now() + interval '1 hour' end
  from fx_area;
$$;

-- Creation records the first event without a previous status.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000a001', 'awaiting_cash_approval');
insert into public.booking_payments(id, booking_id, method, status, amount_gbp)
values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'cash', 'awaiting_approval', 85);
select results_eq(
  $q$select entity, from_status, to_status, actor_type from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000a001' order by entity$q$,
  $q$values ('booking'::text, null::text, 'awaiting_cash_approval'::text, 'system'::text), ('payment', null, 'awaiting_approval', 'system')$q$,
  'Creating a booking and payment records initial events');

-- Legal booking path, recorded in order.
update public.bookings set booking_status = 'confirmed' where id = '00000000-0000-4000-8000-00000000a001';
update public.bookings set booking_status = 'completed' where id = '00000000-0000-4000-8000-00000000a001';
select results_eq(
  $q$select from_status, to_status from public.booking_status_events where entity = 'booking' and booking_id = '00000000-0000-4000-8000-00000000a001' order by occurred_at, id$q$,
  $q$values (null::text, 'awaiting_cash_approval'::text), ('awaiting_cash_approval', 'confirmed'), ('confirmed', 'completed')$q$,
  'Booking history follows the legal path');

-- Illegal booking transitions are rejected and leave the row unchanged.
select throws_ok($$update public.bookings set booking_status = 'confirmed' where id = '00000000-0000-4000-8000-00000000a001'$$,
  '22023', 'Booking status change not allowed: completed to confirmed', 'A completed booking cannot be reopened');
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000a001'), 'completed', 'Rejected change leaves status as it was');

select pg_temp.new_booking('00000000-0000-4000-8000-00000000a002', 'awaiting_cash_approval');
select throws_ok($$update public.bookings set booking_status = 'completed' where id = '00000000-0000-4000-8000-00000000a002'$$,
  '22023', 'Booking status change not allowed: awaiting_cash_approval to completed', 'Approval cannot be skipped');
select throws_ok($$update public.bookings set booking_status = 'no_show' where id = '00000000-0000-4000-8000-00000000a002'$$,
  '22023', 'Booking status change not allowed: awaiting_cash_approval to no_show', 'Unconfirmed booking cannot be a no-show');
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000a002';
select throws_ok($$update public.bookings set booking_status = 'confirmed', cancelled_at = null where id = '00000000-0000-4000-8000-00000000a002'$$,
  '22023', 'Booking status change not allowed: cancelled to confirmed', 'A cancelled booking stays cancelled');

select pg_temp.new_booking('00000000-0000-4000-8000-00000000a003', 'awaiting_transfer');
update public.bookings set booking_status = 'awaiting_payment_verification' where id = '00000000-0000-4000-8000-00000000a003';
select throws_ok($$update public.bookings set booking_status = 'awaiting_transfer' where id = '00000000-0000-4000-8000-00000000a003'$$,
  '22023', 'Booking status change not allowed: awaiting_payment_verification to awaiting_transfer', 'A declared transfer cannot go back to awaiting transfer');
update public.bookings set booking_status = 'confirmed' where id = '00000000-0000-4000-8000-00000000a003';
update public.bookings set booking_status = 'no_show' where id = '00000000-0000-4000-8000-00000000a003';
select throws_ok($$update public.bookings set booking_status = 'completed' where id = '00000000-0000-4000-8000-00000000a003'$$,
  '22023', 'Booking status change not allowed: no_show to completed', 'A no-show is final');

-- Payment transitions.
update public.booking_payments set status = 'approved' where id = '00000000-0000-4000-8000-00000000b001';
select throws_ok($$update public.booking_payments set status = 'awaiting_approval' where id = '00000000-0000-4000-8000-00000000b001'$$,
  '22023', 'Payment status change not allowed: approved to awaiting_approval', 'Approval cannot be undone');
update public.booking_payments set status = 'paid', paid_at = now() where id = '00000000-0000-4000-8000-00000000b001';
select throws_ok($$update public.booking_payments set status = 'approved', paid_at = null where id = '00000000-0000-4000-8000-00000000b001'$$,
  '22023', 'Payment status change not allowed: paid to approved', 'A paid payment cannot go back');
update public.booking_payments set status = 'refunded' where id = '00000000-0000-4000-8000-00000000b001';
select ok((select paid_at is not null from public.booking_payments where id = '00000000-0000-4000-8000-00000000b001'), 'Refund keeps the original payment date');
select throws_ok($$update public.booking_payments set status = 'paid', paid_at = now() where id = '00000000-0000-4000-8000-00000000b001'$$,
  '22023', 'Payment status change not allowed: refunded to paid', 'A refund is final');

insert into public.booking_payments(id, booking_id, method, status, amount_gbp)
values ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a002', 'cash', 'awaiting_approval', 85);
select throws_ok($$update public.booking_payments set status = 'paid', paid_at = now() where id = '00000000-0000-4000-8000-00000000b002'$$,
  '22023', 'Payment status change not allowed: awaiting_approval to paid', 'Cash cannot be paid before it is approved');
update public.booking_payments set status = 'rejected' where id = '00000000-0000-4000-8000-00000000b002';
select throws_ok($$update public.booking_payments set status = 'approved' where id = '00000000-0000-4000-8000-00000000b002'$$,
  '22023', 'Payment status change not allowed: rejected to approved', 'A rejected payment stays rejected');

insert into public.booking_payments(id, booking_id, method, status, amount_gbp)
values ('00000000-0000-4000-8000-00000000b003', '00000000-0000-4000-8000-00000000a003', 'bank_transfer', 'awaiting_transfer', 85);
select lives_ok($$update public.booking_payments set status = 'awaiting_verification' where id = '00000000-0000-4000-8000-00000000b003'$$, 'Declaring a transfer is allowed');
select lives_ok($$update public.booking_payments set status = 'paid', paid_at = now() where id = '00000000-0000-4000-8000-00000000b003'$$, 'Verifying a declared transfer is allowed');

-- Updates that do not change a status add no history.
select is((select count(*)::integer from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000a003'), 7,
  'Booking and payment history for the transfer booking is complete');
update public.bookings set client_note = 'Gate code 1234' where id = '00000000-0000-4000-8000-00000000a003';
update public.bookings set booking_status = booking_status where id = '00000000-0000-4000-8000-00000000a003';
update public.booking_payments set status = status where id = '00000000-0000-4000-8000-00000000b003';
select is((select count(*)::integer from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000a003'), 7,
  'Note edits and no-op status writes add no history');

-- Actors are recorded from the caller, never supplied by it.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000a004', 'awaiting_cash_approval');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000009001","role":"authenticated"}', true);
update public.bookings set booking_status = 'confirmed' where id = '00000000-0000-4000-8000-00000000a004';
select results_eq(
  $q$select actor_type, actor_user_id, actor_role from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000a004' and to_status = 'confirmed'$q$,
  $q$values ('admin'::text, '00000000-0000-0000-0000-000000009001'::uuid, 'authenticated'::text)$q$,
  'Admin change records admin actor');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000009002","role":"authenticated"}', true);
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000a004';
select results_eq(
  $q$select actor_type, actor_user_id from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000a004' and to_status = 'cancelled'$q$,
  $q$values ('client'::text, '00000000-0000-0000-0000-000000009002'::uuid)$q$,
  'Client change records client actor');
select set_config('request.jwt.claims', '', true);

-- History is append-only, even for privileged roles.
select throws_ok($$update public.booking_status_events set to_status = 'confirmed'$$, '42501', 'Booking status history is append-only', 'History cannot be edited');
select throws_ok($$delete from public.booking_status_events$$, '42501', 'Booking status history is append-only', 'History cannot be deleted');
select throws_ok($$truncate public.booking_status_events$$, '42501', 'Booking status history is append-only', 'History cannot be truncated');

-- History survives deleting the booking.
select is((select count(*)::integer from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000a002'), 4, 'Cancelled booking has booking and payment history');
delete from public.bookings where id = '00000000-0000-4000-8000-00000000a002';
select is((select count(*)::integer from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000a002'), 4, 'History outlives the deleted booking');

-- Read access: Admin only.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000009001","role":"authenticated"}', true);
select ok((select count(*) from public.booking_status_events) > 0, 'Admin can read history');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000009002","role":"authenticated"}', true);
select is((select count(*)::integer from public.booking_status_events), 0, 'Other signed-in users see no history');
select throws_ok($$insert into public.booking_status_events(entity, booking_id, to_status, actor_type, actor_role) values ('booking', gen_random_uuid(), 'confirmed', 'admin', 'authenticated')$$,
  '42501', 'permission denied for table booking_status_events', 'Signed-in users cannot forge history');
set local role anon;
select throws_ok($$select count(*) from public.booking_status_events$$, '42501', 'permission denied for table booking_status_events', 'Anonymous users cannot read history');
reset role;

select * from finish();
rollback;
