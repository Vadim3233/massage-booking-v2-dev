begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(8);

-- Inside the 40-day client booking horizon, so the test does not rot as the calendar moves.
select set_config('test.horizon_date',((now() at time zone 'Europe/London')::date + 34)::text,true);

insert into public.services (
  id, slug, name, active, display_order
)
values
  (
    '00000000-0000-0000-0000-000000002001',
    'public-test-active',
    'Public Test Active',
    true,
    900
  ),
  (
    '00000000-0000-0000-0000-000000002002',
    'public-test-inactive',
    'Public Test Inactive',
    false,
    901
  );

insert into public.service_duration_prices (
  service_id, duration_minutes, price_gbp, active
)
values
  (
    '00000000-0000-0000-0000-000000002001',
    60,
    99,
    true
  ),
  (
    '00000000-0000-0000-0000-000000002002',
    60,
    88,
    true
  );

insert into public.service_areas (
  id, slug, name, active, display_order
)
values
  (
    '00000000-0000-0000-0000-000000002101',
    'public-test-area-active',
    'Public Test Area Active',
    true,
    900
  ),
  (
    '00000000-0000-0000-0000-000000002102',
    'public-test-area-inactive',
    'Public Test Area Inactive',
    false,
    901
  );

insert into public.enhancements (
  id, slug, name, active, display_order
)
values
  (
    '00000000-0000-0000-0000-000000002201',
    'public-test-enhancement-active',
    'Public Test Enhancement Active',
    true,
    900
  ),
  (
    '00000000-0000-0000-0000-000000002202',
    'public-test-enhancement-inactive',
    'Public Test Enhancement Inactive',
    false,
    901
  );

insert into public.session_preferences (
  id, slug, label, category, active, display_order
)
values
  (
    '00000000-0000-0000-0000-000000002301',
    'public-test-preference-active',
    'Public Test Preference Active',
    'Focus area',
    true,
    900
  ),
  (
    '00000000-0000-0000-0000-000000002302',
    'public-test-preference-inactive',
    'Public Test Preference Inactive',
    'Focus area',
    false,
    901
  );

delete from public.booking_holds
where date = current_setting('test.horizon_date')::date;

delete from public.bookings
where date = current_setting('test.horizon_date')::date;

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
  840,
  'flexible',
  null
);

set local role anon;

select is(
  (
    select count(*)::integer
    from public.services
    where slug like 'public-test-%'
  ),
  1,
  'anonymous catalogue shows active services only'
);

select is(
  (
    select count(*)::integer
    from public.service_duration_prices p
    join public.services s on s.id = p.service_id
    where s.slug like 'public-test-%'
  ),
  1,
  'anonymous catalogue shows prices only for active services'
);

select is(
  (
    select count(*)::integer
    from public.service_areas
    where slug like 'public-test-area-%'
  ),
  1,
  'anonymous catalogue shows active service areas only'
);

select is(
  (
    select count(*)::integer
    from public.enhancements
    where slug like 'public-test-enhancement-%'
  ),
  1,
  'anonymous review data shows active enhancements only'
);

select is(
  (
    select count(*)::integer
    from public.session_preferences
    where slug like 'public-test-preference-%'
  ),
  1,
  'anonymous review data shows active preferences only'
);

select is(
  (
    select coalesce(
      array_agg(a.start_minutes order by a.start_minutes),
      array[]::integer[]
    )
    from public.get_booking_availability(
      current_setting('test.horizon_date')::date,
      60
    ) a
  ),
  array[600,630,660,690,720,750,780]::integer[],
  'anonymous client can see future available slots before sign-in'
);

select is(
  (
    select count(*)::integer
    from public.get_booking_availability(
      ((now() at time zone 'Europe/London')::date - 1),
      60
    )
  ),
  0,
  'public availability returns no slots for past dates'
);

reset role;

delete from public.working_hours_overrides
where date = (now() at time zone 'Europe/London')::date;

insert into public.working_hours_overrides (
  date,
  available,
  start_minutes,
  end_minutes,
  start_mode,
  fixed_start_minutes
)
values (
  (now() at time zone 'Europe/London')::date,
  true,
  0,
  1440,
  'flexible',
  null
);

set local role anon;

select ok(
  not exists (
    select 1
    from public.get_booking_availability(
      (now() at time zone 'Europe/London')::date,
      60
    ) a
    where a.start_minutes < (
      extract(hour from now() at time zone 'Europe/London')::integer * 60
      + extract(minute from now() at time zone 'Europe/London')::integer
      + 120
    )
  ),
  'same-day public availability enforces the two-hour minimum notice'
);

reset role;

select * from finish();
rollback;
