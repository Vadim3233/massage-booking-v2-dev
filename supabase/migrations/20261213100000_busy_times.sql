-- VAD Massage Booking V2
-- Busiest times (ADR-101): the "Busiest times" section on the Income page and the "When … books" card on a client's page.
-- Read only: nothing is stored or changed. It lists the visits (date, start time and money received); the app does the counting.
--
-- A visit is a booking that was completed, or a confirmed booking whose day has passed, the same rule as the client stats (ADR-099).
-- A booking for two people is one visit. Cancelled and no-show bookings are not visits. The money is what was received for the visit after any
-- refund (0 when it is still unpaid), from the same income_lines the Income page uses.
--
-- For the whole business (no client given) it also lists "wanted times" from the Visitors log (ADR-095): a time someone tapped on the booking page
-- although it was taken, in the last 90 days, once per visit, day and time. That is demand that could not be booked. If the Visitors change
-- (20261130100000_visitors_and_wanted_times.sql) is not applied, the list is empty.
--
-- Safe to run again: the function is created or replaced, and the grants are set again.
-- To take this back: drop function public.admin_busy_times(uuid);

create or replace function public.admin_busy_times(p_client_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_wanted jsonb := '[]'::jsonb;
begin
  perform public.require_booking_admin();
  if p_client_id is null and to_regclass('public.visit_events') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('date', w.date, 'start_minutes', w.start_minutes) order by w.date, w.start_minutes), '[]'::jsonb)
      from (
        select distinct e.visit_id, (e.detail->>'date')::date as date, (e.detail->>'start')::integer as start_minutes
        from public.visit_events e
        where e.kind in ('wanted', 'asked') and e.at >= clock_timestamp() - interval '90 days'
          and e.detail->>'date' ~ '^\d{4}-\d{2}-\d{2}$' and e.detail->>'start' ~ '^\d+$'
      ) w
    $q$ into v_wanted;
  end if;
  return jsonb_build_object(
    'today', v_today,
    'wanted', v_wanted,
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object('date', b.date, 'start_minutes', b.start_minutes, 'net_gbp', coalesce(l.net_gbp, 0)) order by b.date, b.start_minutes)
      from public.bookings b
      left join public.income_lines('2000-01-01'::date, v_today) l on l.booking_id = b.id
      where (b.booking_status = 'completed' or (b.booking_status = 'confirmed' and b.date < v_today))
        and b.date < v_today
        and (p_client_id is null or b.client_id = p_client_id)), '[]'::jsonb));
end;
$$;

revoke all on function public.admin_busy_times(uuid) from public, anon;
grant execute on function public.admin_busy_times(uuid) to authenticated;
