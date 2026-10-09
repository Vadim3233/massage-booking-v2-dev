begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(10);

-- Inside the 40-day client booking horizon, so the test does not rot as the calendar moves.
select set_config('test.horizon_date',((now() at time zone 'Europe/London')::date + 31)::text,true);

delete from public.booking_holds
where client_key in (
  'hold-client-key-000000000001',
  'hold-client-key-000000000002'
);

delete from public.calendar_blocks
where date = current_setting('test.horizon_date')::date;

delete from public.working_hours_overrides
where date = current_setting('test.horizon_date')::date;

insert into public.working_hours_overrides (
  date,
  available,
  start_minutes,
  end_minutes,
  start_mode,
  fixed_start_minutes
)
values (
  current_setting('test.horizon_date')::date,
  true,
  600,
  1200,
  'flexible',
  null
);

-- 1. The V1-compatible booking flow can create a hold before authentication.
set local role anon;
select lives_ok(
  $$select * from public.create_booking_hold(
    current_setting('test.horizon_date')::date,
    600,
    60,
    'hold-client-key-000000000001'
  )$$,
  'anonymous public booking flow can create a hold'
);
reset role;

-- 2. Hold state is private but stores the expected server-authoritative values.
select is(
  (
    select count(*)::integer
    from public.booking_holds
    where client_key = 'hold-client-key-000000000001'
      and client_id is null
      and date = current_setting('test.horizon_date')::date
      and start_minutes = 600
      and treatment_duration_minutes = 60
      and travel_buffer_minutes = 60
      and status = 'active'
  ),
  1,
  'hold stores the chosen slot with the server 60-minute travel buffer'
);

-- 3. Slot-selection hold is twenty minutes.
select is(
  (
    select expires_at
    from public.booking_holds
    where client_key = 'hold-client-key-000000000001'
      and status = 'active'
    order by created_at desc
    limit 1
  ),
  (
    select created_at + interval '20 minutes'
    from public.booking_holds
    where client_key = 'hold-client-key-000000000001'
      and status = 'active'
    order by created_at desc
    limit 1
  ),
  'pre-auth slot hold expires after 20 minutes'
);

-- 4. Active hold immediately participates in Chain Mode.
select is(
  (
    select coalesce(
      array_agg(a.start_minutes order by a.start_minutes),
      array[]::integer[]
    )
    from public.compute_booking_availability(
      current_setting('test.horizon_date')::date,
      60,
      now(),
      60
    ) a
  ),
  array[720]::integer[],
  'active hold immediately changes availability to the next outer edge'
);

-- 5. A retry by the same browser key refreshes rather than duplicates.
set local role anon;
select lives_ok(
  $$select * from public.create_booking_hold(
    current_setting('test.horizon_date')::date,
    600,
    60,
    'hold-client-key-000000000001'
  )$$,
  'same browser key can refresh its selected hold'
);
reset role;

select is(
  (
    select count(*)::integer
    from public.booking_holds
    where client_key = 'hold-client-key-000000000001'
  ),
  1,
  'refresh does not create a duplicate hold'
);

-- 6. Another browser cannot reserve the already-held slot.
set local role anon;
select throws_ok(
  $$select * from public.create_booking_hold(
    current_setting('test.horizon_date')::date,
    600,
    60,
    'hold-client-key-000000000002'
  )$$,
  '23P01',
  'Requested time is no longer available',
  'different browser key cannot take an active held slot'
);
reset role;

-- Capture opaque values while the test owner can inspect the private table.
do $capture$
begin
  perform set_config(
    'test.booking_hold_id',
    (
      select id::text
      from public.booking_holds
      where client_key = 'hold-client-key-000000000001'
      limit 1
    ),
    true
  );

  perform set_config(
    'test.booking_hold_token',
    (
      select hold_token::text
      from public.booking_holds
      where client_key = 'hold-client-key-000000000001'
      limit 1
    ),
    true
  );
end;
$capture$;

-- 8. Hold release requires all three opaque ownership values.
set local role anon;
select throws_ok(
  format(
    'select * from public.release_booking_hold(%L::uuid, %L::uuid, %L)',
    current_setting('test.booking_hold_id'),
    '00000000-0000-0000-0000-000000000099',
    'hold-client-key-000000000001'
  ),
  '42501',
  'Booking hold token is invalid',
  'wrong hold token cannot release a reservation'
);
reset role;

-- 9. Correct token releases the hold.
set local role anon;
select is(
  (
    select r.released
    from public.release_booking_hold(
      current_setting('test.booking_hold_id')::uuid,
      current_setting('test.booking_hold_token')::uuid,
      'hold-client-key-000000000001'
    ) r
  ),
  true,
  'correct hold token releases the reservation'
);
reset role;

-- 10. Released hold no longer blocks the original slot.
select ok(
  exists (
    select 1
    from public.compute_booking_availability(
      current_setting('test.horizon_date')::date,
      60,
      now(),
      60
    ) a
    where a.start_minutes = 600
  ),
  'released hold no longer blocks availability'
);

select * from finish();
rollback;
