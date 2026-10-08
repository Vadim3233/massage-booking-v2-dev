begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(22);

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000a901', 'authenticated', 'authenticated', 'bank-admin@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000a902', 'authenticated', 'authenticated', 'bank-client@example.test', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000a903', 'authenticated', 'authenticated', 'bank-stranger@example.test', now(), '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a901');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000a911', '00000000-0000-0000-0000-00000000a902', 'Bea', 'Banker', 'bank-client@example.test');
delete from public.business_settings where key = 'bank_details';

select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_save_bank_details', 'admin_bank_details', 'get_bank_details') and has_function_privilege('anon', p.oid, 'EXECUTE')), 'Anonymous callers cannot reach bank details');
select ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_save_bank_details', 'admin_bank_details', 'get_bank_details') and not (p.prosecdef and p.proconfig @> array['search_path=""'])), 'They are definers with an empty search path');
select ok(not has_table_privilege('authenticated', 'public.business_settings', 'INSERT,UPDATE,DELETE,TRUNCATE') and not has_table_privilege('anon', 'public.business_settings', 'SELECT'), 'Browsers cannot write or publicly read the settings table');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a902","role":"authenticated"}', true);
select is(public.get_bank_details(), null, 'A client sees nothing before details are entered');
select throws_ok($$select public.admin_save_bank_details('Vad', 'Bank', '00-00-00', '00000000')$$, '42501', 'Admin authorization required', 'A client cannot save bank details');
select throws_ok($$select public.admin_bank_details()$$, '42501', 'Admin authorization required', 'A client cannot use the Admin reader');
select is((select count(*)::integer from public.business_settings), 0, 'A client cannot read the settings table');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a901","role":"authenticated"}', true);
select throws_ok($$select public.admin_save_bank_details('', 'Bank', '12-34-56', '12345678')$$, '22023', 'Enter the name on the account', 'The account name is required');
select throws_ok($$select public.admin_save_bank_details('Vad', 'Bank', '12-34-5', '12345678')$$, '22023', 'The sort code needs six digits', 'The sort code needs six digits');
select throws_ok($$select public.admin_save_bank_details('Vad', 'Bank', '12-34-56', '1234567')$$, '22023', 'The account number needs eight digits', 'The account number needs eight digits');
select throws_ok($$select public.admin_save_bank_details('Vad', repeat('x', 81), '12-34-56', '12345678')$$, '22023', 'That is too long', 'An overlong bank name is refused');
select is(public.admin_bank_details(), null, 'Nothing is saved by the refused attempts');
select lives_ok($$select public.admin_save_bank_details('  Vad Massage  ', ' Wise ', '123456', '1234 5678', 'Please use the reference exactly')$$, 'The Admin can save bank details typed loosely');
select is(public.admin_bank_details(), '{"note":"Please use the reference exactly","bank_name":"Wise","sort_code":"12-34-56","account_name":"Vad Massage","account_number":"12345678"}'::jsonb, 'They are stored tidily, with the sort code in the usual form');
select is((select updated_by from public.business_settings where key = 'bank_details'), '00000000-0000-0000-0000-00000000a901'::uuid, 'The change records who made it');
select lives_ok($$select public.admin_save_bank_details('Vad Massage', null, '65-43-21', '87654321')$$, 'They can be changed, and the optional parts left out');
select is(public.admin_bank_details()->>'sort_code', '65-43-21', 'The new details replace the old');
select ok(not (public.admin_bank_details() ? 'bank_name') and not (public.admin_bank_details() ? 'note'), 'Left-out optional parts are not stored as empty');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a902","role":"authenticated"}', true);
select is(public.get_bank_details()->>'account_number', '87654321', 'A client can read what they need to make a transfer');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a903","role":"authenticated"}', true);
select is(public.get_bank_details(), null, 'Someone with no client record gets nothing');
select set_config('request.jwt.claims', '', true);
select throws_ok($$select public.get_bank_details()$$, '42501', 'Authentication required', 'A session with no user is refused');
reset role;
set local role anon;
select throws_ok($$select public.get_bank_details()$$, '42501', 'permission denied for function get_bank_details', 'The anonymous role is refused');
reset role;

select * from finish();
rollback;
