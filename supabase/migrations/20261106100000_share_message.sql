-- The Admin's own wording for the booking details shared with a client (WhatsApp, Share…, Copy). It is kept in business_settings under
-- 'share_message', which the Admin can already read; this adds the one way to change it. Only the known blanks may be used, so the message can
-- only ever be filled with what the share button already puts in it (never notes, the client's phone or email, or anything internal).
-- Empty means the standard wording.
create function public.admin_save_share_message(p_text text)
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
  if regexp_replace(coalesce(v_text, ''), '\{(date|time|address|treatment|payment|bank details)\}', '', 'g') ~ '[{}]' then
    raise exception 'Only the blanks listed can be used, each in curly brackets' using errcode = '22023';
  end if;
  if v_text is null then delete from public.business_settings where key = 'share_message';
  else insert into public.business_settings (key, value, updated_by) values ('share_message', to_jsonb(v_text), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by; end if;
end;
$$;

revoke all on function public.admin_save_share_message(text) from public, anon;
grant execute on function public.admin_save_share_message(text) to authenticated;
