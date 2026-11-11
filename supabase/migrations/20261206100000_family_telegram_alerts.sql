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
-- ends with one of his 100 love lines, in a mixed order.
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

-- Every message ends with one of the owner's love lines (his own nine and 91 more he approved on 11 Nov 2026, 20 of them Andalusian for
-- his wife, from Olivares near Seville). They come in a mixed order: every line once, at random, before any comes back; after that, a
-- line is picked at random from the 50 used longest ago, so no line comes back until at least 50 others have been sent. To add a line, insert it into family_love_lines.
create table public.family_love_lines (
  id integer primary key,
  line text not null constraint family_love_lines_line_valid check (length(btrim(line)) between 1 and 300),
  last_used_at timestamptz
);
alter table public.family_love_lines enable row level security;
revoke all on table public.family_love_lines from public, anon, authenticated;
grant select, insert, update, delete on table public.family_love_lines to service_role;

insert into public.family_love_lines(id, line) values
  (1, 'Te amo con todo mi culo. Diría corazón, pero mi culo es más grande. 🍑❤️'),
  (2, 'Eres la única persona con la que compartiría mis papitas... y por compartir me refiero a darte una. 🥔🍟'),
  (3, 'Te quiero tanto que soporto que tu lado de la cama ocupe el 80% del espacio. 🛏️😅'),
  (4, 'Me gustas más que dormir cinco minutos más por la mañana. 😴⏰'),
  (5, 'Gracias por aguantarme. Sé que no soy fácil, pero al menos soy guapo. 😎'),
  (6, 'Te amo incluso cuando me preguntas qué quiero cenar y rechazas todas mis opciones. 🍕🙄'),
  (7, 'Eres mi persona favorita para no hacer nada juntos. 🛋️💕'),
  (8, 'Si me dieran a elegir entre tú y un millón de dólares... me costaría un par de segundos, pero te elegiría a ti. 💰➡️💖'),
  (9, 'Te amo de aquí a la cocina, porque hasta allá llego por un snack. 🍪😘'),
  (10, 'Te quiero más que al último trozo de pizza. Y eso es mucho decir. 🍕❤️'),
  (11, 'Eres el queso de mi sándwich: sin ti, solo soy pan triste. 🧀🥪'),
  (12, 'Te amo tanto que te dejo elegir el postre... y luego me como la mitad. 🍰😏'),
  (13, 'Si fueras una verdura, serías una papa-cito. 🥔😍'),
  (14, 'Mi amor por ti es como mi hambre: no tiene fin. 🍔♾️'),
  (15, 'Eres la salsa de mis tacos. 🌮💃'),
  (16, 'Te amo aunque te comas mis galletas a escondidas. Lo sé todo. 🍪👀'),
  (17, 'Eres mi café de la mañana: sin ti no funciono. ☕😵'),
  (18, 'Te daría mi último nugget. Bueno, la mitad. 🍗🤏'),
  (19, 'Te amo aunque me robes la manta todas las noches. 🛌🥶'),
  (20, 'Te quiero tanto que te dejo los pies fríos en mis piernas. 🦶🧊'),
  (21, 'Mi lugar favorito del mundo es a tu lado... en el sofá... con la tele. 🛋️📺'),
  (22, 'Soñé contigo. Bueno, con una pizza, pero tú estabas al lado. 💭🍕'),
  (23, 'Te amo más que a la siesta del domingo. Y eso ya es amor de verdad. 😴❤️'),
  (24, 'Prometo no despertarte... a menos que tenga hambre. 🌙🍳'),
  (25, 'Soy guapo, trabajador y humilde. Tú tienes suerte. 😎💪'),
  (26, 'Tienes un marido increíble. Lo sé porque me lo digo cada mañana en el espejo. 🪞😏'),
  (27, 'Gracias por casarte conmigo. Alguien tenía que hacerlo. 💍😂'),
  (28, 'No soy perfecto, pero soy perfecto para ti. Y eso es lo que cuenta. 🧩💞'),
  (29, 'Mis manos son mágicas, pero mi corazón es todo tuyo. 👐✨'),
  (30, 'Mis clientes me pagan por un masaje. Tú los tienes gratis. Qué suerte, ¿eh? 💆‍♀️😉'),
  (31, 'Te debo un masaje. Bueno, cincuenta. Apúntalo. 📝💆'),
  (32, 'Soy masajista, pero la que me relaja eres tú. 😌💛'),
  (33, 'Trabajo con mis manos, pero pienso en ti con todo lo demás. 🙌💭'),
  (34, 'Gracias por quererme incluso cuando dejo los calcetines por ahí. 🧦🙈'),
  (35, 'Sé que a veces soy un desastre, pero soy TU desastre. 🌪️❤️'),
  (36, 'Eres la única que se ríe de mis chistes malos. Por eso me casé contigo. 🤡💍'),
  (37, 'Te quiero aunque siempre tengas razón. Sobre todo cuando tienes razón. 🤷‍♂️💕'),
  (38, 'Gracias por no venderme en internet cuando me pongo pesado. 📦😅'),
  (39, 'Eres tan paciente que deberían darte una medalla. Yo te doy un beso. 🏅😘'),
  (40, 'Te amo incluso cuando me dices "haz lo que quieras" y no es verdad. 😬❤️'),
  (41, 'Contigo discutir es casi divertido. Casi. 🥊💞'),
  (42, 'Te amo aunque cambies el canal justo en lo mejor. 📺😤❤️'),
  (43, 'Trabajo duro para poder volver a casa contigo. Y para comprar snacks. 🏠🍿'),
  (44, 'Cuenta atrás para volver a verte: activada. ⏳💓'),
  (45, 'Mi parte favorita del día es abrir la puerta y verte. La segunda es la cena. 🚪🍝'),
  (46, 'Voy a trabajar como un campeón para volver a casa como un príncipe. 🏆👑'),
  (47, 'Si llego tarde, es culpa del tráfico. Si llego pronto, es culpa del amor. 🚗💨❤️'),
  (48, 'Guárdame un abrazo. Y un poco de cena. Pero sobre todo el abrazo. 🤗🍲'),
  (49, 'Cuando vuelva, prometo quitarme los zapatos en la entrada. Esta vez sí. 👟🙏'),
  (50, 'Ya estoy pensando en el beso de bienvenida. 💋⏰'),
  (51, 'Vuelvo pronto. No te comas todo el chocolate. 🍫🚨'),
  (52, 'Eres mi persona favorita. Lo siento por todos los demás. 🥇💛'),
  (53, 'Te elegiría otra vez. Y otra. Y otra. Ya me entiendes. 🔁💍'),
  (54, 'Eres la mejor decisión que he tomado. La segunda fue pedir pizza anoche. 🍕✅'),
  (55, 'Contigo hasta hacer la compra es una cita romántica. 🛒💘'),
  (56, 'Te quiero más que ayer y menos que mañana. Y mañana tengo reservas, así que mucho. 📈❤️'),
  (57, 'Si el amor fuera dinero, serías millonaria. Y yo te pediría un préstamo. 💸😂'),
  (58, 'Eres el GPS de mi corazón: siempre me llevas a casa. 🧭❤️'),
  (59, 'Eres mi "y vivieron felices", con algunos dramas de por medio. 📖🎭'),
  (60, 'Cada día me gustas más. Es un problema y no busco solución. 🤷‍♂️💘'),
  (61, 'Te amo más que a mi equipo de fútbol. No se lo digas a nadie. ⚽🤫'),
  (62, 'Eres la reina de la casa. Yo soy el que saca la basura. 👑🗑️'),
  (63, 'Mi amor por ti es como mi espalda después de diez masajes: no se puede medir. 📏😩❤️'),
  (64, 'Si besarte fuera delito, estaría en la cárcel con cadena perpetua. 💋⛓️'),
  (65, 'Te quiero hasta la luna y de vuelta. Pero vuelvo, eh, que allí no hay snacks. 🌙🚀'),
  (66, 'Eres tan bonita que hasta mi madre te prefiere a ti. 👩‍🦳😅'),
  (67, 'Quiero envejecer contigo y discutir por el mando de la tele hasta los 90. 👴👵📺'),
  (68, 'Eres la única persona que me ve recién levantado y aún así se queda. 🧟‍♂️❤️'),
  (69, 'Te amo más de lo que odio el despertador. Y odio MUCHO el despertador. ⏰😤'),
  (70, 'Eres guapísima incluso sin filtro. Yo necesito tres. 📸😂'),
  (71, 'Te quiero tanto que te dejo elegir la serie. Una vez al mes. 🍿📺'),
  (72, 'Eres mi superheroína: aguantas mis chistes y no pierdes los poderes. 🦸‍♀️💥'),
  (73, 'Eres como un buen masaje: me quitas todo el estrés. 💆‍♂️✨'),
  (74, 'Ozú, mi arma, qué bonita eres. Más que la Giralda iluminada. 🌙⛪'),
  (75, 'Te quiero más que un sevillano a la sombra en agosto. ☀️🌳'),
  (76, 'Eres la aceituna de mi tapa. Y de Olivares, que son las mejores. 🫒😍'),
  (77, 'En Olivares hay muchos olivos, pero ninguno tan bonito como tú. 🌳🫒'),
  (78, 'Contigo no necesito aire acondicionado... bueno, en Sevilla en julio sí. 🥵❄️'),
  (79, 'Eres más fresquita que un salmorejo en pleno verano. 🍅🧊'),
  (80, 'Quillo, qué suerte tengo contigo. 🍀😎'),
  (81, 'Tienes más arte que toda la Feria de Abril junta. 💃🎡'),
  (82, 'Te quiero más que al rebujito en la Feria. Y mira que me gusta el rebujito. 🍹💃'),
  (83, 'Eres mi pescaíto frito: no me canso de ti. 🐟😋'),
  (84, 'Contigo hasta los 45 grados de Sevilla se aguantan. Más o menos. 🌡️😅'),
  (85, 'Si me preguntan por la octava maravilla del mundo, digo: una de Olivares. 🌍🫒'),
  (86, 'Hablas tan rápido que a veces no te entiendo, pero te quiero igual, mi arma. 🗣️💨❤️'),
  (87, 'Te amo con más ganas que un sevillano esperando la Semana Santa. 🕯️🙏'),
  (88, 'Eres como el aceite de oliva de tu tierra: lo mejor y en todo. 🫒✨'),
  (89, 'Mi corazón está más contento que un niño con una torrija. 🍞🍯'),
  (90, 'Te quiero a ti más que al montadito de pringá. Y eso en Sevilla es una declaración de amor. 🥪❤️'),
  (91, 'Me dices "ahora mismito voy" y yo ya sé que es en una hora. Te quiero igual. ⏳😂'),
  (92, 'Eres más salá que las papas de la Feria. 🥔🧂😍'),
  (93, '¡Illo, que te quiero! Y no es broma, es de corazón. 💛❤️'),
  (94, 'Gracias por hacer que cada día valga la pena, incluso los días de lluvia en Londres. 🌧️☔💛'),
  (95, 'Si tuviera que elegir entre respirar y quererte, usaría mi último aliento para decirte que te quiero. Y luego pediría oxígeno. 🫁😂'),
  (96, 'Hoy trabajo por los dos. Tú encárgate de estar guapa. Ah, ya lo estás. 💪😍'),
  (97, 'Si el amor se pudiera reservar, tendrías todos mis huecos libres. 📅💖'),
  (98, 'Tú eres mi cliente VIP: sin cita previa y con atención ilimitada. ⭐💆‍♀️'),
  (99, 'Mi reserva favorita es para siempre, y es contigo. 💍📅'),
  (100, 'Te quiero. Ya está. No hay chiste. Bueno, sí: te quiero más que a la pizza. 🍕❤️');

create function public.family_alert_love_line()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id integer;
  v_line text;
begin
  -- A line never used yet, if there is one; otherwise one of the 50 used longest ago.
  select f.id, f.line into v_id, v_line from public.family_love_lines f where f.last_used_at is null order by random() limit 1;
  if v_id is null then
    select l.id, l.line into v_id, v_line
    from (select f.id, f.line from public.family_love_lines f order by f.last_used_at limit 50) l
    order by random() limit 1;
  end if;
  if v_id is not null then update public.family_love_lines set last_used_at = clock_timestamp() where id = v_id; end if;
  return v_line;
end;
$$;
revoke all on function public.family_alert_love_line() from public, anon, authenticated;

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
      v_text := concat_ws(E'\n\n💛 ', v_text, public.family_alert_love_line());
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
