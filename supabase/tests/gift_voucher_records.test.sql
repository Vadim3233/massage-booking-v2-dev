begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- ---------------------------------------------------------------------------------------------
-- Fixtures: the Admin, a client, one treatment (60 min £90, 90 min £125, 120 min £170) and two areas:
-- Chelsea (travel £20 + congestion £15) and Nearby (nothing extra).
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000f701', 'authenticated', 'authenticated', 'gift-admin@rec.example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000f702', 'authenticated', 'authenticated', 'gift-mum@rec.example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f701');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000f711', '00000000-0000-0000-0000-00000000f702', 'Mary', 'Mum', 'gift-mum@rec.example.test', '+44 7700 900611');
insert into public.services(id, slug, name, active, display_order) values ('00000000-0000-4000-8000-00000000f721', 'gift-rec-service', 'Gift Test Massage', true, 990);
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp, active) values
  ('00000000-0000-4000-8000-00000000f721', 60, 90, true), ('00000000-0000-4000-8000-00000000f721', 90, 125, true),
  ('00000000-0000-4000-8000-00000000f721', 120, 170, true);
update public.services set active = false where id <> '00000000-0000-4000-8000-00000000f721';
update public.service_areas set active = false;
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values
  ('00000000-0000-4000-8000-00000000f731', 'rec-chelsea', 'Chelsea', true, 20, 15, 990),
  ('00000000-0000-4000-8000-00000000f732', 'rec-nearby', 'Nearby', true, 0, 0, 991);
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
  select jsonb_agg(jsonb_build_object('service_id', '00000000-0000-4000-8000-00000000f721', 'duration_minutes', p_minutes)) from generate_series(1, p_people);
$$;
-- Hold a time and book it with a code, as the client's browser does.
create function pg_temp.book(p_code text, p_area uuid, p_sessions jsonb, p_day integer, p_start integer, p_key text) returns table(id uuid, total numeric, status text, pay text)
language plpgsql as $$
declare h record;
begin
  select * into h from public.create_booking_hold(pg_temp.day(p_day), p_start, (select sum((s->>'duration_minutes')::integer) from jsonb_array_elements(p_sessions) s)::integer, 'rec-browser-' || p_key || '-00000000');
  return query select f.booking_id, f.total_gbp, f.booking_status, f.payment_status from public.finalize_client_booking(
    p_hold_id := h.hold_id, p_hold_token := h.hold_token, p_hold_client_key := 'rec-browser-' || p_key || '-00000000', p_service_area_id := p_area,
    p_sessions := p_sessions, p_enhancement_ids := '{}'::uuid[], p_saved_address_id := null, p_address_line_1 := null, p_address_line_2 := null,
    p_city := null, p_postcode := null, p_entry_instructions := null, p_client_note := null, p_payment_method := 'bank_transfer',
    p_idempotency_key := 'rec-request-' || p_key, p_address := '1 Gift Road, London', p_gift_code := p_code) f;
end; $$;
grant execute on function pg_temp.book(text, uuid, jsonb, integer, integer, text) to authenticated;
create function pg_temp.voucher(p_choice text, p_buyer text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  r := public.buy_gift_voucher(60, 1, p_choice, null, 'gold_foil', 'Mum', 'Anna', null, 'self', null, null, 'Anna Buyer', p_buyer, null, p_terms := true);
  select id into v from public.gift_vouchers where buyer_token = (r->>'token')::uuid;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000f701');
  perform public.admin_mark_gift_paid(v);
  reset role;
  return v;
end; $$;
create function pg_temp.stamp(p uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id = p $$;
create function pg_temp.pstamp(p uuid) returns timestamptz language sql as $$ select updated_at from public.booking_payments where booking_id = p $$;
grant execute on function pg_temp.stamp(uuid), pg_temp.pstamp(uuid) to authenticated;



-- Runs one call as Vadim and comes back as the test (so every check below can read the tables).
create function pg_temp.adm(q text) returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000f701');
  execute 'select to_jsonb((' || q || '))' into r;
  reset role;
  return r;
end; $f$;
select lives_ok($$ select pg_temp.adm($q$public.admin_save_receipt_details('{"name":"VadMassage","phone":"07700 900123","practitioner_name":"Vad Test","association":"ISRM","membership_number":"9555"}')$q$) $$, 'receipt details');

-- 1. A paid voucher has a receipt (GV-), a History, and the buyer's emails link to their page.
create temp table v1 as select pg_temp.voucher('none', 'rec1@rec.example.test') as id;
alter table v1 add column code text;
update v1 set code = (select g.code from public.gift_vouchers g where g.id = v1.id);
grant select on v1 to anon, authenticated;
select matches((select receipt_number from public.gift_voucher_receipts where voucher_id = (select id from v1)), '^GV-\d{4}-\d{4}$', 'paid voucher: a GV- receipt is made');
select is((select (snapshot->>'total')::numeric from public.gift_voucher_receipts where voucher_id = (select id from v1)), 90.00, 'receipt total is the price paid');
select is((select sum((l->>'amount')::numeric) from public.gift_voucher_receipts r, jsonb_array_elements(r.snapshot->'lines') l where r.voucher_id = (select id from v1)), 90.00, 'its lines add up');
select is((select snapshot#>>'{lines,0,label}' from public.gift_voucher_receipts where voucher_id = (select id from v1)), 'A 60-minute massage', 'first line reads well');
select is((select snapshot#>>'{voucher,code_end}' from public.gift_voucher_receipts where voucher_id = (select id from v1)), (select right(code, 4) from v1), 'only the last 4 letters of the code');
select ok((select snapshot::text not like '%' || (select code from v1) || '%' from public.gift_voucher_receipts where voucher_id = (select id from v1)), 'the full code is not on the receipt');
select is((select array_agg(kind order by at, id) from public.gift_voucher_history where voucher_id = (select id from v1)), array['bought', 'paid', 'receipt'], 'History: bought, paid, receipt');
select ok((select bool_and(d.body like '%{site}/gift?t=' || g.buyer_token::text || '%') from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  join public.gift_vouchers g on g.id = e.aggregate_id where g.id = (select id from v1) and d.audience = 'client' and e.event_type in ('gift.bought', 'gift.ready')), 'buyer emails link to their gift page');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = (select id from v1) and d.audience = 'client' and e.event_type in ('gift.bought', 'gift.ready')), 2, 'both buyer emails are there');

-- The buyer's receipt from their page, as a visitor; a wrong key gets nothing.
create function pg_temp.receipt_as_anon(p uuid) returns jsonb language plpgsql as $f$ declare r jsonb; begin set local role anon; r := public.get_gift_receipt(p); reset role; return r; end; $f$;
grant execute on function pg_temp.receipt_as_anon(uuid) to anon;
select is((pg_temp.receipt_as_anon((select buyer_token from public.gift_vouchers where id = (select id from v1))))#>>'{standing,status}', 'paid', 'the buyer can fetch their receipt');
select throws_ok($$ select pg_temp.receipt_as_anon(gen_random_uuid()) $$, 'PT404', null, 'a wrong key gets nothing');
select is((public.get_my_gift_purchase((select buyer_token from public.gift_vouchers where id = (select id from v1))))->>'receipt', 'true', 'the buyer page knows there is a receipt');

-- 2. Booked with in full (Nearby, 60 minutes): the session gets a treatment receipt saying what the voucher paid; Income counts £90 once.
select pg_temp.as_user('00000000-0000-0000-0000-00000000f702');
create temp table b1 as select * from pg_temp.book((select code from v1), '00000000-0000-4000-8000-00000000f732', pg_temp.sessions(60), 3, 600, 'b1');
reset role;
set constraints all immediate;
set constraints all deferred;
select is((select pay from b1), 'paid', 'nothing left to pay');
select is((select (snapshot#>>'{gift,covered}')::numeric from public.booking_receipts where booking_id = (select id from b1)), 90.00, 'treatment receipt: voucher paid £90');
select is((select (snapshot#>>'{payment,amount}')::numeric from public.booking_receipts where booking_id = (select id from b1)), 0.00, 'and the client £0');
select ok(public.receipt_message((select snapshot from public.booking_receipts where booking_id = (select id from b1))) like '%Paid with gift voucher (ending%', 'the receipt email says so');
select ok((select words like 'Booked by Mary Mum for %' from public.gift_voucher_history where voucher_id = (select id from v1) and kind = 'booked'), 'History: booked by whom, for when');
select is((select (gift_gbp, net_gbp) from public.income_lines(pg_temp.day(3), pg_temp.day(3)) where booking_id = (select id from b1)), (90.00::numeric, 90.00::numeric), 'Income: £90 from the voucher on the session day');
select is((select count(*)::integer from public.income_lines(pg_temp.day(-400), pg_temp.day(400)) where gift_voucher_id = (select id from v1)), 1, 'counted once');
select is((pg_temp.adm($q$public.admin_income_summary('week', '$q$ || pg_temp.day(3) || $q$')$q$)->>'bank_gbp')::numeric, 0.00, 'not in bank transfers');
select is((pg_temp.adm($q$public.admin_income_summary('week', '$q$ || pg_temp.day(3) || $q$')$q$)->>'gift_gbp')::numeric, 90.00, 'in the gift voucher figure');
select ok((pg_temp.adm($q$public.admin_income_summary('month', '$q$ || pg_temp.day(3) || $q$')$q$)#>>'{gifts,held_gbp}')::numeric >= 90, 'held until the session');

-- Moved: the History says so.
create temp table st as select pg_temp.stamp((select id from b1)) as b, pg_temp.pstamp((select id from b1)) as p;
select lives_ok(format($$ select pg_temp.adm($q$public.admin_reschedule_booking(%L, gen_random_uuid(), %L, %L, 660, 'admin')$q$) $$, (select id from b1), (select b from st), pg_temp.day(4)), 'Vadim moves it');
select is((select count(*)::integer from public.gift_voucher_history where voucher_id = (select id from v1) and kind = 'moved'), 1, 'History: moved');

-- Cancelled in good time by Vadim: the voucher comes back and Income no longer counts it.
select lives_ok(format($$ select pg_temp.adm($q$public.admin_cancel_booking(%L, gen_random_uuid(), %L, %L, 'test', 'admin', null)$q$) $$,
  (select id from b1), pg_temp.stamp((select id from b1)), pg_temp.pstamp((select id from b1))), 'Vadim cancels');
select is((select status from public.gift_vouchers where id = (select id from v1)), 'ready', 'voucher back');
select is((select count(*)::integer from public.gift_voucher_history where voucher_id = (select id from v1) and kind = 'back'), 1, 'History: back after a cancel');
select is((select count(*)::integer from public.gift_voucher_history where voucher_id = (select id from v1) and kind in ('used_up', 'extended')), 0, 'not used up, not "more time"');
select is((select count(*)::integer from public.income_lines(pg_temp.day(-400), pg_temp.day(400)) where gift_voucher_id = (select id from v1)), 0, 'Income: not counted');

-- 3. Marked used without a booking: counted today; "not used after all" takes it off and says so.
select lives_ok(format($$ select pg_temp.adm($q$public.admin_mark_gift_used(%L, true)$q$) $$, (select id from v1)), 'marked used');
select is((select booking_status from public.income_lines(pg_temp.day(0), pg_temp.day(0)) where gift_voucher_id = (select id from v1)), 'gift_used', 'Income: counted today');
select lives_ok(format($$ select pg_temp.adm($q$public.admin_mark_gift_used(%L, false)$q$) $$, (select id from v1)), 'not used after all');
select is((select count(*)::integer from public.income_lines(pg_temp.day(-400), pg_temp.day(400)) where gift_voucher_id = (select id from v1)), 0, 'Income: off again');
select is((select count(*)::integer from public.gift_voucher_history where voucher_id = (select id from v1) and kind in ('marked_used', 'not_used')), 2, 'History: marked used, not used after all');
select is((select count(*)::integer from public.event_outbox where aggregate_id = (select id from v1) and event_type in ('gift.marked_used', 'gift.not_used')), 2, 'both in Alerts');

-- 4. More time and Change details are recorded.
select lives_ok(format($$ select pg_temp.adm($q$public.admin_extend_gift_voucher(%L, %L)$q$) $$, (select id from v1), pg_temp.day(500)), 'more time');
select ok((select words like 'More time: % → %' from public.gift_voucher_history where voucher_id = (select id from v1) and kind = 'extended'), 'History: more time, old → new');
select lives_ok(format($$ select pg_temp.adm($q$public.admin_update_gift_voucher(%L, 'Mother', 'Anna', null)$q$) $$, (select id from v1)), 'name changed');
select ok((select words like '%for: Mum → Mother%' from public.gift_voucher_history where voucher_id = (select id from v1) and kind = 'changed'), 'History: what changed');

-- 5. Ended unused: counted on its last day.
update public.gift_vouchers set expires_at = public.gift_end_of_day(clock_timestamp() - interval '2 days') where id = (select id from v1);
select is((select (date, booking_status) from public.income_lines(pg_temp.day(-10), pg_temp.day(0)) where gift_voucher_id = (select id from v1)), (pg_temp.day(-2), 'gift_ended'::text), 'Income: ended unused on its last day');

-- 6. Refunded by Vadim (part of it): recorded, emailed, receipt stamped; the part kept counts on the day of the refund.
create temp table v2 as select pg_temp.voucher('none', 'rec2@rec.example.test') as id;
select throws_ok(format($$ select pg_temp.adm($q$public.admin_gift_refunded(%L, 95)$q$) $$, (select id from v2)), '22023', null, 'not more than was paid');
select lives_ok(format($$ select pg_temp.adm($q$public.admin_gift_refunded(%L, 50)$q$) $$, (select id from v2)), 'refunded £50');
select is((select (status, refund_gbp) from public.gift_vouchers where id = (select id from v2)), ('cancelled'::text, 50.00::numeric), 'cancelled with £50 refunded');
select is(pg_temp.adm(format('public.admin_gift_receipt(%L)', (select id from v2)))#>>'{standing,status}', 'refunded', 'receipt stands as refunded');
select is((select words from public.gift_voucher_history where voucher_id = (select id from v2) and kind = 'refunded'), 'Refund sent: £50.00 (£40.00 kept)', 'History: refund sent £50, £40 kept');
select ok((select d.body like '%£50%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.aggregate_id = (select id from v2) and e.event_type = 'gift.refund_sent' and d.audience = 'client'), 'buyer emailed the amount');
select ok((pg_temp.adm($q$public.admin_income_summary('month', '$q$ || pg_temp.day(0) || $q$')$q$)#>>'{gifts,refunded_gbp}')::numeric >= 50, 'Income: refunded figure');
select is((select (booking_status, net_gbp) from public.income_lines(pg_temp.day(-400), pg_temp.day(400)) where gift_voucher_id = (select id from v2)), ('gift_kept'::text, 40.00::numeric), 'Income: only the £40 kept counts');

-- 7. Money arrived after the buyer cancelled before paying: it becomes a refund to send.
create temp table v3 as select (public.buy_gift_voucher(60, 1, 'none', null, 'gold_foil', 'Dad', 'Ben', null, 'self', null, null, 'Ben Buyer', 'rec3@rec.example.test', null, p_terms := true)->>'token')::uuid as token;
select public.gift_buyer_cancel((select token from v3));
select lives_ok(format($$ select pg_temp.adm($q$public.admin_gift_money_arrived(%L)$q$) $$, (select id from public.gift_vouchers where buyer_token = (select token from v3))), 'money arrived after all');
select is((select (v->>'refund_to_send')::boolean from jsonb_array_elements(pg_temp.adm('public.admin_gift_vouchers()')) v
  where v->>'payment_reference' = (select payment_reference from public.gift_vouchers where buyer_token = (select token from v3))), true, 'in Refunds to send');
select ok((select not (v ? 'buyer_token') from jsonb_array_elements(pg_temp.adm('public.admin_gift_vouchers()')) v limit 1), 'the buyer''s key is never in the list');

-- 8. Old cancelled vouchers stay in the list, with their History.
update public.gift_vouchers set updated_at = clock_timestamp() - interval '90 days' where buyer_token = (select token from v3);
select ok((select jsonb_array_length(v->'history') >= 2 from jsonb_array_elements(pg_temp.adm('public.admin_gift_vouchers()')) v
  where v->>'payment_reference' = (select payment_reference from public.gift_vouchers where buyer_token = (select token from v3))), 'a cancelled voucher stays, with its History');

-- 10. Fixes from the fresh audit.
-- Edit booking on a voucher booking made cheaper than the voucher (90 → 60 minutes) still works, and its receipt adds up.
create temp table tk as select (public.buy_gift_voucher(90, 1, 'none', null, 'gold_foil', 'Mum', 'Anna', null, 'self', null, null, 'Anna Buyer', 'rec5@rec.example.test', null, p_terms := true)->>'token')::uuid as t;
create temp table v5 as select id, code from public.gift_vouchers where buyer_token = (select t from tk);
grant select on v5 to authenticated;
select lives_ok(format($$ select pg_temp.adm($q$public.admin_mark_gift_paid(%L)$q$) $$, (select id from v5)), '90-minute voucher paid');
select pg_temp.as_user('00000000-0000-0000-0000-00000000f702');
create temp table b5 as select * from pg_temp.book((select code from v5), '00000000-0000-4000-8000-00000000f732', pg_temp.sessions(90), 5, 600, 'b5');
reset role;
set constraints all immediate;
set constraints all deferred;
select lives_ok(format($$ select pg_temp.adm($q$public.admin_edit_booking(%L, gen_random_uuid(), %L, %L::jsonb)$q$) $$, (select id from b5), pg_temp.stamp((select id from b5)),
   (select jsonb_agg(jsonb_build_object('id', s.id, 'service_id', s.service_id, 'duration_minutes', 60)) from public.booking_sessions s where s.booking_id = (select id from b5))), 'Edit booking down to 60 minutes works');
set constraints all immediate;
set constraints all deferred;
select ok(public.receipt_message((select snapshot from public.booking_receipts where booking_id = (select id from b5))) like '%Total: £90.00%Paid with gift voucher (ending ____): £90.00%Paid by you: £0.00%', 'its receipt adds up: £90, all by the voucher');
select ok(public.receipt_message((select snapshot from public.booking_receipts where booking_id = (select id from b5))) not like '%Paid by bank transfer%', 'no "Paid by bank transfer" when the voucher paid it all');

-- Extra time (cash) on a voucher session with a top-up refreshes the receipt.
create temp table v6 as select pg_temp.voucher('none', 'rec6@rec.example.test') as id;
alter table v6 add column code text;
update v6 set code = (select code from public.gift_vouchers g where g.id = v6.id);
grant select on v6 to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000f702');
create temp table b6 as select * from pg_temp.book((select code from v6), '00000000-0000-4000-8000-00000000f732', pg_temp.sessions(90), 6, 600, 'b6');
reset role;
update public.booking_payments set status = 'paid', paid_at = clock_timestamp() where booking_id = (select id from b6);
update public.bookings set booking_status = 'confirmed' where id = (select id from b6);
set constraints all immediate;
set constraints all deferred;
update public.bookings set date = pg_temp.day(-1) where id = (select id from b6);
select lives_ok(format($$ select pg_temp.adm($q$public.admin_extend_booking(%L, gen_random_uuid(), %L, %L, 30, 40, 'cash', false)$q$) $$,
  (select id from b6), pg_temp.stamp((select id from b6)), (select id from public.booking_sessions where booking_id = (select id from b6) limit 1)), 'extra time, cash');
set constraints all immediate;
set constraints all deferred;
select is((select (snapshot->>'total')::numeric from public.booking_receipts where booking_id = (select id from b6)), 165.00, 'receipt total includes the extra time');

-- "Not used after all" is refused while the booking is still on.
select throws_ok(format($$ select pg_temp.adm($q$public.admin_mark_gift_used(%L, false)$q$) $$, (select id from v6)), 'PT409', null, 'not while its booking is on');

-- A voucher Vadim made: the buyer can't cancel or refund it from their page.
create temp table v7 as select (pg_temp.adm($q$public.admin_make_gift_voucher(60, 1, 'none', null, 'gold_foil', 'Friend', 'Vadim', null, 'Kind Client', 'kind@rec.example.test', 'cash', 0)$q$)->>'id')::uuid as id;
select is((public.get_my_gift_purchase((select buyer_token from public.gift_vouchers where id = (select id from v7))))->>'can_refund', 'false', 'no refund button on a voucher Vadim made');
select throws_ok(format($$ select public.gift_buyer_cancel(%L) $$, (select buyer_token from public.gift_vouchers where id = (select id from v7))), 'PT409', null, 'and the buyer can''t cancel it');

-- £0 back on a paid voucher: cancelled (not "refund due"), its £90 counted as kept.
create temp table v8 as select pg_temp.voucher('none', 'rec8@rec.example.test') as id;
select lives_ok(format($$ select pg_temp.adm($q$public.admin_gift_refunded(%L, 0)$q$) $$, (select id from v8)), 'cancelled, nothing sent back');
select is(pg_temp.adm(format('public.admin_gift_receipt(%L)', (select id from v8)))#>>'{standing,status}', 'cancelled', 'receipt stands as cancelled');
select is((select words from public.gift_voucher_history where voucher_id = (select id from v8) and kind = 'refunded'), 'Cancelled by you, nothing sent back', 'History says so');
select is((select net_gbp from public.income_lines(pg_temp.day(-1), pg_temp.day(1)) where gift_voucher_id = (select id from v8)), 90.00, 'the £90 kept counts');

-- The old Cancel on a paid voucher (app not yet updated) records a full refund.
create temp table v9 as select pg_temp.voucher('none', 'rec9@rec.example.test') as id;
select lives_ok(format($$ select pg_temp.adm($q$public.admin_cancel_gift_voucher(%L)$q$) $$, (select id from v9)), 'old cancel on a paid voucher');
select is((select (status, refund_gbp, refunded_at is not null) from public.gift_vouchers where id = (select id from v9)), ('cancelled'::text, 90.00::numeric, true), 'recorded as a full refund');

-- Income: a voucher session later this month is in the total once, with no extra "to come" figure.
select ok(not (pg_temp.adm($q$public.admin_income_summary('month', '$q$ || pg_temp.day(0) || $q$')$q$)->'gifts' ? 'to_come_gbp'), 'no separate voucher "to come"');

-- 9. The booking page button and its switch.
select is(public.get_gift_banner(), true, 'button shown by default');
select lives_ok($$ select pg_temp.adm('public.admin_set_gift_banner(false)') $$, 'hidden');
select is(public.get_gift_banner(), false, 'button hidden');
create function pg_temp.banner_as_anon() returns boolean language plpgsql as $f$ declare r boolean; begin set local role anon; r := public.admin_set_gift_banner(true); reset role; return r; end; $f$;
grant execute on function pg_temp.banner_as_anon() to anon;
select throws_ok($$ select pg_temp.banner_as_anon() $$, '42501', null, 'only Vadim can switch it');

select * from finish();
rollback;
