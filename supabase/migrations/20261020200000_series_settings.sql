-- How many days before a repeating session it becomes a booking and the client is asked to pay for it (ADR-030).
create function public.admin_series_reminder_days()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return public.business_setting_int('series_payment_reminder_days', 7);
end;
$$;

create function public.admin_set_series_reminder_days(p_days integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 1 and 30 then
    raise exception 'Choose between 1 and 30 days' using errcode = '22023';
  end if;
  insert into public.business_settings (key, value, updated_by) values ('series_payment_reminder_days', to_jsonb(p_days), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.admin_series_reminder_days() from public, anon;
revoke all on function public.admin_set_series_reminder_days(integer) from public, anon;
grant execute on function public.admin_series_reminder_days() to authenticated;
grant execute on function public.admin_set_series_reminder_days(integer) to authenticated;
