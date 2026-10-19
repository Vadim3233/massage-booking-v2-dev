begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(14);

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

select * from finish();
rollback;
