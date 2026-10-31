-- VAD Massage Booking V2
-- What a client's AI assistant may do is now enforced by the database, not only by the connector (ADR-085).
--
-- An assistant signs in as the client through Supabase's OAuth server, and its token works on the whole database API, not only through
-- the /mcp connector. The consent page promises it cannot move or cancel bookings, and the connector leaves new addresses to the app, so:
--   1. A booking cannot be cancelled, moved or made longer or shorter with an assistant's sign-in (its token carries client_id).
--   2. An assistant's sign-in cannot add, change or delete saved addresses.
-- Also here: a client the Admin has stopped from booking online can no longer change or delete saved addresses (adding was already refused).

create function public.request_is_ai_assistant()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'client_id', '') <> '';
$$;
revoke all on function public.request_is_ai_assistant() from public, anon;
grant execute on function public.request_is_ai_assistant() to authenticated, service_role;

create function public.refuse_ai_assistant_booking_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.request_is_ai_assistant() and (
       (new.booking_status = 'cancelled' and old.booking_status is distinct from 'cancelled')
       or new.date is distinct from old.date
       or new.start_minutes is distinct from old.start_minutes
       or new.treatment_duration_minutes is distinct from old.treatment_duration_minutes) then
    raise exception 'Please move or cancel this booking in the VadMassage app.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.refuse_ai_assistant_booking_change() from public, anon, authenticated;

drop trigger if exists bookings_refuse_ai_assistant_change on public.bookings;
create trigger bookings_refuse_ai_assistant_change
before update on public.bookings
for each row execute function public.refuse_ai_assistant_booking_change();

alter policy "clients can add own addresses" on public.client_addresses
with check (
  not public.request_is_ai_assistant()
  and exists (
    select 1 from public.clients
    where clients.id = client_addresses.client_id and clients.auth_user_id = auth.uid() and clients.online_booking_enabled
  )
);

alter policy "clients can update own addresses" on public.client_addresses
using (
  not public.request_is_ai_assistant()
  and exists (
    select 1 from public.clients
    where clients.id = client_addresses.client_id and clients.auth_user_id = auth.uid() and clients.online_booking_enabled
  )
)
with check (
  not public.request_is_ai_assistant()
  and exists (
    select 1 from public.clients
    where clients.id = client_addresses.client_id and clients.auth_user_id = auth.uid() and clients.online_booking_enabled
  )
);

alter policy "clients can delete own addresses" on public.client_addresses
using (
  not public.request_is_ai_assistant()
  and exists (
    select 1 from public.clients
    where clients.id = client_addresses.client_id and clients.auth_user_id = auth.uid() and clients.online_booking_enabled
  )
);
