-- VAD Massage Booking V2
-- A reminder email on the morning of the appointment.
--
-- The sender asks plan_day_of_reminders() what is due each time it runs. A client is reminded when:
--   * their appointment is today (London time) and is confirmed (not waiting for payment or cash approval, not cancelled);
--   * the time of day has come: from 08:00 London, or the minutes since midnight in the business setting
--     client_reminder_minutes (480 when it is not set), so the reminder goes out in the morning whatever the clocks are doing;
--   * the booking has an email address, and the appointment is at least an hour away (a reminder that arrives as the
--     visit starts is no use);
--   * they have not already been emailed about this booking today (booked, confirmed or moved), because they have just been told;
--   * they have not been reminded for this date already (the event's deduplication key), so running the sender again,
--     or twice at once, never repeats it.
--
-- The reminder is an ordinary client email in the notification queue, written here rather than by the event trigger, so
-- the trigger is left as it is. Anything that follows client emails follows this one too.
--
-- Where the appointment is comes from the one text the booking keeps, bookings.address_snapshot (ADR-059, added by
-- 20261104100000_single_address.sql, which has to be applied before this reminder is switched on). The function body is
-- only checked when it runs, so this file still applies on its own.

create function public.plan_day_of_reminders(p_now timestamptz default clock_timestamp())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'Europe/London';
  v_today date := v_local::date;
  v_minutes integer := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  v_from integer := public.business_setting_int('client_reminder_minutes', 480);
  v_day_start timestamptz := v_today::timestamp at time zone 'Europe/London';
  v_sign text := E'\n\nWarm wishes,\nVad';
  b record;
  v_event uuid;
  v_where text;
  v_made integer := 0;
begin
  if v_minutes < v_from then return 0; end if;
  for b in
    select bk.id, bk.start_minutes, bk.booking_email_snapshot, bk.address_snapshot,
           nullif(btrim(c.first_name), '') as first_name
      from public.bookings bk
      join public.clients c on c.id = bk.client_id
     where bk.date = v_today
       and bk.booking_status = 'confirmed'
       and nullif(btrim(bk.booking_email_snapshot), '') is not null
       and bk.start_minutes >= v_minutes + 60
       and not exists (
         select 1
           from public.notification_deliveries d
           join public.event_outbox e on e.id = d.event_id
          where e.aggregate_type = 'booking' and e.aggregate_id = bk.id
            and d.audience = 'client' and d.channel = 'email' and d.created_at >= v_day_start)
     order by bk.start_minutes, bk.id
  loop
    v_event := null;
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('booking.reminder', 'booking', b.id, 'booking.reminder:' || b.id::text || ':' || v_today::text, jsonb_build_object('date', v_today))
    on conflict (deduplication_key) do nothing
    returning id into v_event;
    if v_event is null then continue; end if;
    v_where := b.address_snapshot;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'email', 'client', btrim(b.booking_email_snapshot), 'Your appointment is today',
      format('Hi %s, a quick reminder: your appointment is today at %s%s. I''m looking forward to seeing you!',
        coalesce(b.first_name, 'there'),
        lpad((b.start_minutes / 60)::text, 2, '0') || ':' || lpad((b.start_minutes % 60)::text, 2, '0'),
        case when v_where = '' then '' else ', at ' || v_where end)
        || E'\n\nYou can see or change your booking here: {link}' || v_sign,
      '/account?booking=' || b.id::text);
    v_made := v_made + 1;
  end loop;
  return v_made;
end;
$$;

revoke all on function public.plan_day_of_reminders(timestamptz) from public, anon, authenticated;
grant execute on function public.plan_day_of_reminders(timestamptz) to service_role;
