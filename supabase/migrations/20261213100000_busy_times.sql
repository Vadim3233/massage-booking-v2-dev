-- VAD Massage Booking V2
-- Busiest times (ADR-101): the "Busiest times" section on the Income page, the "When … books" card on a client's page, and the optional
-- Monday "Your week" Telegram message. Nothing here changes a booking. It lists the facts; the app does the counting (src/admin/busyTimes.js).
--
-- What it lists:
--   visits    each visit with its date, start time and money received. A visit is a booking that was completed, or a confirmed booking whose
--             day has passed, the same rule as the client stats (ADR-099). A booking for two people is one visit. The money is what was
--             received for it after any refund (0 when still unpaid), from the same income_lines the Income page uses.
--   wanted    times someone tapped on the booking page although they were taken, in the last 90 days, once per visit, day and time
--             (Visitors, ADR-095). For one client, only theirs. Empty if the Visitors change is not applied.
--   days      (whole business only) each day from the first visit to two weeks ahead: the working minutes (the weekly hours, or that day's own
--             hours from Edit hours or Day settings, less blocked time) and the booked minutes (each going-ahead booking's treatment time plus
--             the travel time before it), counted in half hours. This is "How full".
--   regulars  (whole business only) clients with 3 or more visits and nothing booked: first name, phone, usual gap, last visit and how many
--             visits fell on each weekday, for the "usually book that day and are due" list.
--
-- The Monday message: when switched on (business_settings 'weekly_summary_telegram'), the every-minute sender asks weekly_summary_due() from
-- 08:00 London time on a Monday, writes the text with the same counting as the page, and queues it once for that week with
-- queue_weekly_summary(). It goes to the Admin's own Telegram, like the other Admin alerts.
--
-- Safe to run again: every function is created or replaced, and the grants are set again.
-- To take this back: drop function public.admin_busy_times(uuid); drop function public.busy_times_data(uuid, date);
-- drop function public.weekly_summary_due(timestamptz); drop function public.queue_weekly_summary(date, text);
-- drop function public.admin_weekly_summary(); drop function public.admin_save_weekly_summary(boolean);
-- delete from public.business_settings where key = 'weekly_summary_telegram';

-- ---------------------------------------------------------------------------------------------
-- The facts. Internal: only the functions below call it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.busy_times_data(p_client_id uuid, p_today date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_wanted jsonb := '[]'::jsonb;
  v_first date;
  v_days jsonb := '[]'::jsonb;
  v_regulars jsonb := '[]'::jsonb;
begin
  if to_regclass('public.visit_events') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('date', w.date, 'start_minutes', w.start_minutes) order by w.date, w.start_minutes), '[]'::jsonb)
      from (
        select distinct e.visit_id, (e.detail->>'date')::date as date, (e.detail->>'start')::integer as start_minutes
        from public.visit_events e
        where e.kind in ('wanted', 'asked') and e.at >= clock_timestamp() - interval '90 days'
          and ($1 is null or e.client_id = $1)
          and e.detail->>'date' ~ '^\d{4}-\d{2}-\d{2}$' and e.detail->>'start' ~ '^\d+$'
      ) w
    $q$ into v_wanted using p_client_id;
  end if;

  if p_client_id is null then
    select min(b.date) into v_first from public.bookings b
    where (b.booking_status = 'completed' or (b.booking_status = 'confirmed' and b.date < p_today)) and b.date < p_today;
    if v_first is not null then
      with dates as (
        select g::date as d from generate_series(greatest(v_first, p_today - 400), p_today + 13, interval '1 day') g
      ), windows as (
        select dt.d,
          case when o.date is not null then o.available else coalesce(w.available, false) end as available,
          case when o.date is not null then o.start_minutes else w.start_minutes end as s,
          case when o.date is not null then o.end_minutes else w.end_minutes end as e
        from dates dt
        left join public.working_hours_overrides o on o.date = dt.d
        left join public.working_hours w on w.weekday = extract(isodow from dt.d)::integer
      ), slots as (
        select wi.d, x.m
        from windows wi cross join lateral generate_series(wi.s, wi.e - 30, 30) x(m)
        where wi.available and wi.s is not null and wi.e is not null
      ), marked as (
        select sl.d, sl.m,
          exists (select 1 from public.calendar_blocks cb where cb.date = sl.d and cb.kind in ('blocked', 'personal_event')
                  and cb.start_minutes < sl.m + 30 and cb.end_minutes > sl.m) as blocked,
          exists (select 1 from public.bookings b where b.date = sl.d
                  and b.booking_status in ('completed', 'confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
                  and b.start_minutes - b.travel_buffer_minutes < sl.m + 30 and b.start_minutes + b.treatment_duration_minutes > sl.m) as booked
        from slots sl
      )
      select coalesce(jsonb_agg(jsonb_build_object('date', d, 'open', open_minutes, 'booked', booked_minutes) order by d), '[]'::jsonb) into v_days
      from (
        select dt.d,
          coalesce((select 30 * count(*) from marked mk where mk.d = dt.d and (not mk.blocked or mk.booked)), 0)::integer as open_minutes,
          coalesce((select 30 * count(*) from marked mk where mk.d = dt.d and mk.booked), 0)::integer as booked_minutes
        from dates dt
      ) per_day;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'first_name', c.first_name, 'phone', c.phone, 'gap_days', s.gap_days, 'last_visit', s.last_visit,
        'weekdays', (select jsonb_agg((select count(*) from public.bookings b
            where b.client_id = c.id and (b.booking_status = 'completed' or (b.booking_status = 'confirmed' and b.date < p_today))
              and extract(isodow from b.date)::integer = wd) order by wd) from generate_series(1, 7) wd))
        order by s.last_visit), '[]'::jsonb) into v_regulars
    from public.client_visit_stats(p_today) s join public.clients c on c.id = s.client_id
    where s.visits >= 3 and s.next_date is null;
  end if;

  return jsonb_build_object(
    'today', p_today,
    'wanted', v_wanted,
    'days', v_days,
    'regulars', v_regulars,
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object('date', b.date, 'start_minutes', b.start_minutes, 'net_gbp', coalesce(l.net_gbp, 0)) order by b.date, b.start_minutes)
      from public.bookings b
      left join public.income_lines('2000-01-01'::date, p_today) l on l.booking_id = b.id
      where (b.booking_status = 'completed' or (b.booking_status = 'confirmed' and b.date < p_today))
        and b.date < p_today
        and (p_client_id is null or b.client_id = p_client_id)), '[]'::jsonb));
end;
$$;
revoke all on function public.busy_times_data(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The Admin's read: the whole business (no client) or one client.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_busy_times(p_client_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_data jsonb;
begin
  perform public.require_booking_admin();
  v_data := public.busy_times_data(p_client_id, (clock_timestamp() at time zone 'Europe/London')::date);
  return v_data || jsonb_build_object('weekly_summary', coalesce((select (value #>> '{}')::boolean from public.business_settings where key = 'weekly_summary_telegram'), false));
end;
$$;
revoke all on function public.admin_busy_times(uuid) from public, anon;
grant execute on function public.admin_busy_times(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The Monday "Your week" switch (shown under Busiest times).
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_save_weekly_summary(p_on boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_booking_admin();
  insert into public.business_settings (key, value, updated_by) values ('weekly_summary_telegram', to_jsonb(coalesce(p_on, false)), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  return coalesce(p_on, false);
end;
$$;
revoke all on function public.admin_save_weekly_summary(boolean) from public, anon;
grant execute on function public.admin_save_weekly_summary(boolean) to authenticated;

-- For the sender only: the facts when this week's message is due (switched on, a Monday from 08:00 London, not queued yet), otherwise null.
create or replace function public.weekly_summary_due(p_now timestamptz default clock_timestamp())
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_local timestamp := p_now at time zone 'Europe/London';
  v_today date := (p_now at time zone 'Europe/London')::date;
begin
  if not coalesce((select (value #>> '{}')::boolean from public.business_settings where key = 'weekly_summary_telegram'), false) then return null; end if;
  if extract(isodow from v_today) <> 1 or extract(hour from v_local) < 8 then return null; end if;
  if exists (select 1 from public.event_outbox where deduplication_key = 'insight.weekly_summary:' || v_today::text) then return null; end if;
  return public.busy_times_data(null, v_today);
end;
$$;
revoke all on function public.weekly_summary_due(timestamptz) from public, anon, authenticated;
grant execute on function public.weekly_summary_due(timestamptz) to service_role;

-- For the sender only: queue the week's message once, for the Admin's Telegram. An empty text only marks the week as done.
create or replace function public.queue_weekly_summary(p_week date, p_body text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_event uuid;
begin
  if p_week is null then return false; end if;
  -- Recorded even when there is nothing worth sending, so the week is not looked at again every minute.
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('insight.weekly_summary', 'insight', gen_random_uuid(), 'insight.weekly_summary:' || p_week::text, jsonb_build_object('week', p_week))
  on conflict (deduplication_key) do nothing
  returning id into v_event;
  if v_event is null or nullif(btrim(coalesce(p_body, '')), '') is null then return false; end if;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
  values (v_event, 'telegram', 'admin', 'admin', 'Your week', left(p_body, 3500), '/admin/income')
  on conflict (event_id, channel, recipient) do nothing;
  return true;
end;
$$;
revoke all on function public.queue_weekly_summary(date, text) from public, anon, authenticated;
grant execute on function public.queue_weekly_summary(date, text) to service_role;
