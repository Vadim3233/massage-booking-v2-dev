-- VAD Massage Booking V2
-- Foundation migration 6: command idempotency/audit and committed-event outbox.
-- These tables are server-managed and are not directly exposed to clients.

create table public.command_requests (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  idempotency_key text not null,
  source_channel text not null,
  actor_type text not null,
  actor_id text,
  command_type text not null,
  request_fingerprint text,
  status text not null default 'started',
  result_reference text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint command_requests_scope_not_blank
    check (length(btrim(scope)) > 0),
  constraint command_requests_idempotency_key_not_blank
    check (length(btrim(idempotency_key)) > 0),
  constraint command_requests_source_channel_not_blank
    check (length(btrim(source_channel)) > 0),
  constraint command_requests_actor_type_not_blank
    check (length(btrim(actor_type)) > 0),
  constraint command_requests_command_type_not_blank
    check (length(btrim(command_type)) > 0),
  constraint command_requests_status_valid
    check (status in ('started', 'succeeded', 'failed')),
  constraint command_requests_completion_consistent
    check (
      (status = 'started' and completed_at is null)
      or
      (status in ('succeeded', 'failed') and completed_at is not null)
    ),
  unique (scope, idempotency_key)
);

create trigger command_requests_set_updated_at
before update on public.command_requests
for each row execute function public.set_updated_at();

create index command_requests_actor_created_idx
  on public.command_requests (actor_type, actor_id, created_at desc);

create index command_requests_command_created_idx
  on public.command_requests (command_type, created_at desc);

alter table public.command_requests enable row level security;

create table public.event_outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  source_command_id uuid references public.command_requests(id) on delete set null,
  deduplication_key text unique,
  payload jsonb not null default '{}'::jsonb,
  delivery_status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_outbox_event_type_not_blank
    check (length(btrim(event_type)) > 0),
  constraint event_outbox_aggregate_type_not_blank
    check (length(btrim(aggregate_type)) > 0),
  constraint event_outbox_payload_is_object
    check (jsonb_typeof(payload) = 'object'),
  constraint event_outbox_delivery_status_valid
    check (delivery_status in ('pending', 'delivering', 'delivered', 'failed')),
  constraint event_outbox_attempt_count_nonnegative
    check (attempt_count >= 0),
  constraint event_outbox_delivery_timestamp_consistent
    check (
      (delivery_status = 'delivered' and delivered_at is not null)
      or
      (delivery_status <> 'delivered' and delivered_at is null)
    )
);

create trigger event_outbox_set_updated_at
before update on public.event_outbox
for each row execute function public.set_updated_at();

create index event_outbox_delivery_queue_idx
  on public.event_outbox (delivery_status, next_attempt_at, created_at);

create index event_outbox_aggregate_idx
  on public.event_outbox (aggregate_type, aggregate_id, created_at);

alter table public.event_outbox enable row level security;

-- No normal authenticated-user policies are created for these tables.
-- Validated SECURITY DEFINER RPCs create command records and outbox events.
-- Notification workers use trusted server/service credentials.

revoke all on table public.command_requests from anon;
revoke all on table public.command_requests from authenticated;
revoke all on table public.event_outbox from anon;
revoke all on table public.event_outbox from authenticated;
