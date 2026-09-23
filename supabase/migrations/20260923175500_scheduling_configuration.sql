-- VAD Massage Booking V2
-- Foundation migration 3: working hours, date overrides, and canonical calendar blocks.
-- Public/client availability will consume these through validated availability RPCs later.

create table public.working_hours (
  weekday smallint primary key,
  available boolean not null default false,
  start_minutes integer,
  end_minutes integer,
  start_mode text not null default 'flexible',
  fixed_start_minutes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint working_hours_weekday_valid
    check (weekday between 1 and 7),
  constraint working_hours_start_minutes_valid
    check (start_minutes is null or start_minutes between 0 and 1439),
  constraint working_hours_end_minutes_valid
    check (end_minutes is null or end_minutes between 1 and 1440),
  constraint working_hours_fixed_start_minutes_valid
    check (fixed_start_minutes is null or fixed_start_minutes between 0 and 1439),
  constraint working_hours_start_mode_valid
    check (start_mode in ('flexible', 'fixed')),
  constraint working_hours_available_window_valid
    check (
      (
        available = false
        and start_minutes is null
        and end_minutes is null
        and fixed_start_minutes is null
      )
      or
      (
        available = true
        and start_minutes is not null
        and end_minutes is not null
        and start_minutes < end_minutes
      )
    ),
  constraint working_hours_fixed_mode_valid
    check (
      (
        start_mode = 'flexible'
        and fixed_start_minutes is null
      )
      or
      (
        start_mode = 'fixed'
        and available = true
        and fixed_start_minutes is not null
        and fixed_start_minutes >= start_minutes
        and fixed_start_minutes < end_minutes
      )
    )
);

create trigger working_hours_set_updated_at
before update on public.working_hours
for each row execute function public.set_updated_at();

alter table public.working_hours enable row level security;

create policy "admins can manage working hours"
on public.working_hours
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.working_hours_overrides (
  date date primary key,
  available boolean not null,
  start_minutes integer,
  end_minutes integer,
  start_mode text not null default 'flexible',
  fixed_start_minutes integer,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint working_hours_overrides_start_minutes_valid
    check (start_minutes is null or start_minutes between 0 and 1439),
  constraint working_hours_overrides_end_minutes_valid
    check (end_minutes is null or end_minutes between 1 and 1440),
  constraint working_hours_overrides_fixed_start_minutes_valid
    check (fixed_start_minutes is null or fixed_start_minutes between 0 and 1439),
  constraint working_hours_overrides_start_mode_valid
    check (start_mode in ('flexible', 'fixed')),
  constraint working_hours_overrides_available_window_valid
    check (
      (
        available = false
        and start_minutes is null
        and end_minutes is null
        and fixed_start_minutes is null
      )
      or
      (
        available = true
        and start_minutes is not null
        and end_minutes is not null
        and start_minutes < end_minutes
      )
    ),
  constraint working_hours_overrides_fixed_mode_valid
    check (
      (
        start_mode = 'flexible'
        and fixed_start_minutes is null
      )
      or
      (
        start_mode = 'fixed'
        and available = true
        and fixed_start_minutes is not null
        and fixed_start_minutes >= start_minutes
        and fixed_start_minutes < end_minutes
      )
    )
);

create trigger working_hours_overrides_set_updated_at
before update on public.working_hours_overrides
for each row execute function public.set_updated_at();

create index working_hours_overrides_date_idx
  on public.working_hours_overrides (date);

alter table public.working_hours_overrides enable row level security;

create policy "admins can manage working hour overrides"
on public.working_hours_overrides
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.calendar_blocks (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  start_minutes integer not null,
  end_minutes integer not null,
  kind text not null,
  title text,
  notes text,
  color_key text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_blocks_start_minutes_valid
    check (start_minutes between 0 and 1439),
  constraint calendar_blocks_end_minutes_valid
    check (end_minutes between 1 and 1440),
  constraint calendar_blocks_window_valid
    check (start_minutes < end_minutes),
  constraint calendar_blocks_kind_valid
    check (kind in ('blocked', 'personal_event')),
  constraint calendar_blocks_personal_event_title_valid
    check (
      kind <> 'personal_event'
      or (title is not null and length(btrim(title)) > 0)
    )
);

create trigger calendar_blocks_set_updated_at
before update on public.calendar_blocks
for each row execute function public.set_updated_at();

create index calendar_blocks_date_time_idx
  on public.calendar_blocks (date, start_minutes, end_minutes);

create index calendar_blocks_kind_date_idx
  on public.calendar_blocks (kind, date);

alter table public.calendar_blocks enable row level security;

create policy "admins can manage calendar blocks"
on public.calendar_blocks
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

-- Direct client reads are intentionally not granted.
-- Client availability will be exposed by a later security-definer RPC that
-- returns only valid booking slots, not personal-event titles or notes.

revoke all on table public.working_hours from anon;
revoke all on table public.working_hours_overrides from anon;
revoke all on table public.calendar_blocks from anon;

grant select, insert, update, delete on table public.working_hours to authenticated;
grant select, insert, update, delete on table public.working_hours_overrides to authenticated;
grant select, insert, update, delete on table public.calendar_blocks to authenticated;
