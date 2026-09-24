-- VAD Massage Booking V2
-- Booking RPC foundation 2: authenticated, idempotent booking hold creation.
-- Holds are created only for a slot returned by the shared availability engine.

create or replace function public.create_booking_hold(
  p_date date,
  p_start_minutes integer,
  p_treatment_duration_minutes integer,
  p_idempotency_key text
)
returns table (
  hold_id uuid,
  hold_date date,
  start_minutes integer,
  treatment_duration_minutes integer,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth_user_id uuid;
  v_client_id uuid;
  v_online_booking_enabled boolean;
  v_now timestamptz := now();
  v_scope text;
  v_fingerprint text;
  v_existing_command public.command_requests%rowtype;
  v_hold public.booking_holds%rowtype;
  v_command_id uuid;
begin
  v_auth_user_id := auth.uid();

  if v_auth_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select c.id, c.online_booking_enabled
  into v_client_id, v_online_booking_enabled
  from public.clients c
  where c.auth_user_id = v_auth_user_id;

  if not found then
    raise exception 'Client profile is not linked to this account'
      using errcode = '42501';
  end if;

  if not v_online_booking_enabled then
    raise exception 'Online booking is disabled for this client'
      using errcode = '42501';
  end if;

  if p_date is null then
    raise exception 'Booking date is required' using errcode = '22023';
  end if;

  if p_start_minutes is null or p_start_minutes not between 0 and 1439 then
    raise exception 'Start time is invalid' using errcode = '22023';
  end if;

  if (
    p_treatment_duration_minutes is null
    or p_treatment_duration_minutes < 60
    or p_treatment_duration_minutes > 1440
    or mod(p_treatment_duration_minutes, 30) <> 0
  ) then
    raise exception 'Treatment duration must be at least 60 minutes and use 30-minute increments'
      using errcode = '22023';
  end if;

  p_idempotency_key := btrim(p_idempotency_key);

  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'Idempotency key is required' using errcode = '22023';
  end if;

  if length(p_idempotency_key) > 200 then
    raise exception 'Idempotency key is too long' using errcode = '22023';
  end if;

  v_scope := 'client_booking_hold:' || v_client_id::text;
  v_fingerprint :=
    p_date::text || '|' ||
    p_start_minutes::text || '|' ||
    p_treatment_duration_minutes::text;

  -- Serialize retries using the same client/idempotency key.
  perform pg_advisory_xact_lock(
    hashtext(v_scope || ':' || p_idempotency_key)
  );

  select cr.*
  into v_existing_command
  from public.command_requests cr
  where cr.scope = v_scope
    and cr.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_command.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Idempotency key was already used for a different hold request'
        using errcode = '22023';
    end if;

    if v_existing_command.status <> 'succeeded'
       or v_existing_command.result_reference is null then
      raise exception 'Previous hold request did not complete successfully'
        using errcode = '55000';
    end if;

    select h.*
    into v_hold
    from public.booking_holds h
    where h.id = v_existing_command.result_reference::uuid
      and h.client_id = v_client_id;

    if not found then
      raise exception 'Previous hold result is no longer available'
        using errcode = '55000';
    end if;

    hold_id := v_hold.id;
    hold_date := v_hold.date;
    start_minutes := v_hold.start_minutes;
    treatment_duration_minutes := v_hold.treatment_duration_minutes;
    expires_at := v_hold.expires_at;
    return next;
    return;
  end if;

  -- Serialize all scheduling writes for the same business date. Future booking
  -- finalization/reschedule RPCs must take the same lock before revalidation.
  perform pg_advisory_xact_lock(
    42420,
    hashtext(p_date::text)
  );

  if not exists (
    select 1
    from public.compute_booking_availability(
      p_date,
      p_treatment_duration_minutes,
      v_now,
      60
    ) a
    where a.start_minutes = p_start_minutes
  ) then
    raise exception 'Requested time is no longer available'
      using errcode = 'P0001';
  end if;

  insert into public.command_requests (
    scope,
    idempotency_key,
    source_channel,
    actor_type,
    actor_id,
    command_type,
    request_fingerprint,
    status
  )
  values (
    v_scope,
    p_idempotency_key,
    'web',
    'client',
    v_auth_user_id::text,
    'create_booking_hold',
    v_fingerprint,
    'started'
  )
  returning id into v_command_id;

  insert into public.booking_holds (
    client_id,
    date,
    start_minutes,
    treatment_duration_minutes,
    travel_buffer_minutes,
    expires_at,
    status
  )
  values (
    v_client_id,
    p_date,
    p_start_minutes,
    p_treatment_duration_minutes,
    60,
    v_now + interval '60 minutes',
    'active'
  )
  returning * into v_hold;

  update public.command_requests
  set
    status = 'succeeded',
    result_reference = v_hold.id::text,
    completed_at = v_now
  where id = v_command_id;

  hold_id := v_hold.id;
  hold_date := v_hold.date;
  start_minutes := v_hold.start_minutes;
  treatment_duration_minutes := v_hold.treatment_duration_minutes;
  expires_at := v_hold.expires_at;
  return next;
end;
$$;

revoke all on function public.create_booking_hold(date, integer, integer, text)
  from public;
revoke all on function public.create_booking_hold(date, integer, integer, text)
  from anon;
grant execute on function public.create_booking_hold(date, integer, integer, text)
  to authenticated;
