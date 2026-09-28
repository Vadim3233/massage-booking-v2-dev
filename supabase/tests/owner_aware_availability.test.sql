begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(16);
insert into public.working_hours_overrides (date, available, start_minutes, end_minutes, start_mode)
values ('2031-04-07', true, 600, 1200, 'flexible');
create temp table owner_hold as select * from public.create_booking_hold('2031-04-07',600,60,'owner-aware-client-000001') with no data;
grant select on owner_hold to anon, authenticated;
set local role anon;
select results_eq($q$select * from public.get_booking_availability('2031-04-07',60)$q$,
  $q$select generate_series(600,1140,30)$q$, 'empty flexible day shows full list');
reset role;
insert into owner_hold select * from public.create_booking_hold('2031-04-07',600,60,'owner-aware-client-000001');
set local role anon;
select results_eq($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),(select hold_token from owner_hold),'owner-aware-client-000001')$q$,
  $q$select generate_series(600,1140,30)$q$, 'verified owner still sees full list');
select results_eq($q$select * from public.get_booking_availability('2031-04-07',60)$q$,
  $q$values (720)$q$, 'other callers see held slot occupied and chain edge');
select throws_ok($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),gen_random_uuid(),'owner-aware-client-000001')$q$,
 '42501','Booking hold identity is invalid or no longer active','wrong token cannot exclude');
select throws_ok($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),(select hold_token from owner_hold),'owner-aware-client-000002')$q$,
 '42501','Booking hold identity is invalid or no longer active','wrong key cannot exclude');
select throws_ok($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold))$q$,
 '22023','Hold ID, token and browser client key must be provided together','partial identity rejected');
select throws_ok($q$select * from public.compute_booking_availability('2031-04-07',60,now(),60,(select hold_id from owner_hold))$q$,
 '42501','permission denied for function compute_booking_availability','raw exclusion function is private');
reset role;
create temp table other_hold as select * from public.create_booking_hold('2031-04-07',720,60,'owner-aware-client-000002');
set local role anon;
select results_eq($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),(select hold_token from owner_hold),'owner-aware-client-000001')$q$,
 $q$values (600),(840)$q$, 'owner exclusion keeps other holds in chain');
reset role;
select * from public.release_booking_hold((select hold_id from other_hold),(select hold_token from other_hold),'owner-aware-client-000002');
create temp table replacement as select * from public.create_booking_hold('2031-04-07',630,60,'owner-aware-client-000001');
select is((select status from public.booking_holds where id=(select hold_id from owner_hold)), 'released', 'switch releases original hold');
select is((select count(*)::integer from public.booking_holds where client_key='owner-aware-client-000001' and status='active'),1,'switch retains exactly one active hold');
set local role anon;
select throws_ok($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),(select hold_token from owner_hold),'owner-aware-client-000001')$q$,
 '42501','Booking hold identity is invalid or no longer active','released identity rejected');
reset role;
truncate owner_hold;
insert into owner_hold select * from replacement;
update public.booking_holds set expires_at=now()-interval '1 second' where id=(select hold_id from owner_hold);
set local role anon;
select throws_ok($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),(select hold_token from owner_hold),'owner-aware-client-000001')$q$,
 '42501','Booking hold identity is invalid or no longer active','expired identity rejected');
reset role;
update public.booking_holds set expires_at=now()+interval '20 minutes' where id=(select hold_id from owner_hold);
insert into public.clients(id,first_name,last_name) values('00000000-0000-4000-8000-000000008001','Owner','Test');
insert into public.bookings(booking_reference,client_id,service_area_id,date,start_minutes,treatment_duration_minutes,booking_status,source_channel,address_line_1_snapshot,city_snapshot,postcode_snapshot,service_area_name_snapshot)
select 'OWNER-CONTRACT','00000000-0000-4000-8000-000000008001',id,'2031-04-07',900,60,'confirmed','test','1 Test Road','London','SW1A 1AA',name from public.service_areas where slug='chelsea';
set local role authenticated;
select results_eq($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),(select hold_token from owner_hold),'owner-aware-client-000001')$q$,
 $q$values (780),(1020)$q$, 'signed-in owner exclusion retains real bookings');
select throws_ok($q$select * from public.compute_booking_availability('2031-04-07',60,now(),60,(select hold_id from owner_hold))$q$,
 '42501','permission denied for function compute_booking_availability','authenticated callers cannot bypass ownership validation');
reset role;
update public.booking_holds set status='consumed' where id=(select hold_id from owner_hold);
set local role anon;
select throws_ok($q$select * from public.get_booking_availability('2031-04-07',60,(select hold_id from owner_hold),(select hold_token from owner_hold),'owner-aware-client-000001')$q$,
 '42501','Booking hold identity is invalid or no longer active','consumed identity rejected');
select results_eq($q$select * from public.get_booking_availability('2031-04-07',60)$q$,
 $q$values (780),(1020)$q$, 'ordinary availability preserves real booking chain');
reset role;
select * from finish();
rollback;
