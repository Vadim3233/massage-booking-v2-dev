-- VAD Massage Booking V2
-- Asking clients for a Google review (Vadim, 12 Nov 2026).
--
-- After a session that is over and paid, the booking shows "Ask for a Google review": WhatsApp the client, copy the message, or just mark them
-- as asked. Each client is asked once: who was asked, when and how is kept in client_review_requests, so the card turns into
-- "Review asked · 12 Nov" on every booking of theirs and the automatic message (below) never goes to them.
--
-- The settings (More › Google reviews), kept in business_settings like the share message:
--   google_review_link  the link from Google Business › Get more reviews (https only). Set here to Vadim's link to start with.
--   review_message      his own wording, with the blanks {name} and {link}; none means the standard wording (in the app and below).
--   review_auto         true: the sender asks by itself, by email (and Telegram, where the client turned it on), from 11:00 London time two days
--                       after a paid session. Off to start with.
--
-- The automatic message (plan_review_requests, run by the sender like the morning reminders) goes to a client when:
--   * the switch is on and a review link is saved;
--   * one of their bookings is confirmed or completed, paid, and was two to fourteen days ago (London dates), and it is 11:00 or later;
--     the fourteen days stop a client from long ago being asked when the switch is first turned on;
--   * they have never been asked (client_review_requests), by hand or automatically.
-- Recording them as asked comes first and only one row a client can exist, so running the sender twice, or at once, never asks twice.

-- ---------------------------------------------------------------------------------------------
-- 1. Who was asked
-- ---------------------------------------------------------------------------------------------
create table public.client_review_requests (
  client_id uuid primary key references public.clients(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  asked_at timestamptz not null default clock_timestamp(),
  channel text not null constraint client_review_requests_channel_valid check (channel in ('whatsapp', 'copy', 'marked', 'automatic')),
  asked_by uuid references auth.users(id) on delete set null
);
alter table public.client_review_requests enable row level security;
create policy "admins can read review requests" on public.client_review_requests
  for select to authenticated using (public.is_booking_admin());
revoke all on table public.client_review_requests from public, anon, authenticated;
grant select on table public.client_review_requests to authenticated;
grant select, insert, update, delete on table public.client_review_requests to service_role;

-- Combining two profiles of the same person deletes the one that goes. Just before, its "review asked" moves to the one that stays (unless that
-- one was asked too), the way its Telegram chats do (keep_telegram_links_on_merge), so the person is still never asked twice.
create function public.keep_review_request_on_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kept uuid;
begin
  select m.kept_client_id into v_kept from public.client_merges m where m.removed_client_id = old.id order by m.merged_at desc limit 1;
  if v_kept is not null and exists (select 1 from public.clients c where c.id = v_kept) then
    insert into public.client_review_requests (client_id, booking_id, asked_at, channel, asked_by)
    select v_kept, r.booking_id, r.asked_at, r.channel, r.asked_by from public.client_review_requests r where r.client_id = old.id
    on conflict (client_id) do nothing;
  end if;
  return old;
end;
$$;
revoke all on function public.keep_review_request_on_merge() from public, anon, authenticated;
create trigger clients_keep_review_request
  before delete on public.clients
  for each row execute function public.keep_review_request_on_merge();

-- ---------------------------------------------------------------------------------------------
-- 2. The standard wording, the same as STANDARD_REVIEW_MESSAGE in src/admin/reviewInvite.js
-- ---------------------------------------------------------------------------------------------
create function public.standard_review_message()
returns text
language sql
immutable
set search_path = ''
as $$
  select E'Hi {name}! I hope you enjoyed our last session and you''re still feeling the benefit of it. If you have a minute, a short Google review would mean a lot to me. It really helps other people find me:\n{link}\n\nWarm wishes,\nVadim'
$$;
revoke all on function public.standard_review_message() from public, anon;
grant execute on function public.standard_review_message() to authenticated, service_role;

-- The message for one client: {name} is the first name, left out with the space before it when none is saved ("Hi!"); {link} the review link.
create function public.review_message_for(p_first_name text, p_link text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_text text := coalesce((select nullif(btrim(value #>> '{}'), '') from public.business_settings where key = 'review_message'), public.standard_review_message());
  v_name text := nullif(btrim(p_first_name), '');
begin
  v_text := case when v_name is null then regexp_replace(v_text, ' ?\{name\}', '', 'g') else replace(v_text, '{name}', v_name) end;
  return btrim(replace(v_text, '{link}', coalesce(p_link, '')));
end;
$$;
revoke all on function public.review_message_for(text, text) from public, anon, authenticated;
grant execute on function public.review_message_for(text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Saving the settings (Admin only)
-- ---------------------------------------------------------------------------------------------
create function public.admin_save_review_settings(p_link text, p_message text, p_auto boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link text := nullif(btrim(p_link), '');
  v_text text := nullif(btrim(p_message), '');
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if v_link is not null and (v_link !~ '^https://[^\s<>"]+$' or length(v_link) > 300) then
    raise exception 'The review link must start with https:// and have no spaces' using errcode = '22023';
  end if;
  if coalesce(p_auto, false) and v_link is null then
    raise exception 'Add your review link before asking automatically' using errcode = '22023';
  end if;
  if length(coalesce(v_text, '')) > 1000 then raise exception 'The review message can be up to 1000 characters' using errcode = '22023'; end if;
  if regexp_replace(coalesce(v_text, ''), '\{(name|link)\}', '', 'g') ~ '[{}]' then
    raise exception 'Only the blanks listed can be used, each in curly brackets' using errcode = '22023';
  end if;
  if v_text is not null and position('{link}' in v_text) = 0 then
    raise exception 'The message needs the {link} blank, so clients can find your review page' using errcode = '22023';
  end if;
  if v_text = public.standard_review_message() then v_text := null; end if;

  if v_link is null then delete from public.business_settings where key = 'google_review_link';
  else insert into public.business_settings (key, value, updated_by) values ('google_review_link', to_jsonb(v_link), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by; end if;
  if v_text is null then delete from public.business_settings where key = 'review_message';
  else insert into public.business_settings (key, value, updated_by) values ('review_message', to_jsonb(v_text), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by; end if;
  insert into public.business_settings (key, value, updated_by) values ('review_auto', to_jsonb(coalesce(p_auto, false)), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;
revoke all on function public.admin_save_review_settings(text, text, boolean) from public, anon;
grant execute on function public.admin_save_review_settings(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Marking a client as asked, or not asked after all (Admin only)
-- ---------------------------------------------------------------------------------------------
create function public.admin_mark_review_asked(p_booking_id uuid, p_channel text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
  v_at timestamptz;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'copy', 'marked') then raise exception 'Unknown way of asking' using errcode = '22023'; end if;
  select client_id into v_client from public.bookings where id = p_booking_id;
  if v_client is null then raise exception 'Booking not found' using errcode = 'P0002'; end if;
  insert into public.client_review_requests (client_id, booking_id, channel, asked_by)
  values (v_client, p_booking_id, p_channel, auth.uid())
  on conflict (client_id) do update set booking_id = excluded.booking_id, channel = excluded.channel, asked_by = excluded.asked_by, asked_at = clock_timestamp()
  returning asked_at into v_at;
  return v_at;
end;
$$;
revoke all on function public.admin_mark_review_asked(uuid, text) from public, anon;
grant execute on function public.admin_mark_review_asked(uuid, text) to authenticated;

create function public.admin_clear_review_asked(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  delete from public.client_review_requests where client_id = p_client_id;
end;
$$;
revoke all on function public.admin_clear_review_asked(uuid) from public, anon;
grant execute on function public.admin_clear_review_asked(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. The automatic message, planned by the sender on each run
-- ---------------------------------------------------------------------------------------------
create function public.plan_review_requests(p_now timestamptz default clock_timestamp())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'Europe/London';
  v_today date := v_local::date;
  v_minutes integer := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  v_link text := (select nullif(btrim(value #>> '{}'), '') from public.business_settings where key = 'google_review_link');
  v_auto boolean := coalesce((select (value #>> '{}')::boolean from public.business_settings where key = 'review_auto'), false);
  b record;
  v_event uuid;
  v_body text;
  v_made integer := 0;
begin
  if not v_auto or v_link is null or v_minutes < 660 then return 0; end if;
  for b in
    select distinct on (bk.client_id) bk.id, bk.client_id, coalesce(nullif(btrim(bk.booking_email_snapshot), ''), nullif(btrim(c.email), '')) as email,
           nullif(btrim(c.first_name), '') as first_name
      from public.bookings bk
      join public.clients c on c.id = bk.client_id
      join public.booking_payments p on p.booking_id = bk.id
     where bk.booking_status in ('confirmed', 'completed')
       and p.status = 'paid'
       and bk.date between v_today - 14 and v_today - 2
       and not exists (select 1 from public.client_review_requests r where r.client_id = bk.client_id)
     order by bk.client_id, bk.date desc, bk.start_minutes desc
  loop
    -- Nowhere to send it: they are left for the Admin to ask by hand.
    if b.email is null and not exists (select 1 from public.client_telegram_links l where l.client_id = b.client_id and l.stopped_at is null) then
      continue;
    end if;
    insert into public.client_review_requests (client_id, booking_id, channel) values (b.client_id, b.id, 'automatic')
    on conflict (client_id) do nothing;
    if not found then continue; end if;
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('booking.review_request', 'booking', b.id, 'booking.review_request:' || b.client_id::text, jsonb_build_object('client_id', b.client_id))
    on conflict (deduplication_key) do nothing
    returning id into v_event;
    if v_event is null then continue; end if;
    v_body := public.review_message_for(b.first_name, v_link);
    if b.email is not null then
      insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
      values (v_event, 'email', 'client', b.email, 'How was your massage?', v_body);
    end if;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
    select v_event, 'telegram_client', 'client', l.chat_id::text, 'How was your massage?', v_body
      from public.client_telegram_links l
     where l.client_id = b.client_id and l.stopped_at is null
    on conflict (event_id, channel, recipient) do nothing;
    v_made := v_made + 1;
  end loop;
  return v_made;
end;
$$;
revoke all on function public.plan_review_requests(timestamptz) from public, anon, authenticated;
grant execute on function public.plan_review_requests(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Vadim's review link to start with (he can change it in More › Google reviews)
-- ---------------------------------------------------------------------------------------------
insert into public.business_settings (key, value) values ('google_review_link', to_jsonb('https://g.page/r/CU-Ccr2ldxfKEBM/review'::text))
on conflict (key) do nothing;
