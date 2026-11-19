-- WhatsApp me button on the client pages (ADR-109).
create or replace function public.get_public_whatsapp()
returns text language sql stable security definer set search_path = '' as $$
  select value->>'number' from public.business_settings
  where key = 'whatsapp_button' and (value->>'show')::boolean and coalesce(value->>'number', '') ~ '^[0-9]{8,15}$';
$$;

create or replace function public.admin_save_whatsapp(p_number text, p_show boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_number text := regexp_replace(coalesce(p_number, ''), '[^0-9]', '', 'g');
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if v_number <> '' and v_number !~ '^[0-9]{8,15}$' then raise exception 'Please check the WhatsApp number' using errcode = '22023'; end if;
  if v_number = '' and p_show then raise exception 'Add your WhatsApp number to show the button' using errcode = '22023'; end if;
  insert into public.business_settings (key, value, updated_by)
  values ('whatsapp_button', jsonb_build_object('number', v_number, 'show', coalesce(p_show, false)), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.get_public_whatsapp() from public;
revoke all on function public.admin_save_whatsapp(text, boolean) from public, anon;
grant execute on function public.get_public_whatsapp() to anon, authenticated;
grant execute on function public.admin_save_whatsapp(text, boolean) to authenticated;
