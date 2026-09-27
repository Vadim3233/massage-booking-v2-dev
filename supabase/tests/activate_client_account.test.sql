begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(9);

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
    '00000000-0000-0000-0000-000000003001',
    'authenticated',
    'authenticated',
    'new-client@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000003002',
    'authenticated',
    'authenticated',
    'existing-client@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000003003',
    'authenticated',
    'authenticated',
    'unconfirmed-client@example.test',
    '',
    null,
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000003004',
    'authenticated',
    'authenticated',
    'duplicate-client@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000003005',
    'authenticated',
    'authenticated',
    'linked-other@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000003006',
    'authenticated',
    'authenticated',
    'other-owner@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000003007',
    'authenticated',
    'authenticated',
    'admin-client@example.test',
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
values
  (
    '00000000-0000-0000-0000-000000003101',
    null,
    'Existing',
    'Client',
    'existing-client@example.test',
    '07111 222333'
  ),
  (
    '00000000-0000-0000-0000-000000003102',
    null,
    'Duplicate',
    'One',
    'duplicate-client@example.test',
    null
  ),
  (
    '00000000-0000-0000-0000-000000003103',
    null,
    'Duplicate',
    'Two',
    'duplicate-client@example.test',
    null
  ),
  (
    '00000000-0000-0000-0000-000000003104',
    '00000000-0000-0000-0000-000000003006',
    'Other',
    'Owner',
    'linked-other@example.test',
    null
  );

insert into public.admin_users (user_id)
values ('00000000-0000-0000-0000-000000003007')
on conflict (user_id) do nothing;

-- 1. Unconfirmed accounts cannot activate a canonical client.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000003003',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.activate_my_client_account('Unconfirmed', 'Client', null)$$,
  '42501',
  'A confirmed email address is required',
  'client activation requires a confirmed Auth email'
);
reset role;

-- 2. New confirmed account creates one canonical client.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000003001',
  true
);
set local role authenticated;
select is(
  (
    select a.created_new_client
    from public.activate_my_client_account(
      'New',
      'Client',
      '+44 7700 900123'
    ) a
  ),
  true,
  'new confirmed account creates a canonical client'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.clients c
    where c.auth_user_id = '00000000-0000-0000-0000-000000003001'
      and c.normalized_email = 'new-client@example.test'
      and c.normalized_phone = '447700900123'
  ),
  1,
  'new client identity comes from Auth email and normalized profile data'
);

-- 3. Repeating activation is idempotent and does not duplicate the client.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000003001',
  true
);
set local role authenticated;
select is(
  (
    select a.created_new_client
    from public.activate_my_client_account(
      'New',
      'Client',
      '+44 7700 900123'
    ) a
  ),
  false,
  'repeat activation returns the already-linked canonical client'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.clients c
    where c.auth_user_id = '00000000-0000-0000-0000-000000003001'
  ),
  1,
  'repeat activation creates no duplicate client'
);

-- 4. Exact confirmed email links an existing unlinked canonical client.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000003002',
  true
);
set local role authenticated;
select is(
  (
    select a.client_id
    from public.activate_my_client_account(
      'Existing',
      'Client',
      '07111 222333'
    ) a
  ),
  '00000000-0000-0000-0000-000000003101'::uuid,
  'activation links an existing client by its unique confirmed email'
);
reset role;

-- 5. Ambiguous duplicate email records are never linked arbitrarily.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000003004',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.activate_my_client_account('Duplicate', 'Client', null)$$,
  'P0001',
  'Multiple client records use this email. Please contact Vad to link the correct account.',
  'ambiguous canonical client matching fails safely'
);
reset role;

-- 6. A client already linked to another Auth user cannot be taken over.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000003005',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.activate_my_client_account('Linked', 'Other', null)$$,
  '23505',
  'This email is already linked to another client account',
  'confirmed email cannot take over another linked account'
);
reset role;

-- 7. Admin accounts remain separate from client accounts.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000003007',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.activate_my_client_account('Admin', 'Client', null)$$,
  '42501',
  'Admin accounts cannot be activated as client accounts',
  'admin identity cannot self-activate as a client'
);
reset role;

select * from finish();
rollback;
