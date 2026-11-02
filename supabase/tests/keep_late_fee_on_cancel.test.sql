begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(14);

-- A late fee already owed (the client moved the booking inside 24 hours) is kept when the client later cancels the new date,
-- even though the new date on its own would be free to cancel (ADR-084).
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000f101', 'authenticated', 'authenticated', 'keep-fee@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000f1ad', 'authenticated', 'authenticated', 'keep-fee-admin@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f1ad');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000f201', '00000000-0000-0000-0000-00000000f101', 'Keep', 'Fee', 'keep-fee@example.test');

-- Bookings ten days ahead (free to cancel on their own), each already carrying a late fee from an earlier late move.
create function pg_temp.moved_booking(p_id uuid, p_payment text, p_fee_status text, p_start integer) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp,
    created_at, late_fee_standard_gbp, late_fee_due_gbp, late_fee_status)
  select p_id, 'KEEP-' || p_id, '00000000-0000-4000-8000-00000000f201', id, ((now() at time zone 'Europe/London') + interval '10 days')::date,
    p_start, 60, 'confirmed', 'test', '1 Test Road', 'London', 'SW1A 1AA', name, 85, 85, now() - interval '3 days',
    case when p_fee_status = 'none' then 0 else 85 end, case when p_fee_status = 'none' then 0 else 85 end, p_fee_status
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (p_id, 'bank_transfer', p_payment, 85, case when p_payment = 'paid' then now() end);
end;
$$;
select pg_temp.moved_booking('00000000-0000-4000-8000-00000000f301', 'awaiting_verification', 'due', 600);
select pg_temp.moved_booking('00000000-0000-4000-8000-00000000f302', 'paid', 'due', 720);
select pg_temp.moved_booking('00000000-0000-4000-8000-00000000f303', 'awaiting_verification', 'due', 840);
select pg_temp.moved_booking('00000000-0000-4000-8000-00000000f304', 'awaiting_verification', 'due', 960);
select pg_temp.moved_booking('00000000-0000-4000-8000-00000000f305', 'awaiting_verification', 'none', 1080);

select ok(not has_function_privilege('authenticated', 'public.late_fee_on_cancel_gbp(public.bookings, timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.late_fee_on_cancel_gbp(public.bookings, timestamptz)', 'EXECUTE'), 'The fee helper is internal');
select ok(not has_function_privilege('anon', 'public.admin_cancel_fee_preview(uuid, text)', 'EXECUTE'), 'Anonymous callers cannot ask the Admin preview');

-- The client
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f101', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000f301')->>'cancel_fee_gbp')::numeric, 85::numeric,
  'The client is shown the fee already owed before cancelling');
select is((public.get_my_change_terms('00000000-0000-4000-8000-00000000f305')->>'cancel_fee_gbp')::numeric, 0::numeric,
  'A booking with no fee owed is still free to cancel ten days ahead');
select throws_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000f301', gen_random_uuid(), 0)$$,
  'PT409', 'The late fee has changed. Please review it and confirm again.', 'Cancelling as if it were free is refused');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000f301', gen_random_uuid(), 85)->>'late_fee_due_gbp', '85.00',
  'Acknowledging the fee cancels and keeps it owed');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000f302', gen_random_uuid(), 85)->>'late_fee_status', 'received',
  'On a paid booking the kept fee comes out of the payment');
select is(public.client_cancel_booking('00000000-0000-4000-8000-00000000f305', gen_random_uuid(), 0)->>'late_fee_status', 'none',
  'A free cancellation with nothing owed is unchanged');
reset role;

select results_eq($$select late_fee_status, late_fee_due_gbp from public.bookings where id = '00000000-0000-4000-8000-00000000f301'$$,
  $$values ('due'::text, 85.00::numeric)$$, 'The fee stays recorded as due');
select is((select refund_due_gbp from public.bookings where id = '00000000-0000-4000-8000-00000000f302'), 0.00::numeric,
  'Nothing is refunded when the kept fee is the full price');

-- The Admin, cancelling at the client's request
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f1ad', 'role', 'authenticated')::text, true);
set local role authenticated;
select is(public.admin_cancel_fee_preview('00000000-0000-4000-8000-00000000f303', 'client'), 85::numeric,
  'The Admin cancel screen starts from the fee already owed');
select is(public.admin_late_fee_preview('00000000-0000-4000-8000-00000000f303', 'client'), 0::numeric,
  'Moving a booking with a fee already owed still adds no second fee');
select lives_ok($$select public.admin_cancel_booking('00000000-0000-4000-8000-00000000f303', gen_random_uuid(),
  (select updated_at from public.bookings where id = '00000000-0000-4000-8000-00000000f303'),
  (select updated_at from public.booking_payments where booking_id = '00000000-0000-4000-8000-00000000f303'), null, 'client', 0)$$,
  'The Admin can still waive it');
reset role;
select results_eq($$select late_fee_status, late_fee_due_gbp from public.bookings where id = '00000000-0000-4000-8000-00000000f303'$$,
  $$values ('waived'::text, 0.00::numeric)$$, 'A waived fee is recorded as waived');

select * from finish();
rollback;
