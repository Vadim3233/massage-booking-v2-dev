-- Google Calendar copy of the bookings (docs/google-calendar-sync-brief.md), part A: the database.
-- One way only, database -> Google, display only. Nothing here talks to Google: a server job (on Vercel, like the email and Telegram sender)
-- reads what the calendar should hold from calendar_desired_events and makes the "VadMassage bookings" calendar match it.
-- No booking behaviour, availability or state change is touched. The only thing added to the booking tables is a trigger that notes which
-- booking needs checking, and it can never stop a booking being saved.

-- The one Google connection. The refresh token is kept in Supabase Vault, referred to here by its id only.
create table public.calendar_connection (
  id boolean primary key default true constraint calendar_connection_single_row check (id),
  status text not null default 'disconnected' constraint calendar_connection_status_valid check (status in ('connected', 'needs_reconnect', 'disconnected')),
  account_email text,
  calendar_id text,
  refresh_token_secret_id uuid,
  connected_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  -- When the job last looked for bookings out of step with the calendar (every 15 minutes), and last rewrote everything (nightly).
  last_check_at timestamptz,
  last_full_check_at timestamptz,
  updated_at timestamptz not null default now()
);

-- What was last put in Google for each booking: its booking event and its travel event.
-- No foreign key to bookings on purpose: a booking deleted outright must still have its events found and removed.
create table public.calendar_sync_events (
  booking_id uuid not null,
  kind text not null constraint calendar_sync_events_kind_valid check (kind in ('booking', 'travel')),
  google_event_id text not null,
  content_hash text not null,
  synced_at timestamptz not null default now(),
  primary key (booking_id, kind)
);

-- The calendar's own queue: which bookings to check. One row per booking, whatever changed and however often (the job re-reads the booking
-- as it is now, so order and repeats do not matter). Kept apart from event_outbox, whose rows the existing tests count exactly, and which
-- sets off the email and Telegram messages.
create table public.calendar_sync_queue (
  booking_id uuid primary key,
  queued_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 constraint calendar_sync_queue_attempts_valid check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text,
  failed_at timestamptz,
  -- Put in Google again even if nothing seems to have changed (the nightly check and Resync now), to undo a change made in Google.
  force boolean not null default false
);
create index calendar_sync_queue_due_idx on public.calendar_sync_queue (next_attempt_at) where failed_at is null;

alter table public.calendar_connection enable row level security;
alter table public.calendar_sync_events enable row level security;
alter table public.calendar_sync_queue enable row level security;
revoke all on table public.calendar_connection, public.calendar_sync_events, public.calendar_sync_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.calendar_connection, public.calendar_sync_events, public.calendar_sync_queue to service_role;

-- Notes a booking for checking. It can never stop the change that called it: if noting fails, a warning is logged and the regular
-- check (every 15 minutes, and nightly) puts the calendar right anyway.
create function public.queue_calendar_sync(p_booking_ids uuid[], p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.calendar_sync_queue (booking_id, force)
  select distinct unnest(p_booking_ids), coalesce(p_force, false)
  on conflict (booking_id) do update set queued_at = clock_timestamp(), attempt_count = 0, next_attempt_at = clock_timestamp(), last_error = null, failed_at = null,
    force = public.calendar_sync_queue.force or excluded.force;
exception when others then
  raise warning 'calendar sync queue: %', sqlerrm;
end;
$$;
revoke all on function public.queue_calendar_sync(uuid[], boolean) from public, anon, authenticated;
grant execute on function public.queue_calendar_sync(uuid[], boolean) to service_role;

create function public.calendar_queue_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_calendar_sync(array[case when tg_op = 'DELETE' then old.id else new.id end]);
  return null;
end;
$$;
create function public.calendar_queue_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_calendar_sync(array[case when tg_op = 'DELETE' then old.booking_id else new.booking_id end]);
  return null;
end;
$$;
-- A client's name is in their bookings' titles.
create function public.calendar_queue_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.queue_calendar_sync(array(select b.id from public.bookings b where b.client_id = new.id));
  return null;
end;
$$;
revoke all on function public.calendar_queue_booking() from public, anon, authenticated;
revoke all on function public.calendar_queue_session() from public, anon, authenticated;
revoke all on function public.calendar_queue_client() from public, anon, authenticated;

create trigger bookings_calendar_sync
after insert or delete or update of booking_status, date, start_minutes, treatment_duration_minutes, travel_buffer_minutes, client_id on public.bookings
for each row execute function public.calendar_queue_booking();
create trigger booking_sessions_calendar_sync
after insert or delete or update on public.booking_sessions
for each row execute function public.calendar_queue_session();
create trigger clients_calendar_sync
after update of first_name, last_name on public.clients
for each row when (old.first_name is distinct from new.first_name or old.last_name is distinct from new.last_name)
execute function public.calendar_queue_client();

-- What the calendar should hold. ALL the rules are here, in one place:
--   which bookings show, and their titles (by booking status; cancelled ones and holds never show; nothing lapses, a booking waiting for
--   money stays until it is confirmed or removed); the time, from treatment start to end in London time; a description with the treatments
--   and the total length only (never the address, phone, email, prices, payment or notes); and after each a "Travel" event as long as that
--   booking's own travel buffer (none when it is 0).
-- The Google event ids are fixed by the booking (vm + the booking's id without dashes + b or t), so putting an event in twice cannot make two.
-- Bookings by date (p_from to p_to, either may be null for no limit), or only the bookings listed when p_booking_ids is given.
create function public.calendar_desired_events(p_from date default null, p_to date default null, p_booking_ids uuid[] default null)
returns table (booking_id uuid, kind text, google_event_id text, title text, starts_at timestamptz, ends_at timestamptz, description text, content_hash text)
language sql
stable
security definer
set search_path = ''
as $$
  with shown as (
    select b.id, b.travel_buffer_minutes,
      (b.date::timestamp + make_interval(mins => b.start_minutes)) at time zone 'Europe/London' as starts_at,
      (b.date::timestamp + make_interval(mins => b.start_minutes + b.treatment_duration_minutes)) at time zone 'Europe/London' as ends_at,
      case b.booking_status
        when 'confirmed' then 'Massage – '
        when 'awaiting_transfer' then '⏳ Awaiting payment – '
        when 'awaiting_payment_verification' then '⏳ Payment being checked – '
        when 'awaiting_cash_approval' then '⏳ Awaiting cash approval – '
        when 'completed' then '✓ Massage – '
        when 'no_show' then 'No-show – '
      end || coalesce(nullif(btrim(concat_ws(' ', btrim(c.first_name), nullif(btrim(c.last_name), ''))), ''), 'Client') as title,
      concat_ws(' · ',
        (select string_agg(concat_ws(' ', nullif(btrim(s.service_name_snapshot), ''), s.duration_minutes || ' min'), ' + ' order by s.position)
           from public.booking_sessions s where s.booking_id = b.id),
        b.treatment_duration_minutes || ' min total') as description
    from public.bookings b
    left join public.clients c on c.id = b.client_id
    where b.booking_status in ('confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'completed', 'no_show')
      and (p_from is null or b.date >= p_from) and (p_to is null or b.date <= p_to)
      and (p_booking_ids is null or b.id = any(p_booking_ids))
  ), events as (
    select id as booking_id, 'booking'::text as kind, 'vm' || replace(id::text, '-', '') || 'b' as google_event_id, title, starts_at, ends_at, description from shown
    union all
    select id, 'travel', 'vm' || replace(id::text, '-', '') || 't', 'Travel', ends_at, ends_at + make_interval(mins => travel_buffer_minutes), '' from shown
    where travel_buffer_minutes > 0
  )
  select e.booking_id, e.kind, e.google_event_id, e.title, e.starts_at, e.ends_at, e.description,
    md5(concat_ws('|', e.title, to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char(e.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), e.description)) as content_hash
  from events e
  order by e.starts_at, e.kind;
$$;
revoke all on function public.calendar_desired_events(date, date, uuid[]) from public, anon, authenticated;
grant execute on function public.calendar_desired_events(date, date, uuid[]) to service_role;

-- Every booking, and every booking something was put in Google for (a booking deleted outright included), is queued: on connecting,
-- nightly and from Resync now (forced, so a change made in Google is undone).
create function public.calendar_queue_all(p_force boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := array(select id from public.bookings union select booking_id from public.calendar_sync_events);
begin
  perform public.queue_calendar_sync(v_ids, p_force);
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;
-- The 15-minute check: bookings whose events are not what was last put in Google (missing, different, or no longer wanted) are queued.
create function public.calendar_queue_out_of_step()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with wanted as (select d.booking_id, d.kind, d.content_hash from public.calendar_desired_events() d),
  differ as (
    select coalesce(w.booking_id, s.booking_id) as booking_id from wanted w
    full join public.calendar_sync_events s on s.booking_id = w.booking_id and s.kind = w.kind
    where w.content_hash is distinct from s.content_hash
  )
  select array(select distinct booking_id from differ) into v_ids;
  perform public.queue_calendar_sync(v_ids);
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;
revoke all on function public.calendar_queue_all(boolean) from public, anon, authenticated;
revoke all on function public.calendar_queue_out_of_step() from public, anon, authenticated;
grant execute on function public.calendar_queue_all(boolean) to service_role;
grant execute on function public.calendar_queue_out_of_step() to service_role;

-- The job takes bookings to check, a few at a time, without two runs taking the same one. A booking taken is not offered again for
-- 10 minutes unless it is finished first; after 5 tries it is marked failed (and checked again by the regular full check).
create function public.claim_calendar_sync(p_limit integer default 20)
returns table (booking_id uuid, queued_at timestamptz, attempt_count integer, force boolean)
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select q.booking_id from public.calendar_sync_queue q
    where q.failed_at is null and q.next_attempt_at <= clock_timestamp()
    order by q.queued_at
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update skip locked
  )
  update public.calendar_sync_queue q set attempt_count = q.attempt_count + 1, next_attempt_at = clock_timestamp() + interval '10 minutes'
  from picked where q.booking_id = picked.booking_id
  returning q.booking_id, q.queued_at, q.attempt_count, q.force;
$$;

-- The job says how a booking went. Done: it leaves the queue, unless it changed again meanwhile (then it stays, to be checked again).
-- Not done: it is tried again after 2, 8, 18 and 32 minutes, then marked failed with the reason.
create function public.complete_calendar_sync(p_booking_id uuid, p_queued_at timestamptz, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_error is null then
    delete from public.calendar_sync_queue where booking_id = p_booking_id and queued_at = p_queued_at;
  else
    update public.calendar_sync_queue set last_error = left(p_error, 500),
      next_attempt_at = clock_timestamp() + make_interval(mins => 2 * attempt_count * attempt_count),
      failed_at = case when attempt_count >= 5 then clock_timestamp() end
    where booking_id = p_booking_id and queued_at = p_queued_at;
  end if;
end;
$$;
revoke all on function public.claim_calendar_sync(integer) from public, anon, authenticated;
revoke all on function public.complete_calendar_sync(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_calendar_sync(integer) to service_role;
grant execute on function public.complete_calendar_sync(uuid, timestamptz, text) to service_role;

-- The Google refresh token, kept in Vault. Only the server job and the sign-in callback (both with the service role) use these.
create function public.calendar_save_connection(p_refresh_token text, p_account_email text, p_calendar_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid := (select refresh_token_secret_id from public.calendar_connection where id);
begin
  if nullif(btrim(p_refresh_token), '') is null or nullif(btrim(p_calendar_id), '') is null then
    raise exception 'A refresh token and a calendar are needed' using errcode = '22023';
  end if;
  if v_secret is not null and exists (select 1 from vault.secrets where id = v_secret) then
    perform vault.update_secret(v_secret, p_refresh_token);
  else
    v_secret := vault.create_secret(p_refresh_token, 'google_calendar_refresh_token_' || gen_random_uuid(), 'Google Calendar copy of the bookings');
  end if;
  insert into public.calendar_connection (id, status, account_email, calendar_id, refresh_token_secret_id, connected_at, last_error, last_error_at, updated_at)
  values (true, 'connected', p_account_email, p_calendar_id, v_secret, now(), null, null, now())
  on conflict (id) do update set status = 'connected', account_email = excluded.account_email, calendar_id = excluded.calendar_id,
    refresh_token_secret_id = excluded.refresh_token_secret_id, connected_at = excluded.connected_at, last_error = null, last_error_at = null, updated_at = now();
  -- Connecting copies every booking in (and puts back anything changed in Google while disconnected).
  perform public.calendar_queue_all(true);
end;
$$;
create function public.calendar_refresh_token()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from public.calendar_connection c join vault.decrypted_secrets s on s.id = c.refresh_token_secret_id
  where c.id and c.status = 'connected';
$$;
-- Disconnecting forgets the token (the job revokes it at Google first). The calendar itself is left in Google, and what was put in it is
-- forgotten here, so connecting again starts with a full copy.
create function public.calendar_forget_connection(p_status text default 'disconnected', p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid := (select refresh_token_secret_id from public.calendar_connection where id);
begin
  if p_status not in ('disconnected', 'needs_reconnect') then raise exception 'Unknown calendar status' using errcode = '22023'; end if;
  if v_secret is not null then delete from vault.secrets where id = v_secret; end if;
  update public.calendar_connection set status = p_status, refresh_token_secret_id = null, updated_at = now(),
    last_error = coalesce(left(p_error, 500), last_error), last_error_at = case when p_error is not null then now() else last_error_at end
  where id;
  if p_status = 'disconnected' then delete from public.calendar_sync_events; end if;
end;
$$;
revoke all on function public.calendar_save_connection(text, text, text) from public, anon, authenticated;
revoke all on function public.calendar_refresh_token() from public, anon, authenticated;
revoke all on function public.calendar_forget_connection(text, text) from public, anon, authenticated;
grant execute on function public.calendar_save_connection(text, text, text) to service_role;
grant execute on function public.calendar_refresh_token() to service_role;
grant execute on function public.calendar_forget_connection(text, text) to service_role;

-- For the Admin's Calendar settings screen: how the copy stands, never the token.
create function public.admin_calendar_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'status', coalesce((select status from public.calendar_connection where id), 'disconnected'),
    'account_email', (select account_email from public.calendar_connection where id),
    'connected_at', (select connected_at from public.calendar_connection where id),
    'last_success_at', (select last_success_at from public.calendar_connection where id),
    'last_error', (select last_error from public.calendar_connection where id),
    'last_error_at', (select last_error_at from public.calendar_connection where id),
    'waiting', (select count(*) from public.calendar_sync_queue where failed_at is null),
    'failed', (select count(*) from public.calendar_sync_queue where failed_at is not null));
end;
$$;
-- "Resync now": every booking is checked again (including ones that failed before).
create function public.admin_calendar_resync()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  perform public.calendar_queue_all(true);
  select count(*) into v_count from public.calendar_sync_queue;
  return v_count;
end;
$$;
revoke all on function public.admin_calendar_status() from public, anon;
revoke all on function public.admin_calendar_resync() from public, anon;
grant execute on function public.admin_calendar_status() to authenticated;
grant execute on function public.admin_calendar_resync() to authenticated;
