begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(34);

-- Fixtures: an Admin, a client, and a booking helper. Chelsea, Mayfair, Paddington and Notting Hill are seeded areas; Mayfair has an £18 congestion charge.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000a801', 'authenticated', 'authenticated', 'area-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000a802', 'authenticated', 'authenticated', 'area-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a801');
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000a901', 'Postie', 'Code', 'area-client@example.test');
update public.service_areas set postcodes = '{}';
update public.service_areas set travel_surcharge_gbp = 0, congestion_fee_gbp = 18 where slug = 'mayfair';

create function pg_temp.area(p_slug text) returns uuid language sql as $$ select id from public.service_areas where slug = p_slug $$;
create function pg_temp.book(p_id uuid, p_area text, p_address text, p_actor text default 'client', p_status text default 'awaiting_transfer',
  p_payment text default 'awaiting_transfer', p_day integer default 30)
returns text language plpgsql as $$
declare v_check text;
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, created_by_actor_type, address_snapshot, service_area_name_snapshot, service_subtotal_gbp, enhancements_total_gbp,
    travel_fee_gbp, congestion_fee_gbp, total_gbp, booking_email_snapshot)
  select p_id, 'AREA-' || right(p_id::text, 4), '00000000-0000-4000-8000-00000000a901', a.id, (now() at time zone 'Europe/London')::date + p_day, 600, 60,
    p_status, 'test', p_actor, p_address, a.name, 90, 0, a.travel_surcharge_gbp, a.congestion_fee_gbp, 90 + a.travel_surcharge_gbp + a.congestion_fee_gbp,
    'area-client@example.test'
  from public.service_areas a where a.slug = p_area
  returning area_check into v_check;
  insert into public.booking_payments(booking_id, method, status, amount_gbp, payment_reference, paid_at)
    select p_id, case when p_payment in ('awaiting_approval', 'approved') then 'cash' else 'bank_transfer' end, p_payment, total_gbp, booking_reference,
      case when p_payment = 'paid' then now() end
    from public.bookings where id = p_id;
  return v_check;
end; $$;

-- Reading a postcode out of an address.
select is(public.address_postcode('12 King''s Road, London, sw31aa'), 'SW3 1AA', 'A postcode is found without its space and in small letters');
select is(public.address_postcode('Flat 2, 1 Park Lane, W1K 1PN, London'), 'W1K 1PN', 'A postcode in the middle of the address is found');
select is(public.address_postcode('1 High Street, London'), null, 'No postcode, nothing found');

-- Before any area has postcodes, nothing is checked.
select is(pg_temp.book('00000000-0000-4000-8000-00000000b001', 'chelsea', '1 Mile End Road, E1 4NS'), null, 'With no postcodes set up, a client booking is not marked');

-- An area's postcodes are tidied, checked, and belong to one area only.
update public.service_areas set postcodes = array[' sw3', 'SW10', 'sw3 '] where slug = 'chelsea';
select is((select postcodes from public.service_areas where slug = 'chelsea'), array['SW10', 'SW3'], 'The list is tidied: capitals, no repeats, in order');
select throws_ok($$update public.service_areas set postcodes = array['Chelsea'] where slug = 'fulham'$$, '22023',
  '"CHELSEA" is not the start of a postcode. Write a district such as SW3 or W1, or a sector such as W2 1.', 'Something that is not a postcode is refused');
select throws_ok($$update public.service_areas set postcodes = array['SW6', 'SW10'] where slug = 'fulham'$$, '22023',
  'SW10 is already in Chelsea. A postcode can be in one area only.', 'One district cannot be in two areas');
update public.service_areas set postcodes = array['W1'] where slug = 'mayfair';
update public.service_areas set postcodes = array['W2 1'] where slug = 'paddington';
update public.service_areas set postcodes = array['W2', 'W11'] where slug = 'notting-hill';

-- Which area a postcode is in: the narrowest match wins, and W1 covers W1K.
select is(public.postcode_area('SW3 4LP'), pg_temp.area('chelsea'), 'SW3 4LP is in Chelsea');
select is(public.postcode_area('w1k 1pn'), pg_temp.area('mayfair'), 'W1K 1PN is in Mayfair, through W1');
select is(public.postcode_area('W2 1AB'), pg_temp.area('paddington'), 'The sector W2 1 wins over the district W2');
select is(public.postcode_area('W2 5XX'), pg_temp.area('notting-hill'), 'The rest of W2 is in Notting Hill');
select is(public.postcode_area('E1 4NS'), null, 'A postcode in no area has none');
update public.service_areas set active = false where slug = 'notting-hill';
select is(public.postcode_area('W2 5XX'), null, 'A hidden area covers nothing');
update public.service_areas set active = true where slug = 'notting-hill';

-- The check on a client's booking.
select is(pg_temp.book('00000000-0000-4000-8000-00000000b002', 'chelsea', '5 Cheyne Walk, London SW3 5LR'), null, 'A postcode in the chosen area is not marked');
select is(pg_temp.book('00000000-0000-4000-8000-00000000b003', 'chelsea', '1 Mile End Road, London, E1 4NS'), 'outside', 'A postcode in no area is marked outside');
select is(pg_temp.book('00000000-0000-4000-8000-00000000b004', 'chelsea', '5 Cheyne Walk, London'), 'no_postcode', 'An address with no postcode is marked');
select throws_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000b005', 'chelsea', '1 Park Lane, W1K 1PN')$$, '22023',
  'W1K 1PN is in Mayfair, not Chelsea. Please go back to the first step and choose Mayfair.', 'A postcode in another area is refused, with the area to choose');
select is(pg_temp.book('00000000-0000-4000-8000-00000000b006', 'chelsea', '1 Mile End Road, E1 4NS', 'admin'), null, 'A booking the Admin makes is not checked');

-- The Admin is told why the request needs a look.
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.created', 'booking', '00000000-0000-4000-8000-00000000b003', 'area-test-created-b003', '{}'),
         ('booking.created', 'booking', '00000000-0000-4000-8000-00000000b004', 'area-test-created-b004', '{}');
select is((select title from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id
  where o.deduplication_key = 'area-test-created-b003' and d.channel = 'in_app'), 'New booking request, outside your areas', 'The request outside the areas says so');
select matches((select body from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id
  where o.deduplication_key = 'area-test-created-b003' and d.channel = 'in_app'), 'E1 4NS is outside your areas', 'and names the postcode');
select is((select title from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id
  where o.deduplication_key = 'area-test-created-b004' and d.channel = 'in_app'), 'New booking request, no postcode', 'The request with no postcode says so');

-- get_my_booking tells the booking screens.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a802","role":"authenticated"}', true);
reset role;
update public.clients set auth_user_id = '00000000-0000-0000-0000-00000000a802' where id = '00000000-0000-4000-8000-00000000a901';
set local role authenticated;
select is(public.get_my_booking('00000000-0000-4000-8000-00000000b003')->>'area_check', 'outside', 'The client''s booking says it is outside the areas');

-- Edit address.
reset role;
select pg_temp.book('00000000-0000-4000-8000-00000000b010', 'chelsea', '5 Cheyne Walk, SW3 5LR', 'client', 'confirmed', 'paid', 31);
select pg_temp.book('00000000-0000-4000-8000-00000000b011', 'chelsea', '5 Cheyne Walk, SW3 5LR', 'client', 'completed', 'paid', 32);
create temp table keys as select gen_random_uuid() as k1, gen_random_uuid() as k2;
grant select on keys to authenticated;
create function pg_temp.version(p_id uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = p_id $$;
grant execute on function pg_temp.version(uuid) to authenticated;
set local role authenticated;

select ok(not has_function_privilege('anon', 'public.admin_change_booking_address(uuid,uuid,timestamptz,text,text,uuid)', 'EXECUTE'), 'Anonymous callers cannot change an address');
select throws_ok($$select public.admin_change_booking_address('00000000-0000-4000-8000-00000000b003', gen_random_uuid(), pg_temp.version('00000000-0000-4000-8000-00000000b003'),
  '1 Park Lane, W1K 1PN', null, pg_temp.area('mayfair'))$$, '42501', 'Admin authorization required', 'A client cannot change an address');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a801","role":"authenticated"}', true);
-- The request outside the areas turns out to be in Mayfair: the congestion charge is added, to the payment as well, and the mark goes.
select is(public.admin_change_booking_address('00000000-0000-4000-8000-00000000b003', (select k1 from keys), pg_temp.version('00000000-0000-4000-8000-00000000b003'),
  E'1 Park Lane\nLondon W1K 1PN', 'Ring flat 2', pg_temp.area('mayfair')), '00000000-0000-4000-8000-00000000b003'::uuid, 'The Admin changes the address');
reset role;
select results_eq($$select address_snapshot, postcode_snapshot, entry_instructions_snapshot, service_area_name_snapshot, congestion_fee_gbp, total_gbp, area_check
  from public.bookings where id = '00000000-0000-4000-8000-00000000b003'$$,
  $$values ('1 Park Lane, London W1K 1PN'::text, 'W1K 1PN'::text, 'Ring flat 2'::text, 'Mayfair'::text, 18.00::numeric, 108.00::numeric, null::text)$$,
  'The booking has the new address, area, fees and total, and is no longer marked');
select is((select amount_gbp from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000b003'), 108.00::numeric, 'The payment due follows the new total');
select matches((select body from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id
  where o.aggregate_id = '00000000-0000-4000-8000-00000000b003' and o.event_type = 'booking.address_changed' and d.channel = 'email'),
  '1 Park Lane, London W1K 1PN.*the price is now £108\.00 \(it was £90\.00\)', 'The client is emailed the new address and price');
select is((select count(*)::integer from public.calendar_sync_queue q where q.booking_id = '00000000-0000-4000-8000-00000000b003'), 1, 'The calendar copy is queued to follow');
set local role authenticated;

-- A paid booking can have its address put right, but not a new price.
select throws_ok($$select public.admin_change_booking_address('00000000-0000-4000-8000-00000000b010', gen_random_uuid(), pg_temp.version('00000000-0000-4000-8000-00000000b010'),
  '1 Park Lane, W1K 1PN', null, pg_temp.area('mayfair'))$$, '22023',
  'The client has already paid or sent £90.00, so the price cannot change. Keep the area as Chelsea, or sort out the difference with them first.', 'A paid booking cannot move to a dearer area');
select is(public.admin_change_booking_address('00000000-0000-4000-8000-00000000b010', (select k2 from keys), pg_temp.version('00000000-0000-4000-8000-00000000b010'),
  '7 Cheyne Walk, SW3 5LR', null, pg_temp.area('chelsea')), '00000000-0000-4000-8000-00000000b010'::uuid, 'A paid booking can have its address corrected in the same area');
select throws_ok($$select public.admin_change_booking_address('00000000-0000-4000-8000-00000000b011', gen_random_uuid(), pg_temp.version('00000000-0000-4000-8000-00000000b011'),
  '7 Cheyne Walk, SW3 5LR', null, pg_temp.area('chelsea'))$$, '22023', 'Only an appointment still to happen can have its address changed.', 'A completed booking cannot be changed');
select throws_ok($$select public.admin_change_booking_address('00000000-0000-4000-8000-00000000b010', gen_random_uuid(), now() - interval '1 day',
  '9 Cheyne Walk, SW3 5LR', null, pg_temp.area('chelsea'))$$, 'PT409', 'Booking state changed', 'A booking changed since it was read is not overwritten');
select throws_ok($$select public.admin_change_booking_address('00000000-0000-4000-8000-00000000b010', gen_random_uuid(), pg_temp.version('00000000-0000-4000-8000-00000000b010'),
  '   ', null, pg_temp.area('chelsea'))$$, '22023', 'Please write the address.', 'An empty address is refused');

select * from finish();
rollback;
