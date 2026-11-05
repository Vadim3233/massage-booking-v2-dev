-- A minimum booking length for an area, and "No minimum booking" for a client (Vadim, 5 Nov 2026).
--
-- Vadim would rather not travel far for a one hour session. From this migration:
--   * Each area can have a minimum booking (`service_areas.minimum_booking_minutes`), set in More > Areas: off (null), 90 minutes, 2 hours or 3 hours.
--     It counts the whole time at the address, so a couple booking 2 x 60 minutes have 2 hours.
--   * A client's own booking (in the app, as a guest, or through their own AI assistant) that is shorter than the minimum of its area is refused,
--     with a sentence saying what the minimum is. The booking screen and the assistant say so before the client gets that far.
--   * The Admin can switch the minimum off for one client (`clients.no_minimum_booking`, on the client's page). Only the Admin can change it:
--     clients can read their own record but not write it.
-- Bookings the Admin makes, and bookings already made, are not checked.
--
-- To take this back: drop the trigger bookings_area_minimum and the function check_booking_minimum, and drop the columns
-- clients.no_minimum_booking and service_areas.minimum_booking_minutes.

alter table public.service_areas add column minimum_booking_minutes integer,
  add constraint service_areas_minimum_booking_valid check (minimum_booking_minutes is null or minimum_booking_minutes between 30 and 600);

alter table public.clients add column no_minimum_booking boolean not null default false;

-- "2 hours", "1 hour 30 minutes": the same words as hoursWords in src/booking/bookingWords.js.
create function public.minimum_booking_words(p_minutes integer)
returns text language sql immutable set search_path = '' as $$
  select btrim(concat_ws(' ',
    case when p_minutes / 60 = 1 then '1 hour' when p_minutes / 60 > 1 then (p_minutes / 60)::text || ' hours' end,
    case when p_minutes % 60 > 0 then (p_minutes % 60)::text || ' minutes' end));
$$;
revoke all on function public.minimum_booking_words(integer) from public, anon;
grant execute on function public.minimum_booking_words(integer) to authenticated, service_role;

create function public.check_booking_minimum()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_area public.service_areas%rowtype;
begin
  if new.created_by_actor_type is distinct from 'client' then return new; end if;
  select * into v_area from public.service_areas where id = new.service_area_id;
  if v_area.minimum_booking_minutes is null or new.treatment_duration_minutes >= v_area.minimum_booking_minutes then return new; end if;
  if exists (select 1 from public.clients c where c.id = new.client_id and c.no_minimum_booking) then return new; end if;
  raise exception '%', format('In %s the minimum booking is %s in total (two people''s times add up). Please choose a longer time.',
      v_area.name, public.minimum_booking_words(v_area.minimum_booking_minutes))
    using errcode = '22023';
end; $$;
revoke all on function public.check_booking_minimum() from public, anon, authenticated;
create trigger bookings_area_minimum before insert on public.bookings
  for each row execute function public.check_booking_minimum();
