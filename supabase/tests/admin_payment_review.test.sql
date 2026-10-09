begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;
select plan(16);
select has_function('public','admin_verify_bank_transfer',array['uuid','uuid','timestamp with time zone','timestamp with time zone']);
select has_function('public','admin_approve_cash_request',array['uuid','uuid','timestamp with time zone','timestamp with time zone']);
select has_function('public','admin_reject_cash_request',array['uuid','uuid','timestamp with time zone','timestamp with time zone']);
select has_function('public','admin_record_payment_received',array['uuid','uuid','timestamp with time zone','timestamp with time zone']);
select ok(not has_table_privilege('authenticated','public.bookings','UPDATE'),'No direct browser booking updates');
select ok(not has_table_privilege('authenticated','public.booking_payments','UPDATE'),'No direct browser payment updates');
select ok(not has_table_privilege('authenticated','public.command_requests','INSERT'),'Command audit is server managed');
select ok(not has_table_privilege('authenticated','public.event_outbox','INSERT'),'Outbox is server managed');
select ok(not has_function_privilege('anon','public.admin_verify_bank_transfer(uuid,uuid,timestamptz,timestamptz)','EXECUTE'),'No anonymous mutation');
select ok(not has_function_privilege('anon','public.admin_payment_review_queue(integer)','EXECUTE'),'No anonymous queue');
select ok(not exists (
  select 1 from information_schema.column_privileges
  where grantee in ('authenticated','anon','PUBLIC') and table_schema='public'
    and table_name in ('bookings','booking_payments') and privilege_type in ('INSERT','UPDATE')
), 'No column-level browser mutation grants bypass table revocation');
select ok(not has_table_privilege('authenticated','public.bookings','INSERT,DELETE,TRUNCATE')
  and not has_table_privilege('authenticated','public.booking_payments','INSERT,DELETE,TRUNCATE'), 'No other direct browser mutation grants');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('admin_verify_bank_transfer','admin_approve_cash_request','admin_reject_cash_request','admin_record_payment_received')), 'Mutation definers have an empty fixed search path');
select ok((select not p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='admin_payment_review_queue'), 'Queue remains security invoker');
set local role authenticated;
select throws_ok('select public.admin_payment_review_queue(0)', '42501', 'Admin authorization required', 'Queue enforces Admin without a session');
select throws_ok('select public.admin_approve_cash_request(null,null,null,null)', '42501', 'Admin authorization required', 'Mutation authorizes before processing arguments');
reset role;
select * from finish();
rollback;
