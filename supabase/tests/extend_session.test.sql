begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- Extra time (20261219100000_extend_session.sql): the rules Vadim agreed on 15 Nov 2026, with his £90 an hour.
insert into auth.users(id, aud, role, email) values ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','admin@x.test'),('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','ann@x.test'),('00000000-0000-0000-0000-0000000000a8','authenticated','authenticated','bob@x.test');
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-0000000000a1');
insert into public.clients(id, first_name, last_name, email, auth_user_id) values ('00000000-0000-4000-8000-0000000000c1','Ann','Lee','ann@x.test','00000000-0000-0000-0000-0000000000a9'),
  ('00000000-0000-4000-8000-0000000000c2','Bob','Ray','bob@x.test','00000000-0000-0000-0000-0000000000a8');
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values ('00000000-0000-4000-8000-0000000000a2','ar','Area',true,0,0,99);
insert into public.services(id, slug, name) values ('00000000-0000-4000-8000-0000000000e1','m','Massage'),('00000000-0000-4000-8000-0000000000e2','s','Sports massage');
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp) values
 ('00000000-0000-4000-8000-0000000000e1',60,90),('00000000-0000-4000-8000-0000000000e1',90,130),('00000000-0000-4000-8000-0000000000e2',90,120);
delete from public.business_settings where key in ('extra_time_rate', 'bank_details');
insert into public.business_settings(key, value) values ('bank_details', '{"account_name":"V Test","sort_code":"00-11-22","account_number":"12345678"}');
create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p $$;
create function pg_temp.as_admin() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false) $$;
create function pg_temp.as_ann() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}', false) $$;
create function pg_temp.as_bob() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a8","role":"authenticated"}', false) $$;
-- p_people x 60 min massage at £90 each, Ann's, starting at p_start on day p_day.
create function pg_temp.mk(p_id uuid, p_day integer, p_start integer, p_pay text, p_people integer default 1, p_method text default 'bank_transfer', p_status text default 'confirmed') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, total_gbp, booking_email_snapshot, created_at, cancelled_at, cancelled_by_actor_type)
  values (p_id, 'R-' || right(p_id::text, 4), '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a2', pg_temp.day(p_day), p_start, 60*p_people, p_status, 'test',
    '1 St', 'London', 'SW3 1AA', 'Area', 90*p_people, 90*p_people, 'ann@x.test', now() - interval '3 days', case when p_status = 'cancelled' then now() end, case when p_status = 'cancelled' then 'admin' end);
  insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp, recipient_name)
  select p_id, g, '00000000-0000-4000-8000-0000000000e1', 60, 'Massage', 90, 'P' || g from generate_series(1, p_people) g;
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at, payment_reference) values (p_id, p_method, p_pay, 90*p_people, case when p_pay='paid' then now() end, 'R-' || right(p_id::text, 4));
end $$;
create function pg_temp.bv(p uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id=p $$;
create function pg_temp.s1(p uuid) returns uuid language sql as $$ select id from public.booking_sessions where booking_id=p order by position limit 1 $$;
create function pg_temp.ext(p uuid, p_minutes integer, p_price numeric, p_pay text, p_notify boolean default false) returns uuid language sql as $$
  select public.admin_extend_booking(p, gen_random_uuid(), pg_temp.bv(p), pg_temp.s1(p), p_minutes, p_price, p_pay, p_notify) $$;
create function pg_temp.b(p uuid) returns public.bookings language sql as $$ select * from public.bookings where id=p $$;
create function pg_temp.pay(p uuid) returns public.booking_payments language sql as $$ select * from public.booking_payments where booking_id=p $$;

-- Yesterday 18:00, today a long while ago, and tomorrow.
select pg_temp.mk('00000000-0000-4000-8000-000000000b01', -1, 1080, 'paid');
select pg_temp.mk('00000000-0000-4000-8000-000000000b02', -1, 600, 'awaiting_transfer');
select pg_temp.mk('00000000-0000-4000-8000-000000000b03', -1, 720, 'approved', 1, 'cash');
select pg_temp.mk('00000000-0000-4000-8000-000000000b04', 1, 600, 'paid');
select pg_temp.mk('00000000-0000-4000-8000-000000000b05', -9, 600, 'paid');
select pg_temp.mk('00000000-0000-4000-8000-000000000b06', -2, 600, 'paid', 2);
select pg_temp.mk('00000000-0000-4000-8000-000000000b07', -2, 900, 'awaiting_verification', 1, 'bank_transfer', 'confirmed');
select pg_temp.mk('00000000-0000-4000-8000-000000000b08', -3, 600, 'paid', 1, 'bank_transfer', 'cancelled');
select pg_temp.mk('00000000-0000-4000-8000-000000000b09', -1, 1380, 'paid');
-- The next booking after b01, at 19:30 yesterday with 30 minutes' travel.
select pg_temp.mk('00000000-0000-4000-8000-000000000b10', -1, 1170, 'paid');
update public.bookings set travel_buffer_minutes = 30, client_id = '00000000-0000-4000-8000-0000000000c2' where id = '00000000-0000-4000-8000-000000000b10';

-- Only Vadim.
select pg_temp.as_ann();
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b01', 30, 45, 'cash') $$, '42501', null, 'a client cannot add extra time');
select throws_ok($$ select public.admin_extend_preview('00000000-0000-4000-8000-000000000b01') $$, '42501', null, 'a client cannot see the Extend screen');
select throws_ok($$ select public.admin_save_extra_time_rate(10) $$, '42501', null, 'a client cannot set the rate');
select ok(not has_function_privilege('anon', 'public.admin_extend_booking(uuid, uuid, timestamptz, uuid, integer, numeric, text, boolean)', 'execute'), 'anonymous callers cannot reach Extend');
select ok(not has_table_privilege('authenticated', 'public.booking_extensions', 'insert'), 'nobody writes extra time directly');
select pg_temp.as_admin();

-- The suggested price: the treatment's 1-hour price with no rate saved, then the rate he saves.
select is((public.admin_extend_preview('00000000-0000-4000-8000-000000000b01')->'sessions'->0->>'hour_price')::numeric, 90.00, 'no rate saved: the treatment''s 1-hour price');
select is(public.admin_extend_preview('00000000-0000-4000-8000-000000000b01')->>'refusal', null, 'a session that started can be extended');
select is(public.admin_extend_preview('00000000-0000-4000-8000-000000000b01')->'pay_by', '["cash", "transfer", "free"]'::jsonb, 'paid: cash, transfer or free');
select is((public.admin_extend_preview('00000000-0000-4000-8000-000000000b01')->'next'->>'start_minutes')::integer, 1170, 'the next booking that day is named');
select is(public.admin_extend_preview('00000000-0000-4000-8000-000000000b02')->'pay_by', '["bill", "free"]'::jsonb, 'not paid yet: on the bill, or free');
select is(public.admin_extend_preview('00000000-0000-4000-8000-000000000b07')->>'refusal', 'Check the client''s payment first (Mark received in To check), then add the extra time.', 'a transfer to check is checked first');
select lives_ok($$ select public.admin_save_extra_time_rate(100) $$, 'he saves £100 an hour');
select is((public.admin_extend_preview('00000000-0000-4000-8000-000000000b01')->'sessions'->0->>'hour_price')::numeric, 100.00, 'the saved rate is used');
select lives_ok($$ select public.admin_save_extra_time_rate(null) $$, 'he clears it');
select is(public.extra_time_rate(), null, 'cleared');
select throws_ok($$ select public.admin_save_extra_time_rate(0) $$, '22023', null, 'a rate of £0 is refused');

-- When.
select is(public.admin_extend_preview('00000000-0000-4000-8000-000000000b04')->>'refusal', 'The session has not started yet. To make it longer before then, use Edit booking.', 'not before it starts');
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b04', 30, 45, 'cash') $$, '22023', 'The session has not started yet. To make it longer before then, use Edit booking.', 'not before it starts (saving)');
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b05', 30, 45, 'cash') $$, '22023', 'Extra time can be added up to 7 days after the session.', 'not more than 7 days after');
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b08', 30, 45, 'cash') $$, '22023', 'Extra time can only be added to a session that went ahead.', 'not on a cancelled booking');
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b09', 45, 45, 'cash') $$, '22023', 'That would run past midnight. Choose less extra time.', 'never past midnight');
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b01', 20, 45, 'cash') $$, '22023', 'Choose 15 minutes to 2 hours of extra time.', 'only 15-minute steps');
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b02', 30, 45, 'cash') $$, 'PT409', null, 'cash is not offered on an unpaid booking');
select throws_ok($$ select public.admin_extend_booking('00000000-0000-4000-8000-000000000b01', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b01'), pg_temp.s1('00000000-0000-4000-8000-000000000b02'), 30, 45, 'cash', false) $$,
  '22023', 'Choose who stayed longer.', 'the person must be on this booking');
select throws_ok($$ select public.admin_extend_booking('00000000-0000-4000-8000-000000000b01', gen_random_uuid(), now() - interval '1 day', pg_temp.s1('00000000-0000-4000-8000-000000000b01'), 30, 45, 'cash', false) $$,
  'PT409', null, 'a booking changed meanwhile is refused');

-- Paid, extra paid in cash there and then: nothing owed.
select lives_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b01', 30, 45, 'cash') $$, 'paid booking, +30 min cash £45');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b01')).treatment_duration_minutes, 90, 'the session is now 90 minutes');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b01')).total_gbp, 135.00, 'total £135');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b01')).balance_due_gbp, 0.00, 'nothing owed');
select is((pg_temp.pay('00000000-0000-4000-8000-000000000b01')).amount_gbp, 135.00, 'the payment stands at £135');
select is((pg_temp.pay('00000000-0000-4000-8000-000000000b01')).status, 'paid', 'still paid');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id where o.aggregate_id = '00000000-0000-4000-8000-000000000b01' and o.event_type = 'booking.extended' and d.audience = 'client'), 0, 'cash, unticked: no message');
select is((public.admin_extend_preview('00000000-0000-4000-8000-000000000b01')->>'extended_minutes')::integer, 30, 'the screen knows 30 minutes were added');

-- Up to 2 hours in all.
select lives_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b01', 60, 90, 'free') $$, 'a further hour, free');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b01')).total_gbp, 135.00, 'free: the total does not change');
select is((select pay_by from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b01' and minutes = 60), 'free', 'any price with "free" is recorded as £0');
select is((select price_gbp from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b01' and minutes = 60), 0.00, 'no charge is £0, whatever was typed');
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b01', 45, 45, 'cash') $$, '22023', 'A booking can have up to 2 hours of extra time in all.', 'not more than 2 hours in all');
select throws_ok($$ select public.admin_remove_extension((select id from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b01' and pay_by = 'cash'), gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b01')) $$,
  '22023', 'This extra was paid in cash, so it cannot be removed.', 'cash already received cannot be removed');

-- A booking with extra time took place: not cancelled, no-show or moved.
select throws_ok($$ update public.bookings set booking_status = 'no_show' where id = '00000000-0000-4000-8000-000000000b01' $$, '22023', 'This booking has extra time. Remove the extra time first.', 'no no-show');
select throws_ok($$ update public.bookings set booking_status = 'cancelled', cancelled_at = now(), cancelled_by_actor_type = 'admin' where id = '00000000-0000-4000-8000-000000000b01' $$, '22023', 'This booking has extra time. Remove the extra time first.', 'no cancelling');
select throws_ok($$ update public.bookings set date = date + 5 where id = '00000000-0000-4000-8000-000000000b01' $$, '22023', 'This booking has extra time. Remove the extra time first.', 'no moving');
select lives_ok($$ update public.bookings set booking_status = 'completed' where id = '00000000-0000-4000-8000-000000000b01' $$, 'Mark completed still works');

-- Edit booking asks for the extra time to be removed first.
select throws_ok($$ select public.admin_preview_booking_change('00000000-0000-4000-8000-000000000b01', '[{"service_id":"00000000-0000-4000-8000-0000000000e1","duration_minutes":90}]', false) $$,
  '22023', 'This booking has extra time. Remove the extra time first, then change the booking.', 'Edit booking: remove the extra time first');

-- Paid, extra by transfer: still to pay, an email with the bank details, To check once the session is over, and "I've sent it".
select lives_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b06', 30, 45, 'transfer') $$, 'couple, paid: +30 min by transfer');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b06')).total_gbp, 225.00, 'total £225');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b06')).balance_due_gbp, 45.00, '£45 still to pay');
select is((pg_temp.pay('00000000-0000-4000-8000-000000000b06')).amount_gbp, 180.00, 'the payment is unchanged until it arrives');
select ok((select d.body like '%Extra time, 30 minutes (P1): £45.00%Total: £225.00%There is £45.00 still to pay%Sort code: 00-11-22%' from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id
  where o.aggregate_id = '00000000-0000-4000-8000-000000000b06' and o.event_type = 'booking.extended' and d.audience = 'client' and d.channel = 'email'), 'the client is emailed the bill and the bank details');
select ok(exists (select 1 from public.admin_payment_review_queue(0) q where q.id = '00000000-0000-4000-8000-000000000b06'), 'To check lists the extra still to pay');
select pg_temp.as_bob();
select throws_ok($$ select public.report_extra_sent('00000000-0000-4000-8000-000000000b06') $$, '42501', null, 'another client cannot say it was sent');
select pg_temp.as_ann();
select is((public.get_my_booking('00000000-0000-4000-8000-000000000b06')->'booking_extensions'->0->>'minutes')::integer, 30, 'the client sees the extra time on the bill');
select is(public.get_my_booking('00000000-0000-4000-8000-000000000b06')->'extra_bank'->>'sort_code', '00-11-22', 'and where to pay it');
select is(public.get_my_booking('00000000-0000-4000-8000-000000000b01')->'extra_bank', 'null'::jsonb, 'no bank details when nothing is owed');
select ok((public.report_extra_sent('00000000-0000-4000-8000-000000000b06')->>'balance_reported_at') is not null, 'the client says they sent it');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id where o.aggregate_id = '00000000-0000-4000-8000-000000000b06' and o.event_type = 'booking.extra_reported' and d.audience = 'admin'), 2, 'Vadim is told (app and Telegram)');
select ok((public.report_extra_sent('00000000-0000-4000-8000-000000000b06')->>'balance_reported_at') is not null, 'saying it twice is harmless');
select is((select count(*)::integer from public.event_outbox o where o.aggregate_id = '00000000-0000-4000-8000-000000000b06' and o.event_type = 'booking.extra_reported'), 1, 'and tells Vadim once');
select pg_temp.as_admin();
select lives_ok($$ select public.admin_record_balance_received('00000000-0000-4000-8000-000000000b06', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b06')) $$, 'Mark extra received');
select is((pg_temp.pay('00000000-0000-4000-8000-000000000b06')).amount_gbp, 225.00, 'paid in full');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b06')).balance_reported_at, null, '"sent" is cleared');
select ok(not exists (select 1 from public.admin_payment_review_queue(0) q where q.id = '00000000-0000-4000-8000-000000000b06'), 'off To check');
select throws_ok($$ select public.admin_remove_extension((select id from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b06'), gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b06')) $$,
  '22023', 'The extra has already been received, so this extra time cannot be removed.', 'received extra time cannot be removed');
-- A second extra by transfer: the first one, received, still cannot be removed; the new one can.
select lives_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b06', 15, 45, 'transfer') $$, 'another +15 min by transfer');
select throws_ok($$ select public.admin_remove_extension((select id from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b06' and minutes = 30), gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b06')) $$,
  '22023', 'The extra has already been received, so this extra time cannot be removed.', 'the received one stays, whatever is owed now');
select lives_ok($$ select public.admin_remove_extension((select id from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b06' and minutes = 15), gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b06')) $$, 'the new one can be removed');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b06')).balance_due_gbp, 0.00, 'nothing owed again');
select pg_temp.as_ann();
set local role authenticated;
select is((select count(*)::integer from public.booking_extensions), 0, 'clients do not read the table itself (only through their booking)');
reset role;
select pg_temp.as_admin();

-- Not paid yet, bank transfer: on the bill, one payment covers it; removed again.
select lives_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b02', 30, 45, 'bill', true) $$, 'unpaid booking, +30 min on the bill, thank-you ticked');
select is((pg_temp.pay('00000000-0000-4000-8000-000000000b02')).amount_gbp, 135.00, 'to pay: £135');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b02')).balance_due_gbp, 0.00, 'nothing separate owed');
select ok((select d.body like '%Total: £135.00%To pay by bank transfer: £135.00%' from public.notification_deliveries d join public.event_outbox o on o.id = d.event_id
  where o.aggregate_id = '00000000-0000-4000-8000-000000000b02' and o.event_type = 'booking.extended' and d.audience = 'client' and d.channel = 'email'), 'the thank-you has the bill');
select lives_ok($$ select public.admin_remove_extension((select id from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b02'), gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b02')) $$, 'Remove extra time');
select is((pg_temp.pay('00000000-0000-4000-8000-000000000b02')).amount_gbp, 90.00, 'back to £90');
select is((pg_temp.b('00000000-0000-4000-8000-000000000b02')).treatment_duration_minutes, 60, 'back to 60 minutes');

-- Not paid yet, cash: on the bill; Cash received takes it all.
select lives_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b03', 15, 23, 'bill') $$, 'cash booking, +15 min £23 on the bill');
select is((pg_temp.pay('00000000-0000-4000-8000-000000000b03')).amount_gbp, 113.00, 'cash to collect: £113');

-- A transfer the client says they sent is checked first, so the amount checked is the amount sent.
select throws_ok($$ select pg_temp.ext('00000000-0000-4000-8000-000000000b07', 30, 45, 'transfer') $$, '22023', 'Check the client''s payment first (Mark received in To check), then add the extra time.', 'transfer to check: not yet');
-- A refund to send comes first.
update public.bookings set refund_due_gbp = 30 where id = '00000000-0000-4000-8000-000000000b09';
select is(public.admin_extend_preview('00000000-0000-4000-8000-000000000b09')->>'refusal', 'This booking has a refund to send. Record the refund first, then add the extra time.', 'a refund to send comes first');

-- Idempotent.
create temp table req as select gen_random_uuid() as id, pg_temp.bv('00000000-0000-4000-8000-000000000b10') as v;
select lives_ok($$ select public.admin_extend_booking('00000000-0000-4000-8000-000000000b10', (select id from req), (select v from req), pg_temp.s1('00000000-0000-4000-8000-000000000b10'), 15, 23, 'cash', false) $$, 'once');
select lives_ok($$ select public.admin_extend_booking('00000000-0000-4000-8000-000000000b10', (select id from req), (select v from req), pg_temp.s1('00000000-0000-4000-8000-000000000b10'), 15, 23, 'cash', false) $$, 'the same tap again');
select is((select count(*)::integer from public.booking_extensions where booking_id = '00000000-0000-4000-8000-000000000b10'), 1, 'saved once');

-- The receipt has a line for it.
select lives_ok($$ select public.admin_save_receipt_details('{"name":"VadMassage","phone":"07700 900123","practitioner_name":"Vad Test","association":"Test Association","membership_number":"123"}') $$, 'receipt details');
select ok(public.build_receipt_snapshot('00000000-0000-4000-8000-000000000b01')->'lines' @> '[{"label":"Extra time, 30 minutes (P1)","amount":45.00}]', 'the receipt lists the extra time');
select is((public.build_receipt_snapshot('00000000-0000-4000-8000-000000000b01')->>'total')::numeric, 135.00, 'and the full total');

select * from finish();
rollback;
