begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(68);

-- ---------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000b101', 'authenticated', 'authenticated', 'notify-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000b102', 'authenticated', 'authenticated', 'notify-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000b101');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000b201', '00000000-0000-0000-0000-00000000b102', 'Nadia', 'Notify', 'notify-client@example.test');

create function pg_temp.new_booking(p_id uuid, p_email text default 'notify-client@example.test') returns void language plpgsql as $$
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot, created_at)
  select p_id, 'NOTE-' || p_id, '00000000-0000-4000-8000-00000000b201', id, date '2031-05-05', 870, 90, 'confirmed',
    'test', '10 Quiet Street', 'London', 'SW1A 1AA', name, 85, 85, p_email, now() - interval '3 days'
  from public.service_areas where slug = 'chelsea';
  insert into public.booking_payments(booking_id, method, status, amount_gbp) values (p_id, 'cash', 'approved', 85);
end;
$$;
create function pg_temp.emit(p_type text, p_booking uuid, p_payload jsonb default '{}'::jsonb) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload) values (p_type, 'booking', p_booking, p_payload) returning id into v_id;
  return v_id;
end;
$$;
create function pg_temp.rows(p_event uuid) returns table(channel text, audience text, recipient text, title text, body text, status text, link_path text) language sql as $$
  select channel, audience, recipient, title, body, status, link_path from public.notification_deliveries where event_id = $1 order by channel, audience;
$$;

select pg_temp.new_booking('00000000-0000-4000-8000-00000000c001');
select pg_temp.new_booking('00000000-0000-4000-8000-00000000c002', null);

-- ---------------------------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.notification_deliveries', 'INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('anon', 'public.notification_deliveries', 'SELECT,INSERT,UPDATE,DELETE'), 'Browsers cannot write or read the delivery table directly');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('claim_notification_deliveries', 'complete_notification_delivery', 'plan_event_notifications', 'notification_when', 'notification_money')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))), 'The sender queue and message writers are not callable from the browser');
select ok(has_function_privilege('service_role', 'public.claim_notification_deliveries(integer,text[])', 'EXECUTE')
  and has_function_privilege('service_role', 'public.complete_notification_delivery(uuid,boolean,text)', 'EXECUTE'), 'Only the service role runs the sender queue');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('admin_list_notifications', 'admin_unread_notification_count', 'admin_mark_notifications_read') and has_function_privilege('anon', p.oid, 'EXECUTE')), 'Anonymous callers cannot reach the Admin inbox');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('claim_notification_deliveries', 'complete_notification_delivery', 'plan_event_notifications', 'admin_list_notifications', 'admin_unread_notification_count', 'admin_mark_notifications_read')
    and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'Every one runs as a definer with an empty search path');

-- ---------------------------------------------------------------------------------------------
-- Alerts for the Admin
-- ---------------------------------------------------------------------------------------------
create temp table ev(name text primary key, id uuid);
insert into ev values ('created', pg_temp.emit('booking.created', '00000000-0000-4000-8000-00000000c001', '{"booking_status":"awaiting_transfer"}'));
select results_eq($$select channel, audience, status from pg_temp.rows((select id from ev where name = 'created'))$$,
  $$values ('email'::text, 'admin'::text, 'pending'::text), ('in_app', 'admin', 'sent'), ('telegram', 'admin', 'pending')$$, 'A new online booking alerts the Admin in the app, on Telegram and by email');
select is((select title from pg_temp.rows((select id from ev where name = 'created')) where channel = 'in_app'), 'New booking request', 'The alert has a plain title');
select is((select body from pg_temp.rows((select id from ev where name = 'created')) where channel = 'in_app'),
  'Nadia Notify: Mon 5 May at 14:30, 90 minutes, £85.00. Waiting for payment.', 'The alert says who, when, how long and how much');
select is((select distinct link_path from pg_temp.rows((select id from ev where name = 'created'))), '/admin/bookings/00000000-0000-4000-8000-00000000c001', 'The alert links to the exact booking');
select is((select count(*)::integer from pg_temp.rows((select id from ev where name = 'created')) where audience = 'client'), 0, 'The client is not emailed about their own request being received');

insert into ev values ('declared', pg_temp.emit('booking.transfer_declared', '00000000-0000-4000-8000-00000000c001', '{"method":"bank_transfer"}'));
select is((select title from pg_temp.rows((select id from ev where name = 'declared')) where channel = 'telegram'), 'Nadia Notify says the transfer is made', 'A transfer declaration alerts the Admin');
select is((select body from pg_temp.rows((select id from ev where name = 'declared')) where channel = 'telegram'), '£85.00 for Mon 5 May at 14:30. Check your bank, then verify the payment.', 'It tells her what to do next');
insert into ev values ('cash', pg_temp.emit('booking.cash_requested', '00000000-0000-4000-8000-00000000c001', '{"method":"cash"}'));
select is((select title from pg_temp.rows((select id from ev where name = 'cash')) where channel = 'email' and audience = 'admin'), 'Nadia Notify would like to pay cash', 'A cash request alerts the Admin');

insert into ev values ('client_cancel_fee', pg_temp.emit('booking.cancelled', '00000000-0000-4000-8000-00000000c001', '{"initiated_by":"client","source":"client","late_fee_due_gbp":85,"refund_due_gbp":0}'));
select is((select body from pg_temp.rows((select id from ev where name = 'client_cancel_fee')) where channel = 'in_app'), 'Mon 5 May at 14:30 (£85.00). Late fee of £85.00 recorded as due.', 'A client cancellation tells the Admin about the late fee');
select is((select title from pg_temp.rows((select id from ev where name = 'client_cancel_fee')) where audience = 'client'), 'Your appointment is cancelled', 'The client gets their own confirmation');
select ok((select body like '%a late fee of £85.00 applies%' from pg_temp.rows((select id from ev where name = 'client_cancel_fee')) where audience = 'client'), 'The client email states the late fee plainly');
insert into ev values ('client_cancel_refund', pg_temp.emit('booking.cancelled', '00000000-0000-4000-8000-00000000c001', '{"initiated_by":"client","source":"client","late_fee_due_gbp":0,"refund_due_gbp":85}'));
select ok((select body like '%No late fee. Refund of £85.00 to send.' from pg_temp.rows((select id from ev where name = 'client_cancel_refund')) where channel = 'in_app'), 'A free cancellation of a paid booking tells the Admin a refund is owed');
select ok((select body like '%A refund of £85.00 is on its way to you.%' from pg_temp.rows((select id from ev where name = 'client_cancel_refund')) where audience = 'client'), 'The client is told about the refund');

insert into ev values ('admin_cancel', pg_temp.emit('booking.cancelled', '00000000-0000-4000-8000-00000000c001', '{"initiated_by":"admin"}'));
select is((select count(*)::integer from pg_temp.rows((select id from ev where name = 'admin_cancel')) where audience = 'admin'), 0, 'The Admin is not alerted about her own cancellation');
select is((select title from pg_temp.rows((select id from ev where name = 'admin_cancel')) where audience = 'client'), 'Your appointment has been cancelled', 'The client is told kindly when the Admin cancels');
insert into ev values ('admin_cancel_for_client', pg_temp.emit('booking.cancelled', '00000000-0000-4000-8000-00000000c001', '{"initiated_by":"client"}'));
select is((select count(*)::integer from pg_temp.rows((select id from ev where name = 'admin_cancel_for_client')) where audience = 'admin'), 0, 'Entering a cancellation at the client''s request is not an alert either');
select is((select title from pg_temp.rows((select id from ev where name = 'admin_cancel_for_client')) where audience = 'client'), 'Your appointment is cancelled', 'But the client still gets their confirmation');

insert into ev values ('moved_by_client', pg_temp.emit('booking.rescheduled', '00000000-0000-4000-8000-00000000c001',
  '{"initiated_by":"client","source":"client","from_date":"2031-05-01","from_start_minutes":600,"late_fee_due_gbp":85}'));
select is((select body from pg_temp.rows((select id from ev where name = 'moved_by_client')) where channel = 'in_app'), 'From Thu 1 May at 10:00 to Mon 5 May at 14:30 (£85.00). Late fee of £85.00 recorded as due.', 'A client move tells the Admin where from and to, and any fee');
select ok((select body like '%Your appointment is now on Mon 5 May at 14:30 (90 minutes) at 10 Quiet Street, London, SW1A 1AA.%a late fee of £85.00 applies%' from pg_temp.rows((select id from ev where name = 'moved_by_client')) where audience = 'client'), 'The client email gives the new time, place and fee');
insert into ev values ('moved_by_admin', pg_temp.emit('booking.rescheduled', '00000000-0000-4000-8000-00000000c001', '{"initiated_by":"admin","from_date":"2031-05-01","from_start_minutes":600}'));
select is((select count(*)::integer from pg_temp.rows((select id from ev where name = 'moved_by_admin')) where audience = 'admin'), 0, 'The Admin is not alerted about her own move');
select is((select title from pg_temp.rows((select id from ev where name = 'moved_by_admin')) where audience = 'client'), 'Your appointment has moved', 'The client is told about it');
select ok((select body not like '%late fee%' from pg_temp.rows((select id from ev where name = 'moved_by_admin')) where audience = 'client'), 'No fee is mentioned for a move the Admin chose');

-- ---------------------------------------------------------------------------------------------
-- Emails to the client
-- ---------------------------------------------------------------------------------------------
insert into ev values ('verified', pg_temp.emit('booking.bank_transfer_verified', '00000000-0000-4000-8000-00000000c001'));
select results_eq($$select channel, audience, recipient, title from pg_temp.rows((select id from ev where name = 'verified'))$$,
  $$values ('email'::text, 'client'::text, 'notify-client@example.test'::text, 'Your appointment is confirmed'::text)$$, 'Confirming a transfer emails only the client');
select ok((select body like '%I have received your payment.%{link}%Warm wishes,%Vad' from pg_temp.rows((select id from ev where name = 'verified'))), 'The email thanks them, carries the link marker and signs off warmly');
select is((select link_path from pg_temp.rows((select id from ev where name = 'verified'))), '/account?booking=00000000-0000-4000-8000-00000000c001', 'The client link goes to their own booking page');
insert into ev values ('approved', pg_temp.emit('booking.cash_approved', '00000000-0000-4000-8000-00000000c001'));
select ok((select body like '%Please pay the full amount in cash at your appointment.%' from pg_temp.rows((select id from ev where name = 'approved'))), 'A cash confirmation reminds them to bring cash');
insert into ev values ('removed', pg_temp.emit('booking.pending_removed', '00000000-0000-4000-8000-00000000c001'));
select is((select title from pg_temp.rows((select id from ev where name = 'removed'))), 'Your appointment request has been cancelled', 'Removing a pending booking tells the client without blame');
insert into ev values ('admin_created', pg_temp.emit('booking.created', '00000000-0000-4000-8000-00000000c001', '{"actor_id":"00000000-0000-0000-0000-00000000b101"}'));
select results_eq($$select audience, title from pg_temp.rows((select id from ev where name = 'admin_created'))$$,
  $$values ('client'::text, 'Your appointment is booked'::text)$$, 'A booking the Admin creates emails the client, and does not alert the Admin');
insert into ev values ('refund', pg_temp.emit('booking.refund_recorded', '00000000-0000-4000-8000-00000000c001', '{"refunded_gbp":55}'));
select is((select body from pg_temp.rows((select id from ev where name = 'refund')) limit 1), E'I have sent your refund of £55.00 for the appointment on Mon 5 May at 14:30.\n\nSee or change your booking: {link}\n\nWarm wishes,\nVad', 'A refund email says how much and for which appointment');

-- ---------------------------------------------------------------------------------------------
-- Cases that must stay quiet
-- ---------------------------------------------------------------------------------------------
insert into ev values ('no_email', pg_temp.emit('booking.bank_transfer_verified', '00000000-0000-4000-8000-00000000c002'));
select is((select count(*)::integer from pg_temp.rows((select id from ev where name = 'no_email'))), 0, 'No email is queued when the booking has no email address');
insert into ev values ('quiet', pg_temp.emit('booking.completed', '00000000-0000-4000-8000-00000000c001'));
select is((select count(*)::integer from pg_temp.rows((select id from ev where name = 'quiet'))), 0, 'Events nobody needs to hear about stay quiet');
insert into ev values ('missing', pg_temp.emit('booking.created', gen_random_uuid(), '{}'));
select is((select count(*)::integer from pg_temp.rows((select id from ev where name = 'missing'))), 0, 'An event for a booking that no longer exists is skipped');
select lives_ok($$insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload) values ('client.created', 'client', gen_random_uuid(), '{}')$$, 'Events about other things are accepted and ignored');

-- ---------------------------------------------------------------------------------------------
-- The Admin's in-app list
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b102","role":"authenticated"}', true);
select throws_ok($$select * from public.admin_list_notifications()$$, '42501', 'Admin authorization required', 'A client cannot read the Admin inbox');
select throws_ok($$select public.admin_unread_notification_count()$$, '42501', 'Admin authorization required', 'A client cannot count the Admin inbox');
select throws_ok($$select public.admin_mark_notifications_read()$$, '42501', 'Admin authorization required', 'A client cannot mark the Admin inbox read');
select is((select count(*)::integer from public.notification_deliveries), 0, 'A client sees no delivery rows, even directly');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b101","role":"authenticated"}', true);
select is(public.admin_unread_notification_count(), 6, 'The Admin has six unread alerts');
select is((select count(*)::integer from public.admin_list_notifications()), 6, 'The list holds the same six');
select ok((select bool_and(channel = 'in_app') from public.notification_deliveries), 'Directly, the Admin can only see in-app rows, never the Telegram or email text');
select is((select title from public.admin_list_notifications(1)), 'Nadia Notify moved their appointment', 'Newest first, and the limit is respected');
select is(public.admin_mark_notifications_read(array[(select id from public.admin_list_notifications(1))]), 1, 'One alert can be marked read');
select is(public.admin_unread_notification_count(), 5, 'The count drops');
select is(public.admin_mark_notifications_read(), 5, 'All can be marked read at once');
select is(public.admin_unread_notification_count(), 0, 'Nothing is left unread');
reset role;
set local role anon;
select throws_ok($$select * from public.admin_list_notifications()$$, '42501', 'permission denied for function admin_list_notifications', 'The anonymous role is refused');
reset role;

-- ---------------------------------------------------------------------------------------------
-- The sender's queue: claim, complete, retry and give up
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select throws_ok($$select * from public.claim_notification_deliveries(10, array['telegram'])$$, '42501', 'permission denied for function claim_notification_deliveries', 'A signed-in user cannot claim deliveries');
reset role;
select ok((select count(*) from public.claim_notification_deliveries(3, array['telegram'])) = 3, 'The sender claims up to its limit');
select ok((select bool_and(channel = 'telegram' and status = 'sending' and attempt_count = 1) from public.notification_deliveries where status = 'sending'), 'Only the requested channel is claimed, and the attempt is counted');
select ok(not exists (select 1 from public.claim_notification_deliveries(50, array['in_app'])), 'In-app rows are never handed to the sender');
reset role;
select is((select count(*)::integer from public.notification_deliveries where channel = 'email' and status = 'sending'), 0, 'Email rows are untouched while only Telegram is requested');

select pg_temp.new_booking('00000000-0000-4000-8000-00000000c003');
insert into ev values ('queue', pg_temp.emit('booking.transfer_declared', '00000000-0000-4000-8000-00000000c003', '{}'));
update public.notification_deliveries set status = 'sent', sent_at = now() where status in ('pending', 'sending') and event_id <> (select id from ev where name = 'queue');
create temp table one as select id, channel from public.claim_notification_deliveries(1, array['email', 'telegram']);
select is((select count(*)::integer from one), 1, 'One row was claimed from the new event');
select public.complete_notification_delivery((select id from one), true);
reset role;
select results_eq($$select status, last_error, sent_at is not null from public.notification_deliveries where id = (select id from one)$$,
  $$values ('sent'::text, null::text, true)$$, 'A successful send is recorded');

create temp table two as select id from public.claim_notification_deliveries(1, array['email', 'telegram']);
select public.complete_notification_delivery((select id from two), false, 'Telegram said no');
reset role;
select results_eq($$select status, last_error, attempt_count, next_attempt_at > now() + interval '1 minute 30 seconds' from public.notification_deliveries where id = (select id from two)$$,
  $$values ('failed'::text, 'Telegram said no'::text, 1, true)$$, 'A failure is recorded and retried after two minutes');
select is((select count(*)::integer from public.claim_notification_deliveries(10, array['email', 'telegram'])), 0, 'A failed row is not retried before its time');
reset role;
update public.notification_deliveries set next_attempt_at = now() - interval '1 second' where id = (select id from two);
select is((select count(*)::integer from public.claim_notification_deliveries(10, array['email', 'telegram'])), 1, 'It is picked up again once the delay has passed');
select public.complete_notification_delivery((select id from two), false, 'Still failing');
reset role;
select is((select attempt_count from public.notification_deliveries where id = (select id from two)), 2, 'The second attempt is counted');
select ok((select next_attempt_at > now() + interval '7 minutes' from public.notification_deliveries where id = (select id from two)), 'The delay grows: eight minutes after the second failure');
update public.notification_deliveries set attempt_count = 5, status = 'failed', next_attempt_at = now() - interval '1 hour' where id = (select id from two);
select is((select count(*)::integer from public.claim_notification_deliveries(10, array['email', 'telegram'])), 0, 'After five attempts a row is left alone but stays visible as failed');
reset role;

alter table public.notification_deliveries disable trigger notification_deliveries_set_updated_at;
update public.notification_deliveries set status = 'sending', updated_at = now() - interval '11 minutes', attempt_count = 1 where id = (select id from two);
alter table public.notification_deliveries enable trigger notification_deliveries_set_updated_at;
select is((select count(*)::integer from public.claim_notification_deliveries(10, array['email', 'telegram'])), 1, 'A row stuck sending for ten minutes is claimed again');
select public.complete_notification_delivery((select id from two), true);
select public.complete_notification_delivery((select id from two), false, 'Late duplicate report');
reset role;
select is((select status from public.notification_deliveries where id = (select id from two)), 'sent', 'A late duplicate completion cannot undo a sent row');

-- ---------------------------------------------------------------------------------------------
-- A real client command produces the right alerts
-- ---------------------------------------------------------------------------------------------
insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode)
values (current_date + 12, true, 600, 1200, 'flexible') on conflict (date) do nothing;
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot, created_at)
select '00000000-0000-4000-8000-00000000c010', 'NOTE-C010', '00000000-0000-4000-8000-00000000b201', id, current_date + 12, 660, 60, 'confirmed',
  'test', '10 Quiet Street', 'London', 'SW1A 1AA', name, 85, 85, 'notify-client@example.test', now() - interval '3 days' from public.service_areas where slug = 'chelsea';
insert into public.booking_payments(booking_id, method, status, amount_gbp) values ('00000000-0000-4000-8000-00000000c010', 'cash', 'approved', 85);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b102","role":"authenticated"}', true);
select lives_ok($$select public.client_cancel_booking('00000000-0000-4000-8000-00000000c010', gen_random_uuid(), 0, 'Change of plan')$$, 'A client cancels through the real command');
reset role;
select results_eq($$select d.channel, d.audience from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000c010' and e.event_type = 'booking.cancelled' order by 1, 2$$,
  $$values ('email'::text, 'admin'::text), ('email', 'client'), ('in_app', 'admin'), ('telegram', 'admin')$$, 'The real cancellation alerts the Admin three ways and emails the client');

select * from finish();
rollback;
