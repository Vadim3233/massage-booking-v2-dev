begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select no_plan();

-- People: an Admin, an ordinary signed-in client, a guest session, and a client the Admin added who has no login.
insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000a101', 'authenticated', 'authenticated', 'atl.admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000a102', 'authenticated', 'authenticated', 'atl.client@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000a103', 'authenticated', 'authenticated', null, '', null, '{"provider":"anonymous","providers":[]}', '{}', now(), now(), true);
insert into public.admin_users(user_id) values ('00000000-0000-0000-0000-00000000a101');
insert into public.clients(id, auth_user_id, first_name, last_name, email, phone) values
  ('00000000-0000-4000-8000-00000000a201', '00000000-0000-0000-0000-00000000a102', 'Rita', 'Registered', 'atl.registered@example.test', '07911 224701'),
  ('00000000-0000-4000-8000-00000000a202', null, 'Addie', 'Added', 'atl.added@example.test', '07911 224702');

create function pg_temp.as_user(p_user text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user, true);
end;
$$;
create function pg_temp.as_guest(p_user text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  perform set_config('request.jwt.claim.sub', p_user, true);
end;
$$;
create function pg_temp.as_visitor() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
create function pg_temp.hash(p_text text) returns text language sql as $$ select encode(sha256(convert_to(p_text, 'UTF8')), 'hex'); $$;

-- The doors
select ok(not has_function_privilege('anon', 'public.admin_create_client_telegram_link(uuid)', 'EXECUTE') and has_function_privilege('authenticated', 'public.admin_create_client_telegram_link(uuid)', 'EXECUTE'),
  'Making a link is open to signed-in callers only, who are then checked as the Admin inside');
select ok(not has_function_privilege('anon', 'public.admin_client_telegram_status(uuid)', 'EXECUTE') and has_function_privilege('authenticated', 'public.admin_client_telegram_status(uuid)', 'EXECUTE'),
  'and so is asking whether a client has linked');
select ok(not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_create_client_telegram_link', 'admin_client_telegram_status')
    and not coalesce(p.prosecdef and p.proconfig @> array['search_path=""'], false)), 'Both are definers with an empty search path');

-- Who may ask
select pg_temp.as_visitor();
set local role anon;
select throws_ok($$select public.admin_create_client_telegram_link('00000000-0000-4000-8000-00000000a201')$$, '42501', null, 'A visitor with no session cannot make a link');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a102');
set local role authenticated;
select throws_ok($$select public.admin_create_client_telegram_link('00000000-0000-4000-8000-00000000a201')$$, '42501', 'Admin authorization required', 'A signed-in client who is not the Admin cannot, not even for themselves');
select throws_ok($$select public.admin_client_telegram_status('00000000-0000-4000-8000-00000000a201')$$, '42501', 'Admin authorization required', 'nor ask whether a client has linked');
reset role;
select pg_temp.as_guest('00000000-0000-0000-0000-00000000a103');
set local role authenticated;
select throws_ok($$select public.admin_create_client_telegram_link('00000000-0000-4000-8000-00000000a201')$$, '42501', 'Admin authorization required', 'A guest session cannot');
reset role;

-- The Admin makes a link for a client with a login, and for one without
select pg_temp.as_user('00000000-0000-0000-0000-00000000a101');
set local role authenticated;
select is((select public.admin_client_telegram_status('00000000-0000-4000-8000-00000000a202')->>'linked'), 'false', 'A client who has not linked is not linked');
create temp table made as select public.admin_create_client_telegram_link('00000000-0000-4000-8000-00000000a202') as code;
create temp table made_for_login as select public.admin_create_client_telegram_link('00000000-0000-4000-8000-00000000a201') as code;
reset role;
select ok((select length(code) = 32 and code ~ '^[A-Za-z0-9]+$' from made), 'The code is 32 letters and digits, which the bot link allows');
select is((select count(*)::integer from public.client_telegram_tokens where token_hash = pg_temp.hash((select code from made))), 1, 'Only its hash is kept');
select is((select count(*)::integer from public.client_telegram_tokens where token_hash = (select code from made)), 0, 'never the code itself');
select ok((select expires_at between clock_timestamp() + interval '23 hours 50 minutes' and clock_timestamp() + interval '24 hours 5 minutes' from public.client_telegram_tokens where token_hash = pg_temp.hash((select code from made))),
  'It lasts 24 hours');
select ok((select used_at is null and client_id = '00000000-0000-4000-8000-00000000a202' from public.client_telegram_tokens where token_hash = pg_temp.hash((select code from made))), 'for that client, still unused');

-- Pressing Start links the chat to that client, once
select is((select public.link_client_telegram((select code from made), 9000001)), jsonb_build_object('status', 'linked', 'first_name', 'Addie'), 'Pressing Start with it links the chat and says whose it is');
select is((select count(*)::integer from public.client_telegram_links where client_id = '00000000-0000-4000-8000-00000000a202' and chat_id = 9000001 and stopped_at is null), 1, 'The chat is linked to that client');
select is((select public.link_client_telegram((select code from made), 9000002)), jsonb_build_object('status', 'used'), 'A second chat cannot use the same link');
select pg_temp.as_user('00000000-0000-0000-0000-00000000a101');
set local role authenticated;
select is((select public.admin_client_telegram_status('00000000-0000-4000-8000-00000000a202')->>'linked'), 'true', 'The profile then shows the client as linked');
select is((select public.admin_client_telegram_status('00000000-0000-4000-8000-00000000a201')->>'linked'), 'false', 'and not the other client');
reset role;

-- An expired link no longer works
update public.client_telegram_tokens set expires_at = clock_timestamp() - interval '1 minute' where token_hash = pg_temp.hash((select code from made_for_login));
select is((select public.link_client_telegram((select code from made_for_login), 9000003)), jsonb_build_object('status', 'expired'), 'A link older than its 24 hours says it has expired');

-- A client that is not there
select pg_temp.as_user('00000000-0000-0000-0000-00000000a101');
set local role authenticated;
select throws_ok($$select public.admin_create_client_telegram_link(gen_random_uuid())$$, 'P0002', 'That client is no longer there. They may already have been deleted or combined.', 'There is no link for a client who is not there');

-- Not a flood
select lives_ok($$select public.admin_create_client_telegram_link('00000000-0000-4000-8000-00000000a201') from generate_series(1, 9)$$, 'Several links in a row are fine');
select throws_ok($$select public.admin_create_client_telegram_link('00000000-0000-4000-8000-00000000a201')$$, 'PT429', 'Please wait a little before asking again.', 'but not more than ten an hour for one client');
reset role;

select * from finish();
rollback;
