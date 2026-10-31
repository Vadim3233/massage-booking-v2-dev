-- VAD Massage Booking V2
-- Signed-in users keep only the table permissions the app uses (ADR-091; ADR-075 left this "for later").
--
-- The explicit grants (20261111100000_explicit_table_grants.sql) wrote down what Supabase had granted automatically, including TRUNCATE,
-- TRIGGER, REFERENCES and MAINTAIN for signed-in users on 18 tables, and INSERT, UPDATE and DELETE on tables only the database functions
-- write. Row security blocked every use of them today, but TRUNCATE ignores row security, so any future path that let a signed-in user run
-- SQL would have emptied the clients or bookings tables. None of these is used by the app; the Admin's own direct edits (catalogue,
-- clients, addresses, notes, hours, blocked time) keep INSERT, UPDATE and DELETE, still limited by row security.

revoke truncate, trigger, references, maintain on all tables in schema public from anon, authenticated;

-- Written only by the database's own functions or the server, never directly by the browser.
revoke insert, update, delete on table
  public.admin_users,
  public.booking_holds,
  public.booking_sessions,
  public.booking_session_enhancements,
  public.booking_session_preferences,
  public.booking_enhancements
from authenticated;

-- Anonymous callers had this only by Supabase's default; it always answered false for them.
revoke execute on function public.is_booking_admin() from anon;
