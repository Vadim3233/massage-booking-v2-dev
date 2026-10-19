-- VAD Massage Booking V2
-- Repeating bookings: more ways to repeat, and cancelling what is coming (ADR-030 grows).
--
-- A repeat was always "every <weekday>". Now it can also be
--   * every 2, 3 or 4 weeks (any gap from 1 to 12 weeks), counted from the first booking;
--   * monthly on the same weekday: the first, second, third or fourth Thursday of each month, or the last one, taken from the date of the
--     first booking;
--   * on dates chosen one by one (all at the same time, length and address as the first booking).
-- Everything else about a repeat is as it was: one standing rule that keeps the slots free, a real booking made for each session a few
-- days ahead, nothing cancelled automatically. A repeat already made keeps working exactly as before (every week).
--
-- Cancelling what is coming, from the client's repeat:
--   * some dates (a date with a booking cancels that booking, a date still only held is skipped), or
--   * all that is upcoming, which also ends the repeat.
-- The cancelling is done as the Admin, so no late fee is charged and a booking that was paid becomes a refund to send, as for any
-- cancellation the Admin makes. The client is emailed about each booking that is cancelled, as for any cancellation the Admin makes.

-- ---------------------------------------------------------------------------------------------
-- 1. The pattern of a repeat
-- ---------------------------------------------------------------------------------------------
alter table public.booking_series
  add column pattern text not null default 'weeks',
  add column every_weeks smallint not null default 1,
  add column month_week smallint,
  add column custom_dates date[];
alter table public.booking_series
  add constraint booking_series_pattern_valid check (
    (pattern = 'weeks' and every_weeks between 1 and 12 and month_week is null and custom_dates is null)
    or (pattern = 'monthly' and every_weeks = 1 and month_week is not null and month_week between 1 and 5 and custom_dates is null)
    or (pattern = 'dates' and every_weeks = 1 and month_week is null and custom_dates is not null and cardinality(custom_dates) between 1 and 60));

-- The dates of a repeat between two days, whatever its pattern (inside only). The one place that knows what each pattern means.
create function public.series_dates(s public.booking_series, p_from date, p_to date)
returns setof date
language sql
stable
set search_path = ''
as $$
  select d::date
  from generate_series(greatest(s.first_date, p_from)::timestamp, p_to::timestamp, interval '1 day') as d
  where (s.end_date is null or d::date <= s.end_date)
    and case s.pattern
      when 'weeks' then (d::date - s.first_date) % (7 * s.every_weeks) = 0
      when 'monthly' then extract(isodow from d)::integer = s.weekday
        and case when s.month_week = 5 then extract(month from d::date + 7) <> extract(month from d::date)
                 else (extract(day from d)::integer - 1) / 7 + 1 = s.month_week end
      else d::date = any(s.custom_dates)
    end;
$$;
revoke all on function public.series_dates(public.booking_series, date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Holding the slots, and making each booking when it is due, for any pattern
-- ---------------------------------------------------------------------------------------------
create or replace function public.refresh_series_holds(p_series_id uuid)
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
  select p_series_id, d, s.start_minutes, least(s.start_minutes + s.treatment_duration_minutes, 1440), 'series_hold',
         'Held for ' || coalesce(nullif(v_name, ''), 'a client') || ' (repeat)', s.created_by
  from public.series_dates(s, greatest(s.first_date, v_today), v_today + 365) as sd(d)
  where not exists (select 1 from public.booking_series_skips k where k.series_id = p_series_id and k.date = sd.d)
    and not exists (select 1 from public.bookings b where b.series_id = p_series_id and b.date = sd.d and b.booking_status <> 'cancelled')
  on conflict (series_id, date) where series_id is not null do nothing;
end;
$$;

create or replace function public.run_series_maintenance()
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
      select sd.d from public.series_dates(s, greatest(s.first_date, v_today), v_today + v_window) as sd(d)
      where ((sd.d + make_interval(mins => s.start_minutes)) at time zone 'Europe/London') > clock_timestamp()
        and not exists (select 1 from public.booking_series_skips k where k.series_id = s.id and k.date = sd.d)
        and not exists (select 1 from public.bookings b where b.series_id = s.id and b.date = sd.d and b.booking_status <> 'cancelled')
      order by sd.d
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

-- ---------------------------------------------------------------------------------------------
-- 3. Making a repeat: the same command, with a pattern
-- ---------------------------------------------------------------------------------------------
-- p_pattern is empty (every week, as before) or one of
--   {"kind": "weeks", "every_weeks": 2}        every 1 to 12 weeks from the first booking
--   {"kind": "monthly"}                        the same weekday of each month, from the first booking's date
--   {"kind": "dates", "dates": ["2026-11-03"]} exactly these dates after the first booking (no end date)
drop function public.admin_create_series(jsonb, date, uuid);
create function public.admin_create_series(p_request jsonb, p_end_date date, p_request_id uuid, p_pattern jsonb default null)
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
  v_kind text := 'weeks';
  v_every integer := 1;
  v_month_week integer;
  v_dates date[];
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'Booking details are required' using errcode = '22023';
  end if;
  -- The weekly bookings that follow are made at the usual times only, so a repeat cannot start from an unusual one.
  if p_request ? 'any_time' then
    raise exception 'A repeat uses the usual times only' using errcode = '22023';
  end if;
  if p_request ? 'past' then
    raise exception 'A repeat cannot start with an appointment that has already happened' using errcode = '22023';
  end if;
  -- The pattern is checked before anything is made, so a pattern that is wrong makes nothing.
  if p_pattern is not null then
    if jsonb_typeof(p_pattern) <> 'object' or exists (select 1 from jsonb_object_keys(p_pattern) k where k not in ('kind', 'every_weeks', 'dates')) then
      raise exception 'Choose how often it repeats' using errcode = '22023';
    end if;
    v_kind := coalesce(p_pattern->>'kind', 'weeks');
    if v_kind not in ('weeks', 'monthly', 'dates') then raise exception 'Choose how often it repeats' using errcode = '22023'; end if;
    if v_kind = 'weeks' and p_pattern ? 'every_weeks' then
      if (p_pattern->>'every_weeks') !~ '^[0-9]{1,2}$' or (p_pattern->>'every_weeks')::integer not between 1 and 12 then
        raise exception 'Choose between 1 and 12 weeks' using errcode = '22023';
      end if;
      v_every := (p_pattern->>'every_weeks')::integer;
    end if;
    if v_kind = 'dates' then
      if jsonb_typeof(p_pattern->'dates') is distinct from 'array' then raise exception 'Choose between 1 and 59 dates' using errcode = '22023'; end if;
      if jsonb_array_length(p_pattern->'dates') not between 1 and 59 then raise exception 'Choose between 1 and 59 dates' using errcode = '22023'; end if;
      if exists (select 1 from jsonb_array_elements_text(p_pattern->'dates') x where x !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        raise exception 'Choose real dates' using errcode = '22023';
      end if;
      begin
        select array_agg(distinct x::date order by x::date) into v_dates from jsonb_array_elements_text(p_pattern->'dates') x;
      exception when others then
        raise exception 'Choose real dates' using errcode = '22023';
      end;
      if p_end_date is not null then raise exception 'Dates chosen one by one have no end date' using errcode = '22023'; end if;
    elsif p_pattern ? 'dates' then
      raise exception 'Choose how often it repeats' using errcode = '22023';
    end if;
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
  if v_kind = 'monthly' then
    -- The first, second, third or fourth such weekday of the month, or the last one when the first booking is on a fifth.
    v_month_week := least((extract(day from v_booking.date)::integer - 1) / 7 + 1, 5);
  elsif v_kind = 'dates' then
    if exists (select 1 from unnest(v_dates) d where d <= v_booking.date or d > v_booking.date + 1100) then
      raise exception 'Choose dates after the first booking, within three years' using errcode = '22023';
    end if;
    v_dates := array_prepend(v_booking.date, v_dates);
  end if;
  v_arrangement := case when p_request->>'payment_arrangement' in ('bank_pending', 'bank_received') then 'bank_pending' else 'cash_appointment' end;
  v_template := (p_request - 'date' - 'start_minutes') || jsonb_build_object('payment_arrangement', v_arrangement);
  insert into public.booking_series (client_id, weekday, first_date, end_date, start_minutes, treatment_duration_minutes, request, created_by,
                                     pattern, every_weeks, month_week, custom_dates)
  values (v_booking.client_id, extract(isodow from v_booking.date)::integer, v_booking.date,
          case when v_kind = 'dates' then v_dates[cardinality(v_dates)] else p_end_date end, v_booking.start_minutes,
          v_booking.treatment_duration_minutes, v_template, auth.uid(), v_kind, v_every, v_month_week, v_dates)
  returning id into v_series;
  update public.bookings set series_id = v_series where id = v_booking.id;
  perform public.refresh_series_holds(v_series);
  return query select v_series, v_booking.id, v_booking.booking_reference;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. What the Admin sees: the pattern, and the dates that are coming
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_client_series(p_client_id uuid)
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
      'pattern', s.pattern, 'every_weeks', s.every_weeks, 'month_week', s.month_week,
      'start_minutes', s.start_minutes, 'treatment_duration_minutes', s.treatment_duration_minutes,
      'payment_arrangement', s.request->>'payment_arrangement',
      'next_booking', (select jsonb_build_object('id', b.id, 'date', b.date, 'booking_status', b.booking_status)
                       from public.bookings b where b.series_id = s.id and b.booking_status <> 'cancelled' and b.date >= v_today order by b.date limit 1),
      'next_held_date', (select min(cb.date) from public.calendar_blocks cb where cb.series_id = s.id and cb.date >= v_today),
      -- The next twelve dates the repeat has: booked (with its booking), skipped (with why), paused, or still only held for the client.
      -- A repeat that has ended has no dates of its own left to come: only the bookings it already made.
      'upcoming', coalesce((
        select jsonb_agg(jsonb_build_object('date', x.d,
                 'state', case when b.id is not null then 'booked' when k.date is not null then 'skipped' when s.status = 'paused' then 'paused' else 'held' end,
                 'booking_id', b.id, 'booking_status', b.booking_status, 'reason', k.reason) order by x.d)
        from (select sd.d from public.series_dates(s, v_today, v_today + 365) as sd(d) order by sd.d limit 12) x
        left join public.bookings b on b.series_id = s.id and b.date = x.d and b.booking_status <> 'cancelled'
        left join public.booking_series_skips k on k.series_id = s.id and k.date = x.d
        where s.status <> 'ended' or b.id is not null), '[]'::jsonb),
      -- How many bookings a "cancel all upcoming" would cancel.
      'upcoming_booked', (select count(*) from public.bookings b
                          where b.series_id = s.id and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
                            and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp()),
      'skipped', coalesce((select jsonb_agg(jsonb_build_object('date', k.date, 'reason', k.reason, 'note', k.note) order by k.date)
                           from public.booking_series_skips k where k.series_id = s.id and k.date >= v_today), '[]'::jsonb)
    ) order by s.created_at desc)
    from public.booking_series s where s.client_id = p_client_id), '[]'::jsonb);
end;
$$;

-- Skip one date. It has to be one of the repeat's dates: a date that is not would change nothing, and the Admin is told so instead.
create or replace function public.admin_skip_series_date(p_series_id uuid, p_date date)
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
  select * into s from public.booking_series where id = p_series_id;
  if p_date is null or not found then
    raise exception 'Repeat unavailable' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.bookings b where b.series_id = p_series_id and b.date = p_date and b.booking_status <> 'cancelled') then
    raise exception 'That session is already booked. Cancel the booking instead.' using errcode = 'PT409';
  end if;
  if not exists (select 1 from public.series_dates(s, p_date, p_date) as sd(d)) then
    raise exception 'That date is not one of this repeat''s dates' using errcode = '22023';
  end if;
  insert into public.booking_series_skips (series_id, date, reason) values (p_series_id, p_date, 'skipped')
    on conflict (series_id, date) do update set reason = 'skipped', note = null;
  perform public.refresh_series_holds(p_series_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Cancelling what is coming (inside only: the two commands below are the way in)
-- ---------------------------------------------------------------------------------------------
-- Cancels the bookings of a repeat on the given dates (every upcoming date when none are given), on the Admin's own account: no late fee, a paid
-- booking becomes a refund to send, each cancellation recorded like any other (so the client is told). A date with no booking is skipped instead.
create function public.series_cancel_dates(p_series_id uuid, p_dates date[], p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_cancelled integer := 0;
  v_skipped integer := 0;
  v_date date;
  s public.booking_series%rowtype;
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_command uuid;
  v_fingerprint text;
begin
  select * into s from public.booking_series where id = p_series_id;
  for v_date in
    select d from (
      select unnest(p_dates) as d
      union
      select bk.date from public.bookings bk where p_dates is null and bk.series_id = p_series_id and bk.date >= v_today
    ) x where d is not null order by d
  loop
    if v_date < v_today then raise exception 'Only dates still to come can be cancelled' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
    select * into b from public.bookings bk where bk.series_id = p_series_id and bk.date = v_date and bk.booking_status <> 'cancelled' for update;
    if found then
      if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
        -- Completed or missed: it has happened, and is left as it is.
        continue;
      end if;
      if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= v_now then continue; end if;
      select * into p from public.booking_payments pp where pp.booking_id = b.id for update;
      v_fingerprint := md5(concat_ws('|', 'series_cancel', p_series_id::text, v_date::text));
      v_command := public.admin_finish_command('admin_cancel_booking', md5(p_request_id::text || ':' || b.id::text)::uuid, v_fingerprint, b.id);
      perform public.apply_booking_cancellation(b, p, 'Cancelled with the repeat', 'admin', null, 'admin', auth.uid()::text, v_now);
      perform public.admin_lifecycle_event('booking.cancelled', v_command, b.id, jsonb_build_object('initiated_by', 'admin', 'standard_fee_gbp', 0));
      v_cancelled := v_cancelled + 1;
    elsif p_dates is not null then
      if not exists (select 1 from public.series_dates(s, v_date, v_date) as sd(d)) then
        raise exception 'That date is not one of this repeat''s dates' using errcode = '22023';
      end if;
      insert into public.booking_series_skips (series_id, date, reason) values (p_series_id, v_date, 'skipped')
        on conflict (series_id, date) do update set reason = case when public.booking_series_skips.reason = 'clash' then 'skipped' else public.booking_series_skips.reason end;
      v_skipped := v_skipped + 1;
    end if;
  end loop;
  return jsonb_build_object('cancelled', v_cancelled, 'skipped', v_skipped);
end;
$$;
revoke all on function public.series_cancel_dates(uuid, date[], uuid) from public, anon, authenticated;

-- Some dates of a repeat: a booked one is cancelled, a held one is skipped. The repeat carries on.
create function public.admin_series_cancel_dates(p_series_id uuid, p_dates date[], p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text := 'admin-series:' || coalesce(auth.uid()::text, '');
  v_fingerprint text;
  v_command public.command_requests%rowtype;
  s public.booking_series%rowtype;
  v_result jsonb;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_series_id is null or p_request_id is null or p_dates is null or cardinality(p_dates) not between 1 and 60 then
    raise exception 'Choose between 1 and 60 dates' using errcode = '22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_series_cancel_dates', p_series_id::text, (select string_agg(d::text, ',' order by d) from unnest(p_dates) d)));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_command from public.command_requests c where c.scope = v_scope and c.idempotency_key = p_request_id::text for update;
  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode = '22023'; end if;
    if v_command.status = 'succeeded' then return jsonb_build_object('repeated', true); end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;
  select * into s from public.booking_series where id = p_series_id for update;
  if not found then raise exception 'Repeat unavailable' using errcode = 'P0002'; end if;
  if s.status = 'ended' then raise exception 'This repeat has ended' using errcode = 'PT409'; end if;
  v_result := public.series_cancel_dates(s.id, p_dates, p_request_id);
  perform public.refresh_series_holds(s.id);
  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type, request_fingerprint, status, result_reference, completed_at)
  values (v_scope, p_request_id::text, 'admin', 'admin', auth.uid()::text, 'admin_series_cancel_dates', v_fingerprint, 'succeeded', s.id::text, clock_timestamp());
  return v_result;
end;
$$;

-- All that is upcoming: every booking of the repeat still to come is cancelled, and the repeat ends (its held slots are released).
create function public.admin_series_cancel_all_upcoming(p_series_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text := 'admin-series:' || coalesce(auth.uid()::text, '');
  v_fingerprint text;
  v_command public.command_requests%rowtype;
  s public.booking_series%rowtype;
  v_result jsonb;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_series_id is null or p_request_id is null then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_series_cancel_all_upcoming', p_series_id::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_command from public.command_requests c where c.scope = v_scope and c.idempotency_key = p_request_id::text for update;
  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode = '22023'; end if;
    if v_command.status = 'succeeded' then return jsonb_build_object('repeated', true); end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;
  select * into s from public.booking_series where id = p_series_id for update;
  if not found then raise exception 'Repeat unavailable' using errcode = 'P0002'; end if;
  if s.status = 'ended' then raise exception 'This repeat has ended' using errcode = 'PT409'; end if;
  v_result := public.series_cancel_dates(s.id, null, p_request_id);
  update public.booking_series set status = 'ended', ended_at = clock_timestamp() where id = s.id;
  perform public.refresh_series_holds(s.id);
  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type, request_fingerprint, status, result_reference, completed_at)
  values (v_scope, p_request_id::text, 'admin', 'admin', auth.uid()::text, 'admin_series_cancel_all_upcoming', v_fingerprint, 'succeeded', s.id::text, clock_timestamp());
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------
revoke all on function public.admin_create_series(jsonb, date, uuid, jsonb) from public, anon;
revoke all on function public.admin_series_cancel_dates(uuid, date[], uuid) from public, anon;
revoke all on function public.admin_series_cancel_all_upcoming(uuid, uuid) from public, anon;
grant execute on function public.admin_create_series(jsonb, date, uuid, jsonb) to authenticated;
grant execute on function public.admin_series_cancel_dates(uuid, date[], uuid) to authenticated;
grant execute on function public.admin_series_cancel_all_upcoming(uuid, uuid) to authenticated;
