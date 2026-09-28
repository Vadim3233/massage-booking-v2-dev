begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(8);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000004001',
    'authenticated',
    'authenticated',
    null,
    '',
    null,
    '{"provider":"anonymous","providers":[]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000004002',
    'authenticated',
    'authenticated',
    'permanent@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  )
on conflict (id) do nothing;

insert into public.clients (
  id,
  auth_user_id,
  first_name,
  last_name,
  email,
  phone
)
values (
  '00000000-0000-0000-0000-000000004101',
  '00000000-0000-0000-0000-000000004002',
  'Existing',
  'Permanent',
  'same-email@example.test',
  '07700 900999'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000004002","role":"authenticated","is_anonymous":false}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004002',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.activate_guest_client_account(
    'Permanent', 'Client', 'permanent@example.test', '07700900111'
  )$$,
  '42501',
  'Guest checkout requires an anonymous session',
  'permanent Auth users cannot activate guest checkout'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000004001","role":"authenticated","is_anonymous":true}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004001',
  true
);
set local role authenticated;
select is(
  (
    select created_new_client
    from public.activate_guest_client_account(
      'Guest', 'Client', 'guest@example.test', '+44 7700 900123'
    )
  ),
  true,
  'anonymous session creates a guest client'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.clients
    where auth_user_id = '00000000-0000-0000-0000-000000004001'
      and normalized_email = 'guest@example.test'
      and normalized_phone = '447700900123'
  ),
  1,
  'guest contact details are stored on the scoped client'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000004001","role":"authenticated","is_anonymous":true}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004001',
  true
);
set local role authenticated;
select is(
  (
    select created_new_client
    from public.activate_guest_client_account(
      'Guest', 'Updated', 'guest@example.test', '+44 7700 900124'
    )
  ),
  false,
  'repeat guest activation reuses the same scoped client'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.clients
    where auth_user_id = '00000000-0000-0000-0000-000000004001'
  ),
  1,
  'repeat guest activation creates no duplicate for the same anonymous session'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000004001","role":"authenticated","is_anonymous":true}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004001',
  true
);
set local role authenticated;
select is(
  (
    select client_id
    from public.activate_guest_client_account(
      'Guest', 'Client', 'same-email@example.test', '07700900125'
    )
  ),
  (
    select id
    from public.clients
    where auth_user_id = '00000000-0000-0000-0000-000000004001'
  ),
  'guest remains on its own client even when supplied email matches another account'
);
reset role;

select is(
  (
    select auth_user_id
    from public.clients
    where id = '00000000-0000-0000-0000-000000004101'
  ),
  '00000000-0000-0000-0000-000000004002'::uuid,
  'existing permanent client ownership is unchanged'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000004001","role":"authenticated","is_anonymous":true}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004001',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.activate_guest_client_account(
    'Guest', 'Client', 'not-an-email', '12'
  )$$,
  '22023',
  'A valid email address is required',
  'guest contact validation is server authoritative'
);
reset role;

select * from finish();
rollback;
