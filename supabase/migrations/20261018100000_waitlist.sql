-- VAD Massage Booking V2
-- Waitlist: a client leaves their details when the day they want is full; the Admin sees who is waiting,
-- which waiting people could be booked right now, and is alerted when someone joins or a day opens up.
--
-- The waitlist never books anything by itself. The Admin contacts the person and books them as usual.

create table public.waitlist_requests (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  contact_name text not null,
  contact_phone text,
  contact_email text,
  requested_date date not null,
  preferred_from_minutes integer not null default 0,
  preferred_to_minutes integer not null default 1440,
  duration_minutes integer not null,
  note text,
  status text not null default 'active',
  admin_note text,
  offered_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  constraint waitlist_status_valid check (status in ('active', 'offered', 'closed')),
  constraint waitlist_duration_valid check (duration_minutes between 60 and 240 and duration_minutes % 30 = 0),
  constraint waitlist_window_valid check (preferred_from_minutes >= 0 and preferred_to_minutes <= 1440 and preferred_from_minutes < preferred_to_minutes),
  constraint waitlist_contact_present check (contact_phone is not null or contact_email is not null),
  constraint waitlist_name_valid check (length(btrim(contact_name)) between 1 and 120),
  constraint waitlist_note_valid check (note is null or length(note) <= 500),
  constraint waitlist_admin_note_valid check (admin_note is null or length(admin_note) <= 500),
  constraint waitlist_closed_consistent check ((status = 'closed') = (closed_at is not null)),
  constraint waitlist_close_reason_valid check (close_reason is null or close_reason in ('booked', 'not_needed', 'closed'))
);
create index waitlist_open_idx on public.waitlist_requests (requested_date, created_at) where status <> 'closed';
create trigger waitlist_requests_set_updated_at before update on public.waitlist_requests
  for each row execute function public.set_updated_at();
alter table public.waitlist_requests enable row level security;
create policy "admins can manage the waitlist" on public.waitlist_requests
  for all to authenticated using (public.is_booking_admin()) with check (public.is_booking_admin());
revoke all on table public.waitlist_requests from public;
revoke all on table public.waitlist_requests from anon;
revoke all on table public.waitlist_requests from authenticated;
grant select on table public.waitlist_requests to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Anyone asks to be told if a time opens up, signed in or not: they are choosing a date before they have to
-- sign in. Limits are by contact detail and overall, so the list cannot be flooded by one person or in total.
-- ---------------------------------------------------------------------------------------------
create function public.join_waitlist(
  p_date date, p_from_minutes integer, p_to_minutes integer, p_duration_minutes integer,
  p_name text, p_phone text, p_email text, p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_name text := nullif(btrim(p_name), '');
  v_phone text := nullif(btrim(p_phone), '');
  v_phone_digits text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_email text := lower(nullif(btrim(p_email), ''));
  v_note text := nullif(btrim(p_note), '');
  v_id uuid;
  v_client uuid;
begin
  if p_date is null or p_date < v_today or p_date > v_today + public.business_setting_int('booking_horizon_days', 40) then
    raise exception 'Please choose a day within the dates you can book.' using errcode = '22023';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 60 and 240 or p_duration_minutes % 30 <> 0 then
    raise exception 'Please choose a treatment length.' using errcode = '22023';
  end if;
  if p_from_minutes is null or p_to_minutes is null or p_from_minutes < 0 or p_to_minutes > 1440 or p_from_minutes >= p_to_minutes then
    raise exception 'Please choose a time of day.' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 120 then raise exception 'Please enter your name.' using errcode = '22023'; end if;
  if v_phone_digits is null and v_email is null then raise exception 'Please enter a phone number or an email address.' using errcode = '22023'; end if;
  if v_phone_digits is not null and length(v_phone_digits) not between 7 and 20 then raise exception 'That phone number does not look right.' using errcode = '22023'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then raise exception 'That email address does not look right.' using errcode = '22023'; end if;
  if length(coalesce(v_note, '')) > 500 then raise exception 'Please keep your note under 500 characters.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('waitlist-contact:' || coalesce(v_email, '') || '|' || coalesce(v_phone_digits, '')));
  -- Asking twice for the same day and length is the same request.
  select id into v_id from public.waitlist_requests
    where requested_date = p_date and duration_minutes = p_duration_minutes and status <> 'closed' and ((v_email is not null and lower(contact_email) = v_email) or (v_phone_digits is not null and regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g') = v_phone_digits)) limit 1;
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.waitlist_requests where status <> 'closed' and ((v_email is not null and lower(contact_email) = v_email) or (v_phone_digits is not null and regexp_replace(coalesce(contact_phone, ''), '[^0-9]', '', 'g') = v_phone_digits))) >= 3 then
    raise exception 'You are already on the waitlist for a few days. Please contact Vad if you need something else.' using errcode = '22023';
  end if;
  if (select count(*) from public.waitlist_requests where status <> 'closed') >= 300 then
    raise exception 'The waitlist is full at the moment. Please contact Vad.' using errcode = '22023';
  end if;
  select id into v_client from public.clients where auth_user_id = auth.uid() and auth.uid() is not null;
  insert into public.waitlist_requests(created_by, client_id, contact_name, contact_phone, contact_email, requested_date,
    preferred_from_minutes, preferred_to_minutes, duration_minutes, note)
  values (auth.uid(), v_client, v_name, v_phone, v_email, p_date, p_from_minutes, p_to_minutes, p_duration_minutes, v_note)
  returning id into v_id;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('waitlist.joined', 'waitlist', v_id, 'waitlist.joined:' || v_id::text,
    jsonb_build_object('waitlist_id', v_id, 'date', p_date, 'from_minutes', p_from_minutes, 'to_minutes', p_to_minutes, 'duration_minutes', p_duration_minutes));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The Admin's list: who is waiting, and which of them could be booked now.
-- ---------------------------------------------------------------------------------------------
create function public.admin_waitlist(p_include_closed boolean default false)
returns table(
  id uuid, client_id uuid, contact_name text, contact_phone text, contact_email text, requested_date date,
  preferred_from_minutes integer, preferred_to_minutes integer, duration_minutes integer, note text, status text,
  admin_note text, offered_at timestamptz, closed_at timestamptz, close_reason text, created_at timestamptz, available_times integer[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return query
  select w.id, w.client_id, w.contact_name, w.contact_phone, w.contact_email, w.requested_date, w.preferred_from_minutes, w.preferred_to_minutes,
    w.duration_minutes, w.note, w.status, w.admin_note, w.offered_at, w.closed_at, w.close_reason, w.created_at,
    case when w.status = 'closed' or w.requested_date < v_today then '{}'::integer[] else coalesce((
      select array_agg(a.start_minutes order by a.start_minutes)
      from public.compute_booking_availability(w.requested_date, w.duration_minutes, v_now, 60, null, null) a
      where a.start_minutes >= w.preferred_from_minutes and a.start_minutes < w.preferred_to_minutes
        and ((w.requested_date + make_interval(mins => a.start_minutes)) at time zone 'Europe/London') > v_now), '{}'::integer[]) end
  from public.waitlist_requests w
  where (p_include_closed and w.status = 'closed' and w.closed_at > v_now - interval '60 days') or (w.status <> 'closed' and w.requested_date >= v_today)
  order by (w.status = 'closed'), w.requested_date, w.created_at
  limit 200;
end;
$$;

create function public.admin_update_waitlist(p_id uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.waitlist_requests%rowtype;
  v_note text := nullif(btrim(p_note), '');
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('offered', 'reopen', 'booked', 'not_needed', 'closed') then
    raise exception 'Choose what to do with this request' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 500 then raise exception 'Please keep the note under 500 characters' using errcode = '22023'; end if;
  select * into w from public.waitlist_requests where id = p_id for update;
  if not found then raise exception 'Request unavailable' using errcode = 'P0002'; end if;
  if w.status = 'closed' then raise exception 'This request is already closed' using errcode = 'PT409'; end if;
  if p_action = 'offered' then
    update public.waitlist_requests set status = 'offered', offered_at = clock_timestamp(), admin_note = coalesce(v_note, admin_note) where id = p_id;
  elsif p_action = 'reopen' then
    update public.waitlist_requests set status = 'active', offered_at = null, admin_note = coalesce(v_note, admin_note) where id = p_id;
  else
    update public.waitlist_requests set status = 'closed', closed_at = clock_timestamp(), close_reason = p_action, admin_note = coalesce(v_note, admin_note) where id = p_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Alerts for the Admin: someone joined, or a booking was cancelled or removed on a day people are waiting for.
-- They use their own recipient name so they never clash with the booking alerts for the same event.
-- ---------------------------------------------------------------------------------------------
create function public.plan_waitlist_notifications()
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
begin
  if new.event_type = 'waitlist.joined' then
    select w.contact_name, w.requested_date into v_name, v_date from public.waitlist_requests w where w.id = new.aggregate_id;
    if v_name is null then return null; end if;
    v_title := 'Someone joined the waitlist';
    v_body := format('%s: %s, %s, %s minutes.', v_name, to_char(v_date, 'FMDy FMDD FMMon'),
      case when (new.payload->>'from_minutes')::integer = 0 and (new.payload->>'to_minutes')::integer = 1440 then 'any time'
           else lpad(((new.payload->>'from_minutes')::integer / 60)::text, 2, '0') || ':' || lpad(((new.payload->>'from_minutes')::integer % 60)::text, 2, '0')
             || ' to ' || lpad(((new.payload->>'to_minutes')::integer / 60)::text, 2, '0') || ':' || lpad(((new.payload->>'to_minutes')::integer % 60)::text, 2, '0') end,
      new.payload->>'duration_minutes');
  elsif new.event_type in ('booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected') and new.aggregate_type = 'booking' then
    select b.date into v_date from public.bookings b where b.id = new.aggregate_id;
    if v_date is null or v_date < (clock_timestamp() at time zone 'Europe/London')::date then return null; end if;
    select count(*)::integer into v_waiting from public.waitlist_requests w where w.requested_date = v_date and w.status <> 'closed';
    if v_waiting = 0 then return null; end if;
    v_title := 'A time may have opened up';
    v_body := format('%s waiting for %s. Open the waitlist to see who could be booked.', case when v_waiting = 1 then '1 person is' else v_waiting::text || ' people are' end, to_char(v_date, 'FMDy FMDD FMMon'));
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
create trigger event_outbox_plan_waitlist_notifications after insert on public.event_outbox
  for each row execute function public.plan_waitlist_notifications();

revoke all on function public.join_waitlist(date, integer, integer, integer, text, text, text, text) from public;
revoke all on function public.admin_waitlist(boolean) from public, anon;
revoke all on function public.admin_update_waitlist(uuid, text, text) from public, anon;
revoke all on function public.plan_waitlist_notifications() from public, anon, authenticated;
grant execute on function public.join_waitlist(date, integer, integer, integer, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_waitlist(boolean) to authenticated;
grant execute on function public.admin_update_waitlist(uuid, text, text) to authenticated;
