-- VAD Massage Booking V2
-- Visitors, and the times clients wanted (ADR-095).
--
-- 1. A short log of each visit to the booking page: which steps were reached, which days were looked at and how many times were free, which time
--    was picked, and whether it ended in a booking. Signed-in clients are named; everybody else is "a visitor". A visit is a random id made in the
--    page's memory, so nothing is stored on the visitor's phone and a stranger's two visits are never joined up. No IP address, no device details.
--    Rows are deleted after 90 days.
-- 2. "Wanted times": on the client's time screen, the times that are not free are shown faded, inside the working hours and up to a few hours
--    after them in the evening (a setting, 0 to 2 hours, 2 by default). Tapping one records that it was wanted; "Yes, let me know" puts the client
--    on the waitlist for that time with one tap when signed in, or with only a phone number or email otherwise.
-- 3. The waitlist alerts say which time a person asked for, and name who wanted the time when a booking on that day is cancelled.
--
-- To take this back: drop function public.admin_visits(date, date); drop function public.record_visit(uuid, text, jsonb);
-- drop function public.ask_for_time(date, integer, integer, text); drop function public.wanted_times(date, integer);
-- drop function public.admin_wanted_evening_hours(); drop function public.admin_save_wanted_evening_hours(integer);
-- drop table public.visit_events; delete from public.business_settings where key = 'wanted_evening_hours';
-- and restore plan_waitlist_notifications from 20261018100000_waitlist.sql.

insert into public.business_settings(key, value) values ('wanted_evening_hours', '2') on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- The visit log. Only the functions below write or read it.
-- ---------------------------------------------------------------------------------------------
create table public.visit_events (
  id bigint generated always as identity primary key,
  visit_id uuid not null,
  at timestamptz not null default clock_timestamp(),
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  user_id uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  constraint visit_events_kind_valid check (kind in ('opened', 'area', 'treatment', 'length', 'day', 'time', 'review', 'details', 'payment', 'booked', 'wanted', 'asked')),
  constraint visit_events_detail_valid check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 600)
);
create index visit_events_at_idx on public.visit_events (at);
create index visit_events_visit_idx on public.visit_events (visit_id, at);
alter table public.visit_events enable row level security;
revoke all on table public.visit_events from public, anon, authenticated;
-- The server may read and clear it (tests, support); browsers only reach it through the functions below (ADR-075: a new table states its grants).
grant select, delete on table public.visit_events to service_role;

-- One step of a visit. Anyone may call it (the booking page is public); it keeps only known details, short values, and a fair number of rows.
create function public.record_visit(p_visit uuid, p_kind text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_detail jsonb;
  v_client uuid;
  v_booking uuid;
begin
  if p_visit is null or p_kind is null or p_kind not in ('opened', 'area', 'treatment', 'length', 'day', 'time', 'review', 'details', 'payment', 'booked', 'wanted', 'asked') then
    return;
  end if;
  -- Only these details, and only short plain values.
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_detail
    from jsonb_each(case when jsonb_typeof(p_detail) = 'object' then p_detail else '{}'::jsonb end) e
   where e.key in ('date', 'start', 'minutes', 'people', 'free', 'pref', 'booking_id', 'step')
     and jsonb_typeof(e.value) in ('string', 'number', 'boolean') and length(e.value::text) <= 60;

  -- A visit has at most 300 steps; at most 3000 rows an hour in all, so the log cannot be flooded.
  if (select count(*) from public.visit_events where visit_id = p_visit) >= 300 then return; end if;
  if (select count(*) from public.visit_events where at > clock_timestamp() - interval '1 hour') >= 3000 then return; end if;

  if auth.uid() is not null then
    select c.id into v_client from public.clients c where c.auth_user_id = auth.uid();
  end if;
  -- A booking counts only if it is this person's own.
  if p_kind = 'booked' then
    begin v_booking := (v_detail->>'booking_id')::uuid; exception when others then v_booking := null; end;
    if v_booking is null or v_client is null or not exists (select 1 from public.bookings b where b.id = v_booking and b.client_id = v_client) then
      return;
    end if;
  end if;

  insert into public.visit_events(visit_id, kind, detail, user_id, client_id) values (p_visit, p_kind, v_detail, auth.uid(), v_client);
  -- Kept for 90 days.
  if p_kind = 'opened' then
    delete from public.visit_events where at < clock_timestamp() - interval '90 days';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Wanted times: every half-hour start a client could ask about on a day, free or not. The booking page shows the free ones as usual and the
-- rest faded. Inside the working hours, plus up to wanted_evening_hours after the end of the day; nothing before the day starts, nothing on a
-- day off, nothing over blocked time or a personal event, nothing already gone or inside the notice period.
-- ---------------------------------------------------------------------------------------------
create function public.wanted_times(p_date date, p_duration_minutes integer)
returns table(start_minutes integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_day record;
  v_extra integer := least(greatest(public.business_setting_int('wanted_evening_hours', 2), 0), 2) * 60;
  v_earliest timestamptz := clock_timestamp() + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120));
begin
  if p_date is null or p_date < v_today or p_date > v_today + public.business_setting_int('booking_horizon_days', 40) then return; end if;
  if p_duration_minutes is null or p_duration_minutes not between 60 and 240 or p_duration_minutes % 30 <> 0 then return; end if;
  select * into v_day from public.day_hours(p_date);
  if not coalesce(v_day.available, false) or v_day.start_minutes is null or v_day.end_minutes is null then return; end if;
  return query
  select m::integer
    from generate_series(v_day.start_minutes, least(v_day.end_minutes + v_extra, 1440) - p_duration_minutes, 30) m
   where ((p_date + make_interval(mins => m)) at time zone 'Europe/London') > v_earliest
     and not exists (select 1 from public.calendar_blocks k where k.date = p_date and m < k.end_minutes and m + p_duration_minutes > k.start_minutes)
   order by m;
end;
$$;

-- "Yes, let me know" on a faded time. A client with an account (or a guest who has given their details) needs nothing more; anybody else gives
-- a phone number or an email address in p_contact. Asking again on the same day (same length) widens the one request to cover both times.
create function public.ask_for_time(p_date date, p_start_minutes integer, p_duration_minutes integer, p_contact text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
  v_name text;
  v_phone text;
  v_email text;
  v_id uuid;
begin
  if p_start_minutes is null or p_start_minutes < 0 or p_start_minutes % 30 <> 0 or p_duration_minutes is null
     or p_start_minutes + coalesce(p_duration_minutes, 0) > 1440 then
    raise exception 'Please choose a time.' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    select * into v_client from public.clients c where c.auth_user_id = auth.uid();
  end if;
  if v_client.id is not null then
    v_name := coalesce(nullif(btrim(v_client.first_name || ' ' || coalesce(v_client.last_name, '')), ''), 'Client');
    v_phone := v_client.phone;
    v_email := v_client.email;
  end if;
  if v_phone is null and v_email is null and auth.uid() is not null then
    select nullif(btrim(u.email), '') into v_email from auth.users u where u.id = auth.uid();
  end if;
  if v_contact is not null then
    if position('@' in v_contact) > 0 then v_email := v_contact; else v_phone := v_contact; end if;
  end if;
  if v_phone is null and v_email is null then
    raise exception 'Please add a phone number or email, so I can let you know.' using errcode = '22023';
  end if;
  v_id := public.join_waitlist(p_date, p_start_minutes, p_start_minutes + 30, p_duration_minutes, coalesce(v_name, 'Visitor'), v_phone, v_email, null);
  update public.waitlist_requests
     set preferred_from_minutes = least(preferred_from_minutes, p_start_minutes), preferred_to_minutes = greatest(preferred_to_minutes, p_start_minutes + 30)
   where id = v_id and (preferred_from_minutes > p_start_minutes or preferred_to_minutes < p_start_minutes + 30);
  return v_id;
end;
$$;

-- The setting, for the Booking rules page.
create function public.admin_wanted_evening_hours()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return least(greatest(public.business_setting_int('wanted_evening_hours', 2), 0), 2);
end;
$$;

create function public.admin_save_wanted_evening_hours(p_hours integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 0 and 2 then
    raise exception 'Choose 0, 1 or 2 hours' using errcode = '22023';
  end if;
  insert into public.business_settings(key, value, updated_by) values ('wanted_evening_hours', to_jsonb(p_hours), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The Admin's Visitors page: every visit that started between two dates (London time, both included, at most 92 days), newest first, with its
-- steps in order. A visit is named after the client if they were signed in at any point of it. A 'booked' step carries the booking's status.
-- ---------------------------------------------------------------------------------------------
create function public.admin_visits(p_from date, p_to date)
returns table(visit_id uuid, started_at timestamptz, last_at timestamptz, client_id uuid, client_name text, client_phone text, client_email text,
  last_booked date, events jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'Choose up to three months' using errcode = '22023';
  end if;
  delete from public.visit_events where at < clock_timestamp() - interval '90 days';
  return query
  with visits as (
    select e.visit_id as id, min(e.at) as first_at, max(e.at) as last_seen,
           (array_agg(e.client_id order by e.at desc) filter (where e.client_id is not null))[1] as cid
      from public.visit_events e
     group by e.visit_id
    having (min(e.at) at time zone 'Europe/London')::date between p_from and p_to
  )
  select v.id, v.first_at, v.last_seen, c.id,
         nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.phone, c.email,
         (select max(b.date) from public.bookings b where b.client_id = c.id and b.date < v_today and b.booking_status in ('confirmed', 'completed')),
         (select jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind,
                   'detail', e.detail || case when e.kind = 'booked' then jsonb_build_object('status', (select b.booking_status from public.bookings b where b.id::text = e.detail->>'booking_id')) else '{}'::jsonb end)
                 order by e.at, e.id)
            from public.visit_events e where e.visit_id = v.id)
    from visits v
    left join public.clients c on c.id = v.cid
   order by v.first_at desc
   limit 2000;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Waitlist alerts: a request for one time says "at 09:00"; a cancelled booking names who wanted that part of the day.
-- ---------------------------------------------------------------------------------------------
create or replace function public.plan_waitlist_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
  v_body text;
  v_date date;
  v_waiting integer;
  v_name text;
  v_from integer;
  v_to integer;
  v_start integer;
  v_end integer;
  v_wanted text;
begin
  if new.event_type = 'waitlist.joined' then
    select w.contact_name, w.requested_date into v_name, v_date from public.waitlist_requests w where w.id = new.aggregate_id;
    if v_name is null then return null; end if;
    v_from := (new.payload->>'from_minutes')::integer;
    v_to := (new.payload->>'to_minutes')::integer;
    v_title := 'Someone joined the waitlist';
    v_body := format('%s: %s, %s, %s minutes.', v_name, to_char(v_date, 'FMDy FMDD FMMon'),
      case when v_from = 0 and v_to = 1440 then 'any time'
           when v_to - v_from = 30 then 'at ' || lpad((v_from / 60)::text, 2, '0') || ':' || lpad((v_from % 60)::text, 2, '0')
           else lpad((v_from / 60)::text, 2, '0') || ':' || lpad((v_from % 60)::text, 2, '0')
             || ' to ' || lpad((v_to / 60)::text, 2, '0') || ':' || lpad((v_to % 60)::text, 2, '0') end,
      new.payload->>'duration_minutes');
  elsif new.event_type in ('booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected') and new.aggregate_type = 'booking' then
    select b.date, b.start_minutes - coalesce(b.travel_buffer_minutes, 0), b.start_minutes + b.treatment_duration_minutes + coalesce(b.travel_buffer_minutes, 0)
      into v_date, v_start, v_end from public.bookings b where b.id = new.aggregate_id;
    if v_date is null or v_date < (clock_timestamp() at time zone 'Europe/London')::date then return null; end if;
    select count(*)::integer into v_waiting from public.waitlist_requests w where w.requested_date = v_date and w.status <> 'closed';
    if v_waiting = 0 then return null; end if;
    -- Who asked for a time this booking (with its travel) was in the way of.
    select string_agg(w.contact_name || ' wanted ' || case when w.preferred_from_minutes = 0 and w.preferred_to_minutes = 1440 then 'any time'
             else lpad((w.preferred_from_minutes / 60)::text, 2, '0') || ':' || lpad((w.preferred_from_minutes % 60)::text, 2, '0') end, '; ' order by w.created_at)
      into v_wanted
      from (select * from public.waitlist_requests w where w.requested_date = v_date and w.status <> 'closed'
               and w.preferred_from_minutes < v_end and w.preferred_to_minutes > v_start order by w.created_at limit 3) w;
    v_title := 'A time may have opened up';
    v_body := concat_ws(' ', v_wanted || '.',
      format('%s waiting for %s. Open the waitlist to see who could be booked.', case when v_waiting = 1 then '1 person is' else v_waiting::text || ' people are' end, to_char(v_date, 'FMDy FMDD FMMon')));
  else
    return null;
  end if;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
  values (new.id, 'in_app', 'admin', 'admin-waitlist', v_title, v_body, '/admin/waitlist', 'sent', clock_timestamp());
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
  values (new.id, 'telegram', 'admin', 'admin-waitlist', v_title, v_body, '/admin/waitlist'),
         (new.id, 'email', 'admin', 'admin-waitlist', v_title, v_body, '/admin/waitlist');
  return null;
end;
$$;

revoke all on function public.record_visit(uuid, text, jsonb) from public;
revoke all on function public.wanted_times(date, integer) from public;
revoke all on function public.ask_for_time(date, integer, integer, text) from public;
revoke all on function public.admin_wanted_evening_hours() from public, anon;
revoke all on function public.admin_save_wanted_evening_hours(integer) from public, anon;
revoke all on function public.admin_visits(date, date) from public, anon;
revoke all on function public.plan_waitlist_notifications() from public, anon, authenticated;
grant execute on function public.record_visit(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.wanted_times(date, integer) to anon, authenticated;
grant execute on function public.ask_for_time(date, integer, integer, text) to anon, authenticated;
grant execute on function public.admin_wanted_evening_hours() to authenticated;
grant execute on function public.admin_save_wanted_evening_hours(integer) to authenticated;
grant execute on function public.admin_visits(date, date) to authenticated;
