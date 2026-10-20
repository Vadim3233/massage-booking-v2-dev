begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(4);

-- Since 30 Oct 2026 Supabase no longer grants permissions on new tables automatically, so every table states its own (ADR-075). These fail
-- when a new table forgets to: on a database built from these files, the server or the app would otherwise be refused it.
select is(
  (select array_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE')),
  null, 'The server (service role) can read and write every table');
select is(
  (select array_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege('anon', c.oid, 'SELECT')),
  array['enhancements', 'service_areas', 'service_duration_prices', 'services', 'session_preference_conflicts', 'session_preferences']::name[],
  'Visitors can read only the catalogue: treatments, prices, areas, extras and preferences');
select ok(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')),
  'Visitors can change no table');
select is(
  (select array_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  null, 'Every table has row security on, so a permission never shows rows it should not');

select * from finish();
rollback;
