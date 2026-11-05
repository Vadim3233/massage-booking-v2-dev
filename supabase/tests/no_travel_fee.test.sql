begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(18);

-- Fixtures: an Admin (who also has a client record of their own), a client with "No travel fee", an ordinary client, an area with a £12 travel fee
-- and £18 congestion, a second area with a £7 travel fee, and a £85 treatment.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000c801', 'authenticated', 'authenticated', 'ntf-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000c802', 'authenticated', 'authenticated', 'ntf-free@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000c803', 'authenticated', 'authenticated', 'ntf-paying@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c801');
insert into public.clients(id, first_name, last_name, email, auth_user_id, no_travel_fee) values
  ('00000000-0000-4000-8000-00000000c901', 'Free', 'Travel', 'ntf-free@example.test', '00000000-0000-0000-0000-00000000c802', true),
  ('00000000-0000-4000-8000-00000000c902', 'Paying', 'Travel', 'ntf-paying@example.test', '00000000-0000-0000-0000-00000000c803', false),
  ('00000000-0000-4000-8000-00000000c903', 'Admin', 'Own', 'ntf-admin@example.test', '00000000-0000-0000-0000-00000000c801', true);
insert into public.client_addresses(id, client_id, address, is_default)
  values ('00000000-0000-4000-8000-00000000ca01', '00000000-0000-4000-8000-00000000c901', '1 Test Street, London, SW3 1AA', true);
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-0000-0000-00000000c101', 'ntf-treatment', 'NTF treatment', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values ('00000000-0000-0000-0000-00000000c101', 60, 85, true);
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values
  ('00000000-0000-0000-0000-00000000c102', 'ntf-area', 'NTF area', true, 12, 18, 990),
  ('00000000-0000-0000-0000-00000000c103', 'ntf-area-two', 'NTF area two', true, 7, 0, 991);
update public.service_areas set postcodes = '{}';

create function pg_temp.sessions() returns jsonb language sql as $$
  select '[{"service_id":"00000000-0000-0000-0000-00000000c101","duration_minutes":60,"recipient_name":"Free"}]'::jsonb $$;
grant execute on function pg_temp.sessions() to authenticated;

select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'no_travel_fee'),
  'false', 'Every client pays the travel fee unless the Admin says otherwise');

-- A client signed in to their own account.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c802","role":"authenticated"}', true);
select is((select array[travel_fee_gbp, congestion_fee_gbp, total_gbp] from public.quote_client_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions())),
  array[0, 18, 103]::numeric[], 'A client with No travel fee is quoted no travel fee, and still the congestion charge');
update public.clients set no_travel_fee = false where id = '00000000-0000-4000-8000-00000000c901';
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000c901' and not no_travel_fee), 0,
  'A client cannot switch it off (or on) themselves');
select throws_ok($$select * from public.compute_client_booking_quote('00000000-0000-0000-0000-00000000c102', pg_temp.sessions(), '{}', '00000000-0000-4000-8000-00000000c901')$$,
  '42501', null, 'A client cannot ask for another client''s quote');
select throws_ok($$select * from public.admin_quote_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions(), '{}', '00000000-0000-4000-8000-00000000c901')$$,
  '42501', 'Admin authorization required', 'Nor use the Admin''s quote');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c803","role":"authenticated"}', true);
select is((select array[travel_fee_gbp, total_gbp] from public.quote_client_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions())),
  array[12, 115]::numeric[], 'Any other client pays the travel fee as before');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select array[travel_fee_gbp, total_gbp] from public.quote_client_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions())),
  array[12, 115]::numeric[], 'Someone not signed in pays the travel fee');

-- The Admin.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c801","role":"authenticated"}', true);
select is((select array[travel_fee_gbp, total_gbp] from public.admin_quote_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions(), '{}', '00000000-0000-4000-8000-00000000c901')),
  array[0, 103]::numeric[], 'The Admin''s quote for this client has no travel fee');
select is((select array[travel_fee_gbp, total_gbp] from public.admin_quote_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions(), '{}', '00000000-0000-4000-8000-00000000c902')),
  array[12, 115]::numeric[], 'The Admin''s quote for another client has it');
select is((select array[travel_fee_gbp, total_gbp] from public.admin_quote_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions())),
  array[12, 115]::numeric[], 'With no client named, the Admin''s own client record does not count');

create temp table t_booking as select * from public.admin_create_booking(jsonb_build_object(
  'client_id', '00000000-0000-4000-8000-00000000c901', 'saved_address_id', '00000000-0000-4000-8000-00000000ca01',
  'service_area_id', '00000000-0000-0000-0000-00000000c102', 'sessions', pg_temp.sessions(),
  'date', (clock_timestamp() at time zone 'Europe/London')::date + 40, 'start_minutes', 600, 'payment_arrangement', 'bank_pending', 'any_time', true),
  gen_random_uuid());
select is((select total_gbp from t_booking), 103.00::numeric, 'The Admin''s booking for this client comes to the price without travel');
reset role;
select is((select array[b.travel_fee_gbp, b.congestion_fee_gbp, b.total_gbp, p.amount_gbp] from public.bookings b join public.booking_payments p on p.booking_id = b.id
  where b.id = (select booking_id from t_booking)), array[0, 18, 103, 103]::numeric[], 'And is saved with no travel fee, and the payment asked for matches');
select is((select (payload->>'total_gbp')::numeric from public.event_outbox where event_type = 'booking.created' and aggregate_id = (select booking_id from t_booking)),
  103.00::numeric, 'What the client is told says the same');

-- Edit address into another area.
set local role authenticated;
select lives_ok(format($$select public.admin_change_booking_address(%L, gen_random_uuid(), %L, '2 Other Street, London', null, '00000000-0000-0000-0000-00000000c103')$$,
  (select booking_id from t_booking), (select updated_at from public.bookings where id = (select booking_id from t_booking))), 'The Admin moves the booking to another area');
reset role;
select is((select array[travel_fee_gbp, congestion_fee_gbp, total_gbp] from public.bookings where id = (select booking_id from t_booking)),
  array[0, 0, 85]::numeric[], 'The new area brings its congestion charge but, for this client, still no travel fee');

-- Switching it off brings the fee back for new bookings only.
update public.clients set no_travel_fee = false where id = '00000000-0000-4000-8000-00000000c901';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c802","role":"authenticated"}', true);
select is((select travel_fee_gbp from public.quote_client_booking('00000000-0000-0000-0000-00000000c102', pg_temp.sessions())), 12.00::numeric,
  'Switched off, the client is quoted the travel fee again');
reset role;
select is((select total_gbp from public.bookings where id = (select booking_id from t_booking)), 85.00::numeric, 'A booking already made keeps its price');

select ok(not has_function_privilege('authenticated', 'public.compute_area_booking_quote(uuid,jsonb,uuid[])', 'EXECUTE'), 'The area-only quote stays private');

select * from finish();
rollback;
