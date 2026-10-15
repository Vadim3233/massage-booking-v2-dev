-- VAD Massage Booking V2
-- A private link to one booking.
--
-- The email a client gets ("See or change your booking") used to open only for a browser that was signed in as that client. A guest
-- who opens it on another phone, in a mail app's own browser, or while signed in as someone else could not see the booking. Now the
-- link carries a private code that opens that one booking, on any device, with no sign-in, and lets the client change or cancel it
-- exactly as the signed-in page does.
--
-- How it is kept safe:
--  * The code is long and random (about 244 bits), made when the email is sent, and only a hash of it is kept, so nothing in the
--    database can be turned back into a working link. It belongs to one booking and lapses 30 days after the appointment.
--  * Anyone holding the link can open that booking, change or cancel it, as with any booking link in an email. It does not show
--    their other bookings or addresses, and it does not sign anyone in.
--  * The calls that take a code give one plain answer for a wrong, expired or unknown code, so they reveal nothing.
--  * Changing or cancelling runs the very same functions as the signed-in page (the late fee, the notice, the availability rules
--    are untouched); the code only decides whose booking the call is for.
--  * A code proves one booking, not everything its client has, and it only lasts for the one call: who the caller was is put back
--    as soon as the call has finished, so nothing in the same transaction can go on acting as the client.

-- ---------------------------------------------------------------------------------------------
-- 1. The codes
-- ---------------------------------------------------------------------------------------------
create table public.booking_access_tokens (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index booking_access_tokens_booking_idx on public.booking_access_tokens (booking_id);
alter table public.booking_access_tokens enable row level security;
revoke all on table public.booking_access_tokens from public;
revoke all on table public.booking_access_tokens from anon;
revoke all on table public.booking_access_tokens from authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Making a code (the email sender only)
-- ---------------------------------------------------------------------------------------------
-- Called by the sender just before an email goes, with the service key. It returns the code once; only its hash is stored.
create function public.mint_booking_access_token(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_token text;
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id;
  if not found then
    raise exception 'Booking unavailable' using errcode = 'P0002';
  end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.booking_access_tokens(booking_id, token_hash, expires_at)
  values (v_booking.id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    greatest(clock_timestamp() + interval '30 days', ((v_booking.date + make_interval(mins => v_booking.start_minutes)) at time zone 'Europe/London') + interval '30 days'));
  -- Old codes are tidied away whenever a new one is made.
  delete from public.booking_access_tokens t where t.expires_at < clock_timestamp() - interval '7 days';
  return v_token;
end;
$$;
revoke all on function public.mint_booking_access_token(uuid) from public, anon, authenticated;
grant execute on function public.mint_booking_access_token(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Checking a code (inside only)
-- ---------------------------------------------------------------------------------------------
-- Finds the client a booking and code belong to and makes the call act as that client, for that one booking: the same way a signed-in
-- client's call does, so the functions below run unchanged. It says the same thing for every kind of failure. Whoever calls it must
-- put the caller back afterwards (booking_link_end); every function below does.
create function public.booking_link_client(p_booking_id uuid, p_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if p_booking_id is not null and p_key is not null and length(p_key) between 32 and 128 then
    select b.client_id into v_client
    from public.booking_access_tokens t join public.bookings b on b.id = t.booking_id
    where t.booking_id = p_booking_id
      and t.token_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
      and t.expires_at > clock_timestamp();
  end if;
  if v_client is null then
    raise exception 'This link is not valid or has expired. Please contact Vad.' using errcode = '42501';
  end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_client, 'role', 'authenticated', 'link_client', v_client, 'link_booking', p_booking_id)::text, true);
  perform set_config('request.jwt.claim.sub', v_client::text, true);
  return v_client;
end;
$$;
revoke all on function public.booking_link_client(uuid, text) from public, anon, authenticated, service_role;

-- Puts the caller back as they were before booking_link_client, so a link call is exactly one call and nothing after it in the
-- same transaction acts as the client. (Both settings are for this transaction only, as they are when made.)
create function public.booking_link_end(p_claims text, p_sub text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
end;
$$;
revoke all on function public.booking_link_end(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. What a client with the link can do: the same five things the signed-in page does
-- ---------------------------------------------------------------------------------------------
create function public.booking_by_key(p_booking_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_result jsonb;
begin
  perform public.booking_link_client(p_booking_id, p_key);
  v_result := public.get_my_booking(p_booking_id);
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end;
$$;

create function public.change_terms_by_key(p_booking_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_result jsonb;
begin
  perform public.booking_link_client(p_booking_id, p_key);
  v_result := public.get_my_change_terms(p_booking_id);
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end;
$$;

create function public.availability_by_key(p_booking_id uuid, p_key text, p_date date)
returns table(start_minutes integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  perform public.booking_link_client(p_booking_id, p_key);
  return query select a.start_minutes from public.get_my_booking_availability(p_booking_id, p_date) a;
  perform public.booking_link_end(v_claims, v_sub);
end;
$$;

create function public.cancel_by_key(p_booking_id uuid, p_key text, p_request_id uuid, p_acknowledged_fee numeric, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_result jsonb;
begin
  perform public.booking_link_client(p_booking_id, p_key);
  v_result := public.client_cancel_booking(p_booking_id, p_request_id, p_acknowledged_fee, p_reason);
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end;
$$;

create function public.reschedule_by_key(p_booking_id uuid, p_key text, p_request_id uuid, p_new_date date, p_new_start_minutes integer, p_acknowledged_fee numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_result jsonb;
begin
  perform public.booking_link_client(p_booking_id, p_key);
  v_result := public.client_reschedule_booking(p_booking_id, p_request_id, p_new_date, p_new_start_minutes, p_acknowledged_fee);
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end;
$$;

revoke all on function public.booking_by_key(uuid, text) from public;
revoke all on function public.change_terms_by_key(uuid, text) from public;
revoke all on function public.availability_by_key(uuid, text, date) from public;
revoke all on function public.cancel_by_key(uuid, text, uuid, numeric, text) from public;
revoke all on function public.reschedule_by_key(uuid, text, uuid, date, integer, numeric) from public;
grant execute on function public.booking_by_key(uuid, text) to anon, authenticated;
grant execute on function public.change_terms_by_key(uuid, text) to anon, authenticated;
grant execute on function public.availability_by_key(uuid, text, date) to anon, authenticated;
grant execute on function public.cancel_by_key(uuid, text, uuid, numeric, text) to anon, authenticated;
grant execute on function public.reschedule_by_key(uuid, text, uuid, date, integer, numeric) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. The two functions the others lean on learn to act for a link
-- ---------------------------------------------------------------------------------------------
-- Both used to find the booking only through the signed-in user. They now also accept the one booking a private link has just
-- proved, for the client it belongs to (see booking_link_client); everything else in them is as it was.

create or replace function public.client_booking_for_change(p_booking_id uuid)
returns public.bookings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- The signed-in client's own booking, or the one booking a private link has just shown belongs to whoever holds it
  -- (booking_link_client sets link_client and link_booking for that one call; a signed-in caller cannot add those claims).
  select bk.* into b from public.bookings bk join public.clients c on c.id = bk.client_id
    where bk.id = p_booking_id and (c.auth_user_id = auth.uid()
      or (c.id::text = coalesce(auth.jwt()->>'link_client', '') and bk.id::text = coalesce(auth.jwt()->>'link_booking', '')));
  if not found then raise exception 'Booking is not available to this client' using errcode = '42501'; end if;
  return b;
end;
$$;

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
  'city_snapshot',b.city_snapshot,'postcode_snapshot',b.postcode_snapshot,
  'late_fee_status',b.late_fee_status,'late_fee_due_gbp',b.late_fee_due_gbp,'refund_due_gbp',b.refund_due_gbp,
  'cancelled_at',b.cancelled_at,
  'booking_sessions',(select coalesce(jsonb_agg(jsonb_build_object('position',s.position,'duration_minutes',s.duration_minutes,
    'recipient_name',s.recipient_name,'service_name_snapshot',s.service_name_snapshot) order by s.position),'[]'::jsonb)
    from public.booking_sessions s where s.booking_id=b.id),
  'booking_payments',jsonb_build_object('method',p.method,'status',p.status,'payment_reference',p.payment_reference,
    'transfer_declared_at',p.transfer_declared_at)
 ) into v_result from public.bookings b join public.clients c on c.id=b.client_id
 join public.booking_payments p on p.booking_id=b.id
 where b.id=p_booking_id and (c.auth_user_id=auth.uid()
   or (c.id::text=coalesce(auth.jwt()->>'link_client','') and b.id::text=coalesce(auth.jwt()->>'link_booking','')));
 if v_result is null then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 return v_result;
end; $function$;
