begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- People. g1 is a guest session (a visitor who booked without an account), r1 has a real login, and a1 was added by the Admin and has no
-- login at all. o1 is a signed-in user with no client profile. Each client has an email, so the planner writes them an email.
-- ---------------------------------------------------------------------------------------------
insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000f111', 'authenticated', 'authenticated', null, '', null, '{"provider":"anonymous","providers":[]}', '{}', now(), now(), true),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000f112', 'authenticated', 'authenticated', 'tg.registered@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000f113', 'authenticated', 'authenticated', 'tg.nobody@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000f114', 'authenticated', 'authenticated', 'tg.newcomer@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000f101', 'authenticated', 'authenticated', 'tg.admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false);
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f101');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000f201', '00000000-0000-0000-0000-00000000f111', 'Gus', 'Guest', 'tg.guest@example.test', '07911 223701'),
  ('00000000-0000-4000-8000-00000000f202', '00000000-0000-0000-0000-00000000f112', 'Rita', 'Registered', 'tg.registered@example.test', '07911 223702'),
  ('00000000-0000-4000-8000-00000000f203', null, 'Addie', 'Added', 'tg.added@example.test', '07911 223703'),
  ('00000000-0000-4000-8000-00000000f204', '00000000-0000-0000-0000-00000000f114', 'Nia', 'Newcomer', 'tg.newcomer@example.test', '07911 223704'),
  ('00000000-0000-4000-8000-00000000f205', null, 'Mia', 'Merged', 'tg.merged@example.test', '07911 223705');

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
create function pg_temp.hash(p_text text) returns text language sql as $$ select encode(sha256(convert_to(p_text, 'UTF8')), 'hex'); $$;
-- A booking for a client, and an event about it: the planner then writes the client's email, which is what gets copied to Telegram.
create function pg_temp.booking(p_id uuid, p_client uuid) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'TG-' || p_id, p_client, a.id, current_date + 5, 600, 60, 'confirmed', 'test', '1 Test Road', 'London', 'SW1A 1AA', a.name, 85, 85, c.email
  from public.service_areas a, public.clients c where a.slug = 'chelsea' and c.id = p_client;
  insert into public.booking_payments(booking_id, method, status, amount_gbp) values (p_id, 'cash', 'approved', 85);
end;
$$;
create function pg_temp.event(p_booking uuid, p_type text, p_key text) returns uuid language sql as $$
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values (p_type, 'booking', p_booking, p_key, jsonb_build_object('booking_id', p_booking, 'initiated_by', 'admin', 'source', 'admin'))
  returning id;
$$;

-- ---------------------------------------------------------------------------------------------
-- The doors
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.create_my_telegram_link()', 'EXECUTE') and has_function_privilege('authenticated', 'public.create_my_telegram_link()', 'EXECUTE'),
  'Asking for a code is for a signed-in or guest client, not for a visitor with no session');
select ok(not has_function_privilege('anon', 'public.my_telegram_status()', 'EXECUTE') and has_function_privilege('authenticated', 'public.my_telegram_status()', 'EXECUTE'),
  'and so is asking whether a chat is linked');
select ok(not has_function_privilege('anon', 'public.link_client_telegram(text,bigint)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.link_client_telegram(text,bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.link_client_telegram(text,bigint)', 'EXECUTE'), 'Only the Telegram webhook (the service key) can link a chat');
select ok(not has_function_privilege('anon', 'public.stop_client_telegram(bigint)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.stop_client_telegram(bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.stop_client_telegram(bigint)', 'EXECUTE'), 'and only it can stop one');
select ok(not has_function_privilege('anon', 'public.mirror_client_email_to_telegram()', 'EXECUTE') and not has_function_privilege('authenticated', 'public.mirror_client_email_to_telegram()', 'EXECUTE'),
  'The copying of emails is not something the browser can run');
select ok(not has_function_privilege('anon', 'public.keep_telegram_links_on_merge()', 'EXECUTE') and not has_function_privilege('authenticated', 'public.keep_telegram_links_on_merge()', 'EXECUTE'),
  'and neither is the moving of chats when two profiles are combined');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('create_my_telegram_link', 'my_telegram_status', 'link_client_telegram', 'stop_client_telegram', 'mirror_client_email_to_telegram', 'keep_telegram_links_on_merge')
    and not coalesce(p.prosecdef and p.proconfig @> array['search_path=""'], false)), 'All of them are definers with an empty search path');
select ok(not has_table_privilege('anon', 'public.client_telegram_tokens', 'select,insert,update,delete') and not has_table_privilege('authenticated', 'public.client_telegram_tokens', 'select,insert,update,delete')
  and not has_table_privilege('anon', 'public.client_telegram_links', 'select,insert,update,delete') and not has_table_privilege('authenticated', 'public.client_telegram_links', 'select,insert,update,delete'),
  'The codes and the linked chats cannot be read or changed from outside');
select ok((select relrowsecurity from pg_class where oid = 'public.client_telegram_tokens'::regclass) and (select relrowsecurity from pg_class where oid = 'public.client_telegram_links'::regclass),
  'Row security is on for both');
create temp table probe as
  with made as (insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('booking.created', 'booking', gen_random_uuid(), 'tg-constraint-probe', '{}') returning id)
  select id from made;
select lives_ok($$insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
  values ((select id from probe), 'telegram_client', 'client', '424242', 't', 'b')$$, 'The client Telegram channel exists, for a client');
select throws_ok($$insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
  values ((select id from probe), 'telegram_client', 'admin', 'admin', 't', 'b')$$, '23514', null, 'but only for a client: it can never carry a message meant for the Admin');
select throws_ok($$insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
  values ((select id from probe), 'whatsapp', 'client', '1', 't', 'b')$$, '23514', null, 'and no other new channel was let in');
delete from public.notification_deliveries where event_id = (select id from probe);
delete from public.event_outbox where id = (select id from probe);

-- ---------------------------------------------------------------------------------------------
-- Asking for a code
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000f111');
set local role authenticated;
create temp table codes as select 'guest'::text as who, public.create_my_telegram_link() as code;
select is((select public.my_telegram_status()->>'linked'), 'false', 'A guest is not linked to begin with');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f112');
set local role authenticated;
insert into codes select 'registered', public.create_my_telegram_link();
insert into codes select 'registered2', public.create_my_telegram_link();
reset role;
grant select on codes to authenticated;
select ok((select bool_and(code ~ '^[0-9a-f]{32}$') from codes), 'A code is 32 random letters and digits');
select is((select count(distinct code)::integer from codes), 3, 'No two codes are alike');
select is((select count(*)::integer from public.client_telegram_tokens t join codes c on t.token_hash = c.code), 0, 'The code itself is not stored anywhere');
select is((select count(*)::integer from public.client_telegram_tokens t join codes c on t.token_hash = pg_temp.hash(c.code)), 3, 'Only its hash is stored');
select ok((select bool_and(t.expires_at between now() + interval '119 minutes' and now() + interval '121 minutes' and t.used_at is null)
  from public.client_telegram_tokens t join codes c on t.token_hash = pg_temp.hash(c.code)), 'A code lasts two hours and is not used');
select is((select count(*)::integer from public.client_telegram_tokens t join codes c on t.token_hash = pg_temp.hash(c.code) join public.clients cl on cl.id = t.client_id where cl.auth_user_id = '00000000-0000-0000-0000-00000000f111' and c.who = 'guest'), 1,
  'It is for the client who asked');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f113');
set local role authenticated;
select throws_ok($$select public.create_my_telegram_link()$$, '42501', 'Authentication required', 'Someone with no client profile gets no code');
select throws_ok($$select public.my_telegram_status()$$, '42501', 'Authentication required', 'and cannot ask about one');
reset role;
select pg_temp.as_visitor();
set local role anon;
select throws_ok($$select public.create_my_telegram_link()$$, '42501', 'permission denied for function create_my_telegram_link', 'A visitor with no session cannot ask at all');
reset role;
-- No more than ten an hour.
select pg_temp.as_user('00000000-0000-0000-0000-00000000f111');
set local role authenticated;
select lives_ok($$select public.create_my_telegram_link() from generate_series(1, 9)$$, 'Nine more codes are fine (ten in the hour)');
select throws_ok($$select public.create_my_telegram_link()$$, 'PT429', 'Please wait a little before asking again.', 'The eleventh is asked to wait');
reset role;
-- Old codes are tidied away when a new one is made.
insert into public.client_telegram_tokens(client_id, token_hash, expires_at) values ('00000000-0000-4000-8000-00000000f202', 'stale-telegram-hash-for-the-test', now() - interval '2 days');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f112');
set local role authenticated;
select public.create_my_telegram_link();
reset role;
select is((select count(*)::integer from public.client_telegram_tokens where token_hash = 'stale-telegram-hash-for-the-test'), 0, 'Codes that lapsed more than a day ago are tidied away when a new one is made');

-- ---------------------------------------------------------------------------------------------
-- Pressing Start in Telegram: the webhook links the chat
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_visitor();
select is((select public.link_client_telegram((select code from codes where who = 'guest'), 111001)->>'status'), 'linked', 'Start with a good code links the chat');
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f201' and chat_id = 111001 and stopped_at is null), 1, 'for that client');
select ok((select t.used_at is not null from public.client_telegram_tokens t where t.token_hash = pg_temp.hash((select code from codes where who = 'guest'))), 'and the code is used up');
select is((select public.link_client_telegram((select code from codes where who = 'guest'), 111001)->>'status'), 'linked', 'Telegram asking again for the same chat is not a failure: it is still linked');
select is((select public.link_client_telegram((select code from codes where who = 'guest'), 999999)->>'status'), 'used', 'but another chat cannot use the same code');
select is((select count(*)::integer from public.client_telegram_links where chat_id = 999999), 0, 'and is not linked');
select is((select public.link_client_telegram(repeat('a', 32), 111002)->>'status'), 'invalid', 'A made-up code is not valid');
select is((select public.link_client_telegram('short', 111002)->>'status'), 'invalid', 'nor is a short one');
select is((select public.link_client_telegram(repeat('a', 200), 111002)->>'status'), 'invalid', 'nor one that is far too long');
select is((select public.link_client_telegram(null, 111002)->>'status'), 'invalid', 'nor no code');
select is((select public.link_client_telegram((select code from codes where who = 'registered'), null)->>'status'), 'invalid', 'nor a code with no chat');
select is((select count(*)::integer from public.client_telegram_tokens t where t.token_hash = pg_temp.hash((select code from codes where who = 'registered')) and t.used_at is null), 1, 'which leaves the code unused');
update public.client_telegram_tokens set expires_at = now() - interval '1 minute' where token_hash = pg_temp.hash((select code from codes where who = 'registered2'));
select is((select public.link_client_telegram((select code from codes where who = 'registered2'), 111003)->>'status'), 'expired', 'A code that has lapsed says so');
select is((select count(*)::integer from public.client_telegram_links where chat_id = 111003), 0, 'and links nothing');
select is((select public.link_client_telegram((select code from codes where who = 'registered'), 111003)->>'status'), 'linked', 'A registered client links a chat the same way');
-- One chat can belong to two people who share a phone, and one person can link two chats.
select pg_temp.as_user('00000000-0000-0000-0000-00000000f112');
set local role authenticated;
create temp table more_codes as select public.create_my_telegram_link() as code;
grant select on more_codes to service_role;
reset role;
select pg_temp.as_visitor();
select is((select public.link_client_telegram((select code from more_codes), 111001)->>'status'), 'linked', 'The same chat can be linked for a second client (a shared phone)');
select is((select count(*)::integer from public.client_telegram_links where chat_id = 111001 and stopped_at is null), 2, 'and both are linked');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f112');
set local role authenticated;
select is((select public.my_telegram_status()->>'linked'), 'true', 'The client is told they are linked');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f111');
set local role authenticated;
select is((select public.my_telegram_status()->>'linked'), 'true', 'and so is the guest');
reset role;

-- ---------------------------------------------------------------------------------------------
-- What the bot is told: whose appointments the chat was just connected to. Linking a chat spends the client's other unused codes.
-- Nia (f204) asks for two codes; chat numbers beyond 2^31 are real ones.
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000f114');
set local role authenticated;
create temp table nia_codes as select 'first'::text as which, public.create_my_telegram_link() as code;
insert into nia_codes select 'second', public.create_my_telegram_link();
reset role;
select pg_temp.as_visitor();
select results_eq($$select q.s->>'status', q.s->>'first_name' from (select public.link_client_telegram((select code from nia_codes where which = 'first'), 5000000001) s) q$$,
  $$values ('linked'::text, 'Nia'::text)$$, 'Linking answers with the client''s first name, so the bot can say whose appointments the chat is connected to');
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f204' and chat_id = 5000000001 and stopped_at is null), 1,
  'A chat number beyond 2^31 is kept whole');
select is((select public.link_client_telegram((select code from nia_codes where which = 'first'), 5000000001)->>'first_name'), 'Nia', 'Asking again for the same chat gives the name again');
select is((select public.link_client_telegram((select code from nia_codes where which = 'second'), 5000000002)->>'status'), 'used',
  'The client''s other code was spent when the chat linked, so it cannot link a second chat');
select ok((select t.used_at is not null from public.client_telegram_tokens t where t.token_hash = pg_temp.hash((select code from nia_codes where which = 'second'))), 'and the record says so');
select is((select count(*)::integer from public.client_telegram_links where chat_id = 5000000002), 0, 'Nothing was linked for it');
-- A name with line breaks, markup or no end is cut to one short line before it is said to anyone.
update public.clients set first_name = E'  Nia\n   <b>x</b> and a very long name that carries on past forty characters  ' where id = '00000000-0000-4000-8000-00000000f204';
select pg_temp.as_user('00000000-0000-0000-0000-00000000f114');
set local role authenticated;
create temp table nia_third as select public.create_my_telegram_link() as code;
reset role;
select pg_temp.as_visitor();
create temp table nia_answer as select public.link_client_telegram((select code from nia_third), 5000000003) as j;
select ok((select (j->>'first_name') !~ E'[\\r\\n]' and length(j->>'first_name') <= 40 and (j->>'first_name') like 'Nia <b>x</b> and a very long%' from nia_answer),
  'A name with line breaks or no end is made one line of at most 40 characters');
update public.clients set first_name = 'Nia' where id = '00000000-0000-4000-8000-00000000f204';
select is((select public.link_client_telegram('0000000000000000000000000000dead', 5000000004)->>'first_name'), null, 'A code that is not valid carries no name');

-- ---------------------------------------------------------------------------------------------
-- Stopping
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_visitor();
select is(public.stop_client_telegram(111003), 1, '/stop ends the link of that chat and says how many it ended');
select is(public.stop_client_telegram(111003), 0, 'and ending it again ends nothing');
select is((select count(*)::integer from public.client_telegram_links where chat_id = 111003 and stopped_at is not null), 1, 'The link stays on record, stopped');
select is(public.stop_client_telegram(111001), 2, 'A chat shared by two clients stops for both');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f111');
set local role authenticated;
select is((select public.my_telegram_status()->>'linked'), 'false', 'and the client is told they are no longer linked');
reset role;
select pg_temp.as_visitor();
create temp table again_code as select '0123456789abcdef0123456789abcdef'::text as code;
insert into public.client_telegram_tokens(client_id, token_hash, expires_at) values ('00000000-0000-4000-8000-00000000f201', pg_temp.hash('0123456789abcdef0123456789abcdef'), now() + interval '1 hour');
select is((select public.link_client_telegram('0123456789abcdef0123456789abcdef', 111001)->>'status'), 'linked', 'Linking again after a stop works');
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f201' and chat_id = 111001 and stopped_at is null), 1, 'with the same link made live again, not a second one');
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f201' and chat_id = 111001), 1, 'There is still one row for that client and chat');

-- ---------------------------------------------------------------------------------------------
-- Every client email about a booking is copied to the client's linked chats
-- Gus has chat 111001 linked now. Rita has chat 111003 stopped. Addie has none.
-- ---------------------------------------------------------------------------------------------
select pg_temp.booking('00000000-0000-4000-8000-00000000f301', '00000000-0000-4000-8000-00000000f201');
select pg_temp.booking('00000000-0000-4000-8000-00000000f302', '00000000-0000-4000-8000-00000000f202');
select pg_temp.booking('00000000-0000-4000-8000-00000000f303', '00000000-0000-4000-8000-00000000f203');
create temp table ev as select
  pg_temp.event('00000000-0000-4000-8000-00000000f301', 'booking.rescheduled', 'tg-gus-moved') as gus,
  pg_temp.event('00000000-0000-4000-8000-00000000f302', 'booking.rescheduled', 'tg-rita-moved') as rita,
  pg_temp.event('00000000-0000-4000-8000-00000000f303', 'booking.rescheduled', 'tg-addie-moved') as addie;
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'email' and d.audience = 'client' and d.event_id in (select gus from ev union select rita from ev union select addie from ev)), 3,
  'Each of the three clients is emailed that their appointment has moved');
select results_eq($$select d.audience, d.recipient, d.title from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select gus from ev)$$,
  $$values ('client'::text, '111001'::text, 'Your appointment has moved'::text)$$, 'A client with a linked chat gets the same message there, with the same title');
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select rita from ev)), 0, 'A client whose link was stopped gets nothing there');
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select addie from ev)), 0, 'and neither does one who never linked a chat');
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id in (select gus from ev union select rita from ev union select addie from ev)), 1, 'Only that one message was made');
select ok((select d.body like 'Your appointment is now on %' and d.body like '%Reference: TG-%' and d.body like E'%\n\nTo change or cancel, use the link in your email, or contact Vad.'
  and d.body not like '%See or change your booking%' and d.body not like '%{link}%' and d.body not like '%Warm wishes%' and d.body not like '%Vad' || E'\n' || '%'
  from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select gus from ev)),
  'It says what the email says, without the link line and the sign-off, and ends by saying where to change or cancel');
select is((select d.link_path from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select gus from ev)), null, 'It carries no link to the booking');
select is((select d.status from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select gus from ev)), 'pending', 'and waits for the sender');
-- A client with two chats gets both. (The ten codes the guest asked for above were an hour ago by now.)
update public.client_telegram_tokens set created_at = now() - interval '2 hours' where client_id = '00000000-0000-4000-8000-00000000f201';
select pg_temp.as_user('00000000-0000-0000-0000-00000000f111');
set local role authenticated;
create temp table second as select public.create_my_telegram_link() as code;
grant select on second to service_role;
reset role;
select pg_temp.as_visitor();
select public.link_client_telegram((select code from second), 111004);
create temp table ev2 as select pg_temp.event('00000000-0000-4000-8000-00000000f301', 'booking.cancelled', 'tg-gus-cancelled') as id;
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select id from ev2)), 2, 'A client with two linked chats gets the message in both');
select results_eq($$select d.recipient from public.notification_deliveries d where d.channel = 'telegram_client' and d.event_id = (select id from ev2) order by 1$$,
  $$values ('111001'::text), ('111004'::text)$$, 'the two chats they linked');
-- What is not copied: receipts, repeat reminders, and anything that is not one of the booking messages.
create temp table other as select (select id from public.event_outbox where deduplication_key = 'tg-gus-moved') as event_id;
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
values ('booking.receipt_emailed', 'booking', '00000000-0000-4000-8000-00000000f301', 'tg-gus-receipt', '{}'), ('series.reminder', 'booking', '00000000-0000-4000-8000-00000000f301', 'tg-gus-series', '{}'),
  ('client.possible_duplicate', 'client', '00000000-0000-4000-8000-00000000f201', 'tg-gus-dup', '{}');
insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
select e.id, 'email', 'client', 'tg.guest@example.test', 'Your receipt', E'Here it is.\n\nWarm wishes,\nVad' from public.event_outbox e where e.deduplication_key in ('tg-gus-receipt', 'tg-gus-series', 'tg-gus-dup');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where d.channel = 'telegram_client' and e.deduplication_key in ('tg-gus-receipt', 'tg-gus-series', 'tg-gus-dup')), 0,
  'A receipt, a repeat reminder and a message that is not about a booking are not copied');
-- The Admin's own messages are never copied, and a message for a booking that is gone makes nothing.
insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
select (select gus from ev), 'email', 'admin', 'admin', 'Admin alert', 'For the Admin.';
insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
select (select gus from ev), 'telegram', 'admin', 'admin', 'Admin alert', 'For the Admin.';
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'telegram_client' and d.title = 'Admin alert'), 0, 'The Admin''s messages are never copied to a client''s chat');
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'telegram_client' and d.recipient = '111001' and d.audience <> 'client'), 0, 'and nothing in a client chat is meant for anyone else');
-- Where the closing line is useful it is there (the moved message above ends with it); on a cancellation it would only be noise.
select ok((select d.body not like '%To change or cancel%' and d.body like 'I am sorry, I have had to cancel your appointment for %' from public.notification_deliveries d
  where d.channel = 'telegram_client' and d.recipient = '111001' and d.event_id = (select id from ev2)),
  'A message about a cancellation does not end by saying where to change or cancel');

-- ---------------------------------------------------------------------------------------------
-- /stop means stop: what is still waiting for that chat is dropped (one already handed to Telegram at that moment cannot be called back), and
-- what waits for another chat, or has already gone, is left alone.
-- ---------------------------------------------------------------------------------------------
insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, status, sent_at)
values ((select gus from ev), 'telegram_client', 'client', '111004', 'Gone already', 'Sent before.', 'sent', now());
insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, status, attempt_count, next_attempt_at, last_error)
values ((select addie from ev), 'telegram_client', 'client', '111004', 'Tried once', 'Waiting for another go.', 'failed', 2, now() + interval '30 minutes', 'Telegram: a timeout');
-- Only the messages on the client Telegram channel are dropped: a row on another channel that happens to carry the same text as its recipient is not.
insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
values ((select addie from ev), 'email', 'client', '111004', 'Not a Telegram message', 'Another channel altogether.');
select is(public.stop_client_telegram(111004), 1, '/stop in the second chat ends its link');
select is((select d.status from public.notification_deliveries d where d.channel = 'email' and d.recipient = '111004'), 'pending', 'and a message on another channel is not touched');
select results_eq($$select d.title, d.status, d.attempt_count from public.notification_deliveries d where d.channel = 'telegram_client' and d.recipient = '111004' order by d.title$$,
  $$values ('Gone already'::text, 'sent'::text, 0), ('Tried once', 'failed', 5), ('Your appointment has been cancelled', 'failed', 5)$$,
  'what was waiting for that chat, new or being tried again, is dropped, and what had already been sent stays as it was');
select is((select count(*)::integer from public.notification_deliveries d where d.channel = 'telegram_client' and d.recipient = '111001' and d.status = 'pending'), 2,
  'and what waits for the client''s other chat is untouched');

-- ---------------------------------------------------------------------------------------------
-- The sender's queue picks them up on their own channel, and the client messages never reach the Admin's channel
-- ---------------------------------------------------------------------------------------------
select ok((select count(*) from public.claim_notification_deliveries(50, array['telegram'])
  where channel = 'telegram_client' or audience = 'client') = 0, 'Asking for the Admin''s Telegram messages never returns a client''s');
select ok((select count(*) from public.claim_notification_deliveries(50, array['telegram_client']) where channel = 'telegram_client' and audience = 'client') = 2,
  'Asking for the client Telegram messages returns them: the moved message and the cancelled one for the chat that is still linked (the dropped ones stay out)');

-- ---------------------------------------------------------------------------------------------
-- Combining two client profiles keeps the Telegram updates. The "same person" step moves everything of the profile that goes to the one that
-- stays, then deletes the emptied profile. Mia (no login) is combined into Rita. Mia has a live chat, a stopped one, one that Rita also had
-- (and had stopped), and one that Rita has live while Mia's is stopped.
-- ---------------------------------------------------------------------------------------------
insert into public.client_telegram_links(client_id, chat_id, stopped_at) values
  ('00000000-0000-4000-8000-00000000f205', 777001, null),
  ('00000000-0000-4000-8000-00000000f205', 777002, now()),
  ('00000000-0000-4000-8000-00000000f205', 111003, null),
  ('00000000-0000-4000-8000-00000000f205', 777003, now()),
  ('00000000-0000-4000-8000-00000000f202', 777003, null);
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f202' and chat_id = 111003 and stopped_at is not null), 1, 'Rita had stopped that chat');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f101');
set local role authenticated;
select lives_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000f202', '00000000-0000-4000-8000-00000000f205', gen_random_uuid())$$, 'The Admin combines Mia into Rita');
reset role;
select is((select count(*)::integer from public.clients where id = '00000000-0000-4000-8000-00000000f205'), 0, 'Mia''s profile is gone');
select results_eq($$select chat_id, stopped_at is null from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f202' and chat_id in (777001, 777002, 777003, 111003) order by chat_id$$,
  $$values (111003::bigint, true), (777001::bigint, true), (777002::bigint, false), (777003::bigint, true)$$,
  'Mia''s chats moved to Rita: a live one is live, a stopped one stays stopped, the one Rita had stopped is on again because Mia had it on, and the one Rita had on stays on although Mia had stopped it');
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f205'), 0, 'Nothing is left under the profile that went');
select is((select count(*)::integer from public.client_telegram_links where chat_id in (777001, 777002, 777003, 111003) and client_id = '00000000-0000-4000-8000-00000000f202'), 4, 'and no chat was added twice');

-- ---------------------------------------------------------------------------------------------
-- When a client goes, so does everything about their Telegram
-- ---------------------------------------------------------------------------------------------
select pg_temp.booking('00000000-0000-4000-8000-00000000f304', '00000000-0000-4000-8000-00000000f203');
delete from public.notification_deliveries where event_id in (select id from public.event_outbox where aggregate_id in ('00000000-0000-4000-8000-00000000f301', '00000000-0000-4000-8000-00000000f302', '00000000-0000-4000-8000-00000000f303'));
delete from public.event_outbox where aggregate_id in ('00000000-0000-4000-8000-00000000f301', '00000000-0000-4000-8000-00000000f302', '00000000-0000-4000-8000-00000000f303', '00000000-0000-4000-8000-00000000f304');
delete from public.bookings where client_id = '00000000-0000-4000-8000-00000000f201';
delete from public.clients where id = '00000000-0000-4000-8000-00000000f201';
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000f201'), 0, 'Deleting a client takes their linked chats with them');
select is((select count(*)::integer from public.client_telegram_tokens where client_id = '00000000-0000-4000-8000-00000000f201'), 0, 'and their codes');

select * from finish();
rollback;
