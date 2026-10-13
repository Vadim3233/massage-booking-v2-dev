begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(91);

-- People. d101 is the Admin; d111 and d112 are real logins; d121 and d122 are guest sessions.
insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d101', 'authenticated', 'authenticated', 'delete-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d111', 'authenticated', 'authenticated', 'dee.delete@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d112', 'authenticated', 'authenticated', 'eli.delete@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false);
insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
select '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000d' || n)::uuid, 'authenticated', 'authenticated', null, '', null, '{"provider":"anonymous","providers":[]}', '{}', now(), now(), true
from unnest(array['121', '122']) n;
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d101');

-- The tests are not disturbed by held times left over from other work on this database.
delete from public.booking_holds;

create function pg_temp.today_plus(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
create function pg_temp.as_user(p_user uuid, p_anonymous boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', p_anonymous)::text, true);
end;
$$;
create function pg_temp.booking(p_id uuid, p_client uuid) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp)
  select p_id, 'DELC-' || p_id, p_client, id, pg_temp.today_plus(-9), 600, 60, 'completed', 'test', '1 Test Road', 'London', 'SW1A 1AA', name, 100, 100
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at) values (p_id, 'cash', 'paid', 100, now());
end;
$$;
-- What the page would have been told, to be handed back to the delete command.
create function pg_temp.expect(p_client uuid) returns jsonb language sql as $$ select public.admin_client_delete_check(p_client); $$;
create function pg_temp.alerts_by_key(p_key text) returns integer language sql as $$
  select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.deduplication_key = p_key;
$$;

-- The clients. d201 has everything hanging off it and nothing that stops it going; d208 is the same shape and must be left alone.
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000d201', null, 'Hugo', 'Pell', 'hugo.delete@example.test', '07911 123901'),
  ('00000000-0000-4000-8000-00000000d202', '00000000-0000-0000-0000-00000000d111', 'Dee', 'Lete', 'dee.delete@example.test', '07911 123902'),
  ('00000000-0000-4000-8000-00000000d203', '00000000-0000-0000-0000-00000000d121', 'Gus', 'Guest', 'gus.delete@example.test', '07911 123903'),
  ('00000000-0000-4000-8000-00000000d204', null, 'Bea', 'Booked', 'bea.delete@example.test', '07911 123904'),
  ('00000000-0000-4000-8000-00000000d205', null, 'Rae', 'Repeat', 'rae.delete@example.test', '07911 123905'),
  ('00000000-0000-4000-8000-00000000d206', '00000000-0000-0000-0000-00000000d122', 'Holly', 'Phoneonly', null, '07911 123906'),
  ('00000000-0000-4000-8000-00000000d207', '00000000-0000-0000-0000-00000000d101', 'Ada', 'Admin', 'delete-admin@example.test', '07911 123907'),
  ('00000000-0000-4000-8000-00000000d208', null, 'Cass', 'Control', 'cass.delete@example.test', '07911 123908'),
  ('00000000-0000-4000-8000-00000000d209', null, 'Hugo', 'Twin', 'hugo.twin@example.test', '07911 123909'),
  ('00000000-0000-4000-8000-00000000d210', null, 'Max', 'Both', 'max.delete@example.test', '07911 123910');
insert into public.client_addresses(id, client_id, label, address_line_1, city, postcode, is_default) values
  ('00000000-0000-4000-8000-00000000d301', '00000000-0000-4000-8000-00000000d201', 'Home', '1 First Street', 'London', 'SW1A 1AA', true),
  ('00000000-0000-4000-8000-00000000d302', '00000000-0000-4000-8000-00000000d201', 'Office', '2 Second Street', 'London', 'SW1A 2AA', false),
  ('00000000-0000-4000-8000-00000000d303', '00000000-0000-4000-8000-00000000d208', 'Home', '3 Third Street', 'London', 'SW1A 3AA', true);
insert into public.client_notes(client_id, author_user_id, note) values
  ('00000000-0000-4000-8000-00000000d201', '00000000-0000-0000-0000-00000000d101', 'Prefers a firm touch'),
  ('00000000-0000-4000-8000-00000000d201', '00000000-0000-0000-0000-00000000d101', 'Ring the top bell'),
  ('00000000-0000-4000-8000-00000000d208', '00000000-0000-0000-0000-00000000d101', 'Control note');
-- Waiting-list requests: d501 is linked to d201, d502 to the control, d503 was made by d202's own login before any profile was linked
-- to it (so it is not linked), and d504 was made by someone else's login.
insert into public.waitlist_requests(id, client_id, created_by, contact_name, contact_phone, requested_date, duration_minutes) values
  ('00000000-0000-4000-8000-00000000d501', '00000000-0000-4000-8000-00000000d201', null, 'Hugo Pell', '07911 123901', pg_temp.today_plus(12), 60),
  ('00000000-0000-4000-8000-00000000d502', '00000000-0000-4000-8000-00000000d208', null, 'Cass Control', '07911 123908', pg_temp.today_plus(13), 60),
  ('00000000-0000-4000-8000-00000000d503', null, '00000000-0000-0000-0000-00000000d111', 'Dee Lete', '07911 123902', pg_temp.today_plus(14), 60),
  ('00000000-0000-4000-8000-00000000d504', null, '00000000-0000-0000-0000-00000000d112', 'Eli Else', '07911 123999', pg_temp.today_plus(15), 60);
-- The alerts, made the way the app makes them: an event, and the database plans the alerts from it.
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
select 'waitlist.joined', 'waitlist', w.id, 'waitlist.joined:' || right(w.id::text, 4),
  jsonb_build_object('waitlist_id', w.id, 'date', w.requested_date, 'from_minutes', 0, 'to_minutes', 1440, 'duration_minutes', 60)
from public.waitlist_requests w where w.id::text like '00000000-0000-4000-8000-00000000d50%';
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload) values
  ('client.possible_duplicate', 'client', '00000000-0000-4000-8000-00000000d201', 'client.possible_duplicate:d201:d209',
    jsonb_build_object('client_id', '00000000-0000-4000-8000-00000000d201', 'other_client_id', '00000000-0000-4000-8000-00000000d209', 'matched_on', '["phone"]'::jsonb)),
  ('client.possible_duplicate', 'client', '00000000-0000-4000-8000-00000000d209', 'client.possible_duplicate:d209:d201',
    jsonb_build_object('client_id', '00000000-0000-4000-8000-00000000d209', 'other_client_id', '00000000-0000-4000-8000-00000000d201', 'matched_on', '["phone"]'::jsonb)),
  ('client.possible_duplicate', 'client', '00000000-0000-4000-8000-00000000d208', 'client.possible_duplicate:d208:d209',
    jsonb_build_object('client_id', '00000000-0000-4000-8000-00000000d208', 'other_client_id', '00000000-0000-4000-8000-00000000d209', 'matched_on', '["phone"]'::jsonb));
-- Combine history. d201 had profile X combined into it, and X had profile Y combined into it before that; the control has one of its own.
insert into public.client_merges(kept_client_id, removed_client_id, removed_client, removed_kind, moved, summary) values
  ('00000000-0000-4000-8000-00000000d201', '00000000-0000-4000-8000-00000000d901', '{"first_name":"Xavier","email":"xavier.old@example.test"}'::jsonb, 'guest', '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000d901', '00000000-0000-4000-8000-00000000d902', '{"first_name":"Yolanda","email":"yolanda.old@example.test"}'::jsonb, 'guest', '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000d208', '00000000-0000-4000-8000-00000000d903', '{"first_name":"Zed","email":"zed.old@example.test"}'::jsonb, 'guest', '{}'::jsonb, '{}'::jsonb);
insert into public.client_not_same(client_a, client_b)
select least('00000000-0000-4000-8000-00000000d201'::uuid, '00000000-0000-4000-8000-00000000d208'::uuid), greatest('00000000-0000-4000-8000-00000000d201'::uuid, '00000000-0000-4000-8000-00000000d208'::uuid);
-- Held-time records that must not count: one used up and long expired, one that ran out, one released that has not run out.
insert into public.booking_holds(id, client_id, client_key, date, start_minutes, treatment_duration_minutes, expires_at, status) values
  ('00000000-0000-4000-8000-00000000d801', '00000000-0000-4000-8000-00000000d201', null, pg_temp.today_plus(3), 600, 60, now() - interval '1 hour', 'consumed'),
  ('00000000-0000-4000-8000-00000000d802', null, 'delete-test-browser-key-0002', pg_temp.today_plus(4), 600, 60, now() - interval '5 minutes', 'active'),
  ('00000000-0000-4000-8000-00000000d803', null, 'delete-test-browser-key-0003', pg_temp.today_plus(6), 600, 60, now() + interval '10 minutes', 'released');
-- The reasons not to delete: bookings, a repeat, the Admin's own profile (which also has a booking), and a client with both a booking and a repeat.
select pg_temp.booking('00000000-0000-4000-8000-00000000d701', '00000000-0000-4000-8000-00000000d204');
select pg_temp.booking('00000000-0000-4000-8000-00000000d702', '00000000-0000-4000-8000-00000000d207');
select pg_temp.booking('00000000-0000-4000-8000-00000000d703', '00000000-0000-4000-8000-00000000d210');
insert into public.booking_series(id, client_id, weekday, first_date, start_minutes, treatment_duration_minutes, request) values
  ('00000000-0000-4000-8000-00000000d601', '00000000-0000-4000-8000-00000000d205', 1, pg_temp.today_plus(7), 600, 60, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000d602', '00000000-0000-4000-8000-00000000d210', 2, pg_temp.today_plus(8), 600, 60, '{}'::jsonb);

-- ---------------------------------------------------------------------------------------------
-- The doors
-- ---------------------------------------------------------------------------------------------
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_client_delete_check', 'admin_delete_client')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not (p.prosecdef and p.proconfig @> array['search_path=""']))),
  'The delete commands are closed to anonymous callers, open to a signed-in caller who is checked inside, and are definers with an empty search path');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'client_delete_scope'
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  'The inside count of what would go cannot be called from outside');
select ok(not has_table_privilege('anon', 'public.client_deletions', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.client_deletions', 'select')
  and not has_table_privilege('authenticated', 'public.client_deletions', 'insert')
  and not has_table_privilege('authenticated', 'public.client_deletions', 'update')
  and not has_table_privilege('authenticated', 'public.client_deletions', 'delete'),
  'The record of deletions cannot be read or changed from outside');

select pg_temp.as_user('00000000-0000-0000-0000-00000000d111', true);
set local role authenticated;
select throws_ok($$select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201')$$, '42501', 'Admin authorization required', 'A guest session cannot ask');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), '{}'::jsonb)$$, '42501', 'Admin authorization required', 'A guest session cannot delete');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d112');
select throws_ok($$select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201')$$, '42501', 'Admin authorization required', 'A client who is signed in cannot ask');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), '{}'::jsonb)$$, '42501', 'Admin authorization required', 'A client who is signed in cannot delete');
reset role;
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000d201'), 1, 'Nothing was deleted by those attempts');

-- ---------------------------------------------------------------------------------------------
-- What the Admin is told first
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select is((select public.admin_client_delete_check(gen_random_uuid())->>'found'), 'false', 'A client who is not there is reported as not found');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201')->>'can_delete'), 'true', 'A client with no bookings can be deleted (held times that are used up, ran out or were released do not count)');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201')->>'reason'), null, 'There is no reason against it');
select results_eq($$select (r->>'addresses')::integer, (r->>'notes')::integer, (r->>'waitlist')::integer, r->>'login', (r->>'bookings')::integer
  from (select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201') r) x$$,
  $$values (2, 2, 1, 'added'::text, 0)$$, 'It says what would go: 2 addresses, 2 notes, 1 waiting-list request, no login, no bookings');
select results_eq($$select r->>'login', (r->>'waitlist')::integer, r->>'can_delete' from (select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d202') r) x$$,
  $$values ('registered'::text, 1, 'true'::text)$$, 'A real login is reported as registered, and a waiting-list request made by their own login counts as theirs');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d203')->>'login'), 'guest', 'A guest session is reported as a guest');
select results_eq($$select r->>'can_delete', r->>'reason', (r->>'bookings')::integer from (select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d204') r) x$$,
  $$values ('false'::text, 'bookings'::text, 1)$$, 'A client with a booking cannot be deleted, and the booking is counted');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d205')->>'reason'), 'repeats', 'A client with a repeating booking cannot be deleted');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d207')->>'reason'), 'admin', 'The Admin''s own profile cannot be deleted, even though it also has a booking');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d210')->>'reason'), 'bookings', 'Bookings are named before a repeat');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d206')->>'can_delete'), 'true', 'A client with only a phone number can be deleted');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Refusals change nothing
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select throws_ok($$select public.admin_delete_client(null, gen_random_uuid(), '{}'::jsonb)$$, '22023', 'Choose a client', 'A missing client is refused');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', null, '{}'::jsonb)$$, '22023', 'Choose a client', 'A missing request key is refused');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), null)$$, '22023', 'Say what is being deleted', 'A deletion that does not say what it expects to remove is refused');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), '[]'::jsonb)$$, '22023', 'Say what is being deleted', 'So is one that says it as a list');
select throws_ok($$select public.admin_delete_client(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)$$, 'P0002', 'That client is no longer there. They may already have been deleted or combined.', 'A client who is not there is refused in plain words');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d204', gen_random_uuid(), '{}'::jsonb)$$, 'PT409', 'This client has bookings, so they cannot be deleted. Bookings, payments and receipts are your records.', 'A client with a booking is refused in plain words');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d210', gen_random_uuid(), '{}'::jsonb)$$, 'PT409', 'This client has bookings, so they cannot be deleted. Bookings, payments and receipts are your records.', 'A client with a booking and a repeat is refused for the booking');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d205', gen_random_uuid(), '{}'::jsonb)$$, 'PT409', 'This client has a repeating booking, so they cannot be deleted.', 'A client with a repeat is refused in plain words');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d207', gen_random_uuid(), '{}'::jsonb)$$, 'PT409', 'This client is signed in as an Admin, so they cannot be deleted here.', 'The Admin''s own profile is refused in plain words');
reset role;
select is((select count(*)::integer from public.clients where id in ('00000000-0000-4000-8000-00000000d204', '00000000-0000-4000-8000-00000000d205', '00000000-0000-4000-8000-00000000d207', '00000000-0000-4000-8000-00000000d210')), 4, 'None of the four refused clients went');
select is((select count(*)::integer from public.bookings where client_id = '00000000-0000-4000-8000-00000000d204'), 1, 'The booking is still there');
select is((select count(*)::integer from auth.users where id = '00000000-0000-0000-0000-00000000d101'), 1, 'The Admin''s sign-in is still there');
select is((select count(*)::integer from public.client_deletions), 0, 'No deletion was recorded for a refusal');
select is((select count(*)::integer from public.command_requests where command_type = 'admin_delete_client'), 0, 'No command was recorded for a refusal');

-- ---------------------------------------------------------------------------------------------
-- Nothing is deleted while someone is in the middle of booking
-- ---------------------------------------------------------------------------------------------
-- A visitor's held time has no client attached (that only happens when their booking is finished), so any held time that is still
-- running stops a deletion, whoever it is for.
insert into public.booking_holds(id, client_id, client_key, date, start_minutes, treatment_duration_minutes, expires_at, status)
values ('00000000-0000-4000-8000-00000000d804', null, 'delete-test-browser-key-0004', pg_temp.today_plus(5), 600, 60, now() + interval '10 minutes', 'active');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select results_eq($$select r->>'can_delete', r->>'reason' from (select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201') r) x$$,
  $$values ('false'::text, 'booking_now'::text)$$, 'While a visitor is booking, no client can be deleted, and the reason says so');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201'))$$, 'PT409', 'Someone is in the middle of booking right now. Try again in a few minutes.', 'The deletion waits, in plain words');
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d204')->>'reason'), 'bookings', 'A client with bookings is still told about the bookings first');
reset role;
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000d201'), 1, 'Nothing was deleted while they waited');
update public.booking_holds set expires_at = now() - interval '1 minute' where id = '00000000-0000-4000-8000-00000000d804';
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201')->>'can_delete'), 'true', 'Once the held time has run out, the client can be deleted again');
reset role;
update public.booking_holds set expires_at = now() + interval '10 minutes', status = 'released' where id = '00000000-0000-4000-8000-00000000d804';
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select is((select public.admin_client_delete_check('00000000-0000-4000-8000-00000000d201')->>'can_delete'), 'true', 'A held time that was released does not stop it either');
reset role;

-- ---------------------------------------------------------------------------------------------
-- What is deleted is what she was told
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
create temp table asked as select pg_temp.expect('00000000-0000-4000-8000-00000000d201') r;
grant select on asked to authenticated;
-- A note is added after the question was put (as the owner or the client could do from another screen).
insert into public.client_notes(id, client_id, note) values ('00000000-0000-4000-8000-00000000d410', '00000000-0000-4000-8000-00000000d201', 'Added after the question');
set local role authenticated;
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), (select r from asked))$$, 'PT409',
  'Something changed while you were deciding. Please look at the question again.', 'A note added since the question stops the deletion, and she is asked again');
reset role;
delete from public.client_notes where id = '00000000-0000-4000-8000-00000000d410';
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), (select r || jsonb_build_object('login', 'registered') from asked))$$, 'PT409',
  'Something changed while you were deciding. Please look at the question again.', 'A login that was not mentioned in the question stops the deletion');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', gen_random_uuid(), '{"addresses":2}'::jsonb)$$, 'PT409',
  'Something changed while you were deciding. Please look at the question again.', 'An answer that leaves things out stops the deletion');
reset role;
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000d201'), 1, 'The client is still there after all three');
select is((select count(*)::integer from public.client_deletions), 0, 'Nothing was recorded for them');

-- ---------------------------------------------------------------------------------------------
-- Deleting a client who has everything hanging off them
-- ---------------------------------------------------------------------------------------------
select is(pg_temp.alerts_by_key('client.possible_duplicate:d201:d209') + pg_temp.alerts_by_key('client.possible_duplicate:d209:d201') + pg_temp.alerts_by_key('waitlist.joined:d501'), 5,
  'Before: five alerts name this client (the question about the pair, asked from both sides, and the waiting-list request in the app, Telegram and email)');
select is(pg_temp.alerts_by_key('client.possible_duplicate:d208:d209') + pg_temp.alerts_by_key('waitlist.joined:d502'), 4, 'Before: the control client has four of their own');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
create temp table gone as select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', 'aaaaaaaa-0000-4000-8000-000000000001', pg_temp.expect('00000000-0000-4000-8000-00000000d201')) r;
grant select on gone to authenticated;
select results_eq($$select r->>'deleted', (r->>'addresses')::integer, (r->>'notes')::integer, (r->>'waitlist')::integer, (r->>'alerts')::integer, (r->>'history')::integer, r->>'login' from gone$$,
  $$values ('true'::text, 2, 2, 1, 5, 2, 'added'::text)$$, 'It reports what went: 2 addresses, 2 notes, 1 waiting-list request, 5 alerts, 2 combine records, no login');
select is((select r->>'repeat' from gone), null, 'The first press is not a repeat');
reset role;
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000d201'), 0, 'The client is gone');
select is((select count(*)::integer from public.client_addresses where client_id = '00000000-0000-4000-8000-00000000d201'), 0, 'Their addresses are gone');
select is((select count(*)::integer from public.client_notes where client_id = '00000000-0000-4000-8000-00000000d201'), 0, 'Their notes are gone');
select is((select count(*)::integer from public.booking_holds where client_id = '00000000-0000-4000-8000-00000000d201'), 0, 'Their used-up held time is gone');
select is((select count(*)::integer from public.waitlist_requests where id = '00000000-0000-4000-8000-00000000d501'), 0, 'Their waiting-list request is gone');
select is((select count(*)::integer from public.client_not_same where '00000000-0000-4000-8000-00000000d201' in (client_a, client_b)), 0, 'Their "different people" answer is gone');
select is((select count(*)::integer from public.client_merges where kept_client_id in ('00000000-0000-4000-8000-00000000d201', '00000000-0000-4000-8000-00000000d901')), 0,
  'The combine history that held other profiles'' details is gone, including the profile combined into the one that was combined');
select is(pg_temp.alerts_by_key('client.possible_duplicate:d201:d209') + pg_temp.alerts_by_key('client.possible_duplicate:d209:d201') + pg_temp.alerts_by_key('waitlist.joined:d501'), 0,
  'The alerts that named them are gone, whichever side of the pair they were on');
-- Everything that is someone else's is untouched.
select is((select count(*)::integer from public.client_addresses where client_id = '00000000-0000-4000-8000-00000000d208'), 1, 'The control client keeps their address');
select is((select count(*)::integer from public.client_notes where client_id = '00000000-0000-4000-8000-00000000d208'), 1, 'The control client keeps their note');
select is((select count(*)::integer from public.waitlist_requests where id in ('00000000-0000-4000-8000-00000000d502', '00000000-0000-4000-8000-00000000d503', '00000000-0000-4000-8000-00000000d504')), 3, 'The other waiting-list requests are untouched');
select is((select count(*)::integer from public.client_merges where kept_client_id = '00000000-0000-4000-8000-00000000d208'), 1, 'The control client keeps their combine history');
select is((select count(*)::integer from public.booking_holds where id = '00000000-0000-4000-8000-00000000d803'), 1, 'Other held-time records are untouched');
select is(pg_temp.alerts_by_key('client.possible_duplicate:d208:d209') + pg_temp.alerts_by_key('waitlist.joined:d502'), 4, 'The control client keeps all four alerts');
select is((select count(*)::integer from public.clients where id in ('00000000-0000-4000-8000-00000000d208', '00000000-0000-4000-8000-00000000d209')), 2, 'The other half of the pair is still a client');
select is((select count(*)::integer from public.bookings where client_id = '00000000-0000-4000-8000-00000000d204'), 1, 'Nobody''s booking went');

-- The record keeps counts and nothing about who it was.
select results_eq($$select client_id, deleted_by, summary->>'login', (summary->>'addresses')::integer from public.client_deletions$$,
  $$values ('00000000-0000-4000-8000-00000000d201'::uuid, '00000000-0000-0000-0000-00000000d101'::uuid, 'added'::text, 2)$$, 'The record says which id, who deleted it and how much went');
select ok((select summary::text from public.client_deletions) !~* '(hugo|pell|example\.test|07911|street|firm touch|xavier|yolanda)', 'The record holds none of the client''s details');
select results_eq($$select scope, command_type, status from public.command_requests where command_type = 'admin_delete_client'$$,
  $$values ('admin-client-delete:00000000-0000-0000-0000-00000000d101'::text, 'admin_delete_client'::text, 'succeeded'::text)$$, 'The command is recorded as done');

-- The same press arriving again is answered, not done again.
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select is((select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', 'aaaaaaaa-0000-4000-8000-000000000001', '{}'::jsonb)->>'repeat'), 'true', 'Pressing again with the same request key says it was already done');
select is((select (public.admin_delete_client('00000000-0000-4000-8000-00000000d201', 'aaaaaaaa-0000-4000-8000-000000000001', '{}'::jsonb)->>'addresses')::integer), 2, 'and tells the same story');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d208', 'aaaaaaaa-0000-4000-8000-000000000001', '{}'::jsonb)$$, '22023', 'Request key reused', 'The same request key for another client is refused');
select throws_ok($$select public.admin_delete_client('00000000-0000-4000-8000-00000000d201', 'aaaaaaaa-0000-4000-8000-000000000002', '{}'::jsonb)$$, 'P0002', 'That client is no longer there. They may already have been deleted or combined.', 'A second tab with a new key finds them already gone');
reset role;
select is((select count(*)::integer from public.client_deletions), 1, 'Only one deletion is on record');
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000d208'), 1, 'The refused request deleted nobody else');

-- ---------------------------------------------------------------------------------------------
-- A client with a login: the login goes too, with what their own login made, and the email is free again
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select results_eq($$select r->>'login', (r->>'waitlist')::integer, (r->>'alerts')::integer from (select public.admin_delete_client('00000000-0000-4000-8000-00000000d202', gen_random_uuid(), pg_temp.expect('00000000-0000-4000-8000-00000000d202')) r) x$$,
  $$values ('registered'::text, 1, 3)$$, 'A registered client is deleted, with the waiting-list request their own login made and its three alerts');
reset role;
select ok(exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid()
  and l.classid = ((hashtext('client-auth-email:dee.delete@example.test')::bigint >> 32) & 4294967295)::oid
  and l.objid = (hashtext('client-auth-email:dee.delete@example.test')::bigint & 4294967295)::oid and l.objsubid = 1),
  'Deleting takes the same email lock as signing up, so a registration on that email waits for it');
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000d202'), 0, 'The profile is gone');
select is((select count(*)::integer from auth.users where id = '00000000-0000-0000-0000-00000000d111'), 0, 'Their login is gone too');
select is((select count(*)::integer from public.waitlist_requests where id = '00000000-0000-4000-8000-00000000d503'), 0, 'The request their login made, which was never linked to a profile, is gone');
select is(pg_temp.alerts_by_key('waitlist.joined:d503'), 0, 'and so are its alerts');
select is((select count(*)::integer from public.waitlist_requests where id = '00000000-0000-4000-8000-00000000d504') + pg_temp.alerts_by_key('waitlist.joined:d504'), 4, 'A request made by someone else''s login is untouched, with its alerts');
select lives_ok($$insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'dee.delete@example.test', '', now(), '{}', '{}', now(), now(), false)$$,
  'Someone can register with that email again');
select is((select count(*)::integer from auth.users where id = '00000000-0000-0000-0000-00000000d112'), 1, 'Another client''s login is untouched');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select is((select public.admin_delete_client('00000000-0000-4000-8000-00000000d203', gen_random_uuid(), pg_temp.expect('00000000-0000-4000-8000-00000000d203'))->>'login'), 'guest', 'A guest is deleted and the answer says it was a guest session');
select is((select public.admin_delete_client('00000000-0000-4000-8000-00000000d206', gen_random_uuid(), pg_temp.expect('00000000-0000-4000-8000-00000000d206'))->>'login'), 'guest', 'A client with no email at all is deleted too, with no email lock needed');
reset role;
select is((select count(*)::integer from auth.users where id in ('00000000-0000-0000-0000-00000000d121', '00000000-0000-0000-0000-00000000d122')), 0, 'Both guest sessions are gone');
select is((select count(*)::integer from public.clients where id in ('00000000-0000-4000-8000-00000000d203', '00000000-0000-4000-8000-00000000d206')), 0, 'and so are their profiles');
select is((select count(*)::integer from auth.users where id = '00000000-0000-0000-0000-00000000d101'), 1, 'The Admin''s sign-in is still there');
select is((select count(*)::integer from public.client_deletions), 4, 'Four deletions are on record');
select ok((select bool_and(deleted_by = '00000000-0000-0000-0000-00000000d101'::uuid) from public.client_deletions), 'Each says who did it');

-- ---------------------------------------------------------------------------------------------
-- Nobody else was reached
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::integer from public.clients where id::text like '00000000-0000-4000-8000-00000000d2%'), 6, 'Six of the ten clients are left: the four who were refused, the control and the other half of the pair');
select is((select count(*)::integer from public.admin_users where user_id = '00000000-0000-0000-0000-00000000d101'), 1, 'The Admin is still the Admin');

select * from finish();
rollback;
