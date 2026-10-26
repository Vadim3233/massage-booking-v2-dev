-- VAD Massage Booking V2
-- A day as half-hour blocks the Admin taps open or closed (ADR-080).
--
-- Nothing new is stored and the booking engine is not touched. The grid is another way to write the two things a day already has:
--   * its working hours, from the first open half hour to the end of the last one, saved as a special day when they differ from what the day has now;
--   * closed half hours inside those hours, saved as plain blocked time (kind 'blocked', no label, no notes, on this date only).
-- Only that plain, one-day blocked time belongs to the grid: saving replaces it. Blocked time with a label or notes, personal events, a block that runs
-- over several days and time kept free for a repeating client are left exactly as they are.
--
-- admin_day_grid(date) shows the day as 48 half hours, worked out here so the screen works none of it out. admin_save_day_grid(date, open half hours)
-- saves it in one go. A half hour that a live booking or its travel time touches, or that other blocked time covers, cannot be changed from the grid,
-- so blocked time never lands on a booking or its travel. Closing time a client is in the middle of booking is asked about first.
--
-- To take this back: drop function public.admin_save_day_grid(date, integer[], boolean); drop function public.admin_day_grid(date);
-- drop function public.day_grid(date);

-- The day's 48 half hours. `open`: inside the working hours and not blocked. `locked`: 'booking' (its treatment), 'travel' (its travel time),
-- 'block' (blocked time the grid does not own), or null when the Admin can tap it. `label`: the client's name on a booking's half hours, the
-- name of blocked time the grid does not own on its half hours. `held`: a client is in the middle of booking this time.
create function public.day_grid(p_date date)
returns table(start_minutes integer, open boolean, locked text, label text, booking_id uuid, held boolean)
language sql
stable
set search_path = ''
as $$
  with day as (select * from public.day_hours(p_date)),
  live as (
    select b.id, b.start_minutes as s, b.start_minutes + b.treatment_duration_minutes as e, b.travel_buffer_minutes as t,
           coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'Client') as name
      from public.bookings b
      join public.clients c on c.id = b.client_id
     where b.date = p_date
       and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed')
  ),
  -- Plain one-day blocked time is the grid's own; everything else in calendar_blocks is somebody else's and stays.
  blocks as (
    select cb.start_minutes as s, cb.end_minutes as e, cb.kind, cb.title,
           cb.kind = 'blocked' and nullif(btrim(coalesce(cb.title, '')), '') is null and nullif(btrim(coalesce(cb.notes, '')), '') is null
             and not exists (select 1 from public.calendar_blocks other where other.group_id = cb.group_id and other.date <> cb.date) as own
      from public.calendar_blocks cb
     where cb.date = p_date
  )
  select m,
         d.available and m >= d.start_minutes and m + 30 <= d.end_minutes
           and not exists (select 1 from blocks k where m < k.e and m + 30 > k.s),
         case when exists (select 1 from live l where m < l.e and m + 30 > l.s) then 'booking'
              when exists (select 1 from live l where m < l.e + l.t and m + 30 > l.s - l.t) then 'travel'
              when exists (select 1 from blocks k where not k.own and m < k.e and m + 30 > k.s) then 'block' end,
         coalesce(
           (select l.name from live l where m < l.e and m + 30 > l.s order by l.s limit 1),
           (select case when k.kind = 'series_hold' then 'Kept free for a repeating client'
                        else coalesce(nullif(btrim(k.title), ''), case when k.kind = 'personal_event' then 'Personal event' else 'Blocked time' end) end
              from blocks k where not k.own and m < k.e and m + 30 > k.s order by k.s limit 1)),
         (select l.id from live l where m < l.e and m + 30 > l.s order by l.s limit 1),
         exists (select 1 from public.booking_holds h
                  where h.date = p_date and h.status = 'active' and h.expires_at > now()
                    and m < h.start_minutes + h.treatment_duration_minutes and m + 30 > h.start_minutes)
    from generate_series(0, 1410, 30) m
    cross join day d
   order by m;
$$;
revoke all on function public.day_grid(date) from public, anon, authenticated;
grant execute on function public.day_grid(date) to service_role;

create function public.admin_day_grid(p_date date)
returns table(start_minutes integer, open boolean, locked text, label text, booking_id uuid, held boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_date is null then
    raise exception 'Choose a date' using errcode = '22023';
  end if;
  return query select * from public.day_grid(p_date);
end;
$$;
revoke all on function public.admin_day_grid(date) from public, anon;
grant execute on function public.admin_day_grid(date) to authenticated, service_role;

-- Save the grid: p_open is every half hour (its start, in minutes from midnight) the Admin wants to work. Returns what was saved, or, when the change
-- closes time a client is in the middle of booking and p_close_held is not true, saves nothing and says which times those are.
create function public.admin_save_day_grid(p_date date, p_open integer[], p_close_held boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Europe/London')::date;
  v_open integer[];
  v_day record;
  v_usual record;
  v_start integer;
  v_end integer;
  v_mode text;
  v_fixed integer;
  v_release integer;
  v_schedule text;
  v_held integer[];
  v_from integer;
  v_minute integer;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_date is null or p_open is null then
    raise exception 'Choose a date and the times you are working' using errcode = '22023';
  end if;
  if p_date < v_today then
    raise exception 'This day has passed, so its hours cannot be changed' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_open) o where o is null or o < 0 or o > 1410 or o % 30 <> 0) then
    raise exception 'Each time must be on the hour or half hour' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct o order by o), '{}') into v_open from unnest(p_open) o;

  -- The same lock a client's hold and a new booking take for this date, so neither can arrive half way through.
  perform pg_advisory_xact_lock(42420, hashtext(p_date::text));

  -- A half hour a booking, its travel time or other blocked time touches stays as it is. The screen does not let these be tapped, so a difference
  -- means the day changed while it was being edited.
  if exists (select 1 from public.day_grid(p_date) g where g.locked is not null and g.open <> (g.start_minutes = any(v_open))) then
    raise exception 'This day changed while you were editing it. Look at it again before saving.' using errcode = '55000';
  end if;

  select coalesce(array_agg(g.start_minutes order by g.start_minutes), '{}') into v_held
    from public.day_grid(p_date) g where g.held and g.open and not (g.start_minutes = any(v_open));
  if cardinality(v_held) > 0 and not coalesce(p_close_held, false) then
    return jsonb_build_object('saved', false, 'held', to_jsonb(v_held));
  end if;

  select * into v_day from public.day_hours(p_date);

  if cardinality(v_open) = 0 then
    if v_day.available then
      insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes, anchor_release_minutes,
        schedule_mode, note)
      values (p_date, false, null, null, 'flexible', null, null, 'chain', v_day.note)
      on conflict (date) do update set available = false, start_minutes = null, end_minutes = null, start_mode = 'flexible',
        fixed_start_minutes = null, anchor_release_minutes = null, schedule_mode = 'chain';
    end if;
    delete from public.calendar_blocks cb where cb.date = p_date and cb.kind = 'blocked'
      and nullif(btrim(coalesce(cb.title, '')), '') is null and nullif(btrim(coalesce(cb.notes, '')), '') is null
      and not exists (select 1 from public.calendar_blocks other where other.group_id = cb.group_id and other.date <> cb.date);
    return jsonb_build_object('saved', true, 'available', false);
  end if;

  v_start := v_open[1];
  v_end := v_open[cardinality(v_open)] + 30;

  -- The rest of the day's settings stay. A day off being opened takes them from the usual week for its weekday.
  if v_day.available then
    v_mode := v_day.start_mode; v_fixed := v_day.fixed_start_minutes; v_release := v_day.anchor_release_minutes; v_schedule := v_day.schedule_mode;
  else
    select w.* into v_usual from public.working_hours w where w.weekday = extract(isodow from p_date)::smallint and w.available;
    v_mode := coalesce(v_usual.start_mode, 'flexible'); v_fixed := v_usual.fixed_start_minutes;
    v_release := v_usual.anchor_release_minutes; v_schedule := coalesce(v_usual.schedule_mode, 'chain');
  end if;
  if v_mode = 'fixed' and (v_fixed is null or not ((v_fixed - v_fixed % 30) = any(v_open))) then
    raise exception 'Your first appointment is set for %, which would not be working time. Change it in Day settings first.',
      to_char(make_time(v_fixed / 60, v_fixed % 60, 0), 'HH24:MI') using errcode = '22023';
  end if;

  if not v_day.available or v_day.start_minutes <> v_start or v_day.end_minutes <> v_end then
    insert into public.working_hours_overrides(date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes, anchor_release_minutes,
      schedule_mode, note)
    values (p_date, true, v_start, v_end, v_mode,
            case when v_mode = 'fixed' then v_fixed end, case when v_mode = 'fixed' then v_release end,
            case when v_schedule = 'flexible' then 'flexible' else 'chain' end, v_day.note)
    on conflict (date) do update set available = true, start_minutes = excluded.start_minutes, end_minutes = excluded.end_minutes,
      start_mode = excluded.start_mode, fixed_start_minutes = excluded.fixed_start_minutes, anchor_release_minutes = excluded.anchor_release_minutes,
      schedule_mode = excluded.schedule_mode;
  end if;

  -- The grid's own blocked time is replaced by the closed half hours inside the new hours, each run of them one block. Time other blocked time
  -- already covers is left to that block.
  delete from public.calendar_blocks cb where cb.date = p_date and cb.kind = 'blocked'
    and nullif(btrim(coalesce(cb.title, '')), '') is null and nullif(btrim(coalesce(cb.notes, '')), '') is null
    and not exists (select 1 from public.calendar_blocks other where other.group_id = cb.group_id and other.date <> cb.date);
  v_from := null;
  for v_minute in select generate_series(v_start, v_end, 30) loop
    if v_minute < v_end and not (v_minute = any(v_open))
       and not exists (select 1 from public.calendar_blocks cb where cb.date = p_date and v_minute < cb.end_minutes and v_minute + 30 > cb.start_minutes) then
      v_from := coalesce(v_from, v_minute);
    elsif v_from is not null then
      insert into public.calendar_blocks(date, start_minutes, end_minutes, kind, created_by) values (p_date, v_from, v_minute, 'blocked', auth.uid());
      v_from := null;
    end if;
  end loop;

  return jsonb_build_object('saved', true, 'available', true, 'start_minutes', v_start, 'end_minutes', v_end);
end;
$$;
revoke all on function public.admin_save_day_grid(date, integer[], boolean) from public, anon;
grant execute on function public.admin_save_day_grid(date, integer[], boolean) to authenticated;
