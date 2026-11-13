-- VAD Massage Booking V2
-- Client base stats on the Clients page (ADR-099). Read only: nothing is stored, every number is worked out from the bookings each time.
--
-- A visit is a booking that was completed, or a confirmed booking whose day has passed (not every session is marked completed). A booking for two
-- people is one visit. Cancelled and no-show bookings are not visits. "Paid" is the money marked paid, as on a client's page.
--
-- Each client gets at most one tag, in this order:
--   new      their first visit was in the last 60 days;
--   lapsed   no visit for 6 months (183 days) and nothing booked;
--   quiet    3 or more visits, nothing booked, and it has been more than twice their usual gap (and at least 4 weeks) since the last one;
--   regular  3 or more visits otherwise.
-- Anyone else (one or two visits a while ago, or no visit yet) has no tag.
-- Active means a visit in the last 90 days, or something booked.
--
-- Safe to run again: each function is created or replaced, and the grants are set again.
--
-- To take this back: drop function public.admin_client_base(); drop function public.admin_client_rhythm(uuid); drop function public.client_visit_stats(date);

-- ---------------------------------------------------------------------------------------------
-- One row per client with their visit numbers and tag. Internal: only the two Admin functions below call it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.client_visit_stats(p_today date)
returns table(client_id uuid, visits integer, first_visit date, last_visit date, gap_days integer, next_date date, paid_gbp numeric,
  tag text, overdue_days integer)
language sql stable security definer set search_path = '' as $$
  with visit as (
    select b.client_id, b.date from public.bookings b
    where b.booking_status = 'completed' or (b.booking_status = 'confirmed' and b.date < p_today)
  ), per as (
    select v.client_id, count(*)::integer as visits, min(v.date) as first_visit, max(v.date) as last_visit from visit v group by v.client_id
  ), upcoming as (
    select b.client_id, min(b.date) as next_date from public.bookings b
    where b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') and b.date >= p_today
    group by b.client_id
  ), paid as (
    select b.client_id, sum(p.amount_gbp) as paid_gbp from public.bookings b join public.booking_payments p on p.booking_id = b.id
    where p.status = 'paid' group by b.client_id
  ), base as (
    select c.id as client_id, coalesce(per.visits, 0) as visits, per.first_visit, per.last_visit,
      case when per.visits >= 2 then round((per.last_visit - per.first_visit)::numeric / (per.visits - 1))::integer end as gap_days,
      u.next_date, coalesce(pd.paid_gbp, 0) as paid_gbp
    from public.clients c left join per on per.client_id = c.id left join upcoming u on u.client_id = c.id left join paid pd on pd.client_id = c.id
  )
  select b.client_id, b.visits, b.first_visit, b.last_visit, b.gap_days, b.next_date, b.paid_gbp,
    case
      when b.first_visit >= p_today - 60 then 'new'
      when b.last_visit < p_today - 183 and b.next_date is null then 'lapsed'
      when b.visits >= 3 and b.next_date is null and p_today - b.last_visit > greatest(2 * b.gap_days, 28) then 'quiet'
      when b.visits >= 3 then 'regular'
    end,
    case when b.gap_days is not null and b.next_date is null then greatest(p_today - b.last_visit - b.gap_days, 0) end
  from base b;
$$;
revoke all on function public.client_visit_stats(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The Clients page: four numbers at the top and one row per client (name, contact and stats) for the tags, filters and lists.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_client_base()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_month date := date_trunc('month', (clock_timestamp() at time zone 'Europe/London')::date)::date;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return (
    with s as (select * from public.client_visit_stats(v_today))
    select jsonb_build_object(
      'today', v_today,
      'total', (select count(*) from s),
      'active', (select count(*) from s where s.last_visit >= v_today - 90 or s.next_date is not null),
      'new_this_month', (select count(*) from s where s.first_visit >= v_month),
      'new_last_month', (select count(*) from s where s.first_visit >= (v_month - interval '1 month')::date and s.first_visit < v_month),
      'visited', (select count(*) from s where s.visits >= 1),
      'came_back', (select count(*) from s where s.visits >= 2 or (s.visits = 1 and s.next_date is not null)),
      'usual_gap_days', (select round(percentile_cont(0.5) within group (order by s.gap_days))::integer from s where s.visits >= 3),
      'clients', coalesce((select jsonb_agg(jsonb_build_object(
          'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'phone', c.phone, 'email', c.email,
          'visits', s.visits, 'first_visit', s.first_visit, 'last_visit', s.last_visit, 'gap_days', s.gap_days, 'next_date', s.next_date,
          'paid_gbp', s.paid_gbp, 'tag', s.tag, 'overdue_days', s.overdue_days)
          order by lower(c.first_name), lower(c.last_name), c.id)
        from s join public.clients c on c.id = s.client_id), '[]'::jsonb)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- One client's card: their tag and rhythm, visits in each of the last 12 months, and their place among all clients by visits.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_client_rhythm(p_client_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_first_month date := (date_trunc('month', (clock_timestamp() at time zone 'Europe/London')::date) - interval '11 months')::date;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then raise exception 'Client unavailable' using errcode = 'P0002'; end if;
  return (
    with s as (select * from public.client_visit_stats(v_today)), me as (select * from s where s.client_id = p_client_id)
    select jsonb_build_object(
      'tag', me.tag, 'visits', me.visits, 'first_visit', me.first_visit, 'last_visit', me.last_visit, 'gap_days', me.gap_days,
      'overdue_days', me.overdue_days, 'next_date', me.next_date,
      'rank', case when me.visits > 0 then (select count(*) + 1 from s where s.visits > me.visits) end,
      'clients', (select count(*) from s),
      'months', (select jsonb_agg(jsonb_build_object('month', m.month, 'visits', (
          select count(*) from public.bookings b where b.client_id = p_client_id
            and (b.booking_status = 'completed' or (b.booking_status = 'confirmed' and b.date < v_today))
            and b.date >= m.month and b.date < (m.month + interval '1 month')::date)) order by m.month)
        from (select (v_first_month + make_interval(months => g))::date as month from generate_series(0, 11) g) m))
    from me);
end;
$$;

revoke all on function public.admin_client_base(), public.admin_client_rhythm(uuid) from public, anon;
grant execute on function public.admin_client_base(), public.admin_client_rhythm(uuid) to authenticated;
