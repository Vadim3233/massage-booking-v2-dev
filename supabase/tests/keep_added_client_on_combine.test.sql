begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(3);

-- Combining a guest with a client the Admin added keeps the added profile (ADR-092).
insert into auth.users(id, aud, role, email, email_confirmed_at, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000e9ad', 'authenticated', 'authenticated', 'combine-admin@example.test', now(), false, '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-00000000e9a1', 'authenticated', 'authenticated', null, null, true, '{}', '{}', now(), now());
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000e9ad');
insert into public.clients(id, auth_user_id, first_name, last_name, email) values
  ('00000000-0000-4000-8000-00000000e9c1', null, 'Added', 'Byvad', 'same-person@example.test'),
  ('00000000-0000-4000-8000-00000000e9c2', '00000000-0000-0000-0000-00000000e9a1', 'Added', 'Byvad', 'same-person@example.test');

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000e9ad', 'role', 'authenticated')::text, true);
set local role authenticated;
select is(public.admin_combine_preview('00000000-0000-4000-8000-00000000e9c2', '00000000-0000-4000-8000-00000000e9c1')->>'keep_id',
  '00000000-0000-4000-8000-00000000e9c1', 'The preview keeps the client the Admin added');
select throws_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000e9c2', '00000000-0000-4000-8000-00000000e9c1', gen_random_uuid())$$,
  'PT409', 'The client you added is the one that stays.', 'An added client cannot be moved into a guest''s profile');
select lives_ok($$select public.admin_merge_clients('00000000-0000-4000-8000-00000000e9c1', '00000000-0000-4000-8000-00000000e9c2', gen_random_uuid())$$,
  'The guest can be combined into the added client');
reset role;

select * from finish();
rollback;
