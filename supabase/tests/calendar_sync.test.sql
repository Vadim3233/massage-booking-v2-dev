begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(54);

-- Privileges: nothing new can be read or changed from a browser, the token least of all.
select ok(not exists (
  select 1 from unnest(array['public.calendar_connection', 'public.calendar_sync_events', 'public.calendar_sync_queue']) t
  where has_table_privilege('anon', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('authenticated', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
), 'Browsers, the Admin included, cannot read or write the calendar tables');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.calendar_connection'::regclass, 'public.calendar_sync_events'::regclass, 'public.calendar_sync_queue'::regclass)), 'Row security is on for all three');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('calendar_desired_events', 'claim_calendar_sync', 'complete_calendar_sync', 'calendar_save_connection', 'calendar_refresh_token', 'calendar_forget_connection', 'queue_calendar_sync', 'calendar_queue_all', 'calendar_queue_out_of_step', 'calendar_queue_booking', 'calendar_queue_session', 'calendar_queue_client')
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
), 'Only the server can run the sync functions or read the token');
select ok(has_function_privilege('service_role', 'public.calendar_refresh_token()', 'EXECUTE') and has_function_privilege('service_role', 'public.claim_calendar_sync(integer)', 'EXECUTE'), 'The server job can');
select ok(not has_function_privilege('anon', 'public.admin_calendar_status()', 'EXECUTE') and not has_function_privilege('anon', 'public.admin_calendar_resync()', 'EXECUTE'), 'A visitor cannot see the status or resync');
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%calendar%'), 'Every calendar function is a definer with an empty search path');

-- Fixtures: one client with every detail filled in, so the description can be checked for what it must never say.
insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000c501', 'authenticated', 'authenticated', 'calendar-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000c502', 'authenticated', 'authenticated', 'calendar-client@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000c501');
insert into public.clients(id, first_name, last_name, email, phone) values ('00000000-0000-4000-8000-00000000c501', 'Amelia', 'Stone', 'amelia-secret@example.test', '+447700900555');
create temporary table fx_area as select id, name from public.service_areas where slug = 'chelsea';
create function pg_temp.booking(p_n integer, p_status text, p_date date, p_start integer, p_minutes integer default 60, p_buffer integer default 60)
returns uuid language plpgsql as $$
declare v_id uuid := ('00000000-0000-4000-8000-0000000c' || lpad(p_n::text, 4, '0'))::uuid;
begin
  insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, travel_buffer_minutes, booking_status,
    source_channel, address_line_1_snapshot, city_snapshot, postcode_snapshot, service_area_name_snapshot, client_note, total_gbp, booking_email_snapshot, cancelled_at)
  select v_id, 'CAL-' || p_n, '00000000-0000-4000-8000-00000000c501', id, p_date, p_start, p_minutes, p_buffer, p_status,
    'test', '9 Secret Road', 'London', 'SW9 9ZZ', name, 'Bad knee, gate code 4321', 123.45, 'amelia-secret@example.test', case when p_status = 'cancelled' then now() end
  from fx_area;
  insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp)
  select v_id, 1, s.id, p_minutes, 'Deep tissue', 123.45 from public.services s order by s.created_at limit 1;
  return v_id;
end $$;
create function pg_temp.title(p_id uuid) returns text language sql as $$ select title from public.calendar_desired_events(null, null, array[p_id]) where kind = 'booking' $$;

-- One check per booking status: shown or not, and the exact title.
select is(pg_temp.title(pg_temp.booking(1, 'confirmed', '2031-03-03', 600)), 'Massage – Amelia Stone', 'Confirmed: Massage');
select is(pg_temp.title(pg_temp.booking(2, 'awaiting_transfer', '2031-03-03', 720)), '⏳ Awaiting payment – Amelia Stone', 'Waiting for a transfer');
select is(pg_temp.title(pg_temp.booking(3, 'awaiting_payment_verification', '2031-03-03', 840)), '⏳ Payment being checked – Amelia Stone', 'Transfer being checked');
select is(pg_temp.title(pg_temp.booking(4, 'awaiting_cash_approval', '2031-03-03', 960)), '⏳ Awaiting cash approval – Amelia Stone', 'Cash waiting for approval');
select is(pg_temp.title(pg_temp.booking(5, 'completed', '2031-03-04', 600)), '✓ Massage – Amelia Stone', 'Completed stays, as history');
select is(pg_temp.title(pg_temp.booking(6, 'no_show', '2031-03-04', 720)), 'No-show – Amelia Stone', 'No-show stays, as history');
select pg_temp.booking(7, 'cancelled', '2031-03-04', 840);
select is((select count(*)::int from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0007'::uuid])), 0, 'Cancelled: nothing, not even travel');
-- Nothing lapses: a booking waiting for a transfer stays, whatever its old reservation time says.
update public.bookings set payment_reservation_expires_at = now() - interval '1 day' where id = '00000000-0000-4000-8000-0000000c0002';
select is(pg_temp.title('00000000-0000-4000-8000-0000000c0002'), '⏳ Awaiting payment – Amelia Stone', 'A booking waiting for money never lapses from the calendar');
-- A time being held while a client books is never shown.
select is((select count(*)::int from public.calendar_desired_events() d where d.booking_id not in (select id from public.bookings)), 0, 'Only real bookings are shown (never a hold)');

-- Times in London, the travel event, and the description. (Bookings are made first: a lookup sees the database as it was when its statement began.)
select pg_temp.booking(8, 'confirmed', '2031-03-05', 600, 120, 45), pg_temp.booking(9, 'confirmed', '2031-03-05', 900, 60, 0),
  pg_temp.booking(10, 'confirmed', '2026-10-24', 600), pg_temp.booking(11, 'confirmed', '2026-10-25', 600), pg_temp.booking(12, 'confirmed', '2026-10-26', 600);
select results_eq($$select kind, title, starts_at, ends_at, description from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0001'::uuid]) order by starts_at$$,
  $$values ('booking'::text, 'Massage – Amelia Stone'::text, '2031-03-03 10:00+00'::timestamptz, '2031-03-03 11:00+00'::timestamptz, 'Deep tissue 60 min · 60 min total'::text),
           ('travel', 'Travel', '2031-03-03 11:00+00', '2031-03-03 12:00+00', '')$$, 'A booking, then Travel for its own buffer');
select is((select ends_at - starts_at from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0008'::uuid]) where kind = 'travel'), interval '45 minutes', 'Travel is as long as that booking''s own buffer');
select is((select count(*)::int from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0009'::uuid])), 1, 'A buffer of 0 gives no travel event');
insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp, recipient_name)
select '00000000-0000-4000-8000-0000000c0008', 2, s.id, 60, 'Sports', 50, 'Guest Name' from public.services s order by s.created_at limit 1;
update public.booking_sessions set duration_minutes = 60 where booking_id = '00000000-0000-4000-8000-0000000c0008' and position = 1;
select is((select description from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0008'::uuid]) where kind = 'booking'), 'Deep tissue 60 min + Sports 60 min · 120 min total', 'Two sessions: each with its length, then the total');
select ok(not exists (
  select 1 from public.calendar_desired_events() d, unnest(array['Secret Road', 'SW9', 'amelia-secret', '07700', '447700', '123.45', '£', 'Bad knee', '4321', 'Guest Name', 'CAL-', 'c0001']) secret
  where d.booking_id::text like '00000000-0000-4000-8000-0000000c%' and (d.title || ' ' || d.description) ilike '%' || secret || '%'
), 'Never the address, email, phone, price, notes, a guest''s name, the reference or an id');
select ok((select bool_and(google_event_id ~ '^vm[0-9a-v]{32}[bt]$') from public.calendar_desired_events()), 'Event ids are fixed by the booking, in the letters Google allows');
select is((select google_event_id from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0001'::uuid]) where kind = 'travel'), 'vm000000000000400080000000000c0001t', 'The travel event id is the booking''s with t');

-- The clocks go back on Sunday 25 October 2026: 10:00 in London is 09:00 UTC before and 10:00 UTC after.
select is((select starts_at from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0010'::uuid]) where kind = 'booking'), '2026-10-24 09:00+00'::timestamptz, 'Saturday 24 Oct: summer time');
select is((select starts_at from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0011'::uuid]) where kind = 'booking'), '2026-10-25 10:00+00'::timestamptz, 'Sunday 25 Oct: winter time from 02:00');
select is((select starts_at from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0012'::uuid]) where kind = 'booking'), '2026-10-26 10:00+00'::timestamptz, 'Monday 26 Oct: winter time');
select is((select count(*)::int from public.calendar_desired_events('2026-10-24', '2026-10-25') where kind = 'booking' and booking_id::text like '%0000000c%'), 2, 'A date window takes only the bookings in it');

-- The content fingerprint changes when what Google shows would change, and only then.
create temporary table fx_hash as select content_hash from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0001'::uuid]) where kind = 'booking';
update public.bookings set client_note = 'Changed note', total_gbp = 99 where id = '00000000-0000-4000-8000-0000000c0001';
select is((select content_hash from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0001'::uuid]) where kind = 'booking'), (select content_hash from fx_hash), 'A note or price change does not change the event');
update public.clients set last_name = 'Stone-Hill' where id = '00000000-0000-4000-8000-00000000c501';
select isnt((select content_hash from public.calendar_desired_events(null, null, array['00000000-0000-4000-8000-0000000c0001'::uuid]) where kind = 'booking'), (select content_hash from fx_hash), 'A name change does');

-- The queue: what changes a booking's events puts it in; anything else does not.
delete from public.calendar_sync_queue;
update public.bookings set client_note = 'Another note' where id = '00000000-0000-4000-8000-0000000c0001';
select is((select count(*)::int from public.calendar_sync_queue), 0, 'A note change queues nothing');
update public.bookings set booking_status = 'cancelled', cancelled_at = now() where id = '00000000-0000-4000-8000-0000000c0001';
select is((select array_agg(booking_id) from public.calendar_sync_queue), array['00000000-0000-4000-8000-0000000c0001'::uuid], 'A status change queues the booking');
delete from public.calendar_sync_queue;
update public.bookings set date = '2031-03-10', start_minutes = 660 where id = '00000000-0000-4000-8000-0000000c0002';
update public.booking_sessions set service_name_snapshot = 'Swedish' where booking_id = '00000000-0000-4000-8000-0000000c0003';
select is((select count(*)::int from public.calendar_sync_queue), 2, 'A move and a treatment change queue their bookings, once each');
delete from public.calendar_sync_queue;
update public.clients set first_name = 'Amy' where id = '00000000-0000-4000-8000-00000000c501';
select is((select count(*)::int from public.calendar_sync_queue), (select count(*)::int from public.bookings where client_id = '00000000-0000-4000-8000-00000000c501'), 'A client''s new name queues all their bookings');
delete from public.calendar_sync_queue;
update public.clients set phone = '+447700900556' where id = '00000000-0000-4000-8000-00000000c501';
select is((select count(*)::int from public.calendar_sync_queue), 0, 'A new phone number queues nothing');
delete from public.booking_sessions where booking_id = '00000000-0000-4000-8000-0000000c0009';
delete from public.bookings where id = '00000000-0000-4000-8000-0000000c0009';
select ok(exists (select 1 from public.calendar_sync_queue where booking_id = '00000000-0000-4000-8000-0000000c0009'), 'A booking deleted outright is queued, so its events are removed');

-- The job takes a booking, says how it went, and is retried and then stopped on failure.
delete from public.calendar_sync_queue;
select public.queue_calendar_sync(array['00000000-0000-4000-8000-0000000c0004'::uuid, '00000000-0000-4000-8000-0000000c0005'::uuid]);
create temporary table fx_claim as select * from public.claim_calendar_sync(10);
select is((select count(*)::int from fx_claim), 2, 'The job takes what is due');
select is((select count(*)::int from public.claim_calendar_sync(10)), 0, 'and no other run takes the same again');
select public.complete_calendar_sync(booking_id, queued_at) from fx_claim where booking_id = '00000000-0000-4000-8000-0000000c0004';
select ok(not exists (select 1 from public.calendar_sync_queue where booking_id = '00000000-0000-4000-8000-0000000c0004'), 'Done: it leaves the queue');
select public.complete_calendar_sync(booking_id, queued_at, 'Google said 503') from fx_claim where booking_id = '00000000-0000-4000-8000-0000000c0005';
select ok((select last_error = 'Google said 503' and failed_at is null and next_attempt_at > clock_timestamp() + interval '1 minute' from public.calendar_sync_queue where booking_id = '00000000-0000-4000-8000-0000000c0005'), 'Failed: kept, with the reason, for a later try');
update public.calendar_sync_queue set attempt_count = 5 where booking_id = '00000000-0000-4000-8000-0000000c0005';
select public.complete_calendar_sync(booking_id, queued_at, 'Google said 503 again') from fx_claim where booking_id = '00000000-0000-4000-8000-0000000c0005';
select ok((select failed_at is not null from public.calendar_sync_queue where booking_id = '00000000-0000-4000-8000-0000000c0005'), 'After 5 tries it is marked failed');
-- Changed again while the job was working on it: it stays to be checked again.
select public.queue_calendar_sync(array['00000000-0000-4000-8000-0000000c0006'::uuid]);
create temporary table fx_claim2 as select * from public.claim_calendar_sync(10);
update public.bookings set start_minutes = 780 where id = '00000000-0000-4000-8000-0000000c0006';
select public.complete_calendar_sync(booking_id, queued_at) from fx_claim2;
select ok(exists (select 1 from public.calendar_sync_queue where booking_id = '00000000-0000-4000-8000-0000000c0006' and attempt_count = 0), 'A booking changed meanwhile is checked again');

-- The 15-minute check finds what is out of step with what was put in Google; nothing more.
delete from public.calendar_sync_queue;
delete from public.calendar_sync_events;
insert into public.calendar_sync_events(booking_id, kind, google_event_id, content_hash) select booking_id, kind, google_event_id, content_hash from public.calendar_desired_events();
select is(public.calendar_queue_out_of_step(), 0, 'Nothing is queued when Google has what is wanted');
update public.calendar_sync_events set content_hash = 'old' where booking_id = '00000000-0000-4000-8000-0000000c0003' and kind = 'booking';
insert into public.calendar_sync_events(booking_id, kind, google_event_id, content_hash) values ('00000000-0000-4000-8000-0000000c0999', 'travel', 'vm000000000000400080000000000c0999t', 'gone');
select is(public.calendar_queue_out_of_step(), 2, 'A changed event and an event whose booking is gone are queued');
select ok((select bool_and(not force) from public.calendar_sync_queue), 'The regular check does not force a rewrite');
-- The nightly check queues everything, forced, including what is only left in Google.
create temporary table fx_all as select public.calendar_queue_all(true) as n;
select ok((select n from fx_all) >= 12 and (select bool_and(force) from public.calendar_sync_queue)
  and exists (select 1 from public.calendar_sync_queue where booking_id = '00000000-0000-4000-8000-0000000c0999'), 'The full check queues every booking and every leftover, forced');
select public.queue_calendar_sync(array['00000000-0000-4000-8000-0000000c0003'::uuid]);
select ok((select force from public.calendar_sync_queue where booking_id = '00000000-0000-4000-8000-0000000c0003'), 'A later ordinary change keeps a forced rewrite forced');
select is((select force from public.claim_calendar_sync(100) where booking_id = '00000000-0000-4000-8000-0000000c0003'), true, 'The job is told to force it');
delete from public.calendar_sync_queue;
delete from public.calendar_sync_events;

-- The connection: the token goes into Vault, and only the server reads it back.
select public.calendar_save_connection('refresh-token-for-test', 'vadim@example.test', 'cal-id@group.calendar.google.com');
select ok((select count(*) from public.calendar_sync_queue where force) = (select count(*) from public.bookings), 'Connecting copies every booking in');
select is(public.calendar_refresh_token(), 'refresh-token-for-test', 'The server reads the token back');
select ok(not exists (select 1 from public.calendar_connection where refresh_token_secret_id is null) and not exists (select 1 from vault.secrets s join public.calendar_connection c on c.refresh_token_secret_id = s.id where s.secret = 'refresh-token-for-test'), 'It is kept encrypted in Vault, not in a plain column');
insert into public.calendar_sync_events(booking_id, kind, google_event_id, content_hash) values ('00000000-0000-4000-8000-0000000c0004', 'booking', 'vm000000000000400080000000000c0004b', 'x');

-- The Admin's screen sees how it stands, never the token; a client sees nothing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c502","role":"authenticated"}', true);
select throws_ok($$select public.admin_calendar_status()$$, '42501', 'Admin authorization required', 'A client cannot see the calendar status');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c501","role":"authenticated"}', true);
select ok((select public.admin_calendar_status() ->> 'status' = 'connected' and public.admin_calendar_status()::text not like '%refresh-token%'), 'The Admin sees Connected, and no token');
select ok(public.admin_calendar_resync() >= (select count(*) from public.bookings where client_id = '00000000-0000-4000-8000-00000000c501'), 'Resync now queues every booking');
reset role;

-- Disconnecting forgets the token and what was put in Google; needing to reconnect keeps the record of what is there.
select public.calendar_forget_connection('needs_reconnect', 'Google said invalid_grant');
select ok((select status = 'needs_reconnect' and refresh_token_secret_id is null and last_error = 'Google said invalid_grant' from public.calendar_connection) and public.calendar_refresh_token() is null and exists (select 1 from public.calendar_sync_events), 'Needs reconnect: no token, the error kept, the event record kept');
select public.calendar_forget_connection();
select ok((select status = 'disconnected' from public.calendar_connection) and not exists (select 1 from public.calendar_sync_events), 'Disconnected: the record of events is forgotten too');

select * from finish();
rollback;
