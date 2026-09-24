begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(31);

insert into public.clients (
  id,
  first_name,
  last_name
)
values (
  '00000000-0000-0000-0000-000000000101',
  'Contract',
  'Test'
)
on conflict (id) do nothing;

insert into public.service_areas (
  id,
  slug,
  name,
  active,
  display_order
)
values (
  '00000000-0000-0000-0000-000000000201',
  'contract-test-area',
  'Contract Test Area',
  true,
  999
)
on conflict (id) do nothing;

create or replace function pg_temp.reset_schedule()
returns void
language plpgsql
as $$
begin
  delete from public.booking_holds;
  delete from public.bookings;
  delete from public.calendar_blocks;
  delete from public.working_hours_overrides;
  delete from public.working_hours;
end;
$$;

create or replace function pg_temp.set_day(
  p_date date,
  p_start integer,
  p_end integer,
  p_available boolean default true,
  p_mode text default 'flexible',
  p_fixed integer default null
)
returns void
language plpgsql
as $$
begin
  insert into public.working_hours_overrides (
    date,
    available,
    start_minutes,
    end_minutes,
    start_mode,
    fixed_start_minutes
  )
  values (
    p_date,
    p_available,
    case when p_available then p_start else null end,
    case when p_available then p_end else null end,
    p_mode,
    case when p_available and p_mode = 'fixed' then p_fixed else null end
  );
end;
$$;

create or replace function pg_temp.add_booking(
  p_date date,
  p_start integer,
  p_duration integer,
  p_reference text
)
returns void
language plpgsql
as $$
begin
  insert into public.bookings (
    booking_reference,
    client_id,
    service_area_id,
    date,
    start_minutes,
    treatment_duration_minutes,
    travel_buffer_minutes,
    booking_status,
    source_channel,
    address_line_1_snapshot,
    city_snapshot,
    postcode_snapshot,
    service_area_name_snapshot
  )
  values (
    p_reference,
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000201',
    p_date,
    p_start,
    p_duration,
    60,
    'confirmed',
    'test',
    '1 Test Street',
    'London',
    'SW1A 1AA',
    'Contract Test Area'
  );
end;
$$;

create or replace function pg_temp.add_hold(
  p_date date,
  p_start integer,
  p_duration integer,
  p_expires_at timestamptz
)
returns void
language plpgsql
as $$
begin
  insert into public.booking_holds (
    client_id,
    date,
    start_minutes,
    treatment_duration_minutes,
    travel_buffer_minutes,
    expires_at,
    status
  )
  values (
    '00000000-0000-0000-0000-000000000101',
    p_date,
    p_start,
    p_duration,
    60,
    p_expires_at,
    'active'
  );
end;
$$;

create or replace function pg_temp.add_block(
  p_date date,
  p_start integer,
  p_end integer
)
returns void
language plpgsql
as $$
begin
  insert into public.calendar_blocks (
    date,
    start_minutes,
    end_minutes,
    kind
  )
  values (
    p_date,
    p_start,
    p_end,
    'blocked'
  );
end;
$$;

create or replace function pg_temp.availability_array(
  p_date date,
  p_duration integer,
  p_now timestamptz,
  p_buffer integer default 60
)
returns integer[]
language sql
as $$
  select coalesce(
    array_agg(a.start_minutes order by a.start_minutes),
    array[]::integer[]
  )
  from public.compute_booking_availability(
    p_date,
    p_duration,
    p_now,
    p_buffer
  ) a;
$$;

-- 1. Empty anchored day returns only the fixed anchor.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200, true, 'fixed', 900);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[900]::integer[],
  'empty fixed-start day returns only the anchor'
);

-- 2. Empty flexible day returns every 30-minute start that fits treatment hours.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 840);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[600,630,660,690,720,750,780]::integer[],
  'empty flexible day exposes 30-minute treatment starts'
);

-- 3. Correct before-chain slot.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-3');
end;
$$;
select ok(
  780 = any(pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z')),
  'before-chain slot is 13:00'
);

-- 4. Correct after-chain slot.
select ok(
  1020 = any(pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z')),
  'after-chain slot is 17:00'
);

-- 5. 90-minute treatment moves the before edge earlier.
select is(
  pg_temp.availability_array('2030-01-07', 90, '2030-01-01T12:00:00Z'),
  array[750,1020]::integer[],
  '90-minute treatment uses correct chain edges'
);

-- 6. After edge is removed if treatment would finish after working hours.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1080);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-6');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 90, '2030-01-01T12:00:00Z'),
  array[750]::integer[],
  'after edge must finish within working hours'
);

-- 7. Last empty-day treatment may finish exactly at working-hours end.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
end;
$$;
select is(
  (
    select max(x)
    from unnest(
      pg_temp.availability_array('2030-01-07', 120, '2030-01-01T12:00:00Z')
    ) as x
  ),
  1080,
  'last treatment may finish exactly at working-hours end'
);

-- 8. Multiple bookings expose only outer chain boundaries.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1320);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-8A');
  perform pg_temp.add_booking('2030-01-07', 1080, 60, 'DBTEST-8B');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1200]::integer[],
  'internal chain gaps are not exposed'
);

-- 9. Blocked period removes an overlapping chain-edge slot.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-9');
  perform pg_temp.add_block('2030-01-07', 1020, 1080);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780]::integer[],
  'blocked period removes overlapping after edge'
);

-- 10. Active hold participates in the chain with a confirmed booking.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1320);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-10');
  perform pg_temp.add_hold('2030-01-07', 1020, 60, '2030-01-01T13:00:00Z');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1140]::integer[],
  'active hold extends the chain'
);

-- 11. Expired hold is ignored.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-11');
  perform pg_temp.add_hold('2030-01-07', 1020, 60, '2030-01-01T11:00:00Z');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1020]::integer[],
  'expired hold does not affect availability'
);

-- 12. 120-minute treatment works at both chain edges.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1320);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-12');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 120, '2030-01-01T12:00:00Z'),
  array[720,1020]::integer[],
  '120-minute treatment uses correct chain edges'
);

-- 13. Parameterized 30-minute travel buffer matches the JS engine contract.
select is(
  pg_temp.availability_array(
    '2030-01-07',
    60,
    '2030-01-01T12:00:00Z',
    30
  ),
  array[810,990]::integer[],
  '30-minute travel buffer is supported'
);

-- 14. Zero travel buffer is supported internally.
select is(
  pg_temp.availability_array(
    '2030-01-07',
    60,
    '2030-01-01T12:00:00Z',
    0
  ),
  array[840,960]::integer[],
  'zero travel buffer is supported'
);

-- 15. Before-chain treatment may start exactly at working-hours start.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 720, 60, 'DBTEST-15');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[600,840]::integer[],
  'before edge may start exactly at working-hours start'
);

-- 16. No edge slot when both sides fall outside treatment hours.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 840, 1020);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-16');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[]::integer[],
  'no edge slot is returned outside working hours'
);

-- 17. Booking insertion order does not affect outer boundaries.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1320);
  perform pg_temp.add_booking('2030-01-07', 1080, 60, 'DBTEST-17A');
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-17B');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1200]::integer[],
  'chain boundaries are order independent'
);

-- 18. An active hold can be the only chain item.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_hold('2030-01-07', 900, 60, '2030-01-01T13:00:00Z');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1020]::integer[],
  'active hold alone forms the chain'
);

-- 19. Hold expiring exactly now is expired.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-19');
  perform pg_temp.add_hold('2030-01-07', 1020, 60, '2030-01-01T12:00:00Z');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1020]::integer[],
  'hold expiring exactly now is ignored'
);

-- 20. Database configuration rejects the day entirely when marked unavailable.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', null, null, false);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[]::integer[],
  'unavailable day returns no slots'
);

-- 21. Fixed anchor is not offered when treatment would finish after hours.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200, true, 'fixed', 1170);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[]::integer[],
  'fixed anchor must allow treatment to finish within hours'
);

-- 22. Fixed anchor is not offered when blocked time overlaps treatment.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200, true, 'fixed', 900);
  perform pg_temp.add_block('2030-01-07', 930, 990);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[]::integer[],
  'blocked time removes a fixed anchor'
);

-- 23. Empty-day availability is not shortened by travel buffer.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 840);
end;
$$;
select is(
  (
    select max(x)
    from unnest(
      pg_temp.availability_array(
        '2030-01-07',
        60,
        '2030-01-01T12:00:00Z',
        120
      )
    ) as x
  ),
  780,
  'travel buffer does not reduce empty-day treatment starts'
);

-- 24. Empty day removes only starts whose treatment overlaps blocked time.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 840);
  perform pg_temp.add_block('2030-01-07', 660, 720);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[600,720,750,780]::integer[],
  'empty-day block removes only overlapping treatments'
);

-- 25. Blocked time during required after-chain travel removes after edge.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-25');
  perform pg_temp.add_block('2030-01-07', 990, 1005);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780]::integer[],
  'block during after-chain travel removes after edge'
);

-- 26. Blocked time during required before-chain travel removes before edge.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-26');
  perform pg_temp.add_block('2030-01-07', 870, 885);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[1020]::integer[],
  'block during before-chain travel removes before edge'
);

-- 27. Block ending exactly at reserved interval start does not overlap.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-27');
  perform pg_temp.add_block('2030-01-07', 720, 780);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1020]::integer[],
  'block ending exactly at reserved start does not overlap'
);

-- 28. Block starting exactly at reserved interval end does not overlap.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 1200);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-28');
  perform pg_temp.add_block('2030-01-07', 1080, 1140);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1020]::integer[],
  'block starting exactly at reserved end does not overlap'
);

-- 29. Confirmed booking and active hold share the same outer chain.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 540, 1320);
  perform pg_temp.add_booking('2030-01-07', 900, 60, 'DBTEST-29');
  perform pg_temp.add_hold('2030-01-07', 1080, 60, '2030-01-01T14:00:00Z');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1200]::integer[],
  'bookings and active holds use shared outer boundaries'
);

-- 30. Expired holds are ignored when an active hold also exists.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 540, 1320);
  perform pg_temp.add_hold('2030-01-07', 720, 60, '2030-01-01T11:00:00Z');
  perform pg_temp.add_hold('2030-01-07', 900, 60, '2030-01-01T14:00:00Z');
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[780,1020]::integer[],
  'expired hold is ignored alongside an active hold'
);

-- 31. Multiple blocked periods apply independently on an empty day.
do $$
begin
  perform pg_temp.reset_schedule();
  perform pg_temp.set_day('2030-01-07', 600, 900);
  perform pg_temp.add_block('2030-01-07', 630, 660);
  perform pg_temp.add_block('2030-01-07', 780, 810);
end;
$$;
select is(
  pg_temp.availability_array('2030-01-07', 60, '2030-01-01T12:00:00Z'),
  array[660,690,720,810,840]::integer[],
  'multiple blocked periods are applied independently'
);

select * from finish();
rollback;
