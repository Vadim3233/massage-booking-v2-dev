-- VAD Massage Booking V2
-- Telegram updates for clients.
--
-- A client can ask for their booking updates on Telegram. A box on their confirmation page opens the clients-only bot with a one-time
-- code; pressing Start in Telegram links that chat to the client. From then on every email the app sends that client about a booking
-- (confirmed, payment received, moved, cancelled, refund sent) is also sent to that chat, in the same words. /stop in the chat ends it, and
-- drops whatever was still waiting to be sent to it. Nothing is sent to a client who has not linked a chat, and only what the app already
-- emails is copied, so an appointment that sends no email sends nothing there either.
--
-- How it is kept safe:
--  * A code is random, single use, lasts two hours, and only its hash is kept. It is shown only to the signed-in (or guest) client it is for.
--    When a chat is linked, that client's other unused codes stop working too.
--  * Only the Telegram webhook (with the service key, after checking Telegram's secret) can link or stop a chat.
--  * The client bot's messages go out on their own channel, 'telegram_client', so they can never be sent to the Admin's chat.
--  * Chats are linked by Telegram's chat number only: no name or username is kept.
--  * Combining two client profiles (the "same person" step) moves a linked chat to the profile that stays, so the client keeps their updates.

-- ---------------------------------------------------------------------------------------------
-- 1. The client messages get a channel of their own
-- ---------------------------------------------------------------------------------------------
alter table public.notification_deliveries drop constraint notification_deliveries_channel_valid;
alter table public.notification_deliveries add constraint notification_deliveries_channel_valid
  check (channel in ('in_app', 'telegram', 'email', 'telegram_client'));
alter table public.notification_deliveries add constraint notification_deliveries_telegram_client_audience
  check (channel <> 'telegram_client' or audience = 'client');

-- ---------------------------------------------------------------------------------------------
-- 2. The one-time codes and the linked chats
-- ---------------------------------------------------------------------------------------------
create table public.client_telegram_tokens (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index client_telegram_tokens_client_idx on public.client_telegram_tokens (client_id, created_at);
alter table public.client_telegram_tokens enable row level security;
revoke all on table public.client_telegram_tokens from public;
revoke all on table public.client_telegram_tokens from anon;
revoke all on table public.client_telegram_tokens from authenticated;

create table public.client_telegram_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  chat_id bigint not null,
  linked_at timestamptz not null default clock_timestamp(),
  stopped_at timestamptz,
  constraint client_telegram_links_unique unique (client_id, chat_id)
);
create index client_telegram_links_active_idx on public.client_telegram_links (client_id) where stopped_at is null;
create index client_telegram_links_chat_idx on public.client_telegram_links (chat_id) where stopped_at is null;
alter table public.client_telegram_links enable row level security;
revoke all on table public.client_telegram_links from public;
revoke all on table public.client_telegram_links from anon;
revoke all on table public.client_telegram_links from authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. What a client (or a guest) can ask for: a code, and whether they are linked
-- ---------------------------------------------------------------------------------------------
create function public.create_my_telegram_link()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
  v_token text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select c.id into v_client from public.clients c where c.auth_user_id = auth.uid();
  if v_client is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- Not a flood of codes: ten an hour is more than anyone needs.
  if (select count(*) from public.client_telegram_tokens t where t.client_id = v_client and t.created_at > clock_timestamp() - interval '1 hour') >= 10 then
    raise exception 'Please wait a little before asking again.' using errcode = 'PT429';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.client_telegram_tokens(client_id, token_hash, expires_at)
  values (v_client, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), clock_timestamp() + interval '2 hours');
  -- Old codes are tidied away whenever a new one is made.
  delete from public.client_telegram_tokens t where t.expires_at < clock_timestamp() - interval '1 day';
  return v_token;
end;
$$;

create function public.my_telegram_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select c.id into v_client from public.clients c where c.auth_user_id = auth.uid();
  if v_client is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return jsonb_build_object('linked', exists (select 1 from public.client_telegram_links l where l.client_id = v_client and l.stopped_at is null));
end;
$$;

revoke all on function public.create_my_telegram_link() from public, anon;
revoke all on function public.my_telegram_status() from public, anon;
grant execute on function public.create_my_telegram_link() to authenticated;
grant execute on function public.my_telegram_status() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. What the Telegram webhook does (the service key only)
-- ---------------------------------------------------------------------------------------------
-- Pressing Start with a code links the chat. The answer says which of four things happened, so the bot can reply kindly; asking again after
-- it worked says "linked" again (a retry from Telegram must not turn a success into "already used"). A "linked" answer carries the client's
-- first name (shortened, on one line), so the bot can say whose appointments the chat is now connected to: someone who was sent a link that
-- is not theirs sees a name that is not theirs, and can answer /stop.
create function public.link_client_telegram(p_token text, p_chat_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token public.client_telegram_tokens%rowtype;
  v_name text;
begin
  if p_chat_id is null or p_token is null or length(p_token) not between 16 and 128 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_token from public.client_telegram_tokens t where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select nullif(left(btrim(regexp_replace(c.first_name, '\s+', ' ', 'g')), 40), '') into v_name from public.clients c where c.id = v_token.client_id;
  if v_token.used_at is not null then
    if exists (select 1 from public.client_telegram_links l where l.client_id = v_token.client_id and l.chat_id = p_chat_id and l.stopped_at is null) then
      return jsonb_build_object('status', 'linked', 'first_name', v_name);
    end if;
    return jsonb_build_object('status', 'used');
  end if;
  if v_token.expires_at <= clock_timestamp() then return jsonb_build_object('status', 'expired'); end if;
  -- This code, and any other the client has not used, is spent: a chat is linked once, and an old code left in a message cannot link another.
  update public.client_telegram_tokens set used_at = clock_timestamp() where client_id = v_token.client_id and used_at is null;
  insert into public.client_telegram_links(client_id, chat_id) values (v_token.client_id, p_chat_id)
  on conflict (client_id, chat_id) do update set stopped_at = null, linked_at = clock_timestamp();
  return jsonb_build_object('status', 'linked', 'first_name', v_name);
end;
$$;

-- /stop (or a chat that has blocked the bot) ends every link of that chat, and drops what is still waiting to be sent to it (stop means stop,
-- not "after the ones already queued"; a message being handed to Telegram at that very moment cannot be called back). It answers how many
-- links it ended.
create function public.stop_client_telegram(p_chat_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.client_telegram_links set stopped_at = clock_timestamp() where chat_id = p_chat_id and stopped_at is null;
  get diagnostics v_count = row_count;
  update public.notification_deliveries d
     set status = 'failed', attempt_count = 5, last_error = 'This chat has stopped Telegram updates', next_attempt_at = clock_timestamp()
   where d.channel = 'telegram_client' and d.recipient = p_chat_id::text and d.status in ('pending', 'failed') and d.attempt_count < 5;
  return v_count;
end;
$$;

revoke all on function public.link_client_telegram(text, bigint) from public, anon, authenticated;
revoke all on function public.stop_client_telegram(bigint) from public, anon, authenticated;
grant execute on function public.link_client_telegram(text, bigint) to service_role;
grant execute on function public.stop_client_telegram(bigint) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Every client email about a booking is also sent to the client's linked chats, in the same words
-- ---------------------------------------------------------------------------------------------
-- The email is already written by the planner (and is not written at all where the app sends no email), so this only copies it: without the
-- line that points to the booking page (a Telegram message cannot carry a private link safely) and the sign-off, and, where it helps (a
-- booking that is made, confirmed or moved), with a closing line saying where to change or cancel. Receipts and repeat reminders are not
-- copied. It does not touch the planner.
create function public.mirror_client_email_to_telegram()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text;
  v_booking uuid;
  v_client uuid;
  v_body text;
begin
  select e.event_type, e.aggregate_id into v_event, v_booking
  from public.event_outbox e where e.id = new.event_id and e.aggregate_type = 'booking';
  if v_event is null or v_event not in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.rescheduled',
    'booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected', 'booking.refund_recorded') then
    return null;
  end if;
  select b.client_id into v_client from public.bookings b where b.id = v_booking;
  if v_client is null then return null; end if;
  v_body := replace(replace(new.body, E'\n\nSee or change your booking: {link}', ''), E'\n\nWarm wishes,\nVad', '')
    || case when v_event in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.rescheduled')
         then E'\n\nTo change or cancel, use the link in your email, or contact Vad.' else '' end;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
  select new.event_id, 'telegram_client', 'client', l.chat_id::text, new.title, v_body
  from public.client_telegram_links l
  where l.client_id = v_client and l.stopped_at is null
  on conflict (event_id, channel, recipient) do nothing;
  return null;
end;
$$;
revoke all on function public.mirror_client_email_to_telegram() from public, anon, authenticated;

create trigger notification_deliveries_mirror_client_telegram
  after insert on public.notification_deliveries
  for each row when (new.audience = 'client' and new.channel = 'email')
  execute function public.mirror_client_email_to_telegram();

-- ---------------------------------------------------------------------------------------------
-- 6. Combining two client profiles keeps the Telegram updates
-- ---------------------------------------------------------------------------------------------
-- The "same person" step moves everything of the profile that goes to the one that stays and then deletes the profile it emptied, which would
-- take its linked chats with it (a guest who linked Telegram and later registered would silently stop getting updates). Just before that
-- delete, the chats move across. The merge writes its record before the delete, so this finds which profile stays; a client who is deleted
-- any other way has no such record, and their chats go with them. A chat the staying profile already has is not added twice (and is switched
-- back on if the profile that went had it on).
create function public.keep_telegram_links_on_merge()
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
    insert into public.client_telegram_links(client_id, chat_id, linked_at, stopped_at)
    select v_kept, l.chat_id, l.linked_at, l.stopped_at from public.client_telegram_links l where l.client_id = old.id
    on conflict (client_id, chat_id) do update
      set stopped_at = case when excluded.stopped_at is null then null else public.client_telegram_links.stopped_at end;
  end if;
  return old;
end;
$$;
revoke all on function public.keep_telegram_links_on_merge() from public, anon, authenticated;

create trigger clients_keep_telegram_links
  before delete on public.clients
  for each row execute function public.keep_telegram_links_on_merge();
