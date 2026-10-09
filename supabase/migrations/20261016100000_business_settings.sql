-- VAD Massage Booking V2
-- Business settings the Admin can change herself, starting with her bank details.
--
-- Settings live in one small table that only the Admin can see. Clients never read the table: they get
-- the bank details through get_bank_details(), which answers only a signed-in client (guests included)
-- and only the fields needed to make a transfer. The old build-time VITE_BANK_* values remain a
-- fallback in the app, so nothing breaks before the Admin has entered her details here.

create table public.business_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint business_settings_key_valid check (key ~ '^[a-z][a-z0-9_]{0,62}$')
);
create trigger business_settings_set_updated_at before update on public.business_settings
  for each row execute function public.set_updated_at();
alter table public.business_settings enable row level security;
create policy "admins can read business settings" on public.business_settings
  for select to authenticated using (public.is_booking_admin());
revoke all on table public.business_settings from public;
revoke all on table public.business_settings from anon;
revoke all on table public.business_settings from authenticated;
grant select on table public.business_settings to authenticated;

create function public.admin_save_bank_details(p_account_name text, p_bank_name text, p_sort_code text, p_account_number text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(p_account_name), '');
  v_bank text := nullif(btrim(p_bank_name), '');
  v_sort text := regexp_replace(coalesce(p_sort_code, ''), '[^0-9]', '', 'g');
  v_number text := regexp_replace(coalesce(p_account_number, ''), '[^0-9]', '', 'g');
  v_note text := nullif(btrim(p_note), '');
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'Enter the name on the account' using errcode = '22023';
  end if;
  if length(v_sort) <> 6 then raise exception 'The sort code needs six digits' using errcode = '22023'; end if;
  if length(v_number) <> 8 then raise exception 'The account number needs eight digits' using errcode = '22023'; end if;
  if length(coalesce(v_bank, '')) > 80 or length(coalesce(v_note, '')) > 300 then
    raise exception 'That is too long' using errcode = '22023';
  end if;
  insert into public.business_settings(key, value, updated_by)
  values ('bank_details', jsonb_strip_nulls(jsonb_build_object('account_name', v_name, 'bank_name', v_bank,
    'sort_code', substr(v_sort, 1, 2) || '-' || substr(v_sort, 3, 2) || '-' || substr(v_sort, 5, 2), 'account_number', v_number, 'note', v_note)), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

create function public.admin_bank_details()
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
  return (select value from public.business_settings where key = 'bank_details');
end;
$$;

create function public.get_bank_details()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- Only someone who has a booking record with us, which every guest and client does once they book.
  if not exists (select 1 from public.clients c where c.auth_user_id = auth.uid()) then return null; end if;
  return (select value from public.business_settings where key = 'bank_details');
end;
$$;

revoke all on function public.admin_save_bank_details(text, text, text, text, text) from public, anon;
revoke all on function public.admin_bank_details() from public, anon;
revoke all on function public.get_bank_details() from public, anon;
grant execute on function public.admin_save_bank_details(text, text, text, text, text) to authenticated;
grant execute on function public.admin_bank_details() to authenticated;
grant execute on function public.get_bank_details() to authenticated;
