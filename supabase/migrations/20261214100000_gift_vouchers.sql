-- Gift vouchers (Vadim, 14 Nov 2026). Mockup: https://claude.ai/artifact/ETJRknEigT3JDa5ZTgNsQY
--
-- What it does, in plain words:
--   * Anyone can buy a voucher at /gift: a massage of a set length (60, 90 or 120 minutes, or 60 minutes each for two people), for someone
--     they name, with a message and one of five designs. They pay by bank transfer with a GIFT-XXXX reference.
--   * The travel fee and congestion charge: the buyer chooses the person's area (that area's charges are added), or "Not sure yet" with
--     "Everything included" (the highest charge of any area is added, and Vadim keeps what is not needed) or "Just the massage" (the person
--     pays their area's charges when they book).
--   * Vadim marks it paid in More › Gift vouchers. The buyer is emailed the voucher's link (/gift/<code>) to print, save or send on WhatsApp,
--     or the person is emailed it on the day the buyer chose. A voucher is valid for 12 months from payment; a reminder goes a month before.
--   * Vadim can also make a voucher by hand, for one paid in cash or in person.
--   * The person books with the code: the length and number of people are set, a longer time is allowed (they pay the difference), the
--     voucher pays for the massage and the charges it covers, and with nothing left to pay the booking is confirmed straight away.
--   * A cancelled booking gives the voucher back, so it can be used again.
--
-- finalize_client_booking (from 20261212100000_paid_visit_counts_without_complete.sql) gains p_gift_code; client_change_check (from
-- 20261207100000_special_price_offers.sql) stops a gift booking's length being changed online.
--
-- Undo: drop the functions below, the trigger bookings_gift_voucher_back, the columns bookings.gift_voucher_id and bookings.gift_covered_gbp,
-- and the table gift_vouchers; put back finalize_client_booking and client_change_check from the migrations named above.

-- ---------------------------------------------------------------------------------------------
-- 1. The vouchers
-- ---------------------------------------------------------------------------------------------
create table public.gift_vouchers (
  id uuid primary key default gen_random_uuid(),
  -- What the person types or scans to book: 8 letters and digits that are easy to read (shown as 7K3M-QX9P).
  code text not null unique,
  -- The bank transfer reference, which is not the code (a bank statement must not give the voucher away).
  payment_reference text not null unique,
  -- The buyer's own page while they wait for the voucher (never shown to anyone else).
  buyer_token uuid not null unique default gen_random_uuid(),
  minutes integer not null constraint gift_vouchers_minutes_valid check (minutes between 30 and 300 and minutes % 30 = 0),
  people integer not null default 1 constraint gift_vouchers_people_valid check (people between 1 and 2),
  -- The price of one person's massage when it was bought, and what was added for the travel fee and congestion charge.
  massage_price_gbp numeric(10,2) not null constraint gift_vouchers_massage_price_valid check (massage_price_gbp >= 0),
  travel_cover_gbp numeric(10,2) not null default 0 constraint gift_vouchers_travel_cover_valid check (travel_cover_gbp >= 0),
  -- 'area' (the buyer chose the person's area), 'all' (everything included, any area) or 'none' (just the massage).
  travel_choice text not null default 'none' constraint gift_vouchers_travel_choice_valid check (travel_choice in ('area', 'all', 'none')),
  service_area_id uuid references public.service_areas(id) on delete set null,
  service_area_name text,
  price_gbp numeric(10,2) not null constraint gift_vouchers_price_valid check (price_gbp >= 0),
  recipient_name text not null constraint gift_vouchers_recipient_valid check (length(btrim(recipient_name)) between 1 and 60),
  from_name text not null constraint gift_vouchers_from_valid check (length(btrim(from_name)) between 1 and 60),
  message text constraint gift_vouchers_message_valid check (message is null or length(message) <= 400),
  design text not null default 'christmas_night'
    constraint gift_vouchers_design_valid check (design in ('christmas_night', 'wrapped_present', 'gold_foil', 'black_gold', 'any_occasion')),
  -- 'self' (the buyer gives it) or 'email' (it is emailed to the person on send_at).
  delivery text not null default 'self' constraint gift_vouchers_delivery_valid check (delivery in ('self', 'email')),
  recipient_email text,
  send_at timestamptz,
  recipient_sent_at timestamptz,
  buyer_name text not null constraint gift_vouchers_buyer_valid check (length(btrim(buyer_name)) between 1 and 120),
  buyer_email text,
  buyer_phone text,
  -- 'awaiting_payment', 'ready' (paid, can be used), 'used' or 'cancelled'. An unused ready voucher past expires_at has expired.
  status text not null default 'awaiting_payment' constraint gift_vouchers_status_valid check (status in ('awaiting_payment', 'ready', 'used', 'cancelled')),
  payment_method text constraint gift_vouchers_payment_method_valid check (payment_method is null or payment_method in ('bank_transfer', 'cash')),
  transfer_declared_at timestamptz,
  paid_at timestamptz,
  expires_at timestamptz,
  reminder_sent_at timestamptz,
  booking_id uuid,
  used_at timestamptz,
  created_by text not null default 'buyer' constraint gift_vouchers_created_by_valid check (created_by in ('buyer', 'admin')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gift_vouchers_paid_valid check (status = 'awaiting_payment' or status = 'cancelled' or (paid_at is not null and expires_at is not null)),
  constraint gift_vouchers_email_needed check (delivery = 'self' or (recipient_email is not null and send_at is not null))
);
create index gift_vouchers_status on public.gift_vouchers(status, created_at desc);
create trigger gift_vouchers_set_updated_at before update on public.gift_vouchers for each row execute function public.set_updated_at();
alter table public.gift_vouchers enable row level security;
-- Only the Admin reads vouchers directly; buyers and the people they give them to reach one only through its code or token, below.
revoke all on table public.gift_vouchers from anon, authenticated;
grant select on table public.gift_vouchers to authenticated;
grant select, insert, update, delete on table public.gift_vouchers to service_role;
create policy gift_vouchers_admin_read on public.gift_vouchers for select to authenticated using (public.is_booking_admin());

-- The booking a voucher paid for, and how much of it the voucher paid.
alter table public.bookings add column gift_voucher_id uuid references public.gift_vouchers(id) on delete set null;
alter table public.bookings add column gift_covered_gbp numeric(10,2) not null default 0;
alter table public.gift_vouchers add constraint gift_vouchers_booking_fk foreign key (booking_id) references public.bookings(id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- 2. Small helpers
-- ---------------------------------------------------------------------------------------------
create function public.new_gift_code(p_length integer default 8)
returns text language plpgsql volatile set search_path = '' as $$
declare v_letters constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v_code text;
begin
  loop
    select string_agg(substr(v_letters, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(v_letters)), 1), '') into v_code
      from generate_series(1, p_length);
    exit when not exists (select 1 from public.gift_vouchers g where g.code = v_code or g.payment_reference = 'GIFT-' || v_code);
  end loop;
  return v_code;
end; $$;
revoke all on function public.new_gift_code(integer) from public, anon, authenticated;

-- A code as people type it ("7k3m qx9p", "7K3M-QX9P") as it is kept ("7K3MQX9P").
create function public.gift_code_clean(p_code text)
returns text language sql immutable set search_path = '' as $$ select nullif(regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g'), '') $$;
-- And as it is shown.
create function public.gift_code_shown(p_code text)
returns text language sql immutable set search_path = '' as $$ select case when length(p_code) = 8 then left(p_code, 4) || '-' || right(p_code, 4) else p_code end $$;

-- One person's massage of this length, at today's price: the first treatment (in the order they are shown) that comes in it.
create function public.gift_massage_price(p_minutes integer)
returns numeric language sql stable set search_path = '' as $$
  select p.price_gbp from public.services s join public.service_duration_prices p on p.service_id = s.id
   where s.active and p.active and p.duration_minutes = p_minutes
   order by s.display_order, s.name limit 1;
$$;

-- What "Everything included" adds: the most any area adds (travel fee and congestion charge together).
create function public.gift_all_areas_cover()
returns numeric language sql stable set search_path = '' as $$
  select coalesce(max(coalesce(a.travel_surcharge_gbp, 0) + coalesce(a.congestion_fee_gbp, 0)), 0)::numeric(10,2) from public.service_areas a where a.active;
$$;

create function public.gift_setting_on()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select (value #>> '{}')::boolean from public.business_settings where key = 'gift_vouchers_on'), true);
$$;
create function public.gift_months()
returns integer language sql stable set search_path = '' as $$
  select greatest(1, least(60, coalesce((select (value #>> '{}')::integer from public.business_settings where key = 'gift_voucher_months'), 12)));
$$;

-- "a 60-minute massage", "a 90-minute massage for two"
create function public.gift_words(p_minutes integer, p_people integer)
returns text language sql immutable set search_path = '' as $$
  select case when p_minutes % 60 = 0 and p_minutes >= 120 then format('a %s-hour massage', p_minutes / 60) else format('a %s-minute massage', p_minutes) end
      || case when p_people = 2 then ' for two' else '' end;
$$;

create function public.gift_london_date(p_at timestamptz)
returns text language sql stable set search_path = '' as $$ select trim(to_char(p_at at time zone 'Europe/London', 'FMDD FMMonth YYYY')) $$;

-- The voucher's link, as the emails and WhatsApp messages give it.
create function public.gift_link_path(p_code text)
returns text language sql immutable set search_path = '' as $$ select '/gift/' || public.gift_code_shown(p_code) $$;

-- The bank details the buyer pays to, as text for the email.
create function public.gift_bank_text()
returns text language sql stable set search_path = '' as $$
  select concat_ws(E'\n',
    'Account name: ' || (b.value->>'account_name'),
    'Sort code: ' || (b.value->>'sort_code'),
    'Account number: ' || (b.value->>'account_number'))
  from public.business_settings b where b.key = 'bank_details';
$$;

revoke all on function public.gift_massage_price(integer), public.gift_all_areas_cover(), public.gift_setting_on(), public.gift_months(),
  public.gift_words(integer, integer), public.gift_london_date(timestamptz), public.gift_link_path(text), public.gift_bank_text(),
  public.gift_code_clean(text), public.gift_code_shown(text) from public, anon, authenticated;

-- Messages about a voucher: an event (never twice for the same key) and its emails and alerts.
create function public.gift_notify(p_voucher public.gift_vouchers, p_kind text, p_admin_title text, p_admin_body text,
  p_client_email text, p_client_title text, p_client_body text, p_client_link text, p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_event uuid;
begin
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('gift.' || p_kind, 'gift_voucher', p_voucher.id, coalesce(p_dedupe, 'gift.' || p_kind || ':' || p_voucher.id::text || ':' || clock_timestamp()::text),
          jsonb_build_object('gift_voucher_id', p_voucher.id))
  on conflict (deduplication_key) do nothing
  returning id into v_event;
  if v_event is null then return null; end if;
  if p_admin_title is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (v_event, 'in_app', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts', 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'telegram', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts'),
           (v_event, 'email', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts');
  end if;
  if p_client_title is not null and nullif(btrim(coalesce(p_client_email, '')), '') is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'email', 'client', btrim(p_client_email), p_client_title, p_client_body || E'\n\nWarm wishes,\nVadim', p_client_link);
  end if;
  return v_event;
end; $$;
revoke all on function public.gift_notify(public.gift_vouchers, text, text, text, text, text, text, text, text) from public, anon, authenticated;

-- What the buyer is told once it is paid (and, for an emailed voucher, when it will arrive).
create function public.gift_ready_messages(v public.gift_vouchers)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.gift_notify(v, 'ready', null, null, v.buyer_email,
    format('Your gift voucher for %s is ready', v.recipient_name),
    format('Thank you, %s. I have received your payment of %s.', split_part(btrim(v.buyer_name), ' ', 1), public.notification_money(v.price_gbp))
      || E'\n\n' || format('Your voucher for %s (%s) is ready. Open it, print it, save it or send it on WhatsApp here:', v.recipient_name, public.gift_words(v.minutes, v.people))
      || E'\n{link}\n\n'
      || case when v.delivery = 'email'
           then format('As you asked, I will email it to %s at %s on %s.', v.recipient_name, v.recipient_email,
                  trim(to_char(v.send_at at time zone 'Europe/London', 'FMDD FMMonth, HH24:MI'))) || E'\n\n'
           else '' end
      || format('Code: %s. Valid until %s.', public.gift_code_shown(v.code), public.gift_london_date(v.expires_at)),
    public.gift_link_path(v.code), 'gift.ready:' || v.id::text);
end; $$;
revoke all on function public.gift_ready_messages(public.gift_vouchers) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The buying page
-- ---------------------------------------------------------------------------------------------
-- What can be bought, at today's prices, and what each area adds.
create function public.get_gift_options()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'on', public.gift_setting_on(),
    'months', public.gift_months(),
    'all_areas_cover', public.gift_all_areas_cover(),
    'lengths', coalesce((select jsonb_agg(jsonb_build_object('minutes', m, 'price', public.gift_massage_price(m)) order by m)
                 from (select distinct p.duration_minutes m from public.services s join public.service_duration_prices p on p.service_id = s.id
                        where s.active and p.active) d where public.gift_massage_price(m) is not null), '[]'::jsonb),
    'areas', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
                 'travel', coalesce(a.travel_surcharge_gbp, 0), 'congestion', coalesce(a.congestion_fee_gbp, 0)) order by a.display_order, a.name)
                 from public.service_areas a where a.active), '[]'::jsonb));
$$;

create function public.buy_gift_voucher(
  p_minutes integer, p_people integer, p_travel_choice text, p_service_area_id uuid, p_design text,
  p_recipient_name text, p_from_name text, p_message text, p_delivery text, p_recipient_email text, p_send_at timestamptz,
  p_buyer_name text, p_buyer_email text, p_buyer_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_price numeric(10,2);
  v_cover numeric(10,2) := 0;
  v_area public.service_areas%rowtype;
  v_code text;
  v public.gift_vouchers%rowtype;
  v_email text := lower(nullif(btrim(coalesce(p_buyer_email, '')), ''));
  v_to_email text := lower(nullif(btrim(coalesce(p_recipient_email, '')), ''));
  v_bank text := public.gift_bank_text();
begin
  if not public.gift_setting_on() then
    raise exception 'Gift vouchers are not on sale right now. Please message Vadim.' using errcode = '22023';
  end if;
  if p_people not in (1, 2) then raise exception 'A voucher is for one or two people.' using errcode = '22023'; end if;
  v_price := public.gift_massage_price(p_minutes);
  if v_price is null then raise exception '%', format('There is no %s-minute massage to give. Please choose another length.', p_minutes) using errcode = '22023'; end if;
  if p_travel_choice not in ('area', 'all', 'none') then raise exception 'Choose where they live.' using errcode = '22023'; end if;
  if p_travel_choice = 'area' then
    select * into v_area from public.service_areas a where a.id = p_service_area_id and a.active;
    if not found then raise exception 'Please choose their area again.' using errcode = '22023'; end if;
    v_cover := coalesce(v_area.travel_surcharge_gbp, 0) + coalesce(v_area.congestion_fee_gbp, 0);
  elsif p_travel_choice = 'all' then
    v_cover := public.gift_all_areas_cover();
  end if;
  if nullif(btrim(coalesce(p_recipient_name, '')), '') is null then raise exception 'Who is the voucher for?' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_from_name, '')), '') is null then raise exception 'Who is it from?' using errcode = '22023'; end if;
  if length(btrim(p_recipient_name)) > 60 or length(btrim(p_from_name)) > 60 then raise exception 'Please make the names shorter.' using errcode = '22023'; end if;
  if length(coalesce(p_message, '')) > 400 then raise exception 'Please make the message shorter (400 letters at most).' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_buyer_name, '')), '') is null then raise exception 'Please add your name.' using errcode = '22023'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please add your email, so I can send you the voucher.' using errcode = '22023'; end if;
  if coalesce(p_delivery, 'self') not in ('self', 'email') then raise exception 'Choose how the voucher should arrive.' using errcode = '22023'; end if;
  if p_delivery = 'email' then
    if v_to_email is null or v_to_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please add their email, so the voucher can reach them.' using errcode = '22023'; end if;
    if p_send_at is null then raise exception 'Choose the day it should arrive.' using errcode = '22023'; end if;
    if p_send_at > clock_timestamp() + interval '1 year' then raise exception 'Please choose a day within the next year.' using errcode = '22023'; end if;
  end if;
  -- A few at a time from one email, and not a flood from everyone: a voucher waiting for payment is only a request.
  if (select count(*) from public.gift_vouchers g where g.buyer_email = v_email and g.status = 'awaiting_payment' and g.created_at > clock_timestamp() - interval '1 day') >= 5
     or (select count(*) from public.gift_vouchers g where g.status = 'awaiting_payment' and g.created_at > clock_timestamp() - interval '1 hour') >= 40 then
    raise exception 'There are already several vouchers waiting for payment. Please message Vadim and he will help.' using errcode = '22023';
  end if;

  v_code := public.new_gift_code();
  insert into public.gift_vouchers(code, payment_reference, minutes, people, massage_price_gbp, travel_cover_gbp, travel_choice, service_area_id,
    service_area_name, price_gbp, recipient_name, from_name, message, design, delivery, recipient_email, send_at, buyer_name, buyer_email, buyer_phone)
  values (v_code, 'GIFT-' || left(public.new_gift_code(), 5), p_minutes, p_people, v_price, v_cover, p_travel_choice, v_area.id, v_area.name,
    v_price * p_people + v_cover, btrim(p_recipient_name), btrim(p_from_name), nullif(btrim(coalesce(p_message, '')), ''),
    coalesce(p_design, 'christmas_night'), coalesce(p_delivery, 'self'), case when p_delivery = 'email' then v_to_email end,
    case when p_delivery = 'email' then p_send_at end, btrim(p_buyer_name), v_email, nullif(btrim(coalesce(p_buyer_phone, '')), ''))
  returning * into v;

  perform public.gift_notify(v, 'bought',
    format('New gift voucher: %s by bank transfer', public.notification_money(v.price_gbp)),
    format('%s is buying %s for %s. Reference %s.', v.buyer_name, public.gift_words(v.minutes, v.people), v.recipient_name, v.payment_reference)
      || E'\n' || 'Mark it paid in More › Gift vouchers when the money arrives.',
    v.buyer_email,
    'Your gift voucher: one last step',
    format('Thank you, %s! To finish, please transfer %s', split_part(btrim(v.buyer_name), ' ', 1), public.notification_money(v.price_gbp))
      || case when v_bank is not null then E':\n\n' || v_bank || E'\nReference: ' || v.payment_reference else format(' with the reference %s.', v.payment_reference) end
      || E'\n\n' || format('As soon as it arrives I will send you the voucher for %s.', v.recipient_name),
    null, 'gift.bought:' || v.id::text);

  return jsonb_build_object('token', v.buyer_token, 'reference', v.payment_reference, 'amount', v.price_gbp,
    'bank', (select value from public.business_settings where key = 'bank_details'));
end; $$;

-- The buyer's own page: what they bought and, once paid, its code.
create function public.get_my_gift_purchase(p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', g.status, 'reference', g.payment_reference, 'amount', g.price_gbp, 'recipient_name', g.recipient_name,
    'minutes', g.minutes, 'people', g.people, 'transfer_declared', g.transfer_declared_at is not null, 'delivery', g.delivery,
    'recipient_email', g.recipient_email, 'send_at', g.send_at,
    'code', case when g.status in ('ready', 'used') then public.gift_code_shown(g.code) end,
    'bank', case when g.status = 'awaiting_payment' then (select value from public.business_settings where key = 'bank_details') end)
  from public.gift_vouchers g where g.buyer_token = p_token;
$$;

-- "I've made the transfer": Vadim is told, once.
create function public.gift_transfer_made(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  update public.gift_vouchers g set transfer_declared_at = clock_timestamp() where g.buyer_token = p_token and g.status = 'awaiting_payment' and g.transfer_declared_at is null
  returning * into v;
  if found then
    perform public.gift_notify(v, 'transfer_declared',
      format('%s says the gift voucher transfer is made', v.buyer_name),
      format('%s with reference %s. Check your bank, then mark it paid in More › Gift vouchers.', public.notification_money(v.price_gbp), v.payment_reference),
      null, null, null, null, 'gift.transfer_declared:' || v.id::text);
  end if;
  return public.get_my_gift_purchase(p_token);
end; $$;

-- The voucher's own page (/gift/<code>), for whoever has the code: what it is, from whom, and whether it can be used.
create function public.get_gift_voucher(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'code', public.gift_code_shown(g.code),
    'state', case when g.status = 'ready' and g.expires_at <= clock_timestamp() then 'expired'
                  when g.status = 'awaiting_payment' then 'waiting' else g.status end,
    'minutes', g.minutes, 'people', g.people, 'recipient_name', g.recipient_name, 'from_name', g.from_name, 'message', g.message,
    'design', g.design, 'travel_choice', g.travel_choice, 'travel_cover', g.travel_cover_gbp, 'area_name', g.service_area_name,
    'expires_at', g.expires_at, 'delivery', g.delivery)
  from public.gift_vouchers g where g.code = public.gift_code_clean(p_code) and g.status <> 'cancelled';
$$;

revoke all on function public.get_gift_options(), public.buy_gift_voucher(integer, integer, text, uuid, text, text, text, text, text, text, timestamptz, text, text, text),
  public.get_my_gift_purchase(uuid), public.gift_transfer_made(uuid), public.get_gift_voucher(text) from public;
grant execute on function public.get_gift_options(), public.buy_gift_voucher(integer, integer, text, uuid, text, text, text, text, text, text, timestamptz, text, text, text),
  public.get_my_gift_purchase(uuid), public.gift_transfer_made(uuid), public.get_gift_voucher(text) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. The Admin: More › Gift vouchers
-- ---------------------------------------------------------------------------------------------
create function public.admin_gift_vouchers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_booking_admin();
  return coalesce((select jsonb_agg(to_jsonb(g) - 'buyer_token' || jsonb_build_object(
      'code_shown', public.gift_code_shown(g.code),
      'expired', g.status = 'ready' and g.expires_at <= clock_timestamp(),
      'booking', (select jsonb_build_object('id', b.id, 'date', b.date, 'start_minutes', b.start_minutes,
                    'client_name', btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')))
                  from public.bookings b left join public.clients c on c.id = b.client_id where b.id = g.booking_id))
    order by case g.status when 'awaiting_payment' then 0 when 'ready' then 1 when 'used' then 2 else 3 end, g.created_at desc)
    from public.gift_vouchers g
    where g.status <> 'cancelled' or g.updated_at > clock_timestamp() - interval '30 days'), '[]'::jsonb);
end; $$;

-- The money has arrived (or Vadim was paid in person): the voucher is ready and the buyer is sent it.
create function public.admin_mark_gift_paid(p_voucher_id uuid, p_method text default 'bank_transfer')
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_now timestamptz := clock_timestamp();
begin
  perform public.require_booking_admin();
  if coalesce(p_method, '') not in ('bank_transfer', 'cash') then raise exception 'Choose bank transfer or cash.' using errcode = '22023'; end if;
  update public.gift_vouchers g set status = 'ready', payment_method = p_method, paid_at = v_now,
         expires_at = v_now + make_interval(months => public.gift_months())
   where g.id = p_voucher_id and g.status = 'awaiting_payment'
  returning * into v;
  if not found then
    select * into v from public.gift_vouchers where id = p_voucher_id;
    if not found then raise exception 'That voucher was not found.' using errcode = '22023'; end if;
    if v.status <> 'ready' then raise exception 'That voucher is not waiting for payment.' using errcode = 'PT409'; end if;
    return v;
  end if;
  perform public.gift_ready_messages(v);
  -- An emailed voucher whose day has come goes now (the sender picks it up within the minute).
  perform public.plan_gift_messages(v_now);
  select * into v from public.gift_vouchers where id = p_voucher_id;
  return v;
end; $$;

-- A voucher Vadim makes himself, already paid (cash, or a transfer he has seen).
create function public.admin_make_gift_voucher(p_minutes integer, p_people integer, p_travel_choice text, p_service_area_id uuid, p_design text,
  p_recipient_name text, p_from_name text, p_message text, p_buyer_name text, p_buyer_email text, p_method text, p_price_gbp numeric default null)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v_price numeric(10,2); v_cover numeric(10,2) := 0; v_area public.service_areas%rowtype; v public.gift_vouchers%rowtype; v_now timestamptz := clock_timestamp();
  v_code text;
begin
  perform public.require_booking_admin();
  if p_people not in (1, 2) then raise exception 'A voucher is for one or two people.' using errcode = '22023'; end if;
  v_price := public.gift_massage_price(p_minutes);
  if v_price is null then raise exception '%', format('There is no %s-minute massage. Choose another length.', p_minutes) using errcode = '22023'; end if;
  if coalesce(p_travel_choice, 'none') = 'area' then
    select * into v_area from public.service_areas a where a.id = p_service_area_id;
    v_cover := coalesce(v_area.travel_surcharge_gbp, 0) + coalesce(v_area.congestion_fee_gbp, 0);
  elsif p_travel_choice = 'all' then
    v_cover := public.gift_all_areas_cover();
  end if;
  if nullif(btrim(coalesce(p_recipient_name, '')), '') is null then raise exception 'Who is the voucher for?' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('bank_transfer', 'cash') then raise exception 'Choose bank transfer or cash.' using errcode = '22023'; end if;
  if p_price_gbp is not null and p_price_gbp < 0 then raise exception 'Enter a price in pounds, for example 90.' using errcode = '22023'; end if;
  v_code := public.new_gift_code();
  insert into public.gift_vouchers(code, payment_reference, minutes, people, massage_price_gbp, travel_cover_gbp, travel_choice, service_area_id,
    service_area_name, price_gbp, recipient_name, from_name, message, design, delivery, buyer_name, buyer_email, status, payment_method,
    paid_at, expires_at, created_by)
  values (v_code, 'GIFT-' || left(public.new_gift_code(), 5), p_minutes, p_people, v_price, v_cover, coalesce(p_travel_choice, 'none'), v_area.id, v_area.name,
    coalesce(p_price_gbp, v_price * p_people + v_cover), btrim(p_recipient_name), coalesce(nullif(btrim(coalesce(p_from_name, '')), ''), btrim(coalesce(p_buyer_name, 'Vadim'))),
    nullif(btrim(coalesce(p_message, '')), ''), coalesce(p_design, 'christmas_night'), 'self',
    coalesce(nullif(btrim(coalesce(p_buyer_name, '')), ''), coalesce(nullif(btrim(coalesce(p_from_name, '')), ''), 'In person')),
    lower(nullif(btrim(coalesce(p_buyer_email, '')), '')), 'ready', p_method, v_now, v_now + make_interval(months => public.gift_months()), 'admin')
  returning * into v;
  if v.buyer_email is not null then perform public.gift_ready_messages(v); end if;
  return v;
end; $$;

-- Not paid after all, or made by mistake. A used voucher stays as it is.
create function public.admin_cancel_gift_voucher(p_voucher_id uuid)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  update public.gift_vouchers g set status = 'cancelled' where g.id = p_voucher_id and g.status in ('awaiting_payment', 'ready') returning * into v;
  if not found then raise exception 'That voucher has already been used, so it can''t be cancelled.' using errcode = 'PT409'; end if;
  return v;
end; $$;

-- Used without an online booking (Vadim booked it himself, or it was given in person).
create function public.admin_mark_gift_used(p_voucher_id uuid, p_used boolean default true)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  if p_used then
    update public.gift_vouchers g set status = 'used', used_at = clock_timestamp() where g.id = p_voucher_id and g.status = 'ready' returning * into v;
  else
    update public.gift_vouchers g set status = 'ready', used_at = null, booking_id = null where g.id = p_voucher_id and g.status = 'used' returning * into v;
  end if;
  if not found then raise exception 'That voucher can''t be changed now.' using errcode = 'PT409'; end if;
  return v;
end; $$;

revoke all on function public.admin_gift_vouchers(), public.admin_mark_gift_paid(uuid, text),
  public.admin_make_gift_voucher(integer, integer, text, uuid, text, text, text, text, text, text, text, numeric),
  public.admin_cancel_gift_voucher(uuid), public.admin_mark_gift_used(uuid, boolean) from public, anon;
grant execute on function public.admin_gift_vouchers(), public.admin_mark_gift_paid(uuid, text),
  public.admin_make_gift_voucher(integer, integer, text, uuid, text, text, text, text, text, text, text, numeric),
  public.admin_cancel_gift_voucher(uuid), public.admin_mark_gift_used(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Emails that wait for a day: an emailed voucher on the day the buyer chose, and a reminder a month before a voucher ends
-- ---------------------------------------------------------------------------------------------
create or replace function public.plan_gift_messages(p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_made integer := 0;
begin
  for v in select * from public.gift_vouchers g where g.status = 'ready' and g.delivery = 'email' and g.recipient_sent_at is null
             and g.send_at <= p_now and g.expires_at > p_now for update skip locked loop
    perform public.gift_notify(v, 'arrived', null, null, v.recipient_email,
      format('%s has sent you a gift', v.from_name),
      format('Hi %s,', v.recipient_name) || E'\n\n' || format('%s has sent you a gift. Open it here:', v.from_name) || E'\n{link}',
      public.gift_link_path(v.code) || '?open=1', 'gift.arrived:' || v.id::text);
    update public.gift_vouchers g set recipient_sent_at = p_now where g.id = v.id;
    v_made := v_made + 1;
  end loop;
  for v in select * from public.gift_vouchers g where g.status = 'ready' and g.reminder_sent_at is null
             and g.expires_at > p_now and g.expires_at <= p_now + interval '30 days' and g.paid_at < p_now - interval '60 days'
             for update skip locked loop
    perform public.gift_notify(v, 'reminder', null, null, coalesce(v.recipient_email, v.buyer_email),
      'Your massage gift voucher ends soon',
      format('Hi %s,', case when v.recipient_email is not null then v.recipient_name else split_part(btrim(v.buyer_name), ' ', 1) end) || E'\n\n'
        || format('A friendly reminder: the gift voucher for %s (%s, from %s) can be used until %s. Choose a day here:',
             v.recipient_name, public.gift_words(v.minutes, v.people), v.from_name, public.gift_london_date(v.expires_at)) || E'\n{link}',
      public.gift_link_path(v.code), 'gift.reminder:' || v.id::text);
    update public.gift_vouchers g set reminder_sent_at = p_now where g.id = v.id;
    v_made := v_made + 1;
  end loop;
  return v_made;
end; $$;
revoke all on function public.plan_gift_messages(timestamptz) from public, anon, authenticated;
grant execute on function public.plan_gift_messages(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Booking with a voucher
-- ---------------------------------------------------------------------------------------------
-- How much of a booking a voucher pays: one massage of its length for each of its people (today's price of the treatment chosen, so a longer
-- time costs only the difference), and the travel fee and congestion charge up to what it covers. Extras are not covered.
create function public.gift_cover_for(v public.gift_vouchers, p_sessions jsonb, p_travel numeric, p_congestion numeric)
returns numeric language plpgsql stable set search_path = '' as $$
declare s jsonb; v_cover numeric(10,2) := 0; v_price numeric(10,2); v_full numeric(10,2); v_n integer := 0;
begin
  for s in select value from jsonb_array_elements(p_sessions) loop
    v_n := v_n + 1;
    exit when v_n > v.people;
    select p.price_gbp into v_full from public.service_duration_prices p where p.service_id = (s->>'service_id')::uuid and p.duration_minutes = (s->>'duration_minutes')::integer and p.active;
    select p.price_gbp into v_price from public.service_duration_prices p where p.service_id = (s->>'service_id')::uuid and p.duration_minutes = v.minutes and p.active;
    v_cover := v_cover + least(coalesce(v_full, 0), coalesce(v_price, v.massage_price_gbp));
  end loop;
  return v_cover + least(coalesce(p_travel, 0) + coalesce(p_congestion, 0), v.travel_cover_gbp);
end; $$;
revoke all on function public.gift_cover_for(public.gift_vouchers, jsonb, numeric, numeric) from public, anon, authenticated;

-- A voucher that can be booked with now, or why not.
create function public.usable_gift_voucher(p_code text, p_sessions jsonb, p_lock boolean default false)
returns public.gift_vouchers language plpgsql volatile security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; s jsonb;
begin
  if p_lock then
    select * into v from public.gift_vouchers g where g.code = public.gift_code_clean(p_code) for update;
  else
    select * into v from public.gift_vouchers g where g.code = public.gift_code_clean(p_code);
  end if;
  if not found or v.status = 'cancelled' then raise exception 'That gift voucher code doesn''t work. Please check it, or message Vadim.' using errcode = '22023'; end if;
  if v.status = 'awaiting_payment' then raise exception 'This gift voucher is waiting for payment, so it can''t be used yet.' using errcode = '22023'; end if;
  if v.status = 'used' then raise exception 'This gift voucher has already been used.' using errcode = '22023'; end if;
  if v.expires_at <= clock_timestamp() then
    raise exception '%', format('Sorry, this gift voucher ended on %s. Please message Vadim.', public.gift_london_date(v.expires_at)) using errcode = '22023';
  end if;
  if p_sessions is not null then
    if jsonb_array_length(p_sessions) <> v.people then
      raise exception '%', case when v.people = 2 then 'This gift voucher is for two people, so please book for two.' else 'This gift voucher is for one person.' end using errcode = '22023';
    end if;
    for s in select value from jsonb_array_elements(p_sessions) loop
      if (s->>'duration_minutes')::integer < v.minutes then
        raise exception '%', format('This gift voucher is for %s minutes, so please choose %s minutes or longer.', v.minutes, v.minutes) using errcode = '22023';
      end if;
    end loop;
  end if;
  return v;
end; $$;
revoke all on function public.usable_gift_voucher(text, jsonb, boolean) from public, anon, authenticated;

-- The voucher for the booking page: what it gives, without the buyer's details.
create function public.check_gift_code(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  v := public.usable_gift_voucher(p_code, null);
  return jsonb_build_object('code', public.gift_code_shown(v.code), 'minutes', v.minutes, 'people', v.people, 'from_name', v.from_name,
    'recipient_name', v.recipient_name, 'travel_cover', v.travel_cover_gbp, 'travel_choice', v.travel_choice, 'area_name', v.service_area_name,
    'expires_at', v.expires_at);
end; $$;

-- The price on the review screen, with what the voucher pays and what is left.
create function public.quote_gift_booking(p_gift_code text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[] default '{}'::uuid[])
returns table(service_area_name text, primary_service_id uuid, treatment_duration_minutes integer, service_subtotal_gbp numeric, enhancements_total_gbp numeric,
  travel_fee_gbp numeric, congestion_fee_gbp numeric, total_gbp numeric, gift_covered_gbp numeric, to_pay_gbp numeric)
language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; q record; v_cover numeric(10,2);
begin
  v := public.usable_gift_voucher(p_gift_code, p_sessions);
  select * into q from public.compute_client_booking_quote(p_service_area_id, p_sessions, coalesce(p_enhancement_ids, '{}'::uuid[]));
  v_cover := least(q.total_gbp, public.gift_cover_for(v, p_sessions, q.travel_fee_gbp, q.congestion_fee_gbp));
  return query select q.service_area_name, q.primary_service_id, q.treatment_duration_minutes, q.service_subtotal_gbp, q.enhancements_total_gbp,
    q.travel_fee_gbp, q.congestion_fee_gbp, q.total_gbp, v_cover, (q.total_gbp - v_cover)::numeric(10,2);
end; $$;

revoke all on function public.check_gift_code(text), public.quote_gift_booking(text, uuid, jsonb, uuid[]) from public;
grant execute on function public.check_gift_code(text), public.quote_gift_booking(text, uuid, jsonb, uuid[]) to anon, authenticated;

-- A cancelled booking gives its voucher back, so it can be used again (Vadim can mark it used in More › Gift vouchers if he keeps it).
create function public.gift_voucher_back()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.gift_voucher_id is not null and new.booking_status = 'cancelled' and old.booking_status is distinct from 'cancelled' then
    update public.gift_vouchers g set status = 'ready', booking_id = null, used_at = null where g.id = new.gift_voucher_id and g.status = 'used' and g.booking_id = new.id;
  end if;
  return null;
end; $$;
revoke all on function public.gift_voucher_back() from public, anon, authenticated;
create trigger bookings_gift_voucher_back after update of booking_status on public.bookings
  for each row execute function public.gift_voucher_back();

-- A client cannot change the length of a booking a voucher paid for online (moving it is fine), as 20261207100000 otherwise.
create or replace function public.client_change_check(b public.bookings, p_minutes integer)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.service_areas%rowtype;
begin
  if b.slot_offer_id is not null then
    raise exception 'This booking has a special price, so it can''t be changed online. Please message Vadim and he''ll sort it out.' using errcode = '22023';
  end if;
  if b.gift_voucher_id is not null and p_minutes is not null and p_minutes <> b.treatment_duration_minutes then
    raise exception 'This booking was paid with a gift voucher, so its length can''t be changed online. Please message Vadim and he''ll sort it out.' using errcode = '22023';
  end if;
  if b.booking_status not in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed') then
    raise exception 'This booking can no longer be changed online. Please contact Vad.' using errcode = 'PT409';
  end if;
  if ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp() then
    raise exception 'This appointment has already started. Please contact Vad.' using errcode = '22023';
  end if;
  if p_minutes is not null then
    select * into a from public.service_areas where id = b.service_area_id;
    if a.minimum_booking_minutes is not null and p_minutes < a.minimum_booking_minutes
       and not exists (select 1 from public.clients c where c.id = b.client_id and c.no_minimum_booking) then
      raise exception '%', format('In %s the minimum booking is %s in total. Please contact Vadim to make it shorter.',
        a.name, public.minimum_booking_words(a.minimum_booking_minutes)) using errcode = '22023';
    end if;
  end if;
end;
$$;
revoke all on function public.client_change_check(public.bookings, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Finishing a booking with a voucher code: 20261212100000's finalize_client_booking with p_gift_code added.
-- ---------------------------------------------------------------------------------------------
-- What Vadim and the client are told about a booking made with a gift voucher. The usual "New booking request … Waiting for payment"
-- is reworded, and when the voucher pays it all the client gets "Your appointment is booked" straight away.
create function public.gift_booking_messages(p_event uuid, p_booking uuid, v public.gift_vouchers, p_to_pay numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; v_name text; v_when text; v_where text; v_title text; v_body text;
begin
  select * into b from public.bookings where id = p_booking;
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
  v_name := coalesce(nullif(v_name, ''), 'A client');
  v_when := public.notification_when(b.date, b.start_minutes);
  v_where := concat_ws(', ', b.address_line_1_snapshot, b.city_snapshot, b.postcode_snapshot);
  if p_to_pay = 0 then
    v_title := 'New booking with a gift voucher';
    v_body := format('%s: %s, %s minutes. Paid by the gift voucher from %s (%s). Nothing to pay, it is confirmed.',
      v_name, v_when, b.treatment_duration_minutes, v.from_name, public.gift_code_shown(v.code));
  else
    v_title := 'New booking request with a gift voucher';
    v_body := format('%s: %s, %s minutes. The gift voucher from %s pays %s, %s left to pay. Waiting for payment.',
      v_name, v_when, b.treatment_duration_minutes, v.from_name, public.notification_money(b.gift_covered_gbp), public.notification_money(p_to_pay));
  end if;
  update public.notification_deliveries d set title = v_title, body = v_body
   where d.event_id = p_event and d.audience = 'admin';
  if p_to_pay = 0 and nullif(btrim(b.booking_email_snapshot), '') is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (p_event, 'email', 'client', btrim(b.booking_email_snapshot), 'Your appointment is booked',
      format('Your appointment is confirmed for %s (%s minutes) at %s.', v_when, b.treatment_duration_minutes, v_where)
      || E'\n' || format('Your gift voucher from %s pays for it, so there is nothing to pay.', v.from_name)
      || E'\n' || format('Reference: %s', b.booking_reference)
      || E'\n\nSee or change your booking: {link}\n\nWarm wishes,\nVadim', '/account?booking=' || b.id::text)
    on conflict do nothing;
  end if;
end; $$;
revoke all on function public.gift_booking_messages(uuid, uuid, public.gift_vouchers, numeric) from public, anon, authenticated;

drop function public.finalize_client_booking(uuid, uuid, text, uuid, jsonb, uuid[], uuid, text, text, text, text, text, text, text, text, text, text);
CREATE FUNCTION public.finalize_client_booking(p_hold_id uuid, p_hold_token uuid, p_hold_client_key text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[], p_saved_address_id uuid, p_address_line_1 text, p_address_line_2 text, p_city text, p_postcode text, p_entry_instructions text, p_client_note text, p_payment_method text, p_idempotency_key text, p_address text DEFAULT NULL::text, p_offer_code text DEFAULT NULL::text, p_gift_code text DEFAULT NULL::text)
 RETURNS TABLE(booking_id uuid, booking_reference text, booking_status text, payment_status text, total_gbp numeric, payment_reference text, saved_address_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := now();
  v_london_today date := (now() at time zone 'Europe/London')::date;
  v_london_now_minutes integer := (
    extract(hour from now() at time zone 'Europe/London')::integer * 60
    + extract(minute from now() at time zone 'Europe/London')::integer
  );
  v_user_id uuid := auth.uid();
  v_client public.clients%rowtype;
  v_hold public.booking_holds%rowtype;
  v_address public.client_addresses%rowtype;
  v_quote record;
  v_command public.command_requests%rowtype;
  v_command_id uuid;
  v_event_id uuid;
  v_scope text;
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text;
  v_enhancement_ids uuid[] := coalesce(p_enhancement_ids, '{}'::uuid[]);
  v_sorted_enhancement_ids text;
  v_booking_id uuid;
  v_booking_reference text;
  v_booking_status text;
  v_payment_status text;
  v_payment_reference text;
  v_is_returning boolean := false;
  v_active_future_count integer := 0;
  v_is_default_address boolean := false;
  v_address_text text;
  v_session jsonb;
  v_session_id uuid;
  v_service_id uuid;
  v_duration integer;
  v_recipient_name text;
  v_position integer := 0;
  v_unit_price numeric(10,2);
  v_service_name text;
  v_preference_ids uuid[];
  v_preference_count integer;
  v_enhancement_id uuid;
  v_enhancement public.enhancements%rowtype;
  -- A special-price offer (Vadim's link for one free time), or none.
  v_offer public.slot_offers%rowtype;
  v_offer_code text := upper(nullif(btrim(coalesce(p_offer_code, '')), ''));
  -- A gift voucher (20261214100000): what it pays and what is left to pay.
  v_gift public.gift_vouchers%rowtype;
  v_gift_code text := public.gift_code_clean(p_gift_code);
  v_gift_covered numeric(10,2) := 0;
  v_to_pay numeric(10,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if public.is_booking_admin() then
    raise exception 'Admin accounts must use the Admin booking contract'
      using errcode = '42501';
  end if;

  select c.*
  into v_client
  from public.clients c
  where c.auth_user_id = v_user_id
  for update;

  if not found then
    raise exception 'Client account is not activated'
      using errcode = '42501';
  end if;

  if not v_client.online_booking_enabled then
    raise exception 'Online booking is disabled for this client'
      using errcode = '42501';
  end if;

  if length(v_idempotency_key) < 8 or length(v_idempotency_key) > 200 then
    raise exception 'A valid idempotency key is required'
      using errcode = '22023';
  end if;

  if p_payment_method not in ('bank_transfer', 'cash') then
    raise exception 'Payment method must be bank_transfer or cash'
      using errcode = '22023';
  end if;

  if p_hold_id is null
     or p_hold_token is null
     or btrim(coalesce(p_hold_client_key, '')) = '' then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  select string_agg(e_id::text, ',' order by e_id::text)
  into v_sorted_enhancement_ids
  from unnest(v_enhancement_ids) e_id;

  v_scope := 'client-finalize:' || v_client.id::text;
  v_fingerprint := md5(concat_ws(
    '|',
    p_hold_id::text,
    p_hold_token::text,
    btrim(p_hold_client_key),
    p_service_area_id::text,
    p_sessions::text,
    coalesce(v_sorted_enhancement_ids, ''),
    coalesce(p_saved_address_id::text, ''),
    coalesce(btrim(p_address_line_1), ''),
    coalesce(btrim(p_address_line_2), ''),
    coalesce(btrim(p_city), ''),
    coalesce(upper(btrim(p_postcode)), ''),
    coalesce(btrim(p_entry_instructions), ''),
    coalesce(btrim(p_client_note), ''),
    p_payment_method,
    btrim(p_address),
    coalesce(v_offer_code, ''),
    coalesce(v_gift_code, '')
  ));

  perform pg_advisory_xact_lock(
    hashtext(v_scope || ':' || v_idempotency_key)
  );

  select cr.*
  into v_command
  from public.command_requests cr
  where cr.scope = v_scope
    and cr.idempotency_key = v_idempotency_key
  for update;

  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Idempotency key was already used for a different request'
        using errcode = '22023';
    end if;

    if v_command.status = 'succeeded' and v_command.result_reference is not null then
      return query
      select
        b.id,
        b.booking_reference,
        b.booking_status,
        bp.status,
        bp.amount_gbp,
        bp.payment_reference,
        b.saved_address_id
      from public.bookings b
      join public.booking_payments bp on bp.booking_id = b.id
      where b.id = v_command.result_reference::uuid;
      return;
    end if;

    raise exception 'Booking request is already in progress'
      using errcode = '40001';
  end if;

  select *
  into v_quote
  from public.compute_client_booking_quote(
    p_service_area_id,
    p_sessions,
    v_enhancement_ids
  );

  -- Match hold creation lock order: browser key first, then business date.
  perform pg_advisory_xact_lock(
    hashtext('booking-hold-client:' || btrim(p_hold_client_key))
  );

  select h.*
  into v_hold
  from public.booking_holds h
  where h.id = p_hold_id;

  if not found then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  perform pg_advisory_xact_lock(42420, hashtext(v_hold.date::text));

  select h.*
  into v_hold
  from public.booking_holds h
  where h.id = p_hold_id
  for update;

  if not found
     or v_hold.hold_token <> p_hold_token
     or v_hold.client_key is distinct from btrim(p_hold_client_key)
     or v_hold.status <> 'active'
     or v_hold.expires_at <= v_now
     or v_hold.treatment_duration_minutes <> v_quote.treatment_duration_minutes
     or v_hold.travel_buffer_minutes <> 60 then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  -- A special-price offer: the hold was made from the offer's link, and the offer is still open. Its price is the whole price (no travel fee,
  -- congestion charge or extras), for one person at the offer's length. A hold made from an offer can only be booked with it.
  if v_offer_code is not null or v_hold.slot_offer_id is not null then
    select o.* into v_offer from public.slot_offers o where o.id = v_hold.slot_offer_id for update;
    if not found or v_offer_code is null or v_offer.code <> v_offer_code then
      raise exception 'Time slot is no longer available'
        using errcode = '23P01';
    end if;
    if v_offer.status <> 'open' or v_offer.closes_at <= v_now then
      raise exception 'Sorry, this special time is no longer available.'
        using errcode = '23P01';
    end if;
    if jsonb_array_length(p_sessions) <> 1 or cardinality(v_enhancement_ids) > 0
       or v_offer.duration_minutes <> v_quote.treatment_duration_minutes
       or v_offer.date <> v_hold.date or v_offer.start_minutes <> v_hold.start_minutes then
      raise exception '%', format('This special price is for one person, %s minutes, with no extras.', v_offer.duration_minutes)
        using errcode = '22023';
    end if;
    v_quote.service_subtotal_gbp := v_offer.price_gbp;
    v_quote.enhancements_total_gbp := 0;
    -- The travel fee and congestion charge of the client's area are added only when Vadim ticked "Add travel fee" (20261210100000).
    if not v_offer.add_travel_fee then
      v_quote.travel_fee_gbp := 0;
      v_quote.congestion_fee_gbp := 0;
    end if;
    v_quote.total_gbp := v_offer.price_gbp + coalesce(v_quote.travel_fee_gbp, 0) + coalesce(v_quote.congestion_fee_gbp, 0);
  end if;

  -- A gift voucher pays one massage of its length for each of its people, and the travel fee and congestion charge up to what it covers.
  if v_gift_code is not null then
    if v_offer.id is not null then
      raise exception 'A gift voucher can''t be used with a special price.' using errcode = '22023';
    end if;
    v_gift := public.usable_gift_voucher(v_gift_code, p_sessions, true);
    v_gift_covered := least(v_quote.total_gbp, public.gift_cover_for(v_gift, p_sessions, v_quote.travel_fee_gbp, v_quote.congestion_fee_gbp));
  end if;
  v_to_pay := v_quote.total_gbp - v_gift_covered;

  if v_hold.date < v_london_today then
    raise exception 'Booking date cannot be in the past'
      using errcode = '22023';
  end if;

  if v_hold.date > v_london_today + public.business_setting_int('booking_horizon_days', 40) then
    raise exception '%', format('Online appointments can currently be arranged up to %s days ahead. Please choose an earlier date.', public.business_setting_int('booking_horizon_days', 40))
      using errcode = '22023';
  end if;

  -- An offer has its own closing time (checked above) instead of the usual notice.
  if v_offer.id is null and ((v_hold.date + make_interval(mins => v_hold.start_minutes)) at time zone 'Europe/London') < clock_timestamp() + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120)) then
    raise exception '%', format('Online appointments need at least %s notice. Please choose a later time.', public.notice_text(public.business_setting_int('minimum_notice_minutes', 120)))
      using errcode = '23P01';
  end if;

  -- Serialize client booking-limit decisions.
  perform pg_advisory_xact_lock(
    hashtext('client-booking-limit:' || v_client.id::text)
  );

  -- A returning client has had a paid visit. Vadim rarely presses Complete, so a confirmed visit
  -- whose time has passed counts too (client_has_paid_visit, 20261212100000).
  v_is_returning := public.client_has_paid_visit(v_client.id);

  select count(*)::integer
  into v_active_future_count
  from public.bookings b
  join public.booking_payments bp on bp.booking_id = b.id
  where b.client_id = v_client.id
    and b.booking_status in (
      'awaiting_transfer',
      'awaiting_payment_verification',
      'awaiting_cash_approval',
      'confirmed'
    )
    and bp.status not in ('rejected', 'refunded')
    and (
      b.date > v_london_today
      or (
        b.date = v_london_today
        and b.start_minutes > v_london_now_minutes
      )
    );

  if not v_is_returning and v_active_future_count >= public.business_setting_int('new_client_booking_limit', 1) then
    raise exception 'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.'
      using errcode = '22023';
  end if;

  if v_is_returning and v_active_future_count >= public.business_setting_int('returning_client_booking_limit', 5) then
    raise exception '%', format('You already have %s upcoming appointments. Please manage one of those appointments before adding another.', public.count_word(public.business_setting_int('returning_client_booking_limit', 5)))
      using errcode = '22023';
  end if;

  -- Exclude the caller's own hold from the shared availability calculation.
  -- Any later error rolls this update back with the rest of the transaction.
  update public.booking_holds h
  set
    status = 'consumed',
    client_id = v_client.id
  where h.id = v_hold.id;

  -- An offer's time is one Vadim chose himself, so it need not be one of the usual times: it must only not overlap another appointment.
  if v_offer.id is not null then
    if public.admin_time_clash(v_hold.date, v_hold.start_minutes, v_hold.treatment_duration_minutes, v_now) then
      raise exception 'Sorry, this special time is no longer available.'
        using errcode = '23P01';
    end if;
  elsif not exists (
    select 1
    from public.compute_booking_availability(
      v_hold.date,
      v_hold.treatment_duration_minutes,
      v_now,
      v_hold.travel_buffer_minutes
    ) a
    where a.start_minutes = v_hold.start_minutes
  ) then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  if p_saved_address_id is not null then
    select a.*
    into v_address
    from public.client_addresses a
    where a.id = p_saved_address_id
      and a.client_id = v_client.id
    for update;

    if not found then
      raise exception 'Saved address is not available to this client'
        using errcode = '42501';
    end if;
  else
    -- The address as one text (the new screens), or put together from its parts (the old ones).
    v_address_text := public.clean_address(coalesce(p_address, concat_ws(', ', nullif(btrim(p_address_line_1), ''), nullif(btrim(p_address_line_2), ''),
      nullif(btrim(p_city), ''), upper(nullif(btrim(p_postcode), '')))));
    if p_address is not null then
      if v_address_text is null then
        raise exception 'A complete booking address is required'
          using errcode = '22023';
      end if;
    elsif nullif(btrim(p_address_line_1), '') is null
       or nullif(btrim(p_city), '') is null
       or nullif(btrim(p_postcode), '') is null then
      raise exception 'A complete booking address is required'
        using errcode = '22023';
    end if;
    if length(v_address_text) > 400 then
      raise exception 'That address is too long'
        using errcode = '22023';
    end if;

    select a.*
    into v_address
    from public.client_addresses a
    where a.client_id = v_client.id
      and a.normalized_address = lower(regexp_replace(v_address_text, '[^a-zA-Z0-9]+', '', 'g'))
    order by a.is_default desc, a.created_at
    limit 1;

    if not found then
      select not exists (
        select 1
        from public.client_addresses existing
        where existing.client_id = v_client.id
      )
      into v_is_default_address;

      insert into public.client_addresses (
        client_id,
        label,
        address,
        address_line_1,
        address_line_2,
        city,
        postcode,
        normalized_postcode,
        entry_instructions,
        is_default
      )
      values (
        v_client.id,
        case when v_is_default_address then 'Home' else 'Saved address' end,
        v_address_text,
        case when p_address is null then btrim(p_address_line_1) end,
        case when p_address is null then nullif(btrim(p_address_line_2), '') end,
        case when p_address is null then btrim(p_city) end,
        case when p_address is null then upper(btrim(p_postcode)) end,
        case when p_address is null then regexp_replace(upper(btrim(p_postcode)), '[^A-Z0-9]+', '', 'g') end,
        nullif(btrim(p_entry_instructions), ''),
        v_is_default_address
      )
      returning * into v_address;
    end if;
  end if;

  insert into public.command_requests (
    scope,
    idempotency_key,
    source_channel,
    actor_type,
    actor_id,
    command_type,
    request_fingerprint,
    status
  )
  values (
    v_scope,
    v_idempotency_key,
    'web',
    'client',
    v_user_id::text,
    'finalize_client_booking',
    v_fingerprint,
    'started'
  )
  returning id into v_command_id;

  v_booking_id := gen_random_uuid();
  v_booking_reference :=
    'VDM-'
    || to_char(v_now at time zone 'UTC', 'YYYYMMDDHH24MISS')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  if v_gift.id is not null and v_to_pay = 0 then
    -- Fully paid by the voucher: booked straight away, nothing to pay.
    v_booking_status := 'confirmed';
    v_payment_status := 'paid';
  elsif p_payment_method = 'bank_transfer' then
    v_booking_status := 'awaiting_transfer';
    v_payment_status := 'awaiting_transfer';
  else
    v_booking_status := 'awaiting_cash_approval';
    v_payment_status := 'awaiting_approval';
  end if;

  v_payment_reference := v_booking_reference;

  insert into public.bookings (
    id,
    booking_reference,
    client_id,
    saved_address_id,
    service_area_id,
    date,
    start_minutes,
    treatment_duration_minutes,
    travel_buffer_minutes,
    booking_status,
    source_channel,
    created_by_actor_type,
    created_by_actor_id,
    address_line_1_snapshot,
    address_line_2_snapshot,
    city_snapshot,
    postcode_snapshot,
    address_snapshot,
    entry_instructions_snapshot,
    service_area_name_snapshot,
    service_subtotal_gbp,
    enhancements_total_gbp,
    travel_fee_gbp,
    congestion_fee_gbp,
    total_gbp,
    booking_email_snapshot,
    payment_reservation_expires_at,
    client_note,
    slot_offer_id,
    gift_voucher_id,
    gift_covered_gbp
  )
  values (
    v_booking_id,
    v_booking_reference,
    v_client.id,
    v_address.id,
    p_service_area_id,
    v_hold.date,
    v_hold.start_minutes,
    v_quote.treatment_duration_minutes,
    v_hold.travel_buffer_minutes,
    v_booking_status,
    'web',
    'client',
    v_user_id::text,
    v_address.address_line_1,
    v_address.address_line_2,
    v_address.city,
    v_address.postcode,
    v_address.address,
    v_address.entry_instructions,
    v_quote.service_area_name,
    v_quote.service_subtotal_gbp,
    v_quote.enhancements_total_gbp,
    v_quote.travel_fee_gbp,
    v_quote.congestion_fee_gbp,
    v_quote.total_gbp,
    v_client.email,
    null,
    nullif(btrim(p_client_note), ''),
    v_offer.id,
    v_gift.id,
    v_gift_covered
  );

  if v_gift.id is not null then
    update public.gift_vouchers g set status = 'used', booking_id = v_booking_id, used_at = v_now where g.id = v_gift.id;
  end if;

  if v_offer.id is not null then
    update public.slot_offers o set status = 'booked', booking_id = v_booking_id, updated_at = v_now where o.id = v_offer.id;
  end if;

  for v_session in
    select value
    from jsonb_array_elements(p_sessions)
  loop
    v_position := v_position + 1;
    v_service_id := (v_session ->> 'service_id')::uuid;
    v_duration := (v_session ->> 'duration_minutes')::integer;
    v_recipient_name := nullif(btrim(v_session ->> 'recipient_name'), '');

    if v_recipient_name is not null and length(v_recipient_name) > 120 then
      raise exception 'Session recipient name is too long'
        using errcode = '22023';
    end if;

    select s.name, p.price_gbp
    into v_service_name, v_unit_price
    from public.services s
    join public.service_duration_prices p
      on p.service_id = s.id
    where s.id = v_service_id
      and s.active
      and p.duration_minutes = v_duration
      and p.active;

    if v_offer.id is not null then
      v_unit_price := v_offer.price_gbp;
    end if;

    insert into public.booking_sessions (
      booking_id,
      position,
      service_id,
      duration_minutes,
      service_name_snapshot,
      unit_price_gbp,
      recipient_name
    )
    values (
      v_booking_id,
      v_position,
      v_service_id,
      v_duration,
      v_service_name,
      v_unit_price,
      v_recipient_name
    )
    returning id into v_session_id;

    if v_session ? 'preference_ids' then
      if jsonb_typeof(v_session -> 'preference_ids') <> 'array' then
        raise exception 'Session preferences must be an array'
          using errcode = '22023';
      end if;

      select coalesce(array_agg(pref_id), '{}'::uuid[])
      into v_preference_ids
      from (
        select value::uuid as pref_id
        from jsonb_array_elements_text(v_session -> 'preference_ids')
      ) pref;

      select count(distinct pref_id)::integer
      into v_preference_count
      from unnest(v_preference_ids) pref_id;

      if v_preference_count <> cardinality(v_preference_ids) then
        raise exception 'Session preference selection contains duplicates'
          using errcode = '22023';
      end if;

      if (
        select count(*)::integer
        from public.session_preferences sp
        where sp.id = any(v_preference_ids)
          and sp.active
      ) <> cardinality(v_preference_ids) then
        raise exception 'Selected session preference is no longer available'
          using errcode = '22023';
      end if;

      if exists (
        select 1
        from public.session_preference_conflicts c
        where c.preference_id = any(v_preference_ids)
          and c.conflicting_preference_id = any(v_preference_ids)
      ) then
        raise exception 'Selected session preferences conflict'
          using errcode = '22023';
      end if;

      insert into public.booking_session_preferences (
        booking_session_id,
        preference_id,
        preference_label_snapshot,
        preference_category_snapshot
      )
      select
        v_session_id,
        sp.id,
        sp.label,
        sp.category
      from public.session_preferences sp
      where sp.id = any(v_preference_ids);
    end if;
  end loop;

  foreach v_enhancement_id in array v_enhancement_ids
  loop
    select e.*
    into v_enhancement
    from public.enhancements e
    where e.id = v_enhancement_id
      and e.active;

    insert into public.booking_enhancements (
      booking_id,
      enhancement_id,
      enhancement_name_snapshot,
      quantity,
      unit_price_gbp,
      duration_minutes_snapshot
    )
    values (
      v_booking_id,
      v_enhancement.id,
      v_enhancement.name,
      1,
      v_enhancement.price_gbp,
      0
    );
  end loop;

  insert into public.booking_payments (
    booking_id,
    method,
    status,
    amount_gbp,
    payment_reference,
    paid_at
  )
  values (
    v_booking_id,
    case when v_payment_status = 'paid' then 'bank_transfer' else p_payment_method end,
    v_payment_status,
    v_to_pay,
    v_payment_reference,
    case when v_payment_status = 'paid' then v_now end
  );

  insert into public.event_outbox (
    event_type,
    aggregate_type,
    aggregate_id,
    source_command_id,
    deduplication_key,
    payload
  )
  values (
    'booking.created',
    'booking',
    v_booking_id,
    v_command_id,
    'booking.created:' || v_booking_id::text,
    jsonb_build_object(
      'booking_id', v_booking_id,
      'booking_reference', v_booking_reference,
      'client_id', v_client.id,
      'booking_status', v_booking_status,
      'payment_status', v_payment_status,
      'date', v_hold.date,
      'start_minutes', v_hold.start_minutes,
      'total_gbp', v_quote.total_gbp,
      'gift_voucher_id', v_gift.id,
      'gift_covered_gbp', v_gift_covered,
      'to_pay_gbp', v_to_pay
    )
  )
  returning id into v_event_id;

  if v_gift.id is not null then
    perform public.gift_booking_messages(v_event_id, v_booking_id, v_gift, v_to_pay);
  end if;

  update public.command_requests cr
  set
    status = 'succeeded',
    result_reference = v_booking_id::text,
    completed_at = v_now
  where cr.id = v_command_id;

  return query
  select
    v_booking_id,
    v_booking_reference,
    v_booking_status,
    v_payment_status,
    v_to_pay::numeric(10,2),
    v_payment_reference,
    v_address.id;
end;
$function$;

revoke all on function public.finalize_client_booking(uuid, uuid, text, uuid, jsonb, uuid[], uuid, text, text, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.finalize_client_booking(uuid, uuid, text, uuid, jsonb, uuid[], uuid, text, text, text, text, text, text, text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. Changing a booking paid partly by a voucher: the voucher's part counts as already held (20261204100000's booking_change_plan).
-- ---------------------------------------------------------------------------------------------
create or replace function public.booking_change_plan(b public.bookings, p public.booking_payments, p_sessions jsonb, p_lower_price boolean, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.booking_sessions%rowtype;
  v_item jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_ids uuid[] := '{}'::uuid[];
  v_id uuid;
  v_service uuid;
  v_duration integer;
  v_recipient text;
  v_name text;
  v_price numeric(10,2);
  v_position integer := 0;
  v_minutes integer := 0;
  v_list_sessions numeric(10,2) := 0;
  v_extras numeric(10,2);
  v_list_total numeric(10,2);
  v_total numeric(10,2);
  v_inside boolean;
  v_changed boolean := false;
  -- A gift voucher's part counts as money already held towards the booking (20261214100000).
  v_gift numeric(10,2) := coalesce(b.gift_covered_gbp, 0);
  v_amount numeric(10,2) := p.amount_gbp + coalesce(b.gift_covered_gbp, 0);
  v_refund numeric(10,2) := coalesce(b.refund_due_gbp, 0);
  v_balance numeric(10,2) := 0;
  v_back numeric(10,2);
  v_held boolean := p.status in ('paid', 'awaiting_verification');
begin
  if p_sessions is null or jsonb_typeof(p_sessions) <> 'array' or octet_length(p_sessions::text) > 16000 then
    raise exception 'Missing command arguments' using errcode = '22023';
  end if;
  if jsonb_array_length(p_sessions) not between 1 and 4 then
    raise exception 'A booking is for one to four people.' using errcode = '22023';
  end if;
  if (select count(*) from public.booking_sessions x where x.booking_id = b.id) <> jsonb_array_length(p_sessions) then v_changed := true; end if;
  for v_item in select value from jsonb_array_elements(p_sessions) loop
    v_position := v_position + 1;
    if jsonb_typeof(v_item) <> 'object' or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id', 'service_id', 'duration_minutes', 'recipient_name')) then
      raise exception 'Missing command arguments' using errcode = '22023';
    end if;
    begin
      v_id := nullif(v_item->>'id', '')::uuid;
      v_service := nullif(v_item->>'service_id', '')::uuid;
      v_duration := nullif(v_item->>'duration_minutes', '')::integer;
    exception when invalid_text_representation then
      raise exception 'Missing command arguments' using errcode = '22023';
    end;
    v_recipient := nullif(btrim(coalesce(v_item->>'recipient_name', '')), '');
    if v_service is null then raise exception 'Choose a treatment for each person.' using errcode = '22023'; end if;
    if v_duration is null or v_duration not in (60, 90, 120) then
      raise exception 'Choose 60, 90 or 120 minutes for each person.' using errcode = '22023';
    end if;
    if length(v_recipient) > 120 then raise exception 'Keep each name under 120 characters.' using errcode = '22023'; end if;
    s := null;
    if v_id is not null then
      if v_id = any(v_ids) then raise exception 'Missing command arguments' using errcode = '22023'; end if;
      select * into s from public.booking_sessions x where x.id = v_id and x.booking_id = b.id;
      if not found then raise exception 'Booking state changed' using errcode = 'PT409'; end if;
      v_ids := v_ids || v_id;
    end if;
    if s.id is not null and s.service_id = v_service and s.duration_minutes = v_duration then
      -- Unchanged: the price it was booked at.
      v_name := s.service_name_snapshot; v_price := s.unit_price_gbp;
    else
      select sv.name, d.price_gbp into v_name, v_price
        from public.services sv join public.service_duration_prices d on d.service_id = sv.id
       where sv.id = v_service and d.duration_minutes = v_duration and sv.active and d.active;
      if not found then
        raise exception '%', format('That treatment is not offered for %s minutes. Choose another length or treatment.', v_duration) using errcode = '22023';
      end if;
    end if;
    if s.id is null or s.service_id <> v_service or s.duration_minutes <> v_duration or s.position <> v_position
       or s.recipient_name is distinct from v_recipient then
      v_changed := true;
    end if;
    v_minutes := v_minutes + v_duration;
    v_list_sessions := v_list_sessions + v_price;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', v_id, 'service_id', v_service, 'duration_minutes', v_duration,
      'recipient_name', v_recipient, 'name', v_name, 'price', v_price));
  end loop;
  if v_minutes > 240 then raise exception 'One visit can be up to 4 hours in all.' using errcode = '22023'; end if;

  -- Extras chosen for a person who is removed go with them; extras for the visit, travel and congestion stay as booked.
  v_extras := greatest(b.enhancements_total_gbp - coalesce((select sum(se.unit_price_gbp * se.quantity) from public.booking_session_enhancements se
    join public.booking_sessions x on x.id = se.booking_session_id where x.booking_id = b.id and not (x.id = any(v_ids))), 0), 0);
  v_list_total := v_list_sessions + v_extras + b.travel_fee_gbp + b.congestion_fee_gbp;
  -- Inside the free-cancellation window (the same rule, grace period included, as a late fee): never below the price it has now.
  v_inside := public.late_fee_standard_gbp(1, b.date, b.start_minutes, b.created_at, p_now) > 0;
  v_total := case when v_inside and not coalesce(p_lower_price, false) then greatest(v_list_total, b.total_gbp) else v_list_total end;

  -- The money. Not paid yet: the amount to pay is the new price. Paid, or sent by transfer: the payment stands at what is held towards
  -- this booking; a lower price makes the rest a refund to send, a higher one first takes back a refund not yet sent, then the rest is
  -- still to pay.
  if p.id is not null and v_held then
    if v_total < v_amount then
      v_refund := v_refund + (v_amount - v_total); v_amount := v_total;
    elsif v_total > v_amount then
      v_back := least(v_refund, v_total - v_amount);
      v_refund := v_refund - v_back; v_amount := v_amount + v_back;
      v_balance := v_total - v_amount;
    end if;
  elsif p.id is not null then
    v_amount := v_total;
  end if;

  return jsonb_build_object('rows', v_rows, 'kept_ids', to_jsonb(v_ids), 'minutes', v_minutes, 'changed', v_changed,
    'service_subtotal_gbp', v_total - v_extras - b.travel_fee_gbp - b.congestion_fee_gbp, 'list_sessions_gbp', v_list_sessions,
    'enhancements_total_gbp', v_extras, 'list_total_gbp', v_list_total, 'total_gbp', v_total, 'previous_total_gbp', b.total_gbp,
    'inside_window', v_inside, 'price_kept', v_total > v_list_total,
    'free_cancellation_hours', public.business_setting_int('free_cancellation_hours', 24),
    'payment_method', p.method, 'payment_status', p.status, 'held', p.id is not null and v_held,
    'amount_gbp', greatest(v_amount - v_gift, 0), 'previous_amount_gbp', p.amount_gbp,
    'refund_due_gbp', v_refund, 'previous_refund_due_gbp', coalesce(b.refund_due_gbp, 0),
    'balance_due_gbp', v_balance, 'previous_balance_due_gbp', coalesce(b.balance_due_gbp, 0));
end;
$$;
revoke all on function public.booking_change_plan(public.bookings, public.booking_payments, jsonb, boolean, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 9. The client's booking page: what a gift voucher paid, and from whom (20261204100000's get_my_booking with two more keys).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_result jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select jsonb_build_object(
  'id',b.id,'booking_reference',b.booking_reference,'booking_status',b.booking_status,
  'booking_email_snapshot',b.booking_email_snapshot,'date',b.date,'start_minutes',b.start_minutes,
  'treatment_duration_minutes',b.treatment_duration_minutes,'total_gbp',b.total_gbp,
  'service_area_name_snapshot',b.service_area_name_snapshot,
  'address_line_1_snapshot',b.address_line_1_snapshot,'address_line_2_snapshot',b.address_line_2_snapshot,
  'city_snapshot',b.city_snapshot,'postcode_snapshot',b.postcode_snapshot,'address_snapshot',b.address_snapshot,'area_check',b.area_check,
  'late_fee_status',b.late_fee_status,'late_fee_due_gbp',b.late_fee_due_gbp,'refund_due_gbp',b.refund_due_gbp,'balance_due_gbp',b.balance_due_gbp,
  'cancelled_at',b.cancelled_at,
  'gift_covered_gbp',b.gift_covered_gbp,'gift_from',(select g.from_name from public.gift_vouchers g where g.id=b.gift_voucher_id),
  'booking_sessions',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'service_id',s.service_id,'position',s.position,'duration_minutes',s.duration_minutes,
    'recipient_name',s.recipient_name,'service_name_snapshot',s.service_name_snapshot,'unit_price_gbp',s.unit_price_gbp) order by s.position),'[]'::jsonb)
    from public.booking_sessions s where s.booking_id=b.id),
  'booking_payments',jsonb_build_object('method',p.method,'status',p.status,'payment_reference',p.payment_reference,
    'transfer_declared_at',p.transfer_declared_at,'amount_gbp',p.amount_gbp),
  'pay_after_session',(select jsonb_build_object('id',e.id,'date',e.date,'start_minutes',e.start_minutes,'booking_status',e.booking_status,
      'auto_confirm',public.auto_confirm_later_sessions())
    from public.bookings e where e.id=b.pay_after_booking_id),
  'earlier_session',case when b.pay_after_booking_id is null and b.booking_status='awaiting_transfer' and p.status='awaiting_transfer'
      and p.method='bank_transfer' and b.area_check is null then
    (select jsonb_build_object('id',e.id,'date',e.date,'start_minutes',e.start_minutes,'booking_status',e.booking_status,
      'auto_confirm',public.auto_confirm_later_sessions())
      from public.bookings e where e.id=public.earlier_session_to_pay_first(b.id)) end
 ) into v_result from public.bookings b join public.clients c on c.id=b.client_id
 join public.booking_payments p on p.booking_id=b.id
 where b.id=p_booking_id and (c.auth_user_id=auth.uid()
   or (c.id::text=coalesce(auth.jwt()->>'link_client','') and b.id::text=coalesce(auth.jwt()->>'link_booking','')));
 if v_result is null then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 return v_result;
end; $function$;

-- ---------------------------------------------------------------------------------------------
-- 10. An area's minimum booking does not apply to a gift voucher's booking: the voucher was sold for its length
--     (20261207100000's check_booking_minimum, which skips special-price offers, with the gift voucher added).
-- ---------------------------------------------------------------------------------------------
create or replace function public.check_booking_minimum()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_area public.service_areas%rowtype;
begin
  if new.created_by_actor_type is distinct from 'client' or new.slot_offer_id is not null or new.gift_voucher_id is not null then return new; end if;
  select * into v_area from public.service_areas where id = new.service_area_id;
  if v_area.minimum_booking_minutes is null or new.treatment_duration_minutes >= v_area.minimum_booking_minutes then return new; end if;
  if exists (select 1 from public.clients c where c.id = new.client_id and c.no_minimum_booking) then return new; end if;
  raise exception '%', format('In %s the minimum booking is %s in total (two people''s times add up). Please choose a longer time.',
      v_area.name, public.minimum_booking_words(v_area.minimum_booking_minutes))
    using errcode = '22023';
end; $$;
revoke all on function public.check_booking_minimum() from public, anon, authenticated;
