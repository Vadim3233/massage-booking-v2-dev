-- VAD Massage Booking V2
-- Approved initial business configuration.
--
-- This migration seeds only values explicitly confirmed for V2:
-- - four existing service identities with public 60/90/120 prices
-- - 15 service areas and location fees
-- - two genuine public enhancements
-- - 20 session preferences and their mutual conflicts
-- - normal weekly working hours
--
-- V1-only scheduling flags are intentionally not represented here.

-- The four canonical service identities must already exist. Preserve their IDs.
do $$
declare
  v_service_count integer;
begin
  select count(*)::integer
  into v_service_count
  from public.services
  where slug in (
    'massage',
    'assisted-stretching',
    'soft-tissue-therapy',
    'body-exam'
  );

  if v_service_count <> 4 then
    raise exception
      'Expected four canonical services before seeding business configuration; found %',
      v_service_count;
  end if;
end;
$$;

update public.services
set active = true
where slug in (
  'massage',
  'assisted-stretching',
  'soft-tissue-therapy',
  'body-exam'
);

-- Current public prices are shared by all four services for now:
-- 60 minutes £90, 90 minutes £125, 120 minutes £170.
with price_matrix (duration_minutes, price_gbp) as (
  values
    (60, 90.00::numeric),
    (90, 125.00::numeric),
    (120, 170.00::numeric)
)
insert into public.service_duration_prices (
  service_id,
  duration_minutes,
  price_gbp,
  active
)
select
  s.id,
  p.duration_minutes,
  p.price_gbp,
  true
from public.services s
cross join price_matrix p
where s.slug in (
  'massage',
  'assisted-stretching',
  'soft-tissue-therapy',
  'body-exam'
)
on conflict (service_id, duration_minutes)
do update set
  price_gbp = excluded.price_gbp,
  active = true;

-- Approved V1 service areas, preserving the verified display order.
insert into public.service_areas (
  slug,
  name,
  active,
  travel_surcharge_gbp,
  congestion_fee_gbp,
  display_order
)
values
  ('chelsea', 'Chelsea', true, 0.00, 0.00, 10),
  ('kensington', 'Kensington', true, 0.00, 0.00, 20),
  ('fulham', 'Fulham', true, 0.00, 0.00, 30),
  ('chiswick', 'Chiswick', true, 0.00, 0.00, 40),
  ('hammersmith', 'Hammersmith', true, 0.00, 0.00, 50),
  ('belgravia', 'Belgravia', true, 0.00, 0.00, 60),
  ('ealing', 'Ealing', true, 0.00, 0.00, 70),
  ('acton', 'Acton', true, 0.00, 0.00, 80),
  ('mayfair', 'Mayfair', true, 0.00, 18.00, 90),
  ('notting-hill', 'Notting Hill', true, 0.00, 0.00, 100),
  ('shepherds-bush', 'Shepherd’s Bush', true, 0.00, 0.00, 110),
  ('earls-court', 'Earl’s Court', true, 0.00, 0.00, 120),
  ('westminster', 'Westminster', true, 0.00, 18.00, 130),
  ('paddington', 'Paddington', true, 0.00, 0.00, 140),
  ('marylebone', 'Marylebone', true, 0.00, 0.00, 150)
on conflict (slug)
do update set
  name = excluded.name,
  active = excluded.active,
  travel_surcharge_gbp = excluded.travel_surcharge_gbp,
  congestion_fee_gbp = excluded.congestion_fee_gbp,
  display_order = excluded.display_order;

-- Only the two genuine verified public enhancements are seeded.
-- The two unfinished V1 "New enhancement" records are intentionally omitted.
insert into public.enhancements (
  slug,
  name,
  description,
  price_gbp,
  duration_minutes,
  active,
  display_order
)
values
  (
    'extra-strong',
    'EXTRA STRONG',
    'Additional pressure',
    15.00,
    0,
    true,
    10
  ),
  (
    'aftercare-advice',
    'Aftercare advice',
    'Describe this enhancement.',
    0.00,
    0,
    true,
    20
  )
on conflict (slug)
do update set
  name = excluded.name,
  description = excluded.description,
  price_gbp = excluded.price_gbp,
  duration_minutes = excluded.duration_minutes,
  active = excluded.active,
  display_order = excluded.display_order;

-- Verified public session preferences.
insert into public.session_preferences (
  slug,
  label,
  category,
  active,
  display_order
)
values
  ('neck-focus', 'Neck focus', 'Focus area', true, 10),
  ('shoulder-focus', 'Shoulder focus', 'Focus area', true, 20),
  ('lower-back-focus', 'Lower-back focus', 'Focus area', true, 30),
  ('calf-focus', 'Calf focus', 'Focus area', true, 40),
  ('foot-focus', 'Foot focus', 'Focus area', true, 50),

  ('stronger-shoulders', 'Stronger shoulders', 'Pressure', true, 60),
  ('stronger-back', 'Stronger back', 'Pressure', true, 70),
  ('lighter-calves', 'Lighter calves', 'Pressure', true, 80),
  ('lighter-pressure', 'Lighter pressure', 'Pressure', true, 90),
  ('firm-pressure', 'Firm pressure', 'Pressure', true, 100),

  ('head-massage', 'Head massage', 'Include', true, 110),
  ('foot-massage', 'Foot massage', 'Include', true, 120),
  ('hand-massage', 'Hand massage', 'Include', true, 130),
  ('jaw-massage', 'Jaw massage', 'Include', true, 140),
  ('face-and-ears', 'Face and ears', 'Include', true, 150),
  ('abdomen-massage', 'Abdomen massage', 'Include', true, 160),

  ('avoid-feet', 'Avoid feet', 'Avoid', true, 170),
  ('avoid-head', 'Avoid head', 'Avoid', true, 180),
  ('avoid-abdomen', 'Avoid abdomen', 'Avoid', true, 190),
  ('avoid-sensitive-areas', 'Avoid sensitive areas', 'Avoid', true, 200)
on conflict (slug)
do update set
  label = excluded.label,
  category = excluded.category,
  active = excluded.active,
  display_order = excluded.display_order;

-- Four mutual conflicts. The conflict table is directional, so seed both
-- directions for each verified pair.
with conflict_slugs (left_slug, right_slug) as (
  values
    ('lighter-pressure', 'firm-pressure'),
    ('head-massage', 'avoid-head'),
    ('foot-massage', 'avoid-feet'),
    ('abdomen-massage', 'avoid-abdomen')
),
resolved as (
  select
    l.id as left_id,
    r.id as right_id
  from conflict_slugs c
  join public.session_preferences l on l.slug = c.left_slug
  join public.session_preferences r on r.slug = c.right_slug
),
directed as (
  select left_id as preference_id, right_id as conflicting_preference_id
  from resolved
  union all
  select right_id, left_id
  from resolved
)
insert into public.session_preference_conflicts (
  preference_id,
  conflicting_preference_id
)
select
  preference_id,
  conflicting_preference_id
from directed
on conflict (preference_id, conflicting_preference_id) do nothing;

-- ISO weekday numbering is used by the scheduling RPC:
-- 1 Monday through 7 Sunday.
insert into public.working_hours (
  weekday,
  available,
  start_minutes,
  end_minutes,
  start_mode,
  fixed_start_minutes
)
values
  (1, true, 855, 1170, 'flexible', null), -- Monday    14:15–19:30
  (2, true, 855, 1140, 'flexible', null), -- Tuesday   14:15–19:00
  (3, true, 855, 1260, 'flexible', null), -- Wednesday 14:15–21:00
  (4, true, 855, 1260, 'flexible', null), -- Thursday  14:15–21:00
  (5, true, 855, 1230, 'flexible', null), -- Friday    14:15–20:30
  (6, false, null, null, 'flexible', null), -- Saturday closed
  (7, true, 720, 1290, 'flexible', null)  -- Sunday    12:00–21:30
on conflict (weekday)
do update set
  available = excluded.available,
  start_minutes = excluded.start_minutes,
  end_minutes = excluded.end_minutes,
  start_mode = excluded.start_mode,
  fixed_start_minutes = excluded.fixed_start_minutes;
