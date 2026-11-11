begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- The family alerts are worked out when a change is saved (at commit). A test never commits, so they are made to run at the end of each
-- statement instead; one test below puts them back to "at commit" to check that a change made in steps sends one message.
set constraints public.bookings_family_alert immediate;

insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000fa01', 'authenticated', 'authenticated', 'fam.admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000fa02', 'authenticated', 'authenticated', 'fam.client@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false);
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000fa01');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000fb01', '00000000-0000-0000-0000-00000000fa02', 'Carla', 'Client', 'fam.client@example.test', '07911 223801');

create function pg_temp.as_user(p_user text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user, true);
end;
$$;
create function pg_temp.as_nobody() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
create function pg_temp.booking(p_id uuid, p_date date, p_start integer, p_minutes integer, p_status text, p_travel integer default 30) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, travel_buffer_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'FAM-' || p_id, '00000000-0000-4000-8000-00000000fb01', a.id, p_date, p_start, p_minutes, p_travel, p_status, 'test', '1 Test Road', 'London', 'SW1A 1AA',
    a.name, 90, 90, 'fam.client@example.test'
  from public.service_areas a where a.slug = 'chelsea';
end;
$$;
create function pg_temp.messages() returns integer language sql as $$ select count(*)::integer from public.family_telegram_messages; $$;
create function pg_temp.last_body() returns text language sql as $$ select body from public.family_telegram_messages order by created_at desc, id limit 1; $$;
-- The message without its love line (the last two lines), which is picked at random.
create function pg_temp.last_news() returns text language sql as $$ select split_part(pg_temp.last_body(), E'\n\n💛 ', 1); $$;
create function pg_temp.day(p_date date) returns text language sql as $$
  select (array['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'])[extract(dow from p_date)::integer + 1] || ' ' || extract(day from p_date)::integer || ' '
    || (array['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'])[extract(month from p_date)::integer];
$$;

-- ---------------------------------------------------------------------------------------------
-- The doors
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_create_family_telegram_link()', 'EXECUTE'), 'A visitor cannot make a family link');
select ok(not has_function_privilege('authenticated', 'public.link_family_telegram(text, bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.link_family_telegram(text, bigint)', 'EXECUTE'), 'Only the webhook can link a chat');
select ok(not has_function_privilege('authenticated', 'public.claim_family_telegram_messages(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_family_telegram_messages(integer)', 'EXECUTE'), 'and only the sender can read the messages');
select ok(not has_table_privilege('authenticated', 'public.family_telegram_messages', 'SELECT')
  and not has_table_privilege('anon', 'public.family_telegram_chats', 'SELECT')
  and not has_table_privilege('authenticated', 'public.family_telegram_tokens', 'SELECT'), 'Nobody signed in can read the family tables directly');

select pg_temp.as_user('00000000-0000-0000-0000-00000000fa02');
select throws_ok($$ select public.admin_create_family_telegram_link() $$, '42501', 'Admin authorization required', 'A client cannot make a family link');
select throws_ok($$ select public.admin_family_telegram_status() $$, '42501', 'Admin authorization required', 'or see who is linked');
select pg_temp.as_nobody();
select throws_ok($$ select public.admin_create_family_telegram_link() $$, '42501', 'Admin authorization required', 'nor can someone not signed in');

-- ---------------------------------------------------------------------------------------------
-- Linking a chat
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000fa01');
create temp table codes(code text) on commit drop;
grant all on codes to public;
insert into codes select public.admin_create_family_telegram_link();
select ok((select code ~ '^family_[0-9a-f]{32}$' from codes), 'The Admin gets a one-time code that starts with family_');
select is((select count(*)::integer from public.family_telegram_tokens where token_hash = (select code from codes)), 0, 'and the code itself is not kept, only its hash');
select is(public.admin_family_telegram_status(), '{"chats": []}'::jsonb, 'No chat is linked yet');

select pg_temp.as_nobody();
select is(public.link_family_telegram('family_nonsense_nonsense', 501), '{"status": "invalid"}'::jsonb, 'A code that was never made does not link');
select is(public.link_family_telegram((select code from codes), 501), '{"status": "linked"}'::jsonb, 'Pressing Start with the code links the chat');
select is(public.link_family_telegram((select code from codes), 501), '{"status": "linked"}'::jsonb, 'Telegram asking again still says linked');
select is(public.link_family_telegram((select code from codes), 502), '{"status": "used"}'::jsonb, 'but the code cannot link a second chat');

select pg_temp.as_user('00000000-0000-0000-0000-00000000fa01');
insert into codes select public.admin_create_family_telegram_link();
update public.family_telegram_tokens set expires_at = now() - interval '1 minute' where used_at is null;
select is(public.link_family_telegram((select code from codes order by code <> (select code from codes limit 1) desc limit 1), 503), '{"status": "expired"}'::jsonb,
  'A code older than 24 hours has expired');
select is(jsonb_array_length(public.admin_family_telegram_status()->'chats'), 1, 'The Admin sees one linked chat');

-- ---------------------------------------------------------------------------------------------
-- What she is told
-- ---------------------------------------------------------------------------------------------
-- A request still waiting for payment says nothing.
select pg_temp.booking('00000000-0000-4000-8000-00000000fc01', current_date + 3, 840, 90, 'awaiting_transfer');
select is(pg_temp.messages(), 0, 'A booking still waiting for payment is not sent');

-- Once it is confirmed: new booking, with the day, the times and when he is home (15:30 + 30 min travel).
update public.bookings set booking_status = 'confirmed' where id = '00000000-0000-4000-8000-00000000fc01';
select is(pg_temp.messages(), 1, 'Confirming it sends one message');
select is(pg_temp.last_news(), E'📅 Nueva reserva\n🕑 ' || pg_temp.day(current_date + 3) || E', de 14:00 a 15:30\n🏠 Ese día estaré en casa sobre las 16:00.',
  'It gives the day, the times and when he is home, nothing about the client');
select ok(pg_temp.last_news() !~* 'Carla|Client|Test Road|SW1A|90|chelsea', 'No name, address, postcode, area or price');
select ok(exists (select 1 from public.family_love_lines where line = split_part(pg_temp.last_body(), E'\n\n💛 ', 2)),
  'and ends with one of his love lines');
select is((select chat_id from public.family_telegram_messages limit 1), 501::bigint, 'It goes to the linked chat');

-- A second booking later that day moves the home time.
select pg_temp.booking('00000000-0000-4000-8000-00000000fc02', current_date + 3, 1020, 60, 'confirmed', 45);
select is(pg_temp.last_news(), E'📅 Nueva reserva\n🕑 ' || pg_temp.day(current_date + 3) || E', de 17:00 a 18:00\n🏠 Ese día estaré en casa sobre las 18:45.',
  'A booking made already confirmed is sent too, with the later home time');

-- Saving it again unchanged, or changing only its travel, says nothing.
update public.bookings set booking_status = 'confirmed', travel_buffer_minutes = 50 where id = '00000000-0000-4000-8000-00000000fc02';
select is(pg_temp.messages(), 2, 'A change that does not touch the times says nothing');

-- Moved.
update public.bookings set date = current_date + 4, start_minutes = 600 where id = '00000000-0000-4000-8000-00000000fc02';
select is(pg_temp.last_news(), E'🔁 Reserva cambiada de hora\n⏪ Antes: ' || pg_temp.day(current_date + 3) || E', de 17:00 a 18:00\n⏩ Ahora: '
  || pg_temp.day(current_date + 4) || E', de 10:00 a 11:00\n🏠 Ese día estaré en casa sobre las 11:50.', 'Moving it says where it was and where it is now');

-- Only the length changed.
update public.bookings set treatment_duration_minutes = 120 where id = '00000000-0000-4000-8000-00000000fc02';
select is(split_part(pg_temp.last_news(), E'\n', 1), '🔁 Reserva cambiada', 'A longer session on the same time is "changed"');

-- Cancelled: the home time for that day goes back.
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000fc02';
select is(pg_temp.last_news(), E'❌ Reserva cancelada\n🕑 ' || pg_temp.day(current_date + 4) || E', de 10:00 a 12:00\n🛋️ No hay más reservas ese día.',
  'Cancelling it says so, and that there is nothing else that day');
select is(pg_temp.messages(), 5, 'One message for each change');

-- A booking in the past says nothing, whatever happens to it.
select pg_temp.booking('00000000-0000-4000-8000-00000000fc03', current_date - 2, 600, 60, 'confirmed');
update public.bookings set booking_status = 'completed' where id = '00000000-0000-4000-8000-00000000fc03';
select is(pg_temp.messages(), 5, 'An old booking entered afterwards, or marked done, says nothing');

-- A change made in steps, saved together, is one message with the final times.
set constraints public.bookings_family_alert deferred;
update public.bookings set start_minutes = 660 where id = '00000000-0000-4000-8000-00000000fc01';
update public.bookings set treatment_duration_minutes = 60 where id = '00000000-0000-4000-8000-00000000fc01';
set constraints public.bookings_family_alert immediate;
select is(pg_temp.messages(), 6, 'Two steps of one change send one message');
select is(split_part(pg_temp.last_news(), E'\n', 3), '⏩ Ahora: ' || pg_temp.day(current_date + 3) || ', de 11:00 a 12:00', 'with the final times');

-- Removed outright.
delete from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000fc01';
delete from public.bookings where id = '00000000-0000-4000-8000-00000000fc01';
select is(split_part(pg_temp.last_news(), E'\n', 1), '❌ Reserva cancelada', 'A booking removed outright is sent as cancelled');

-- ---------------------------------------------------------------------------------------------
-- Sending, stopping
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::integer from public.claim_family_telegram_messages(3)), 3, 'The sender takes what is due, a few at a time');
select public.complete_family_telegram_message(id, true) from public.family_telegram_messages where status = 'sending';
select is((select count(*)::integer from public.family_telegram_messages where status = 'sent'), 3, 'and marks them sent');

select is(public.stop_family_telegram(501), 1, '/stop ends the chat');
select is((select count(*)::integer from public.family_telegram_messages where status = 'pending'), 0, 'and drops what was still waiting for it');
select pg_temp.booking('00000000-0000-4000-8000-00000000fc04', current_date + 5, 600, 60, 'confirmed');
select is((select count(*)::integer from public.family_telegram_messages where status = 'pending'), 0, 'Nothing more is written for a stopped chat');
select is(public.stop_family_telegram(501), 0, '/stop again finds nothing to stop');

-- Linking again with a new code turns it back on; the Admin can switch it off.
select pg_temp.as_user('00000000-0000-0000-0000-00000000fa01');
delete from codes;
insert into codes select public.admin_create_family_telegram_link();
select is(public.link_family_telegram((select code from codes), 501), '{"status": "linked"}'::jsonb, 'A new link turns a stopped chat back on');
select public.admin_stop_family_telegram(((public.admin_family_telegram_status()->'chats')->0->>'id')::uuid);
select is(public.admin_family_telegram_status(), '{"chats": []}'::jsonb, 'The Admin can switch a chat off');

-- The love lines: 100 of them, in a mixed order, none back until at least 50 others have been used.
select is((select count(*)::integer from public.family_love_lines), 100, 'There are 100 love lines');
update public.family_love_lines set last_used_at = null;
create temp table picked(n integer generated always as identity, line text) on commit drop;
insert into picked(line) select public.family_alert_love_line() from generate_series(1, 150);
select is((select count(distinct line)::integer from picked where n <= 100), 100, 'The first 100 picks use every line once');
select ok(not exists (select 1 from picked a join picked b on a.line = b.line and b.n > a.n and b.n - a.n < 51), 'and no line comes back within 50 picks');
select ok((select string_agg(line, '|' order by n) from picked where n <= 10) <> (select string_agg(line, '|' order by id) from public.family_love_lines where id <= 10),
  'They come in a mixed order, not the list order');

-- A failure in the alerts never stops a booking being saved.
alter table public.family_telegram_messages add constraint fam_test_break check (false) not valid;
select lives_ok($$ update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000fc04' $$,
  'A problem writing the alert never stops the booking change');

select * from finish();
rollback;
