-- VAD Massage Booking V2
-- Public booking discovery.
-- Preserve the existing client flow: Area -> Treatment -> Duration ->
-- Date & Time -> Review -> Your Details -> Payment.
-- Catalogue and availability must therefore be readable before sign-in,
-- while private calendar rows remain inaccessible.

create policy "anonymous users can read active services"
on public.services
for select
to anon
using (active);

create policy "anonymous users can read active service prices"
on public.service_duration_prices
for select
to anon
using (
  active
  and exists (
    select 1
    from public.services
    where services.id = service_duration_prices.service_id
      and services.active
  )
);

create policy "anonymous users can read active enhancements"
on public.enhancements
for select
to anon
using (active);

create policy "anonymous users can read active session preferences"
on public.session_preferences
for select
to anon
using (active);

create policy "anonymous users can read preference conflicts"
on public.session_preference_conflicts
for select
to anon
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

create policy "anonymous users can read active service areas"
on public.service_areas
for select
to anon
using (active);

grant select on table public.services to anon;
grant select on table public.service_duration_prices to anon;
grant select on table public.enhancements to anon;
grant select on table public.session_preferences to anon;
grant select on table public.session_preference_conflicts to anon;
grant select on table public.service_areas to anon;

create or replace function public.get_booking_availability(
  p_date date,
  p_treatment_duration_minutes integer
)
returns table (start_minutes integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_london_today date := (now() at time zone 'Europe/London')::date;
  v_london_now_minutes integer := (
    extract(hour from now() at time zone 'Europe/London')::integer * 60
    + extract(minute from now() at time zone 'Europe/London')::integer
  );
begin
  if p_date is null then
    raise exception 'Booking date is required' using errcode = '22023';
  end if;

  if (
    p_treatment_duration_minutes is null
    or p_treatment_duration_minutes < 60
    or p_treatment_duration_minutes > 240
    or mod(p_treatment_duration_minutes, 30) <> 0
  ) then
    raise exception 'Booking duration is invalid'
      using errcode = '22023';
  end if;

  if p_date < v_london_today then
    return;
  end if;

  return query
  select a.start_minutes
  from public.compute_booking_availability(
    p_date,
    p_treatment_duration_minutes,
    v_now,
    60
  ) a
  where (
    p_date > v_london_today
    or a.start_minutes >= v_london_now_minutes + 120
  )
  order by a.start_minutes;
end;
$$;

revoke all on function public.get_booking_availability(date, integer)
  from public;
grant execute on function public.get_booking_availability(date, integer)
  to anon, authenticated;
