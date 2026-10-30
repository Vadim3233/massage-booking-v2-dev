begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(131);

-- Start from nothing, so the numbers and settings are the ones this test makes (all of this is rolled back at the end).
delete from public.booking_receipt_revisions;
delete from public.booking_receipts;
delete from public.receipt_counters;
delete from public.business_settings where key = 'receipt_details';
-- A count left over from last year: this year's numbering starts again at 1, and last year's count is left alone.
insert into public.receipt_counters(year, last_number) values (extract(year from (clock_timestamp() at time zone 'Europe/London'))::integer - 1, 7);

insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000c101', 'authenticated', 'authenticated', 'receipts-admin@example.test', '', now(), '{}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000c102', 'authenticated', 'authenticated', 'receipts-client@example.test', '', now(), '{}', '{}', now(), now(), false);
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c101');
insert into public.clients(id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000c201', 'Clara', 'Jensen', 'clara.receipt@example.test', '07911 555001'),
  ('00000000-0000-4000-8000-00000000c202', 'Noel', 'Nomail', null, '07911 555002'),
  -- A name with a character that flips the direction of text, and a line break in it.
  ('00000000-0000-4000-8000-00000000c203', 'Zoe' || chr(8238) || 'Evil', E'Park\nLane', 'zoe.receipt@example.test', '07911 555003'),
  -- A name longer than a receipt line.
  ('00000000-0000-4000-8000-00000000c204', repeat('A', 70), repeat('B', 70), 'long.receipt@example.test', '07911 555004');
insert into public.enhancements(id, slug, name, price_gbp, duration_minutes) values
  ('00000000-0000-4000-8000-00000000c901', 'receipt-test-extra', 'Aftercare advice', 10, 0);

create function pg_temp.pbooking(p_id uuid, p_client uuid, p_status text, p_method text, p_pay text, p_sub numeric, p_enh numeric, p_travel numeric, p_cong numeric,
  p_total numeric, p_paid numeric, p_email text default null) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, enhancements_total_gbp, travel_fee_gbp, congestion_fee_gbp,
    total_gbp, booking_email_snapshot, cancelled_at)
  select p_id, 'RCPT-' || p_id, p_client, a.id, ((now() at time zone 'Europe/London')::date + 5), 870, 90, p_status, 'test',
    '1 Test Road', 'London', 'SW1A 1AA', a.name, p_sub, p_enh, p_travel, p_cong, p_total, p_email, case when p_status = 'cancelled' then now() end
  from public.service_areas a where a.slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, p_method, p_pay, p_paid, case when p_pay = 'paid' then now() - interval '2 days' end);
end;
$$;
create function pg_temp.psession(p_booking uuid, p_position integer, p_name text, p_minutes integer, p_price numeric) returns void language sql as $$
  insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp, recipient_name)
  values (p_booking, p_position, (select id from public.services where slug = 'massage'), p_minutes, p_name, p_price, 'Guest');
$$;
create function pg_temp.as_user(p_user uuid, p_anonymous boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', p_anonymous)::text, true);
end;
$$;
create function pg_temp.today_plus(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p; $$;
create function pg_temp.year_now() returns integer language sql as $$ select extract(year from (clock_timestamp() at time zone 'Europe/London'))::integer; $$;

-- B1: a bank transfer, one 90 minute massage and travel (127). B2: cash, a 60 minute massage, an extra, travel and congestion (115).
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c301', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'bank_transfer', 'paid', 115, 0, 12, 0, 127, 127, 'clara.booking@example.test');
select pg_temp.psession('00000000-0000-4000-8000-00000000c301', 1, 'Massage', 90, 115);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c302', '00000000-0000-4000-8000-00000000c201', 'completed', 'cash', 'paid', 85, 10, 12, 8, 115, 115);
select pg_temp.psession('00000000-0000-4000-8000-00000000c302', 1, 'Massage', 60, 85);
insert into public.booking_enhancements(booking_id, enhancement_id, enhancement_name_snapshot, quantity, unit_price_gbp)
values ('00000000-0000-4000-8000-00000000c302', '00000000-0000-4000-8000-00000000c901', 'Aftercare advice', 1, 10);
-- B3 unpaid, B4 refunded, B5 cancelled but paid, B6 the lines disagree with the subtotals (uses the subtotals), B7 nothing adds up, B8 the payment is not the total, B9 no email at all.
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c303', '00000000-0000-4000-8000-00000000c201', 'awaiting_transfer', 'bank_transfer', 'awaiting_transfer', 85, 0, 0, 0, 85, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c304', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'bank_transfer', 'refunded', 85, 0, 0, 0, 85, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c305', '00000000-0000-4000-8000-00000000c201', 'cancelled', 'bank_transfer', 'paid', 85, 0, 0, 0, 85, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c306', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 90, 0, 0, 0, 90, 90);
select pg_temp.psession('00000000-0000-4000-8000-00000000c306', 1, 'Massage', 90, 80);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c307', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 90, 0, 0, 0, 200, 200);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c308', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 127, 0, 0, 0, 127, 100);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c309', '00000000-0000-4000-8000-00000000c202', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85);
select pg_temp.psession('00000000-0000-4000-8000-00000000c309', 1, 'Massage', 90, 85);
-- B10 to B13 each get a receipt and then change: B10 is cancelled, B11 is refunded, B12 is marked as missed, B13 is moved to another day.
-- B14 is already a missed appointment. B15 has two sessions, an extra on the second, and travel. B16 and B17 belong to the clients with the unusual names.
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c310', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85, 'clara.booking@example.test');
select pg_temp.psession('00000000-0000-4000-8000-00000000c310', 1, 'Massage', 60, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c311', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85, 'clara.booking@example.test');
select pg_temp.psession('00000000-0000-4000-8000-00000000c311', 1, 'Massage', 60, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c312', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85, 'clara.booking@example.test');
select pg_temp.psession('00000000-0000-4000-8000-00000000c312', 1, 'Massage', 60, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c313', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85, 'clara.booking@example.test');
select pg_temp.psession('00000000-0000-4000-8000-00000000c313', 1, 'Massage', 60, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c314', '00000000-0000-4000-8000-00000000c201', 'no_show', 'cash', 'paid', 85, 0, 0, 0, 85, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c315', '00000000-0000-4000-8000-00000000c201', 'completed', 'cash', 'paid', 170, 10, 12, 0, 192, 192);
select pg_temp.psession('00000000-0000-4000-8000-00000000c315', 1, 'Swedish massage', 60, 85);
select pg_temp.psession('00000000-0000-4000-8000-00000000c315', 2, 'Deep tissue massage', 60, 85);
insert into public.booking_session_enhancements(booking_session_id, enhancement_id, enhancement_name_snapshot, quantity, unit_price_gbp)
select s.id, '00000000-0000-4000-8000-00000000c901', 'Aftercare advice', 1, 10 from public.booking_sessions s where s.booking_id = '00000000-0000-4000-8000-00000000c315' and s.position = 2;
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c316', '00000000-0000-4000-8000-00000000c203', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85);
select pg_temp.psession('00000000-0000-4000-8000-00000000c316', 1, 'Massage', 60, 85);
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c317', '00000000-0000-4000-8000-00000000c204', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85);
select pg_temp.psession('00000000-0000-4000-8000-00000000c317', 1, 'Massage', 60, 85);
-- B18: a treatment name with a character that flips the text and an invisible mark, and an area name with a bell character in it.
-- B19 is emailed, then cancelled while the email is being handed over, and has an unrelated email waiting too.
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c318', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 85, 0, 12, 0, 97, 97);
select pg_temp.psession('00000000-0000-4000-8000-00000000c318', 1, 'Mass' || chr(8238) || 'age' || chr(8206), 60, 85);
update public.bookings set service_area_name_snapshot = 'Chel' || chr(7) || 'sea' where id = '00000000-0000-4000-8000-00000000c318';
select pg_temp.pbooking('00000000-0000-4000-8000-00000000c319', '00000000-0000-4000-8000-00000000c201', 'confirmed', 'cash', 'paid', 85, 0, 0, 0, 85, 85, 'clara.booking@example.test');
select pg_temp.psession('00000000-0000-4000-8000-00000000c319', 1, 'Massage', 60, 85);

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('receipt_message', 'receipt_strip_link', 'receipt_clean_text', 'receipt_lock_booking', 'receipt_refusal', 'receipt_json', 'receipt_check_business', 'build_receipt_snapshot', 'stop_receipt_emails')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'The inside workings cannot be called from outside');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('admin_receipt_details', 'admin_save_receipt_details', 'admin_issue_receipt', 'admin_get_receipt', 'admin_edit_receipt', 'admin_email_receipt')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or not has_function_privilege('authenticated', p.oid, 'EXECUTE') or not coalesce(p.prosecdef and p.proconfig @> array['search_path=""'], false))),
  'The Admin commands are closed to anonymous callers, open to signed-in ones, and are definers with an empty search path');
select ok(not exists (
  select 1 from (values ('receipt_counters'), ('booking_receipts'), ('booking_receipt_revisions')) t(name)
  where has_table_privilege('authenticated', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('anon', 'public.' || t.name, 'SELECT,INSERT,UPDATE,DELETE')),
  'Nobody can read or write the receipt tables directly');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c102');
set local role authenticated;
select throws_ok($$select public.admin_receipt_details()$$, '42501', 'Admin authorization required', 'A client cannot read the receipt details');
select throws_ok($$select public.admin_save_receipt_details('{"name":"X","email":"x@example.test"}')$$, '42501', 'Admin authorization required', 'A client cannot change the receipt details');
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c301')$$, '42501', 'Admin authorization required', 'A client cannot make a receipt');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"note":"x"}')$$, '42501', 'Admin authorization required', 'A client cannot edit a receipt');
select throws_ok($$select public.admin_get_receipt('00000000-0000-4000-8000-00000000c301')$$, '42501', 'Admin authorization required', 'A client cannot look at a receipt');
select throws_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', gen_random_uuid())$$, '42501', 'Admin authorization required', 'A client cannot email a receipt');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c102', true);
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c301')$$, '42501', 'Admin authorization required', 'A guest cannot make a receipt');
select throws_ok($$select public.admin_receipt_details()$$, '42501', 'Admin authorization required', 'A guest cannot read the receipt details');
select throws_ok($$select public.admin_save_receipt_details('{"name":"X","email":"x@example.test"}')$$, '42501', 'Admin authorization required', 'A guest cannot change the receipt details');
select throws_ok($$select public.admin_get_receipt('00000000-0000-4000-8000-00000000c301')$$, '42501', 'Admin authorization required', 'A guest cannot look at a receipt');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"note":"x"}')$$, '42501', 'Admin authorization required', 'A guest cannot edit a receipt');
select throws_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', gen_random_uuid())$$, '42501', 'Admin authorization required', 'A guest cannot email a receipt');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Her details
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select is(public.admin_receipt_details(), null, 'Nothing is saved to start with');
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c301')$$, 'PT409', 'Save your receipt details first', 'No receipt is made before her details are saved');
select throws_ok($$select public.admin_save_receipt_details('{"phone":"07700 900123"}')$$, '22023', 'Enter your business name', 'A business name is needed');
select throws_ok($$select public.admin_save_receipt_details('{"name":"VadMassage"}')$$, '22023', 'Add a phone number, an email address or a website for the receipt', 'Some way to reach her is needed');
select throws_ok($$select public.admin_save_receipt_details('{"name":"VadMassage","email":"not-an-email"}')$$, '22023', 'That email address does not look right', 'The email must look like an email');
select throws_ok($$select public.admin_save_receipt_details(jsonb_build_object('name', repeat('x', 121), 'phone', '07700 900123'))$$, '22023', 'That is too long', 'A name that is too long is refused');
select throws_ok($$select public.admin_save_receipt_details('{"name":"VadMassage","phone":"07700 900123","vat_number":"GB123"}')$$, '22023', 'Invalid receipt details', 'Nothing else can be stored with her details');
select lives_ok($$select public.admin_save_receipt_details('{"name":" VadMassage ","phone":"07700 900123","email":"Hello@VadMassage.example","address":"1 Example Street\nLondon","closing":"Thank you.","practitioner_name":"Vad Test","practitioner_title":"Therapist","association":"Test Association","membership_number":"123"}')$$, 'She can save her details');
select results_eq($$select v->>'name', v->>'email', v->>'closing' from (select public.admin_receipt_details() v) q$$, $$values ('VadMassage'::text, 'hello@vadmassage.example'::text, 'Thank you.'::text)$$, 'They come back tidied, the email in lower case');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Which bookings can have a receipt
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c303')$$, 'PT409', 'A receipt can be made once the payment is marked as received', 'A booking still waiting for payment has no receipt');
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c304')$$, 'PT409', 'This payment was refunded, so there is no receipt', 'A refunded payment has no receipt');
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c305')$$, 'PT409', 'A cancelled booking has no receipt', 'A cancelled booking has no receipt');
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c314')$$, 'PT409', 'A missed appointment has no receipt', 'A missed appointment has no receipt');
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c307')$$, 'PT409', 'The prices on this booking do not add up to its total, so a receipt cannot be made', 'A wrong price is not turned into a receipt');
select throws_ok($$select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c308')$$, 'PT409', 'The amount paid does not match the booking, so a receipt cannot be made', 'A payment that is not the total is not turned into a receipt');
select throws_ok($$select public.admin_issue_receipt(gen_random_uuid())$$, 'P0002', 'Booking unavailable', 'An unknown booking has no receipt');
reset role;
select is((select count(*)::integer from public.booking_receipts) + (select count(*)::integer from public.receipt_counters where year = pg_temp.year_now()), 0, 'None of those made a receipt, and none used up a number');

-- ---------------------------------------------------------------------------------------------
-- Making one
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
create temp table first_receipt as select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c301') r;
create temp table second_receipt as select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c302') r;
grant select on first_receipt, second_receipt to authenticated;
reset role;
select is((select r->>'number' from first_receipt), 'VAD-' || pg_temp.year_now() || '-0001', 'The first receipt is number 1 of the year');
select is((select r->>'number' from second_receipt), 'VAD-' || pg_temp.year_now() || '-0002', 'The next is number 2');
select results_eq($$select l->>'label', (l->>'amount')::numeric from jsonb_array_elements((select r->'snapshot'->'lines' from first_receipt)) l$$,
  $$values ('Massage, 90 minutes'::text, 115.00::numeric), ('Travel, Chelsea', 12.00::numeric)$$, 'The lines are what the booking shows');
select results_eq($$select r->'snapshot'->>'billed_to', r->'snapshot'->>'reference', (r->'snapshot'->>'total')::numeric, r->'snapshot'->'payment'->>'method' from first_receipt$$,
  $$values ('Clara Jensen'::text, 'RCPT-00000000-0000-4000-8000-00000000c301'::text, 127.00::numeric, 'bank_transfer'::text)$$, 'It says who paid, the booking reference, the total and how');
select results_eq($$select l->>'label', (l->>'amount')::numeric from jsonb_array_elements((select r->'snapshot'->'lines' from second_receipt)) l$$,
  $$values ('Massage, 60 minutes'::text, 85.00::numeric), ('Aftercare advice', 10.00::numeric), ('Travel, Chelsea', 12.00::numeric), ('Congestion charge', 8.00::numeric)$$, 'Extras and the congestion charge are lines of their own');
select is((select sum((l->>'amount')::numeric) from jsonb_array_elements((select r->'snapshot'->'lines' from second_receipt)) l), 115.00::numeric, 'The lines always add up to the total');
select ok(not (select (r->'snapshot')::text ~ 'Test Road|SW1A' or r->>'message' ~ 'Test Road|SW1A' from first_receipt), 'The treatment address is not on the receipt');
select ok((select r->>'message' like 'Receipt VAD-%-0001' || E'\nIssued ' || to_char(pg_temp.today_plus(0), 'FMDD FMMonth YYYY') || E'\n\nVadMassage\n07700 900123 · hello@vadmassage.example\n1 Example Street\nLondon\n\nReceived from: Clara Jensen\nBooking reference: RCPT-%' from first_receipt),
  'The top of the message has the number, the day, and her details');
select ok((select r->>'message' like '%Appointment: ' || to_char(pg_temp.today_plus(5), 'FMDay FMDD FMMonth YYYY') || E' at 14:30 (90 minutes)\n\nMassage, 90 minutes: £115.00\nTravel, Chelsea: £12.00\nTotal paid: £127.00\nPaid by bank transfer on ' || to_char(pg_temp.today_plus(-2), 'FMDD FMMonth YYYY') || E'.\n\nPractitioner: Vad Test, Therapist\nTest Association, membership number 123\n\nThank you.' from first_receipt),
  'The message lists the appointment, the lines, the total and how it was paid, and ends with her closing line');
select ok((select r->>'message' like '%Paid by cash on%' from second_receipt), 'A cash payment says so');
-- The same one every time.
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select is((select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c301')->>'id'), (select r->>'id' from first_receipt), 'Opening it again gives the same receipt');
reset role;
select is((select count(*)::integer from public.booking_receipts), 2, 'No second receipt was made for the booking');
select is((select last_number from public.receipt_counters where year = pg_temp.year_now()), 2, 'And no number was used up');
-- The lines can disagree with the subtotals: then the subtotals are used.
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select results_eq($$select l->>'label', (l->>'amount')::numeric from jsonb_array_elements(public.admin_issue_receipt('00000000-0000-4000-8000-00000000c306')->'snapshot'->'lines') l$$, $$values ('Treatment'::text, 90.00::numeric)$$,
  'If the treatment lines do not match the booking''s subtotal, the subtotal is shown');
reset role;

-- ---------------------------------------------------------------------------------------------
-- A receipt stays as it was
-- ---------------------------------------------------------------------------------------------
create temp table frozen as select md5(snapshot::text) as hash, public.receipt_message(snapshot) as message from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000c301';
update public.bookings set service_subtotal_gbp = 999, total_gbp = 1086, service_area_name_snapshot = 'Elsewhere' where id = '00000000-0000-4000-8000-00000000c301';
update public.booking_sessions set unit_price_gbp = 999 where booking_id = '00000000-0000-4000-8000-00000000c301';
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select lives_ok($$select public.admin_save_receipt_details('{"name":"A New Name","email":"new@vadmassage.example","practitioner_name":"Vad Test","practitioner_title":"Therapist","association":"Test Association","membership_number":"123"}')$$, 'Her details can change later');
select is((select md5((public.admin_issue_receipt('00000000-0000-4000-8000-00000000c301')->'snapshot')::text)), (select md5((r->'snapshot')::text) from first_receipt), 'A receipt that exists does not change when the booking or her details do');
reset role;
select is((select public.receipt_message(snapshot) from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000c301'), (select message from frozen), 'Its words do not change either');
update public.bookings set service_subtotal_gbp = 115, total_gbp = 127, service_area_name_snapshot = (select name from public.service_areas where slug = 'chelsea') where id = '00000000-0000-4000-8000-00000000c301';
update public.booking_sessions set unit_price_gbp = 115 where booking_id = '00000000-0000-4000-8000-00000000c301';
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select is((select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c309')->'snapshot'#>>'{business,name}'), 'A New Name', 'A new receipt uses the details as they are now');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Editing the words on one receipt
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
create temp table edited as select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301',
  '{"billed_to":"Jensen Holdings Ltd","note":"Order 4471","lines":["Sports massage, 90 minutes","Travel to Chelsea"],"business":{"name":"VadMassage Ltd","phone":"07700 900123","address":"2 Other Street","practitioner_name":"Vad Test","practitioner_title":"Therapist","association":"Test Association","membership_number":"123"}}') r;
grant select on edited to authenticated;
reset role;
select results_eq($$select r->'snapshot'->>'billed_to', r->'snapshot'->>'note', r->'snapshot'#>>'{business,name}', r->'snapshot'#>>'{business,address}', r->>'number', (r->>'edit_count')::integer from edited$$,
  $$select 'Jensen Holdings Ltd'::text, 'Order 4471'::text, 'VadMassage Ltd'::text, '2 Other Street'::text, 'VAD-' || pg_temp.year_now() || '-0001', 1$$, 'Who it is for, a note and her details change; the number does not');
select results_eq($$select l->>'label', (l->>'amount')::numeric from jsonb_array_elements((select r->'snapshot'->'lines' from edited)) l$$,
  $$values ('Sports massage, 90 minutes'::text, 115.00::numeric), ('Travel to Chelsea', 12.00::numeric)$$, 'The words of each line change; the amounts do not');
select results_eq($$select r->'snapshot'->>'total', r->'snapshot'#>>'{payment,method}', r->'snapshot'->'appointment'->>'start_minutes' from edited$$, $$values ('127.00'::text, 'bank_transfer'::text, '870'::text)$$, 'The total, how it was paid and the appointment are untouched');
select ok((select r->>'message' like '%Received from: Jensen Holdings Ltd%Sports massage, 90 minutes: £115.00%Total paid: £127.00%Order 4471%' from edited), 'The message follows the edit');
select results_eq($$select revision, snapshot->>'billed_to' from public.booking_receipt_revisions where receipt_id = (select (r->>'id')::uuid from edited)$$, $$values (1, 'Clara Jensen'::text)$$, 'The version before the edit is kept');
select ok((select r->>'edited_at' is not null from edited), 'It says when it was edited');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select is((select (public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"billed_to":"Jensen Holdings Ltd"}')->>'edit_count')::integer), 1, 'Saving what is already there changes and records nothing');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"total":1}')$$, '22023', 'Invalid receipt changes', 'The total cannot be sent as a change');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"payment":{"method":"cash"}}')$$, '22023', 'Invalid receipt changes', 'Nor how it was paid');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"lines":[{"label":"x","amount":1},{"label":"y","amount":1}]}')$$, '22023', 'Every line of the receipt needs its words', 'A line cannot carry a new amount');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"lines":["Only one line"]}')$$, '22023', 'Every line of the receipt needs its words', 'Every line must be there');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"lines":["Fine"," "]}')$$, '22023', 'Every line of the receipt needs its words', 'A line cannot be left blank');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"billed_to":" "}')$$, '22023', 'Enter who the receipt is for', 'It needs a name');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('note', repeat('x', 301)))$$, '22023', 'That is too long', 'A note that is too long is refused');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"business":{"name":"","phone":"07700 900123"}}')$$, '22023', 'Enter your business name', 'Her details on a receipt still need a name');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c303', '{"note":"x"}')$$, 'P0002', 'This booking has no receipt yet', 'A booking without a receipt cannot be edited');
select throws_ok($$select public.admin_edit_receipt(gen_random_uuid(), '{"note":"x"}')$$, 'P0002', 'Booking unavailable', 'A booking that does not exist cannot be edited');
select lives_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"note":null}')$$, 'A note can be taken off');
reset role;
select ok(not (select snapshot ? 'note' from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000c301'), 'Taking the note off leaves none');
select is((select count(*)::integer from public.booking_receipt_revisions where receipt_id = (select (r->>'id')::uuid from edited)), 2, 'Each real change keeps the version before it');
select is((select count(*)::integer from public.event_outbox where aggregate_id = '00000000-0000-4000-8000-00000000c301' and event_type in ('booking.receipt_issued', 'booking.receipt_edited')), 3, 'Making and editing it are on the record');

-- ---------------------------------------------------------------------------------------------
-- Emailing it
-- ---------------------------------------------------------------------------------------------
create temp table request as select gen_random_uuid() as id;
grant select on request to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
create temp table emailed as select public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', (select id from request)) r;
grant select on emailed to authenticated;
reset role;
select results_eq($$select d.channel, d.audience, d.recipient, d.title, d.status from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c301'$$,
  $$values ('email'::text, 'client'::text, 'clara.booking@example.test'::text, 'Your receipt from VadMassage Ltd (VAD-' || pg_temp.year_now() || '-0001)', 'pending'::text)$$, 'One email is queued for the address on the booking, for the sender to deliver');
select ok((select d.body like E'Hello Clara,\n\nHere is your receipt for your appointment on ' || to_char(pg_temp.today_plus(5), 'FMDay FMDD FMMonth YYYY') || E' at 14:30.\n\nReceipt VAD-%' || E'\n\nWarm wishes,\nVad' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c301'),
  'It greets the client by first name and carries the receipt, edited as it is now');
select results_eq($$select r->>'emailed_to', r->>'emailed_at' is not null from emailed$$, $$values ('clara.booking@example.test'::text, true)$$, 'The receipt records who it was sent to and when');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select lives_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', (select id from request))$$, 'Pressing the button twice with the same request is harmless');
reset role;
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c301'), 1, 'It sends one email, not two');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select lives_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', gen_random_uuid())$$, 'It can be sent again on purpose');
reset role;
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c301'), 2, 'And that is a second email');
select is((select count(*)::integer from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and d.channel <> 'email'), 0, 'Nothing goes to Telegram');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select lives_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', '{"note":"Added after sending"}')$$, 'A receipt can be edited after it was sent');
reset role;
select ok((select edited_at > emailed_at from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000c301'), 'The receipt shows it changed after the email went');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select is((public.admin_issue_receipt('00000000-0000-4000-8000-00000000c309')->>'number'), 'VAD-' || pg_temp.year_now() || '-0004', 'Numbers carry on in order: the fourth receipt of the year');
select throws_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c309', gen_random_uuid())$$, 'PT409', 'There is no email address on this booking', 'A booking with no email address cannot be emailed');
select throws_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c303', gen_random_uuid())$$, 'P0002', 'This booking has no receipt yet', 'A booking with no receipt cannot be emailed');
select throws_ok($$select public.admin_email_receipt(gen_random_uuid(), gen_random_uuid())$$, 'P0002', 'Booking unavailable', 'A booking that does not exist cannot be emailed');
reset role;

-- ---------------------------------------------------------------------------------------------
-- What became of the email: the receipt only ever says what is true
-- ---------------------------------------------------------------------------------------------
select results_eq($$select r->'email'->>'status', r->'email'->>'to', (r->'email'->>'attempts')::integer, r->'email'->>'sent_at' is null from emailed$$,
  $$values ('pending'::text, 'clara.booking@example.test'::text, 0, true)$$, 'Straight after pressing Email, the receipt says it is waiting to be sent');
create temp table picked as select id, recipient from public.claim_notification_deliveries(50, array['email']);
select ok((select count(*) >= 2 from picked where recipient = 'clara.booking@example.test'), 'The sender picks the emails up');
do $$ begin perform public.complete_notification_delivery(id, false, 'The mail service refused it') from picked; end $$;
select results_eq($$select public.receipt_json(r)->'email'->>'status', public.receipt_json(r)->'email'->>'attempts' from public.booking_receipts r where r.booking_id = '00000000-0000-4000-8000-00000000c301'$$,
  $$values ('failed'::text, '1'::text)$$, 'If the sender could not deliver it, the receipt says so');
do $$ begin
  update public.notification_deliveries set status = 'sent', sent_at = clock_timestamp(), last_error = null
  where id = (select d.id from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
              where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c301' order by d.created_at desc limit 1);
end $$;
select results_eq($$select public.receipt_json(r)->'email'->>'status', public.receipt_json(r)->'email'->>'sent_at' is not null from public.booking_receipts r where r.booking_id = '00000000-0000-4000-8000-00000000c301'$$,
  $$values ('sent'::text, true)$$, 'Once the sender has delivered it, the receipt says sent');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select is((select public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', gen_random_uuid())->'email'->>'status'), 'pending', 'Sending it again shows the newest email, which is waiting to be sent');
reset role;

-- ---------------------------------------------------------------------------------------------
-- A booking that changes after its receipt was made
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
do $$ begin
  perform public.admin_issue_receipt('00000000-0000-4000-8000-00000000c310');
  perform public.admin_issue_receipt('00000000-0000-4000-8000-00000000c311');
  perform public.admin_issue_receipt('00000000-0000-4000-8000-00000000c312');
  perform public.admin_issue_receipt('00000000-0000-4000-8000-00000000c313');
  perform public.admin_issue_receipt('00000000-0000-4000-8000-00000000c319');
  -- An email for each of the first three is waiting to be sent when the booking changes under it.
  perform public.admin_email_receipt('00000000-0000-4000-8000-00000000c310', gen_random_uuid());
  perform public.admin_email_receipt('00000000-0000-4000-8000-00000000c311', gen_random_uuid());
  perform public.admin_email_receipt('00000000-0000-4000-8000-00000000c312', gen_random_uuid());
  perform public.admin_email_receipt('00000000-0000-4000-8000-00000000c319', gen_random_uuid());
end $$;
reset role;
-- B19: its email is already being handed to the mail service, and an unrelated email for the same booking is waiting.
update public.notification_deliveries set status = 'sending', attempt_count = 1
 where event_id in (select e.id from public.event_outbox e where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c319');
insert into public.event_outbox(id, event_type, aggregate_type, aggregate_id, deduplication_key, payload)
values ('00000000-0000-4000-8000-00000000d001', 'booking.confirmed', 'booking', '00000000-0000-4000-8000-00000000c319', 'receipts-test-unrelated', '{}');
insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
values ('00000000-0000-4000-8000-00000000d001', 'email', 'client', 'clara.booking@example.test', 'Something else', 'Not a receipt');
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000c310';
update public.booking_payments set status = 'refunded', paid_at = null where booking_id = '00000000-0000-4000-8000-00000000c311';
update public.bookings set booking_status = 'no_show' where id = '00000000-0000-4000-8000-00000000c312';
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-00000000c319';
update public.bookings set date = date + 1, start_minutes = 600 where id = '00000000-0000-4000-8000-00000000c313';
select results_eq($$select d.status, d.attempt_count, d.last_error from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c310'$$,
  $$values ('failed'::text, 5, 'The receipt can no longer be sent'::text)$$, 'A receipt email still waiting is stopped when the booking is cancelled');
select results_eq($$select d.status, d.attempt_count from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c311'$$,
  $$values ('failed'::text, 5)$$, 'Or when the payment is refunded');
select results_eq($$select d.status, d.attempt_count from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c312'$$,
  $$values ('failed'::text, 5)$$, 'Or when the appointment is marked as missed');
select is((select d.status from public.notification_deliveries d where d.event_id = '00000000-0000-4000-8000-00000000d001'), 'pending', 'And no other email about the booking is touched');
select results_eq($$select d.status from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c319'$$,
  $$values ('sending'::text)$$, 'An email already being handed to the mail service is left alone');
select is((select count(*)::integer from public.claim_notification_deliveries(50, array['email']) c where c.event_id in (select e.id from public.event_outbox e where e.event_type = 'booking.receipt_emailed' and e.aggregate_id in ('00000000-0000-4000-8000-00000000c310', '00000000-0000-4000-8000-00000000c311', '00000000-0000-4000-8000-00000000c312'))), 0,
  'The sender does not pick a stopped receipt email up');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select throws_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c310', gen_random_uuid())$$, 'PT409', 'This booking was cancelled, so its receipt can no longer be sent or changed', 'A receipt for a booking that was cancelled cannot be emailed');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c310', '{"note":"x"}')$$, 'PT409', 'This booking was cancelled, so its receipt can no longer be sent or changed', 'Nor changed');
select throws_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c311', gen_random_uuid())$$, 'PT409', 'This payment was refunded, so its receipt can no longer be sent or changed', 'A receipt for a payment that was refunded cannot be emailed');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c311', '{"note":"x"}')$$, 'PT409', 'This payment was refunded, so its receipt can no longer be sent or changed', 'Nor changed');
select throws_ok($$select public.admin_email_receipt('00000000-0000-4000-8000-00000000c312', gen_random_uuid())$$, 'PT409', 'This appointment was marked as missed, so its receipt can no longer be sent or changed', 'A receipt for a missed appointment cannot be emailed');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c312', '{"note":"x"}')$$, 'PT409', 'This appointment was marked as missed, so its receipt can no longer be sent or changed', 'Nor changed');
select is((select public.admin_get_receipt('00000000-0000-4000-8000-00000000c310')->>'number'), 'VAD-' || pg_temp.year_now() || '-0005', 'A receipt that was made can still be looked at after the booking is cancelled');
select is(public.admin_get_receipt('00000000-0000-4000-8000-00000000c303'), null, 'A booking that has no receipt shows none, and does not make one');
select results_eq($$select (c->>'appointment')::boolean, (c->>'total')::boolean from (select public.admin_get_receipt('00000000-0000-4000-8000-00000000c301')->'changes' c) q$$,
  $$values (false, false)$$, 'A receipt whose booking has not changed says nothing is out of date');
select results_eq($$select (c->>'appointment')::boolean, (c->>'total')::boolean from (select public.admin_get_receipt('00000000-0000-4000-8000-00000000c313')->'changes' c) q$$,
  $$values (true, false)$$, 'A receipt says when its appointment was moved afterwards');
select is((select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c313', '{"sync_appointment":true}')->'snapshot'->'appointment'->>'start_minutes'), '600', 'One tap brings the date and time on the receipt up to date');
select results_eq($$select (c->>'appointment')::boolean, (c->>'total')::boolean from (select public.admin_get_receipt('00000000-0000-4000-8000-00000000c313')->'changes' c) q$$,
  $$values (false, false)$$, 'And then nothing is out of date');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c313', '{"sync_appointment":"yes"}')$$, '22023', 'Invalid receipt changes', 'The one tap is a yes or no, nothing else');
reset role;
select is((select count(*)::integer from public.booking_receipt_revisions where receipt_id = (select id from public.booking_receipts where booking_id = '00000000-0000-4000-8000-00000000c313')), 1, 'The version with the old date is kept');
update public.bookings set total_gbp = 90 where id = '00000000-0000-4000-8000-00000000c313';
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select results_eq($$select (c->>'appointment')::boolean, (c->>'total')::boolean from (select public.admin_get_receipt('00000000-0000-4000-8000-00000000c313')->'changes' c) q$$,
  $$values (false, true)$$, 'A receipt says when the price on the booking is not the amount on it');
reset role;
update public.bookings set total_gbp = 85 where id = '00000000-0000-4000-8000-00000000c313';
-- Each way a booking can move counts: another day, another start time, another length.
update public.bookings set date = date + 3 where id = '00000000-0000-4000-8000-00000000c302';
update public.bookings set start_minutes = start_minutes + 30 where id = '00000000-0000-4000-8000-00000000c306';
update public.bookings set treatment_duration_minutes = 120 where id = '00000000-0000-4000-8000-00000000c309';
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select results_eq($$select (public.admin_get_receipt(v.b)->'changes'->>'appointment')::boolean from (values ('00000000-0000-4000-8000-00000000c302'::uuid), ('00000000-0000-4000-8000-00000000c306'::uuid), ('00000000-0000-4000-8000-00000000c309'::uuid)) v(b)$$,
  $$values (true), (true), (true)$$, 'A new day, a new start time and a new length each count as moved');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Text that cannot be shown safely
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('note', 'Hello' || chr(8238) || 'there'))$$, '22023', 'That contains characters that cannot be used', 'A character that flips the direction of text is refused');
select throws_ok($$select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('billed_to', 'A' || chr(7) || 'B'))$$, '22023', 'That contains characters that cannot be used', 'So is a control character');
select throws_ok($$select public.admin_save_receipt_details(jsonb_build_object('name', 'Vad' || chr(8238), 'phone', '07700 900123'))$$, '22023', 'That contains characters that cannot be used', 'Also in her details');
select is((select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('billed_to', E'Jensen\nHoldings'))->'snapshot'->>'billed_to'), 'Jensen Holdings', 'A line break in a one-line field becomes a space');
select is((select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('note', E'First line\r\nSecond line'))->'snapshot'->>'note'), E'First line\nSecond line', 'A note keeps its line breaks');
select ok((select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('note', 'Open {link} now'))->>'message') not like '%{link}%', 'The word the email sender swaps for a web address never reaches a message');
do $$ begin perform public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', gen_random_uuid()); end $$;
reset role;
select ok((select d.body not like '%{link}%' and d.body like '%Open  now%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
           where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c301' order by d.created_at desc limit 1), 'Nor to the email');
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select ok((select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('note', '{li{li{link}nk}nk} done'))->>'message') not like '%{link}%', 'Taking the link word out cannot leave another one behind');
do $$ begin perform public.admin_email_receipt('00000000-0000-4000-8000-00000000c301', gen_random_uuid()); end $$;
select is((select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('billed_to', 'Jensen' || chr(8232) || 'Holdings'))->'snapshot'->>'billed_to'), 'Jensen Holdings', 'The line separator some phones type is a line break too');
select is((select public.admin_edit_receipt('00000000-0000-4000-8000-00000000c301', jsonb_build_object('note', 'Zero' || chr(8203) || 'width' || chr(65279) || chr(8206)))->'snapshot'->>'note'), 'Zerowidth', 'Marks that cannot be seen are dropped');
reset role;
select ok((select d.body not like '%{link}%' and d.body like '%done%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
           where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c301' order by d.created_at desc limit 1), 'Nor in the email');

-- ---------------------------------------------------------------------------------------------
-- Longer bookings and unusual names
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-00000000c101');
set local role authenticated;
select results_eq($$select l->>'label', (l->>'amount')::numeric from jsonb_array_elements(public.admin_issue_receipt('00000000-0000-4000-8000-00000000c315')->'snapshot'->'lines') l$$,
  $$values ('Swedish massage, 60 minutes'::text, 85.00::numeric), ('Deep tissue massage, 60 minutes'::text, 85.00::numeric), ('Aftercare advice'::text, 10.00::numeric), ('Travel, Chelsea'::text, 12.00::numeric)$$,
  'A booking with two sessions lists each one, then the extra, then travel');
select is((select sum((l->>'amount')::numeric) from jsonb_array_elements(public.admin_issue_receipt('00000000-0000-4000-8000-00000000c315')->'snapshot'->'lines') l), 192.00::numeric, 'And they add up to the total');
select is((select public.admin_issue_receipt('00000000-0000-4000-8000-00000000c316')->'snapshot'->>'billed_to'), 'ZoeEvil Park Lane', 'Hidden characters and line breaks in a name are tidied away on the receipt');
select is((select length(public.admin_issue_receipt('00000000-0000-4000-8000-00000000c317')->'snapshot'->>'billed_to')), 120, 'A very long name is cut to fit');
select results_eq($$select l->>'label', (l->>'amount')::numeric from jsonb_array_elements(public.admin_issue_receipt('00000000-0000-4000-8000-00000000c318')->'snapshot'->'lines') l$$,
  $$values ('Massage, 60 minutes'::text, 85.00::numeric), ('Travel, Chelsea'::text, 12.00::numeric)$$, 'Names with hidden characters in them are tidied on the lines too');
do $$ begin perform public.admin_email_receipt('00000000-0000-4000-8000-00000000c316', gen_random_uuid()); end $$;
reset role;
select ok((select d.body like E'Hello ZoeEvil,%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
           where e.event_type = 'booking.receipt_emailed' and e.aggregate_id = '00000000-0000-4000-8000-00000000c316'), 'And so is the greeting');
select ok(exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid = 42420 and objid = hashtext(pg_temp.today_plus(5)::text)),
  'Making a receipt waits behind the same day lock the cancel and refund commands use');
select is((select last_number from public.receipt_counters where year = pg_temp.year_now() - 1), 7, 'Last year''s count is left alone');

select * from finish();
rollback;
