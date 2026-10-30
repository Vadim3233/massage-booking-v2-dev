begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(30);

-- Receipts for insurance claims: credentials on every receipt, VAD- numbers, a receipt made by itself when a payment is received,
-- what a receipt now stands for, and a client fetching their own. Everything here is rolled back at the end.

insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d101', 'authenticated', 'authenticated', 'pdf-admin@example.test', '', now(), '{}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d102', 'authenticated', 'authenticated', 'pdf-client@example.test', '', now(), '{}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d103', 'authenticated', 'authenticated', 'pdf-other@example.test', '', now(), '{}', '{}', now(), now(), false);
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000d101');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000d201', '00000000-0000-0000-0000-00000000d102', 'Musa', 'Akram', 'musa.pdf@example.test', '07911 555101'),
  ('00000000-0000-4000-8000-00000000d202', '00000000-0000-0000-0000-00000000d103', 'Other', 'Person', 'other.pdf@example.test', '07911 555102');

create function pg_temp.pbooking(p_id uuid, p_status text, p_method text, p_pay text, p_total numeric, p_paid numeric) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, enhancements_total_gbp, travel_fee_gbp, congestion_fee_gbp, total_gbp)
  select p_id, 'PDF-' || right(p_id::text, 4), '00000000-0000-4000-8000-00000000d201', a.id, ((now() at time zone 'Europe/London')::date + 3), 600, 60, p_status, 'test',
    '1 Test Road', 'London', 'SW1A 1AA', a.name, p_total, 0, 0, 0, p_total
  from public.service_areas a where a.slug = 'chelsea';
  insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp, recipient_name)
  values (p_id, 1, (select id from public.services where slug = 'massage'), 60, 'Massage Therapy', p_total, 'Musa Akram');
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, p_method, p_pay, p_paid, case when p_pay = 'paid' then now() end);
end;
$$;
create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', false)::text, true);
end;
$$;
-- The automatic receipt is made at the end of a save. Inside one test transaction, this is that moment.
create function pg_temp.end_of_save() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end;
$$;
create function pg_temp.receipt_count(p_booking uuid) returns integer language sql as $$
  select count(*)::integer from public.booking_receipts where booking_id = p_booking;
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('receipt_standing', 'issue_receipt', 'auto_issue_receipt', 'client_receipt_json')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'The inside workings cannot be called from outside');
select ok(has_function_privilege('authenticated', 'public.get_my_receipt(uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.get_my_receipt(uuid)', 'EXECUTE'),
  'Only a signed-in client can ask for their own receipt');
select ok(has_function_privilege('anon', 'public.receipt_by_key(uuid, text)', 'EXECUTE'), 'Someone with the private link can ask for it without signing in');

-- ---------------------------------------------------------------------------------------------
-- Receipt details: the credentials are filled in and required
-- ---------------------------------------------------------------------------------------------
select results_eq($$select value->>'practitioner_name', value->>'practitioner_title', value->>'association', value->>'membership_number', value->>'website'
    from public.business_settings where key = 'receipt_details'$$,
  $$values ('Vadim Susarin'::text, 'Level 5 Soft Tissue Therapist'::text, 'Institute for Soft Tissue Therapists (ISRM)'::text, '9555'::text, 'vadmassage.com'::text)$$,
  'Vadim''s credentials and website are in the receipt details');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select throws_ok($$select public.admin_save_receipt_details('{"name":"VAD","website":"vadmassage.com","practitioner_name":"Vadim Susarin","association":"ISRM"}')$$,
  '22023', 'Add your full name, professional association and membership number', 'The membership number cannot be left out');
select throws_ok($$select public.admin_save_receipt_details('{"name":"VAD","website":"vadmassage.com","association":"ISRM","membership_number":"9555"}')$$,
  '22023', 'Add your full name, professional association and membership number', 'Nor can the practitioner''s name');
select lives_ok($$select public.admin_save_receipt_details((select value from public.business_settings where key = 'receipt_details'))$$,
  'A website is enough to reach the business, with the credentials saved');
reset role;
-- Details saved before this change, with no credentials yet, make no receipt.
update public.business_settings set value = value - 'membership_number' where key = 'receipt_details';
select pg_temp.pbooking('00000000-0000-4000-8000-00000000d300', 'confirmed', 'cash', 'paid', 90, 90);
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000d300')$$, 'PT409', 'Save your receipt details first', 'No receipt is made without the credentials');
reset role;
select lives_ok($$select pg_temp.end_of_save()$$, 'A payment saved without credentials in place is still saved');
select is(pg_temp.receipt_count('00000000-0000-4000-8000-00000000d300'), 0, 'It just has no receipt yet');
update public.business_settings set value = value || '{"membership_number":"9555"}' where key = 'receipt_details';
select pg_temp.end_of_save();

-- ---------------------------------------------------------------------------------------------
-- Made by itself when the payment is received, and never before
-- ---------------------------------------------------------------------------------------------
-- D1: confirmed now, paid later by bank transfer. D2: a past booking entered as paid. D3: the payment is not the total.
select pg_temp.pbooking('00000000-0000-4000-8000-00000000d301', 'awaiting_transfer', 'bank_transfer', 'awaiting_transfer', 90, 90);
select pg_temp.end_of_save();
update public.bookings set booking_status = 'confirmed' where id = '00000000-0000-4000-8000-00000000d301';
select pg_temp.end_of_save();
select is(pg_temp.receipt_count('00000000-0000-4000-8000-00000000d301'), 0, 'A booking confirmed with the payment still awaited has no receipt');
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select lives_ok($$select public.admin_record_bank_transfer_received(b.id, gen_random_uuid(), b.updated_at, p.updated_at)
    from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.id = '00000000-0000-4000-8000-00000000d301'$$, 'She marks the transfer as received');
reset role;
select pg_temp.end_of_save();
select is(pg_temp.receipt_count('00000000-0000-4000-8000-00000000d301'), 1, 'Marking it paid makes the receipt');
select matches((select receipt_number from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d301'),
  '^VAD-' || extract(year from (clock_timestamp() at time zone 'Europe/London'))::integer || '-[0-9]{4}$', 'It has a VAD- number for this year');
select is((select issued_by from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d301'), '00000000-0000-0000-0000-00000000d101'::uuid,
  'It is recorded as made by whoever marked the payment');
select results_eq($$select snapshot#>>'{business,practitioner_name}', snapshot#>>'{business,association}', snapshot#>>'{business,membership_number}',
    snapshot#>>'{treatments,0,name}', (snapshot#>>'{treatments,0,duration_minutes}')::integer, snapshot#>>'{treatments,0,recipient}', (snapshot#>>'{payment,amount}')::numeric
    from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d301'$$,
  $$values ('Vadim Susarin'::text, 'Institute for Soft Tissue Therapists (ISRM)'::text, '9555'::text, 'Massage Therapy'::text, 60, 'Musa Akram'::text, 90.00::numeric)$$,
  'It keeps the credentials, the treatment as booked, and the amount paid');
select ok((select public.receipt_message(snapshot) like E'%\nPractitioner: Vadim Susarin, Level 5 Soft Tissue Therapist\nInstitute for Soft Tissue Therapists (ISRM), membership number 9555%'
    from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d301'), 'The emailed words carry the credentials too');
select ok((select snapshot::text !~ 'Test Road|SW1A|07911' from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d301'),
  'No home address or phone number is on it');
-- Saving the payment again, or opening the receipt, never makes another one or uses another number.
create temp table d301_number as select receipt_number n from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000d301';
grant select on d301_number to authenticated, anon;
create temp table counted as select last_number from public.receipt_counters where year = extract(year from (clock_timestamp() at time zone 'Europe/London'))::integer;
update public.booking_payments set status = 'paid' where booking_id = '00000000-0000-4000-8000-00000000d301';
update public.bookings set booking_status = 'completed' where id = '00000000-0000-4000-8000-00000000d301';
select pg_temp.end_of_save();
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select is((public.admin_issue_receipt('00000000-0000-4000-8000-00000000d301')->>'number'), (select n from d301_number), 'Opening it gives the same receipt');
reset role;
select is((select last_number from public.receipt_counters where year = extract(year from (clock_timestamp() at time zone 'Europe/London'))::integer), (select last_number from counted),
  'And no number is used up');

select pg_temp.pbooking('00000000-0000-4000-8000-00000000d302', 'completed', 'cash', 'paid', 90, 90);
select pg_temp.end_of_save();
select is(pg_temp.receipt_count('00000000-0000-4000-8000-00000000d302'), 1, 'A past booking entered as paid gets its receipt straight away');
select pg_temp.pbooking('00000000-0000-4000-8000-00000000d303', 'confirmed', 'cash', 'paid', 90, 80);
select lives_ok($$select pg_temp.end_of_save()$$, 'A payment that does not match the total is still saved');
select is(pg_temp.receipt_count('00000000-0000-4000-8000-00000000d303'), 0, 'But no receipt is made for it');

-- ---------------------------------------------------------------------------------------------
-- What a receipt stands for now
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select is((public.admin_get_receipt('00000000-0000-4000-8000-00000000d302')#>>'{standing,status}'), 'paid', 'A paid receipt says paid');
reset role;
update public.booking_payments set status = 'refunded', refunded_gbp = 90, refunded_at = now() where booking_id = '00000000-0000-4000-8000-00000000d302';
select pg_temp.as_user('00000000-0000-0000-0000-00000000d101');
set local role authenticated;
select results_eq($$select r#>>'{standing,status}', (r#>>'{standing,refunded_gbp}')::numeric from (select public.admin_get_receipt('00000000-0000-4000-8000-00000000d302') r) q$$,
  $$values ('refunded'::text, 90.00::numeric)$$, 'After a refund the receipt is kept, and says it was refunded and how much');
reset role;

-- ---------------------------------------------------------------------------------------------
-- The client's own receipt
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000d102');
set local role authenticated;
select results_eq($$select r->>'number', r#>>'{snapshot,billed_to}', r#>>'{standing,status}', r ? 'email', r ? 'message' from (select public.get_my_receipt('00000000-0000-4000-8000-00000000d301') r) q$$,
  $$select n, 'Musa Akram'::text, 'paid'::text, false, false from d301_number$$,
  'A client gets the receipt for their own booking, without anything about emails');
select is(public.get_my_receipt('00000000-0000-4000-8000-00000000d303'), null, 'A booking with no receipt gives nothing');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000d103');
set local role authenticated;
select throws_ok($$select public.get_my_receipt('00000000-0000-4000-8000-00000000d301')$$, '42501', 'Booking is not available to this client', 'Nobody else can get it');
reset role;
create temp table link_key as select public.mint_booking_access_token('00000000-0000-4000-8000-00000000d301') k;
grant select on link_key to anon;
set local role anon;
select is((public.receipt_by_key('00000000-0000-4000-8000-00000000d301', (select k from link_key))->>'number'),
  (select n from d301_number), 'The private link in the email opens it');
select throws_ok($$select public.receipt_by_key('00000000-0000-4000-8000-00000000d301', repeat('0', 64))$$, '42501', 'This link is not valid or has expired. Please contact Vad.',
  'A wrong code opens nothing');
reset role;

select * from finish();
rollback;
