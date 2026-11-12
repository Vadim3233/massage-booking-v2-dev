begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- Changing a booking (20261204100000_edit_booking_services.sql): the 15 examples Vadim agreed on 11 Nov 2026, and a few safety checks.
insert into auth.users(id, aud, role, email) values ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','admin@x.test'),('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','ann@x.test');
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-0000000000a1');
insert into public.clients(id, first_name, last_name, email, auth_user_id) values ('00000000-0000-4000-8000-0000000000c1','Ann','Lee','ann@x.test','00000000-0000-0000-0000-0000000000a9');
insert into public.service_areas(id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order) values ('00000000-0000-4000-8000-0000000000a2','ar','Area',true,0,0,99),('00000000-0000-4000-8000-0000000000a3','ch','Chelsea',true,0,0,98);
update public.service_areas set minimum_booking_minutes = 120 where id='00000000-0000-4000-8000-0000000000a3';
insert into public.services(id, slug, name) values ('00000000-0000-4000-8000-0000000000e1','m','Massage'),('00000000-0000-4000-8000-0000000000e2','s','Sports massage');
insert into public.service_duration_prices(service_id, duration_minutes, price_gbp) values
 ('00000000-0000-4000-8000-0000000000e1',60,90),('00000000-0000-4000-8000-0000000000e1',90,130),('00000000-0000-4000-8000-0000000000e1',120,170),('00000000-0000-4000-8000-0000000000e2',60,100);
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes) select ((clock_timestamp() at time zone 'Europe/London')::date + d), true, 540, 1380 from generate_series(0,12) d;
create function pg_temp.day(p integer) returns date language sql as $$ select (clock_timestamp() at time zone 'Europe/London')::date + p $$;
create function pg_temp.as_admin() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false) $$;
create function pg_temp.as_ann() returns void language sql as $$ select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}', false) $$;
-- p_people x 60 min massage at £90 each
create function pg_temp.mk(p_id uuid, p_day integer, p_start integer, p_pay text, p_people integer default 2, p_method text default 'bank_transfer', p_status text default 'confirmed', p_area uuid default '00000000-0000-4000-8000-0000000000a2') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status, source_channel,
    address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, service_subtotal_gbp, total_gbp, booking_email_snapshot, created_at)
  values (p_id, 'R-' || right(p_id::text, 4), '00000000-0000-4000-8000-0000000000c1', p_area, pg_temp.day(p_day), p_start, 60*p_people, p_status, 'test',
    '1 St', 'London', 'SW3 1AA', 'Area', 90*p_people, 90*p_people, 'ann@x.test', now() - interval '3 days');
  insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp, recipient_name)
  select p_id, g, '00000000-0000-4000-8000-0000000000e1', 60, 'Massage', 90, 'P' || g from generate_series(1, p_people) g;
  insert into public.booking_payments(booking_id, method, status, amount_gbp, paid_at, payment_reference) values (p_id, p_method, p_pay, 90*p_people, case when p_pay='paid' then now() end, 'R-' || right(p_id::text, 4));
end $$;
create function pg_temp.bv(p uuid) returns timestamptz language sql as $$ select updated_at from public.bookings where id=p $$;
create function pg_temp.pv(p uuid) returns timestamptz language sql as $$ select updated_at from public.booking_payments where booking_id=p $$;
create function pg_temp.sid(p uuid, pos integer) returns text language sql as $$ select id::text from public.booking_sessions where booking_id=p and position=pos $$;
create function pg_temp.ses(p uuid, pos integer, minutes integer, svc text default '00000000-0000-4000-8000-0000000000e1') returns jsonb language sql as $$ select jsonb_build_object('id', pg_temp.sid(p,pos), 'service_id', svc, 'duration_minutes', minutes, 'recipient_name', 'P' || pos) $$;
create function pg_temp.new(minutes integer) returns jsonb language sql as $$ select jsonb_build_object('service_id','00000000-0000-4000-8000-0000000000e1','duration_minutes',minutes,'recipient_name','New') $$;
-- True when the statement is refused (whatever the words), so each refusal reads as one line below.
create function pg_temp.refused(q text) returns boolean language plpgsql as $$ begin begin execute q; exception when others then return true; end; return false; end $$;
create function pg_temp.st(p uuid) returns text language sql as $$ select format('total=%s amount=%s refund=%s balance=%s mins=%s status=%s', b.total_gbp, pp.amount_gbp, b.refund_due_gbp, b.balance_due_gbp, b.treatment_duration_minutes, pp.status) from public.bookings b join public.booking_payments pp on pp.booking_id=b.id where b.id=p $$;
create function pg_temp.mail(p uuid, aud text default 'client') returns text language sql as $$ select string_agg(d.body, E'\n----\n' order by d.created_at) from public.notification_deliveries d join public.event_outbox e on e.id=d.event_id where e.aggregate_id=p and e.event_type='booking.services_changed' and d.audience=aud and d.channel in ('email','in_app') $$;
-- a client change: first time offered for the new length on the same day (or the current start if offered)
create function pg_temp.client_change(p uuid, sessions jsonb) returns jsonb language plpgsql as $$
declare v_prev jsonb; v_start integer; v_b public.bookings%rowtype; v_mins integer;
begin
  select * into v_b from public.bookings where id=p;
  v_prev := public.my_booking_change_preview(p, sessions);
  v_mins := (v_prev->>'minutes')::integer;
  select coalesce(max(start_minutes) filter (where start_minutes = v_b.start_minutes), min(start_minutes)) into v_start from public.my_booking_change_times(p, v_b.date, v_mins);
  if v_start is null then raise exception 'no time offered'; end if;
  return public.change_my_booking(p, gen_random_uuid(), sessions, v_b.date, v_start, (v_prev->>'total_gbp')::numeric);
end $$;

-- E1: 2 people -> 1, 3 days before, paid £180 by bank (client)
select pg_temp.mk('00000000-0000-4000-8000-000000000b01', 3, 960, 'paid');
select pg_temp.mk('00000000-0000-4000-8000-000000000b99', 3, 1080+60, 'paid', 1);  -- someone after, so chain matters
select pg_temp.as_ann();
select pg_temp.client_change('00000000-0000-4000-8000-000000000b01', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b01',1,60))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b01') = 'total=90.00 amount=90.00 refund=90.00 balance=0.00 mins=60 status=paid', 'E1 refund £90');

-- E2: same, today evening (inside 24 h), paid
select pg_temp.mk('00000000-0000-4000-8000-000000000b02', 0, 1200, 'paid');
select pg_temp.client_change('00000000-0000-4000-8000-000000000b02', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b02',1,60))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b02') = 'total=180.00 amount=180.00 refund=0.00 balance=0.00 mins=60 status=paid', 'E2 price stays £180, no refund');
-- E3: inside 24 h, cash
select pg_temp.mk('00000000-0000-4000-8000-000000000b03', 0, 1260, 'approved', 2, 'cash');
select pg_temp.client_change('00000000-0000-4000-8000-000000000b03', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b03',1,60))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b03') = 'total=180.00 amount=180.00 refund=0.00 balance=0.00 mins=60 status=approved', 'E3 cash: still £180');
select ok(pg_temp.mail('00000000-0000-4000-8000-000000000b03') like '%price stays £180.00.%full £180.00 ready in cash%', 'E3 message');
-- E4: 1 h -> 2 h, 4 days before, not paid
select pg_temp.mk('00000000-0000-4000-8000-000000000b04', 4, 600, 'awaiting_transfer', 1);
select pg_temp.client_change('00000000-0000-4000-8000-000000000b04', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b04',1,120))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b04') = 'total=170.00 amount=170.00 refund=0.00 balance=0.00 mins=120 status=awaiting_transfer', 'E4 now £170 to pay');
-- E5: inside 24 h, paid £90, 1 h -> 2 h: £80 still to pay; Vadim marks it received
-- (Its time follows the clock, so the test passes at any hour: the next half hour with no notice, before E2's 20:00; late in the evening,
-- tomorrow at 09:00, which is still inside 24 h.)
create temp table e5_notice as select value from public.business_settings where key = 'minimum_notice_minutes';
insert into public.business_settings(key, value) values ('minimum_notice_minutes', '0') on conflict (key) do update set value = excluded.value;
create function pg_temp.e5() returns table (d integer, s integer) language sql as $$
  with m as (select (extract(hour from clock_timestamp() at time zone 'Europe/London') * 60 + extract(minute from clock_timestamp() at time zone 'Europe/London'))::integer as now_min),
       c as (select greatest(570, (ceil(now_min / 30.0) * 30)::integer + 30) as start from m)
  select case when start <= 1080 then 0 else 1 end, case when start <= 1080 then start else 540 end from c $$;
select pg_temp.mk('00000000-0000-4000-8000-000000000b05', (select d from pg_temp.e5()), (select s from pg_temp.e5()), 'paid', 1);
select pg_temp.client_change('00000000-0000-4000-8000-000000000b05', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b05',1,120))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b05') = 'total=170.00 amount=90.00 refund=0.00 balance=80.00 mins=120 status=paid', 'E5 £80 still to pay');
select ok(pg_temp.mail('00000000-0000-4000-8000-000000000b05') like '%Please pay the extra £80.00 by bank transfer, using the reference R-0b05%', 'E5 message asks for £80');
select pg_temp.as_admin();
select public.admin_record_balance_received('00000000-0000-4000-8000-000000000b05', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b05')) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b05') = 'total=170.00 amount=170.00 refund=0.00 balance=0.00 mins=120 status=paid', 'E5 extra received');
select ok((select coalesce(sum(net_gbp),0) = 170 from public.income_lines(pg_temp.day((select d from pg_temp.e5())), pg_temp.day((select d from pg_temp.e5()))) where booking_id='00000000-0000-4000-8000-000000000b05'), 'E5 income £170');
delete from public.business_settings where key = 'minimum_notice_minutes';
insert into public.business_settings(key, value) select 'minimum_notice_minutes', value from e5_notice;
-- E7: 2 x 1 h -> 1 x 2 h, 5 days before, paid: £10 refund
select pg_temp.mk('00000000-0000-4000-8000-000000000b07', 5, 600, 'paid');
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b07', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b07'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b07',1,120))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b07') = 'total=170.00 amount=170.00 refund=10.00 balance=0.00 mins=120 status=paid', 'E7 £10 refund');
-- E8: inside 24 h: 2 h -> 1 h (stays £180), then back to 2 x 1 h: nothing extra
select pg_temp.mk('00000000-0000-4000-8000-000000000b08', 0, 720, 'paid');
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b08', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b08'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b08',1,60))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b08') = 'total=180.00 amount=180.00 refund=0.00 balance=0.00 mins=60 status=paid', 'E8 first change keeps £180');
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b08', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b08'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b08',1,60), pg_temp.new(60))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b08') = 'total=180.00 amount=180.00 refund=0.00 balance=0.00 mins=120 status=paid', 'E8 back to 2 h, nothing extra');
-- E9a: refund not sent yet, then more time: the refund owed shrinks first
select pg_temp.mk('00000000-0000-4000-8000-000000000b09', 6, 600, 'paid');
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b09', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b09'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b09',1,60))) is not null;
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b09', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b09'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b09',1,120))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b09') = 'total=170.00 amount=170.00 refund=10.00 balance=0.00 mins=120 status=paid', 'E9a refund owed goes 90 -> 10');
-- E9b: refund sent, then more time: £80 to pay
select pg_temp.mk('00000000-0000-4000-8000-000000000b10', 6, 900, 'paid');
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b10', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b10'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b10',1,60))) is not null;
select public.admin_record_refund('00000000-0000-4000-8000-000000000b10', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b10'), pg_temp.pv('00000000-0000-4000-8000-000000000b10')) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b10') = 'total=90.00 amount=90.00 refund=0.00 balance=0.00 mins=60 status=paid', 'E9b refund recorded, still paid');
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b10', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b10'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b10',1,120))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b10') = 'total=170.00 amount=90.00 refund=0.00 balance=80.00 mins=120 status=paid', 'E9b £80 to pay');
-- E10: Massage -> Sports massage, not paid
select pg_temp.mk('00000000-0000-4000-8000-000000000b11', 7, 600, 'awaiting_transfer', 1);
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b11', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b11'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b11',1,60,'00000000-0000-4000-8000-0000000000e2'))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b11') = 'total=100.00 amount=100.00 refund=0.00 balance=0.00 mins=60 status=awaiting_transfer', 'E10 £100');
-- E11: area with a 2 h minimum: the client is refused, Vadim is not
select pg_temp.mk('00000000-0000-4000-8000-000000000b12', 8, 600, 'paid', 2, 'bank_transfer', 'confirmed', '00000000-0000-4000-8000-0000000000a3');
select pg_temp.as_ann();
select ok(pg_temp.refused($q$ select pg_temp.client_change('00000000-0000-4000-8000-000000000b12', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b12',1,60))) $q$), 'E11 client below minimum is refused');
select pg_temp.as_admin();
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b12', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b12'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b12',1,60))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b12') like 'total=90.00%', 'E11 Vadim can');
-- E12: transfer to check (£90 sent), 1 h -> 2 h: £80 more
select pg_temp.mk('00000000-0000-4000-8000-000000000b13', 9, 600, 'awaiting_verification', 1, 'bank_transfer', 'awaiting_payment_verification');
select pg_temp.as_ann();
select pg_temp.client_change('00000000-0000-4000-8000-000000000b13', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b13',1,120))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b13') = 'total=170.00 amount=90.00 refund=0.00 balance=80.00 mins=120 status=awaiting_verification', 'E12 £80 more');
-- E14: started: the client cannot; Vadim keeps the price by default, or lowers it
select pg_temp.mk('00000000-0000-4000-8000-000000000b14', 0, 0, 'paid');
select ok(pg_temp.refused($q$ select public.my_booking_change_preview('00000000-0000-4000-8000-000000000b14', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b14',1,60))) $q$), 'E14 client after start is refused');
select pg_temp.as_admin();
select ok((public.admin_preview_booking_change('00000000-0000-4000-8000-000000000b14', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b14',1,60)))->>'total_gbp')::numeric = 180, 'E14 preview keeps £180');
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b14', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b14'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b14',1,60)), null, null, false, true, true) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b14') = 'total=90.00 amount=90.00 refund=90.00 balance=0.00 mins=60 status=paid', 'E14 lowered anyway: refund £90');
select ok(pg_temp.mail('00000000-0000-4000-8000-000000000b14') is null, 'E14 no email for a started appointment');
-- E15: request not confirmed yet, bank, not paid
select pg_temp.mk('00000000-0000-4000-8000-000000000b15', 10, 600, 'awaiting_transfer', 2, 'bank_transfer', 'awaiting_transfer');
select pg_temp.as_ann();
select pg_temp.client_change('00000000-0000-4000-8000-000000000b15', jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b15',2,60))) is not null;
select ok(pg_temp.st('00000000-0000-4000-8000-000000000b15') = 'total=90.00 amount=90.00 refund=0.00 balance=0.00 mins=60 status=awaiting_transfer', 'E15 request now £90');
select ok((select count(*) = 3 from public.notification_deliveries d join public.event_outbox e on e.id=d.event_id where e.aggregate_id='00000000-0000-4000-8000-000000000b15' and d.audience='admin'), 'E15 Vadim alerted (app, Telegram, email)');
-- Safety: the price shown must be the price saved; same request twice is one change; cancel adds to a refund owed
select pg_temp.mk('00000000-0000-4000-8000-000000000b16', 3, 600, 'paid');
select ok(pg_temp.refused($q$ select public.change_my_booking('00000000-0000-4000-8000-000000000b16', gen_random_uuid(), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b16',1,60)), pg_temp.day(3), (select min(start_minutes) from public.my_booking_change_times('00000000-0000-4000-8000-000000000b16', pg_temp.day(3), 60)), 180) $q$), 'a price shown that is out of date is refused');
select pg_temp.as_admin();
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b16', '00000000-0000-4000-8000-0000000000f1', pg_temp.bv('00000000-0000-4000-8000-000000000b16'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b16',1,60)), null, null, false, false) is not null;
select public.admin_cancel_booking('00000000-0000-4000-8000-000000000b16', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b16'), pg_temp.pv('00000000-0000-4000-8000-000000000b16'), 'test', 'admin', 0) is not null;
select ok((select refund_due_gbp = 180 from public.bookings where id='00000000-0000-4000-8000-000000000b16'), 'cancel after a lower price: refund all £180');
select public.admin_record_refund('00000000-0000-4000-8000-000000000b16', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b16'), pg_temp.pv('00000000-0000-4000-8000-000000000b16')) is not null;
select ok((select coalesce(sum(net_gbp),0) = 0 from public.income_lines(pg_temp.day(3), pg_temp.day(3)) where booking_id='00000000-0000-4000-8000-000000000b16'), 'income nets to 0');
-- Receipt corrected after a change on a paid booking
select pg_temp.mk('00000000-0000-4000-8000-000000000b17', 11, 600, 'paid');
select (public.issue_receipt('00000000-0000-4000-8000-000000000b17', '00000000-0000-0000-0000-0000000000a1')).id is not null;
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b17', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b17'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b17',2,60)), null, null, false, false) is not null;
select ok((select (snapshot->>'total')::numeric = 90 and (snapshot->'payment'->>'amount')::numeric = 90 and jsonb_array_length(snapshot->'treatments') = 1 and edit_count = 1 from public.booking_receipts where booking_id='00000000-0000-4000-8000-000000000b17'), 'receipt corrected');
-- Longer into the next appointment (Vadim, same time): refused
select pg_temp.mk('00000000-0000-4000-8000-000000000b18', 12, 600, 'paid', 1);
select pg_temp.mk('00000000-0000-4000-8000-000000000b19', 12, 660, 'paid', 1);
select ok(pg_temp.refused($q$ select public.admin_edit_booking('00000000-0000-4000-8000-000000000b18', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b18'), jsonb_build_array(pg_temp.ses('00000000-0000-4000-8000-000000000b18',1,90))) $q$), 'longer runs into next is refused');
-- 3 people, moved with any time, reordered
select public.admin_edit_booking('00000000-0000-4000-8000-000000000b18', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b18'), jsonb_build_array(pg_temp.new(60), pg_temp.ses('00000000-0000-4000-8000-000000000b18',1,60), pg_temp.new(60)), pg_temp.day(12), 1200, true, false, false) is not null;
select ok((select start_minutes = 1200 and treatment_duration_minutes = 180 from public.bookings where id='00000000-0000-4000-8000-000000000b18'), 'moved to 20:00, 3 people');
select ok(pg_temp.refused($q$ select public.admin_edit_booking('00000000-0000-4000-8000-000000000b18', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b18'), jsonb_build_array(pg_temp.new(120), pg_temp.new(120), pg_temp.new(60))) $q$), 'over 4 hours is refused');
select ok(pg_temp.refused($q$ select public.admin_edit_booking('00000000-0000-4000-8000-000000000b18', gen_random_uuid(), pg_temp.bv('00000000-0000-4000-8000-000000000b18'), jsonb_build_array(pg_temp.new(60),pg_temp.new(60),pg_temp.new(60),pg_temp.new(60),pg_temp.new(60))) $q$), '5 people is refused');
-- Not the Admin: refused
select pg_temp.as_ann();
select ok(pg_temp.refused($q$ select public.admin_preview_booking_change('00000000-0000-4000-8000-000000000b18', jsonb_build_array(pg_temp.new(60))) $q$), 'client cannot use admin preview is refused');
select ok(pg_temp.refused($q$ select public.my_booking_change_preview('00000000-0000-4000-8000-000000000b18', '[]') $q$), 'empty people is refused');


select * from finish();
rollback;
