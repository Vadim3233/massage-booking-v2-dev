begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(30);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000f101', 'authenticated', 'authenticated', 'clients-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000f102', 'authenticated', 'authenticated', 'clients-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f101');
insert into public.clients(id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000f201', 'Maya', 'Margin', 'maya@example.test', '+44 7700 900201'),
  ('00000000-0000-4000-8000-00000000f202', 'Noor', 'Neighbour', 'noor@example.test', '+44 7700 900202');
insert into public.client_addresses(id, client_id, address_line_1, city, postcode, is_default) values
  ('00000000-0000-4000-8000-00000000f301', '00000000-0000-4000-8000-00000000f201', '1 First Street', 'London', 'SW1A 1AA', true),
  ('00000000-0000-4000-8000-00000000f302', '00000000-0000-4000-8000-00000000f201', '2 Second Street', 'London', 'SW1A 2AA', false),
  ('00000000-0000-4000-8000-00000000f303', '00000000-0000-4000-8000-00000000f202', '3 Third Street', 'London', 'SW1A 3AA', true);

create function pg_temp.booking(p_id uuid, p_status text, p_day_offset integer, p_payment text, p_total numeric default 100) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, cancelled_at)
  select p_id, 'CLI-' || p_id, '00000000-0000-4000-8000-00000000f201', id, ((now() at time zone 'Europe/London')::date + p_day_offset), 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, p_total, p_total, case when p_status = 'cancelled' then now() end
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, case when p_payment = 'awaiting_transfer' then 'bank_transfer' else 'cash' end, p_payment, p_total, case when p_payment = 'paid' then now() end);
end;
$$;
select pg_temp.booking('00000000-0000-4000-8000-00000000f401', 'completed', -30, 'paid', 100);
select pg_temp.booking('00000000-0000-4000-8000-00000000f402', 'completed', -10, 'paid', 80);
select pg_temp.booking('00000000-0000-4000-8000-00000000f403', 'confirmed', 5, 'approved', 100);
select pg_temp.booking('00000000-0000-4000-8000-00000000f404', 'awaiting_transfer', 9, 'awaiting_transfer', 60);
select pg_temp.booking('00000000-0000-4000-8000-00000000f405', 'cancelled', 12, 'rejected', 90);
update public.bookings set late_fee_status = 'due', late_fee_due_gbp = 90, late_fee_standard_gbp = 90 where id = '00000000-0000-4000-8000-00000000f405';
update public.bookings set refund_due_gbp = 25 where id = '00000000-0000-4000-8000-00000000f402';

select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_update_client', 'admin_client_summary', 'admin_set_default_address')
    and has_function_privilege('anon', p.oid, 'EXECUTE')), 'Anonymous callers cannot use the client commands');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_update_client', 'admin_client_summary', 'admin_set_default_address')
    and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'They are definers with an empty search path');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f102","role":"authenticated"}', true);
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"X","email":"x@example.test"}')$$, '42501', 'Admin authorization required', 'A client cannot edit a client');
select throws_ok($$select public.admin_client_summary('00000000-0000-4000-8000-00000000f201')$$, '42501', 'Admin authorization required', 'A client cannot read a summary');
select throws_ok($$select public.admin_set_default_address('00000000-0000-4000-8000-00000000f201', '00000000-0000-4000-8000-00000000f302')$$, '42501', 'Admin authorization required', 'A client cannot change a default address');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f101","role":"authenticated"}', true);

-- Editing a client
select is((select first_name || ' ' || last_name || ' / ' || email || ' / ' || phone from public.admin_update_client('00000000-0000-4000-8000-00000000f201',
  '{"first_name":" Maya ","last_name":"Marginson","email":"MAYA.M@Example.test","phone":"07700 900 301"}')), 'Maya Marginson / maya.m@example.test / 07700 900 301', 'The Admin can change a client''s details, tidied');
select is((select normalized_email from public.clients where id = '00000000-0000-4000-8000-00000000f201'), 'maya.m@example.test', 'The lookup email follows');
select is((select normalized_phone from public.clients where id = '00000000-0000-4000-8000-00000000f201'), '07700900301', 'The lookup phone follows');
select lives_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"Maya","last_name":"Marginson","email":"maya.m@example.test","phone":"07700 900 301"}')$$, 'Saving a client with their own email and phone is not a duplicate');
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"Maya","email":"noor@example.test"}')$$, 'PT409', 'Another client already uses this email or phone.', 'Another client''s email is refused');
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"Maya","phone":"+44 7700 900202"}')$$, 'PT409', 'Another client already uses this email or phone.', 'Another client''s phone is refused, however it is typed');
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"","email":"maya@example.test"}')$$, '22023', 'Name and a valid email or phone are required', 'A name is required');
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"Maya"}')$$, '22023', 'Name and a valid email or phone are required', 'Some way to reach the client is required');
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"Maya","email":"not-an-email"}')$$, '22023', 'Name and a valid email or phone are required', 'The email must look like an email');
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000f201', '{"first_name":"Maya","email":"m@example.test","online_booking_enabled":false}')$$, '22023', 'Invalid client details', 'Only the four contact fields can be changed here');
select throws_ok($$select * from public.admin_update_client(gen_random_uuid(), '{"first_name":"Maya","email":"m@example.test"}')$$, 'P0002', 'Client unavailable', 'An unknown client is refused');
select results_eq($$select first_name from public.clients where id = '00000000-0000-4000-8000-00000000f202'$$, $$values ('Noor'::text)$$, 'The other client is untouched');

-- The summary
select results_eq($$select (s->>'completed_visits')::int, (s->>'upcoming')::int, (s->>'paid_gbp')::numeric, (s->>'late_fees_due_gbp')::numeric, (s->>'refunds_due_gbp')::numeric
  from (select public.admin_client_summary('00000000-0000-4000-8000-00000000f201') s) q$$,
  $$values (2, 2, 180::numeric, 90::numeric, 25::numeric)$$, 'The summary counts visits, upcoming bookings, money paid, fees due and refunds due');
select is((public.admin_client_summary('00000000-0000-4000-8000-00000000f201')->'next_booking'->>'id'), '00000000-0000-4000-8000-00000000f403', 'The next booking is the soonest open one');
select ok((public.admin_client_summary('00000000-0000-4000-8000-00000000f201')->>'last_visit')::date = (now() at time zone 'Europe/London')::date - 10, 'The last visit is the most recent completed one');
select results_eq($$select (s->>'completed_visits')::int, (s->>'paid_gbp')::numeric, s->'next_booking' from (select public.admin_client_summary('00000000-0000-4000-8000-00000000f202') s) q$$,
  $$values (0, 0::numeric, 'null'::jsonb)$$, 'A client with no bookings has an empty, honest summary');
select throws_ok($$select public.admin_client_summary(gen_random_uuid())$$, 'P0002', 'Client unavailable', 'An unknown client has no summary');

-- Default address
select lives_ok($$select public.admin_set_default_address('00000000-0000-4000-8000-00000000f201', '00000000-0000-4000-8000-00000000f302')$$, 'The default address can be changed');
select results_eq($$select id, is_default from public.client_addresses where client_id = '00000000-0000-4000-8000-00000000f201' order by id$$,
  $$values ('00000000-0000-4000-8000-00000000f301'::uuid, false), ('00000000-0000-4000-8000-00000000f302'::uuid, true)$$, 'Exactly one default remains, and it is the new one');
select is((select is_default from public.client_addresses where id = '00000000-0000-4000-8000-00000000f303'), true, 'Another client''s default is not touched');
select throws_ok($$select public.admin_set_default_address('00000000-0000-4000-8000-00000000f201', '00000000-0000-4000-8000-00000000f303')$$, '22023', 'Address does not belong to this client', 'An address of someone else cannot be made the default');
select lives_ok($$select public.admin_set_default_address('00000000-0000-4000-8000-00000000f201', '00000000-0000-4000-8000-00000000f302')$$, 'Choosing the current default again is harmless');

-- Notes and addresses, directly
select lives_ok($$insert into public.client_notes(client_id, author_user_id, note) values ('00000000-0000-4000-8000-00000000f201', '00000000-0000-0000-0000-00000000f101', 'Prefers firm pressure on shoulders')$$, 'The Admin can add a note');
select lives_ok($$delete from public.client_addresses where id = '00000000-0000-4000-8000-00000000f301'$$, 'The Admin can remove an address');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f102","role":"authenticated"}', true);
select is((select count(*)::integer from public.client_notes), 0, 'Nobody else can read the Admin''s notes');
reset role;

select * from finish();
rollback;
