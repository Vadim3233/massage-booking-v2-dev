-- VAD Massage Booking V2
-- Family alerts on Telegram.
--
-- The owner's family (his wife) can get a short Telegram message when a booking is confirmed, moved or cancelled, so she knows when he is
-- working and roughly when he will be home. The message has the day and the times only: never the client's name, address, phone, price or
-- notes. It comes from the clients' Telegram bot, so nothing new has to be set up in Telegram.
--
-- How she connects: in More › Family alerts the Admin makes a one-time link and sends it to her. She taps it and presses Start; the bot's
-- webhook (link_family_telegram) links her chat. /stop in the chat ends it, and the Admin can switch a chat off from the same page.
--
-- What she is told, and when:
--  * "Nueva reserva" (new booking) when a booking becomes confirmed (requests still waiting for payment or for the owner are not sent).
--  * "Reserva cambiada de hora" (moved) when a confirmed booking's day or start time changes, "Reserva cambiada" (changed) when only its length does.
--  * "Reserva cancelada" (cancelled) when a confirmed booking is cancelled (or removed).
--  * Only for bookings still to come: nothing about the past, so entering an old booking or marking one done says nothing.
-- Each message is in Spanish, says when he is likely home that day (the end of that day's last confirmed booking plus its travel time), and
-- ends with one of his love lines, picked at random.
--
-- How it is worked out: a trigger on bookings compares each booking with what she was last told (family_booking_told) and writes a message
-- only when it differs. The trigger runs when the change is saved (at commit), so a change made in several steps sends one message, with
-- the final times. It can never stop a booking being saved: if it fails, a warning is logged and nothing is sent. What she was told is kept
-- whether or not a chat is linked, so a chat linked later hears "moved", not "new", about a booking that was already there.
--
-- How it is kept safe:
--  * Only a signed-in Admin can make a link, see the linked chats or switch one off.
--  * A link is random, single use, lasts 24 hours, and only its hash is kept. Ten an hour at most.
--  * Only the Telegram webhook (with the service key, after checking Telegram's secret) can link or stop a chat, and only the sender can
--    read the messages. Chats are kept by Telegram's chat number only: no name or username.
--  * Family messages have a queue of their own (family_telegram_messages), apart from the client and Admin messages.

-- ---------------------------------------------------------------------------------------------
-- 1. The tables
-- ---------------------------------------------------------------------------------------------
create table public.family_telegram_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.family_telegram_chats (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null constraint family_telegram_chats_chat_unique unique,
  linked_at timestamptz not null default clock_timestamp(),
  stopped_at timestamptz
);

-- What the family was last told about each booking. No foreign key on purpose: a booking deleted outright must still be found here, so
-- its cancellation can be sent.
create table public.family_booking_told (
  booking_id uuid primary key,
  date date not null,
  start_minutes integer not null,
  end_minutes integer not null,
  told_at timestamptz not null default clock_timestamp()
);

create table public.family_telegram_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  body text not null,
  status text not null default 'pending'
    constraint family_telegram_messages_status_valid check (status in ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint family_telegram_messages_sent_consistent check ((status = 'sent') = (sent_at is not null))
);
create index family_telegram_messages_queue_idx on public.family_telegram_messages (status, next_attempt_at) where status in ('pending', 'sending', 'failed');

alter table public.family_telegram_tokens enable row level security;
alter table public.family_telegram_chats enable row level security;
alter table public.family_booking_told enable row level security;
alter table public.family_telegram_messages enable row level security;
revoke all on table public.family_telegram_tokens, public.family_telegram_chats, public.family_booking_told, public.family_telegram_messages
  from public, anon, authenticated;
grant select, insert, update, delete on table public.family_telegram_tokens, public.family_telegram_chats, public.family_booking_told,
  public.family_telegram_messages to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Writing the messages
-- ---------------------------------------------------------------------------------------------
-- The messages are in Spanish: "jue 14 nov, de 14:00 a 15:30".
create function public.family_alert_clock(p_minutes integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select lpad((p_minutes / 60)::text, 2, '0') || ':' || lpad((p_minutes % 60)::text, 2, '0');
$$;

create function public.family_alert_when(p_date date, p_start integer, p_end integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select (array['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'])[extract(dow from p_date)::integer + 1] || ' '
    || extract(day from p_date)::integer || ' '
    || (array['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'])[extract(month from p_date)::integer]
    || ', de ' || public.family_alert_clock(p_start) || ' a ' || public.family_alert_clock(p_end);
$$;

-- Every message ends with one of the owner's own love lines, picked at random (his words, 11 Nov 2026). To add one, add it to this list.
create function public.family_alert_love_line()
returns text
language sql
volatile
set search_path = ''
as $$
  select l[1 + floor(random() * array_length(l, 1))::integer]
  from (select array[
    'Te amo con todo mi culo. Diría corazón, pero mi culo es más grande. 🍑❤️',
    'Eres la única persona con la que compartiría mis papitas... y por compartir me refiero a darte una. 🥔🍟',
    'Te quiero tanto que soporto que tu lado de la cama ocupe el 80% del espacio. 🛏️😅',
    'Me gustas más que dormir cinco minutos más por la mañana. 😴⏰',
    'Gracias por aguantarme. Sé que no soy fácil, pero al menos soy guapo. 😎',
    'Te amo incluso cuando me preguntas qué quiero cenar y rechazas todas mis opciones. 🍕🙄',
    'Eres mi persona favorita para no hacer nada juntos. 🛋️💕',
    'Si me dieran a elegir entre tú y un millón de dólares... me costaría un par de segundos, pero te elegiría a ti. 💰➡️💖',
    'Te amo de aquí a la cocina, porque hasta allá llego por un snack. 🍪😘'
  ] as l) lines;
$$;

-- The last line: when he is likely home that day (the end of the day's last confirmed booking plus its travel time), or that there is no
-- other booking that day. A time past midnight is not given (it cannot happen with today's opening hours).
create function public.family_alert_home_line(p_date date)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when max(b.start_minutes + b.treatment_duration_minutes + b.travel_buffer_minutes) is null then '🛋️ No hay más reservas ese día.'
    when max(b.start_minutes + b.treatment_duration_minutes + b.travel_buffer_minutes) >= 24 * 60 then null
    else '🏠 Ese día estaré en casa sobre las ' || public.family_alert_clock(max(b.start_minutes + b.treatment_duration_minutes + b.travel_buffer_minutes)) || '.'
  end
  from public.bookings b
  where b.date = p_date and b.booking_status in ('confirmed', 'completed');
$$;
revoke all on function public.family_alert_home_line(date) from public, anon, authenticated;

create function public.family_alert_is_ahead(p_date date, p_start integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_date::timestamp + make_interval(mins => p_start) > (now() at time zone 'Europe/London');
$$;

-- Compares a booking with what the family was last told, and writes a message to each linked chat when it differs.
create function public.family_alert_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_told public.family_booking_told%rowtype;
  v_date date;
  v_start integer;
  v_end integer;
  v_status text;
  v_text text;
begin
  begin
    select * into v_told from public.family_booking_told t where t.booking_id = v_id for update;
    select b.date, b.start_minutes, b.start_minutes + b.treatment_duration_minutes, b.booking_status
      into v_date, v_start, v_end, v_status
    from public.bookings b where b.id = v_id;

    if v_status in ('confirmed', 'completed') then
      if v_told.booking_id is null then
        insert into public.family_booking_told(booking_id, date, start_minutes, end_minutes) values (v_id, v_date, v_start, v_end)
        on conflict (booking_id) do nothing;
        if found and public.family_alert_is_ahead(v_date, v_start) then
          v_text := '📅 Nueva reserva' || E'\n🕑 ' || public.family_alert_when(v_date, v_start, v_end);
        end if;
      elsif (v_told.date, v_told.start_minutes, v_told.end_minutes) is distinct from (v_date, v_start, v_end) then
        update public.family_booking_told set date = v_date, start_minutes = v_start, end_minutes = v_end, told_at = clock_timestamp()
        where booking_id = v_id;
        if public.family_alert_is_ahead(v_date, v_start) then
          v_text := case when (v_told.date, v_told.start_minutes) is distinct from (v_date, v_start) then '🔁 Reserva cambiada de hora' else '🔁 Reserva cambiada' end
            || E'\n⏪ Antes: ' || public.family_alert_when(v_told.date, v_told.start_minutes, v_told.end_minutes)
            || E'\n⏩ Ahora: ' || public.family_alert_when(v_date, v_start, v_end);
        end if;
      end if;
      if v_text is not null then v_text := concat_ws(E'\n', v_text, public.family_alert_home_line(v_date)); end if;
    elsif v_told.booking_id is not null then
      -- No longer going ahead. Only a cancellation (or a booking removed outright) is news; a no-show is in the past anyway.
      delete from public.family_booking_told where booking_id = v_id;
      if (v_status is null or v_status = 'cancelled') and public.family_alert_is_ahead(v_told.date, v_told.start_minutes) then
        v_text := concat_ws(E'\n', '❌ Reserva cancelada', '🕑 ' || public.family_alert_when(v_told.date, v_told.start_minutes, v_told.end_minutes),
          public.family_alert_home_line(v_told.date));
      end if;
    end if;

    if v_text is not null then
      v_text := v_text || E'\n\n💛 ' || public.family_alert_love_line();
      insert into public.family_telegram_messages(chat_id, body)
      select c.chat_id, v_text from public.family_telegram_chats c where c.stopped_at is null;
    end if;
  exception when others then
    raise warning 'family alert: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.family_alert_booking() from public, anon, authenticated;

-- Runs when the change is saved, so several steps of one change (status, then time) are one message with the final times.
create constraint trigger bookings_family_alert
after insert or delete or update of booking_status, date, start_minutes, treatment_duration_minutes on public.bookings
deferrable initially deferred
for each row execute function public.family_alert_booking();

-- The bookings already going ahead count as told, so the first change to one of them is "moved", not "new".
insert into public.family_booking_told(booking_id, date, start_minutes, end_minutes)
select b.id, b.date, b.start_minutes, b.start_minutes + b.treatment_duration_minutes
from public.bookings b
where b.booking_status in ('confirmed', 'completed') and b.date >= current_date - 1;

-- ---------------------------------------------------------------------------------------------
-- 3. What the Admin can do: make a link, see the linked chats, switch one off
-- ---------------------------------------------------------------------------------------------
create function public.admin_family_telegram_status()
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
  return jsonb_build_object('chats', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'linked_at', c.linked_at) order by c.linked_at)
    from public.family_telegram_chats c where c.stopped_at is null), '[]'::jsonb));
end;
$$;

-- The code is "family_" and 32 random letters and digits: the bot's webhook knows a family link by the start.
create function public.admin_create_family_telegram_link()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if (select count(*) from public.family_telegram_tokens t where t.created_at > clock_timestamp() - interval '1 hour') >= 10 then
    raise exception 'Please wait a little before asking again.' using errcode = 'PT429';
  end if;
  v_token := 'family_' || replace(gen_random_uuid()::text, '-', '');
  insert into public.family_telegram_tokens(token_hash, expires_at)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), clock_timestamp() + interval '24 hours');
  delete from public.family_telegram_tokens t where t.expires_at < clock_timestamp() - interval '1 day';
  return v_token;
end;
$$;

create function public.admin_stop_family_telegram(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chat bigint;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  select c.chat_id into v_chat from public.family_telegram_chats c where c.id = p_id and c.stopped_at is null;
  if v_chat is not null then perform public.stop_family_telegram(v_chat); end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. What the Telegram webhook does (the service key only)
-- ---------------------------------------------------------------------------------------------
-- Pressing Start with a family code links the chat. Asking again after it worked says "linked" again (a retry from Telegram must not turn a
-- success into "already used").
create function public.link_family_telegram(p_token text, p_chat_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token public.family_telegram_tokens%rowtype;
begin
  if p_chat_id is null or p_token is null or length(p_token) not between 16 and 64 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_token from public.family_telegram_tokens t where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if v_token.used_at is not null then
    if exists (select 1 from public.family_telegram_chats c where c.chat_id = p_chat_id and c.stopped_at is null) then
      return jsonb_build_object('status', 'linked');
    end if;
    return jsonb_build_object('status', 'used');
  end if;
  if v_token.expires_at <= clock_timestamp() then return jsonb_build_object('status', 'expired'); end if;
  update public.family_telegram_tokens set used_at = clock_timestamp() where id = v_token.id;
  insert into public.family_telegram_chats(chat_id) values (p_chat_id)
  on conflict (chat_id) do update set stopped_at = null, linked_at = clock_timestamp();
  return jsonb_build_object('status', 'linked');
end;
$$;

-- /stop (or a chat that has blocked the bot) ends the chat's family alerts and drops what is still waiting for it. Answers 1 if it was on.
create function public.stop_family_telegram(p_chat_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.family_telegram_chats set stopped_at = clock_timestamp() where chat_id = p_chat_id and stopped_at is null;
  get diagnostics v_count = row_count;
  update public.family_telegram_messages m
     set status = 'failed', attempt_count = 5, last_error = 'This chat has stopped family alerts', next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
   where m.chat_id = p_chat_id and m.status in ('pending', 'failed') and m.attempt_count < 5;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. What the sender does (the service key only): take what is due, and say how it went
-- ---------------------------------------------------------------------------------------------
-- Like the other messages: five tries, after 2, 8, 18 and 32 minutes; one left "sending" for 10 minutes is tried again. Old sent messages,
-- and what was told about bookings long past, are tidied away here.
create function public.claim_family_telegram_messages(p_limit integer)
returns setof public.family_telegram_messages
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.family_telegram_messages m where m.status = 'sent' and m.sent_at < clock_timestamp() - interval '30 days';
  delete from public.family_booking_told t where t.date < current_date - 7;
  return query
  with picked as (
    select m.id from public.family_telegram_messages m
    where m.attempt_count < 5
      and ((m.status in ('pending', 'failed') and m.next_attempt_at <= clock_timestamp())
        or (m.status = 'sending' and m.updated_at < clock_timestamp() - interval '10 minutes'))
    order by m.created_at
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
    for update skip locked
  )
  update public.family_telegram_messages m set status = 'sending', attempt_count = m.attempt_count + 1, updated_at = clock_timestamp()
  from picked where m.id = picked.id
  returning m.*;
end;
$$;

create function public.complete_family_telegram_message(p_id uuid, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.family_telegram_messages set
    status = case when p_ok then 'sent' else 'failed' end,
    sent_at = case when p_ok then clock_timestamp() else null end,
    last_error = case when p_ok then null else left(coalesce(p_error, 'Unknown error'), 500) end,
    next_attempt_at = case when p_ok then next_attempt_at else clock_timestamp() + make_interval(mins => 2 * attempt_count * attempt_count) end,
    updated_at = clock_timestamp()
  where id = p_id and status = 'sending';
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Who may call what
-- ---------------------------------------------------------------------------------------------
revoke all on function public.admin_family_telegram_status() from public, anon;
revoke all on function public.admin_create_family_telegram_link() from public, anon;
revoke all on function public.admin_stop_family_telegram(uuid) from public, anon;
grant execute on function public.admin_family_telegram_status() to authenticated;
grant execute on function public.admin_create_family_telegram_link() to authenticated;
grant execute on function public.admin_stop_family_telegram(uuid) to authenticated;

revoke all on function public.link_family_telegram(text, bigint) from public, anon, authenticated;
revoke all on function public.stop_family_telegram(bigint) from public, anon, authenticated;
revoke all on function public.claim_family_telegram_messages(integer) from public, anon, authenticated;
revoke all on function public.complete_family_telegram_message(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.link_family_telegram(text, bigint) to service_role;
grant execute on function public.stop_family_telegram(bigint) to service_role;
grant execute on function public.claim_family_telegram_messages(integer) to service_role;
grant execute on function public.complete_family_telegram_message(uuid, boolean, text) to service_role;
