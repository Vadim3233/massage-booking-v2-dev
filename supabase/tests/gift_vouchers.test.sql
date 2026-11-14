begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- Fixtures: the Admin, a client, one treatment (60 min £90, 90 min £125, 120 min £170) and two areas:
-- Chelsea (travel £20 + congestion £15) and Nearby (nothing extra).
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000d501', 'authenticated', 'authenticated', 'gift-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000d502', 'authenticated', 'authenticated', 'gift-mum@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d501');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000d511', '00000000-0000-0000-0000-00000000d502', 'Mary', 'Mum', 'gift-mum@example.test', '+44 7700 900611');
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000d521', 'gift-test-service', 'Gift Test Massage', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values
  ('00000000-0000-4000-8000-00000000d521', 60, 90, true), ('00000000-0000-4000-8000-00000000d521', 90, 125, true),
  ('00000000-0000-4000-8000-00000000d521', 120, 170, true);
update public.services set active = false where id <> '00000000-0000-4000-8000-00000000d521';
update public.service_areas set active = false;
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values
  ('00000000-0000-4000-8000-00000000d531', 'gift-chelsea', 'Chelsea', true, 20, 15, 990),
  ('00000000-0000-4000-8000-00000000d532', 'gift-nearby', 'Nearby', true, 0, 0, 991);
create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
  select pg_temp.day(d), true, 600, 1200, 'flexible' from generate_series(0, 20) d
  on conflict (date) do update set available = true, start_minutes = 600, end_minutes = 1200, start_mode = 'flexible', fixed_start_minutes = null;
insert into public.business_settings(key, value) values ('new_client_booking_limit', '20'), ('returning_client_booking_limit', '20'), ('minimum_notice_minutes', '60')
  on conflict (key) do update set value = excluded.value;

create function pg_temp.as_user(p_sub text) returns void language sql as $$
  select set_config('role', 'authenticated', true), set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.sessions(p_minutes integer, p_people integer default 1) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('service_id', '00000000-0000-4000-8000-00000000d521', 'duration_minutes', p_minutes)) from generate_series(1, p_people);
$$;
-- Hold a time and book it with a code, as the client's browser does.
create function pg_temp.book(p_code text, p_area uuid, p_sessions jsonb, p_day integer, p_start integer, p_key text) returns table(id uuid, total numeric, status text, pay text)
language plpgsql as $$
declare h record;
begin
  select * into h from public.create_booking_hold(pg_temp.day(p_day), p_start, (select sum((s->>'duration_minutes')::integer) from jsonb_array_elements(p_sessions) s)::integer, 'gift-browser-' || p_key || '-00000000');
  return query select f.booking_id, f.total_gbp, f.booking_status, f.payment_status from public.finalize_client_booking(
    p_hold_id := h.hold_id, p_hold_token := h.hold_token, p_hold_client_key := 'gift-browser-' || p_key || '-00000000', p_service_area_id := p_area,
    p_sessions := p_sessions, p_enhancement_ids := '{}'::uuid[], p_saved_address_id := null, p_address_line_1 := null, p_address_line_2 := null,
    p_city := null, p_postcode := null, p_entry_instructions := null, p_client_note := null, p_payment_method := 'bank_transfer',
    p_idempotency_key := 'gift-request-' || p_key, p_address := '1 Gift Road, London', p_gift_code := p_code) f;
end; $$;
grant execute on function pg_temp.book(text, uuid, jsonb, integer, integer, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------------------------------
select ok(has_function_privilege('anon', 'public.get_gift_options()', 'EXECUTE'), 'Anyone can see what can be bought');
select ok(has_function_privilege('anon', 'public.buy_gift_voucher(integer,integer,text,uuid,text,text,text,text,text,text,timestamptz,text,text,text)', 'EXECUTE'), 'and buy a voucher without an account');
select ok(has_function_privilege('anon', 'public.get_gift_voucher(text)', 'EXECUTE'), 'and open a voucher with its code');
select ok(not has_table_privilege('anon', 'public.gift_vouchers', 'SELECT'), 'Visitors cannot list vouchers');
select ok(not has_function_privilege('anon', 'public.admin_mark_gift_paid(uuid,text)', 'EXECUTE'), 'A visitor cannot mark one paid');
select ok(not has_function_privilege('authenticated', 'public.plan_gift_messages(timestamptz)', 'EXECUTE'), 'Only the server plans the waiting emails');
select ok(not has_function_privilege('anon', 'public.usable_gift_voucher(text,jsonb,boolean)', 'EXECUTE'), 'The inside helpers are not callable');

-- ---------------------------------------------------------------------------------------------
-- The buying page
-- ---------------------------------------------------------------------------------------------
set local role anon;
select is((select public.get_gift_options()->'lengths'), '[{"price": 90, "minutes": 60}, {"price": 125, "minutes": 90}, {"price": 170, "minutes": 120}]'::jsonb, 'The lengths at today''s prices');
select is((select (public.get_gift_options()->>'all_areas_cover')::numeric), 35.00, '"Everything included" adds the highest area charge, £35');
select is((select jsonb_array_length(public.get_gift_options()->'areas')), 2, 'and the areas are listed with what they add');

select throws_ok($$select public.buy_gift_voucher(75, 1, 'all', null, 'gold_foil', 'Mum', 'Anna', null, 'self', null, null, 'Anna Buyer', 'anna@example.test', null)$$,
  '22023', 'There is no 75-minute massage to give. Please choose another length.', 'A length with no massage is refused');
select throws_ok($$select public.buy_gift_voucher(60, 1, 'all', null, 'gold_foil', ' ', 'Anna', null, 'self', null, null, 'Anna Buyer', 'anna@example.test', null)$$,
  '22023', 'Who is the voucher for?', 'It needs a name');
select throws_ok($$select public.buy_gift_voucher(60, 1, 'all', null, 'gold_foil', 'Mum', 'Anna', null, 'self', null, null, 'Anna Buyer', 'not-an-email', null)$$,
  '22023', 'Please add your email, so I can send you the voucher.', 'and the buyer''s email');
select throws_ok($$select public.buy_gift_voucher(60, 1, 'all', null, 'gold_foil', 'Mum', 'Anna', null, 'email', null, now() + interval '1 day', 'Anna Buyer', 'anna@example.test', null)$$,
  '22023', 'Please add their email, so the voucher can reach them.', 'Sending by email needs their email');

create temp table bought as select public.buy_gift_voucher(60, 1, 'all', null, 'christmas_night', 'Mum', 'Anna', 'Happy Christmas! Love, Anna x', 'self', null, null,
  'Anna Buyer', 'Anna@Example.test', '07700 900000') as r;
grant select on bought to anon, authenticated;
select is((select (r->>'amount')::numeric from bought), 125.00, 'A 60-minute massage with everything included is £90 + £35');
select ok((select r->>'reference' ~ '^GIFT-[A-Z0-9]{5}$' from bought), 'with a GIFT- reference to pay with');
reset role;
create temp table v1 as select * from public.gift_vouchers;
grant select on v1 to anon, authenticated;
select is((select (status, price_gbp, travel_cover_gbp, buyer_email) from v1), ('awaiting_payment'::text, 125.00::numeric(10,2), 35.00::numeric(10,2), 'anna@example.test'::text), 'It waits for payment, keeping what the travel cover is');
select ok((select code ~ '^[A-HJKMNP-Z2-9]{8}$' from v1), 'Its code is eight letters and digits that are easy to read');
select is((select count(*)::int from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'gift.bought' and d.audience = 'admin' and d.title = 'New gift voucher: £125.00 by bank transfer'), 3, 'Vadim is told (app, Telegram, email)');
select is((select count(*)::int from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'gift.bought' and d.audience = 'client' and d.recipient = 'anna@example.test' and d.body like '%Warm wishes,' || E'\n' || 'Vadim'), 1, 'and the buyer is emailed how to pay');

set local role anon;
select is((select public.get_gift_voucher((select lower(code) from v1))->>'state'), 'waiting', 'The voucher''s page says it is waiting for payment');
select throws_ok($$select public.check_gift_code((select code from v1))$$, '22023', 'This gift voucher is waiting for payment, so it can''t be used yet.', 'and it cannot be booked with yet');
select is((select public.gift_transfer_made(((select r->>'token' from bought))::uuid)->>'transfer_declared'), 'true', 'The buyer says the transfer is made');
select is((select public.gift_transfer_made(((select r->>'token' from bought))::uuid)->>'status'), 'awaiting_payment', 'Saying it twice is fine');
reset role;
select is((select count(*)::int from public.event_outbox where event_type = 'gift.transfer_declared'), 1, 'Vadim is told once');

-- ---------------------------------------------------------------------------------------------
-- Vadim marks it paid
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
select throws_ok($$select public.admin_mark_gift_paid((select id from v1))$$, '42501', null, 'A client cannot mark it paid');
select is((select count(*)::int from public.gift_vouchers), 0, 'nor read vouchers');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select is((select status from public.admin_mark_gift_paid((select id from v1))), 'ready', 'Vadim marks it paid: it is ready');
select is((select status from public.admin_mark_gift_paid((select id from v1))), 'ready', 'Pressing again changes nothing');
select is((select jsonb_array_length(public.admin_gift_vouchers())), 1, 'He sees it in More › Gift vouchers');
select ok(not (public.admin_gift_vouchers()->0 ? 'buyer_token'), 'without the buyer''s private link');
reset role;
select ok((select expires_at between now() + interval '12 months' - interval '1 minute' and now() + interval '12 months' + interval '1 minute' from public.gift_vouchers where id = (select id from v1)), 'It is valid for 12 months');
select is((select count(*)::int from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'gift.ready' and d.recipient = 'anna@example.test' and d.title = 'Your gift voucher for Mum is ready' and d.link_path like '/gift/____-____'), 1, 'The buyer is sent the voucher''s link');

set local role anon;
select is((select public.get_gift_voucher((select code from v1))->>'state'), 'ready', 'The voucher''s page opens it');
select is((select public.check_gift_code((select left(code, 4) || '-' || right(code, 4) from v1))->>'minutes'), '60', 'The code works as shown, with its dash');
-- The price on the review screen.
select is((select (total_gbp, gift_covered_gbp, to_pay_gbp) from public.quote_gift_booking((select code from v1), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60))),
  (125.00::numeric, 125.00::numeric, 0.00::numeric), 'In Chelsea it pays the massage, travel and congestion: nothing to pay');
select is((select (total_gbp, gift_covered_gbp, to_pay_gbp) from public.quote_gift_booking((select code from v1), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(90))),
  (160.00::numeric, 125.00::numeric, 35.00::numeric), 'A 90-minute massage instead costs only the £35 difference');
select is((select (total_gbp, gift_covered_gbp, to_pay_gbp) from public.quote_gift_booking((select code from v1), '00000000-0000-4000-8000-00000000d532', pg_temp.sessions(60))),
  (90.00::numeric, 90.00::numeric, 0.00::numeric), 'Nearby, the unused travel cover is simply not needed');
select throws_ok($$select * from public.quote_gift_booking((select code from v1), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60, 2))$$,
  '22023', 'This gift voucher is for one person.', 'Two people are refused');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Booking with it
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
select throws_ok($$select * from pg_temp.book('WRONG123', '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60), 3, 600, 'wrong')$$,
  '22023', 'That gift voucher code doesn''t work. Please check it, or message Vadim.', 'A wrong code is refused');
create temp table booked1 as select * from pg_temp.book((select code from v1), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60), 3, 600, 'one');
grant select on booked1 to authenticated;
select is((select (total, status, pay) from booked1), (0.00::numeric, 'confirmed'::text, 'paid'::text), 'Mum books: nothing to pay, confirmed straight away');
reset role;
select is((select (total_gbp, gift_covered_gbp, gift_voucher_id) from public.bookings where id = (select id from booked1)), (125.00::numeric(10,2), 125.00::numeric(10,2), (select id from v1)),
  'The booking keeps its full price (Income) and what the voucher paid');
select is((select (method, status, amount_gbp, paid_at is not null) from public.booking_payments where booking_id = (select id from booked1)),
  ('bank_transfer'::text, 'paid'::text, 0.00::numeric(10,2), true), 'Its payment is nothing, already paid');
select is((select (status, booking_id) from public.gift_vouchers where id = (select id from v1)), ('used'::text, (select id from booked1)), 'The voucher is now used');
select is((select title from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from booked1) and e.event_type = 'booking.created' and d.channel = 'telegram' and d.audience = 'admin'), 'New booking with a gift voucher', 'Vadim is told it is a gift booking');
select ok((select body like '%Nothing to pay, it is confirmed.' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from booked1) and e.event_type = 'booking.created' and d.channel = 'telegram' and d.audience = 'admin'), 'with nothing to pay');
select is((select count(*)::int from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from booked1) and d.audience = 'client' and d.recipient = 'gift-mum@example.test' and d.title = 'Your appointment is booked'
    and d.body like '%Your gift voucher from Anna pays for it%Warm wishes,' || E'\n' || 'Vadim'), 1, 'Mum is emailed that it is booked');

select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
select throws_ok($$select * from pg_temp.book((select code from v1), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60), 4, 600, 'again')$$,
  '22023', 'This gift voucher has already been used.', 'A used voucher cannot be booked again');
reset role;
select throws_ok($$select public.client_change_check((select b from public.bookings b where b.id = (select id from booked1)), 90)$$, '22023',
  'This booking was paid with a gift voucher, so its length can''t be changed online. Please message Vadim and he''ll sort it out.', 'Its length cannot be changed online');
select lives_ok($$select public.client_change_check((select b from public.bookings b where b.id = (select id from booked1)), null)$$, 'but it can be moved');
-- Vadim makes it longer: the voucher's part counts as already paid, so only the difference is asked for.
select is((select (public.booking_change_plan(b, p, pg_temp.sessions(90), false, now()))->>'balance_due_gbp' from public.bookings b join public.booking_payments p on p.booking_id = b.id
  where b.id = (select id from booked1)), '35.00', 'Making it 90 minutes leaves £35 to pay');

-- A cancelled booking gives the voucher back.
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = (select id from booked1);
select is((select (status, booking_id) from public.gift_vouchers where id = (select id from v1)), ('ready'::text, null::uuid), 'Cancelled: the voucher can be used again');

-- ---------------------------------------------------------------------------------------------
-- "Just the massage", made by Vadim for cash, for two people
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
create temp table v2 as select * from public.admin_make_gift_voucher(60, 2, 'none', null, 'any_occasion', 'Sam and Alex', 'Jo', null, 'Jo Cash', null, 'cash');
grant select on v2 to authenticated;
select is((select (status, price_gbp, payment_method, created_by) from v2), ('ready'::text, 180.00::numeric(10,2), 'cash'::text, 'admin'::text), 'Vadim makes a voucher for two paid in cash: £180, ready');
reset role;
select is((select count(*)::int from public.event_outbox where event_type = 'gift.ready' and aggregate_id = (select id from v2)), 0, 'With no email, nobody is emailed');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
select throws_ok($$select * from pg_temp.book((select code from v2), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60), 5, 600, 'single')$$,
  '22023', 'This gift voucher is for two people, so please book for two.', 'It must be booked for two');
create temp table booked2 as select * from pg_temp.book((select code from v2), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60, 2), 5, 600, 'two');
select is((select (total, status, pay) from booked2), (35.00::numeric, 'awaiting_transfer'::text, 'awaiting_transfer'::text), 'In Chelsea they pay the £35 travel and congestion, as usual');
reset role;
select is((select amount_gbp from public.booking_payments where booking_id = (select id from booked2)), 35.00, 'The payment asked for is £35');
select is((select title from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from booked2) and e.event_type = 'booking.created' and d.channel = 'telegram'), 'New booking request with a gift voucher', 'Vadim is told the voucher pays part');

-- ---------------------------------------------------------------------------------------------
-- Emails that wait for their day
-- ---------------------------------------------------------------------------------------------
set local role anon;
create temp table bought3 as select public.buy_gift_voucher(90, 1, 'area', '00000000-0000-4000-8000-00000000d532', 'gold_foil', 'Dad', 'Ben', null, 'email',
  'dad@example.test', now() + interval '2 days', 'Ben Buyer', 'ben@example.test', null) as r;
reset role;
select is((select (r->>'amount')::numeric from bought3), 125.00, 'A 90-minute massage in an area with nothing extra is £125');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select is((select status from public.admin_mark_gift_paid((select id from public.gift_vouchers where recipient_name = 'Dad'), 'bank_transfer')), 'ready', 'Paid');
reset role;
select ok((select body like '%I will email it to Dad at dad@example.test%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'gift.ready' and d.recipient = 'ben@example.test'), 'The buyer is told when it will arrive');
select is(public.plan_gift_messages(now()), 0, 'Nothing goes before the day');
select is(public.plan_gift_messages(now() + interval '3 days'), 1, 'On the day, the voucher goes');
select is((select link_path from public.notification_deliveries where recipient = 'dad@example.test' and title = 'Ben has sent you a gift'), '/gift/' || (select public.gift_code_shown(code) from public.gift_vouchers where recipient_name = 'Dad') || '?open=1',
  'Dad is emailed the link to open it');
select is(public.plan_gift_messages(now() + interval '3 days'), 0, 'only once');
select is(public.plan_gift_messages(now() + interval '11 months' + interval '10 days'), 2, 'A month before the end, a reminder for each unused voucher');
select is((select count(*)::int from public.notification_deliveries where recipient = 'dad@example.test' and title = 'Your massage gift voucher ends soon'), 1, 'sent to the person who has it');
select is(public.plan_gift_messages(now() + interval '11 months' + interval '12 days'), 0, 'and only once');

-- An expired voucher cannot be used.
update public.gift_vouchers set expires_at = now() - interval '1 day' where recipient_name = 'Dad';
select throws_ok($$select public.check_gift_code((select code from public.gift_vouchers where recipient_name = 'Dad'))$$, '22023', null, 'An expired voucher is refused');
select is((select public.get_gift_voucher((select code from public.gift_vouchers where recipient_name = 'Dad'))->>'state'), 'expired', 'and its page says it has ended');

-- Turned off: nothing can be bought.
insert into public.business_settings(key, value) values ('gift_vouchers_on', 'false') on conflict (key) do update set value = excluded.value;
set local role anon;
select throws_ok($$select public.buy_gift_voucher(60, 1, 'none', null, 'gold_foil', 'Mum', 'Anna', null, 'self', null, null, 'Anna Buyer', 'anna@example.test', null)$$,
  '22023', 'Gift vouchers are not on sale right now. Please message Vadim.', 'When turned off, vouchers cannot be bought');
reset role;

select * from finish();
rollback;
