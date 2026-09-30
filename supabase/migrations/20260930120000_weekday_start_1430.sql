-- Shift standard weekday starts from 14:15 to 14:30.
-- Preserve all end times, weekend hours, fixed-start scheduling and
-- intentional date-specific working_hours_overrides.
update public.working_hours
set start_minutes = 870
where weekday between 1 and 5
  and available = true
  and start_mode = 'flexible'
  and start_minutes = 855;
