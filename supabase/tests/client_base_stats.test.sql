begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(22);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000c501', 'authenticated', 'authenticated', 'stats-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000c502', 'authenticated', 'authenticated', 'stats-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c501');

create temp table known(id uuid) on commit drop;
insert into known select id from public.clients;
grant select on known to authenticated;

insert into public.clients(id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000c601', 'Rita', 'Regular', 'rita@example.test', '07700 900601'),
  ('00000000-0000-4000-8000-00000000c602', 'Quentin', 'Quiet', 'quentin@example.test', '07700 900602'),
  ('00000000-0000-4000-8000-00000000c603', 'Nina', 'New', 'nina@example.test', '07700 900603'),
  ('00000000-0000-4000-8000-00000000c604', 'Larry', 'Lapsed', 'larry@example.test', '07700 900604'),
  ('00000000-0000-4000-8000-00000000c605', 'Olga', 'Once', 'olga@example.test', '07700 900605'),
  ('00000000-0000-4000-8000-00000000c606', 'Zero', 'Visits', 'zero@example.test', '07700 900606');

create function pg_temp.visit(p_client text, p_day_offset integer, p_status text default 'completed', p_payment text default 'paid', p_total numeric default 90)
returns void language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, cancelled_at)
  select v_id, 'STAT-' || v_id, ('00000000-0000-4000-8000-00000000c6' || p_client)::uuid, id, ((now() at time zone 'Europe/London')::date + p_day_offset), 600, 60,
    p_status, 'test', '1 Test Road', 'London', 'SW1A 1AA', name, p_total, p_total, case when p_status = 'cancelled' then now() end
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at)
  values (v_id, case when p_payment = 'awaiting_transfer' then 'bank_transfer' else 'cash' end, p_payment, p_total, case when p_payment = 'paid' then now() end);
end;
$$;
-- Rita: every 3 weeks, next one booked.
select pg_temp.visit('01', -84); select pg_temp.visit('01', -63); select pg_temp.visit('01', -42); select pg_temp.visit('01', -21, 'confirmed');
select pg_temp.visit('01', 7, 'confirmed', 'approved');
-- Quentin: every 3 weeks, then nothing for 80 days. A cancelled booking is not a visit.
select pg_temp.visit('02', -143); select pg_temp.visit('02', -122); select pg_temp.visit('02', -101); select pg_temp.visit('02', -80);
select pg_temp.visit('02', -30, 'cancelled', 'rejected');
-- Nina: first visit 10 days ago.
select pg_temp.visit('03', -10);
-- Larry: three visits, the last 200 days ago.
select pg_temp.visit('04', -260); select pg_temp.visit('04', -230); select pg_temp.visit('04', -200);
-- Olga: one visit 90 days ago, then booked again.
select pg_temp.visit('05', -90); select pg_temp.visit('05', 3, 'awaiting_transfer', 'awaiting_transfer');

select ok(not has_function_privilege('anon', 'public.admin_client_base()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_client_rhythm(uuid)', 'EXECUTE'), 'Visitors cannot read the stats');
select ok(not has_function_privilege('authenticated', 'public.client_visit_stats(date)', 'EXECUTE'), 'The inner function is not open to browsers');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c502","role":"authenticated"}', true);
select throws_ok($$select public.admin_client_base()$$, '42501', 'Admin authorization required', 'A client cannot read the client base');
select throws_ok($$select public.admin_client_rhythm('00000000-0000-4000-8000-00000000c601')$$, '42501', 'Admin authorization required', 'A client cannot read a rhythm');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c501","role":"authenticated"}', true);

create temp table b as select public.admin_client_base() as v;
create temp table c as select x.* from b, jsonb_to_recordset(b.v->'clients') as x(id uuid, visits integer, gap_days integer, tag text, overdue_days integer, paid_gbp numeric, next_date date)
  where x.id::text like '00000000-0000-4000-8000-00000000c6%';

select is((select tag from c where id = '00000000-0000-4000-8000-00000000c601'), 'regular', 'Three or more visits on rhythm is Regular');
select is((select visits from c where id = '00000000-0000-4000-8000-00000000c601'), 4, 'A confirmed booking whose day has passed counts as a visit');
select is((select gap_days from c where id = '00000000-0000-4000-8000-00000000c601'), 21, 'Their usual gap is the average gap');
select is((select paid_gbp from c where id = '00000000-0000-4000-8000-00000000c601'), 360.00, 'Paid counts only paid money');
select is((select tag from c where id = '00000000-0000-4000-8000-00000000c602'), 'quiet', 'A regular more than twice their gap overdue is Quiet');
select is((select visits from c where id = '00000000-0000-4000-8000-00000000c602'), 4, 'A cancelled booking is not a visit');
select is((select overdue_days from c where id = '00000000-0000-4000-8000-00000000c602'), 59, 'Overdue counts the days past their usual gap');
select is((select tag from c where id = '00000000-0000-4000-8000-00000000c603'), 'new', 'A first visit in the last 60 days is New');
select is((select tag from c where id = '00000000-0000-4000-8000-00000000c604'), 'lapsed', 'No visit for six months is Lapsed');
select is((select tag from c where id = '00000000-0000-4000-8000-00000000c605'), null, 'One visit a while ago, booked again: no tag');
select is((select visits from c where id = '00000000-0000-4000-8000-00000000c606'), 0, 'A client with no bookings is listed with no visits');
select is((select (v->>'total')::integer from b) - (select count(*)::integer from known), 6, 'Total counts every client');
select is((select (v->>'came_back')::integer from b), (select count(*)::integer from c where visits >= 2 or (visits = 1 and next_date is not null))
  + (select count(*)::integer from jsonb_to_recordset((select v->'clients' from b)) as x(id uuid, visits integer, next_date date)
     where x.id::text not like '00000000-0000-4000-8000-00000000c6%' and (x.visits >= 2 or (x.visits = 1 and x.next_date is not null))), 'Came back counts second visits and bookings');

create temp table r as select public.admin_client_rhythm('00000000-0000-4000-8000-00000000c602') as v;
select is((select v->>'tag' from r), 'quiet', 'The card has the same tag');
select is((select jsonb_array_length(v->'months') from r), 12, 'The card has twelve months');
select is((select sum((m->>'visits')::integer)::integer from r, jsonb_array_elements(v->'months') m
  where (m->>'month')::date >= (date_trunc('month', (now() at time zone 'Europe/London')::date) - interval '11 months')::date), 4, 'Every visit in the last year is in a month');
select ok((select (v->>'rank')::integer from r) >= 1, 'The card has a rank');
select throws_ok($$select public.admin_client_rhythm('00000000-0000-4000-8000-00000000ffff')$$, 'P0002', 'Client unavailable', 'An unknown client is refused');

select * from finish();
rollback;
