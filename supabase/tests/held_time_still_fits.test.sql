begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(5);

-- On a Chain day, a client's valid hold can be reserved even once other clients have booked around it (ADR-090).
insert into auth.users(id, aud, role, email, email_confirmed_at, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000f901', 'authenticated', 'authenticated', 'chain-a@example.test', now(), false, '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000f902', 'authenticated', 'authenticated', null, null, true, '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000f903', 'authenticated', 'authenticated', 'chain-c@example.test', now(), false, '{}', '{}', now(), now());
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000f911', '00000000-0000-0000-0000-00000000f901', 'Ada', 'Chain', 'chain-a@example.test', '+44 7700 900911'),
  ('00000000-0000-4000-8000-00000000f913', '00000000-0000-0000-0000-00000000f903', 'Cy', 'Chain', 'chain-c@example.test', '+44 7700 900913'),
  ('00000000-0000-4000-8000-00000000f919', null, 'Xavi', 'Booked', null, null);
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000f921', 'chain-fit-service', 'Chain Fit Service', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values ('00000000-0000-4000-8000-00000000f921', 60, 85, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order)
values ('00000000-0000-4000-8000-00000000f931', 'chain-fit-area', 'Chain Fit Area', true, 0, 0, 990);

select set_config('test.day', ((now() at time zone 'Europe/London')::date + 12)::text, true);
delete from public.calendar_blocks where date = current_setting('test.day')::date;
delete from public.working_hours_overrides where date = current_setting('test.day')::date;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, schedule_mode)
values (current_setting('test.day')::date, true, 600, 1320, 'flexible', 'chain');
-- Someone already booked at 15:00.
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp)
values ('00000000-0000-4000-8000-00000000f941', 'CHAIN-X', '00000000-0000-4000-8000-00000000f919', '00000000-0000-4000-8000-00000000f931',
  current_setting('test.day')::date, 900, 60, 'confirmed', 'test', '1 Test Road', 'Chain Fit Area', 85, 85);
insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at) values ('00000000-0000-4000-8000-00000000f941', 'bank_transfer', 'paid', 85, now());

create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.reserve(p_hold_id uuid, p_token uuid, p_key text) returns uuid language plpgsql as $$
declare r record;
begin
  select * into r from public.finalize_client_booking(p_hold_id, p_token, p_key,
    '00000000-0000-4000-8000-00000000f931', '[{"service_id":"00000000-0000-4000-8000-00000000f921","duration_minutes":60}]',
    '{}', null, '1 Chain Road', null, 'London', 'sw1a1aa', null, null, 'bank_transfer', 'chain-fit-' || p_key);
  return r.booking_id;
end;
$$;

-- A holds 17:00, the end of the run after the 15:00 booking.
select pg_temp.as_user('00000000-0000-0000-0000-00000000f901');
set local role authenticated;
create temp table hold_a as select * from public.create_booking_hold(current_setting('test.day')::date, 1020, 60, 'chain-fit-key-a-000000000001');
reset role;
-- B, a guest, is then offered and holds 19:00, after A.
select pg_temp.as_user('00000000-0000-0000-0000-00000000f902');
set local role authenticated;
select ok(exists (select 1 from public.get_booking_availability(current_setting('test.day')::date, 60) where start_minutes = 1140), 'B is offered 19:00, after A''s hold');
create temp table hold_b as select * from public.create_booking_hold(current_setting('test.day')::date, 1140, 60, 'chain-fit-key-b-000000000001');
reset role;
select ok(not exists (select 1 from public.compute_booking_availability(current_setting('test.day')::date, 60, now(), 60, (select hold_id from hold_a), null)
  where start_minutes = 1020), 'With A set aside, 17:00 is no longer an end of the run');

-- A can still reserve the time they hold.
select pg_temp.as_user('00000000-0000-0000-0000-00000000f901');
set local role authenticated;
select ok(pg_temp.reserve((select hold_id from hold_a), (select hold_token from hold_a), 'chain-fit-key-a-000000000001') is not null,
  'A reserves the held 17:00 although it is boxed in');
reset role;

-- C holds 13:00 (the start of the run), then the Admin blocks that time: it no longer fits, so it is refused.
select pg_temp.as_user('00000000-0000-0000-0000-00000000f903');
set local role authenticated;
create temp table hold_c as select * from public.create_booking_hold(current_setting('test.day')::date, 780, 60, 'chain-fit-key-c-000000000001');
reset role;
insert into public.calendar_blocks(date, start_minutes, end_minutes, kind, title)
values (current_setting('test.day')::date, 780, 840, 'blocked', 'Chain fit block');
select set_config('test.hold_c', (select hold_id::text || ',' || hold_token::text from hold_c), true);
select pg_temp.as_user('00000000-0000-0000-0000-00000000f903');
set local role authenticated;
select throws_ok($$select pg_temp.reserve(split_part(current_setting('test.hold_c'), ',', 1)::uuid, split_part(current_setting('test.hold_c'), ',', 2)::uuid, 'chain-fit-key-c-000000000001')$$,
  '23P01', 'Time slot is no longer available', 'A held time that blocked time now covers is refused');
reset role;
select is((select count(*)::integer from public.bookings where date = current_setting('test.day')::date and booking_status <> 'cancelled'), 2,
  'Only the 15:00 booking and A''s booking exist');

select * from finish();
rollback;
