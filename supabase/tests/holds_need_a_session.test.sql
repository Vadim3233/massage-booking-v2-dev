begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(6);

-- Holding a time needs a session, and one session holds one time at most (ADR-086).
select set_config('test.day', ((now() at time zone 'Europe/London')::date + 30)::text, true);
delete from public.calendar_blocks where date = current_setting('test.day')::date;
delete from public.working_hours_overrides where date = current_setting('test.day')::date;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
values (current_setting('test.day')::date, true, 600, 1200, 'flexible');
insert into auth.users(id, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000d101', 'authenticated', 'authenticated', true, '{}', '{}', now(), now());

select ok(not has_function_privilege('anon', 'public.create_booking_hold(date, integer, integer, text)', 'EXECUTE'),
  'Without a session nobody can hold a time');

-- Even a caller that reaches the function without a session is refused.
select throws_ok($$select * from public.create_booking_hold(current_setting('test.day')::date, 600, 60, 'session-rule-key-000000000001')$$,
  '42501', 'Please refresh the page and choose your time again.', 'The function itself refuses a caller with no session');

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000d101', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
create temp table first_hold as select * from public.create_booking_hold(current_setting('test.day')::date, 600, 60, 'session-rule-key-000000000001');
select ok((select hold_id from first_hold) is not null, 'A guest session can hold a time');
-- The same session with another made-up browser key: the first time is let go, so one session cannot hold many times.
create temp table second_hold as select * from public.create_booking_hold(current_setting('test.day')::date, 840, 60, 'session-rule-key-000000000002');
reset role;
select is((select status from public.booking_holds where id = (select hold_id from first_hold)), 'released',
  'A second hold from the same session lets go of the first');
select is((select count(*)::integer from public.booking_holds
  where holder_user_id = '00000000-0000-0000-0000-00000000d101' and status = 'active' and expires_at > now()), 1,
  'One session holds one time at most');
select is((select holder_user_id from public.booking_holds where id = (select hold_id from second_hold)),
  '00000000-0000-0000-0000-00000000d101'::uuid, 'The hold records its session');

select * from finish();
rollback;
