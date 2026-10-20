begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(9);

-- The sentence (word for word as the booking screens; every combination is compared in server/bookingSentence.integration.test.js).
select is(public.people_sentence(array[120], 'massage'), 'One 2-hour massage for 1 person', 'One person');
select is(public.people_sentence(array[60, 60, 60], 'massage'), 'Three 60-minute massages for 3 people, one after the other – 3 hours in total', 'Three people, the same length');
select is(public.people_sentence(array[60, 90], 'session'), 'Two sessions for 2 people, one after the other (60 min + 90 min) – 2 hours 30 minutes in total', 'Two people, different lengths');
select is(public.people_sentence(array[]::integer[], 'massage'), null, 'Nothing for no sessions');
select ok(not has_function_privilege('anon', 'public.booking_people_sentence(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.people_sentence(integer[],text)', 'EXECUTE'), 'Browsers cannot call them');

-- A booking for 1 person of 120 minutes, and its confirmation email.
insert into public.clients(id, first_name, last_name, email) values ('00000000-0000-4000-8000-00000000e501', 'Sentence', 'Test', 'sentence@example.test');
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_snapshot, service_area_name_snapshot, total_gbp, service_subtotal_gbp, booking_email_snapshot)
select '00000000-0000-4000-8000-00000000e601', 'SENT-1', '00000000-0000-4000-8000-00000000e501', id, '2031-05-05', 600, 120, 'confirmed',
  'test', '1 Sentence Road, London', name, 170, 170, 'sentence@example.test'
from public.service_areas where slug = 'chelsea';
insert into public.booking_sessions(booking_id, position, service_id, duration_minutes, service_name_snapshot, unit_price_gbp)
select '00000000-0000-4000-8000-00000000e601', 1, s.id, 120, 'Massage', 170 from public.services s order by s.created_at limit 1;
insert into public.booking_payments(booking_id, method, status, amount_gbp) values ('00000000-0000-4000-8000-00000000e601', 'cash', 'approved', 170);
select is(public.booking_people_sentence('00000000-0000-4000-8000-00000000e601'), 'One 2-hour massage for 1 person – £170.00', 'A booking''s sentence, with its price');
select is(public.booking_people_sentence('00000000-0000-4000-8000-00000000e601', false), 'One 2-hour massage for 1 person', 'and without');
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload) values ('booking.cash_approved', 'booking', '00000000-0000-4000-8000-00000000e601', '{}');
select ok((select body like 'Thank you. Your appointment is confirmed for Mon 5 May at 10:00 at 1 Sentence Road, London.' || E'\n' || 'One 2-hour massage for 1 person – £170.00.' || E'\n' || 'Reference: SENT-1%'
  from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e601' and d.audience = 'client' and d.channel = 'email'),
  'The confirmation email says who, how long and the price on its own line');
select ok((select body not like '%(120 minutes)%' from public.notification_deliveries d join public.event_outbox e on e.id = d.event_id
  where e.aggregate_id = '00000000-0000-4000-8000-00000000e601' and d.audience = 'client' and d.channel = 'email'), 'and no longer only "(120 minutes)"');

select * from finish();
rollback;
