-- VAD Massage Booking V2
-- Canonical client account activation/linking.
-- A confirmed Supabase Auth account links to one canonical public.clients row.
-- The browser never chooses an arbitrary client_id and never supplies its email
-- as identity authority; the confirmed auth.users email is authoritative.

create or replace function public.activate_my_client_account(
  p_first_name text default null,
  p_last_name text default null,
  p_phone text default null
)
returns table (
  client_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  online_booking_enabled boolean,
  created_new_client boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_auth_email text;
  v_first_name text := nullif(btrim(p_first_name), '');
  v_last_name text := nullif(btrim(p_last_name), '');
  v_phone text := nullif(btrim(p_phone), '');
  v_client public.clients%rowtype;
  v_candidate_id uuid;
  v_candidate_count integer;
  v_created boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if public.is_booking_admin() then
    raise exception 'Admin accounts cannot be activated as client accounts'
      using errcode = '42501';
  end if;

  select lower(btrim(u.email))
  into v_auth_email
  from auth.users u
  where u.id = v_user_id
    and u.email_confirmed_at is not null
    and nullif(btrim(u.email), '') is not null;

  if v_auth_email is null then
    raise exception 'A confirmed email address is required'
      using errcode = '42501';
  end if;

  -- Serialize account activation both by Auth user and confirmed email.
  perform pg_advisory_xact_lock(
    hashtext('client-auth-user:' || v_user_id::text)
  );
  perform pg_advisory_xact_lock(
    hashtext('client-auth-email:' || v_auth_email)
  );

  -- Repeated activation is idempotent for an already-linked canonical client.
  select c.*
  into v_client
  from public.clients c
  where c.auth_user_id = v_user_id
  for update;

  if found then
    update public.clients c
    set
      first_name = coalesce(v_first_name, c.first_name),
      last_name = coalesce(v_last_name, c.last_name),
      email = v_auth_email,
      phone = coalesce(v_phone, c.phone)
    where c.id = v_client.id
    returning c.* into v_client;

    client_id := v_client.id;
    first_name := v_client.first_name;
    last_name := v_client.last_name;
    email := v_client.email;
    phone := v_client.phone;
    online_booking_enabled := v_client.online_booking_enabled;
    created_new_client := false;
    return next;
    return;
  end if;

  -- A confirmed email cannot silently take over a client already linked to a
  -- different Auth account.
  if exists (
    select 1
    from public.clients c
    where c.normalized_email = v_auth_email
      and c.auth_user_id is not null
      and c.auth_user_id <> v_user_id
  ) then
    raise exception 'This email is already linked to another client account'
      using errcode = '23505';
  end if;

  select count(*)::integer, min(c.id)
  into v_candidate_count, v_candidate_id
  from public.clients c
  where c.normalized_email = v_auth_email
    and c.auth_user_id is null;

  if v_candidate_count > 1 then
    raise exception 'Multiple client records use this email. Please contact Vad to link the correct account.'
      using errcode = 'P0001';
  end if;

  if v_candidate_count = 1 then
    update public.clients c
    set
      auth_user_id = v_user_id,
      first_name = coalesce(v_first_name, c.first_name),
      last_name = coalesce(v_last_name, c.last_name),
      email = v_auth_email,
      phone = coalesce(v_phone, c.phone)
    where c.id = v_candidate_id
      and c.auth_user_id is null
    returning c.* into v_client;

    if not found then
      raise exception 'Client account linking changed while activation was in progress'
        using errcode = '40001';
    end if;
  else
    if v_first_name is null then
      raise exception 'First name is required for a new client account'
        using errcode = '22023';
    end if;

    insert into public.clients (
      auth_user_id,
      first_name,
      last_name,
      email,
      phone
    )
    values (
      v_user_id,
      v_first_name,
      coalesce(v_last_name, ''),
      v_auth_email,
      v_phone
    )
    returning * into v_client;

    v_created := true;
  end if;

  client_id := v_client.id;
  first_name := v_client.first_name;
  last_name := v_client.last_name;
  email := v_client.email;
  phone := v_client.phone;
  online_booking_enabled := v_client.online_booking_enabled;
  created_new_client := v_created;
  return next;
end;
$$;

revoke all on function public.activate_my_client_account(text, text, text)
  from public;
revoke all on function public.activate_my_client_account(text, text, text)
  from anon;
grant execute on function public.activate_my_client_account(text, text, text)
  to authenticated;
