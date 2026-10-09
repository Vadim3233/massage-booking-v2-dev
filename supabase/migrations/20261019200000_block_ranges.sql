-- Blocked time can run over several days and start or end part-way through a day (a holiday, or
-- "Friday 14:00 to Monday 09:00"). Each day keeps its own row in calendar_blocks, so the availability
-- search, the calendar and the clash checks work unchanged; rows that belong to one block share a group_id
-- and are saved, changed and removed together.

alter table public.calendar_blocks add column group_id uuid not null default gen_random_uuid();
create index calendar_blocks_group_idx on public.calendar_blocks (group_id);

-- Create a block, or replace the block that p_group_id names, over a date and time range.
-- The first day starts at p_start_minutes, the last day ends at p_end_minutes, and any days between are whole days.
create function public.admin_save_block_range(
  p_group_id uuid, p_kind text, p_title text, p_notes text,
  p_start_date date, p_start_minutes integer, p_end_date date, p_end_minutes integer
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group uuid := coalesce(p_group_id, gen_random_uuid());
  v_title text := nullif(btrim(p_title), '');
  v_notes text := nullif(btrim(p_notes), '');
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_start_minutes is null or p_end_minutes is null
     or p_start_minutes not between 0 and 1439 or p_end_minutes not between 1 and 1440 then
    raise exception 'Choose a valid date and time range' using errcode = '22023';
  end if;
  if p_end_date < p_start_date or (p_end_date = p_start_date and p_end_minutes <= p_start_minutes) then
    raise exception 'The end must be after the start' using errcode = '22023';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception 'A block can cover up to a year' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('blocked', 'personal_event') then
    raise exception 'Choose what is happening' using errcode = '22023';
  end if;
  if p_kind = 'personal_event' and v_title is null then
    raise exception 'Give the personal event a name' using errcode = '22023';
  end if;
  if length(coalesce(v_title, '')) > 120 or length(coalesce(v_notes, '')) > 500 then
    raise exception 'The title or notes are too long' using errcode = '22023';
  end if;
  if p_group_id is not null then
    delete from public.calendar_blocks where group_id = p_group_id;
    if not found then raise exception 'Blocked time unavailable' using errcode = 'P0002'; end if;
  end if;
  insert into public.calendar_blocks (group_id, date, start_minutes, end_minutes, kind, title, notes, created_by)
  select v_group, d::date,
         case when d::date = p_start_date then p_start_minutes else 0 end,
         case when d::date = p_end_date then p_end_minutes else 1440 end,
         p_kind, v_title, v_notes, auth.uid()
  from generate_series(p_start_date::timestamp, p_end_date::timestamp, interval '1 day') as d;
  return v_group;
end;
$$;

-- Which live bookings a block over this range would clash with, day by day. The travel allowance around
-- each booking counts, as it does for a single day. Nothing is moved or cancelled.
create function public.admin_block_range_conflicts(
  p_start_date date, p_start_minutes integer, p_end_date date, p_end_minutes integer
) returns table(date date, booking_id uuid, client_name text, start_minutes integer, treatment_duration_minutes integer, booking_status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_start_minutes is null or p_end_minutes is null
     or p_start_minutes not between 0 and 1439 or p_end_minutes not between 1 and 1440
     or p_end_date < p_start_date or p_end_date - p_start_date > 366
     or (p_end_date = p_start_date and p_end_minutes <= p_start_minutes) then
    raise exception 'Choose a valid date and time range' using errcode = '22023';
  end if;
  return query
  select b.date, b.id, coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'Client'),
         b.start_minutes, b.treatment_duration_minutes, b.booking_status
  from public.bookings b
  join public.clients c on c.id = b.client_id
  where b.date between p_start_date and p_end_date
    and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
    and b.start_minutes - b.travel_buffer_minutes < case when b.date = p_end_date then p_end_minutes else 1440 end
    and b.start_minutes + b.treatment_duration_minutes + b.travel_buffer_minutes > case when b.date = p_start_date then p_start_minutes else 0 end
  order by b.date, b.start_minutes;
end;
$$;

revoke all on function public.admin_save_block_range(uuid, text, text, text, date, integer, date, integer) from public, anon;
revoke all on function public.admin_block_range_conflicts(date, integer, date, integer) from public, anon;
grant execute on function public.admin_save_block_range(uuid, text, text, text, date, integer, date, integer) to authenticated;
grant execute on function public.admin_block_range_conflicts(date, integer, date, integer) to authenticated;
