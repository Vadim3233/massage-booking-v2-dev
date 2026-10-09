-- VAD Massage Booking V2
-- Alerts: in-app, Telegram and email, created from committed booking events.
--
-- The database writes every message (title, text and a link to the exact record) the moment an event
-- is committed, so the wording lives in one tested place and the in-app list never depends on an
-- outside service. A small sender (api/dispatch-notifications.js) delivers the Telegram and email rows
-- and records the result; failed rows are retried with a growing delay.
--
-- Alerts to the Admin: a new online booking, "I've paid", a cash request, and client cancellations and
-- moves. Emails to clients: confirmed, cancelled, moved, and refund sent. Nothing is sent for changes the
-- Admin makes herself, except the client's own email about them.

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event_outbox(id) on delete cascade,
  channel text not null,
  audience text not null,
  recipient text not null,
  title text not null,
  body text not null,
  link_path text,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_channel_valid check (channel in ('in_app', 'telegram', 'email')),
  constraint notification_deliveries_audience_valid check (audience in ('admin', 'client')),
  constraint notification_deliveries_status_valid check (status in ('pending', 'sending', 'sent', 'failed')),
  constraint notification_deliveries_in_app_admin check (channel <> 'in_app' or audience = 'admin'),
  constraint notification_deliveries_sent_consistent check ((status = 'sent') = (sent_at is not null)),
  constraint notification_deliveries_unique unique (event_id, channel, recipient)
);
create index notification_deliveries_queue_idx on public.notification_deliveries (status, next_attempt_at) where status in ('pending', 'sending', 'failed');
create index notification_deliveries_admin_inbox_idx on public.notification_deliveries (created_at desc) where channel = 'in_app';
create trigger notification_deliveries_set_updated_at before update on public.notification_deliveries
  for each row execute function public.set_updated_at();

alter table public.notification_deliveries enable row level security;
create policy "admins can read in-app notifications" on public.notification_deliveries
  for select to authenticated using (channel = 'in_app' and public.is_booking_admin());
revoke all on table public.notification_deliveries from public;
revoke all on table public.notification_deliveries from anon;
revoke all on table public.notification_deliveries from authenticated;
grant select on table public.notification_deliveries to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Writing the messages
-- ---------------------------------------------------------------------------------------------
create function public.notification_when(p_date date, p_start_minutes integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(p_date, 'FMDy FMDD FMMon') || ' at ' || lpad((p_start_minutes / 60)::text, 2, '0') || ':' || lpad((p_start_minutes % 60)::text, 2, '0');
$$;

create function public.notification_money(p_amount numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select '£' || to_char(p_amount, 'FM999990.00');
$$;

create function public.plan_event_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_name text;
  v_email text;
  v_when text;
  v_total text;
  v_initiated text := new.payload->>'initiated_by';
  v_source text := new.payload->>'source';
  v_admin_title text;
  v_admin_body text;
  v_client_title text;
  v_client_body text;
  v_fee numeric := coalesce((new.payload->>'late_fee_due_gbp')::numeric, 0);
  v_refund numeric := coalesce((new.payload->>'refund_due_gbp')::numeric, 0);
  v_admin_link text;
  v_client_link text;
  v_where text;
  v_sign text := E'\n\nWarm wishes,\nVad';
begin
  if new.aggregate_type <> 'booking' then return null; end if;
  select * into b from public.bookings where id = new.aggregate_id;
  if not found then return null; end if;
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
  v_name := coalesce(nullif(v_name, ''), 'A client');
  v_email := nullif(btrim(b.booking_email_snapshot), '');
  v_when := public.notification_when(b.date, b.start_minutes);
  v_total := public.notification_money(b.total_gbp);
  v_admin_link := '/admin/bookings/' || b.id::text;
  v_client_link := '/account?booking=' || b.id::text;
  v_where := concat_ws(', ', b.address_line_1_snapshot, b.city_snapshot, b.postcode_snapshot);

  case new.event_type
    when 'booking.created' then
      if new.payload ? 'actor_id' then
        v_client_title := 'Your appointment is booked';
        v_client_body := format('Your appointment is confirmed for %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference);
      else
        v_admin_title := 'New booking request';
        v_admin_body := format('%s: %s, %s minutes, %s. Waiting for payment.', v_name, v_when, b.treatment_duration_minutes, v_total);
      end if;
    when 'booking.transfer_declared' then
      v_admin_title := format('%s says the transfer is made', v_name);
      v_admin_body := format('%s for %s. Check your bank, then verify the payment.', v_total, v_when);
    when 'booking.cash_requested' then
      v_admin_title := format('%s would like to pay cash', v_name);
      v_admin_body := format('%s for %s. Approve the request when you are happy to.', v_total, v_when);
    when 'booking.cancelled' then
      if v_source = 'client' then
        v_admin_title := format('%s cancelled', v_name);
        v_admin_body := format('%s (%s).', v_when, v_total) ||
          case when v_fee > 0 then format(' Late fee of %s recorded as due.', public.notification_money(v_fee)) else ' No late fee.' end ||
          case when v_refund > 0 then format(' Refund of %s to send.', public.notification_money(v_refund)) else '' end;
      end if;
      if v_initiated = 'client' then
        v_client_title := 'Your appointment is cancelled';
        v_client_body := format('I have cancelled your appointment for %s as you asked.', v_when) ||
          case when v_fee > 0 then format(E'\n\nBecause this was inside 24 hours, a late fee of %s applies. I will be in touch about it.', public.notification_money(v_fee)) else '' end ||
          case when v_refund > 0 then format(E'\n\nA refund of %s is on its way to you.', public.notification_money(v_refund)) else '' end;
      else
        v_client_title := 'Your appointment has been cancelled';
        v_client_body := format('I am sorry, I have had to cancel your appointment for %s. Please get in touch if you would like to find another time.', v_when) ||
          case when v_refund > 0 then format(E'\n\nA refund of %s is on its way to you.', public.notification_money(v_refund)) else '' end;
      end if;
    when 'booking.pending_removed', 'booking.cash_rejected' then
      v_client_title := 'Your appointment request has been cancelled';
      v_client_body := format('I have not been able to confirm your appointment request for %s. If you think this is a mistake, or you would like to find another time, please get in touch.', v_when);
    when 'booking.rescheduled' then
      if v_source = 'client' then
        v_admin_title := format('%s moved their appointment', v_name);
        v_admin_body := format('From %s to %s (%s).', public.notification_when((new.payload->>'from_date')::date, (new.payload->>'from_start_minutes')::integer), v_when, v_total) ||
          case when v_fee > 0 then format(' Late fee of %s recorded as due.', public.notification_money(v_fee)) else '' end;
      end if;
      v_client_title := 'Your appointment has moved';
      v_client_body := format('Your appointment is now on %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference) ||
        case when v_initiated = 'client' and v_fee > 0 then format(E'\n\nBecause this change was inside 24 hours, a late fee of %s applies. I will be in touch about it.', public.notification_money(v_fee)) else '' end;
    when 'booking.bank_transfer_verified', 'booking.cash_approved' then
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Thank you. Your appointment is confirmed for %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference) ||
        case when new.event_type = 'booking.cash_approved' then E'\n\nPlease pay the full amount in cash at your appointment.' else E'\n\nI have received your payment.' end;
    when 'booking.refund_recorded' then
      v_client_title := 'Your refund has been sent';
      v_client_body := format('I have sent your refund of %s for the appointment on %s.', public.notification_money((new.payload->>'refunded_gbp')::numeric), v_when);
    else
      null;
  end case;

  if v_admin_title is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (new.id, 'in_app', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'telegram', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link),
           (new.id, 'email', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link);
  end if;
  if v_client_title is not null and v_email is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'email', 'client', v_email, v_client_title, v_client_body || E'\n\nSee or change your booking: {link}' || v_sign, v_client_link);
  end if;
  return null;
end;
$$;
create trigger event_outbox_plan_notifications after insert on public.event_outbox
  for each row execute function public.plan_event_notifications();

revoke all on function public.notification_when(date, integer) from public, anon, authenticated;
revoke all on function public.notification_money(numeric) from public, anon, authenticated;
revoke all on function public.plan_event_notifications() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The Admin's in-app list
-- ---------------------------------------------------------------------------------------------
create function public.admin_list_notifications(p_limit integer default 50)
returns table(id uuid, title text, body text, link_path text, created_at timestamptz, read_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return query select d.id, d.title, d.body, d.link_path, d.created_at, d.read_at
    from public.notification_deliveries d where d.channel = 'in_app'
    order by d.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

create function public.admin_unread_notification_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return (select count(*)::integer from public.notification_deliveries d where d.channel = 'in_app' and d.read_at is null);
end;
$$;

create function public.admin_mark_notifications_read(p_ids uuid[] default null)
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
  update public.notification_deliveries set read_at = clock_timestamp()
    where channel = 'in_app' and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.admin_list_notifications(integer) from public, anon;
revoke all on function public.admin_unread_notification_count() from public, anon;
revoke all on function public.admin_mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.admin_list_notifications(integer) to authenticated;
grant execute on function public.admin_unread_notification_count() to authenticated;
grant execute on function public.admin_mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The sender's queue (service role only). A row is claimed, sent, then completed; a row left
-- 'sending' for ten minutes is picked up again. Failures retry after 2, 8, 18 and 32 minutes,
-- then stop after five attempts and stay visible as failed.
-- ---------------------------------------------------------------------------------------------
create function public.claim_notification_deliveries(p_limit integer, p_channels text[])
returns setof public.notification_deliveries
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select d.id from public.notification_deliveries d
    where d.channel = any(p_channels) and d.channel <> 'in_app' and d.attempt_count < 5
      and ((d.status in ('pending', 'failed') and d.next_attempt_at <= clock_timestamp())
        or (d.status = 'sending' and d.updated_at < clock_timestamp() - interval '10 minutes'))
    order by d.created_at
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
    for update skip locked
  )
  update public.notification_deliveries d set status = 'sending', attempt_count = d.attempt_count + 1
  from picked where d.id = picked.id
  returning d.*;
$$;

create function public.complete_notification_delivery(p_id uuid, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notification_deliveries set
    status = case when p_ok then 'sent' else 'failed' end,
    sent_at = case when p_ok then clock_timestamp() else null end,
    last_error = case when p_ok then null else left(coalesce(p_error, 'Unknown error'), 500) end,
    next_attempt_at = case when p_ok then next_attempt_at else clock_timestamp() + make_interval(mins => 2 * attempt_count * attempt_count) end
  where id = p_id and status = 'sending';
$$;

revoke all on function public.claim_notification_deliveries(integer, text[]) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer, text[]) to service_role;
grant execute on function public.complete_notification_delivery(uuid, boolean, text) to service_role;
