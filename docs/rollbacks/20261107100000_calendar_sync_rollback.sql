-- Takes back migration 20261107100000_calendar_sync.sql. Run by hand in the Supabase SQL editor only if the Google Calendar copy is to be
-- removed. Bookings are not touched. First disconnect from the Calendar settings screen (that revokes the token at Google); this then
-- deletes the stored token from Vault and drops what the migration added. The "VadMassage bookings" calendar stays in Google, to delete by hand.
begin;
delete from vault.secrets where id in (select refresh_token_secret_id from public.calendar_connection where refresh_token_secret_id is not null);
drop trigger if exists bookings_calendar_sync on public.bookings;
drop trigger if exists booking_sessions_calendar_sync on public.booking_sessions;
drop trigger if exists clients_calendar_sync on public.clients;
drop function if exists public.admin_calendar_resync();
drop function if exists public.admin_calendar_status();
drop function if exists public.calendar_forget_connection(text, text);
drop function if exists public.calendar_refresh_token();
drop function if exists public.calendar_save_connection(text, text, text);
drop function if exists public.complete_calendar_sync(uuid, timestamptz, text);
drop function if exists public.claim_calendar_sync(integer);
drop function if exists public.calendar_desired_events(date, date, uuid[]);
drop function if exists public.calendar_queue_client();
drop function if exists public.calendar_queue_session();
drop function if exists public.calendar_queue_booking();
drop function if exists public.calendar_queue_out_of_step();
drop function if exists public.calendar_queue_all(boolean);
drop function if exists public.queue_calendar_sync(uuid[], boolean);
drop table if exists public.calendar_sync_queue;
drop table if exists public.calendar_sync_events;
drop table if exists public.calendar_connection;
commit;
