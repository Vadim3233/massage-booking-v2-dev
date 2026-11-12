begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(33);

-- ---------------------------------------------------------------------------------------------
-- Fixtures. Dates are far ahead and "now" is passed in, so nothing depends on today's date.
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000e901', 'authenticated', 'authenticated', 'review-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000e902', 'authenticated', 'authenticated', 'review-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e901');
delete from public.business_settings where key in ('google_review_link', 'review_message', 'review_auto');

insert into public.clients(id, first_name, email) values
  ('00000000-0000-4000-8000-00000000e1a1', 'Ana', 'ana-review@example.test'),       -- paid, two days ago: asked
  ('00000000-0000-4000-8000-00000000e1b1', 'Ben', 'ben-review@example.test'),       -- paid, yesterday: too soon
  ('00000000-0000-4000-8000-00000000e1c1', 'Cara', 'cara-review@example.test'),     -- not paid yet
  ('00000000-0000-4000-8000-00000000e1d1', 'Dan', 'dan-review@example.test'),      -- fifteen days ago: too long ago
  ('00000000-0000-4000-8000-00000000e1e1', 'Eve', 'eve-review@example.test'),      -- asked by hand already
  ('00000000-0000-4000-8000-00000000e1f1', 'Fay', 'fay-review@example.test'),      -- cancelled
  ('00000000-0000-4000-8000-00000000e1a7', 'Gus', null),                           -- nowhere to send it
  ('00000000-0000-4000-8000-00000000e1a8', 'Hal', null);                           -- Telegram only

create function pg_temp.new_booking(p_id uuid, p_client uuid, p_date date, p_payment text default 'paid', p_status text default 'confirmed') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot, created_at,
    cancelled_at, cancelled_by_actor_type)
  select p_id, 'REV-' || p_id, p_client, a.id, p_date, 600, 60, p_status, 'test', '1 Review Road', a.name, 85, 85,
    (select email from public.clients where id = p_client), now() - interval '30 days',
    case when p_status = 'cancelled' then now() end, case when p_status = 'cancelled' then 'admin' end
  from public.service_areas a where a.slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at) values (p_id, 'bank_transfer', p_payment, 85, case when p_payment = 'paid' then now() end);
end;
$$;
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2a1', '00000000-0000-4000-8000-00000000e1a1', date '2031-05-05');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2b1', '00000000-0000-4000-8000-00000000e1b1', date '2031-05-06');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2c1', '00000000-0000-4000-8000-00000000e1c1', date '2031-05-05', 'awaiting_transfer');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2d1', '00000000-0000-4000-8000-00000000e1d1', date '2031-04-22');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2e1', '00000000-0000-4000-8000-00000000e1e1', date '2031-05-05');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2f1', '00000000-0000-4000-8000-00000000e1f1', date '2031-05-05', 'paid', 'cancelled');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2a7', '00000000-0000-4000-8000-00000000e1a7', date '2031-05-05');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e2a8', '00000000-0000-4000-8000-00000000e1a8', date '2031-05-04');
insert into public.client_telegram_links(client_id, chat_id) values ('00000000-0000-4000-8000-00000000e1a8', 7700123);

create function pg_temp.review_rows(p_client uuid) returns table(channel text, recipient text, title text, body text, link_path text) language sql as $$
  select d.channel, d.recipient, d.title, d.body, d.link_path
    from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
   where e.event_type = 'booking.review_request' and e.payload->>'client_id' = $1::text order by d.channel;
$$;

-- ---------------------------------------------------------------------------------------------
-- Who can do what
-- ---------------------------------------------------------------------------------------------
select ok(has_function_privilege('service_role', 'public.plan_review_requests(timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.plan_review_requests(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.plan_review_requests(timestamptz)', 'EXECUTE'), 'Only the sender can plan the automatic messages');
select ok(not has_function_privilege('anon', 'public.admin_save_review_settings(text,text,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_mark_review_asked(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_clear_review_asked(uuid)', 'EXECUTE'), 'A visitor can change nothing');
select ok((select relrowsecurity from pg_class where oid = 'public.client_review_requests'::regclass)
  and not has_table_privilege('authenticated', 'public.client_review_requests', 'insert,update,delete')
  and not has_table_privilege('anon', 'public.client_review_requests', 'select'), 'Who was asked is changed only through the Admin functions');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e902","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_review_settings('https://g.page/r/x/review', null, true)$$, '42501', 'Admin authorization required', 'A client cannot change the settings');
select throws_ok($$select public.admin_mark_review_asked('00000000-0000-4000-8000-00000000e2e1', 'whatsapp')$$, '42501', 'Admin authorization required', 'A client cannot mark anyone as asked');

-- ---------------------------------------------------------------------------------------------
-- The settings
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e901","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_review_settings('http://g.page/r/x/review', null, false)$$, '22023', 'The review link must start with https:// and have no spaces', 'Only an https link is taken');
select throws_ok($$select public.admin_save_review_settings('https://g.page/r x', null, false)$$, '22023', 'The review link must start with https:// and have no spaces', 'A link with a space is refused');
select throws_ok($$select public.admin_save_review_settings(null, null, true)$$, '22023', 'Add your review link before asking automatically', 'No asking automatically without a link');
select throws_ok($$select public.admin_save_review_settings('https://g.page/r/x/review', 'Hi {name}, please review me', false)$$, '22023', 'The message needs the {link} blank, so clients can find your review page', 'A wording without the link is refused');
select throws_ok($$select public.admin_save_review_settings('https://g.page/r/x/review', 'Hi {date} {link}', false)$$, '22023', 'Only the blanks listed can be used, each in curly brackets', 'Only {name} and {link} can be used');
select lives_ok($$select public.admin_save_review_settings('  https://g.page/r/CU-Ccr2ldxfKEBM/review ', public.standard_review_message(), false)$$, 'The Admin saves the link, the standard wording and the switch off');
select is((select count(*)::int from public.business_settings where key = 'review_message'), 0, 'The standard wording is kept as nothing, so a later change to it reaches clients');
reset role;
select is((select value #>> '{}' from public.business_settings where key = 'google_review_link'), 'https://g.page/r/CU-Ccr2ldxfKEBM/review', 'The link is kept, tidied');

-- ---------------------------------------------------------------------------------------------
-- Asking by hand
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e901","role":"authenticated"}', true);
select throws_ok($$select public.admin_mark_review_asked('00000000-0000-4000-8000-00000000e2e1', 'automatic')$$, '22023', 'Unknown way of asking', 'Only WhatsApp, Copy or Mark as asked are taken from the app');
select isnt(public.admin_mark_review_asked('00000000-0000-4000-8000-00000000e2e1', 'whatsapp'), null, 'The Admin marks Eve as asked by WhatsApp');
select is((select channel from public.client_review_requests where client_id = '00000000-0000-4000-8000-00000000e1e1'), 'whatsapp', 'The Admin reads back how she was asked');
select lives_ok($$select public.admin_mark_review_asked('00000000-0000-4000-8000-00000000e2e1', 'copy')$$, 'Asking again just updates it');
select is((select count(*)::int from public.client_review_requests where client_id = '00000000-0000-4000-8000-00000000e1e1'), 1, 'There is still one row for her');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e902","role":"authenticated"}', true);
select is((select count(*)::int from public.client_review_requests), 0, 'A client cannot see who was asked');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e901","role":"authenticated"}', true);
select lives_ok($$select public.admin_clear_review_asked('00000000-0000-4000-8000-00000000e1b1')$$, 'Not asked after all, for someone never asked, does nothing');
reset role;

-- ---------------------------------------------------------------------------------------------
-- The automatic message
-- ---------------------------------------------------------------------------------------------
-- 2031-05-07 is in British Summer Time (UTC+1).
select is(public.plan_review_requests('2031-05-07 12:00:00+01'), 0, 'Nothing is sent while the switch is off');
update public.business_settings set value = 'true'::jsonb where key = 'review_auto';
select is(public.plan_review_requests('2031-05-07 10:59:00+01'), 0, 'Nothing before 11:00 London time');
select is(public.plan_review_requests('2031-05-07 11:00:00+01'), 2, 'At 11:00, the two clients due are asked');
select is((select array_agg(client_id order by client_id) from public.client_review_requests where channel = 'automatic'),
  array['00000000-0000-4000-8000-00000000e1a1', '00000000-0000-4000-8000-00000000e1a8']::uuid[], 'Ana (paid, two days ago) and the Telegram-only client (three days ago)');
select results_eq($$select channel, recipient, title, body, link_path from pg_temp.review_rows('00000000-0000-4000-8000-00000000e1a1')$$,
  $$values ('email'::text, 'ana-review@example.test'::text, 'How was your massage?'::text,
    E'Hi Ana! I hope you enjoyed our last session and you''re still feeling the benefit of it. If you have a minute, a short Google review would mean a lot to me. It really helps other people find me:\nhttps://g.page/r/CU-Ccr2ldxfKEBM/review\n\nWarm wishes,\nVadim'::text, null::text)$$,
  'Ana gets one email in the standard wording, with her first name and the link');
select results_eq($$select channel, recipient, left(body, 12) from pg_temp.review_rows('00000000-0000-4000-8000-00000000e1a8')$$,
  $$values ('telegram_client'::text, '7700123'::text, 'Hi Hal! I ho'::text)$$, 'A client on Telegram only gets it there');
select is((select count(*)::int from public.client_review_requests where client_id in ('00000000-0000-4000-8000-00000000e1b1', '00000000-0000-4000-8000-00000000e1c1',
  '00000000-0000-4000-8000-00000000e1d1', '00000000-0000-4000-8000-00000000e1f1', '00000000-0000-4000-8000-00000000e1a7')), 0,
  'Not asked: yesterday''s session, an unpaid one, one from over two weeks ago, a cancelled one, and a client with nowhere to send it');
select is((select count(*)::int from public.event_outbox where event_type = 'booking.review_request' and payload->>'client_id' = '00000000-0000-4000-8000-00000000e1e1'), 0,
  'Eve, asked by hand, is never sent it');
select is(public.plan_review_requests('2031-05-07 15:00:00+01'), 0, 'Running again the same day asks nobody twice');
select is(public.plan_review_requests('2031-05-08 11:00:00+01'), 1, 'The next day Ben''s session is two days old, so he is asked');
select is(public.plan_review_requests('2031-05-09 11:00:00+01'), 0, 'And never again');

-- Their own wording is used.
update public.business_settings set value = 'true'::jsonb where key = 'review_auto';
insert into public.business_settings(key, value) values ('review_message', to_jsonb('Thanks {name}! {link}'::text));
update public.booking_payments set status = 'paid', paid_at = now() where booking_id = '00000000-0000-4000-8000-00000000e2c1';
select is(public.plan_review_requests('2031-05-09 11:00:00+01'), 1, 'Cara is asked once she has paid');
select is((select body from pg_temp.review_rows('00000000-0000-4000-8000-00000000e1c1')), 'Thanks Cara! https://g.page/r/CU-Ccr2ldxfKEBM/review', 'In the Admin''s own wording');

select * from finish();
rollback;
