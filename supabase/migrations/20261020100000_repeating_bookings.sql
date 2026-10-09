-- Repeating bookings (ADR-030). A repeat is one standing rule, not a year of bookings:
--  * the rule keeps the weekly slot free (as blocked time) until it ends, so nobody else can take it;
--  * a real booking is made for the first session straight away, and for each later session a few days ahead
--    (the payment reminder window), which is when the client is asked to pay for it;
--  * a cancelled, moved or skipped date is released and never recreated; nothing is cancelled automatically.

create table public.booking_series (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  status text not null default 'active',
  weekday smallint not null,
  first_date date not null,
  end_date date,
  start_minutes integer not null,
  treatment_duration_minutes integer not null,
  request jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint booking_series_status_valid check (status in ('active', 'paused', 'ended')),
  constraint booking_series_weekday_valid check (weekday between 1 and 7),
  constraint booking_series_start_valid check (start_minutes between 0 and 1439 and mod(start_minutes, 30) = 0),
  constraint booking_series_duration_valid check (treatment_duration_minutes between 30 and 480),
  constraint booking_series_end_valid check (end_date is null or end_date >= first_date),
  constraint booking_series_request_is_object check (jsonb_typeof(request) = 'object')
);
create trigger booking_series_set_updated_at before update on public.booking_series
  for each row execute function public.set_updated_at();
create index booking_series_client_idx on public.booking_series (client_id);
create index booking_series_active_idx on public.booking_series (status) where status = 'active';

create table public.booking_series_skips (
  series_id uuid not null references public.booking_series(id) on delete cascade,
  date date not null,
  reason text not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (series_id, date),
  constraint booking_series_skips_reason_valid check (reason in ('skipped', 'cancelled', 'moved', 'clash'))
);

alter table public.booking_series enable row level security;
alter table public.booking_series_skips enable row level security;
revoke all on public.booking_series, public.booking_series_skips from anon, authenticated;

alter table public.bookings add column series_id uuid references public.booking_series(id) on delete set null;
create unique index bookings_series_date_unique on public.bookings (series_id, date)
  where series_id is not null and booking_status <> 'cancelled';

-- The weekly slot is held as blocked time, so the availability search and every clash check already honour it.
alter table public.calendar_blocks add column series_id uuid references public.booking_series(id) on delete cascade;
alter table public.calendar_blocks drop constraint calendar_blocks_kind_valid;
alter table public.calendar_blocks add constraint calendar_blocks_kind_valid check (kind in ('blocked', 'personal_event', 'series_hold'));
create unique index calendar_blocks_series_date_unique on public.calendar_blocks (series_id, date) where series_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Keeping the held slots in step with the rule
-- ---------------------------------------------------------------------------------------------
create function public.refresh_series_holds(p_series_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.booking_series%rowtype;
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_name text;
begin
  select * into s from public.booking_series where id = p_series_id;
  if not found then return; end if;
  -- Holds that no longer apply: the repeat is not active, the day has passed, the date was skipped or has its own booking.
  delete from public.calendar_blocks cb
  where cb.series_id = p_series_id
    and (s.status <> 'active' or cb.date < v_today or (s.end_date is not null and cb.date > s.end_date)
         or exists (select 1 from public.booking_series_skips k where k.series_id = p_series_id and k.date = cb.date)
         or exists (select 1 from public.bookings b where b.series_id = p_series_id and b.date = cb.date and b.booking_status <> 'cancelled'));
  if s.status <> 'active' then return; end if;
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = s.client_id;
  insert into public.calendar_blocks (series_id, date, start_minutes, end_minutes, kind, title, created_by)
  select p_series_id, d::date, s.start_minutes, least(s.start_minutes + s.treatment_duration_minutes, 1440), 'series_hold',
         'Held for ' || coalesce(nullif(v_name, ''), 'a client') || ' (repeat)', s.created_by
  from generate_series(greatest(s.first_date, v_today)::timestamp, (v_today + 365)::timestamp, interval '1 day') as d
  where extract(isodow from d)::integer = s.weekday
    and (s.end_date is null or d::date <= s.end_date)
    and not exists (select 1 from public.booking_series_skips k where k.series_id = p_series_id and k.date = d::date)
    and not exists (select 1 from public.bookings b where b.series_id = p_series_id and b.date = d::date and b.booking_status <> 'cancelled')
  on conflict (series_id, date) where series_id is not null do nothing;
end;
$$;

-- Make the real booking for one session of a repeat, through the same command the Admin uses for a new booking,
-- so the same availability, price and snapshot rules apply. The held slot is released first and the booking takes it.
create function public.series_create_occurrence(p_series_id uuid, p_date date, p_notify boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.booking_series%rowtype;
  v_claims text := current_setting('request.jwt.claims', true);
  v_booking uuid;
  v_request jsonb;
begin
  select * into s from public.booking_series where id = p_series_id for update;
  if not found or s.status <> 'active' then return null; end if;
  if exists (select 1 from public.booking_series_skips k where k.series_id = s.id and k.date = p_date)
     or exists (select 1 from public.bookings b where b.series_id = s.id and b.date = p_date and b.booking_status <> 'cancelled') then
    return null;
  end if;
  delete from public.calendar_blocks where series_id = s.id and date = p_date;
  v_request := s.request || jsonb_build_object('date', p_date, 'start_minutes', s.start_minutes);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', s.created_by, 'role', 'authenticated')::text, true);
  perform set_config('app.series_suppress', case when p_notify then 'on' else '' end, true);
  select c.booking_id into v_booking from public.admin_create_booking(v_request, md5(s.id::text || ':' || p_date::text)::uuid) c;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('app.series_suppress', '', true);
  update public.bookings set series_id = s.id where id = v_booking;
  if p_notify then
    insert into public.event_outbox (event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('booking.series_due', 'booking', v_booking, 'booking.series_due:' || v_booking::text,
            jsonb_build_object('booking_id', v_booking, 'series_id', s.id, 'date', p_date));
  end if;
  return v_booking;
end;
$$;

-- The daily job: keep the holds topped up and make the bookings that are now due. Safe to run as often as wanted.
create function public.run_series_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.booking_series%rowtype;
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_window integer := public.business_setting_int('series_payment_reminder_days', 7);
  v_date date;
  v_made integer := 0;
  v_clashes integer := 0;
  v_ended integer := 0;
  v_message text;
begin
  for s in select * from public.booking_series where status = 'active' order by created_at loop
    if s.end_date is not null and s.end_date < v_today then
      update public.booking_series set status = 'ended', ended_at = clock_timestamp() where id = s.id;
      perform public.refresh_series_holds(s.id);
      v_ended := v_ended + 1;
      continue;
    end if;
    perform public.refresh_series_holds(s.id);
    for v_date in
      select d::date from generate_series(greatest(s.first_date, v_today)::timestamp, (v_today + v_window)::timestamp, interval '1 day') as d
      where extract(isodow from d)::integer = s.weekday
        and (s.end_date is null or d::date <= s.end_date)
        and ((d::date + make_interval(mins => s.start_minutes)) at time zone 'Europe/London') > clock_timestamp()
        and not exists (select 1 from public.booking_series_skips k where k.series_id = s.id and k.date = d::date)
        and not exists (select 1 from public.bookings b where b.series_id = s.id and b.date = d::date and b.booking_status <> 'cancelled')
      order by d
    loop
      begin
        if public.series_create_occurrence(s.id, v_date, true) is not null then v_made := v_made + 1; end if;
      exception when others then
        get stacked diagnostics v_message = message_text;
        insert into public.booking_series_skips (series_id, date, reason, note) values (s.id, v_date, 'clash', left(v_message, 300))
          on conflict (series_id, date) do nothing;
        delete from public.calendar_blocks where series_id = s.id and date = v_date;
        insert into public.event_outbox (event_type, aggregate_type, aggregate_id, deduplication_key, payload)
        values ('series.clash', 'series', s.id, 'series.clash:' || s.id::text || ':' || v_date::text,
                jsonb_build_object('client_id', s.client_id, 'date', v_date));
        v_clashes := v_clashes + 1;
      end;
    end loop;
  end loop;
  return jsonb_build_object('made', v_made, 'clashes', v_clashes, 'ended', v_ended);
end;
$$;

-- A cancelled or moved session releases its date; it is never made again.
create function public.series_booking_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.series_id is null then return null; end if;
  if new.booking_status = 'cancelled' and old.booking_status <> 'cancelled' then
    insert into public.booking_series_skips (series_id, date, reason) values (new.series_id, old.date, 'cancelled') on conflict (series_id, date) do nothing;
  elsif new.date is distinct from old.date then
    insert into public.booking_series_skips (series_id, date, reason) values (new.series_id, old.date, 'moved') on conflict (series_id, date) do nothing;
  end if;
  return null;
end;
$$;
create trigger bookings_series_changed after update of booking_status, date on public.bookings
  for each row when (old.series_id is not null) execute function public.series_booking_changed();

-- ---------------------------------------------------------------------------------------------
-- Admin commands
-- ---------------------------------------------------------------------------------------------
-- Make the first booking exactly as a new booking is made, then start the repeat from it.
create function public.admin_create_series(p_request jsonb, p_end_date date, p_request_id uuid)
returns table(series_id uuid, booking_id uuid, booking_reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first record;
  v_booking public.bookings%rowtype;
  v_series uuid;
  v_template jsonb;
  v_arrangement text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'Booking details are required' using errcode = '22023';
  end if;
  select c.* into v_first from public.admin_create_booking(p_request, p_request_id) c;
  select * into v_booking from public.bookings b where b.id = v_first.booking_id;
  if v_booking.series_id is not null then
    -- The same request was sent again: answer with the repeat it already made.
    return query select v_booking.series_id, v_booking.id, v_booking.booking_reference;
    return;
  end if;
  if p_end_date is not null and p_end_date < v_booking.date then
    raise exception 'The repeat cannot end before it starts' using errcode = '22023';
  end if;
  if p_end_date is not null and p_end_date > v_booking.date + 1100 then
    raise exception 'A repeat can run for up to three years' using errcode = '22023';
  end if;
  v_arrangement := case when p_request->>'payment_arrangement' in ('bank_pending', 'bank_received') then 'bank_pending' else 'cash_appointment' end;
  v_template := (p_request - 'date' - 'start_minutes') || jsonb_build_object('payment_arrangement', v_arrangement);
  insert into public.booking_series (client_id, weekday, first_date, end_date, start_minutes, treatment_duration_minutes, request, created_by)
  values (v_booking.client_id, extract(isodow from v_booking.date)::integer, v_booking.date, p_end_date, v_booking.start_minutes,
          v_booking.treatment_duration_minutes, v_template, auth.uid())
  returning id into v_series;
  update public.bookings set series_id = v_series where id = v_booking.id;
  perform public.refresh_series_holds(v_series);
  return query select v_series, v_booking.id, v_booking.booking_reference;
end;
$$;

create function public.admin_client_series(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'status', s.status, 'weekday', s.weekday, 'first_date', s.first_date, 'end_date', s.end_date,
      'start_minutes', s.start_minutes, 'treatment_duration_minutes', s.treatment_duration_minutes,
      'payment_arrangement', s.request->>'payment_arrangement',
      'next_booking', (select jsonb_build_object('id', b.id, 'date', b.date, 'booking_status', b.booking_status)
                       from public.bookings b where b.series_id = s.id and b.booking_status <> 'cancelled' and b.date >= v_today order by b.date limit 1),
      'next_held_date', (select min(cb.date) from public.calendar_blocks cb where cb.series_id = s.id and cb.date >= v_today),
      'skipped', coalesce((select jsonb_agg(jsonb_build_object('date', k.date, 'reason', k.reason, 'note', k.note) order by k.date)
                           from public.booking_series_skips k where k.series_id = s.id and k.date >= v_today), '[]'::jsonb)
    ) order by s.created_at desc)
    from public.booking_series s where s.client_id = p_client_id), '[]'::jsonb);
end;
$$;

create function public.admin_set_series_status(p_series_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.booking_series%rowtype;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'paused', 'ended') then
    raise exception 'Choose active, paused or ended' using errcode = '22023';
  end if;
  select * into s from public.booking_series where id = p_series_id for update;
  if not found then raise exception 'Repeat unavailable' using errcode = 'P0002'; end if;
  if s.status = 'ended' then raise exception 'This repeat has ended' using errcode = 'PT409'; end if;
  update public.booking_series set status = p_status, ended_at = case when p_status = 'ended' then clock_timestamp() end where id = s.id;
  perform public.refresh_series_holds(s.id);
end;
$$;

-- Skip one date. A session that already has a booking is cancelled the usual way instead.
create function public.admin_skip_series_date(p_series_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_date is null or not exists (select 1 from public.booking_series where id = p_series_id) then
    raise exception 'Repeat unavailable' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.bookings b where b.series_id = p_series_id and b.date = p_date and b.booking_status <> 'cancelled') then
    raise exception 'That session is already booked. Cancel the booking instead.' using errcode = 'PT409';
  end if;
  insert into public.booking_series_skips (series_id, date, reason) values (p_series_id, p_date, 'skipped')
    on conflict (series_id, date) do update set reason = 'skipped', note = null;
  perform public.refresh_series_holds(p_series_id);
end;
$$;

create function public.admin_unskip_series_date(p_series_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  delete from public.booking_series_skips where series_id = p_series_id and date = p_date and reason in ('skipped', 'clash');
  if not found then raise exception 'That date cannot be put back' using errcode = 'PT409'; end if;
  perform public.refresh_series_holds(p_series_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------------------------
-- A booking made by the repeat is not announced as a new booking; the repeat sends its own message.
create function public.suppress_series_booking_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.series_suppress', true) = 'on'
     and exists (select 1 from public.event_outbox e where e.id = new.event_id and e.event_type = 'booking.created') then
    return null;
  end if;
  return new;
end;
$$;
create trigger notification_deliveries_suppress_series before insert on public.notification_deliveries
  for each row execute function public.suppress_series_booking_created();

create function public.plan_series_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_name text;
  v_email text;
  v_when text;
  v_where text;
  v_admin_title text;
  v_admin_body text;
  v_admin_link text;
  v_client_title text;
  v_client_body text;
  v_free integer := public.business_setting_int('free_cancellation_hours', 24);
  v_date date;
  v_client uuid;
begin
  if new.event_type = 'booking.series_due' and new.aggregate_type = 'booking' then
    select * into b from public.bookings where id = new.aggregate_id;
    if not found then return null; end if;
    select * into p from public.booking_payments where booking_id = b.id;
    select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
    v_name := coalesce(nullif(v_name, ''), 'A client');
    v_email := nullif(btrim(b.booking_email_snapshot), '');
    v_when := public.notification_when(b.date, b.start_minutes);
    v_where := concat_ws(', ', b.address_line_1_snapshot, b.city_snapshot, b.postcode_snapshot);
    v_admin_link := '/admin/bookings/' || b.id::text;
    v_admin_title := format('Next repeat booking for %s', v_name);
    v_admin_body := format('%s, %s minutes, %s.', v_when, b.treatment_duration_minutes, public.notification_money(b.total_gbp)) ||
      case when p.method = 'bank_transfer' then ' Waiting for the bank transfer.' else ' To be paid in cash at the appointment.' end;
    v_client_title := case when p.method = 'bank_transfer' then 'Time to pay for your next appointment' else 'Your next regular appointment' end;
    v_client_body := format('Your next regular appointment is booked for %s (%s minutes) at %s.', v_when, b.treatment_duration_minutes, v_where) ||
      case when p.method = 'bank_transfer'
        then format(E'\n\nThe cost is %s. Please pay by bank transfer before the day; the bank details are on your booking page.', public.notification_money(b.total_gbp))
        else format(E'\n\nThe cost is %s, to be paid in cash at the appointment.', public.notification_money(b.total_gbp)) end ||
      format(E'\n\nIf that day does not suit, you can cancel or move it from the same page. It is free more than %s hours before the appointment.', v_free) ||
      E'\nReference: ' || b.booking_reference;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (new.id, 'in_app', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'telegram', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link),
           (new.id, 'email', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link);
    if v_email is not null then
      insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
      values (new.id, 'email', 'client', v_email, v_client_title,
              v_client_body || E'\n\nSee or change your booking: {link}' || E'\n\nWarm wishes,\nVad', '/account?booking=' || b.id::text);
    end if;
  elsif new.event_type = 'series.clash' and new.aggregate_type = 'series' then
    v_date := (new.payload->>'date')::date;
    v_client := (new.payload->>'client_id')::uuid;
    select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = v_client;
    v_admin_title := 'A repeat booking could not be made';
    v_admin_body := format('%s: %s could not be booked because the time is no longer free. That date has been skipped. Open the client to decide what to do.',
      coalesce(nullif(v_name, ''), 'A client'), to_char(v_date, 'FMDy FMDD FMMon'));
    v_admin_link := '/admin/clients/' || v_client::text;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (new.id, 'in_app', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'telegram', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link),
           (new.id, 'email', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link);
  end if;
  return null;
end;
$$;
create trigger event_outbox_plan_series_notifications after insert on public.event_outbox
  for each row execute function public.plan_series_notifications();

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------
revoke all on function public.refresh_series_holds(uuid) from public, anon, authenticated;
revoke all on function public.series_create_occurrence(uuid, date, boolean) from public, anon, authenticated;
revoke all on function public.run_series_maintenance() from public, anon, authenticated;
revoke all on function public.series_booking_changed() from public, anon, authenticated;
revoke all on function public.suppress_series_booking_created() from public, anon, authenticated;
revoke all on function public.plan_series_notifications() from public, anon, authenticated;
revoke all on function public.admin_create_series(jsonb, date, uuid) from public, anon;
revoke all on function public.admin_client_series(uuid) from public, anon;
revoke all on function public.admin_set_series_status(uuid, text) from public, anon;
revoke all on function public.admin_skip_series_date(uuid, date) from public, anon;
revoke all on function public.admin_unskip_series_date(uuid, date) from public, anon;
grant execute on function public.run_series_maintenance() to service_role;
grant execute on function public.admin_create_series(jsonb, date, uuid) to authenticated;
grant execute on function public.admin_client_series(uuid) to authenticated;
grant execute on function public.admin_set_series_status(uuid, text) to authenticated;
grant execute on function public.admin_skip_series_date(uuid, date) to authenticated;
grant execute on function public.admin_unskip_series_date(uuid, date) to authenticated;
