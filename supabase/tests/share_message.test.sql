begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(24);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000f801', 'authenticated', 'authenticated', 'share-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000f802', 'authenticated', 'authenticated', 'share-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f801');
delete from public.business_settings where key = 'share_message';

select ok(not has_function_privilege('anon', 'public.admin_save_share_message(text)', 'EXECUTE'), 'A visitor cannot change the share message');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f802","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_share_message('Hi {date}')$$, '42501', 'Admin authorization required', 'A client cannot change it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f801","role":"authenticated"}', true);
select lives_ok($$select public.admin_save_share_message(E'  See you {date} at {time}\n{address}\n{treatment}\n{payment}\n{bank details}  ')$$, 'The Admin can save a message with every blank');
select is((select value #>> '{}' from public.business_settings where key = 'share_message'), E'See you {date} at {time}\n{address}\n{treatment}\n{payment}\n{bank details}', 'It is kept, tidied');
select is((select count(*)::int from public.business_settings where key = 'share_message'), 1, 'The Admin reads it back from the settings, as the share button does');
reset role;

-- A client can never read it (or any setting).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f802","role":"authenticated"}', true);
select is((select count(*)::int from public.business_settings where key = 'share_message'), 0, 'A client cannot read it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f801","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_share_message('Your phone {phone}')$$, '22023', 'Only the blanks listed can be used, each in curly brackets', 'A blank that is not on the list is refused');
select throws_ok($$select public.admin_save_share_message('Note: {note}')$$, '22023', 'Only the blanks listed can be used, each in curly brackets', 'The notes can never be put in');
select throws_ok($$select public.admin_save_share_message('Half a blank {date')$$, '22023', 'Only the blanks listed can be used, each in curly brackets', 'A bracket left open is refused');
select throws_ok($$select public.admin_save_share_message('{Date}')$$, '22023', 'Only the blanks listed can be used, each in curly brackets', 'A blank is written exactly as listed');
select throws_ok($$select public.admin_save_share_message(repeat('x', 1001))$$, '22023', 'The share message can be up to 1000 characters', 'A long message is refused');
select is((select value #>> '{}' from public.business_settings where key = 'share_message'), E'See you {date} at {time}\n{address}\n{treatment}\n{payment}\n{bank details}', 'A refused message leaves the saved one as it was');
select lives_ok($$select public.admin_save_share_message('   ')$$, 'An empty message goes back to the standard one');
reset role;
select is((select count(*)::int from public.business_settings where key = 'share_message'), 0, 'Nothing is kept, so the standard wording is used');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f801","role":"authenticated"}', true);
select lives_ok($$select public.admin_save_share_message('Free until: {cancellation}')$$, 'The cancellation blank can be used');
reset role;

-- The free-cancellation deadline: exactly where the fee rule starts charging, in London time.
select is(public.booking_free_until('2031-01-01 12:00+00', '2031-03-05', 600), '2031-03-04 10:00+00'::timestamptz, 'Booked well ahead: free until 24 hours before the start');
select is(public.booking_free_until('2031-03-05 08:00+00', '2031-03-05', 600), '2031-03-05 09:00+00'::timestamptz, 'Booked inside 24 hours: free for the hour after booking');
select is(public.booking_free_until('2026-10-01 12:00+00', '2026-10-26', 600), '2026-10-25 10:00+00'::timestamptz, 'Clocks go back on 25 Oct: 10:00 on Monday 26th is free until 10:00 GMT on Sunday');
select is(public.booking_free_until('2026-10-01 12:00+00', '2026-10-25', 1080), '2026-10-24 18:00+00'::timestamptz, 'Across the change: 18:00 GMT on Sunday 25th is free until 19:00 summer time on Saturday (24 real hours)');
select ok((select bool_and(public.late_fee_standard_gbp(100, d, s, c, public.booking_free_until(c, d, s) - interval '1 second') = 0
    and public.late_fee_standard_gbp(100, d, s, c, public.booking_free_until(c, d, s)) = 100)
  from (values ('2031-01-01 12:00+00'::timestamptz, '2031-03-05'::date, 600), ('2031-03-05 08:00+00', '2031-03-05', 600),
    ('2026-10-01 12:00+00', '2026-10-25', 1080), ('2031-03-04 09:30+00', '2031-03-05', 600)) t(c, d, s)),
  'The fee rule agrees: free one second before the deadline, the full price from it');
select ok(not has_function_privilege('authenticated', 'public.booking_free_until(timestamptz,date,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_cancellation_terms(uuid)', 'EXECUTE'), 'Browsers cannot call the helper, and visitors not the Admin function');

-- The Admin's terms for a real booking; a client cannot ask.
insert into public.clients(id, first_name) values ('00000000-0000-4000-8000-00000000f8c1', 'Terms');
insert into public.bookings(id, booking_reference, client_id, service_area_id, date, start_minutes, treatment_duration_minutes, booking_status,
  source_channel, address_snapshot, service_area_name_snapshot, created_at)
select '00000000-0000-4000-8000-00000000f8b1', 'TERMS-1', '00000000-0000-4000-8000-00000000f8c1', id, '2031-03-05', 600, 60, 'confirmed', 'test', '1 Test Road', name, '2031-01-01 12:00+00'
from public.service_areas where slug = 'chelsea';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f801","role":"authenticated"}', true);
select is(public.admin_cancellation_terms('00000000-0000-4000-8000-00000000f8b1'), '{"free_until": "2031-03-04T10:00:00+00:00", "ended": false, "open": true}'::jsonb, 'The Admin gets the deadline, whether it has passed, and that the booking can still change');
reset role;
update public.bookings set date = '2021-03-05', created_at = '2021-01-01 12:00+00' where id = '00000000-0000-4000-8000-00000000f8b1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f801","role":"authenticated"}', true);
select is(public.admin_cancellation_terms('00000000-0000-4000-8000-00000000f8b1') - 'free_until', '{"ended": true, "open": false}'::jsonb, 'A booking in the past: ended, and no longer open to change');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f802","role":"authenticated"}', true);
select throws_ok($$select public.admin_cancellation_terms('00000000-0000-4000-8000-00000000f8b1')$$, '42501', 'Admin authorization required', 'A client cannot');
reset role;

select * from finish();
rollback;
