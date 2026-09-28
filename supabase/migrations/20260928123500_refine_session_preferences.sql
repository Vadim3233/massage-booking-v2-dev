-- VAD Massage Booking V2
-- Refine public session-preference wording and coverage for a compact grouped UI.
--
-- Historical preference rows are preserved. Existing canonical rows are relabelled
-- in place where possible so their UUIDs remain stable. The superseded
-- "Face and ears" row is kept but made inactive.

-- Focus on
update public.session_preferences
set label = 'Neck', category = 'Focus on', active = true, display_order = 10
where slug = 'neck-focus';

update public.session_preferences
set label = 'Shoulders', category = 'Focus on', active = true, display_order = 20
where slug = 'shoulder-focus';

insert into public.session_preferences (slug, label, category, active, display_order)
values ('upper-back-focus', 'Upper back', 'Focus on', true, 30)
on conflict (slug) do update set
  label = excluded.label,
  category = excluded.category,
  active = excluded.active,
  display_order = excluded.display_order;

update public.session_preferences
set label = 'Lower back', category = 'Focus on', active = true, display_order = 40
where slug = 'lower-back-focus';

insert into public.session_preferences (slug, label, category, active, display_order)
values ('hips-glutes-focus', 'Hips & glutes', 'Focus on', true, 50)
on conflict (slug) do update set
  label = excluded.label,
  category = excluded.category,
  active = excluded.active,
  display_order = excluded.display_order;

update public.session_preferences
set label = 'Legs & calves', category = 'Focus on', active = true, display_order = 60
where slug = 'calf-focus';

update public.session_preferences
set label = 'Feet', category = 'Focus on', active = true, display_order = 70
where slug = 'foot-focus';

-- Pressure
update public.session_preferences
set label = 'Lighter overall', category = 'Pressure', active = true, display_order = 80
where slug = 'lighter-pressure';

update public.session_preferences
set label = 'Firm overall', category = 'Pressure', active = true, display_order = 90
where slug = 'firm-pressure';

update public.session_preferences
set label = 'Stronger shoulders', category = 'Pressure', active = true, display_order = 100
where slug = 'stronger-shoulders';

update public.session_preferences
set label = 'Stronger back', category = 'Pressure', active = true, display_order = 110
where slug = 'stronger-back';

update public.session_preferences
set label = 'Gentle on calves', category = 'Pressure', active = true, display_order = 120
where slug = 'lighter-calves';

-- Include
update public.session_preferences
set label = 'Head & scalp', category = 'Include', active = true, display_order = 130
where slug = 'head-massage';

update public.session_preferences
set label = 'Feet', category = 'Include', active = true, display_order = 140
where slug = 'foot-massage';

update public.session_preferences
set label = 'Hands', category = 'Include', active = true, display_order = 150
where slug = 'hand-massage';

update public.session_preferences
set label = 'Face & jaw', category = 'Include', active = true, display_order = 160
where slug = 'jaw-massage';

update public.session_preferences
set label = 'Abdomen', category = 'Include', active = true, display_order = 170
where slug = 'abdomen-massage';

update public.session_preferences
set active = false
where slug = 'face-and-ears';

-- Avoid
update public.session_preferences
set label = 'Head', category = 'Avoid', active = true, display_order = 180
where slug = 'avoid-head';

update public.session_preferences
set label = 'Feet', category = 'Avoid', active = true, display_order = 190
where slug = 'avoid-feet';

update public.session_preferences
set label = 'Abdomen', category = 'Avoid', active = true, display_order = 200
where slug = 'avoid-abdomen';

insert into public.session_preferences (slug, label, category, active, display_order)
values
  ('avoid-face', 'Face', 'Avoid', true, 210),
  ('avoid-glutes', 'Glutes', 'Avoid', true, 220)
on conflict (slug) do update set
  label = excluded.label,
  category = excluded.category,
  active = excluded.active,
  display_order = excluded.display_order;

update public.session_preferences
set label = 'Sensitive areas', category = 'Avoid', active = true, display_order = 230
where slug = 'avoid-sensitive-areas';

-- Rebuild conflicts for the managed public preference set. The table is
-- directional, so both directions are inserted.
delete from public.session_preference_conflicts
where preference_id in (
  select id from public.session_preferences
  where slug in (
    'lighter-pressure', 'firm-pressure',
    'head-massage', 'avoid-head',
    'foot-massage', 'avoid-feet',
    'abdomen-massage', 'avoid-abdomen',
    'jaw-massage', 'avoid-face',
    'foot-focus',
    'hips-glutes-focus', 'avoid-glutes'
  )
)
or conflicting_preference_id in (
  select id from public.session_preferences
  where slug in (
    'lighter-pressure', 'firm-pressure',
    'head-massage', 'avoid-head',
    'foot-massage', 'avoid-feet',
    'abdomen-massage', 'avoid-abdomen',
    'jaw-massage', 'avoid-face',
    'foot-focus',
    'hips-glutes-focus', 'avoid-glutes'
  )
);

with conflict_slugs (left_slug, right_slug) as (
  values
    ('lighter-pressure', 'firm-pressure'),
    ('head-massage', 'avoid-head'),
    ('foot-massage', 'avoid-feet'),
    ('abdomen-massage', 'avoid-abdomen'),
    ('jaw-massage', 'avoid-face'),
    ('foot-focus', 'avoid-feet'),
    ('hips-glutes-focus', 'avoid-glutes')
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
select preference_id, conflicting_preference_id
from directed
on conflict (preference_id, conflicting_preference_id) do nothing;
