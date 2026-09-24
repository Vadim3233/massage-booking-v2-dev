begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(7);

-- These are local-only contract rows. FK enforcement is disabled only for the
-- setup insert so auth.uid() can be simulated without creating Auth accounts.
set local session_replication_role = replica;

insert into public.clients (
  id,
  auth_user_id,
  first_name,
  last_name,
  online_booking_enabled
)
values
  (
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001001',
    'Hold',
    'Client',
    true
  ),
  (
    '00000000-0000-0000-0000-000000001102',
    '00000000-0000-0000-0000-000000001002',
    'Disabled',
    'Client',
    false
  )
on conflict (id) do nothing;

set local session_replication_role = origin;

delete from public.command_requests
where scope like 'client_booking_hold:%';

delete from public.booking_holds
where client_id in (
  '00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001102'
);

delete from public.calendar_blocks
where date = '2031-02-03';

delete from public.working_hours_overrides
where date = '2031-02-03';

insert into public.working_hours_overrides (
  date,
  available,
  start_minutes,
  end_minutes,
  start_mode,
  fixed_start_minutes
)
values (
  '2031-02-03',
  true,
  600,
  1200,
  'flexible',
  null
);

-- 1. User without a linked canonical client is rejected.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000001099',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.create_booking_hold(
    '2031-02-03', 600, 60, 'hold-test-unlinked'
  )$$,
  '42501',
  'Client profile is not linked to this account',
  'hold creation requires a linked canonical client'
);
reset role;

-- 2. Disabled client cannot create a hold.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000001002',
  true
);
set local role authenticated;
select throws_ok(
  $$select * from public.create_booking_hold(
    '2031-02-03', 600, 60, 'hold-test-disabled'
  )$$,
  '42501',
  'Online booking is disabled for this client',
  'online booking access is enforced'
);
reset role;

-- 3. Available slot creates a hold.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000001001',
  true
);
set local role authenticated;
select lives_ok(
  $$select * from public.create_booking_hold(
    '2031-02-03', 600, 60, 'hold-test-create'
  )$$,
  'available slot creates a booking hold'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.booking_holds
    where client_id = '00000000-0000-0000-0000-000000001101'
      and date = '2031-02-03'
      and start_minutes = 600
      and treatment_duration_minutes = 60
      and travel_buffer_minutes = 60
      and status = 'active'
      and expires_at = created_at + interval '60 minutes'
  ),
  1,
  'created hold has expected slot, buffer, state and expiry'
);

-- 4. Active hold immediately participates in Chain Mode.
select is(
  (
    select coalesce(
      array_agg(a.start_minutes order by a.start_minutes),
      array[]::integer[]
    )
    from public.compute_booking_availability(
      '2031-02-03', 60, now(), 60
    ) a
  ),
  array[720]::integer[],
  'active hold immediately changes availability'
);

-- 5. Same idempotency key does not create a duplicate.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000001001',
  true
);
set local role authenticated;
select lives_ok(
  $$select * from public.create_booking_hold(
    '2031-02-03', 600, 60, 'hold-test-create'
  )$$,
  'idempotent retry returns successfully'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.booking_holds
    where client_id = '00000000-0000-0000-0000-000000001101'
  ),
  1,
  'idempotent retry creates no duplicate hold'
);

select * from finish();
rollback;
