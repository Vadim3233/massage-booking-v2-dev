-- VAD Massage Booking V2
-- A day's working hours for the Admin's Calendar, from the place the booking engine reads them (ADR-061).
--
-- The engine (compute_booking_availability) takes a date's hours from its special day if there is one, and otherwise from the usual week for its
-- weekday; a day that is not available offers nothing, and blocked time is taken out of the hours as busy time. day_hours(date) gives exactly that
-- row, read the same way, and admin_day_hours(from, to) gives one row per date for the Calendar, with the name of a block that covers the whole day.
-- The Calendar shows these and works none of it out itself. Nothing here changes how times are offered: the engine is not touched, and a database
-- test checks that the two agree.
--
-- To take this back: drop function public.admin_day_hours(date, date); drop function public.day_hours(date);

create function public.day_hours(p_date date)
returns table(source text, available boolean, start_minutes integer, end_minutes integer, start_mode text, fixed_start_minutes integer,
  anchor_release_minutes integer, schedule_mode text, note text)
language sql
stable
set search_path = ''
as $$
  -- A special day wins; otherwise the usual week; a weekday the usual week says nothing about is not worked.
  select 'special', o.available, o.start_minutes, o.end_minutes, o.start_mode, o.fixed_start_minutes, o.anchor_release_minutes, o.schedule_mode,
         nullif(btrim(o.note), '')
    from public.working_hours_overrides o
   where o.date = p_date
  union all
  select 'usual', w.available, w.start_minutes, w.end_minutes, w.start_mode, w.fixed_start_minutes, w.anchor_release_minutes, w.schedule_mode, null
    from public.working_hours w
   where w.weekday = extract(isodow from p_date)::smallint
     and not exists (select 1 from public.working_hours_overrides o where o.date = p_date)
  union all
  select 'usual', false, null, null, 'flexible', null, null, 'chain', null
   where not exists (select 1 from public.working_hours_overrides o where o.date = p_date)
     and not exists (select 1 from public.working_hours w where w.weekday = extract(isodow from p_date)::smallint);
$$;
revoke all on function public.day_hours(date) from public, anon, authenticated;
grant execute on function public.day_hours(date) to service_role;

-- One row per date from p_from to p_to (both included, at most a year), for the Admin only. `away` is the name of a block that covers the whole day
-- (time away, a holiday), which the booking engine treats as busy all day.
create function public.admin_day_hours(p_from date, p_to date)
returns table(date date, source text, available boolean, start_minutes integer, end_minutes integer, start_mode text, fixed_start_minutes integer,
  anchor_release_minutes integer, schedule_mode text, note text, away text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose a range of dates of up to a year' using errcode = '22023';
  end if;
  return query
    select d.day, h.source, h.available, h.start_minutes, h.end_minutes, h.start_mode, h.fixed_start_minutes, h.anchor_release_minutes,
           h.schedule_mode, h.note,
           (select coalesce(nullif(btrim(b.title), ''), case when b.kind = 'personal_event' then 'Personal event' else 'Blocked time' end)
              from public.calendar_blocks b
             where b.date = d.day and b.start_minutes = 0 and b.end_minutes = 1440
             order by b.created_at, b.id
             limit 1)
      from (select g::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
      cross join lateral public.day_hours(d.day) h
     order by d.day;
end;
$$;
revoke all on function public.admin_day_hours(date, date) from public, anon;
grant execute on function public.admin_day_hours(date, date) to authenticated, service_role;
