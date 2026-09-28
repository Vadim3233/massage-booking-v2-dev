-- VAD Massage Booking V2
-- Guest checkout identity activation.
--
-- Guest checkout uses a Supabase anonymous Auth session. This gives the browser
-- an authenticated, scoped user ID without asking the client to create login
-- credentials. The guest's supplied email is intentionally NOT used to claim
-- or link an existing canonical client because it has not been verified.

create or replace function public.activate_guest_client_account(
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text
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
  v_is_anonymous boolean := coalesce(
    (auth.jwt() ->> 'is_anonymous')::boolean,
    false
  );
  v_first_name text := nullif(btrim(p_first_name), '');
  v_last_name text := nullif(btrim(p_last_name), '');
  v_email text := lower(nullif(btrim(p_email), ''));
  v_phone text := nullif(btrim(p_phone), '');
  v_client public.clients%rowtype;
  v_created boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if not v_is_anonymous then
    raise exception 'Guest checkout requires an anonymous session'
      using errcode = '42501';
  end if;

  if public.is_booking_admin() then
    raise exception 'Admin accounts cannot use guest checkout'
      using errcode = '42501';
  end if;

  if v_first_name is null then
    raise exception 'First name is required'
      using errcode = '22023';
  end if;

  if v_last_name is null then
    raise exception 'Last name is required'
      using errcode = '22023';
  end if;

  if v_email is null
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'A valid email address is required'
      using errcode = '22023';
  end if;

  if v_phone is null
     or length(regexp_replace(v_phone, '[^0-9]+', '', 'g')) < 7 then
    raise exception 'A valid contact number is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('guest-client-auth-user:' || v_user_id::text)
  );

  -- Idempotent for reload/back/retry within the same anonymous Auth session.
  select c.*
  into v_client
  from public.clients c
  where c.auth_user_id = v_user_id
  for update;

  if found then
    update public.clients c
    set
      first_name = v_first_name,
      last_name = v_last_name,
      email = v_email,
      phone = v_phone
    where c.id = v_client.id
    returning c.* into v_client;
  else
    -- Do not match by email here. A guest-entered email is unverified, so using
    -- it to claim an existing client could expose that client's saved records.
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
      v_last_name,
      v_email,
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

revoke all on function public.activate_guest_client_account(text, text, text, text)
  from public;
revoke all on function public.activate_guest_client_account(text, text, text, text)
  from anon;
grant execute on function public.activate_guest_client_account(text, text, text, text)
  to authenticated;
