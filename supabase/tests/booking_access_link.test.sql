begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(96);

-- ---------------------------------------------------------------------------------------------
-- People. g1 and g2 are guest sessions, r1 has a real login, and Addie was added by the Admin and has no login at all.
-- ---------------------------------------------------------------------------------------------
insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000e111', 'authenticated', 'authenticated', null, '', null, '{"provider":"anonymous","providers":[]}', '{}', now(), now(), true),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000e112', 'authenticated', 'authenticated', 'link.registered@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000e113', 'authenticated', 'authenticated', null, '', null, '{"provider":"anonymous","providers":[]}', '{}', now(), now(), true);
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000e201', '00000000-0000-0000-0000-00000000e111', 'Gus', 'Guest', 'link.guest@example.test', '07911 123701'),
  ('00000000-0000-4000-8000-00000000e202', '00000000-0000-0000-0000-00000000e112', 'Rita', 'Registered', 'link.registered@example.test', '07911 123702'),
  ('00000000-0000-4000-8000-00000000e203', null, 'Addie', 'Added', 'link.added@example.test', '07911 123703'),
  ('00000000-0000-4000-8000-00000000e204', '00000000-0000-0000-0000-00000000e113', 'Other', 'Guest', 'link.other@example.test', '07911 123704');

create function pg_temp.slot_date(p_offset interval) returns date language sql as $$
  select ((now() at time zone 'Europe/London') + p_offset)::date;
$$;
-- A start on the half hour that always fits in its day (a 60-minute booking at 23:30 would run past midnight, which the database refuses).
create function pg_temp.slot_start(p_offset interval) returns integer language sql as $$
  select least((floor((extract(hour from (now() at time zone 'Europe/London') + p_offset) * 60
    + extract(minute from (now() at time zone 'Europe/London') + p_offset)) / 30) * 30)::integer, 1380);
$$;
create function pg_temp.new_booking(p_id uuid, p_client uuid, p_status text, p_offset interval, p_method text, p_payment text,
  p_created_ago interval default interval '3 days') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, created_at, booking_email_snapshot)
  select p_id, 'LINK-' || p_id, p_client, a.id, pg_temp.slot_date(p_offset), pg_temp.slot_start(p_offset), 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', a.name, 85, 85, now() - p_created_ago, c.email
  from public.service_areas a, public.clients c where a.slug = 'chelsea' and c.id = p_client;
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, p_method, p_payment, 85, case when p_payment = 'paid' then now() end);
end;
$$;
-- Acting as someone: a signed-in user, or a visitor who is nobody. Each section below starts from a clean slate, because a link
-- call makes the rest of its own transaction act for the client (in the app every call is its own transaction).
create function pg_temp.as_user(p_user text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user, true);
end;
$$;
create function pg_temp.as_visitor() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
-- Who a call is acting as right now: the signed-in user, then the client and the booking a link has proved ('-' for none).
create function pg_temp.who() returns text language sql as $$
  select coalesce(auth.uid()::text, '-') || ' | ' || coalesce(auth.jwt()->>'link_client', '-') || ' | ' || coalesce(auth.jwt()->>'link_booking', '-');
$$;

-- Every date is open all day, so a booking can be moved to a time that is offered.
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.slot_date(interval '1 day' * d), true, 0, 1440, 'flexible' from generate_series(0, 12) d
on conflict (date) do update set available = true, start_minutes = 0, end_minutes = 1440, start_mode = 'flexible', fixed_start_minutes = null;

-- The bookings: b1 is the guest's, five days away; b2 is the guest's and inside 24 hours (a late fee applies to cancelling it);
-- b3 is the registered client's; b4 is the Admin-added client's; b5 is the other guest's; b6 is the guest's, six days away.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e301', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '5 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e302', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '5 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e303', '00000000-0000-4000-8000-00000000e202', 'awaiting_payment_verification', interval '7 days', 'bank_transfer', 'awaiting_verification');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e304', '00000000-0000-4000-8000-00000000e203', 'confirmed', interval '5 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e305', '00000000-0000-4000-8000-00000000e204', 'confirmed', interval '5 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e306', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '6 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e307', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '9 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e308', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '11 days', 'cash', 'approved');
-- And four more for the checks further down, all the guest's: b9 happened ten days ago, b10 is inside 24 hours (a late move), b11 and b12 are
-- ordinary and are cancelled and moved to see that a link call leaves nobody acting as the client.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e309', '00000000-0000-4000-8000-00000000e201', 'completed', interval '-10 days', 'cash', 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e310', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '8 hours', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e311', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '4 days', 'cash', 'approved');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e312', '00000000-0000-4000-8000-00000000e201', 'confirmed', interval '3 days', 'cash', 'approved');

-- ---------------------------------------------------------------------------------------------
-- The doors
-- ---------------------------------------------------------------------------------------------
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'mint_booking_access_token'
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') or not has_function_privilege('service_role', p.oid, 'EXECUTE'))),
  'Only the sender (the service key) can make a code');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'booking_link_client'
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))),
  'The check of a code cannot be called from outside at all');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('booking_by_key', 'change_terms_by_key', 'availability_by_key', 'cancel_by_key', 'reschedule_by_key')
    and (not has_function_privilege('anon', p.oid, 'EXECUTE') or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not (p.prosecdef and p.proconfig @> array['search_path=""']))),
  'The five link commands are open to a visitor and to a signed-in client, and are definers with an empty search path');
select ok((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('booking_by_key', 'change_terms_by_key', 'availability_by_key', 'cancel_by_key', 'reschedule_by_key')) = 5, 'There are exactly those five');
select ok(not has_table_privilege('anon', 'public.booking_access_tokens', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.booking_access_tokens', 'select,insert,update,delete'),
  'The codes cannot be read or changed from outside');
select ok((select relrowsecurity from pg_class where oid = 'public.booking_access_tokens'::regclass), 'Row security is on for the codes');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'client_booking_for_change'
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  'The shared internals are still closed to the browser');
select ok((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'booking_link_end') = 1
  and not exists (
    select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'booking_link_end'
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))),
  'Putting the caller back is inside work too: it cannot be called from outside at all');
-- Who a link makes the caller is for one transaction only. Everything here runs in a single transaction, so the difference cannot be seen
-- by acting; it is read from the definitions instead: every setting of the caller is made with is_local true (and none with false).
select ok((select (length(p.prosrc) - length(replace(p.prosrc, ', true);', ''))) / length(', true);') = 2 and position(', false)' in p.prosrc) = 0
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'booking_link_client'),
  'The caller a link makes is for that transaction only (a setting that outlived it would reach the next person on the same connection)');
select ok((select (length(p.prosrc) - length(replace(p.prosrc, ', true);', ''))) / length(', true);') = 2 and position(', false)' in p.prosrc) = 0
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'booking_link_end'),
  'and so is putting the caller back');

-- ---------------------------------------------------------------------------------------------
-- Making a code
-- ---------------------------------------------------------------------------------------------
create temp table tokens as
  select name, public.mint_booking_access_token(id) as token
  from (values ('t1', '00000000-0000-4000-8000-00000000e301'::uuid), ('t2', '00000000-0000-4000-8000-00000000e302'::uuid),
    ('t3', '00000000-0000-4000-8000-00000000e303'::uuid), ('t4', '00000000-0000-4000-8000-00000000e304'::uuid),
    ('t5', '00000000-0000-4000-8000-00000000e305'::uuid), ('t6', '00000000-0000-4000-8000-00000000e306'::uuid),
    ('t7', '00000000-0000-4000-8000-00000000e307'::uuid), ('t8', '00000000-0000-4000-8000-00000000e308'::uuid)) v(name, id);
grant select on tokens to anon, authenticated;
create temp table more_tokens as
  select name, public.mint_booking_access_token(id) as token
  from (values ('m9', '00000000-0000-4000-8000-00000000e309'::uuid), ('m10', '00000000-0000-4000-8000-00000000e310'::uuid),
    ('m11', '00000000-0000-4000-8000-00000000e311'::uuid), ('m12', '00000000-0000-4000-8000-00000000e312'::uuid)) v(name, id);
grant select on more_tokens to anon, authenticated;
select ok((select bool_and(token ~ '^[0-9a-f]{64}$') from tokens), 'A code is 64 random characters');
select is((select count(distinct token)::integer from tokens), 8, 'No two codes are alike');
select is((select count(*)::integer from public.booking_access_tokens t join tokens k on t.token_hash = k.token), 0, 'The code itself is not stored anywhere');
select is((select count(*)::integer from public.booking_access_tokens t join tokens k on t.token_hash = encode(sha256(convert_to(k.token, 'UTF8')), 'hex')), 8, 'Only its hash is stored');
select ok((select expires_at between now() + interval '34 days' and now() + interval '36 days' from public.booking_access_tokens t join tokens k on t.token_hash = encode(sha256(convert_to(k.token, 'UTF8')), 'hex') where k.name = 't1'),
  'A code for an appointment five days away lapses about 30 days after it');
select ok((select expires_at between now() + interval '29 days' and now() + interval '31 days' from public.booking_access_tokens t join tokens k on t.token_hash = encode(sha256(convert_to(k.token, 'UTF8')), 'hex') where k.name = 't2'),
  'A code for an appointment today lapses 30 days from now');
select ok((select expires_at between now() + interval '29 days' and now() + interval '31 days' from public.booking_access_tokens t join more_tokens k on t.token_hash = encode(sha256(convert_to(k.token, 'UTF8')), 'hex') where k.name = 'm9'),
  'A code for an appointment that has already happened still lasts 30 days from now, so an email sent after the appointment (a refund, for example) never carries a link that has already lapsed');
select throws_ok($$select public.mint_booking_access_token(gen_random_uuid())$$, 'P0002', 'Booking unavailable', 'No code can be made for a booking that is not there');
insert into public.booking_access_tokens(booking_id, token_hash, expires_at) values ('00000000-0000-4000-8000-00000000e307', 'stale-hash-for-the-test', now() - interval '8 days');
select public.mint_booking_access_token('00000000-0000-4000-8000-00000000e307');
select is((select count(*)::integer from public.booking_access_tokens where token_hash = 'stale-hash-for-the-test'), 0, 'Codes that lapsed more than a week ago are tidied away when a new one is made');

-- ---------------------------------------------------------------------------------------------
-- A visitor with the link sees the booking
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_visitor();
set local role anon;
create temp table via_link as select public.booking_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't1')) r;
grant select on via_link to authenticated;
select is((select r->>'id' from via_link), '00000000-0000-4000-8000-00000000e301', 'The link shows the booking it is for');
select is((select r->>'booking_status' from via_link), 'confirmed', 'with its status');
select is((select r->'booking_payments'->>'method' from via_link), 'cash', 'and how it is paid');
reset role;
select is(pg_temp.who(), '- | - | -', 'After a link call a visitor is still nobody, not the client');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e111');
set local role authenticated;
select is((select public.get_my_booking('00000000-0000-4000-8000-00000000e301')), (select r from via_link), 'It shows exactly what the signed-in page shows the same client');
reset role;

-- ---------------------------------------------------------------------------------------------
-- A wrong, mixed-up, short or lapsed code says one plain thing and shows nothing
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_visitor();
set local role anon;
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't5'))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'Another booking''s code does not open this booking');
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e305', (select token from tokens where name = 't1'))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'and this booking''s code does not open another');
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e301', repeat('a', 64))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'A made-up code does not open it');
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e301', null)$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'No code does not open it');
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e301', 'short')$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'A short code does not open it');
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e301', repeat('a', 500))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'A code that is far too long does not open it');
select throws_ok($$select public.booking_by_key(gen_random_uuid(), (select token from tokens where name = 't1'))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'A booking that is not there gives the same answer, so nothing is given away');
select throws_ok($$select public.booking_by_key(null, (select token from tokens where name = 't1'))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'and so does no booking at all');
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e301', upper((select token from tokens where name = 't1')))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'The code must match exactly');
reset role;
update public.booking_access_tokens set expires_at = now() - interval '1 minute'
where token_hash = (select encode(sha256(convert_to(token, 'UTF8')), 'hex') from tokens where name = 't6');
select pg_temp.as_visitor();
set local role anon;
select throws_ok($$select public.booking_by_key('00000000-0000-4000-8000-00000000e306', (select token from tokens where name = 't6'))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'A code that has lapsed does not open the booking');
reset role;
update public.booking_access_tokens set expires_at = now() + interval '30 days'
where token_hash = (select encode(sha256(convert_to(token, 'UTF8')), 'hex') from tokens where name = 't6');

-- ---------------------------------------------------------------------------------------------
-- The terms and the times are the same as the signed-in page's
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_visitor();
set local role anon;
create temp table terms_link as select public.change_terms_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't1')) r;
create temp table times_link as select a.start_minutes from public.availability_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't1'), pg_temp.slot_date(interval '8 days')) a;
grant select on terms_link, times_link to authenticated;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000e111');
set local role authenticated;
select is((select public.get_my_change_terms('00000000-0000-4000-8000-00000000e301')), (select r from terms_link), 'The link gives the same change terms');
select is((select r->>'can_change' from terms_link), 'true', 'and a booking five days away can be changed');
select results_eq($$select start_minutes from public.get_my_booking_availability('00000000-0000-4000-8000-00000000e301', pg_temp.slot_date(interval '8 days')) order by 1$$,
  $$select start_minutes from times_link order by 1$$, 'and the same times');
select ok((select count(*) from times_link) > 0, 'and there are times to choose from');
reset role;
select pg_temp.as_visitor();
set local role anon;
select is((select public.change_terms_by_key('00000000-0000-4000-8000-00000000e303', (select token from tokens where name = 't3'))->>'can_change'), 'true', 'A registered client''s link works as well');
select is((select public.change_terms_by_key('00000000-0000-4000-8000-00000000e304', (select token from tokens where name = 't4'))->>'can_change'), 'true', 'and so does the link of a client the Admin added, who has no login at all');
select throws_ok($$select * from public.availability_by_key('00000000-0000-4000-8000-00000000e301', repeat('b', 64), pg_temp.slot_date(interval '8 days'))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'Times are not given for a wrong code');
select throws_ok($$select public.change_terms_by_key('00000000-0000-4000-8000-00000000e301', repeat('b', 64))$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'and neither are the terms');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Cancelling from the link
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_visitor();
set local role anon;
create temp table cancelled as select public.cancel_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't1'), 'cccccccc-0000-4000-8000-000000000001', 0, 'Plans changed') r;
reset role;
select is((select r->>'booking_status' from cancelled), 'cancelled', 'Cancelling from the link cancels the booking');
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000e301'), 'cancelled', 'in the database too');
select is((select cancellation_reason from public.bookings where id = '00000000-0000-4000-8000-00000000e301'), 'Plans changed', 'and keeps the reason the client gave');
select results_eq($$select scope, actor_type, actor_id, command_type from public.command_requests where idempotency_key = 'cccccccc-0000-4000-8000-000000000001'$$,
  $$values ('client-self-service:00000000-0000-4000-8000-00000000e201'::text, 'client'::text, '00000000-0000-4000-8000-00000000e201'::text, 'client_cancel_booking'::text)$$,
  'It is recorded as the client''s own doing');
select results_eq($$select e.payload->>'initiated_by', e.payload->>'actor_id' from public.event_outbox e where e.event_type = 'booking.cancelled' and e.aggregate_id = '00000000-0000-4000-8000-00000000e301'$$,
  $$values ('client'::text, '00000000-0000-4000-8000-00000000e201'::text)$$, 'and the cancellation event says the client did it');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e301' and d.audience = 'client' and d.channel = 'email' and d.title = 'Your appointment is cancelled'), 1, 'The client is emailed that it is cancelled');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e301' and d.audience = 'admin' and d.channel = 'in_app'), 1, 'and the Admin sees it in the app');
select pg_temp.as_visitor();
set local role anon;
select is((select public.cancel_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't1'), 'cccccccc-0000-4000-8000-000000000001', 0, 'Plans changed')->>'booking_status'), 'cancelled',
  'Pressing again with the same request key says the same thing');
reset role;
select is((select count(*)::integer from public.event_outbox where event_type = 'booking.cancelled' and aggregate_id = '00000000-0000-4000-8000-00000000e301'), 1, 'and does not cancel twice');
select pg_temp.as_visitor();
set local role anon;
select is((select public.booking_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't1'))->>'booking_status'), 'cancelled', 'The link still opens the booking afterwards, and says it is cancelled');
select is((select public.change_terms_by_key('00000000-0000-4000-8000-00000000e301', (select token from tokens where name = 't1'))->>'can_change'), 'false', 'and that it can no longer be changed');
-- Inside 24 hours a late fee applies and has to be acknowledged, exactly as on the signed-in page.
select throws_ok($$select public.cancel_by_key('00000000-0000-4000-8000-00000000e302', (select token from tokens where name = 't2'), 'cccccccc-0000-4000-8000-000000000002', 0, null)$$, 'PT409',
  'The late fee has changed. Please review it and confirm again.', 'A late cancellation that has not acknowledged the fee is refused, as on the signed-in page');
create temp table late_terms as select public.change_terms_by_key('00000000-0000-4000-8000-00000000e302', (select token from tokens where name = 't2')) r;
select ok((select (r->>'cancel_fee_gbp')::numeric > 0 from late_terms), 'The terms show the fee');
create temp table late_cancel as select public.cancel_by_key('00000000-0000-4000-8000-00000000e302', (select token from tokens where name = 't2'), 'cccccccc-0000-4000-8000-000000000003', (select (r->>'cancel_fee_gbp')::numeric from late_terms), null) r;
reset role;
select ok((select late_fee_due_gbp > 0 and late_fee_status = 'due' from public.bookings where id = '00000000-0000-4000-8000-00000000e302'), 'Once acknowledged, the late cancellation goes through and records the fee as due');
-- The client the Admin added, with no login, can cancel too.
select pg_temp.as_visitor();
set local role anon;
select is((select public.cancel_by_key('00000000-0000-4000-8000-00000000e304', (select token from tokens where name = 't4'), 'cccccccc-0000-4000-8000-000000000004', 0, null)->>'booking_status'), 'cancelled',
  'A client with no login can cancel from the link');
reset role;
select results_eq($$select scope, actor_id from public.command_requests where idempotency_key = 'cccccccc-0000-4000-8000-000000000004'$$,
  $$values ('client-self-service:00000000-0000-4000-8000-00000000e203'::text, '00000000-0000-4000-8000-00000000e203'::text)$$, 'and it is recorded against that client');
-- Someone else's code cannot cancel someone else's booking.
select pg_temp.as_visitor();
set local role anon;
select throws_ok($$select public.cancel_by_key('00000000-0000-4000-8000-00000000e305', (select token from tokens where name = 't1'), 'cccccccc-0000-4000-8000-000000000005', 0, null)$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'A code for another booking cannot cancel this one');
reset role;
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000e305'), 'confirmed', 'which is still confirmed');

-- ---------------------------------------------------------------------------------------------
-- Moving from the link
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_visitor();
set local role anon;
create temp table offered as select a.start_minutes from public.availability_by_key('00000000-0000-4000-8000-00000000e306', (select token from tokens where name = 't6'), pg_temp.slot_date(interval '9 days')) a order by 1 limit 1;
create temp table moved as select public.reschedule_by_key('00000000-0000-4000-8000-00000000e306', (select token from tokens where name = 't6'), 'cccccccc-0000-4000-8000-000000000006',
  pg_temp.slot_date(interval '9 days'), (select start_minutes from offered), 0) r;
reset role;
select is((select r->>'date' from moved), pg_temp.slot_date(interval '9 days')::text, 'Moving from the link moves the booking to the day chosen');
select is((select start_minutes from public.bookings where id = '00000000-0000-4000-8000-00000000e306'), (select start_minutes from offered), 'and the time chosen');
select results_eq($$select e.payload->>'initiated_by', e.payload->>'actor_id' from public.event_outbox e where e.event_type = 'booking.rescheduled' and e.aggregate_id = '00000000-0000-4000-8000-00000000e306'$$,
  $$values ('client'::text, '00000000-0000-4000-8000-00000000e201'::text)$$, 'The move is recorded as the client''s own doing');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e306' and d.audience = 'client' and d.channel = 'email' and d.title = 'Your appointment has moved'), 1, 'and the client is emailed about it');
select pg_temp.as_visitor();
set local role anon;
select throws_ok($$select public.reschedule_by_key('00000000-0000-4000-8000-00000000e307', (select token from tokens where name = 't7'), 'cccccccc-0000-4000-8000-000000000007', pg_temp.slot_date(interval '9 days'), 15, 0)$$, '22023',
  'Please choose a start time on the hour or half hour.', 'The rules of moving are the same: a start time must be on the hour or half hour');
select throws_ok($$select public.reschedule_by_key('00000000-0000-4000-8000-00000000e307', (select token from tokens where name = 't1'), 'cccccccc-0000-4000-8000-000000000008', pg_temp.slot_date(interval '9 days'), 600, 0)$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'and the wrong code cannot move it');
reset role;
-- Moving a booking inside 24 hours costs the late fee, which has to be acknowledged first, exactly as on the signed-in page.
select pg_temp.as_visitor();
set local role anon;
create temp table late_move_terms as select public.change_terms_by_key('00000000-0000-4000-8000-00000000e310', (select token from more_tokens where name = 'm10')) r;
create temp table late_offered as select a.start_minutes from public.availability_by_key('00000000-0000-4000-8000-00000000e310', (select token from more_tokens where name = 'm10'), pg_temp.slot_date(interval '10 days')) a order by 1 limit 1;
select ok((select (r->>'reschedule_fee_gbp')::numeric > 0 from late_move_terms), 'Moving a booking inside 24 hours shows the late fee');
select throws_ok($$select public.reschedule_by_key('00000000-0000-4000-8000-00000000e310', (select token from more_tokens where name = 'm10'), 'cccccccc-0000-4000-8000-00000000000b',
  pg_temp.slot_date(interval '10 days'), (select start_minutes from late_offered), 0)$$, 'PT409',
  'The late fee has changed. Please review it and confirm again.', 'and moving it without acknowledging the fee is refused, as on the signed-in page');
create temp table late_moved as select public.reschedule_by_key('00000000-0000-4000-8000-00000000e310', (select token from more_tokens where name = 'm10'), 'cccccccc-0000-4000-8000-00000000000c',
  pg_temp.slot_date(interval '10 days'), (select start_minutes from late_offered), (select (r->>'reschedule_fee_gbp')::numeric from late_move_terms)) r;
reset role;
select ok((select late_fee_due_gbp > 0 and late_fee_status = 'due' and date = pg_temp.slot_date(interval '10 days') from public.bookings where id = '00000000-0000-4000-8000-00000000e310'),
  'Once the fee is acknowledged the booking moves and the fee is recorded as due');
select is(pg_temp.who(), '- | - | -', 'and after moving it a visitor is still nobody, not the client');

-- ---------------------------------------------------------------------------------------------
-- A link does not sign anyone in, and leaves the signed-in rules as they were
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select is((select public.booking_by_key('00000000-0000-4000-8000-00000000e307', (select token from tokens where name = 't7'))->>'id'), '00000000-0000-4000-8000-00000000e307',
  'A signed-in client (or the Admin) who opens someone else''s link sees that booking');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select throws_ok($$select public.get_my_booking('00000000-0000-4000-8000-00000000e307')$$, '42501', 'Booking is not available to this client',
  'but the same person still cannot see it through the signed-in page');
select throws_ok($$select public.get_my_change_terms('00000000-0000-4000-8000-00000000e307')$$, '42501', 'Booking is not available to this client',
  'or its terms');
select is((select public.get_my_booking('00000000-0000-4000-8000-00000000e303')->>'id'), '00000000-0000-4000-8000-00000000e303', 'Their own booking is still theirs');
reset role;
-- Cancelling from someone else's link while signed in is recorded as the client's own doing, not the signed-in person's.
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select is((select public.cancel_by_key('00000000-0000-4000-8000-00000000e308', (select token from tokens where name = 't8'), 'cccccccc-0000-4000-8000-00000000000a', 0, null)->>'booking_status'), 'cancelled',
  'A signed-in person (or the Admin) who holds the link can cancel with it');
reset role;
select results_eq($$select scope, actor_id from public.command_requests where idempotency_key = 'cccccccc-0000-4000-8000-00000000000a'$$,
  $$values ('client-self-service:00000000-0000-4000-8000-00000000e201'::text, '00000000-0000-4000-8000-00000000e201'::text)$$,
  'and it is recorded as the client''s doing, not the signed-in person''s');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e113');
set local role authenticated;
select is((select public.get_my_booking('00000000-0000-4000-8000-00000000e305')->>'id'), '00000000-0000-4000-8000-00000000e305', 'A guest still sees their own booking in their own browser');
select throws_ok($$select public.get_my_booking('00000000-0000-4000-8000-00000000e307')$$, '42501', 'Booking is not available to this client', 'and still not another guest''s');
select throws_ok($$select public.cancel_by_key('00000000-0000-4000-8000-00000000e307', repeat('c', 64), 'cccccccc-0000-4000-8000-000000000009', 0, null)$$, '42501',
  'This link is not valid or has expired. Please contact Vad.', 'A wrong code does not become right because the caller is signed in');
reset role;
select pg_temp.as_visitor();
set local role anon;
select throws_ok($$select public.get_my_booking('00000000-0000-4000-8000-00000000e307')$$, '42501', 'permission denied for function get_my_booking',
  'A visitor cannot call the signed-in page''s functions at all');
reset role;

-- ---------------------------------------------------------------------------------------------
-- A code proves one booking, not everything its client has
-- ---------------------------------------------------------------------------------------------
-- Called directly (as the database's own user), so that nothing puts the caller back: this is exactly what a link leaves behind for the
-- functions it runs, and they must find only the one booking.
select pg_temp.as_visitor();
select public.booking_link_client('00000000-0000-4000-8000-00000000e307', (select token from tokens where name = 't7'));
select is(pg_temp.who(), '00000000-0000-4000-8000-00000000e201 | 00000000-0000-4000-8000-00000000e201 | 00000000-0000-4000-8000-00000000e307',
  'A code makes the caller its client, for its one booking');
select is((select public.get_my_booking('00000000-0000-4000-8000-00000000e307')->>'id'), '00000000-0000-4000-8000-00000000e307', 'A code opens its own booking');
select throws_ok($$select public.get_my_booking('00000000-0000-4000-8000-00000000e306')$$, '42501', 'Booking is not available to this client',
  'but not another booking of the same client');
select throws_ok($$select public.get_my_change_terms('00000000-0000-4000-8000-00000000e306')$$, '42501', 'Booking is not available to this client', 'nor its terms');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000e306', gen_random_uuid(), 0)$$, '42501', 'Booking is not available to this client',
  'nor can it cancel it');
select throws_ok($$select public.client_reschedule_booking('00000000-0000-4000-8000-00000000e306', gen_random_uuid(), pg_temp.slot_date(interval '9 days'), 600, 0)$$, '42501',
  'Booking is not available to this client', 'nor move it');
select throws_ok($$select public.get_my_booking('00000000-0000-4000-8000-00000000e305')$$, '42501', 'Booking is not available to this client',
  'and certainly not another client''s booking');
select throws_ok($$select public.get_my_change_terms('00000000-0000-4000-8000-00000000e305')$$, '42501', 'Booking is not available to this client', 'or its terms');
select pg_temp.as_visitor();

-- ---------------------------------------------------------------------------------------------
-- A link call is one call: the caller is put back afterwards, so nothing after it acts as the client
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select public.booking_by_key('00000000-0000-4000-8000-00000000e307', (select token from tokens where name = 't7'));
reset role;
select is(pg_temp.who(), '00000000-0000-0000-0000-00000000e112 | - | -', 'After viewing by link a signed-in person is themself again, not the client');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select public.change_terms_by_key('00000000-0000-4000-8000-00000000e307', (select token from tokens where name = 't7'));
reset role;
select is(pg_temp.who(), '00000000-0000-0000-0000-00000000e112 | - | -', 'and after asking for the terms');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select count(*) from public.availability_by_key('00000000-0000-4000-8000-00000000e307', (select token from tokens where name = 't7'), pg_temp.slot_date(interval '8 days'));
reset role;
select is(pg_temp.who(), '00000000-0000-0000-0000-00000000e112 | - | -', 'and after asking for the times');
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select public.cancel_by_key('00000000-0000-4000-8000-00000000e311', (select token from more_tokens where name = 'm11'), 'cccccccc-0000-4000-8000-00000000000d', 0, null);
reset role;
select is(pg_temp.who(), '00000000-0000-0000-0000-00000000e112 | - | -', 'and after cancelling');
select pg_temp.as_visitor();
create temp table restore_offered as select a.start_minutes from public.availability_by_key('00000000-0000-4000-8000-00000000e312', (select token from more_tokens where name = 'm12'), pg_temp.slot_date(interval '12 days')) a order by 1 limit 1;
grant select on restore_offered to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000e112');
set local role authenticated;
select public.reschedule_by_key('00000000-0000-4000-8000-00000000e312', (select token from more_tokens where name = 'm12'), 'cccccccc-0000-4000-8000-00000000000e',
  pg_temp.slot_date(interval '12 days'), (select start_minutes from restore_offered), 0);
reset role;
select is(pg_temp.who(), '00000000-0000-0000-0000-00000000e112 | - | -', 'and after moving');
select ok((select booking_status = 'cancelled' from public.bookings where id = '00000000-0000-4000-8000-00000000e311')
  and (select date = pg_temp.slot_date(interval '12 days') from public.bookings where id = '00000000-0000-4000-8000-00000000e312'), 'Each of those calls still did its work');

-- ---------------------------------------------------------------------------------------------
-- Tidiness
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::integer from public.booking_access_tokens where booking_id = '00000000-0000-4000-8000-00000000e307'), 2, 'Each email gets a code of its own, so a booking can have several');
delete from public.bookings where id = '00000000-0000-4000-8000-00000000e307';
select is((select count(*)::integer from public.booking_access_tokens where booking_id = '00000000-0000-4000-8000-00000000e307'), 0, 'When a booking goes, so do its codes');

select * from finish();
rollback;
