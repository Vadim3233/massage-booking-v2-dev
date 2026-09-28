begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(15);

select is(
  (select count(*)::integer from public.service_areas where active),
  15,
  '15 approved service areas are active'
);

select is(
  (select congestion_fee_gbp from public.service_areas where slug = 'mayfair'),
  18.00::numeric,
  'Mayfair congestion fee is £18'
);

select is(
  (select congestion_fee_gbp from public.service_areas where slug = 'westminster'),
  18.00::numeric,
  'Westminster congestion fee is £18'
);

select is(
  (
    select count(*)::integer
    from public.service_areas
    where active
      and slug not in ('mayfair', 'westminster')
      and travel_surcharge_gbp = 0
      and congestion_fee_gbp = 0
  ),
  13,
  'all other active service areas have no configured fee'
);

select is(
  (
    select count(*)::integer
    from public.service_duration_prices p
    join public.services s on s.id = p.service_id
    where s.slug in ('massage', 'assisted-stretching', 'soft-tissue-therapy', 'body-exam')
      and p.active
  ),
  12,
  'four services each have three active public duration prices'
);

select is(
  (
    select count(*)::integer
    from public.service_duration_prices p
    join public.services s on s.id = p.service_id
    where s.slug in ('massage', 'assisted-stretching', 'soft-tissue-therapy', 'body-exam')
      and p.duration_minutes = 60
      and p.price_gbp = 90
      and p.active
  ),
  4,
  'all four services price 60 minutes at £90'
);

select is(
  (
    select count(*)::integer
    from public.service_duration_prices p
    join public.services s on s.id = p.service_id
    where s.slug in ('massage', 'assisted-stretching', 'soft-tissue-therapy', 'body-exam')
      and p.duration_minutes = 90
      and p.price_gbp = 125
      and p.active
  ),
  4,
  'all four services price 90 minutes at £125'
);

select is(
  (
    select count(*)::integer
    from public.service_duration_prices p
    join public.services s on s.id = p.service_id
    where s.slug in ('massage', 'assisted-stretching', 'soft-tissue-therapy', 'body-exam')
      and p.duration_minutes = 120
      and p.price_gbp = 170
      and p.active
  ),
  4,
  'all four services price 120 minutes at £170'
);

select is(
  (select count(*)::integer from public.enhancements where active),
  2,
  'only the two approved public enhancements are active'
);

select is(
  (select count(*)::integer from public.session_preferences where active),
  23,
  '23 compact grouped session preferences are active'
);

select ok(
  not (select active from public.session_preferences where slug = 'face-and-ears'),
  'superseded Face and ears preference is inactive'
);

select is(
  (select count(*)::integer from public.session_preference_conflicts),
  14,
  'seven mutual preference conflicts are stored in both directions'
);

select results_eq(
  $$
    select available, start_minutes, end_minutes, start_mode
    from public.working_hours
    where weekday = 1
  $$,
  $$
    values (true, 855, 1170, 'flexible'::text)
  $$,
  'Monday working hours are 14:15–19:30 flexible'
);

select results_eq(
  $$
    select available, start_minutes, end_minutes, start_mode
    from public.working_hours
    where weekday = 6
  $$,
  $$
    values (false, null::integer, null::integer, 'flexible'::text)
  $$,
  'Saturday is closed'
);

select results_eq(
  $$
    select available, start_minutes, end_minutes, start_mode
    from public.working_hours
    where weekday = 7
  $$,
  $$
    values (true, 720, 1290, 'flexible'::text)
  $$,
  'Sunday working hours are 12:00–21:30 flexible'
);

select * from finish();
rollback;
