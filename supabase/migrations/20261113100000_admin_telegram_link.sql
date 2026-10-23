-- VAD Massage Booking V2
-- A Telegram link the Admin can send a client.
--
-- A client who did not press "Get updates on Telegram" on their confirmation page can still be sent the link: from the client's profile the
-- Admin makes a one-time link and shares it (WhatsApp, or copied). It is the same kind of code the client's own button makes, on the same
-- table and linked by the same webhook (link_client_telegram), so pressing Start in Telegram links that chat to that client exactly as before.
--
-- How it is kept safe:
--  * Only a signed-in Admin can ask for a code, and only for a client that exists. A guest or ordinary client cannot.
--  * A code is random, single use and only its hash is kept. It is shown once, to the Admin who asked.
--  * It lasts 24 hours, not the 2 hours of the client's own button, because it is sent to a phone and opened later. Linking a chat
--    spends this client's other unused codes too (link_client_telegram), so an old link left in a chat cannot link a second one.
--  * Ten codes an hour per client at most, counted together with the client's own.
--  * The bot tells whoever presses Start whose appointments the chat is now connected to (their first name), so a link that reached the
--    wrong person shows. The profile shows when the chat has linked.
-- No table is added or changed, so there are no table permissions to state (ADR-075); the two functions state their own.

create function public.admin_client_telegram_status(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return jsonb_build_object('linked', exists (select 1 from public.client_telegram_links l where l.client_id = p_client_id and l.stopped_at is null));
end;
$$;

create function public.admin_create_client_telegram_link(p_client_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id) then
    raise exception 'That client is no longer there. They may already have been deleted or combined.' using errcode = 'P0002';
  end if;
  if (select count(*) from public.client_telegram_tokens t where t.client_id = p_client_id and t.created_at > clock_timestamp() - interval '1 hour') >= 10 then
    raise exception 'Please wait a little before asking again.' using errcode = 'PT429';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.client_telegram_tokens(client_id, token_hash, expires_at)
  values (p_client_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), clock_timestamp() + interval '24 hours');
  delete from public.client_telegram_tokens t where t.expires_at < clock_timestamp() - interval '1 day';
  return v_token;
end;
$$;

revoke all on function public.admin_client_telegram_status(uuid) from public, anon;
revoke all on function public.admin_create_client_telegram_link(uuid) from public, anon;
grant execute on function public.admin_client_telegram_status(uuid) to authenticated;
grant execute on function public.admin_create_client_telegram_link(uuid) to authenticated;
