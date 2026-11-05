begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(11);

-- Fixtures: two clients, one of them let off the minimum. Chelsea and Mayfair are seeded areas; postcodes are cleared so only the minimum is tested.
insert into public.clients(id, first_name, last_name, email, no_minimum_booking) values
  ('00000000-0000-4000-8000-00000000c901', 'Mini', 'Mum', 'minimum-client@example.test', false),
  ('00000000-0000-4000-8000-00000000c902', 'Free', 'Length', 'minimum-free@example.test', true);
update public.service_areas set postcodes = '{}';
update public.service_areas set minimum_booking_minutes = 120 where slug = 'chelsea';
update public.service_areas set minimum_booking_minutes = null where slug = 'mayfair';

create function pg_temp.book(p_id uuid, p_area text, p_minutes integer, p_client uuid default '00000000-0000-4000-8000-00000000c901',
  p_actor text default 'client')
returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, created_by_actor_type, address_snapshot, service_area_name_snapshot, service_subtotal_gbp, enhancements_total_gbp,
    travel_fee_gbp, congestion_fee_gbp, total_gbp, booking_email_snapshot)
  select p_id, 'MIN-' || right(p_id::text, 4), p_client, a.id, (now() at time zone 'Europe/London')::date + 30, 600, p_minutes,
    'awaiting_transfer', 'test', p_actor, '1 Test Street, London', a.name, 90, 0, 0, 0, 90, 'minimum-client@example.test'
  from public.service_areas a where a.slug = p_area;
end; $$;

select is(public.minimum_booking_words(120), '2 hours', 'Two hours in words');
select is(public.minimum_booking_words(90), '1 hour 30 minutes', 'Ninety minutes in words');
select throws_ok($$update public.service_areas set minimum_booking_minutes = 0 where slug = 'fulham'$$, '23514', null, 'A minimum of nothing is refused (off is empty)');

select throws_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000d001', 'chelsea', 60)$$, '22023',
  'In Chelsea the minimum booking is 2 hours in total (two people''s times add up). Please choose a longer time.', 'A client''s hour in Chelsea is refused, with the minimum');
select throws_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000d002', 'chelsea', 90)$$, '22023', null, '90 minutes is still under 2 hours');
select lives_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000d003', 'chelsea', 120)$$, 'Two hours (one person, or two people of an hour each) is fine');
select lives_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000d004', 'chelsea', 180)$$, 'Longer is fine');
select lives_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000d005', 'mayfair', 60)$$, 'An area with no minimum takes an hour');
select lives_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000d006', 'chelsea', 60, '00000000-0000-4000-8000-00000000c902')$$,
  'A client Vadim let off the minimum can book an hour');
select lives_ok($$select pg_temp.book('00000000-0000-4000-8000-00000000d007', 'chelsea', 60, '00000000-0000-4000-8000-00000000c901', 'admin')$$,
  'A booking the Admin makes is not checked');

-- Clients read their own record but cannot let themselves off the minimum.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000c801', 'authenticated', 'authenticated', 'minimum-client@example.test', now(), '{}', '{}', now(), now());
update public.clients set auth_user_id = '00000000-0000-0000-0000-00000000c801' where id = '00000000-0000-4000-8000-00000000c901';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c801","role":"authenticated"}', true);
update public.clients set no_minimum_booking = true where id = '00000000-0000-4000-8000-00000000c901';
reset role;
select is((select no_minimum_booking from public.clients where id = '00000000-0000-4000-8000-00000000c901'), false, 'A client cannot switch the minimum off for themselves');

select * from finish();
rollback;
