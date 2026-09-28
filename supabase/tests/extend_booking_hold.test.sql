begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(9);
insert into public.working_hours_overrides (date, available, start_minutes, end_minutes, start_mode)
values ('2031-03-04', true, 600, 1200, 'flexible');
create temp table held as select * from public.create_booking_hold('2031-03-04',600,60,'extension-test-client-000001');
grant select on held to anon, authenticated;
set local role anon;
select throws_ok($q$select * from public.extend_booking_hold((select hold_id from held), gen_random_uuid(), 'extension-test-client-000001')$q$,
  '42501', 'Booking hold token is invalid', 'wrong token cannot extend');
select throws_ok($q$select * from public.extend_booking_hold((select hold_id from held), (select hold_token from held), 'extension-test-client-000002')$q$,
  '42501', 'Booking hold token is invalid', 'wrong browser cannot extend');
select is((select expires_at from public.extend_booking_hold((select hold_id from held), (select hold_token from held), 'extension-test-client-000001')),
  (select expires_at + interval '10 minutes' from held), 'anonymous extension adds ten minutes');
reset role;
select is((select expires_at - created_at from public.booking_holds where id = (select hold_id from held)), interval '30 minutes', 'maximum deadline is thirty minutes');
set local role authenticated;
select is((select expires_at from public.extend_booking_hold((select hold_id from held), (select hold_token from held), 'extension-test-client-000001')),
  (select expires_at + interval '10 minutes' from held), 'authenticated retry cannot extend twice');
select is((select expires_at from public.create_booking_hold('2031-03-04',600,60,'extension-test-client-000001')),
  (select expires_at + interval '10 minutes' from held), 'reselecting the slot cannot reset the deadline');
select lives_ok($q$select * from public.release_booking_hold((select hold_id from held), (select hold_token from held), 'extension-test-client-000001')$q$, 'extended hold can be released');
select throws_ok($q$select * from public.extend_booking_hold((select hold_id from held), (select hold_token from held), 'extension-test-client-000001')$q$,
  '23P01', 'Your time hold has expired or been released. Please choose a time again.', 'released hold cannot extend');
reset role;
update public.booking_holds set status = 'active', expires_at = now() - interval '1 second', extended_at = null where id = (select hold_id from held);
set local role anon;
select throws_ok($q$select * from public.extend_booking_hold((select hold_id from held), (select hold_token from held), 'extension-test-client-000001')$q$,
  '23P01', 'Your time hold has expired or been released. Please choose a time again.', 'expired hold cannot extend');
reset role;
select * from finish();
rollback;
