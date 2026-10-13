begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(95);

-- People. b101 is the Admin; b111 registers later; b112 and b113 are two real logins; b121 to b131 are guest sessions.
insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000b101', 'authenticated', 'authenticated', 'same-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000b111', 'authenticated', 'authenticated', 'olo.same@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000b112', 'authenticated', 'authenticated', 'pat.same@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000b113', 'authenticated', 'authenticated', 'quinn.same@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false);
insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
select '00000000-0000-0000-0000-000000000000', ('00000000-0000-0000-0000-00000000b' || n)::uuid, 'authenticated', 'authenticated', null, '', null, '{"provider":"anonymous","providers":[]}', '{}', now(), now(), true
from unnest(array['121', '122', '123', '124', '125', '126', '127', '128', '129', '130', '131']) n;
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000b101');
-- Every date is open, so a repeat can book its next session.
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
  select (clock_timestamp() at time zone 'Europe/London')::date + d, true, 0, 1440, 'flexible' from generate_series(0, 400) d
  on conflict (date) do update set available = true, start_minutes = 0, end_minutes = 1440, start_mode = 'flexible', fixed_start_minutes = null;

create function pg_temp.booking(p_id uuid, p_client uuid, p_status text, p_day_offset integer, p_payment text, p_address uuid default null) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, saved_address_id)
  select p_id, 'SAME-' || p_id, p_client, id, ((now() at time zone 'Europe/London')::date + p_day_offset), 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 100, 100, p_address
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, 'cash', p_payment, 100, case when p_payment = 'paid' then now() end);
end;
$$;
create function pg_temp.series_request(p_client uuid, p_address uuid, p_offset integer) returns jsonb language sql as $$
  select jsonb_build_object('client_id', p_client, 'saved_address_id', p_address, 'service_area_id', (select id from public.service_areas where slug = 'chelsea'),
    'sessions', jsonb_build_array(jsonb_build_object('service_id', (select id from public.services where slug = 'massage'), 'duration_minutes', 60, 'recipient_name', 'Olo')),
    'enhancement_ids', '[]'::jsonb, 'date', (clock_timestamp() at time zone 'Europe/London')::date + p_offset, 'start_minutes', 600,
    'payment_arrangement', 'bank_pending', 'note', 'Weekly regular');
$$;
create function pg_temp.today_plus(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
create function pg_temp.as_user(p_user uuid, p_anonymous boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', p_anonymous)::text, true);
end;
$$;
create function pg_temp.alerts_about(p_client uuid) returns table(channel text, title text, body text, link_path text, read_at timestamptz) language sql as $$
  select d.channel, d.title, d.body, d.link_path, d.read_at
  from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'client.possible_duplicate' and (e.payload->>'client_id' = p_client::text or e.payload->>'other_client_id' = p_client::text)
  order by d.created_at, d.channel;
$$;

-- ---------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------
select is(public.phone_match_key('07911123401'), '7911123401', 'A UK number is matched by its last ten digits');
select is(public.phone_match_key('447911123401'), '7911123401', 'The same number with the country code matches it');
select is(public.phone_match_key('12345'), null, 'A number too short to mean anything matches nothing');
select is(public.client_login_kind(null), 'added', 'A profile with no login was added by the Admin');
select is(public.client_login_kind('00000000-0000-0000-0000-00000000b121'), 'guest', 'A guest session is a guest');
select is(public.client_login_kind('00000000-0000-0000-0000-00000000b112'), 'registered', 'A real login is registered');

select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('phone_match_key', 'client_login_kind', 'client_pair_candidates', 'client_duplicate_pairs', 'flag_possible_duplicate_clients', 'plan_client_notifications', 'mark_duplicate_alerts_read', 'client_combine_profile')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'The inside workings cannot be called from outside');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('admin_possible_duplicates', 'admin_combine_preview', 'admin_keep_clients_separate', 'admin_merge_clients', 'admin_update_client')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or not (p.prosecdef and p.proconfig @> array['search_path=""']))), 'The Admin commands are closed to anonymous callers and are definers with an empty search path');

-- ---------------------------------------------------------------------------------------------
-- A guest books (two bookings, a weekly repeat, a note, addresses, a waitlist request, a held time) ...
-- ---------------------------------------------------------------------------------------------
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone, online_booking_enabled, created_at) values
  ('00000000-0000-4000-8000-00000000b201', '00000000-0000-0000-0000-00000000b121', 'Olo', 'Ehe', 'olo.same@example.test', '07911 123401', false, now() - interval '30 days');
insert into public.client_addresses(id, client_id, label, address_line_1, city, postcode, entry_instructions, is_default) values
  ('00000000-0000-4000-8000-00000000b301', '00000000-0000-4000-8000-00000000b201', 'Home', '1 First Street', 'London', 'SW1A 1AA', 'Ring the top bell', true),
  ('00000000-0000-4000-8000-00000000b302', '00000000-0000-4000-8000-00000000b201', 'Office', '2 Second Street', 'London', 'SW1A 2AA', 'Side gate, code 1234', false),
  ('00000000-0000-4000-8000-00000000b306', '00000000-0000-4000-8000-00000000b201', null, '7 Elm Road', 'London', 'SW1A 7AA', 'Green door', false);
select pg_temp.booking('00000000-0000-4000-8000-00000000b401', '00000000-0000-4000-8000-00000000b201', 'completed', -9, 'paid', '00000000-0000-4000-8000-00000000b301');
select pg_temp.booking('00000000-0000-4000-8000-00000000b402', '00000000-0000-4000-8000-00000000b201', 'confirmed', 6, 'approved', '00000000-0000-4000-8000-00000000b302');
insert into public.client_notes(id, client_id, author_user_id, note) values
  ('00000000-0000-4000-8000-00000000b501', '00000000-0000-4000-8000-00000000b201', '00000000-0000-0000-0000-00000000b101', 'Prefers a firm touch');
insert into public.waitlist_requests(id, client_id, contact_name, contact_phone, requested_date, duration_minutes)
values ('00000000-0000-4000-8000-00000000b701', '00000000-0000-4000-8000-00000000b201', 'Olo Ehe', '07911 123401', pg_temp.today_plus(12), 60);
insert into public.booking_holds(id, client_id, date, start_minutes, treatment_duration_minutes, expires_at, status)
values ('00000000-0000-4000-8000-00000000b801', '00000000-0000-4000-8000-00000000b201', pg_temp.today_plus(11), 600, 60, now() + interval '10 minutes', 'active');
-- The weekly repeat is made the way the Admin makes one, so it carries a copy of the booking it makes (client and saved address).
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
create temp table made as select * from public.admin_create_series(pg_temp.series_request('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b301', 10), null, gen_random_uuid());
grant select on made to authenticated;
reset role;
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b201')), 0, 'A lone guest raises no question');

-- ... then registers with the same email: not turned away, and the Admin is asked.
select pg_temp.as_user('00000000-0000-0000-0000-00000000b111');
set local role authenticated;
select lives_ok($$select * from public.activate_my_client_account('Olo', 'Ehe', null)$$, 'Registering with the email a guest used is no longer refused');
reset role;
select is((select count(*)::integer from public.clients where auth_user_id = '00000000-0000-0000-0000-00000000b111' and normalized_email = 'olo.same@example.test'), 1, 'The registration has a profile of its own');
select results_eq($$select first_name, auth_user_id, phone from public.clients where id = '00000000-0000-4000-8000-00000000b201'$$,
  $$values ('Olo'::text, '00000000-0000-0000-0000-00000000b121'::uuid, '07911 123401'::text)$$, 'The guest''s profile is not taken over');

create temp table olo as select id from public.clients where auth_user_id = '00000000-0000-0000-0000-00000000b111';
grant select on olo to authenticated;
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b201')), 1, 'The Admin gets one question about the pair');
select results_eq($$select channel, title, read_at is null from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b201')$$,
  $$values ('in_app'::text, 'Is this the same person?'::text, true)$$, 'It is an unread alert in the app, with no Telegram message or email');
select is((select body from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b201')),
  'Olo Ehe (has a login) and Olo Ehe (booked as a guest) have the same email. Look at them side by side and combine them if they are one person.', 'It says what matched and does not claim when anything happened');
select is((select link_path from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b201')),
  '/admin/clients/combine?a=' || (select id from olo)::text || '&b=00000000-0000-4000-8000-00000000b201', 'It opens the two profiles side by side');

-- ---------------------------------------------------------------------------------------------
-- Noticing other pairs
-- ---------------------------------------------------------------------------------------------
-- Made by the Admin first, then a guest with the same phone written another way.
insert into public.clients(id, first_name, last_name, email, phone, created_at) values
  ('00000000-0000-4000-8000-00000000b220', 'Sam', 'Ple', 'sam.same@example.test', '+44 7911 123420', now() - interval '2 days');
select pg_temp.booking('00000000-0000-4000-8000-00000000b403', '00000000-0000-4000-8000-00000000b220', 'confirmed', 8, 'approved');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000b221', '00000000-0000-0000-0000-00000000b122', 'Sammy', 'Ple', 'other.same@example.test', '07911 123420');
select results_eq($$select matched_on from public.client_duplicate_pairs('00000000-0000-4000-8000-00000000b221')$$, $$values (array['phone']::text[])$$, 'The same phone number is spotted, however it is written');
select is((select body from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b221')),
  'Sam Ple (added by you) and Sammy Ple (booked as a guest) have the same phone number. Look at them side by side and combine them if they are one person.', 'The alert names the profile the Admin added first, then the guest');

-- Two real logins on one phone are never offered.
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000b202', '00000000-0000-0000-0000-00000000b112', 'Pat', 'Registered', 'pat.same@example.test', '07911 123430'),
  ('00000000-0000-4000-8000-00000000b203', '00000000-0000-0000-0000-00000000b113', 'Quinn', 'Registered', 'quinn.same@example.test', '+44 7911 123430');
select is((select count(*)::integer from public.client_duplicate_pairs() where client_a in ('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b203') or client_b in ('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b203')), 0, 'Two profiles that each have a login are never offered');
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b203')), 0, 'And nothing is raised for them');

-- A returning guest on a new device: a second guest profile with the registered client's email.
select pg_temp.as_user('00000000-0000-0000-0000-00000000b123', true);
set local role authenticated;
select lives_ok($$select * from public.activate_guest_client_account('Olo', 'Ehe', 'olo.same@example.test', '07911 123499')$$, 'A guest can book again with the same email');
reset role;
select is((select count(*)::integer from public.client_duplicate_pairs() p where p.client_a = (select id from olo) or p.client_b = (select id from olo)), 2, 'Both guest profiles are listed against the registered one');
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'client.possible_duplicate' and e.payload->>'client_id' = (select c.id::text from public.clients c where c.auth_user_id = '00000000-0000-0000-0000-00000000b123')), 1, 'The new guest raises one question, about the profile that has something to combine');
select is((select e.payload->>'other_client_id' from public.event_outbox e where e.event_type = 'client.possible_duplicate' and e.payload->>'client_id' = (select c.id::text from public.clients c where c.auth_user_id = '00000000-0000-0000-0000-00000000b123')), '00000000-0000-4000-8000-00000000b201', 'It is the earlier guest, who has bookings, not the registration, who has none yet');

-- Saving the same details again does not ask again.
select pg_temp.as_user('00000000-0000-0000-0000-00000000b123', true);
set local role authenticated;
select lives_ok($$select * from public.activate_guest_client_account('Olo', 'Ehe', 'olo.same@example.test', '07911 123499')$$, 'The same guest can save the same details again');
reset role;
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'client.possible_duplicate' and e.payload->>'client_id' = (select c.id::text from public.clients c where c.auth_user_id = '00000000-0000-0000-0000-00000000b123')), 1, 'Each pair is raised only once');

-- Nobody can flood the alerts: each profile saved raises at most one question, and only where there is something to combine.
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000b251', '00000000-0000-0000-0000-00000000b128', 'Flo', 'One', 'flood.same@example.test', '07911 123451');
select pg_temp.booking('00000000-0000-4000-8000-00000000b405', '00000000-0000-4000-8000-00000000b251', 'confirmed', 9, 'approved');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000b252', '00000000-0000-0000-0000-00000000b129', 'Flo', 'Two', 'flood.same@example.test', '07911 123452');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000b253', '00000000-0000-0000-0000-00000000b130', 'Flo', 'Three', 'flood.same@example.test', '07911 123453');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000b254', '00000000-0000-0000-0000-00000000b131', 'Flo', 'Four', 'flood.same@example.test', '07911 123454');
select is((select count(*)::integer from public.client_duplicate_pairs() p where p.client_a in ('00000000-0000-4000-8000-00000000b251', '00000000-0000-4000-8000-00000000b252', '00000000-0000-4000-8000-00000000b253', '00000000-0000-4000-8000-00000000b254')), 6, 'Four profiles with one email are six pairs on the Clients page');
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'client.possible_duplicate' and e.aggregate_id in ('00000000-0000-4000-8000-00000000b252', '00000000-0000-4000-8000-00000000b253', '00000000-0000-4000-8000-00000000b254')), 3, 'But each new profile raises one alert, not one for every match');
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'client.possible_duplicate' and e.aggregate_id = '00000000-0000-4000-8000-00000000b251'), 0, 'And the first of them, with nothing to compare, raises none');

-- ---------------------------------------------------------------------------------------------
-- Only the Admin
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000b112');
set local role authenticated;
select throws_ok($$select * from public.admin_possible_duplicates()$$, '42501', 'Admin authorization required', 'A client cannot list possible duplicates');
select throws_ok($$select public.admin_combine_preview('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b220')$$, '42501', 'Admin authorization required', 'A client cannot compare two profiles');
select throws_ok($$select public.admin_keep_clients_separate('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b220')$$, '42501', 'Admin authorization required', 'A client cannot say two profiles are different people');
select throws_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b201', gen_random_uuid())$$, '42501', 'Admin authorization required', 'A client cannot combine profiles');
select throws_ok($$select count(*) from public.client_not_same$$, '42501', 'permission denied for table client_not_same', 'The decisions cannot be read directly');
select pg_temp.as_user('00000000-0000-0000-0000-00000000b123', true);
select throws_ok($$select * from public.admin_possible_duplicates()$$, '42501', 'Admin authorization required', 'A guest cannot list possible duplicates');
reset role;

-- ---------------------------------------------------------------------------------------------
-- What the Admin sees
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
select is((select count(*)::integer from public.admin_possible_duplicates() p where '00000000-0000-4000-8000-00000000b201' in (p.client_a, p.client_b)
  and p.matched_on = array['email'] and ((p.a_kind = 'guest' and p.b_kind = 'registered') or (p.a_kind = 'registered' and p.b_kind = 'guest'))), 1,
  'The list says who is registered and who is a guest, and what matched');
select results_eq($$select p->>'kind', p->>'bookings', p->>'notes', p->>'addresses', p->>'repeats', p->>'upcoming'
  from jsonb_array_elements(public.admin_combine_preview('00000000-0000-4000-8000-00000000b201', (select id from olo))->'profiles') p
  where p->>'id' = '00000000-0000-4000-8000-00000000b201'$$,
  $$values ('guest'::text, '3'::text, '1'::text, '3'::text, '1'::text, '2'::text)$$, 'The side-by-side view counts what the guest holds');
select results_eq($$select p->'matched_on', p->>'can_combine', p->>'keep_id', p->>'kept_separate'
  from (select public.admin_combine_preview('00000000-0000-4000-8000-00000000b201', (select id from olo))) q(p)$$,
  $$select '["email"]'::jsonb, 'true', (select id::text from olo), 'false'$$, 'It suggests keeping the profile that has the login');
select is((public.admin_combine_preview('00000000-0000-4000-8000-00000000b221', '00000000-0000-4000-8000-00000000b220')->>'keep_id'), '00000000-0000-4000-8000-00000000b220', 'With no login on either side it suggests the profile the Admin added');
select is((public.admin_combine_preview('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b220')->>'keep_id'), '00000000-0000-4000-8000-00000000b220', 'It never suggests keeping a guest over one the Admin added, even if the guest has more bookings');
select is((public.admin_combine_preview('00000000-0000-4000-8000-00000000b221', '00000000-0000-4000-8000-00000000b201')->>'keep_id'), '00000000-0000-4000-8000-00000000b201', 'Between two guests it suggests the one with more bookings');
select is((public.admin_combine_preview('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b203')->>'can_combine'), 'false', 'Two profiles that each have a login cannot be combined');
select throws_ok($$select public.admin_combine_preview('00000000-0000-4000-8000-00000000b201', gen_random_uuid())$$, 'P0002', 'One of these clients is no longer there. They may already have been combined.', 'A profile that is gone is explained kindly');
select throws_ok($$select public.admin_combine_preview('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b201')$$, '22023', 'Choose two different clients', 'A profile cannot be compared with itself');
reset role;

-- ---------------------------------------------------------------------------------------------
-- "No, different people" is remembered
-- ---------------------------------------------------------------------------------------------
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000b231', '00000000-0000-0000-0000-00000000b124', 'Dee', 'Shared', 'family.same@example.test', '07911 123440'),
  ('00000000-0000-4000-8000-00000000b232', '00000000-0000-0000-0000-00000000b125', 'Dan', 'Shared', 'family.same@example.test', '07911 123441');
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b231')), 0, 'Two profiles with no bookings raise no alert');
select is((select count(*)::integer from public.client_duplicate_pairs('00000000-0000-4000-8000-00000000b231')), 1, 'But they are still listed as a pair');
select pg_temp.booking('00000000-0000-4000-8000-00000000b404', '00000000-0000-4000-8000-00000000b231', 'confirmed', 13, 'approved');
update public.clients set phone = phone where id = '00000000-0000-4000-8000-00000000b232';
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b231') where read_at is null), 1, 'Once there is something to combine, saving a profile raises the question');
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
select lives_ok($$select public.admin_keep_clients_separate('00000000-0000-4000-8000-00000000b232', '00000000-0000-4000-8000-00000000b231')$$, 'The Admin can say two profiles are different people, whichever way round');
select lives_ok($$select public.admin_keep_clients_separate('00000000-0000-4000-8000-00000000b231', '00000000-0000-4000-8000-00000000b232')$$, 'Saying it twice is harmless');
select is((select count(*)::integer from public.admin_possible_duplicates() p where p.client_a in ('00000000-0000-4000-8000-00000000b231', '00000000-0000-4000-8000-00000000b232')), 0, 'They are not offered again');
select is((public.admin_combine_preview('00000000-0000-4000-8000-00000000b231', '00000000-0000-4000-8000-00000000b232')->>'kept_separate'), 'true', 'The comparison remembers it');
select throws_ok($$select public.admin_keep_clients_separate('00000000-0000-4000-8000-00000000b231', gen_random_uuid())$$, 'P0002', 'One of these clients is no longer there. They may already have been combined.', 'An unknown profile is explained kindly');
-- People who share an email can still have their details corrected; only a value that is being changed can collide.
select lives_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000b231', '{"first_name":"Dee","last_name":"Renamed","email":"family.same@example.test","phone":"07911 123440"}')$$, 'A profile that shares an email can have its name corrected');
select throws_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000b231', '{"first_name":"Dee","last_name":"Renamed","email":"olo.same@example.test","phone":"07911 123440"}')$$, 'PT409', 'Another client already uses this email or phone.', 'But a new email that another profile uses is still refused');
select lives_ok($$select * from public.admin_update_client('00000000-0000-4000-8000-00000000b221', '{"first_name":"Sammy","last_name":"Ple","email":"other.same@example.test","phone":"07911 123420"}')$$, 'A profile whose phone matches another one, not yet decided, can be saved unchanged');
reset role;
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b231') where read_at is null), 0, 'The alert about them is marked as read');
update public.clients set phone = '07911 123442' where id = '00000000-0000-4000-8000-00000000b231';
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b231')), 1, 'Changing their details does not raise the question again');

-- ---------------------------------------------------------------------------------------------
-- Refusals leave everything as it was
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
select throws_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b202', gen_random_uuid())$$, 'PT409', 'The client with the login is the one that stays.', 'The profile with the login cannot be the one that goes');
select throws_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b203', gen_random_uuid())$$, 'PT409', 'Two clients who each have their own login cannot be combined.', 'Two logins cannot be combined');
select throws_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b202', gen_random_uuid())$$, '22023', 'Choose two different clients', 'A profile cannot be combined with itself');
select throws_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000b202', gen_random_uuid(), gen_random_uuid())$$, 'P0002', 'One of these clients is no longer there. They may already have been combined.', 'An unknown profile is explained kindly');
select throws_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b201', null)$$, '22023', 'Choose two different clients', 'A request key is required');
reset role;
select results_eq($$select (select count(*) from public.bookings where client_id = '00000000-0000-4000-8000-00000000b201')::integer, (select count(*) from public.client_merges where removed_client_id in ('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b203'))::integer$$,
  $$values (3, 0)$$, 'Nothing moved and nothing was recorded');

-- ---------------------------------------------------------------------------------------------
-- "Yes, combine them"
-- ---------------------------------------------------------------------------------------------
-- The registered profile already has some of the guest's addresses: a copy of the first (without the instructions the guest's copy has), and a
-- same street with other instructions, which is a different place to the Admin and must not be merged away.
insert into public.client_addresses(id, client_id, label, address_line_1, city, postcode, is_default) values
  ('00000000-0000-4000-8000-00000000b303', (select id from olo), null, '1 FIRST STREET ', 'London', 'sw1a 1aa', true),
  ('00000000-0000-4000-8000-00000000b304', (select id from olo), null, '9 Other Road', 'London', 'SW1A 9AA', false);
insert into public.client_addresses(id, client_id, label, address_line_1, city, postcode, entry_instructions, is_default) values
  ('00000000-0000-4000-8000-00000000b305', (select id from olo), null, '7 Elm Road', 'London', 'SW1A 7AA', 'Blue door', false);
insert into public.client_notes(id, client_id, author_user_id, note) values
  ('00000000-0000-4000-8000-00000000b502', (select id from olo), '00000000-0000-0000-0000-00000000b101', 'Ring the bell twice');
-- An alert that points at the guest's page (the repeat could not be made once) follows the profile that stays.
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
values ('series.clash', 'series', (select series_id from made), 'series.clash:same-person-test',
  jsonb_build_object('client_id', '00000000-0000-4000-8000-00000000b201', 'date', pg_temp.today_plus(50)));
create temp table before_merge as
  select b.id, b.booking_status, b.total_gbp, p.status as payment_status from public.bookings b join public.booking_payments p on p.booking_id = b.id
  where b.client_id = '00000000-0000-4000-8000-00000000b201';
create temp table request as select '00000000-0000-4000-8000-00000000c001'::uuid as id;
grant select on before_merge, request to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
select results_eq($$select (s->>'bookings')::integer, (s->>'repeats')::integer, (s->>'notes')::integer, (s->>'addresses')::integer, (s->>'waitlist')::integer
  from (select public.admin_merge_clients((select id from olo), '00000000-0000-4000-8000-00000000b201', (select id from request)) s) q$$,
  $$values (3, 1, 1, 2, 1)$$, 'The Admin combines them and is told what moved: three bookings, a repeat, a note, two addresses, a waitlist request');
reset role;
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000b201'), 0, 'The guest''s profile is gone');
select is((select count(*)::integer from public.bookings where client_id = (select id from olo)), 3, 'All three bookings now belong to the registered profile');
select results_eq($$select b.id, b.booking_status, b.total_gbp, p.status from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.client_id = (select id from olo) order by b.id$$,
  $$select id, booking_status, total_gbp, payment_status from before_merge order by id$$, 'Their status, price and payment are exactly as they were');
select results_eq($$select id, saved_address_id from public.bookings where id in ('00000000-0000-4000-8000-00000000b401', '00000000-0000-4000-8000-00000000b402') order by id$$,
  $$values ('00000000-0000-4000-8000-00000000b401'::uuid, '00000000-0000-4000-8000-00000000b303'::uuid), ('00000000-0000-4000-8000-00000000b402', '00000000-0000-4000-8000-00000000b302')$$, 'A booking that used a copy of an address now points at the original');
select results_eq($$select id from public.client_addresses where client_id = (select id from olo) order by id$$,
  $$values ('00000000-0000-4000-8000-00000000b302'::uuid), ('00000000-0000-4000-8000-00000000b303'), ('00000000-0000-4000-8000-00000000b304'), ('00000000-0000-4000-8000-00000000b305'), ('00000000-0000-4000-8000-00000000b306')$$,
  'Addresses are combined without a copy of one that was already there, and a same street with other instructions is kept apart');
select results_eq($$select label, entry_instructions from public.client_addresses where id = '00000000-0000-4000-8000-00000000b303'$$, $$values ('Home'::text, 'Ring the top bell'::text)$$, 'The original gained the label and instructions its copy had');
select is((select entry_instructions from public.client_addresses where id = '00000000-0000-4000-8000-00000000b305'), 'Blue door', 'The other instructions were not touched');
select is((select count(*)::integer from public.client_addresses where client_id = (select id from olo) and is_default), 1, 'Exactly one address is the default');
select is((select id from public.client_addresses where client_id = (select id from olo) and is_default), '00000000-0000-4000-8000-00000000b303'::uuid, 'It is the one the registered profile already had');
select results_eq($$select m.moved->'duplicate_addresses'->0->'address'->>'address_line_1', m.moved->'duplicate_addresses'->0->'address'->>'entry_instructions' from public.client_merges m where m.removed_client_id = '00000000-0000-4000-8000-00000000b201'$$,
  $$values ('1 First Street'::text, 'Ring the top bell'::text)$$, 'The copy that was not kept is saved whole in the history');
select is((select count(*)::integer from public.client_notes where client_id = (select id from olo) and id in ('00000000-0000-4000-8000-00000000b501', '00000000-0000-4000-8000-00000000b502')), 2, 'Both profiles'' notes are together');
select is((select note from public.client_notes where client_id = (select id from olo) and note like 'Combined%'), 'Combined with another profile on ' || to_char(now() at time zone 'Europe/London', 'FMDD FMMon YYYY') || ': Olo Ehe, olo.same@example.test, 07911 123401.', 'A private note says what was combined');
select results_eq($$select (select client_id from public.booking_series where id = (select series_id from made)), (select client_id from public.waitlist_requests where id = '00000000-0000-4000-8000-00000000b701'), (select client_id from public.booking_holds where id = '00000000-0000-4000-8000-00000000b801'), (select status from public.booking_holds where id = '00000000-0000-4000-8000-00000000b801')$$,
  $$select id, id, id, 'active'::text from olo$$, 'The repeat, the waitlist request and the held time moved too');
select results_eq($$select phone, online_booking_enabled from public.clients where id = (select id from olo)$$, $$values ('07911 123401'::text, false)$$, 'The registered profile gained the missing phone, and online booking stays off');
select ok((select created_at <= now() - interval '29 days' from public.clients where id = (select id from olo)), 'Client since is the earlier of the two');
select results_eq($$select removed_client->>'first_name', removed_kind, jsonb_array_length(moved->'bookings'), merged_by from public.client_merges where kept_client_id = (select id from olo)$$,
  $$values ('Olo'::text, 'guest'::text, 3, '00000000-0000-0000-0000-00000000b101'::uuid)$$, 'The profile that went is saved whole, with what moved and who did it');
select is((select count(*)::integer from pg_temp.alerts_about('00000000-0000-4000-8000-00000000b201') where read_at is null), 0, 'The alert about the pair is marked as read');
select is((select count(*)::integer from public.client_duplicate_pairs() p where p.client_a = '00000000-0000-4000-8000-00000000b201' or p.client_b = '00000000-0000-4000-8000-00000000b201'), 0, 'The pair is no longer offered');
select is((select d.link_path from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.deduplication_key = 'series.clash:same-person-test' and d.channel = 'in_app'), '/admin/clients/' || (select id from olo)::text, 'An alert that pointed at the old profile now points at the one that stays');

-- The weekly repeat keeps booking, now for the profile that stays (it kept a copy of the client and the saved address it was made with).
select results_eq($$select request->>'client_id', request->>'saved_address_id' from public.booking_series where id = (select series_id from made)$$,
  $$select id::text, '00000000-0000-4000-8000-00000000b303'::text from olo$$, 'The repeat now names the profile that stays and the original address');
insert into public.business_settings(key, value) values ('series_payment_reminder_days', '20') on conflict (key) do update set value = '20';
select public.run_series_maintenance();
select results_eq($$select client_id, saved_address_id, booking_status from public.bookings where series_id = (select series_id from made) and date = pg_temp.today_plus(17)$$,
  $$select id, '00000000-0000-4000-8000-00000000b303'::uuid, 'confirmed'::text from olo$$, 'The next session of the repeat is booked for the profile that stays, at the original address');
select is((select count(*)::integer from public.booking_series_skips where series_id = (select series_id from made) and reason = 'clash'), 0, 'The repeat did not fall over: no session was given up as a clash');

-- The same request again, or the same pair from a second tab, does nothing more.
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
select is((public.admin_merge_clients((select id from olo), '00000000-0000-4000-8000-00000000b201', (select id from request))->>'repeat'), 'true', 'Sending the same request again returns the same answer');
select is((public.admin_merge_clients((select id from olo), '00000000-0000-4000-8000-00000000b201', gen_random_uuid())->>'repeat'), 'true', 'Combining a pair that was already combined returns the same answer');
select throws_ok($$select public.admin_merge_clients((select id from olo), '00000000-0000-4000-8000-00000000b221', (select id from request))$$, '22023', 'Request key reused', 'A request key cannot be reused for something else');
select is((select count(*)::integer from public.client_merges where removed_client_id = '00000000-0000-4000-8000-00000000b201'), 1, 'Only one combine is on record');
reset role;

-- A decision about the profile that goes now applies to the one that stays.
insert into public.clients(id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000b241', 'Kit', 'Keeper', 'kit.same@example.test');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000b242', '00000000-0000-0000-0000-00000000b126', 'Kit', 'Leaver', 'kit.guest@example.test'),
  ('00000000-0000-4000-8000-00000000b243', '00000000-0000-0000-0000-00000000b127', 'Kit', 'Other', 'kit.other@example.test');
insert into public.client_not_same(client_a, client_b) values (least('00000000-0000-4000-8000-00000000b242'::uuid, '00000000-0000-4000-8000-00000000b243'), greatest('00000000-0000-4000-8000-00000000b242'::uuid, '00000000-0000-4000-8000-00000000b243'));
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
select lives_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000b241', '00000000-0000-4000-8000-00000000b242', gen_random_uuid())$$, 'Two profiles with no login can be combined, keeping either');
reset role;
select results_eq($$select client_a, client_b from public.client_not_same where '00000000-0000-4000-8000-00000000b243' in (client_a, client_b)$$,
  $$select least('00000000-0000-4000-8000-00000000b241'::uuid, '00000000-0000-4000-8000-00000000b243'), greatest('00000000-0000-4000-8000-00000000b241'::uuid, '00000000-0000-4000-8000-00000000b243')$$, 'An earlier "different people" answer carries over to the profile that stays');
select results_eq($$select email, last_name from public.clients where id = '00000000-0000-4000-8000-00000000b241'$$, $$values ('kit.same@example.test'::text, 'Keeper'::text)$$, 'The profile that stays keeps its own details');

-- The Admin can read the history, and nobody else.
select pg_temp.as_user('00000000-0000-0000-0000-00000000b101');
set local role authenticated;
select is((select count(*)::integer from public.client_merges where kept_client_id in ((select id from olo), '00000000-0000-4000-8000-00000000b241')), 2, 'The Admin can read the combine history');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000b112');
set local role authenticated;
select is((select count(*)::integer from public.client_merges), 0, 'Nobody else can');
reset role;

select * from finish();
rollback;
