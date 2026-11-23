-- VAD Massage Booking V2
-- "Pay with Wise": Vadim can save his Wise payment link next to his bank details (More › Bank details).
-- Clients who have Wise see a "Pay with Wise" button in the Bank transfer box. It is still a bank transfer: the client
-- presses "I've made the bank transfer" and Vadim marks it paid as before. Nothing else about payments changes.
--
-- The link is stored inside the same bank_details setting (key wise_link), so every screen that already gets the bank
-- details gets it too. Only a wise.com/pay/... link is accepted, so a slip cannot send clients somewhere else.
-- p_wise_link: null keeps the saved link (an older screen that does not know about it cannot wipe it), '' removes it.
-- Safe to run more than once.

drop function if exists public.admin_save_bank_details(text, text, text, text, text);
drop function if exists public.admin_save_bank_details(text, text, text, text, text, text);

create function public.admin_save_bank_details(p_account_name text, p_bank_name text, p_sort_code text, p_account_number text, p_note text default null, p_wise_link text default null)
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
  v_wise text := nullif(btrim(p_wise_link), '');
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
  -- Left out: keep what is saved.
  if p_wise_link is null then
    v_wise := (select s.value->>'wise_link' from public.business_settings s where s.key = 'bank_details');
  elsif v_wise is not null then
    -- http:// or no scheme at all becomes https://, like the app does (wiseLinkOf).
    if v_wise !~* '^https://' then v_wise := 'https://' || regexp_replace(v_wise, '^http://', '', 'i'); end if;
    v_wise := regexp_replace(v_wise, '^https://(www\.)?wise\.com/', 'https://wise.com/', 'i');
    if v_wise !~ '^https://wise\.com/pay/[A-Za-z0-9/_.?=&%-]{1,180}$' then
      raise exception 'That is not a Wise payment link' using errcode = '22023';
    end if;
  end if;
  insert into public.business_settings(key, value, updated_by)
  values ('bank_details', jsonb_strip_nulls(jsonb_build_object('account_name', v_name, 'bank_name', v_bank,
    'sort_code', substr(v_sort, 1, 2) || '-' || substr(v_sort, 3, 2) || '-' || substr(v_sort, 5, 2), 'account_number', v_number, 'note', v_note,
    'wise_link', v_wise)), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.admin_save_bank_details(text, text, text, text, text, text) from public, anon;
grant execute on function public.admin_save_bank_details(text, text, text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
