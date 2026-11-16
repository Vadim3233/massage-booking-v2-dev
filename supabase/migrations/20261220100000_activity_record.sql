-- VAD Massage Booking V2
-- Alerts as a record (Vadim, 16 Nov 2026). Rules page: https://claude.ai/artifact/GzkQJTGYtutmyDVvBcZexB
--
--   * The Alerts page becomes the record of what happened to bookings, clients and gift vouchers: what, when, and who did it (the client,
--     Vadim, or the app by itself). Things a client did that raised an alert keep the gold ring until read, as before; things Vadim did and
--     things the app did by itself are shown too, quieter. The red number on the Alerts button still counts unread alerts only.
--   * Every booking page gets a History section with the booking's whole story, oldest first.
--   * Nothing new has to be recorded for most of it: every change already writes an event (event_outbox) with who made it, from the very
--     first booking (18 Oct 2026). This file reads those events back. What was not recorded so far starts now: changes to a client's name,
--     email or phone, and notes added to a client. Vadim can add a short "why" to a move he makes (activity_notes).
--   * Read only by the Admin. Nobody can change or remove a line of the record from the app; when a client with no bookings is deleted, their
--     contact-change and note lines go with them (privacy), as their alerts already do.
--
-- Safe before the new screens are live: nothing changes for existing screens, and the new functions are only called by the new ones. If
-- the Alerts page loads before this file is applied, it falls back to the old list of alerts.
--
-- To take this back: drop the functions admin_activity_list, admin_booking_activity, admin_client_moves, admin_note_last_event,
-- activity_rows, activity_current_client, activity_actor, activity_money_types, activity_record_client_details, activity_record_client_note,
-- activity_forget_deleted_client, activity_forget_merged_client (with their triggers on clients, client_notes and client_merges) and the
-- table activity_notes.

-- ---------------------------------------------------------------------------------------------
-- 1. A short "why" Vadim can add to something he did (for now: a move)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.activity_notes (
  event_id uuid primary key references public.event_outbox(id) on delete cascade,
  note text not null constraint activity_notes_note_valid check (length(btrim(note)) between 1 and 300),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.activity_notes enable row level security;
revoke all on table public.activity_notes from public;
revoke all on table public.activity_notes from anon;
revoke all on table public.activity_notes from authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Who is making a change right now: the Admin, a client (signed in, or from a link in an email), or the app itself
-- ---------------------------------------------------------------------------------------------
create or replace function public.activity_actor()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '');
begin
  if auth.uid() is not null then
    return case when exists (select 1 from public.admin_users a where a.user_id = auth.uid()) then 'admin' else 'client' end;
  end if;
  return case when v_role = 'anon' then 'client' else 'system' end;
end; $$;
revoke all on function public.activity_actor() from public, anon, authenticated;

-- A client that was combined into another lives on as that one; its old lines follow it there.
create or replace function public.activity_current_client(p_client_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  with recursive chain(id, depth) as (
    select p_client_id, 0
    union all
    select m.kept_client_id, chain.depth + 1
    from chain join public.client_merges m on m.removed_client_id = chain.id
    where chain.depth < 10 and not exists (select 1 from public.clients c where c.id = chain.id)
  )
  select chain.id from chain where exists (select 1 from public.clients c where c.id = chain.id) order by depth limit 1;
$$;
revoke all on function public.activity_current_client(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Recorded from now on: a client's name, email or phone changed, and a note added
-- ---------------------------------------------------------------------------------------------
create or replace function public.activity_record_client_details()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_changes jsonb := '{}'::jsonb;
begin
  if btrim(concat_ws(' ', old.first_name, old.last_name)) is distinct from btrim(concat_ws(' ', new.first_name, new.last_name)) then
    v_changes := v_changes || jsonb_build_object('name', jsonb_build_object('from', btrim(concat_ws(' ', old.first_name, old.last_name)), 'to', btrim(concat_ws(' ', new.first_name, new.last_name))));
  end if;
  if old.phone is distinct from new.phone then
    v_changes := v_changes || jsonb_build_object('phone', jsonb_build_object('from', old.phone, 'to', new.phone));
  end if;
  if old.email is distinct from new.email then
    v_changes := v_changes || jsonb_build_object('email', jsonb_build_object('from', old.email, 'to', new.email));
  end if;
  if v_changes <> '{}'::jsonb then
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload)
    values ('client.details_changed', 'client', new.id,
      jsonb_build_object('client_id', new.id, 'actor_id', auth.uid(), 'actor_type', public.activity_actor(), 'changes', v_changes));
  end if;
  return null;
end; $$;
revoke all on function public.activity_record_client_details() from public, anon, authenticated;
drop trigger if exists clients_record_details_change on public.clients;
create trigger clients_record_details_change after update of first_name, last_name, email, phone on public.clients
  for each row execute function public.activity_record_client_details();

create or replace function public.activity_record_client_note()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, payload)
  values ('client.note_added', 'client', new.client_id,
    jsonb_build_object('client_id', new.client_id, 'note_id', new.id, 'actor_id', auth.uid(), 'actor_type', public.activity_actor()));
  return null;
end; $$;
revoke all on function public.activity_record_client_note() from public, anon, authenticated;
drop trigger if exists client_notes_record_added on public.client_notes;
create trigger client_notes_record_added after insert on public.client_notes
  for each row execute function public.activity_record_client_note();

-- A deleted client (only possible with no bookings) takes these lines with them. A client combined into another keeps them, under the other.
create or replace function public.activity_forget_deleted_client()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.client_merges m where m.removed_client_id = old.id) then
    delete from public.event_outbox e
    where e.aggregate_type = 'client' and e.aggregate_id = old.id and e.event_type in ('client.details_changed', 'client.note_added');
  end if;
  return null;
end; $$;
revoke all on function public.activity_forget_deleted_client() from public, anon, authenticated;
drop trigger if exists clients_forget_activity on public.clients;
create trigger clients_forget_activity after delete on public.clients
  for each row execute function public.activity_forget_deleted_client();

-- Profiles combined into a client are that person too: when deleting the client removes the combine history (the only time it is
-- removed), their lines go as well.
create or replace function public.activity_forget_merged_client()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.event_outbox e
  where e.aggregate_type = 'client' and e.aggregate_id = old.removed_client_id and e.event_type in ('client.details_changed', 'client.note_added');
  return null;
end; $$;
revoke all on function public.activity_forget_merged_client() from public, anon, authenticated;
drop trigger if exists client_merges_forget_activity on public.client_merges;
create trigger client_merges_forget_activity after delete on public.client_merges
  for each row execute function public.activity_forget_merged_client();

-- ---------------------------------------------------------------------------------------------
-- 4. The record, one row per thing that happened
-- ---------------------------------------------------------------------------------------------
-- Money things (the Money filter); everything else that is not a gift voucher is under Bookings.
create or replace function public.activity_money_types()
returns text[] language sql immutable set search_path = '' as $$
  select array['booking.transfer_declared', 'booking.cash_requested', 'booking.bank_transfer_received', 'booking.bank_transfer_verified',
    'booking.cash_approved', 'booking.cash_rejected', 'booking.cash_received', 'booking.refund_recorded', 'booking.late_fee_settled',
    'booking.balance_received', 'booking.extra_reported', 'booking.payment_method_changed', 'booking.receipt_issued', 'booking.receipt_emailed',
    'booking.receipt_edited', 'booking.next_payment_due', 'booking.extended', 'booking.extension_removed', 'booking.pay_after_requested'];
$$;
revoke all on function public.activity_money_types() from public, anon, authenticated;

-- p_booking_id: one booking's lines. p_before_at/p_before_id/p_limit/p_types: for the Alerts list, the page is cut from the events first
-- (newest first), so a page never reads the whole record. p_unread_only: only events with an unread alert.
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
        case when ev.cmd_actor = 'admin' or ev.event_type in ('gift.ready', 'gift.refund_sent') then 'admin'
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
    ev.payload,
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

-- ---------------------------------------------------------------------------------------------
-- 5. What the Admin screens read
-- ---------------------------------------------------------------------------------------------
-- The Alerts list, newest first, 50 at a time. Filters: all, new (unread alerts), bookings, money, gifts, mine (what Vadim did). A name
-- search looks at the client's (or gift buyer's) name. The next page starts after the last line shown (its time and id).
create or replace function public.admin_activity_list(p_filter text default 'all', p_search text default null,
  p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_search text := lower(nullif(btrim(coalesce(p_search, '')), ''));
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if not public.is_booking_admin() then
    raise exception 'Only the Admin can read the record.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.at desc, r.id desc)
    from (
      -- The page is cut from the events first, unless who did it or a name decides (By me, a search), which are worked out per line.
      select * from public.activity_rows(null, p_before_at, p_before_id,
        -- (a few more than asked, as a line about something since deleted is left out after the cut)
        case when v_search is null and coalesce(p_filter, 'all') <> 'mine' then v_limit + 20 end,
        case when p_filter in ('money', 'gifts', 'bookings') then p_filter else 'all' end, coalesce(p_filter, 'all') = 'new') a
      where (coalesce(p_filter, 'all') <> 'mine' or a.actor = 'admin')
        and (v_search is null or position(v_search in lower(coalesce(a.name, ''))) > 0)
      order by a.at desc, a.id desc
      limit v_limit
    ) r), '[]'::jsonb);
end; $$;
revoke all on function public.admin_activity_list(text, text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.admin_activity_list(text, text, timestamptz, uuid, integer) to authenticated;

-- One booking's whole story, oldest first.
create or replace function public.admin_booking_activity(p_booking_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_booking_admin() then
    raise exception 'Only the Admin can read the record.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.at, a.id) from public.activity_rows(p_booking_id) a), '[]'::jsonb);
end; $$;
revoke all on function public.admin_booking_activity(uuid) from public, anon;
grant execute on function public.admin_booking_activity(uuid) to authenticated;

-- "Moved 3 of their last 5 bookings": of the client's last 5 bookings, how many the client asked to move (moved by them, or by Vadim with
-- "The client asked", or a new day or time in a change they made themselves).
create or replace function public.admin_client_moves(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_of integer; v_moved integer;
begin
  if not public.is_booking_admin() then
    raise exception 'Only the Admin can read the record.' using errcode = '42501';
  end if;
  with recent as (
    select b.id from public.bookings b where b.client_id = p_client_id order by b.created_at desc limit 5
  )
  select count(*)::integer,
    count(*) filter (where exists (
      select 1 from public.event_outbox e left join public.command_requests cmd on cmd.id = e.source_command_id
      where e.aggregate_type = 'booking' and e.aggregate_id = recent.id
        and (e.event_type = 'booking.rescheduled' or (e.event_type = 'booking.services_changed'
          and (e.payload->>'from_date', e.payload->>'from_start_minutes') is distinct from (e.payload->>'to_date', e.payload->>'to_start_minutes')))
        and (e.payload->>'initiated_by' = 'client' or e.payload->>'source' = 'client' or cmd.actor_type = 'client')))::integer
  into v_of, v_moved from recent;
  return jsonb_build_object('moved', v_moved, 'of', v_of);
end; $$;
revoke all on function public.admin_client_moves(uuid) from public, anon;
grant execute on function public.admin_client_moves(uuid) to authenticated;

-- Vadim's "why" for something he just did to a booking (for now a move): added to his newest such line on that booking from the last
-- 10 minutes that has no note yet. Returns false if there is none (the move itself is already saved either way).
create or replace function public.admin_note_last_event(p_booking_id uuid, p_event_type text, p_note text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_event uuid; v_note text := btrim(coalesce(p_note, ''));
begin
  if not public.is_booking_admin() then
    raise exception 'Only the Admin can add a note.' using errcode = '42501';
  end if;
  if v_note = '' then return false; end if;
  if length(v_note) > 300 then
    raise exception 'Please keep the note under 300 characters.' using errcode = '22023';
  end if;
  if p_event_type not in ('booking.rescheduled') then
    raise exception 'A note can only be added to a move.' using errcode = '22023';
  end if;
  select e.id into v_event
  from public.event_outbox e
  left join public.command_requests cmd on cmd.id = e.source_command_id
  where e.aggregate_type = 'booking' and e.aggregate_id = p_booking_id and e.event_type = p_event_type
    and e.created_at > clock_timestamp() - interval '10 minutes'
    and (cmd.actor_id = auth.uid()::text or e.payload->>'actor_id' = auth.uid()::text)
    and not exists (select 1 from public.activity_notes n where n.event_id = e.id)
  order by e.created_at desc, e.id desc limit 1;
  if v_event is null then return false; end if;
  insert into public.activity_notes(event_id, note, created_by) values (v_event, v_note, auth.uid());
  return true;
end; $$;
revoke all on function public.admin_note_last_event(uuid, text, text) from public, anon;
grant execute on function public.admin_note_last_event(uuid, text, text) to authenticated;
