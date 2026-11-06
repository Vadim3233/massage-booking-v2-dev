begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(12);

-- Income's calendar and "Your hour" (20261129100000_income_calendar_hourly.sql). January 2034, which no other test uses; 1 Jan 2034 is a Sunday.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000b901', 'authenticated', 'authenticated', 'hourly-admin@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000b901');
insert into public.clients(id, first_name, last_name) values ('00000000-0000-4000-8000-00000000b1c1', 'Hugo', 'Ours');
create function pg_temp.b(p_n integer, p_date date, p_start integer, p_minutes integer, p_travel integer, p_area text, p_total numeric,
  p_status text, p_method text, p_payment text, p_fee numeric default 0, p_fee_status text default 'none') returns uuid language plpgsql as $$
declare v_id uuid := ('00000000-0000-4000-8000-0000000b' || lpad(p_n::text, 4, '0'))::uuid;
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, travel_buffer_minutes,
    booking_status, source_channel, address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, cancelled_at,
    late_fee_standard_gbp, late_fee_due_gbp, late_fee_status)
  select v_id, 'HOUR-' || p_n, '00000000-0000-4000-8000-00000000b1c1', id, p_date, p_start, p_minutes, p_travel, p_status, 'test', '1 Test Road', name,
    p_total, p_total, case when p_status = 'cancelled' then now() end, p_fee, p_fee, p_fee_status
  from public.service_areas where slug = p_area;
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (v_id, p_method, p_payment, p_total, case when p_payment = 'paid' then now() end);
  return v_id;
end $$;

select pg_temp.b(1, '2034-01-02', 600, 60, 60, 'chelsea', 100, 'confirmed', 'bank_transfer', 'paid');      -- 1 h treatment, travel there 1 h
select pg_temp.b(2, '2034-01-02', 780, 120, 30, 'kensington', 200, 'completed', 'cash', 'paid');           -- the day's last: travel there and home, 30 min each
select pg_temp.b(3, '2034-01-03', 600, 60, 60, 'chelsea', 100, 'cancelled', 'bank_transfer', 'rejected', 50, 'received'); -- a late fee: money, no time
select pg_temp.b(4, '2034-01-04', 600, 60, 60, 'chelsea', 100, 'confirmed', 'bank_transfer', 'awaiting_transfer'); -- not paid yet: to come, no time

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b901","role":"authenticated"}', true);
create temporary table m as select public.admin_income_summary('month', '2034-01-15') as j;
create temporary table y as select public.admin_income_summary('year', '2034-01-15') as j;

select is((select jsonb_array_length(j->'days') from m), 31, 'A month has a square for every day');
select is((select (d->>'received_gbp')::numeric from m, jsonb_array_elements(j->'days') d where d->>'date' = '2034-01-02'), 300.00, 'A day shows the money received for it');
select is((select (d->>'received_gbp')::numeric from m, jsonb_array_elements(j->'days') d where d->>'date' = '2034-01-03'), 50.00, 'A late fee received counts on its day');
select is((select (d->>'to_come_gbp')::numeric from m, jsonb_array_elements(j->'days') d where d->>'date' = '2034-01-04'), 100.00, 'An appointment not paid yet shows as to come on its day');
select ok((select j->>'days' is null from y), 'Only a month has days');

select is((select (j->'hours'->>'work_minutes')::int from m), 180, 'Treatment time counts appointments that went ahead and were paid');
select is((select (j->'hours'->>'travel_minutes')::int from m), 120, 'Travel is the way to each appointment, plus the way home after the last of the day');
select is((select (j->'hours'->>'earned_gbp')::numeric from m), 300.00, 'The hourly figure leaves out a late fee, which took no time');
select is((select (j->'hours'->>'per_hour_gbp')::numeric from m), 60.00, '£300 over 5 hours is £60 an hour');
select is((select string_agg(a->>'name' || ' ' || (a->>'per_hour_gbp'), ', ') from m, jsonb_array_elements(j->'hours'->'areas') a),
  'Kensington 66.67, Chelsea 50.00', 'Each area has its own hourly figure, best first');
select is((select (b->>'per_hour_gbp')::numeric from y, jsonb_array_elements(j->'bars') b where b->>'from' = '2034-01-01'), 60.00, 'The year shows each month''s hourly figure');
select is((select b->>'per_hour_gbp' from y, jsonb_array_elements(j->'bars') b where b->>'from' = '2034-02-01'), null, 'A month with no worked time has no hourly figure');
reset role;

select * from finish();
rollback;
