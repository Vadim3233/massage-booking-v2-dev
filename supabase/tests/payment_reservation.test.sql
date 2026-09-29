begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(21);

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
select is((select payment_reservation_expires_at-created_at from public.bookings where id=(select id from payment_ids)),interval '60 minutes','reservation lasts sixty minutes');
select is((select booking_email_snapshot from public.bookings where id=(select id from payment_ids)),'finalize-client@example.test','canonical client email snapshotted');
select ok(not exists(select 1 from public.get_booking_availability(current_setting('test.finalize_date1')::date,60) where start_minutes=600),'live provisional reservation blocks slot');
update public.bookings set payment_reservation_expires_at=now()-interval '1 second' where id=(select id from payment_ids);
select ok(exists(select 1 from public.get_booking_availability(current_setting('test.finalize_date1')::date,60) where start_minutes=600),'expired reservation frees slot without cleanup');
set local role authenticated;
select is(public.get_my_booking((select id from payment_ids))->>'reservation_expired','true','read model reports server expiry');
select throws_ok($q$select public.declare_my_bank_transfer((select id from payment_ids))$q$,'23P01','Your payment reservation has expired. Please choose another time.','expired reservation cannot be declared');
select throws_ok($q$select public.confirm_my_cash_booking((select id from payment_ids))$q$,'23P01','Your payment reservation has expired. Please choose another time.','expired reservation cannot convert to cash');
reset role;
truncate payment_ids;
insert into payment_ids select pg_temp.reserve('payment-provisional-0002');
select is((select count(*)::integer from public.bookings where client_id='00000000-0000-0000-0000-000000004501'),2,'expired reservation no longer consumes first-booking limit');
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
update public.bookings set payment_reservation_expires_at=now()-interval '1 second' where id=(select id from payment_ids);
select ok(not exists(select 1 from public.get_booking_availability(current_setting('test.finalize_date1')::date,60) where start_minutes=600),'declared transfer remains occupied after original deadline');
set local role authenticated;
select is(public.declare_my_bank_transfer((select id from payment_ids))->'booking_payments'->>'status','awaiting_verification','declaration retry remains valid after original deadline');
reset role;
-- Administrator completion permits another booking for this returning client.
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
