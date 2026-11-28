-- Moving and cancelling through a client's own AI assistant (the connector at /mcp, ADR-117).
--
-- The connector moves and cancels with the same client functions as the account page (client_reschedule_booking, client_cancel_booking), so
-- every rule, fee and alert is the app's own. This only marks what the assistant did, so the booking History and Alerts can say
-- "Moved through their AI assistant" / "Cancelled through their AI assistant":
-- a booking event written during a request signed in through an assistant (its token carries the assistant's client_id; the app's own
-- sign-in has none) gets "via": "ai" in its payload. Nothing else changes. Safe to run again.

create or replace function public.mark_ai_assistant_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if new.aggregate_type = 'booking' and coalesce(v_claims->>'client_id', '') <> '' and not (coalesce(new.payload, '{}'::jsonb) ? 'via') then
    new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('via', 'ai');
  end if;
  return new;
end;
$$;
revoke all on function public.mark_ai_assistant_event() from public, anon, authenticated;

drop trigger if exists event_outbox_mark_ai_assistant on public.event_outbox;
create trigger event_outbox_mark_ai_assistant
before insert on public.event_outbox
for each row execute function public.mark_ai_assistant_event();
