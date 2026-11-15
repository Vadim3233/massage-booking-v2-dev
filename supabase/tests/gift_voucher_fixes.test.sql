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
  select * into h from public.create_booking_hold(pg_temp.day(p_day), p_start, (select sum((s->>'duration_minutes')::integer) from jsonb_array_elements(p_sessions) s)::integer, 'fix-browser-' || p_key || '-00000000');
  return query select f.booking_id, f.total_gbp, f.booking_status, f.payment_status from public.finalize_client_booking(
    p_hold_id := h.hold_id, p_hold_token := h.hold_token, p_hold_client_key := 'fix-browser-' || p_key || '-00000000', p_service_area_id := p_area,
    p_sessions := p_sessions, p_enhancement_ids := '{}'::uuid[], p_saved_address_id := null, p_address_line_1 := null, p_address_line_2 := null,
    p_city := null, p_postcode := null, p_entry_instructions := null, p_client_note := null, p_payment_method := 'bank_transfer',
    p_idempotency_key := 'fix-request-' || p_key, p_address := '1 Gift Road, London', p_gift_code := p_code) f;
end; $$;
grant execute on function pg_temp.book(text, uuid, jsonb, integer, integer, text) to authenticated;
create function pg_temp.voucher(p_choice text, p_buyer text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  r := public.buy_gift_voucher(60, 1, p_choice, null, 'gold_foil', 'Mum', 'Anna', null, 'self', null, null, 'Anna Buyer', p_buyer, null, p_terms := true);
  select id into v from public.gift_vouchers where buyer_token = (r->>'token')::uuid;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
  perform public.admin_mark_gift_paid(v);
  reset role;
  return v;
end; $$;
create function pg_temp.stamp(p uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = p $$;
create function pg_temp.pstamp(p uuid) returns timestamptz language sql as $$ select updated_at from public.booking_payments where booking_id = p $$;
grant execute on function pg_temp.stamp(uuid), pg_temp.pstamp(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. A voucher that pays the massage only; the person lives in Chelsea (£35 travel and congestion): £35 is left to pay
-- ---------------------------------------------------------------------------------------------
create temp table v_none as select pg_temp.voucher('none', 'anna@example.test') as id;
alter table v_none add column code text;
update v_none set code = (select g.code from public.gift_vouchers g where g.id = v_none.id);
grant select on v_none to authenticated;
select ok((select expires_at = public.gift_end_of_day(expires_at) and to_char(expires_at at time zone 'Europe/London', 'HH24:MI:SS') = '23:59:59'
  from public.gift_vouchers where id = (select id from v_none)), 'A voucher ends at the end of its last day, London time');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
create temp table b_top as select * from pg_temp.book((select code from v_none), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60), 3, 600, 'top');
select is((select (status, pay) from b_top), ('awaiting_transfer'::text, 'awaiting_transfer'::text), 'The booking waits for the £35');
select is((select (r->>'amount_gbp')::numeric from jsonb_array_elements(public.list_my_bookings()) r where (r->>'id')::uuid = (select id from b_top)), 35.00,
  'Your bookings knows only £35 is left to pay');
select is((select (r->>'gift_covered_gbp')::numeric from jsonb_array_elements(public.list_my_bookings()) r where (r->>'id')::uuid = (select id from b_top)), 90.00,
  'and that the voucher paid £90');
select lives_ok($$select public.declare_my_bank_transfer((select id from b_top))$$, 'The client says the transfer is made');
reset role;
select ok((select bool_and(d.body like '£35.00 for %') from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from b_top) and e.event_type = 'booking.transfer_declared' and d.audience = 'admin'), 'Vadim is told to look for £35, not £125');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select lives_ok($$select public.admin_verify_bank_transfer((select id from b_top), gen_random_uuid(), pg_temp.stamp((select id from b_top)), pg_temp.pstamp((select id from b_top)))$$,
  'Vadim can verify the £35 (it used to stop with "Payment amount needs review")');
reset role;
select is((select (b.booking_status, p.status, p.amount_gbp) from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = (select id from b_top)),
  ('confirmed'::text, 'paid'::text, 35.00::numeric(10,2)), 'The booking is confirmed and the £35 paid');

-- The same, confirmed first and paid later (Confirm now, pay later, then Paid).
create temp table v_none2 as select pg_temp.voucher('none', 'anna2@example.test') as id;
alter table v_none2 add column code text;
update v_none2 set code = (select g.code from public.gift_vouchers g where g.id = v_none2.id);
grant select on v_none2 to authenticated;
update public.business_settings set value = '20' where key = 'new_client_booking_limit';
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
create temp table b_top2 as select * from pg_temp.book((select code from v_none2), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(60), 4, 600, 'top2');
grant select on b_top2 to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select lives_ok($$select public.admin_confirm_pay_later((select id from b_top2), gen_random_uuid(), pg_temp.stamp((select id from b_top2)), pg_temp.pstamp((select id from b_top2)))$$, 'Confirm now, pay later');
select lives_ok($$select public.admin_record_bank_transfer_received((select id from b_top2), gen_random_uuid(), pg_temp.stamp((select id from b_top2)), pg_temp.pstamp((select id from b_top2)))$$,
  'and later Paid works for the £35');
reset role;

-- ---------------------------------------------------------------------------------------------
-- 2. Everything included, booked Nearby: nothing to pay; the email names the address
-- ---------------------------------------------------------------------------------------------
create temp table v_all as select pg_temp.voucher('all', 'anna3@example.test') as id;
alter table v_all add column code text;
update v_all set code = (select g.code from public.gift_vouchers g where g.id = v_all.id);
grant select on v_all to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
create temp table b_all as select * from pg_temp.book((select code from v_all), '00000000-0000-4000-8000-00000000d532', pg_temp.sessions(60), 5, 600, 'all');
grant select on b_all to authenticated;
reset role;
select is((select (status, pay) from b_all), ('confirmed'::text, 'paid'::text), 'Everything included: confirmed, nothing to pay');
select ok((select body like '%at 1 Gift Road, London.%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from b_all) and d.audience = 'client' and d.title = 'Your appointment is booked'), 'The email says where (it used to say "at .")');
select ok((select body like '%' || E'\n' || '1 Gift Road, London' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from b_all) and d.audience = 'admin' and d.channel = 'telegram'), 'and Vadim''s alert gives the address');

-- Vadim moves it to Chelsea: the voucher covers the £35 too, so there is still nothing to pay and the change is allowed.
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select lives_ok($$select public.admin_change_booking_address((select id from b_all), gen_random_uuid(), pg_temp.stamp((select id from b_all)), '2 Gift Road, London', null,
  '00000000-0000-4000-8000-00000000d531')$$, 'Vadim changes the address to Chelsea');
reset role;
select is((select (b.total_gbp, b.gift_covered_gbp, p.amount_gbp) from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = (select id from b_all)),
  (125.00::numeric(10,2), 125.00::numeric(10,2), 0.00::numeric(10,2)), 'The voucher pays the new travel too: nothing to pay');

-- A massage-only voucher booked Nearby, moved to Chelsea while unpaid... (the voucher above is fully paid; this one is not)
create temp table v_none3 as select pg_temp.voucher('none', 'anna4@example.test') as id;
alter table v_none3 add column code text;
update v_none3 set code = (select g.code from public.gift_vouchers g where g.id = v_none3.id);
grant select on v_none3 to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
create temp table b_n3 as select * from pg_temp.book((select code from v_none3), '00000000-0000-4000-8000-00000000d532', pg_temp.sessions(90), 6, 600, 'n3');
grant select on b_n3 to authenticated;
reset role;
select is((select (b.total_gbp, b.gift_covered_gbp, p.amount_gbp) from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = (select id from b_n3)),
  (125.00::numeric(10,2), 90.00::numeric(10,2), 35.00::numeric(10,2)), 'A 90-minute massage on a 60-minute voucher: £35 to pay');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select lives_ok($$select public.admin_change_booking_address((select id from b_n3), gen_random_uuid(), pg_temp.stamp((select id from b_n3)), '3 Gift Road, London', null,
  '00000000-0000-4000-8000-00000000d531')$$, 'Moved to Chelsea');
reset role;
select is((select (b.total_gbp, b.gift_covered_gbp, p.amount_gbp) from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = (select id from b_n3)),
  (160.00::numeric(10,2), 90.00::numeric(10,2), 70.00::numeric(10,2)), 'The voucher pays only the massage: £70 to pay (it used to ask for all £160)');

-- ---------------------------------------------------------------------------------------------
-- 3. A no-show on a booking the voucher paid in full: no fee is suggested
-- ---------------------------------------------------------------------------------------------
update public.bookings set date = date - 10 where id = (select id from b_all);
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select lives_ok($$select public.admin_mark_no_show((select id from b_all), gen_random_uuid(), pg_temp.stamp((select id from b_all)))$$, 'Vadim marks a no-show');
reset role;
select is((select (booking_status, late_fee_due_gbp, late_fee_status) from public.bookings where id = (select id from b_all)),
  ('no_show'::text, 0.00::numeric(10,2), 'waived'::text), 'with no fee due (it used to show the client "Late fee of £125 due")');

-- ---------------------------------------------------------------------------------------------
-- 4. A voucher given back never comes back already ended; more time; changing details
-- ---------------------------------------------------------------------------------------------
update public.gift_vouchers set expires_at = public.gift_end_of_day(now() + interval '2 days') where id = (select id from v_none3);
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select lives_ok($$select public.admin_cancel_booking((select id from b_n3), gen_random_uuid(), pg_temp.stamp((select id from b_n3)), pg_temp.pstamp((select id from b_n3)), 'Vadim is ill', 'admin', null)$$,
  'Vadim cancels the booking');
reset role;
select ok((select status = 'ready' and expires_at >= now() + interval '29 days' from public.gift_vouchers where id = (select id from v_none3)),
  'The voucher comes back with at least 30 days left');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
select throws_ok($$select public.admin_extend_gift_voucher((select id from v_none3), current_date + 100)$$, '42501', null, 'A client cannot give a voucher more time');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select is((select to_char(expires_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') from public.admin_extend_gift_voucher((select id from v_none3), date '2027-06-30')),
  '2027-06-30 23:59', 'Vadim gives it more time, to the end of the day he chose');
select throws_ok($$select public.admin_extend_gift_voucher((select id from v_none3), current_date - 1)$$, '22023', 'Choose a day from today on.', 'Not a day in the past');
select throws_ok($$select public.admin_extend_gift_voucher((select id from v_all), date '2027-06-30')$$, 'PT409',
  'Only a paid voucher that has not been used can be given more time.', 'A used voucher is not given more time');
select is((select (recipient_name, from_name, message) from public.admin_update_gift_voucher((select id from v_none3), ' Mummy ', 'Anna & Tom', ' With love ')),
  ('Mummy'::text, 'Anna & Tom'::text, 'With love'::text), 'Vadim corrects the names and message');
reset role;
select * from finish();
rollback;
