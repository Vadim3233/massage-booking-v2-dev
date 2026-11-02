begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(9);

-- Follow-ups from the review of the security fixes (ADR-093).
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000da01', 'authenticated', 'authenticated', 'follow-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000da02', 'authenticated', 'authenticated', 'follow-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000da01');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000da11', '00000000-0000-0000-0000-00000000da02', 'Fola', 'Lowup', 'follow-client@example.test');

-- A paid £85 booking ten days ahead, moved late earlier (£85 fee due), and one with no fee.
create function pg_temp.b(p_id uuid, p_fee_status text, p_start integer) returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, created_at, late_fee_standard_gbp, late_fee_due_gbp, late_fee_status)
  select p_id, 'FOLLOW-' || p_id, '00000000-0000-4000-8000-00000000da11', id, ((now() at time zone 'Europe/London') + interval '10 days')::date,
    p_start, 60, 'confirmed', 'test', '1 Test Road', name, 85, 85, now() - interval '3 days',
    case when p_fee_status = 'none' then 0 else 85 end, case when p_fee_status = 'none' then 0 else 85 end, p_fee_status
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at) values (p_id, 'bank_transfer', 'paid', 85, now());
end $$;
select pg_temp.b('00000000-0000-4000-8000-00000000da21', 'due', 600);
select pg_temp.b('00000000-0000-4000-8000-00000000da22', 'none', 840);

-- The Admin takes the late-move fee on its own, then the client cancels.
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000da01', 'role', 'authenticated')::text, true);
set local role authenticated;
select lives_ok($$select public.admin_settle_late_fee('00000000-0000-4000-8000-00000000da21', gen_random_uuid(),
  (select updated_at from public.bookings where id = '00000000-0000-4000-8000-00000000da21'), 'received')$$, 'The Admin marks the late-move fee received');
reset role;
select ok((select late_fee_paid_separately from public.bookings where id = '00000000-0000-4000-8000-00000000da21'), 'It is recorded as paid on its own');

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000da02', 'role', 'authenticated')::text, true);
set local role authenticated;
select ok((public.get_my_change_terms('00000000-0000-4000-8000-00000000da21')->>'fee_from_late_move')::boolean, 'The client is told the fee comes from the earlier late move');
select ok(not (public.get_my_change_terms('00000000-0000-4000-8000-00000000da22')->>'fee_from_late_move')::boolean, 'An ordinary booking says nothing of the kind');
select lives_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000da21', gen_random_uuid(), 85)$$, 'The client cancels, acknowledging the fee');
reset role;
select results_eq($$select refund_due_gbp, late_fee_status from public.bookings where id = '00000000-0000-4000-8000-00000000da21'$$,
  $$values (85.00::numeric, 'received'::text)$$, 'The fee already paid on its own is not taken again: the whole payment is refunded');
-- Once the refund is sent, Income keeps the fee taken on its own.
update public.booking_payments set status = 'refunded', refunded_gbp = 85, refunded_at = now() where booking_id = '00000000-0000-4000-8000-00000000da21';
select is((select net_gbp from public.income_lines(((now() at time zone 'Europe/London') + interval '10 days')::date, ((now() at time zone 'Europe/London') + interval '10 days')::date)
  where booking_id = '00000000-0000-4000-8000-00000000da21'), 85.00::numeric, 'Income still counts the fee once the payment is refunded');

-- A held time kept by "still fits" needs blocked time clear of its travel too.
select set_config('test.day', ((now() at time zone 'Europe/London')::date + 20)::text, true);
delete from public.calendar_blocks where date = current_setting('test.day')::date;
delete from public.working_hours_overrides where date = current_setting('test.day')::date;
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode) values (current_setting('test.day')::date, true, 600, 1320, 'flexible');
insert into public.calendar_blocks(date, start_minutes, end_minutes, kind, title) values (current_setting('test.day')::date, 1110, 1140, 'blocked', 'Follow-up block');
select ok(not public.held_time_still_fits(current_setting('test.day')::date, 1020, 60, 60, now()), 'Blocked time inside the travel after a held time means it no longer fits');

-- Tables made later do not get the permissions taken away in ADR-091.
create table public.follow_up_probe(id integer);
select ok(not has_table_privilege('authenticated', 'public.follow_up_probe', 'TRUNCATE') and not has_table_privilege('anon', 'public.follow_up_probe', 'TRUNCATE'),
  'A new table cannot be emptied by signed-in or anonymous users');

select * from finish();
rollback;
