-- The client's first name in the share message (Vadim, 11 Nov 2026). The standard wording now greets the client by name ("Hi Sarah! Thank you so
-- much for booking...") through a new blank, {name}, which the app fills with the first name (left out, with its space, when none is saved).
-- The standard wording works without this file; it only lets the Admin's own wording (More › Share message) use {name} too.
create or replace function public.admin_save_share_message(p_text text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text text := nullif(btrim(p_text), '');
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if length(coalesce(v_text, '')) > 1000 then raise exception 'The share message can be up to 1000 characters' using errcode = '22023'; end if;
  if regexp_replace(coalesce(v_text, ''), '\{(name|date|time|address|treatment|payment|bank details|cancellation|calendar)\}', '', 'g') ~ '[{}]' then
    raise exception 'Only the blanks listed can be used, each in curly brackets' using errcode = '22023';
  end if;
  if v_text is null then delete from public.business_settings where key = 'share_message';
  else insert into public.business_settings (key, value, updated_by) values ('share_message', to_jsonb(v_text), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by; end if;
end;
$$;

revoke all on function public.admin_save_share_message(text) from public, anon;
grant execute on function public.admin_save_share_message(text) to authenticated;
