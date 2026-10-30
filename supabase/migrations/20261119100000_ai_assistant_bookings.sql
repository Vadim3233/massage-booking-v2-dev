-- Booking through a client's own AI assistant (Claude, ChatGPT and others), through the connector at /mcp.
--
-- The assistant signs in as the client through Supabase's OAuth server, so everything it does goes through the same client functions and rules
-- as the app. Two things are added here:
--   1. A booking made with such a sign-in is marked as made by an AI assistant (bookings.source_channel = 'ai_assistant'), so the Admin can see it.
--      The sign-in's token carries the assistant's client_id; the app's own sign-in has none.
--   2. A limit on how often one client's assistant can ask, so an assistant stuck in a loop cannot flood the booking functions.

create or replace function public.mark_ai_assistant_booking()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if new.source_channel = 'web' and coalesce(v_claims->>'client_id', '') <> '' then
    new.source_channel := 'ai_assistant';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_mark_ai_assistant on public.bookings;
create trigger bookings_mark_ai_assistant
before insert on public.bookings
for each row execute function public.mark_ai_assistant_booking();

create table if not exists public.ai_request_counts (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  requests integer not null default 0,
  primary key (user_id, window_start)
);
alter table public.ai_request_counts enable row level security;
revoke all on public.ai_request_counts from public, anon, authenticated;

-- Called by the connector before each action. 120 an hour is far more than a real conversation needs.
create or replace function public.note_ai_request()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_window timestamptz := date_trunc('hour', now());
  v_requests integer;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  delete from public.ai_request_counts where user_id = v_user and window_start < v_window - interval '1 day';
  insert into public.ai_request_counts as counts (user_id, window_start, requests) values (v_user, v_window, 1)
  on conflict (user_id, window_start) do update set requests = counts.requests + 1
  returning requests into v_requests;
  if v_requests > 120 then
    raise exception 'Your assistant has asked too many times in the last hour. Please try again later, or book in the app.' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.note_ai_request() from public, anon;
grant execute on function public.note_ai_request() to authenticated;
