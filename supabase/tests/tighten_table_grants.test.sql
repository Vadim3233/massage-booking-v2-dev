begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(5);

-- Signed-in users keep only the table permissions the app uses (ADR-091).
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and (has_table_privilege('authenticated', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRIGGER')
      or has_table_privilege('authenticated', c.oid, 'REFERENCES') or has_table_privilege('anon', c.oid, 'TRUNCATE'))), 0,
  'No table can be emptied, given triggers or referenced by signed-in or anonymous users');
select is((select count(*)::integer from unnest(array['admin_users', 'booking_holds', 'booking_sessions', 'booking_session_enhancements',
    'booking_session_preferences', 'booking_enhancements']) t
  where has_table_privilege('authenticated', 'public.' || t, 'INSERT') or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
    or has_table_privilege('authenticated', 'public.' || t, 'DELETE')), 0, 'Tables only the database writes cannot be written directly');
select ok(has_table_privilege('authenticated', 'public.services', 'INSERT') and has_table_privilege('authenticated', 'public.client_notes', 'DELETE')
  and has_table_privilege('authenticated', 'public.client_addresses', 'UPDATE'), 'The Admin''s direct edits still have their permissions (row security decides)');
select ok(has_table_privilege('authenticated', 'public.booking_sessions', 'SELECT'), 'Clients can still read their own booking details');
select ok(not has_function_privilege('anon', 'public.is_booking_admin()', 'EXECUTE'), 'Anonymous callers cannot call the admin check');

select * from finish();
rollback;
