-- Alerts record (ADR-107), follow-up: a gift voucher Vadim cancels is now in the record.
-- Before this, "Cancel voucher" in More > Gift vouchers changed the voucher but wrote nothing, so the record still showed
-- "New gift voucher" as new, with no sign it was cancelled. Now:
--   * cancelling writes a "gift.cancelled" line (by You), and the voucher's alerts stop counting as new: nothing is left to do;
--   * every gift line carries the voucher's status now, so "New gift voucher" says "cancelled since" when it was;
--   * vouchers already cancelled by Vadim get their line added once, at the time they were cancelled.
-- Safe to run more than once.

create or replace function public.admin_cancel_gift_voucher(p_voucher_id uuid)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  update public.gift_vouchers g set status = 'cancelled' where g.id = p_voucher_id and g.status in ('awaiting_payment', 'ready') returning * into v;
  if not found then raise exception 'That voucher has already been used, so it can''t be cancelled.' using errcode = 'PT409'; end if;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('gift.cancelled', 'gift_voucher', v.id, 'gift.cancelled:' || v.id::text,
    jsonb_build_object('gift_voucher_id', v.id, 'actor_type', 'admin', 'actor_id', auth.uid(), 'from_status', 'ready'))
  on conflict (deduplication_key) do nothing;
  update public.notification_deliveries d set read_at = clock_timestamp()
  where d.channel = 'in_app' and d.read_at is null
    and d.event_id in (select e.id from public.event_outbox e where e.aggregate_type = 'gift_voucher' and e.aggregate_id = v.id);
  return v;
end; $$;
revoke all on function public.admin_cancel_gift_voucher(uuid) from public, anon;
grant execute on function public.admin_cancel_gift_voucher(uuid) to authenticated;

-- Vouchers Vadim already cancelled (the buyer's own cancel always wrote its line).
insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload, created_at)
select 'gift.cancelled', 'gift_voucher', g.id, 'gift.cancelled:' || g.id::text,
  jsonb_build_object('gift_voucher_id', g.id, 'actor_type', 'admin', 'backfilled', true), g.updated_at
from public.gift_vouchers g
where g.status = 'cancelled'
  and not exists (select 1 from public.event_outbox e where e.aggregate_type = 'gift_voucher' and e.aggregate_id = g.id
    and e.event_type in ('gift.cancelled', 'gift.buyer_cancelled', 'gift.refund_requested'))
on conflict (deduplication_key) do nothing;
update public.notification_deliveries d set read_at = clock_timestamp()
where d.channel = 'in_app' and d.read_at is null
  and d.event_id in (select e.id from public.event_outbox e join public.gift_vouchers g on g.id = e.aggregate_id
    where e.aggregate_type = 'gift_voucher' and g.status = 'cancelled'
      and exists (select 1 from public.event_outbox c where c.aggregate_type = 'gift_voucher' and c.aggregate_id = g.id and c.event_type = 'gift.cancelled'));

-- The record, as before, with the voucher's status on gift lines and Vadim's cancel shown as his.
create or replace function public.activity_rows(p_booking_id uuid default null, p_before_at timestamptz default null,
  p_before_id uuid default null, p_limit integer default null, p_types text default 'all', p_unread_only boolean default false)
returns table (
  id uuid, event_type text, at timestamptz, actor text, via text, initiated_by text,
  booking_id uuid, client_id uuid, name text, booking_date date, booking_start integer, booking_minutes integer, booking_total numeric,
  booking_status text, gift_voucher_id uuid, payload jsonb, note text, late boolean, next_address text,
  alert_id uuid, alert_title text, alert_body text, alert_link text, alert_read_at timestamptz, sent jsonb)
language sql stable security definer set search_path = '' as $$
  with settings as (select public.business_setting_int('free_cancellation_hours', 24) as free_hours),
  page as (
    select e.* from public.event_outbox e
    where e.event_type <> 'client.created' and e.aggregate_type <> 'insight'
      and (p_booking_id is null or (e.aggregate_type = 'booking' and e.aggregate_id = p_booking_id))
      and (p_before_at is null or (e.created_at, e.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
      and case coalesce(p_types, 'all')
        when 'money' then e.event_type = any(public.activity_money_types())
        when 'gifts' then e.event_type like 'gift.%'
        when 'bookings' then e.event_type not like 'gift.%' and not (e.event_type = any(public.activity_money_types()))
        else true end
      and (not p_unread_only or exists (select 1 from public.notification_deliveries d where d.event_id = e.id and d.channel = 'in_app' and d.read_at is null))
    order by e.created_at desc, e.id desc
    limit p_limit
  ),
  ev as (
    select e.*, cmd.actor_type as cmd_actor,
      case when e.aggregate_type = 'booking' then e.aggregate_id end as b_id,
      case when e.aggregate_type = 'gift_voucher' then e.aggregate_id end as g_id,
      case when e.aggregate_type = 'waitlist' then e.aggregate_id end as w_id,
      case when e.aggregate_type = 'client' then e.aggregate_id end as c_id,
      case when e.aggregate_type = 'series' then e.aggregate_id end as s_id
    from page e
    left join public.command_requests cmd on cmd.id = e.source_command_id
  )
  select ev.id, ev.event_type, ev.created_at,
    case
      when ev.event_type like 'gift.%' then
        case when ev.cmd_actor = 'admin' or ev.payload->>'actor_type' = 'admin' or ev.event_type in ('gift.ready', 'gift.refund_sent', 'gift.cancelled') then 'admin'
             when ev.event_type in ('gift.arrived', 'gift.reminder') then 'system' else 'buyer' end
      when ev.payload->>'actor_type' in ('admin', 'client', 'system') then ev.payload->>'actor_type'
      when ev.cmd_actor in ('admin', 'client', 'system') then ev.cmd_actor
      when ev.payload->>'actor_id' is not null and exists (select 1 from public.admin_users a where a.user_id::text = ev.payload->>'actor_id') then 'admin'
      when ev.payload->>'actor_id' is not null then 'client'
      when ev.event_type in ('booking.created', 'booking.transfer_declared', 'booking.cash_requested', 'booking.extra_reported',
        'booking.pay_after_requested', 'waitlist.joined') then 'client'
      else 'system' end,
    case when ev.event_type = 'booking.created' and b.source_channel = 'ai_assistant' then 'ai' end,
    ev.payload->>'initiated_by',
    b.id, cl.id,
    coalesce(nullif(btrim(concat_ws(' ', cl.first_name, cl.last_name)), ''), nullif(btrim(g.buyer_name), ''), nullif(btrim(w.contact_name), '')),
    b.date, b.start_minutes, b.treatment_duration_minutes, b.total_gbp, b.booking_status, g.id,
    ev.payload || case when g.id is not null then jsonb_build_object('gift_status', g.status) else '{}'::jsonb end,
    -- Vadim's "why", a cancellation's reason, or a note's text (read from the note itself, so a deleted note's words are gone).
    coalesce(n.note, case when ev.event_type = 'booking.cancelled' then nullif(btrim(b.cancellation_reason), '') end,
      case when ev.event_type = 'client.note_added' then (select left(btrim(cn.note), 160) from public.client_notes cn where cn.id::text = ev.payload->>'note_id') end),
    -- A move, change or cancel inside the free-cancellation window (24 hours unless changed in Booking rules) before the session, and
    -- before it started (tidying up a past booking is not late).
    coalesce(case
      when ev.event_type in ('booking.rescheduled', 'booking.services_changed') and ev.payload ? 'from_date' then
        ev.created_at between ((((ev.payload->>'from_date')::date + make_interval(mins => (ev.payload->>'from_start_minutes')::integer))
          at time zone 'Europe/London') - make_interval(hours => settings.free_hours))
          and (((ev.payload->>'from_date')::date + make_interval(mins => (ev.payload->>'from_start_minutes')::integer)) at time zone 'Europe/London')
      when ev.event_type = 'booking.cancelled' and b.id is not null then
        ev.created_at between (((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') - make_interval(hours => settings.free_hours))
          and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London')
    end, false),
    -- An address change: the address it changed to (the next change's old address, or the address now).
    case when ev.event_type = 'booking.address_changed' then
      coalesce((select nx.payload->>'previous_address' from public.event_outbox nx
        where nx.aggregate_type = 'booking' and nx.aggregate_id = ev.aggregate_id and nx.event_type = 'booking.address_changed'
          and (nx.created_at, nx.id) > (ev.created_at, ev.id) order by nx.created_at, nx.id limit 1), b.address_snapshot) end,
    alert.id, alert.title, alert.body, alert.link_path, alert.read_at,
    sent.list
  from ev
  cross join settings
  left join public.bookings b on b.id = ev.b_id
  left join public.gift_vouchers g on g.id = coalesce(ev.g_id, nullif(ev.payload->>'gift_voucher_id', '')::uuid)
  left join public.waitlist_requests w on w.id = ev.w_id
  left join public.booking_series s on s.id = ev.s_id
  left join public.clients cl on cl.id = coalesce(b.client_id, public.activity_current_client(coalesce(ev.c_id, w.client_id, s.client_id)))
  left join public.activity_notes n on n.event_id = ev.id
  left join lateral (
    select d.id, d.title, d.body, d.link_path, d.read_at from public.notification_deliveries d
    where d.event_id = ev.id and d.channel = 'in_app' order by d.created_at limit 1) alert on true
  left join lateral (
    select jsonb_agg(jsonb_build_object('channel', d.channel, 'status', d.status) order by d.channel) as list
    from public.notification_deliveries d where d.event_id = ev.id and d.audience = 'client') sent on true
  -- A line about something that is no longer there (a client who was deleted) is left out.
  where (ev.aggregate_type <> 'booking' or b.id is not null)
    and (ev.aggregate_type <> 'gift_voucher' or g.id is not null)
    and (ev.aggregate_type <> 'client' or cl.id is not null)
    and (ev.aggregate_type <> 'waitlist' or w.id is not null)
    and (ev.aggregate_type <> 'series' or s.id is not null);
$$;
revoke all on function public.activity_rows(uuid, timestamptz, uuid, integer, text, boolean) from public, anon, authenticated;
