begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(5);

-- The queue does not keep a message stuck after its fifth try, and does not send a message more than two days late (ADR-088).
-- Other messages already in the local queue are moved out of the way so only these rows can be claimed.
update public.notification_deliveries set next_attempt_at = now() + interval '1 year' where status in ('pending', 'failed', 'sending');
insert into public.event_outbox(id, event_type, aggregate_type, aggregate_id, payload)
values ('00000000-0000-4000-8000-0000000c0e01', 'client.created', 'client', gen_random_uuid(), '{}');
insert into public.notification_deliveries(id, event_id, channel, audience, recipient, title, body, status, attempt_count, next_attempt_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000c0d01', '00000000-0000-4000-8000-0000000c0e01', 'telegram', 'admin', 'q1', 'Stuck', 'Body', 'sending', 5, now(), now() - interval '1 hour', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000c0d02', '00000000-0000-4000-8000-0000000c0e01', 'telegram', 'admin', 'q2', 'Old', 'Body', 'pending', 0, now(), now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000c0d03', '00000000-0000-4000-8000-0000000c0e01', 'telegram', 'admin', 'q3', 'Fresh', 'Body', 'pending', 0, now(), now() - interval '1 hour', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000c0d04', '00000000-0000-4000-8000-0000000c0e01', 'email', 'admin', 'q4', 'Old, channel off', 'Body', 'pending', 0, now(), now() - interval '3 days', now() - interval '3 days');

set local role service_role;
select results_eq($$select id from public.claim_notification_deliveries(10, array['telegram'])$$,
  $$values ('00000000-0000-4000-8000-0000000c0d03'::uuid)$$, 'Only the recent message is claimed');
reset role;
select results_eq($$select status, last_error from public.notification_deliveries where id = '00000000-0000-4000-8000-0000000c0d01'$$,
  $$values ('failed'::text, 'Stopped after 5 tries; the last try did not report back.'::text)$$, 'A fifth try that never reported back is marked failed');
select results_eq($$select status, last_error from public.notification_deliveries where id = '00000000-0000-4000-8000-0000000c0d02'$$,
  $$values ('failed'::text, 'Not sent: more than two days late.'::text)$$, 'A message more than two days old is not sent and says why');
select is((select status from public.notification_deliveries where id = '00000000-0000-4000-8000-0000000c0d04'), 'pending',
  'A channel that is not being sent is left alone');
select is((select attempt_count from public.notification_deliveries where id = '00000000-0000-4000-8000-0000000c0d03'), 1,
  'The claimed message counts its try as before');

select * from finish();
rollback;
