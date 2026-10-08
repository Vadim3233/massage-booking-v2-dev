begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pg_temp;
select no_plan();

select has_function('public','admin_search_clients',array['text']);
select has_function('public','admin_client_addresses',array['uuid']);
select has_function('public','admin_create_client',array['jsonb','uuid']);
select has_function('public','admin_quote_booking',array['uuid','jsonb','uuid[]']);
select has_function('public','admin_booking_availability',array['date','integer']);
select has_function('public','admin_create_booking',array['jsonb','uuid']);
select has_function('public','admin_record_bank_transfer_received',array['uuid','uuid','timestamp with time zone','timestamp with time zone']);
select ok(not has_table_privilege('authenticated','public.bookings','INSERT,UPDATE,DELETE,TRUNCATE'),'No browser booking mutation grants');
select ok(not has_table_privilege('authenticated','public.booking_payments','INSERT,UPDATE,DELETE,TRUNCATE'),'No browser payment mutation grants');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('admin_search_clients','admin_client_addresses','admin_create_client','admin_quote_booking','admin_booking_availability','admin_create_booking','admin_record_bank_transfer_received')),'All Admin definers use empty search_path');
select ok(not has_function_privilege('anon','public.admin_create_booking(jsonb,uuid)','EXECUTE'),'Anonymous has no execution grant');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000008001','authenticated','authenticated','admin-new-test@example.test',now(),'{}','{}',now(),now()),
 ('00000000-0000-0000-0000-000000008002','authenticated','authenticated','other-new-test@example.test',now(),'{}','{}',now(),now());
insert into public.admin_users(user_id) values('00000000-0000-0000-0000-000000008001');
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000008002","role":"authenticated"}',true);
select throws_ok($$select public.admin_search_clients('')$$,'42501','Admin authorization required','Non-admin search rejected');
select throws_ok($$select public.admin_create_booking('{}',gen_random_uuid())$$,'42501','Admin authorization required','Non-admin mutation rejected');
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000008001","role":"authenticated","is_anonymous":true}',true);
select throws_ok($$select public.admin_create_booking('{}',gen_random_uuid())$$,'42501','Admin authorization required','Anonymous Admin JWT rejected');
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000008001","role":"authenticated"}',true);

insert into public.services(id,slug,name,active,display_order) values('00000000-0000-0000-0000-000000008101','admin-test-treatment','Admin test treatment',true,990);
insert into public.service_duration_prices(service_id,duration_minutes,price_gbp,active) values
 ('00000000-0000-0000-0000-000000008101',60,85,true),('00000000-0000-0000-0000-000000008101',90,115,true),('00000000-0000-0000-0000-000000008101',120,160,true);
insert into public.service_areas(id,slug,name,active,travel_surcharge_gbp,congestion_fee_gbp,display_order)
 values('00000000-0000-0000-0000-000000008102','admin-test-area','Admin test area',true,12,18,990);
insert into public.enhancements(id,slug,name,price_gbp,duration_minutes,active,display_order)
 values('00000000-0000-0000-0000-000000008103','admin-test-extra','Admin test extra',10,15,true,990);
insert into public.session_preferences(id,slug,label,category,active,display_order) values
 ('00000000-0000-0000-0000-000000008104','admin-test-pref-one','Test one','Pressure',true,990),
 ('00000000-0000-0000-0000-000000008105','admin-test-pref-two','Test two','Pressure',true,991);
insert into public.session_preference_conflicts(preference_id,conflicting_preference_id)
 values('00000000-0000-0000-0000-000000008104','00000000-0000-0000-0000-000000008105');
insert into public.working_hours_overrides(date,available,start_minutes,end_minutes,start_mode)
 select (clock_timestamp() at time zone 'Europe/London')::date+d,true,0,1440,'flexible' from generate_series(0,366) d
 on conflict(date) do update set available=true,start_minutes=0,end_minutes=1440,start_mode='flexible',fixed_start_minutes=null;

create temporary table t_clients as select * from public.admin_create_client(
 '{"first_name":"Alice","last_name":"AdminTest","email":" Alice.AdminTest@example.test ","phone":"+44 7700 900811","address_line_1":"1 Test Street","city":"London","postcode":" sw3 1aa ","entry_instructions":"Bell 2"}',
 '00000000-0000-0000-0000-000000008201');
select is((select count(*)::integer from t_clients),1,'Canonical client created');
select ok((select auth_user_id is null and normalized_email='alice.admintest@example.test' and normalized_phone='447700900811' from t_clients),'Canonical contacts normalized without fake Auth');
select ok((select a.is_default and a.postcode='SW3 1AA' from public.client_addresses a join t_clients c on c.id=a.client_id),'Default address saved');
select is((select id from public.admin_create_client(
 '{"first_name":"Alice","last_name":"AdminTest","email":" Alice.AdminTest@example.test ","phone":"+44 7700 900811","address_line_1":"1 Test Street","city":"London","postcode":" sw3 1aa ","entry_instructions":"Bell 2"}',
 '00000000-0000-0000-0000-000000008201')),(select id from t_clients),'Client create retry returns same client');
select throws_ok($$select public.admin_create_client('{"first_name":"Other","email":"ALICE.ADMINTEST@example.test","address_line_1":"2 Road","city":"London","postcode":"SW1 1AA"}',gen_random_uuid())$$,
 'PT409','An existing client uses this email or phone. Select that client instead.','Normalized email duplicate rejected');
select throws_ok($$select public.admin_create_client('{"first_name":"Other","phone":"44 (7700) 900811","address_line_1":"2 Road","city":"London","postcode":"SW1 1AA"}',gen_random_uuid())$$,
 'PT409','An existing client uses this email or phone. Select that client instead.','Normalized phone duplicate rejected');
select throws_ok($$select public.admin_create_client('{"first_name":"Other","address_line_1":"2 Road","city":"London","postcode":"SW1 1AA"}',gen_random_uuid())$$,
 '22023','Name and a valid email or phone are required','Useful contact required');
select is((select count(*)::integer from public.admin_search_clients('Alice AdminTest')),1,'Search full name');
select is((select count(*)::integer from public.admin_search_clients('900811')),1,'Search normalized phone');
select is((select count(*)::integer from public.admin_search_clients('ALICE.ADMINTEST@')),1,'Search email');
insert into public.clients(first_name,last_name) select 'Bounded','Client '||n from generate_series(1,25)n;
select is((select count(*)::integer from public.admin_search_clients('')),20,'Default search bounded');
select is((select count(*)::integer from public.admin_search_clients('Bounded')),20,'Matching search bounded');
select is((select count(*)::integer from public.admin_client_addresses((select id from t_clients))),1,'Only selected client addresses');

create function pg_temp.request(p_offset integer default 10,p_payment text default 'bank_pending',p_sessions jsonb default null) returns jsonb language sql as $$
 select jsonb_build_object('client_id',c.id,'saved_address_id',a.id,'service_area_id','00000000-0000-0000-0000-000000008102',
   'sessions',coalesce(p_sessions,'[{"service_id":"00000000-0000-0000-0000-000000008101","duration_minutes":60,"recipient_name":"Alice","preference_ids":["00000000-0000-0000-0000-000000008104"]}]'::jsonb),
   'enhancement_ids',jsonb_build_array('00000000-0000-0000-0000-000000008103'),'date',(clock_timestamp() at time zone 'Europe/London')::date+p_offset,
   'start_minutes',600,'payment_arrangement',p_payment,'note','Appointment note only')
 from t_clients c join public.client_addresses a on a.client_id=c.id and a.is_default;
$$;
select is((select total_gbp from public.admin_quote_booking('00000000-0000-0000-0000-000000008102',pg_temp.request()->'sessions',array['00000000-0000-0000-0000-000000008103'::uuid])),125.00::numeric,'Authoritative quote includes service, enhancement, travel and congestion');
create temporary table t_bookings as select * from public.admin_create_booking(pg_temp.request(),'00000000-0000-0000-0000-000000008301');
select is((select count(*)::integer from t_bookings),1,'Single session creation succeeds');
select ok((select b.booking_status='confirmed' and b.source_channel='admin' and b.created_by_actor_type='admin' and b.created_by_actor_id=auth.uid()::text
 and b.payment_reservation_expires_at is null and b.booking_email_snapshot='alice.admintest@example.test' and b.client_note='Appointment note only'
 from public.bookings b join t_bookings t on t.booking_id=b.id),'Booking source, actor, email, note and no provisional expiry');
select ok((select p.method='bank_transfer' and p.status='awaiting_transfer' and p.paid_at is null and p.verified_at is null and p.verified_by is null
 from public.booking_payments p join t_bookings t on t.booking_id=p.booking_id),'Bank pending payment mapping');
select ok((select b.service_subtotal_gbp=85 and b.enhancements_total_gbp=10 and b.travel_fee_gbp=12 and b.congestion_fee_gbp=18 and b.total_gbp=125
 from public.bookings b join t_bookings t on t.booking_id=b.id),'Authoritative price snapshots');
select is((select count(*)::integer from public.booking_session_preferences p join public.booking_sessions s on s.id=p.booking_session_id join t_bookings t on t.booking_id=s.booking_id),1,'Session preference snapshot saved');
select is((select booking_id from public.admin_create_booking(pg_temp.request(),'00000000-0000-0000-0000-000000008301')),(select booking_id from t_bookings),'Same request retry returns existing booking despite occupied slot');
select throws_ok($$select public.admin_create_booking(pg_temp.request() || '{"note":"Changed"}', '00000000-0000-0000-0000-000000008301')$$,'22023','Request key reused','Same key different payload rejected');
select is((select count(*)::integer from public.command_requests where command_type='admin_create_booking'),1,'Exactly one create command');
select is((select count(*)::integer from public.event_outbox e join t_bookings b on b.booking_id=e.aggregate_id),1,'Exactly one create outbox event');
select throws_ok($$select public.admin_create_booking(pg_temp.request(),gen_random_uuid())$$,'PT409','This time is no longer available. Choose another time.','Stale/occupied slot fails safely');

insert into t_bookings select * from public.admin_create_booking(pg_temp.request(11,'bank_received'),gen_random_uuid());
select ok((select p.status='paid' and p.paid_at is not null and p.verified_at is not null and p.verified_by=auth.uid()
 from public.booking_payments p join public.bookings b on b.id=p.booking_id where b.client_id=(select id from t_clients) and b.date=(clock_timestamp() at time zone 'Europe/London')::date+11),'Bank received payment mapping');
insert into t_bookings select * from public.admin_create_booking(pg_temp.request(12,'cash_appointment'),gen_random_uuid());
select ok((select p.status='approved' and p.method='cash' and p.paid_at is null and p.verified_at is null
 from public.booking_payments p join public.bookings b on b.id=p.booking_id where b.client_id=(select id from t_clients) and b.date=(clock_timestamp() at time zone 'Europe/London')::date+12),'Cash at appointment payment mapping');
insert into t_bookings select * from public.admin_create_booking(pg_temp.request(13,'cash_received'),gen_random_uuid());
select ok((select p.status='paid' and p.method='cash' and p.paid_at is not null and p.verified_at is null and p.verified_by is null
 from public.booking_payments p join public.bookings b on b.id=p.booking_id where b.client_id=(select id from t_clients) and b.date=(clock_timestamp() at time zone 'Europe/London')::date+13),'Cash received payment mapping does not fake verification');
insert into t_bookings select * from public.admin_create_booking(pg_temp.request(14,'bank_pending',
 '[{"service_id":"00000000-0000-0000-0000-000000008101","duration_minutes":60,"recipient_name":"Alice"},{"service_id":"00000000-0000-0000-0000-000000008101","duration_minutes":90,"recipient_name":"Bob"}]'),gen_random_uuid());
select ok((select b.treatment_duration_minutes=150 and b.travel_buffer_minutes=60 and b.service_subtotal_gbp=200 and b.total_gbp=240
 from public.bookings b where b.client_id=(select id from t_clients) and b.date=(clock_timestamp() at time zone 'Europe/London')::date+14),'Multi-session is one visit with one travel fee/buffer');
select is((select count(*)::integer from public.booking_sessions s join public.bookings b on b.id=s.booking_id where b.client_id=(select id from t_clients) and b.date=(clock_timestamp() at time zone 'Europe/London')::date+14),2,'Both recipient sessions saved');
select lives_ok($$select public.admin_create_booking(pg_temp.request(15),gen_random_uuid())$$,'More than five future bookings permitted');
select lives_ok($$select public.admin_create_booking(pg_temp.request(100),gen_random_uuid())$$,'Beyond public 40-day horizon allowed');
select lives_ok($$select public.admin_create_booking(pg_temp.request(365),gen_random_uuid())$$,'365-day boundary allowed');
select throws_ok($$select public.admin_create_booking(pg_temp.request(366),gen_random_uuid())$$,'22023','Choose a date within the next 365 days','Beyond Admin horizon rejected');
select throws_ok($$select public.admin_create_booking(pg_temp.request(-1),gen_random_uuid())$$,'22023','Choose a date within the next 365 days','Past date rejected');
select throws_ok($$select public.admin_create_booking(pg_temp.request(0) || '{"start_minutes":0}',gen_random_uuid())$$,'PT409','This time is no longer available. Choose another time.','Past same-day time rejected');
-- Deterministic near-future check, conditional only for the final hour of a day
-- where no sixty-minute treatment can finish before midnight.
select case when extract(hour from clock_timestamp() at time zone 'Europe/London')<23 then
 ok(exists(select 1 from public.admin_booking_availability((clock_timestamp() at time zone 'Europe/London')::date,60) a
   where a.start_minutes < extract(hour from clock_timestamp() at time zone 'Europe/London')::integer*60+extract(minute from clock_timestamp() at time zone 'Europe/London')::integer+120),
   'Same-day future slots have no public two-hour notice')
 else pass('No treatment can finish today in final hour; future-only filter verified separately') end;

select throws_ok($$select public.admin_create_booking(pg_temp.request(16) || '{"client_id":"00000000-0000-0000-0000-000000009999"}',gen_random_uuid())$$,'22023','Client unavailable','Invalid client rejected');
insert into public.client_addresses(client_id,address_line_1,city,postcode)
 select id,'Other address','London','SW1 1AA' from public.clients where first_name='Bounded' limit 1;
select throws_ok($$select public.admin_create_booking(pg_temp.request(16) || jsonb_build_object('saved_address_id',(select id from public.client_addresses where address_line_1='Other address')),gen_random_uuid())$$,
 '22023','Address does not belong to this client','Address ownership enforced');
select lives_ok($$select public.admin_create_booking((pg_temp.request(16)-'saved_address_id') || '{"address":{"address_line_1":"One off","city":"London","postcode":"SW7 1AA"}}',gen_random_uuid())$$,'One-off booking address accepted');
select is((select count(*)::integer from public.client_addresses where client_id=(select id from t_clients)),1,'One-off does not mutate saved addresses');
update public.services set active=false where id='00000000-0000-0000-0000-000000008101';
select throws_ok($$select public.admin_create_booking(pg_temp.request(17),gen_random_uuid())$$,'22023','Selected treatment duration is no longer available','Inactive treatment rejected');
update public.services set active=true where id='00000000-0000-0000-0000-000000008101';
update public.service_duration_prices set active=false where service_id='00000000-0000-0000-0000-000000008101' and duration_minutes=60;
select throws_ok($$select public.admin_create_booking(pg_temp.request(17),gen_random_uuid())$$,'22023','Selected treatment duration is no longer available','Inactive duration rejected');
update public.service_duration_prices set active=true where service_id='00000000-0000-0000-0000-000000008101' and duration_minutes=60;
select throws_ok($$select public.admin_create_booking(pg_temp.request(17,'bank_pending','[{"service_id":"00000000-0000-0000-0000-000000008101","duration_minutes":60,"recipient_name":"Alice","preference_ids":["00000000-0000-0000-0000-000000008104","00000000-0000-0000-0000-000000008105"]}]'),gen_random_uuid())$$,
 '22023','Selected session preferences conflict','Preference conflicts rejected');
select is((select count(*)::integer from public.bookings where client_id=(select id from t_clients) and date=(clock_timestamp() at time zone 'Europe/London')::date+17),0,'Failed preference validation atomically rolls back booking');
insert into public.calendar_blocks(kind,date,start_minutes,end_minutes,title)
 values('blocked',(clock_timestamp() at time zone 'Europe/London')::date+17,600,660,'Test block');
select throws_ok($$select public.admin_create_booking(pg_temp.request(17),gen_random_uuid())$$,'PT409','This time is no longer available. Choose another time.','Calendar block respected');
select * from public.create_booking_hold((clock_timestamp() at time zone 'Europe/London')::date+18,600,60,'admin-new-booking-test-hold');
select throws_ok($$select public.admin_create_booking(pg_temp.request(18),gen_random_uuid())$$,'PT409','This time is no longer available. Choose another time.','Active client hold respected');

create temporary table t_receipt as select b.id,b.updated_at as booking_version,p.updated_at as payment_version
 from public.bookings b join public.booking_payments p on p.booking_id=b.id
 where b.client_id=(select id from t_clients) and b.date=(clock_timestamp() at time zone 'Europe/London')::date+10;
select throws_ok($$select public.admin_record_bank_transfer_received(id,gen_random_uuid(),booking_version-interval '1 second',payment_version) from t_receipt$$,
 'PT409','Booking state changed','Stale booking version rejected');
select throws_ok($$select public.admin_record_bank_transfer_received(id,gen_random_uuid(),booking_version,payment_version-interval '1 second') from t_receipt$$,
 'PT409','Booking state changed','Stale payment version rejected');
update public.booking_payments set amount_gbp=1 where booking_id=(select id from t_receipt);
select throws_ok($$select public.admin_record_bank_transfer_received(id,gen_random_uuid(),booking_version,payment_version) from t_receipt$$,
 '22023','Payment amount needs review','Receipt refuses amount mismatch');
update public.booking_payments set amount_gbp=125 where booking_id=(select id from t_receipt);
select lives_ok($$select public.admin_record_bank_transfer_received(id,'00000000-0000-0000-0000-000000008401',booking_version,payment_version) from t_receipt$$,'Confirmed pending bank transfer can be marked received');
select ok((select p.status='paid' and p.paid_at is not null and p.verified_at is not null and p.verified_by=auth.uid() from public.booking_payments p where p.booking_id=(select id from t_receipt)),'Receipt metadata correct');
select lives_ok($$select public.admin_record_bank_transfer_received(id,'00000000-0000-0000-0000-000000008401',booking_version,payment_version) from t_receipt$$,'Receipt retry idempotent');
select throws_ok($$select public.admin_record_bank_transfer_received(id,gen_random_uuid(),booking_version,payment_version) from t_receipt$$,'PT409','Booking state changed','Concurrent second receipt loses safely');
select is((select count(*)::integer from public.command_requests where command_type='admin_record_bank_transfer_received'),1,'One receipt command');
select is((select count(*)::integer from public.event_outbox where event_type='booking.bank_transfer_received'),1,'One receipt outbox event');
update public.bookings set booking_status='completed' where client_id=(select id from t_clients) and date=(clock_timestamp() at time zone 'Europe/London')::date+14;
select lives_ok($$select public.admin_record_bank_transfer_received(b.id,gen_random_uuid(),b.updated_at,p.updated_at) from public.bookings b join public.booking_payments p on p.booking_id=b.id where b.client_id=(select id from t_clients) and b.booking_status='completed'$$,'Completed bank pending payment can be received');
select is((select count(*)::integer from public.admin_payment_review_queue(0) where id in(select t.booking_id from t_bookings t)),0,'Admin pending transfer appointments do not enter Payment Review');
select * from finish();
rollback;
