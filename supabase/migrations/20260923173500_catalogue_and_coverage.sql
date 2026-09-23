-- VAD Massage Booking V2
-- Foundation migration 2: service catalogue, prices, enhancements, preferences and coverage.
-- No booking rows or scheduling state are introduced here.

create table public.services (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  short_description text,
  long_description text,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint services_slug_not_blank
    check (length(btrim(slug)) > 0),
  constraint services_name_not_blank
    check (length(btrim(name)) > 0),
  constraint services_display_order_nonnegative
    check (display_order >= 0)
);

create trigger services_set_updated_at
before update on public.services
for each row execute function public.set_updated_at();

create index services_active_display_order_idx
  on public.services (active, display_order, name);

alter table public.services enable row level security;

create policy "authenticated users can read active services"
on public.services
for select
to authenticated
using (active);

create policy "admins can manage services"
on public.services
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.service_duration_prices (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  duration_minutes integer not null,
  price_gbp numeric(10,2) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_duration_prices_duration_supported
    check (duration_minutes in (60, 90, 120)),
  constraint service_duration_prices_price_nonnegative
    check (price_gbp >= 0),
  unique (service_id, duration_minutes)
);

create trigger service_duration_prices_set_updated_at
before update on public.service_duration_prices
for each row execute function public.set_updated_at();

create index service_duration_prices_active_idx
  on public.service_duration_prices (service_id, active, duration_minutes);

alter table public.service_duration_prices enable row level security;

create policy "authenticated users can read active service prices"
on public.service_duration_prices
for select
to authenticated
using (
  active
  and exists (
    select 1
    from public.services
    where services.id = service_duration_prices.service_id
      and services.active
  )
);

create policy "admins can manage service prices"
on public.service_duration_prices
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.enhancements (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  price_gbp numeric(10,2) not null default 0,
  duration_minutes integer not null default 0,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint enhancements_slug_not_blank
    check (length(btrim(slug)) > 0),
  constraint enhancements_name_not_blank
    check (length(btrim(name)) > 0),
  constraint enhancements_price_nonnegative
    check (price_gbp >= 0),
  constraint enhancements_duration_nonnegative
    check (duration_minutes >= 0),
  constraint enhancements_display_order_nonnegative
    check (display_order >= 0)
);

create trigger enhancements_set_updated_at
before update on public.enhancements
for each row execute function public.set_updated_at();

create index enhancements_active_display_order_idx
  on public.enhancements (active, display_order, name);

alter table public.enhancements enable row level security;

create policy "authenticated users can read active enhancements"
on public.enhancements
for select
to authenticated
using (active);

create policy "admins can manage enhancements"
on public.enhancements
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.session_preferences (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  category text not null,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_preferences_slug_not_blank
    check (length(btrim(slug)) > 0),
  constraint session_preferences_label_not_blank
    check (length(btrim(label)) > 0),
  constraint session_preferences_category_not_blank
    check (length(btrim(category)) > 0),
  constraint session_preferences_display_order_nonnegative
    check (display_order >= 0)
);

create trigger session_preferences_set_updated_at
before update on public.session_preferences
for each row execute function public.set_updated_at();

create index session_preferences_active_display_order_idx
  on public.session_preferences (active, display_order, label);

alter table public.session_preferences enable row level security;

create policy "authenticated users can read active session preferences"
on public.session_preferences
for select
to authenticated
using (active);

create policy "admins can manage session preferences"
on public.session_preferences
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.session_preference_conflicts (
  preference_id uuid not null references public.session_preferences(id) on delete cascade,
  conflicting_preference_id uuid not null references public.session_preferences(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (preference_id, conflicting_preference_id),
  constraint session_preference_conflicts_not_self
    check (preference_id <> conflicting_preference_id)
);

alter table public.session_preference_conflicts enable row level security;

create policy "authenticated users can read preference conflicts"
on public.session_preference_conflicts
for select
to authenticated
using (
  exists (
    select 1
    from public.session_preferences p
    where p.id = session_preference_conflicts.preference_id
      and p.active
  )
  and exists (
    select 1
    from public.session_preferences p
    where p.id = session_preference_conflicts.conflicting_preference_id
      and p.active
  )
);

create policy "admins can manage preference conflicts"
on public.session_preference_conflicts
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.service_areas (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  travel_surcharge_gbp numeric(10,2) not null default 0,
  congestion_fee_gbp numeric(10,2) not null default 0,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_areas_slug_not_blank
    check (length(btrim(slug)) > 0),
  constraint service_areas_name_not_blank
    check (length(btrim(name)) > 0),
  constraint service_areas_travel_surcharge_nonnegative
    check (travel_surcharge_gbp >= 0),
  constraint service_areas_congestion_fee_nonnegative
    check (congestion_fee_gbp >= 0),
  constraint service_areas_display_order_nonnegative
    check (display_order >= 0)
);

create trigger service_areas_set_updated_at
before update on public.service_areas
for each row execute function public.set_updated_at();

create index service_areas_active_display_order_idx
  on public.service_areas (active, display_order, name);

alter table public.service_areas enable row level security;

create policy "authenticated users can read active service areas"
on public.service_areas
for select
to authenticated
using (active);

create policy "admins can manage service areas"
on public.service_areas
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

-- Seed only the stable V1 service identities.
-- Prices, enhancements, preferences and service areas remain configurable and
-- are intentionally not guessed in this migration.
insert into public.services (slug, name, short_description, display_order)
values
  ('massage', 'Massage', 'Bespoke mobile massage tailored to your body.', 10),
  ('assisted-stretching', 'Assisted Stretching', 'Guided stretching for mobility and ease.', 20),
  ('soft-tissue-therapy', 'Soft Tissue Therapy', 'Targeted soft tissue work for recovery.', 30),
  ('body-exam', 'Body Exam', 'Focused assessment before treatment planning.', 40)
on conflict (slug) do nothing;

revoke all on table public.services from anon;
revoke all on table public.service_duration_prices from anon;
revoke all on table public.enhancements from anon;
revoke all on table public.session_preferences from anon;
revoke all on table public.session_preference_conflicts from anon;
revoke all on table public.service_areas from anon;

grant select on table public.services to authenticated;
grant select on table public.service_duration_prices to authenticated;
grant select on table public.enhancements to authenticated;
grant select on table public.session_preferences to authenticated;
grant select on table public.session_preference_conflicts to authenticated;
grant select on table public.service_areas to authenticated;

grant insert, update, delete on table public.services to authenticated;
grant insert, update, delete on table public.service_duration_prices to authenticated;
grant insert, update, delete on table public.enhancements to authenticated;
grant insert, update, delete on table public.session_preferences to authenticated;
grant insert, update, delete on table public.session_preference_conflicts to authenticated;
grant insert, update, delete on table public.service_areas to authenticated;
