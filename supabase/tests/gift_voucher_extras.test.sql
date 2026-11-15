begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- Gift vouchers, second step (20261215100000_gift_voucher_extras.sql): the area cards, extras, the terms tick, and late changes to a gift booking.

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
-- A congestion-only area (£18) beside Chelsea (£35) and Nearby (£0), and an extra.
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values
  ('00000000-0000-4000-8000-00000000d533', 'gift-mid', 'Middle', true, 0, 18, 992);
update public.enhancements set active = false;
insert into public.enhancements(id, slug, name, description, price_gbp, duration_minutes, active, display_order) values
  ('00000000-0000-4000-8000-00000000d541', 'gift-extra-strong', 'Extra strong', 'Additional pressure', 15, 0, true, 990);
create function pg_temp.book_with(p_code text, p_area uuid, p_sessions jsonb, p_extras uuid[], p_day integer, p_start integer, p_key text)
returns table(id uuid, total numeric, status text, pay text) language plpgsql as $$
declare h record;
begin
  select * into h from public.create_booking_hold(pg_temp.day(p_day), p_start, (select sum((s->>'duration_minutes')::integer) from jsonb_array_elements(p_sessions) s)::integer, 'gift-browser-' || p_key || '-00000000');
  return query select f.booking_id, f.total_gbp, f.booking_status, f.payment_status from public.finalize_client_booking(
    p_hold_id := h.hold_id, p_hold_token := h.hold_token, p_hold_client_key := 'gift-browser-' || p_key || '-00000000', p_service_area_id := p_area,
    p_sessions := p_sessions, p_enhancement_ids := p_extras, p_saved_address_id := null, p_address_line_1 := null, p_address_line_2 := null,
    p_city := null, p_postcode := null, p_entry_instructions := null, p_client_note := null, p_payment_method := 'bank_transfer',
    p_idempotency_key := 'gift-request-' || p_key, p_address := '1 Gift Road, London', p_gift_code := p_code) f;
end; $$;
grant execute on function pg_temp.book_with(text, uuid, jsonb, uuid[], integer, integer, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Buying: the terms tick, the 'upto' card, the extras
-- ---------------------------------------------------------------------------------------------
select ok((public.get_gift_options()->'enhancements') @> '[{"name": "Extra strong", "price": 15.00}]'::jsonb, 'The buying page lists the extras');
set local role anon;
select throws_ok($$select public.buy_gift_voucher(90, 1, 'none', null, 'gold_foil', 'Sam', 'Jo', null, 'self', null, null, 'Jo Buyer', 'jo@example.test', null)$$,
  '22023', 'Please tick the box to say you understand the voucher terms.', 'The terms must be ticked');
select throws_ok($$select public.buy_gift_voucher(90, 1, 'upto', null, 'gold_foil', 'Sam', 'Jo', null, 'self', null, null, 'Jo Buyer', 'jo@example.test', null, 10, '{}', true)$$,
  '22023', 'Please choose where they live again.', 'An up-to amount must be some area''s charge');
select throws_ok($$select public.buy_gift_voucher(90, 1, 'upto', null, 'gold_foil', 'Sam', 'Jo', null, 'self', null, null, 'Jo Buyer', 'jo@example.test', null, 35, '{}', true)$$,
  '22023', 'Please choose where they live again.', 'and below the highest (that one is Everything included)');
select throws_ok($$select public.buy_gift_voucher(90, 1, 'none', null, 'gold_foil', 'Sam', 'Jo', null, 'self', null, null, 'Jo Buyer', 'jo@example.test', null, null, '{00000000-0000-4000-8000-0000000000ff}', true)$$,
  '22023', 'Please choose the extras again.', 'Only extras on offer can be added');
create temp table b1 as select public.buy_gift_voucher(90, 1, 'upto', null, 'gold_foil', 'Sam', 'Jo', null, 'self', null, null, 'Jo Buyer', 'jo@example.test', null,
  18, '{00000000-0000-4000-8000-00000000d541}', true) as r;
reset role;
select is((select (r->>'amount')::numeric from b1), 158.00, '90 minutes £125 + congestion up to £18 + Extra strong £15 = £158');
select is((select (travel_choice, travel_cover_gbp, enhancements_gbp, enhancement_names, terms_accepted_at is not null) from public.gift_vouchers where recipient_name = 'Sam'),
  ('upto'::text, 18.00::numeric(10,2), 15.00::numeric(10,2), '{"Extra strong"}'::text[], true), 'It keeps the card, the extra and when the terms were ticked');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select is((select status from public.admin_mark_gift_paid((select id from public.gift_vouchers where recipient_name = 'Sam'), 'bank_transfer')), 'ready', 'Paid');
reset role;
create temp table c1 as select code from public.gift_vouchers where recipient_name = 'Sam';
grant select on c1 to authenticated;
select is(public.get_gift_voucher((select code from c1))->'extras', '["Extra strong"]'::jsonb, 'The voucher page names the extra');
select is(public.check_gift_code((select code from c1))->'enhancement_ids', '["00000000-0000-4000-8000-00000000d541"]'::jsonb, 'and the booking is told to pick it');

-- ---------------------------------------------------------------------------------------------
-- Booking: the voucher pays the extra, and the charge up to its amount
-- ---------------------------------------------------------------------------------------------
select is((select (gift_covered_gbp, to_pay_gbp) from public.quote_gift_booking((select code from c1), '00000000-0000-4000-8000-00000000d533', pg_temp.sessions(90), '{00000000-0000-4000-8000-00000000d541}')),
  (158.00::numeric, 0.00::numeric), 'In the £18 area with the extra: nothing to pay');
select is((select (gift_covered_gbp, to_pay_gbp) from public.quote_gift_booking((select code from c1), '00000000-0000-4000-8000-00000000d531', pg_temp.sessions(90), '{00000000-0000-4000-8000-00000000d541}')),
  (158.00::numeric, 17.00::numeric), 'In the £35 area: only the £17 over the £18 is to pay');
select is((select (gift_covered_gbp, to_pay_gbp) from public.quote_gift_booking((select code from c1), '00000000-0000-4000-8000-00000000d533', pg_temp.sessions(90), '{}')),
  (143.00::numeric, 0.00::numeric), 'Without the extra, the voucher pays only what is booked');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
create temp table k1 as select * from pg_temp.book_with((select code from c1), '00000000-0000-4000-8000-00000000d533', pg_temp.sessions(90), '{00000000-0000-4000-8000-00000000d541}', 5, 720, 'x1');
reset role;
select is((select (status, pay) from k1), ('confirmed'::text, 'paid'::text), 'Booked with the extra and nothing to pay: confirmed straight away');
select is((select gift_covered_gbp from public.bookings where id = (select id from k1)), 158.00::numeric(10,2), 'The voucher paid it all');

-- ---------------------------------------------------------------------------------------------
-- Late changes: the fee is only on what the client paid; a late cancel uses the voucher up; no late move online; not past the end
-- ---------------------------------------------------------------------------------------------
select is(public.change_fee_gbp((select b from public.bookings b where id = (select id from k1)), 'client', now() + interval '5 days'), 0.00::numeric, 'Late, the fee leaves out what the voucher paid');
-- Moved past the voucher's end, or late: refused online.
update public.gift_vouchers set expires_at = now() + interval '6 days' where recipient_name = 'Sam';
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
select throws_like(format($$select public.client_reschedule_booking(%L, gen_random_uuid(), %L, 720, 0)$$, (select id from k1), pg_temp.day(9)),
  'Your gift voucher ends on %', 'A gift booking cannot be moved past its voucher''s end');
reset role;
update public.bookings set date = pg_temp.day(1), start_minutes = 0, created_at = now() - interval '2 days' where id = (select id from k1);
select pg_temp.as_user('00000000-0000-0000-0000-00000000d502');
select throws_like(format($$select public.client_reschedule_booking(%L, gen_random_uuid(), %L, 720, 0)$$, (select id from k1), pg_temp.day(3)),
  'Within % hours of the appointment, a booking paid with a gift voucher can''t be moved online.%', 'nor moved late');
select is((public.get_my_change_terms((select id from k1))->>'gift_late')::boolean, true, 'The client is told cancelling now uses the voucher up');
select is((public.get_my_change_terms((select id from k1))->>'cancel_fee_gbp')::numeric, 0.00::numeric, 'with no fee on top');
select ok((select (public.client_cancel_booking((select id from k1), gen_random_uuid(), 0, 'Ill')) is not null), 'Cancelled late');
reset role;
select is((select (status, booking_id is not null) from public.gift_vouchers where recipient_name = 'Sam'), ('used'::text, true), 'The voucher is used up');
select is((select (late_fee_due_gbp, refund_due_gbp) from public.bookings where id = (select id from k1)), (0.00::numeric(10,2), 0.00::numeric(10,2)), 'and nothing more is owed or refunded');

-- Vadim can still give it back by hand.
select pg_temp.as_user('00000000-0000-0000-0000-00000000d501');
select is((select e->'booking'->>'status' from jsonb_array_elements(public.admin_gift_vouchers()) e where e->>'recipient_name' = 'Sam'), 'cancelled', 'Vadim sees its booking was cancelled');
select is((select status from public.admin_mark_gift_used((select id from public.gift_vouchers where recipient_name = 'Sam'), false)), 'ready'::text, 'Vadim can give it back by hand');
reset role;

select * from finish();
rollback;
