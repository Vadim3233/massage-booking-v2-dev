begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- The buyer cancels before paying, or asks for a refund within 14 days of buying; Vadim records the refund as sent.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000e501', 'authenticated', 'authenticated', 'refund-admin@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e501');

create function pg_temp.as_admin() returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e501', 'role', 'authenticated')::text, true);
$$;
-- Buy a voucher as a visitor would; returns its private page token.
create function pg_temp.buy(p_buyer text) returns uuid language plpgsql as $$
begin
  return (public.buy_gift_voucher(60, 1, 'none', null, 'gold_foil', 'Mum', 'Anna', null, 'self', null, null, 'Anna Buyer', p_buyer, null, p_terms := true)->>'token')::uuid;
end; $$;
create function pg_temp.v(p_token uuid) returns public.gift_vouchers language sql as $$ select * from public.gift_vouchers where buyer_token = p_token; $$;
create function pg_temp.mark_paid(p_token uuid) returns void language plpgsql as $$
begin
  perform pg_temp.as_admin();
  perform public.admin_mark_gift_paid((pg_temp.v(p_token)).id);
  reset role;
end; $$;
create function pg_temp.cancel_as_anon(p_token uuid) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role anon;
  r := public.gift_buyer_cancel(p_token);
  reset role;
  return r;
end; $$;
grant execute on function pg_temp.cancel_as_anon(uuid) to anon;
create temp table t(name text primary key, token uuid);
grant all on t to anon, authenticated;

-- 1. Unpaid, transfer not declared: cancelled at once, nothing owed, Vadim told quietly.
insert into t values ('unpaid', pg_temp.buy('refund-a@example.test'));
select is((pg_temp.cancel_as_anon((select token from t where name = 'unpaid')))->>'status', 'cancelled', 'unpaid gift: the buyer can cancel it (as a visitor)');
select is((pg_temp.v((select token from t where name = 'unpaid'))).refund_requested_at, null, 'unpaid gift: no refund owed');
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'gift.buyer_cancelled' and e.aggregate_id = (pg_temp.v((select token from t where name = 'unpaid'))).id), 1, 'unpaid gift: Vadim is told');

-- 2. Transfer declared but not yet marked paid: cancelled and a refund is owed in case the money arrives.
insert into t values ('declared', pg_temp.buy('refund-b@example.test'));
select public.gift_transfer_made((select token from t where name = 'declared'));
select is((pg_temp.cancel_as_anon((select token from t where name = 'declared')))->>'refund_requested', 'true', 'declared transfer: a refund is owed');
select ok((select d.body like '%if the money arrives, send it back%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'gift.refund_requested' and e.aggregate_id = (pg_temp.v((select token from t where name = 'declared'))).id and d.audience = 'admin' and d.channel = 'telegram'),
  'declared transfer: Vadim is told to send it back if it arrives');

-- 3. Paid, unused, within 14 days: the buyer's page offers it, the code stops working, Vadim and the buyer are told.
insert into t values ('paid', pg_temp.buy('refund-c@example.test'));
select pg_temp.mark_paid((select token from t where name = 'paid'));
select is((public.get_my_gift_purchase((select token from t where name = 'paid')))->>'can_refund', 'true', 'paid gift: the page offers a refund');
create temp table code_before as select (pg_temp.v((select token from t where name = 'paid'))).code as code;
select is((pg_temp.cancel_as_anon((select token from t where name = 'paid')))->>'status', 'cancelled', 'paid gift: refund asked, voucher cancelled');
select is(public.get_gift_voucher((select code from code_before)), null, 'paid gift: the code no longer opens a voucher');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'gift.refund_requested' and e.aggregate_id = (pg_temp.v((select token from t where name = 'paid'))).id and d.audience = 'client' and d.recipient = 'refund-c@example.test'),
  1, 'paid gift: the buyer gets a confirmation email');
select is((pg_temp.cancel_as_anon((select token from t where name = 'paid')))->>'status', 'cancelled', 'asking twice is harmless');
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'gift.refund_requested' and e.aggregate_id = (pg_temp.v((select token from t where name = 'paid'))).id), 1, 'asking twice alerts once');

-- 4. Vadim sees it in More › Gift vouchers, first, and records the refund as sent.
select pg_temp.as_admin();
select is((select bool_and((x->>'refund_to_send')::boolean) from (select x from jsonb_array_elements(public.admin_gift_vouchers()) x limit 2) l), true, 'refunds to send are listed first');
select is((select (x->>'refund_to_send')::boolean from jsonb_array_elements(public.admin_gift_vouchers()) x where (x->>'id')::uuid = (pg_temp.v((select token from t where name = 'paid'))).id), true, 'marked Refund to send');
select ok((public.admin_gift_refund_sent((pg_temp.v((select token from t where name = 'paid'))).id)).refunded_at is not null, 'Refund sent is recorded');
select throws_ok(format('select public.admin_gift_refund_sent(%L)', (pg_temp.v((select token from t where name = 'paid'))).id), 'PT409', null, 'Refund sent only once');
reset role;
select is((public.get_my_gift_purchase((select token from t where name = 'paid')))->>'refunded', 'true', 'the buyer page shows the refund was sent');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'gift.refund_sent' and d.recipient = 'refund-c@example.test'), 1, 'the buyer is emailed when the refund is sent');

-- The declared transfer never arrived: Vadim clears it without emailing the buyer.
select pg_temp.as_admin();
select ok((public.admin_gift_refund_sent((pg_temp.v((select token from t where name = 'declared'))).id, false)).refunded_at is not null, 'money never came: cleared');
reset role;
select is((select count(*)::integer from public.event_outbox e where e.event_type = 'gift.refund_sent' and e.aggregate_id = (pg_temp.v((select token from t where name = 'declared'))).id), 0, 'money never came: no email');

-- 5. Past 14 days, or used: no refund from the page.
insert into t values ('late', pg_temp.buy('refund-d@example.test'));
select pg_temp.mark_paid((select token from t where name = 'late'));
update public.gift_vouchers set created_at = clock_timestamp() - interval '15 days' where buyer_token = (select token from t where name = 'late');
select is((public.get_my_gift_purchase((select token from t where name = 'late')))->>'can_refund', 'false', 'after 14 days the page does not offer a refund');
select throws_ok(format('select public.gift_buyer_cancel(%L)', (select token from t where name = 'late')), 'PT409', null, 'after 14 days a refund is refused');
insert into t values ('used', pg_temp.buy('refund-e@example.test'));
select pg_temp.mark_paid((select token from t where name = 'used'));
select pg_temp.as_admin();
select public.admin_mark_gift_used((pg_temp.v((select token from t where name = 'used'))).id, true);
reset role;
select throws_ok(format('select public.gift_buyer_cancel(%L)', (select token from t where name = 'used')), 'PT409', null, 'a used voucher cannot be refunded');
select throws_ok(format('select public.gift_buyer_cancel(%L)', gen_random_uuid()), 'PT404', null, 'an unknown link is refused');

-- 6. Only the Admin records refunds.
set local role anon;
select throws_ok(format('select public.admin_gift_refund_sent(%L)', gen_random_uuid()), '42501', null, 'visitors cannot record refunds');
reset role;

select * from finish();
rollback;
