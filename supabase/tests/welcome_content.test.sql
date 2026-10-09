begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(13);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000f701', 'authenticated', 'authenticated', 'welcome-admin@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-00000000f702', 'authenticated', 'authenticated', 'welcome-other@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000f701');
delete from public.business_settings where key in ('welcome_text', 'about_text');

select ok(has_function_privilege('anon', 'public.get_public_welcome()', 'EXECUTE'), 'A visitor can read the welcome');
select ok(not has_function_privilege('anon', 'public.admin_save_welcome(text,text)', 'EXECUTE'), 'A visitor cannot change it');
select is(public.get_public_welcome(), '{"welcome": "", "about": ""}'::jsonb, 'Nothing is set to begin with');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f702","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_welcome('Hello', 'About')$$, '42501', 'Admin authorization required', 'A client cannot change it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
select lives_ok($$select public.admin_save_welcome('  Welcome in.  ', 'I trained in Swedish massage.')$$, 'The Admin can save both texts');
reset role;
select is(public.get_public_welcome(), '{"welcome": "Welcome in.", "about": "I trained in Swedish massage."}'::jsonb, 'Both are read back, tidied');
set local role anon;
select is(public.get_public_welcome()->>'welcome', 'Welcome in.', 'A visitor sees the saved welcome');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
select lives_ok($$select public.admin_save_welcome('Only a welcome', '   ')$$, 'A blank about text clears it');
reset role;
select is(public.get_public_welcome(), '{"welcome": "Only a welcome", "about": ""}'::jsonb, 'Clearing one leaves the other');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f701","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_welcome(repeat('x', 501), null)$$, '22023', 'The welcome message can be up to 500 characters', 'A long welcome is refused');
select throws_ok($$select public.admin_save_welcome(null, repeat('x', 1501))$$, '22023', 'The about text can be up to 1500 characters', 'A long about text is refused');
select lives_ok($$select public.admin_save_welcome(null, null)$$, 'Both can be cleared');
reset role;
select is(public.get_public_welcome(), '{"welcome": "", "about": ""}'::jsonb, 'Cleared means the booking page shows its standard welcome');

select * from finish();
rollback;
