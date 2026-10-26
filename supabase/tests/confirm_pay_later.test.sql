begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(23);

-- Fixtures: an Admin, a client user, a client with an email and a linked Telegram chat, and a working day per booking.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000e001', 'authenticated', 'authenticated', 'paylater-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e002', 'authenticated', 'authenticated', 'paylater-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e001');
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000e101', 'Sarah', 'Later', 'paylater-client@example.test');
insert into public.client_telegram_links(client_id, chat_id) values ('00000000-0000-4000-8000-00000000e101', 555000111);
delete from public.business_settings where key = 'bank_details';
insert into public.business_settings(key, value) values ('bank_details',
  jsonb_build_object('account_name', 'Vad Massage', 'sort_code', '040004', 'account_number', '12345678', 'bank_name', 'WISE'));

create function pg_temp.london_day(p_offset integer) returns date language sql as $$
  select ((now() at time zone 'Europe/London')::date + p_offset);
$$;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
select pg_temp.london_day(d), true, 600, 1200, 'flexible' from unnest(array[20, 21, 22, 23]) d
on conflict do nothing;

create function pg_temp.new_booking(p_id uuid, p_status text, p_day integer, p_method text, p_payment_status text)
returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
  select p_id, 'LATER-' || right(p_id::text, 4), '00000000-0000-4000-8000-00000000e101', id, pg_temp.london_day(p_day), 600, 60, p_status,
    'test', '1 Test Road', 'London', 'SW1A 1AA', name, 90, 90, 'paylater-client@example.test'
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, payment_reference, paid_at)
    values (p_id, p_method, p_payment_status, 90, 'LATER-' || right(p_id::text, 4), case when p_payment_status = 'paid' then now() end);
end;
$$;
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f001', 'awaiting_transfer', 20, 'bank_transfer', 'awaiting_transfer');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f002', 'awaiting_payment_verification', 21, 'bank_transfer', 'awaiting_verification');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f003', 'awaiting_cash_approval', 22, 'cash', 'awaiting_approval');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000f004', 'confirmed', 23, 'bank_transfer', 'paid');

create temp table versions as
  select b.id, b.updated_at as booking_version, p.updated_at as payment_version
  from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id::text like '00000000-0000-4000-8000-00000000f00%';
create temp table keys as select gen_random_uuid() as k1, gen_random_uuid() as k2, gen_random_uuid() as k3, gen_random_uuid() as k4;
grant select on versions, keys to authenticated;
create function pg_temp.v(p_id uuid, p_which text) returns timestamptz language sql as $$
  select case when p_which = 'b' then booking_version else payment_version end from versions where id = p_id;
$$;
grant execute on function pg_temp.v(uuid, text) to authenticated;

-- Command surface.
select has_function('public', 'admin_confirm_pay_later', array['uuid', 'uuid', 'timestamp with time zone', 'timestamp with time zone']);
select ok(not has_function_privilege('anon', 'public.admin_confirm_pay_later(uuid,uuid,timestamptz,timestamptz)', 'EXECUTE'), 'Anonymous callers cannot confirm');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'admin_confirm_pay_later'), 'The command is a definer with an empty fixed search path');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e002","role":"authenticated"}', true);
select throws_ok($$select public.admin_confirm_pay_later('00000000-0000-4000-8000-00000000f001', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000f001', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000f001', 'p'))$$,
  '42501', 'Admin authorization required', 'A client cannot confirm a booking');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
-- An undeclared transfer: confirmed, the payment stays awaited; the same request again is safe.
select is(public.admin_confirm_pay_later('00000000-0000-4000-8000-00000000f001', (select k1 from keys), pg_temp.v('00000000-0000-4000-8000-00000000f001', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000f001', 'p')),
  '00000000-0000-4000-8000-00000000f001'::uuid, 'Admin confirms an undeclared transfer booking, pay later');
select is(public.admin_confirm_pay_later('00000000-0000-4000-8000-00000000f001', (select k1 from keys), pg_temp.v('00000000-0000-4000-8000-00000000f001', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000f001', 'p')),
  '00000000-0000-4000-8000-00000000f001'::uuid, 'Retrying the same request is safe');
-- With no bank details saved, the next email says to ask instead.
reset role;
delete from public.business_settings where key = 'bank_details';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
-- A transfer the client says they sent: confirmed, still to be checked.
select is(public.admin_confirm_pay_later('00000000-0000-4000-8000-00000000f002', (select k2 from keys), pg_temp.v('00000000-0000-4000-8000-00000000f002', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000f002', 'p')),
  '00000000-0000-4000-8000-00000000f002'::uuid, 'Admin confirms a declared transfer booking, pay later');
-- Cash requests and paid bookings are not for this command.
select throws_ok($$select public.admin_confirm_pay_later('00000000-0000-4000-8000-00000000f003', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000f003', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000f003', 'p'))$$,
  'PT409', 'Booking state changed', 'A cash request is approved, not confirmed pay later');
select throws_ok($$select public.admin_confirm_pay_later('00000000-0000-4000-8000-00000000f004', gen_random_uuid(), pg_temp.v('00000000-0000-4000-8000-00000000f004', 'b'), pg_temp.v('00000000-0000-4000-8000-00000000f004', 'p'))$$,
  'PT409', 'Booking state changed', 'A booking already confirmed and paid is left alone');
select ok(not exists (select 1 from public.admin_payment_review_queue(0) q where q.id in ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f002')),
  'Confirmed bookings leave the payment review queue');
reset role;

select results_eq($$select b.booking_status, p.status, p.paid_at is null from public.bookings b join public.booking_payments p on p.booking_id = b.id
  where b.id in ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f002') order by b.date$$,
  $$values ('confirmed'::text, 'awaiting_transfer'::text, true), ('confirmed', 'awaiting_verification', true)$$,
  'Both bookings are confirmed and their payments stay open');
select is((select count(*)::integer from public.command_requests where command_type = 'admin_confirm_pay_later'), 2, 'One command record per request, retries included');
select is((select count(*)::integer from public.event_outbox where event_type = 'booking.confirmed_payment_due'
  and aggregate_id in ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f002')), 2, 'One event per booking');
-- The client's email: confirmed, what is still to pay, the reference and the bank details.
select is((select title from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000f001' and e.event_type = 'booking.confirmed_payment_due' and d.channel = 'email'),
  'Your appointment is confirmed', 'The client is emailed that the appointment is confirmed');
select ok((select body like '%Your appointment is confirmed for%' and body like '%Payment of £90.00 is still due.%' and body like '%using the reference LATER-f001.%'
    and body like '%Sort code: 040004%' and body like '%Account number: 12345678%'
  from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000f001' and e.event_type = 'booking.confirmed_payment_due' and d.channel = 'email'),
  'The email says what is still to pay, with the reference and the bank details');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000f001' and e.event_type = 'booking.confirmed_payment_due' and d.audience = 'admin'), 0,
  'The Admin is not notified about their own action');
-- The same message on Telegram for a client who linked it.
select ok((select body like '%Payment of £90.00 is still due.%' and body like '%To change or cancel%' and body not like '%{link}%'
  from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000f001' and e.event_type = 'booking.confirmed_payment_due' and d.channel = 'telegram_client' and d.recipient = '555000111'),
  'The client gets the same message on Telegram');
select ok((select body like '%If you need the bank details, just ask me.%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000f002' and e.event_type = 'booking.confirmed_payment_due' and d.channel = 'email'),
  'With no bank details saved, the email says to ask');

-- Mark paid, later, for both kinds.
create temp table now_versions as
  select b.id, b.updated_at as booking_version, p.updated_at as payment_version
  from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id::text like '00000000-0000-4000-8000-00000000f00%';
grant select on now_versions to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select is(public.admin_record_bank_transfer_received('00000000-0000-4000-8000-00000000f001', (select k3 from keys),
  (select booking_version from now_versions where id = '00000000-0000-4000-8000-00000000f001'), (select payment_version from now_versions where id = '00000000-0000-4000-8000-00000000f001')),
  '00000000-0000-4000-8000-00000000f001'::uuid, 'Mark paid on a confirmed booking whose transfer was awaited');
select is(public.admin_record_bank_transfer_received('00000000-0000-4000-8000-00000000f002', (select k4 from keys),
  (select booking_version from now_versions where id = '00000000-0000-4000-8000-00000000f002'), (select payment_version from now_versions where id = '00000000-0000-4000-8000-00000000f002')),
  '00000000-0000-4000-8000-00000000f002'::uuid, 'Mark paid on a confirmed booking whose transfer was to be checked');
reset role;
select results_eq($$select b.booking_status, p.status, p.paid_at is not null, p.verified_by from public.bookings b join public.booking_payments p on p.booking_id = b.id
  where b.id in ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f002') order by b.date$$,
  $$values ('confirmed'::text, 'paid'::text, true, '00000000-0000-0000-0000-00000000e001'::uuid), ('confirmed', 'paid', true, '00000000-0000-0000-0000-00000000e001'::uuid)$$,
  'Both payments are recorded as paid, by the Admin');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.event_type = 'booking.bank_transfer_received' and e.aggregate_id in ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f002') and d.audience = 'client'), 0,
  'Marking paid sends the client nothing new');
-- The audit trail shows the booking confirmed first, then the payment.
select results_eq($$select entity, to_status from public.booking_status_events where booking_id = '00000000-0000-4000-8000-00000000f001' and actor_type = 'admin' order by occurred_at, entity$$,
  $$values ('booking'::text, 'confirmed'::text), ('payment', 'paid')$$, 'Audit records the booking confirmed, then paid');

select * from finish();
rollback;
