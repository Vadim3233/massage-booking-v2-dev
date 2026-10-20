-- Every table's Data API permissions, written down (20 Oct 2026).
-- Supabase stops granting permissions on new tables in "public" automatically on 30 Oct 2026, for any database built from these files: a new
-- project, a preview branch, a local "supabase db reset", or a rebuild after a disaster. Until now most tables here relied on those automatic
-- grants, so such a rebuild would leave the server and the signed-in roles with no access to them. This states, table by table, exactly the
-- permissions the live database has today (read from it on 20 Oct 2026), so a rebuild matches it. On the live database it changes nothing:
-- every grant below is already there. Row security still decides which rows anyone sees; these say only which tables a role may reach at all.
-- From now on, a migration that creates a table states its own grants (see docs/DECISIONS.md, ADR-075).

grant delete, insert, maintain, references, select, trigger, truncate, update on table public.admin_users to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.admin_users to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_access_tokens to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_enhancements to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_enhancements to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_holds to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_holds to service_role;
grant maintain, references, select, trigger on table public.booking_payments to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_payments to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_receipt_revisions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_receipts to service_role;
grant select on table public.booking_schedule_changes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_schedule_changes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_series to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_series_skips to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_session_enhancements to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_session_enhancements to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_session_preferences to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_session_preferences to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_sessions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_sessions to service_role;
grant select on table public.booking_status_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.booking_status_events to service_role;
grant maintain, references, select, trigger on table public.bookings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.bookings to service_role;
grant select on table public.business_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.business_settings to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.calendar_blocks to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.calendar_blocks to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.calendar_connection to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.calendar_sync_events to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.calendar_sync_queue to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_addresses to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_addresses to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_deletions to service_role;
grant select on table public.client_merges to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_merges to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_not_same to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_notes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_notes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_telegram_links to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.client_telegram_tokens to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.clients to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.clients to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.command_requests to service_role;
grant select on table public.enhancements to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.enhancements to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.enhancements to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.event_outbox to service_role;
grant select on table public.notification_deliveries to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.notification_deliveries to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.receipt_counters to service_role;
grant select on table public.service_areas to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.service_areas to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.service_areas to service_role;
grant select on table public.service_duration_prices to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.service_duration_prices to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.service_duration_prices to service_role;
grant select on table public.services to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.services to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.services to service_role;
grant select on table public.session_preference_conflicts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.session_preference_conflicts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.session_preference_conflicts to service_role;
grant select on table public.session_preferences to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.session_preferences to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.session_preferences to service_role;
grant select on table public.waitlist_requests to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_requests to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.working_hours to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.working_hours to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.working_hours_overrides to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.working_hours_overrides to service_role;
