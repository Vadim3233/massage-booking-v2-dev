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
  if regexp_replace(coalesce(v_text, ''), '\{(date|time|address|treatment|payment|bank details|cancellation)\}', '', 'g') ~ '[{}]' then
    raise exception 'Only the blanks listed can be used, each in curly brackets' using errcode = '22023';
  end if;
  if v_text is null then delete from public.business_settings where key = 'share_message';
  else insert into public.business_settings (key, value, updated_by) values ('share_message', to_jsonb(v_text), auth.uid())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by; end if;
end;
$$;

revoke all on function public.admin_save_share_message(text) from public, anon;
grant execute on function public.admin_save_share_message(text) to authenticated;

-- The moment a booking stops being free to cancel or move, worked out exactly as the fee rule does (late_fee_standard_gbp): free within the
-- grace period after it was made, and until the free-cancellation hours before it starts (London time). From this moment the full price applies.
create function public.booking_free_until(p_created_at timestamptz, p_date date, p_start_minutes integer)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(
    p_created_at + make_interval(mins => public.business_setting_int('grace_minutes', 60)),
    ((p_date + make_interval(mins => p_start_minutes)) at time zone 'Europe/London') - make_interval(hours => public.business_setting_int('free_cancellation_hours', 24)));
$$;
revoke all on function public.booking_free_until(timestamptz, date, integer) from public, anon, authenticated;
grant execute on function public.booking_free_until(timestamptz, date, integer) to service_role;

-- For the Admin's share message: until when the client can still cancel or move this booking for free, whether that time has passed, and
-- whether the booking can still be changed at all.
create function public.admin_cancellation_terms(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_until timestamptz;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  select * into b from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking not found' using errcode = 'P0002'; end if;
  v_until := public.booking_free_until(b.created_at, b.date, b.start_minutes);
  -- 'open': the booking can still be cancelled or moved at all (not cancelled, finished, or started).
  return jsonb_build_object('free_until', v_until, 'ended', clock_timestamp() >= v_until,
    'open', b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
      and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') > clock_timestamp());
end;
$$;
revoke all on function public.admin_cancellation_terms(uuid) from public, anon;
grant execute on function public.admin_cancellation_terms(uuid) to authenticated;
