-- The booking's address goes into its Google Calendar event, as the event's location (Vadim's request, 20 Oct 2026): the phone's calendar keeps it
-- offline and offers directions. Only the booking event has it, never the Travel event. Someone the calendar is shared with as free/busy sees no details,
-- so the address stays private there. Everything else the calendar holds is unchanged.
-- An event's content fingerprint now includes the location, so the regular 15-minute check puts the address into the events already in
-- Google by itself; and a booking's address changing now queues it too.

-- The rules function gains a location column (a new return type, so it is dropped and made again, with the same permissions).
drop function public.calendar_desired_events(date, date, uuid[]);
create function public.calendar_desired_events(p_from date default null, p_to date default null, p_booking_ids uuid[] default null)
returns table (booking_id uuid, kind text, google_event_id text, title text, starts_at timestamptz, ends_at timestamptz, description text, location text, content_hash text)
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
        b.treatment_duration_minutes || ' min total') as description,
      nullif(btrim(b.address_snapshot), '') as location
    from public.bookings b
    left join public.clients c on c.id = b.client_id
    where b.booking_status in ('confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'completed', 'no_show')
      and (p_from is null or b.date >= p_from) and (p_to is null or b.date <= p_to)
      and (p_booking_ids is null or b.id = any(p_booking_ids))
  ), events as (
    select id as booking_id, 'booking'::text as kind, 'vm' || replace(id::text, '-', '') || 'b' as google_event_id, title, starts_at, ends_at, description, location from shown
    union all
    select id, 'travel', 'vm' || replace(id::text, '-', '') || 't', 'Travel', ends_at, ends_at + make_interval(mins => travel_buffer_minutes), '', null::text from shown
    where travel_buffer_minutes > 0
  )
  select e.booking_id, e.kind, e.google_event_id, e.title, e.starts_at, e.ends_at, e.description, e.location,
    md5(concat_ws('|', e.title, to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char(e.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), e.description, e.location)) as content_hash
  from events e
  order by e.starts_at, e.kind;
$$;
revoke all on function public.calendar_desired_events(date, date, uuid[]) from public, anon, authenticated;
grant execute on function public.calendar_desired_events(date, date, uuid[]) to service_role;

drop trigger bookings_calendar_sync on public.bookings;
create trigger bookings_calendar_sync
after insert or delete or update of booking_status, date, start_minutes, treatment_duration_minutes, travel_buffer_minutes, client_id, address_snapshot on public.bookings
for each row execute function public.calendar_queue_booking();
