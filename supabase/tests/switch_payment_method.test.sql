begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(23);

-- Fixtures: an Admin, a client user, and one booking per case.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000d501', 'authenticated', 'authenticated', 'switch-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000d502', 'authenticated', 'authenticated', 'switch-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d501');
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000d601', 'Sam', 'Switch', 'switch-client@example.test');

create function pg_temp.london_day(p_offset integer) returns date language sql as $$
  select ((now() at time zone 'Europe/London')::date + p_offset);
$$;
create function pg_temp.new_booking(p_id uuid, p_status text, p_day integer, p_method text, p_payment_status text, p_reference text)
returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'SWITCH-' || right(p_id::text, 4), '00000000-0000-4000-8000-00000000d601', id, pg_temp.london_day(p_day), 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 90, 90, 'switch-client@example.test'
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, payment_reference, paid_at, transfer_declared_at)
    values (p_id, p_method, p_payment_status, 90, p_reference, case when p_payment_status = 'paid' then now() end,
      case when p_payment_status = 'awaiting_verification' then now() end);
end;
$$;
-- d701: confirmed, the client said the transfer was sent (Sabri's case before it was marked paid).
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d701', 'confirmed', -3, 'bank_transfer', 'awaiting_verification', 'SWITCH-d701');
-- d702: confirmed and paid by "bank transfer" with a receipt, really paid in cash.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d702', 'confirmed', -2, 'bank_transfer', 'paid', 'SWITCH-d702');
insert into public.booking_receipts(booking_id, receipt_number, snapshot)
  values ('00000000-0000-4000-8000-00000000d702', 'VAD-TEST-0001', '{"number":"VAD-TEST-0001","payment":{"amount":90,"method":"bank_transfer"}}');
-- d703: confirmed, cash agreed, made without a payment reference.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d703', 'confirmed', 5, 'cash', 'approved', null);
-- d704: still waiting for a transfer, not confirmed: not for this command.
select pg_temp.new_booking('00000000-0000-4000-8000-00000000d704', 'awaiting_transfer', 6, 'bank_transfer', 'awaiting_transfer', 'SWITCH-d704');

create function pg_temp.v(p_id uuid, p_which text) returns timestamptz language sql security definer as $$
  select case when p_which = 'b' then (select updated_at from public.bookings where id = p_id) else (select updated_at from public.booking_payments where booking_id = p_id) end;
$$;
grant execute on function pg_temp.v(uuid, text) to authenticated;
create temp table keys as select gen_random_uuid() as k1;
create temp table first_versions as select pg_temp.v('00000000-0000-4000-8000-00000000d701', 'b') as b, pg_temp.v('00000000-0000-4000-8000-00000000d701', 'p') as p;
grant select on keys, first_versions to authenticated;

-- Command surface.
select has_function('public', 'admin_switch_payment_method', array['uuid', 'uuid', 'timestamp with time zone', 'timestamp with time zone', 'text']);
select ok(not has_function_privilege('anon', 'public.admin_switch_payment_method(uuid,uuid,timestamptz,timestamptz,text)', 'EXECUTE'), 'Anonymous callers cannot switch');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'admin_switch_payment_method'), 'The command is a definer with an empty fixed search path');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d502","role":"authenticated"}', true);
select throws_ok($$select public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d701', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000d701', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000d701', 'p'), 'cash')$$,
  '42501', 'Admin authorization required', 'A client cannot switch how a booking is paid');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d501","role":"authenticated"}', true);
-- Unpaid bank transfer to cash: cash is agreed for the appointment; the same request again is safe.
select is(public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d701', (select k1 from keys), (select b from first_versions), (select p from first_versions), 'cash'),
  '00000000-0000-4000-8000-00000000d701'::uuid, 'An unpaid bank transfer becomes cash');
select is(public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d701', (select k1 from keys), (select b from first_versions), (select p from first_versions), 'cash'),
  '00000000-0000-4000-8000-00000000d701'::uuid, 'Retrying the same request is safe');
reset role;
select results_eq($$select method, status, transfer_declared_at is null, paid_at is null from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000d701'$$,
  $$values ('cash'::text, 'approved'::text, true, true)$$, 'It is now cash agreed for the appointment, not yet received');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d501","role":"authenticated"}', true);
-- A new request to switch to the method it already has is refused.
select throws_ok($$select public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d701', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000d701', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000d701', 'p'), 'cash')$$,
  'PT409', 'Booking state changed', 'Switching to the method it already has is refused');
-- And back again: cash agreed becomes a bank transfer still to come.
select is(public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d701', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000d701', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000d701', 'p'), 'bank_transfer'),
  '00000000-0000-4000-8000-00000000d701'::uuid, 'Cash agreed becomes a bank transfer');
reset role;
select results_eq($$select method, status from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000d701'$$,
  $$values ('bank_transfer'::text, 'awaiting_transfer'::text)$$, 'It is now a bank transfer still to come');

-- Paid by "bank transfer", really cash: it stays paid and the receipt says cash, keeping what it said before.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d501","role":"authenticated"}', true);
select is(public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d702', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000d702', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000d702', 'p'), 'cash'),
  '00000000-0000-4000-8000-00000000d702'::uuid, 'A paid bank transfer becomes paid in cash');
reset role;
select results_eq($$select method, status, paid_at is not null from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000d702'$$,
  $$values ('cash'::text, 'paid'::text, true)$$, 'It stays paid, by cash');
select is((select snapshot->'payment'->>'method' from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d702'), 'cash', 'The receipt now says cash');
select is((select edit_count from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d702'), 1, 'The receipt counts the change as an edit');
select is((select r.snapshot->'payment'->>'method' from public.booking_receipt_revisions r join public.booking_receipts x on x.id = r.receipt_id
  where x.booking_id = '00000000-0000-4000-8000-00000000d702' and r.revision = 1), 'bank_transfer', 'What the receipt said before is kept');

-- Cash agreed, no reference: becoming a bank transfer gives it the booking reference to quote.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d501","role":"authenticated"}', true);
select is(public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d703', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000d703', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000d703', 'p'), 'bank_transfer'),
  '00000000-0000-4000-8000-00000000d703'::uuid, 'Cash agreed becomes a bank transfer');
-- A booking not yet confirmed, a stale version and an unknown method are refused.
select throws_ok($$select public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d704', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000d704', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000d704', 'p'), 'cash')$$,
  'PT409', 'Booking state changed', 'A booking not yet confirmed is decided in payment review instead');
select throws_ok($$select public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d702', gen_random_uuid(), now() - interval '1 day', pg_temp.v('00000000-0000-4000-8000-00000000d702', 'p'), 'bank_transfer')$$,
  'PT409', 'Booking state changed', 'A stale booking version is refused');
select throws_ok($$select public.admin_switch_payment_method('00000000-0000-4000-8000-00000000d702', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000d702', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000d702', 'p'), 'card')$$,
  '22023', 'Missing command arguments', 'Only cash and bank transfer are methods');
reset role;
select is((select payment_reference from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000d703'), 'SWITCH-d703', 'The booking reference becomes the payment reference');

-- Records: one command per request (the retry included), one event per change, and the payment status moves audited.
select is((select count(*)::integer from public.command_requests where command_type = 'admin_switch_payment_method'), 4, 'One command record per request, retries included');
select is((select count(*)::integer from public.event_outbox where event_type = 'booking.payment_method_changed'), 4, 'One event per change');
-- The guard still refuses the same moves without a change of method.
select throws_ok($$update public.booking_payments set status = 'approved' where booking_id = '00000000-0000-4000-8000-00000000d701'$$,
  '22023', 'Payment status change not allowed: awaiting_transfer to approved', 'Without a change of method, the guard is as before');

select * from finish();
rollback;
