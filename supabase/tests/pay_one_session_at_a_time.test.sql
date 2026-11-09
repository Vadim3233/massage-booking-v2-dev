begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(39);

-- Three clients: Anna has a confirmed session and books a later one; Ben's earlier session is still waiting for its transfer to be checked;
-- Cara has no earlier session at all.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000e501', 'authenticated', 'authenticated', 'anna-later@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e502', 'authenticated', 'authenticated', 'ben-later@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e503', 'authenticated', 'authenticated', 'cara-later@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e504', 'authenticated', 'authenticated', 'dan-later@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e505', 'authenticated', 'authenticated', 'later-admin@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e505');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000e601', '00000000-0000-0000-0000-00000000e501', 'Anna', 'Later', 'anna-later@example.test'),
  ('00000000-0000-4000-8000-00000000e602', '00000000-0000-0000-0000-00000000e502', 'Ben', 'Later', 'ben-later@example.test'),
  ('00000000-0000-4000-8000-00000000e603', '00000000-0000-0000-0000-00000000e503', 'Cara', 'Later', 'cara-later@example.test'),
  ('00000000-0000-4000-8000-00000000e604', '00000000-0000-0000-0000-00000000e504', 'Dan', 'Later', 'dan-later@example.test');
insert into public.client_telegram_links(client_id, chat_id) values ('00000000-0000-4000-8000-00000000e601', 4242);

create function pg_temp.london_day(p_offset integer) returns date language sql as $$
  select ((now() at time zone 'Europe/London')::date + p_offset);
$$;
create function pg_temp.new_booking(p_id uuid, p_client uuid, p_status text, p_day integer, p_payment_status text)
returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'LATER-' || right(p_id::text, 4), p_client, id, pg_temp.london_day(p_day), 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 90, 90, (select email from public.clients where id = p_client)
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, payment_reference, paid_at, transfer_declared_at)
    values (p_id, 'bank_transfer', p_payment_status, 90, 'LATER-' || right(p_id::text, 4), case when p_payment_status = 'paid' then now() end,
      case when p_payment_status = 'awaiting_verification' then now() end);
end;
$$;
-- Anna: e701 confirmed and paid in 3 days; e702 just reserved, in 10 days.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e701', '00000000-0000-4000-8000-00000000e601', 'confirmed', 3, 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e702', '00000000-0000-4000-8000-00000000e601', 'awaiting_transfer', 10, 'awaiting_transfer');
-- Ben: e703 in 4 days, transfer said to be sent; e704 just reserved, in 11 days.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e703', '00000000-0000-4000-8000-00000000e602', 'awaiting_payment_verification', 4, 'awaiting_verification');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e704', '00000000-0000-4000-8000-00000000e602', 'awaiting_transfer', 11, 'awaiting_transfer');
-- Cara: e705 just reserved, nothing before it.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e705', '00000000-0000-4000-8000-00000000e603', 'awaiting_transfer', 5, 'awaiting_transfer');

-- Dan: e706 confirmed in 6 days; e707 just reserved, in 12 days. He books with the automatic confirming switched off.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e706', '00000000-0000-4000-8000-00000000e604', 'confirmed', 6, 'paid');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000e707', '00000000-0000-4000-8000-00000000e604', 'awaiting_transfer', 12, 'awaiting_transfer');

-- Command surface.
select has_function('public', 'book_my_session_pay_later', array['uuid']);
select ok(not has_function_privilege('anon', 'public.book_my_session_pay_later(uuid)', 'EXECUTE'), 'Anonymous callers cannot use it');
select ok(not has_function_privilege('authenticated', 'public.plan_next_session_payments(timestamptz)', 'EXECUTE'), 'Only the sender plans the payment emails');
select ok(not has_function_privilege('authenticated', 'public.confirm_pay_after_session(uuid)', 'EXECUTE'), 'Clients cannot confirm a session directly');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'book_my_session_pay_later'), 'The command is a definer with an empty fixed search path');

set local role authenticated;
-- Anna.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e501","role":"authenticated"}', true);
select is(public.get_my_booking('00000000-0000-4000-8000-00000000e702')->'earlier_session'->>'id', '00000000-0000-4000-8000-00000000e701',
  'The payment step is told about the earlier session');
select is(public.get_my_booking('00000000-0000-4000-8000-00000000e701')->'earlier_session', 'null'::jsonb, 'A first session has none');
select throws_ok($$select public.book_my_session_pay_later('00000000-0000-4000-8000-00000000e704')$$, '42501', 'Booking is not available to this client',
  'Nobody can do this for another client''s booking');
create temp table answer as select public.book_my_session_pay_later('00000000-0000-4000-8000-00000000e702') as a;
select is((select a->>'booking_status' from answer), 'confirmed', 'With the earlier session confirmed, the later one is confirmed straight away');
select is((select a->'pay_after_session'->>'id' from answer), '00000000-0000-4000-8000-00000000e701', 'It is linked to the earlier session');
select is((select a->'booking_payments'->>'status' from answer), 'awaiting_transfer', 'Its payment stays open');
select is((select a->'earlier_session' from answer), 'null'::jsonb, 'The choice is no longer offered');
select is(public.book_my_session_pay_later('00000000-0000-4000-8000-00000000e702')->>'booking_status', 'confirmed', 'Pressing it again changes nothing');
select is((select (r->>'pay_after_date') from jsonb_array_elements(public.list_my_bookings()) r where r->>'id' = '00000000-0000-4000-8000-00000000e702'),
  pg_temp.london_day(3)::text, 'Your bookings shows which session it is paid after');
-- Cara.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e503","role":"authenticated"}', true);
select throws_ok($$select public.book_my_session_pay_later('00000000-0000-4000-8000-00000000e705')$$, '22023',
  'You have no earlier appointment to pay for first, so this one is paid now.', 'A first session is paid in the usual way');
-- Ben.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e502","role":"authenticated"}', true);
select is(public.book_my_session_pay_later('00000000-0000-4000-8000-00000000e704')->>'booking_status', 'awaiting_transfer',
  'With the earlier session still waiting, the later one waits for it');
reset role;

-- What was sent.
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000e702' and event_type = 'booking.confirmed_pay_after'), 1,
  'One confirmation, however many times it was pressed');
select ok((select body from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e702' and e.event_type = 'booking.confirmed_pay_after' and d.channel = 'email' and d.audience = 'client')
  like '%There is nothing to pay yet. After your appointment on %, I''ll send you the details to pay £90.00 for this one.%', 'Anna is told there is nothing to pay yet');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e702' and e.event_type = 'booking.confirmed_pay_after' and d.channel = 'telegram_client'), 1,
  'and on Telegram too');
select ok((select title from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e704' and e.event_type = 'booking.pay_after_requested' and d.audience = 'admin') = 'Ben Later booked another session',
  'Vadim is told about Ben''s later session');

-- Vadim confirms Ben's earlier session: the later one follows.
update public.bookings set booking_status = 'confirmed' where id = '00000000-0000-4000-8000-00000000e703';
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000e704'), 'confirmed',
  'Confirming the earlier session confirms the later one');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000e704' and event_type = 'booking.confirmed_pay_after'), 1,
  'and Ben is told');

-- The payment details, once the earlier session is over.
select is(public.plan_next_session_payments(now()), 0, 'Nothing is sent before the earlier session');
select is(public.plan_next_session_payments((pg_temp.london_day(3) + time '11:01') at time zone 'Europe/London'), 1,
  'After Anna''s earlier session, her next one is sent');
select is(public.plan_next_session_payments((pg_temp.london_day(3) + time '11:01') at time zone 'Europe/London'), 0, 'Only once');
select ok((select body from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e702' and e.event_type = 'booking.next_payment_due' and d.channel = 'email')
  like 'Hi Anna,%Thank you for your appointment. Your next appointment is on %, and you can pay for it now: £90.00 by bank transfer, using the reference LATER-e702.%',
  'The email names the session, the amount and the reference');
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000e703';
select is(public.plan_next_session_payments(now()), 1, 'An earlier session cancelled: the next one is to pay now');
select ok((select body from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e704' and e.event_type = 'booking.next_payment_due' and d.channel = 'email')
  not like '%Thank you%', 'and nobody is thanked for a session that did not happen');
select is((select count(*)::integer from public.event_outbox where event_type = 'booking.next_payment_due'), 2, 'Two payment emails in all');

select is((select count(*)::integer from public.bookings where pay_after_booking_id is not null), 2, 'Only the two later sessions are linked');

-- The switch: on to start with, only the Admin can see or change it.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e504","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_auto_confirm_later_sessions(false)$$, '42501', 'Admin authorization required', 'A client cannot change the switch');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e505","role":"authenticated"}', true);
select is(public.admin_auto_confirm_later_sessions(), true, 'Later sessions are confirmed automatically to start with');
select public.admin_save_auto_confirm_later_sessions(false);
select is(public.admin_auto_confirm_later_sessions(), false, 'The Admin can switch it off');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e504","role":"authenticated"}', true);
select is(public.get_my_booking('00000000-0000-4000-8000-00000000e707')->'earlier_session'->>'auto_confirm', 'false', 'The payment step knows Vadim will confirm it');
select is(public.book_my_session_pay_later('00000000-0000-4000-8000-00000000e707')->>'booking_status', 'awaiting_transfer',
  'Switched off, a later session waits for Vadim even with the earlier one confirmed');
reset role;
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e707' and e.event_type = 'booking.pay_after_requested' and d.audience = 'admin'), 3,
  'and Vadim hears about it in the app, on Telegram and by email');
-- Vadim confirms it with "Confirm, pay later": Dan is told there is nothing to pay yet, not asked for the money now.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e505","role":"authenticated"}', true);
select public.admin_confirm_pay_later('00000000-0000-4000-8000-00000000e707', gen_random_uuid(),
  (select updated_at from public.bookings where id = '00000000-0000-4000-8000-00000000e707'),
  (select updated_at from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000e707'));
reset role;
select is((select booking_status from public.bookings where id = '00000000-0000-4000-8000-00000000e707'), 'confirmed', 'Vadim''s confirmation stands');
select ok((select body from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e707' and e.event_type = 'booking.confirmed_payment_due' and d.channel = 'email')
  ~ E'There is nothing to pay yet\\. After your appointment on .*, I''ll send you the details to pay £90\\.00 for this one\\.\n\nSee or change your booking: [{]link[}]',
  'Dan''s email says there is nothing to pay yet');
select ok((select body from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e707' and e.event_type = 'booking.confirmed_payment_due' and d.channel = 'email')
  not like '%still due%', 'and does not ask for the money now');

select * from finish();
rollback;
