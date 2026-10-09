-- A short welcome and an "about me" the Admin writes herself, shown at the top of the booking page.
-- Public so a visitor who has not signed in can read them; only the Admin can change them.
create function public.get_public_welcome()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'welcome', coalesce((select value #>> '{}' from public.business_settings where key = 'welcome_text' and jsonb_typeof(value) = 'string'), ''),
    'about', coalesce((select value #>> '{}' from public.business_settings where key = 'about_text' and jsonb_typeof(value) = 'string'), ''));
$$;

create function public.admin_save_welcome(p_welcome text, p_about text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_welcome text := nullif(btrim(p_welcome), '');
  v_about text := nullif(btrim(p_about), '');
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if length(coalesce(v_welcome, '')) > 500 then raise exception 'The welcome message can be up to 500 characters' using errcode = '22023'; end if;
  if length(coalesce(v_about, '')) > 1500 then raise exception 'The about text can be up to 1500 characters' using errcode = '22023'; end if;
  if v_welcome is null then delete from public.business_settings where key = 'welcome_text';
  else insert into public.business_settings (key, value, updated_by) values ('welcome_text', to_jsonb(v_welcome), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by; end if;
  if v_about is null then delete from public.business_settings where key = 'about_text';
  else insert into public.business_settings (key, value, updated_by) values ('about_text', to_jsonb(v_about), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by; end if;
end;
$$;

revoke all on function public.get_public_welcome() from public;
revoke all on function public.admin_save_welcome(text, text) from public, anon;
grant execute on function public.get_public_welcome() to anon, authenticated;
grant execute on function public.admin_save_welcome(text, text) to authenticated;
