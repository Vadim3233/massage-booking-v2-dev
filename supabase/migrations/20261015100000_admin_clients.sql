-- VAD Massage Booking V2
-- Admin client management: edit a client without creating a duplicate, see a summary, set the default address.
--
-- Looking people up, listing their bookings, adding notes and adding or removing addresses use the tables
-- directly (Admin-only policies). These three commands cover what needs checking or happens in one step.

create function public.admin_update_client(p_client_id uuid, p_details jsonb)
returns setof public.clients
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_email text;
  v_phone text;
  v_matches uuid[];
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_client_id is null or p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'Client details are required' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_details) k where k not in ('first_name', 'last_name', 'email', 'phone'))
     or length(p_details::text) > 2000 then
    raise exception 'Invalid client details' using errcode = '22023';
  end if;
  v_email := lower(nullif(btrim(p_details->>'email'), ''));
  v_phone := nullif(regexp_replace(coalesce(p_details->>'phone', ''), '[^0-9]', '', 'g'), '');
  if nullif(btrim(p_details->>'first_name'), '') is null or length(p_details->>'first_name') > 120
     or length(coalesce(p_details->>'last_name', '')) > 120
     or (v_email is null and v_phone is null)
     or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'))
     or (v_phone is not null and length(v_phone) not between 7 and 20) then
    raise exception 'Name and a valid email or phone are required' using errcode = '22023';
  end if;
  -- The same locks as creating a client, so two edits cannot both claim one email or phone.
  if v_email is not null then perform pg_advisory_xact_lock(hashtext('client-auth-email:' || v_email)); end if;
  if v_phone is not null then perform pg_advisory_xact_lock(hashtext('client-phone:' || v_phone)); end if;
  select * into v_client from public.clients where id = p_client_id for update;
  if not found then raise exception 'Client unavailable' using errcode = 'P0002'; end if;
  select array_agg(m.id) into v_matches from (
    select c.id from public.clients c
    where c.id <> p_client_id
      and ((v_email is not null and c.normalized_email = v_email) or (v_phone is not null and c.normalized_phone = v_phone))
    order by c.id limit 20) m;
  if cardinality(v_matches) > 0 then
    raise exception 'Another client already uses this email or phone.' using errcode = 'PT409', detail = array_to_json(v_matches)::text;
  end if;
  return query update public.clients set first_name = btrim(p_details->>'first_name'), last_name = btrim(coalesce(p_details->>'last_name', '')),
    email = v_email, phone = nullif(btrim(p_details->>'phone'), '') where id = p_client_id returning *;
end;
$$;

create function public.admin_client_summary(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (clock_timestamp() at time zone 'Europe/London')::date;
  v_open text[] := array['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed'];
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then raise exception 'Client unavailable' using errcode = 'P0002'; end if;
  return (select jsonb_build_object(
    'completed_visits', count(*) filter (where b.booking_status = 'completed'),
    'upcoming', count(*) filter (where b.booking_status = any(v_open) and b.date >= v_today),
    'paid_gbp', coalesce(sum(p.amount_gbp) filter (where p.status = 'paid'), 0),
    'late_fees_due_gbp', coalesce(sum(b.late_fee_due_gbp) filter (where b.late_fee_status = 'due'), 0),
    'refunds_due_gbp', coalesce(sum(b.refund_due_gbp), 0),
    'last_visit', (select max(x.date) from public.bookings x where x.client_id = p_client_id and x.booking_status = 'completed'),
    'next_booking', (select jsonb_build_object('id', n.id, 'date', n.date, 'start_minutes', n.start_minutes) from public.bookings n
      where n.client_id = p_client_id and n.booking_status = any(v_open) and n.date >= v_today order by n.date, n.start_minutes limit 1))
    from public.bookings b join public.booking_payments p on p.booking_id = b.id where b.client_id = p_client_id);
end;
$$;

create function public.admin_set_default_address(p_client_id uuid, p_address_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  perform 1 from public.client_addresses where id = p_address_id and client_id = p_client_id for update;
  if not found then raise exception 'Address does not belong to this client' using errcode = '22023'; end if;
  update public.client_addresses set is_default = false where client_id = p_client_id and is_default and id <> p_address_id;
  update public.client_addresses set is_default = true where id = p_address_id;
end;
$$;

revoke all on function public.admin_update_client(uuid, jsonb) from public, anon;
revoke all on function public.admin_client_summary(uuid) from public, anon;
revoke all on function public.admin_set_default_address(uuid, uuid) from public, anon;
grant execute on function public.admin_update_client(uuid, jsonb) to authenticated;
grant execute on function public.admin_client_summary(uuid) to authenticated;
grant execute on function public.admin_set_default_address(uuid, uuid) to authenticated;
