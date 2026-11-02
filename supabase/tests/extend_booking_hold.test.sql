begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

-- Holding a time needs a session (ADR-086): each browser key below holds as its own guest session.
create function pg_temp.as_guest(p_key text) returns void language plpgsql as $guest$
declare v_id uuid := md5('guest:' || p_key)::uuid;
begin
  insert into auth.users(id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_id, 'authenticated', 'authenticated', true, '{}', '{}', now(), now()) on conflict (id) do nothing;
  perform set_config('request.jwt.claims', json_build_object('sub', v_id, 'role', 'authenticated', 'is_anonymous', true)::text, true);
end;
$guest$;
select plan(9);

-- Inside the 40-day client booking horizon, so the test does not rot as the calendar moves.
select set_config('test.horizon_date',((now() at time zone 'Europe/London')::date + 32)::text,true);
insert into public.working_hours_overrides (date, available, start_minutes, end_minutes, start_mode)
values (current_setting('test.horizon_date')::date, true, 600, 1200, 'flexible');
select pg_temp.as_guest('extension-test-client-000001');
create temp table held as select * from public.create_booking_hold(current_setting('test.horizon_date')::date,600,60,'extension-test-client-000001');
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
select is((select expires_at from public.create_booking_hold(current_setting('test.horizon_date')::date,600,60,'extension-test-client-000001')),
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
