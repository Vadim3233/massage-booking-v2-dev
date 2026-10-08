-- VAD Massage Booking V2
-- Schedule control: warn the Admin before she blocks time, closes a day or shortens hours over bookings.
--
-- Working hours, special days and blocked time are edited by the Admin directly (their tables already
-- have Admin-only policies and strict checks). This adds one read-only helper so the screen can say,
-- before saving, which live bookings a change would clash with. Nothing is moved or cancelled for her.

create function public.admin_schedule_conflicts(p_date date, p_start_minutes integer, p_end_minutes integer)
returns table(booking_id uuid, client_name text, start_minutes integer, treatment_duration_minutes integer, booking_status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_date is null or p_start_minutes is null or p_end_minutes is null
     or p_start_minutes < 0 or p_end_minutes > 1440 or p_start_minutes >= p_end_minutes then
    raise exception 'Choose a valid date and time range' using errcode = '22023';
  end if;
  -- The travel allowance around each booking counts, because it is time she cannot use either.
  return query
  select b.id, coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'Client'),
         b.start_minutes, b.treatment_duration_minutes, b.booking_status
  from public.bookings b
  join public.clients c on c.id = b.client_id
  where b.date = p_date
    and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
    and b.start_minutes - b.travel_buffer_minutes < p_end_minutes
    and b.start_minutes + b.treatment_duration_minutes + b.travel_buffer_minutes > p_start_minutes
  order by b.start_minutes;
end;
$$;

revoke all on function public.admin_schedule_conflicts(date, integer, integer) from public, anon;
grant execute on function public.admin_schedule_conflicts(date, integer, integer) to authenticated;
