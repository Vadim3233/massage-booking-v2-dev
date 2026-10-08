begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(19);

select set_config(
  'test.finalize_date1',
  ((now() at time zone 'Europe/London')::date + 10)::text,
  true
);
select set_config(
  'test.finalize_date2',
  ((now() at time zone 'Europe/London')::date + 11)::text,
  true
);

-- Catalogue fixtures.
insert into public.services (id, slug, name, active, display_order)
values (
  '00000000-0000-0000-0000-000000004001',
  'quote-finalize-test-service',
  'Quote Finalize Test Service',
  true,
  990
);

insert into public.service_duration_prices (
  service_id, duration_minutes, price_gbp, active
)
values
  ('00000000-0000-0000-0000-000000004001', 60, 85, true),
  ('00000000-0000-0000-0000-000000004001', 90, 115, true),
  ('00000000-0000-0000-0000-000000004001', 120, 160, true);

insert into public.service_areas (
  id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order
)
values (
  '00000000-0000-0000-0000-000000004101',
  'quote-finalize-test-area',
  'Quote Finalize Test Area',
  true,
  12,
  8,
  990
);

insert into public.enhancements (
  id, slug, name, price_gbp, duration_minutes, active, display_order
)
values (
  '00000000-0000-0000-0000-000000004201',
  'quote-finalize-test-enhancement',
  'Quote Finalize Test Enhancement',
  10,
  15,
  true,
  990
);

insert into public.session_preferences (
  id, slug, label, category, active, display_order
)
values (
  '00000000-0000-0000-0000-000000004301',
  'quote-finalize-test-preference',
  'More neck',
  'Focus area',
  true,
  990
);

-- Future scheduling fixture.
delete from public.working_hours_overrides
where date in (
  current_setting('test.finalize_date1')::date,
  current_setting('test.finalize_date2')::date
);

insert into public.working_hours_overrides (
  date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes
)
values
  (current_setting('test.finalize_date1')::date, true, 600, 1200, 'flexible', null),
  (current_setting('test.finalize_date2')::date, true, 600, 1200, 'flexible', null);

-- Auth/client fixture.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000004401',
  'authenticated',
  'authenticated',
  'finalize-client@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into public.clients (
  id, auth_user_id, first_name, last_name, email, phone
)
values (
  '00000000-0000-0000-0000-000000004501',
  '00000000-0000-0000-0000-000000004401',
  'Finalize',
  'Client',
  'finalize-client@example.test',
  '+44 7700 900555'
);


select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000004401',true);
create function pg_temp.reserve(p_key text) returns uuid language plpgsql as $$
declare h record; r record;
begin
 select * into h from public.create_booking_hold(current_setting('test.finalize_date1')::date,600,60,'payment-reserve-browser-00001');
 select * into r from public.finalize_client_booking(h.hold_id,h.hold_token,'payment-reserve-browser-00001',
 '00000000-0000-0000-0000-000000004101','[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60}]',
 '{}',null,'1 Canonical Road','Flat 2','London','sw1a1aa',null,null,'bank_transfer',p_key);
 return r.booking_id;
end; $$;
create temp table payment_ids as select pg_temp.reserve('payment-provisional-0001') id;
grant select on payment_ids to authenticated,anon;
select is((select booking_status from public.bookings where id=(select id from payment_ids)),'awaiting_transfer','initial booking awaits transfer');
select is((select status from public.booking_payments where booking_id=(select id from payment_ids)),'awaiting_transfer','initial payment awaits transfer');
select ok((select payment_reservation_expires_at is null from public.bookings where id=(select id from payment_ids)),'pending transfer has no deadline');
select is((select booking_email_snapshot from public.bookings where id=(select id from payment_ids)),'finalize-client@example.test','canonical client email snapshotted');
select ok(not exists(select 1 from public.get_booking_availability(current_setting('test.finalize_date1')::date,60) where start_minutes=600),'live provisional reservation blocks slot');
select ok(not exists(select 1 from public.compute_booking_availability(current_setting('test.finalize_date1')::date,60,now()+interval '9 days',60,null) where start_minutes=600),'unconfirmed transfer keeps its time long after the old 60-minute deadline');
set local role authenticated;
select ok(not (public.get_my_booking((select id from payment_ids)) ?| array['reservation_expired','payment_reservation_expires_at']),'read model carries no reservation deadline');
reset role;
-- A different day, so the refusal comes from the booking limit rather than the occupied slot.
select set_config('test.finalize_date0',current_setting('test.finalize_date1'),true);
select set_config('test.finalize_date1',current_setting('test.finalize_date2'),true);
select throws_ok($q$select pg_temp.reserve('payment-provisional-0002')$q$,'22023','Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.','a pending first booking still counts toward the first-booking limit');
select set_config('test.finalize_date1',current_setting('test.finalize_date0'),true);
set local role anon;
select throws_ok($q$select public.declare_my_bank_transfer((select id from payment_ids))$q$,'42501','permission denied for function declare_my_bank_transfer','anonymous callers cannot declare');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000004402',true);
set local role authenticated;
select throws_ok($q$select public.declare_my_bank_transfer((select id from payment_ids))$q$,'42501','Booking is not available to this client','other clients cannot declare');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000004401',true);
set local role authenticated;
select is(public.declare_my_bank_transfer((select id from payment_ids))->'booking_payments'->>'status','awaiting_verification','declaration awaits verification');
select is(public.declare_my_bank_transfer((select id from payment_ids))->'booking_payments'->>'status','awaiting_verification','declaration retry is idempotent');
reset role;
select ok((select paid_at is null and status<>'paid' from public.booking_payments where booking_id=(select id from payment_ids)),'client declaration never marks paid');
select is((select count(*)::integer from public.event_outbox where aggregate_id=(select id from payment_ids) and event_type='booking.transfer_declared'),1,'only one declaration event');
select ok(not exists(select 1 from public.compute_booking_availability(current_setting('test.finalize_date1')::date,60,now()+interval '9 days',60,null) where start_minutes=600),'declared transfer remains occupied indefinitely');
set local role authenticated;
select is(public.declare_my_bank_transfer((select id from payment_ids))->'booking_payments'->>'status','awaiting_verification','declaration retry stays valid');
reset role;
-- Administrator completion permits another booking for this returning client.
update public.bookings set booking_status='confirmed' where id=(select id from payment_ids);
update public.bookings set booking_status='completed' where id=(select id from payment_ids);
update public.booking_payments set status='paid',paid_at=now() where booking_id=(select id from payment_ids);
-- A fresh date is used so the completed appointment does not conflict.
select set_config('test.finalize_date1',current_setting('test.finalize_date2'),true);
truncate payment_ids;
insert into payment_ids select pg_temp.reserve('payment-provisional-0003');
set local role authenticated;
select is(public.confirm_my_cash_booking((select id from payment_ids))->'booking_payments'->>'status','awaiting_approval','cash request awaits approval');
select is(public.confirm_my_cash_booking((select id from payment_ids))->'booking_payments'->>'method','cash','cash retry reuses same booking');
reset role;
select ok((select payment_reservation_expires_at is null from public.bookings where id=(select id from payment_ids)), 'cash confirmation removes provisional expiry');
select * from finish();
rollback;
