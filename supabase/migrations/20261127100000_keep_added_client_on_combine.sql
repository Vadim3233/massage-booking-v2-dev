-- VAD Massage Booking V2
-- Combining a guest with a client the Admin added always keeps the added profile (ADR-092).
--
-- Before: with no login on either side the Admin could choose either profile to keep. Keeping the guest moved the added client's bookings,
-- addresses and repeats to a profile owned by a guest session, so whoever made that guest booking (anyone can book as a guest with
-- someone else's email or phone) could then see and cancel them. Now the added profile stays and the guest's bookings move into it.

-- admin_merge_clients: as before (20261104100000_single_address.sql), plus the rule above.
CREATE OR REPLACE FUNCTION public.admin_merge_clients(p_keep_client_id uuid, p_remove_client_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_scope text := 'admin-client-merge:' || coalesce(auth.uid()::text, '');
  v_fingerprint text := md5(coalesce(p_keep_client_id::text, '') || ':' || coalesce(p_remove_client_id::text, ''));
  v_command public.command_requests%rowtype;
  v_logged public.client_merges%rowtype;
  v_keep public.clients%rowtype;
  v_remove public.clients%rowtype;
  v_keep_kind text;
  v_remove_kind text;
  v_message text;
  v_lock text;
  v_bookings uuid[];
  v_series uuid[];
  v_notes uuid[];
  v_addresses uuid[];
  v_waitlist uuid[];
  v_holds uuid[];
  v_duplicates jsonb;
  v_keep_had_default boolean;
  v_remove_default uuid;
  v_keep_name text;
  v_moved jsonb;
  v_summary jsonb;
  v_merge_id uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_keep_client_id is null or p_remove_client_id is null or p_request_id is null or p_keep_client_id = p_remove_client_id then
    raise exception 'Choose two different clients' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_command from public.command_requests c where c.scope = v_scope and c.idempotency_key = p_request_id::text for update;
  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode = '22023';
    end if;
    if v_command.status = 'succeeded' then
      select * into v_logged from public.client_merges m where m.id = v_command.result_reference::uuid;
      return v_logged.summary || jsonb_build_object('repeat', true);
    end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;

  -- The same email lock as signing up and adding a client, so a registration on either email waits for this to finish.
  for v_lock in
    select distinct 'client-auth-email:' || c.normalized_email from public.clients c
    where c.id in (p_keep_client_id, p_remove_client_id) and c.normalized_email is not null order by 1
  loop
    perform pg_advisory_xact_lock(hashtext(v_lock));
  end loop;
  -- The repeat job locks a repeat and then its client; this does the same, so the two never wait on each other.
  perform 1 from public.booking_series s where s.client_id = p_remove_client_id order by s.id for update;
  perform 1 from public.clients c where c.id in (p_keep_client_id, p_remove_client_id) order by c.id for update;

  select * into v_keep from public.clients c where c.id = p_keep_client_id;
  if not found then
    raise exception 'One of these clients is no longer there. They may already have been combined.' using errcode = 'P0002';
  end if;
  select * into v_remove from public.clients c where c.id = p_remove_client_id;
  if not found then
    -- Already combined by an earlier request, for example from a second tab.
    select * into v_logged from public.client_merges m
      where m.kept_client_id = p_keep_client_id and m.removed_client_id = p_remove_client_id order by m.merged_at desc limit 1;
    if found then return v_logged.summary || jsonb_build_object('repeat', true); end if;
    raise exception 'One of these clients is no longer there. They may already have been combined.' using errcode = 'P0002';
  end if;

  v_keep_kind := public.client_login_kind(v_keep.auth_user_id);
  v_remove_kind := public.client_login_kind(v_remove.auth_user_id);
  if v_remove_kind = 'registered' then
    v_message := case when v_keep_kind = 'registered'
      then 'Two clients who each have their own login cannot be combined.'
      else 'The client with the login is the one that stays.' end;
    raise exception '%', v_message using errcode = 'PT409';
  end if;
  -- A profile the Admin added (no login) never moves into a guest's: whoever made the guest booking could then see and cancel that client's
  -- bookings from their own phone (ADR-092).
  if v_remove_kind = 'added' and v_keep_kind = 'guest' then
    raise exception 'The client you added is the one that stays.' using errcode = 'PT409';
  end if;

  -- Bookings keep everything about themselves (status, payment, fees, the address they were made for); only the owner changes.
  with moved as (update public.bookings b set client_id = p_keep_client_id where b.client_id = p_remove_client_id returning b.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_bookings from moved;
  with moved as (update public.booking_series s set client_id = p_keep_client_id where s.client_id = p_remove_client_id returning s.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_series from moved;
  with moved as (update public.client_notes n set client_id = p_keep_client_id where n.client_id = p_remove_client_id returning n.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_notes from moved;
  with moved as (update public.waitlist_requests w set client_id = p_keep_client_id where w.client_id = p_remove_client_id returning w.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_waitlist from moved;
  with moved as (update public.booking_holds h set client_id = p_keep_client_id where h.client_id = p_remove_client_id returning h.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_holds from moved;

  -- Addresses: an address the kept profile already has is not copied. Bookings that used the copy now point at the original.
  v_keep_had_default := exists (select 1 from public.client_addresses a where a.client_id = p_keep_client_id and a.is_default);
  select a.id into v_remove_default from public.client_addresses a where a.client_id = p_remove_client_id and a.is_default;
  -- Entry instructions are never lost: two copies count as one only when their instructions agree or one has none, and what the
  -- copy knew that the original did not (instructions, a label) is kept on the original. The whole copy is saved in the history too.
  select coalesce(jsonb_agg(jsonb_build_object('removed', d.removed_id, 'kept', d.kept_id, 'address', d.removed_row)), '[]'::jsonb) into v_duplicates
  from (
    select distinct on (r.id) r.id as removed_id, k.id as kept_id, to_jsonb(r) as removed_row
    from public.client_addresses r
    join public.client_addresses k on k.client_id = p_keep_client_id
      and k.normalized_address = r.normalized_address
      and (nullif(btrim(coalesce(r.entry_instructions, '')), '') is null or nullif(btrim(coalesce(k.entry_instructions, '')), '') is null
        or lower(btrim(r.entry_instructions)) = lower(btrim(k.entry_instructions)))
    where r.client_id = p_remove_client_id
    order by r.id, k.is_default desc, k.created_at, k.id
  ) d;
  update public.client_addresses k set
    entry_instructions = coalesce(nullif(btrim(coalesce(k.entry_instructions, '')), ''), nullif(btrim(coalesce(r.entry_instructions, '')), '')),
    label = coalesce(nullif(btrim(coalesce(k.label, '')), ''), nullif(btrim(coalesce(r.label, '')), ''))
  from (select (e->>'removed')::uuid as removed_id, (e->>'kept')::uuid as kept_id from jsonb_array_elements(v_duplicates) e) d
  join public.client_addresses r on r.id = d.removed_id
  where k.id = d.kept_id;
  update public.bookings b set saved_address_id = d.kept_id
  from (select (e->>'removed')::uuid as removed_id, (e->>'kept')::uuid as kept_id from jsonb_array_elements(v_duplicates) e) d
  where b.saved_address_id = d.removed_id;
  delete from public.client_addresses a where a.id in (select (e->>'removed')::uuid from jsonb_array_elements(v_duplicates) e);
  if v_keep_had_default then
    update public.client_addresses a set is_default = false where a.client_id = p_remove_client_id and a.is_default;
  end if;
  with moved as (update public.client_addresses a set client_id = p_keep_client_id where a.client_id = p_remove_client_id returning a.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_addresses from moved;
  if not v_keep_had_default and v_remove_default is not null
     and not exists (select 1 from public.client_addresses a where a.id = v_remove_default) then
    -- The default address was a copy: the original the kept profile has becomes the default.
    update public.client_addresses a set is_default = true
    where a.id = (select (e->>'kept')::uuid from jsonb_array_elements(v_duplicates) e where (e->>'removed')::uuid = v_remove_default);
  end if;

  -- A repeat keeps a copy of the booking it makes each week, naming the client and perhaps a saved address. Both follow the move, or
  -- every later session of the repeat would fail to be made.
  update public.booking_series s set request = jsonb_set(s.request, '{client_id}', to_jsonb(p_keep_client_id::text))
  where s.id = any(v_series);
  update public.booking_series s set request = jsonb_set(s.request, '{saved_address_id}', to_jsonb(d.kept_id::text))
  from (select (e->>'removed')::uuid as removed_id, (e->>'kept')::uuid as kept_id from jsonb_array_elements(v_duplicates) e) d
  where s.id = any(v_series) and s.request->>'saved_address_id' = d.removed_id::text;

  v_summary := jsonb_build_object('kept_id', v_keep.id, 'removed_id', v_remove.id,
    'bookings', cardinality(v_bookings), 'repeats', cardinality(v_series), 'notes', cardinality(v_notes),
    'addresses', cardinality(v_addresses), 'waitlist', cardinality(v_waitlist));
  v_moved := jsonb_build_object('bookings', to_jsonb(v_bookings), 'repeats', to_jsonb(v_series), 'notes', to_jsonb(v_notes),
    'addresses', to_jsonb(v_addresses), 'duplicate_addresses', v_duplicates, 'waitlist', to_jsonb(v_waitlist), 'holds', to_jsonb(v_holds));
  insert into public.client_merges(kept_client_id, removed_client_id, removed_client, removed_kind, moved, summary, merged_by)
  values (v_keep.id, v_remove.id, to_jsonb(v_remove), v_remove_kind, v_moved, v_summary, auth.uid())
  returning id into v_merge_id;

  -- "Not the same person" answers about the profile that goes now apply to the one that stays.
  insert into public.client_not_same(client_a, client_b, decided_by, decided_at)
  select least(n.other, p_keep_client_id), greatest(n.other, p_keep_client_id), n.decided_by, n.decided_at
  from (select case when s.client_a = p_remove_client_id then s.client_b else s.client_a end as other, s.decided_by, s.decided_at
        from public.client_not_same s where p_remove_client_id in (s.client_a, s.client_b)) n
  where n.other <> p_keep_client_id
  on conflict do nothing;

  -- Everything has moved, so nothing else is removed with the profile.
  delete from public.clients c where c.id = p_remove_client_id;

  update public.clients c set
    created_at = least(c.created_at, v_remove.created_at),
    last_name = case when btrim(c.last_name) = '' then v_remove.last_name else c.last_name end,
    email = coalesce(c.email, v_remove.email),
    phone = coalesce(c.phone, v_remove.phone),
    online_booking_enabled = c.online_booking_enabled and v_remove.online_booking_enabled
  where c.id = p_keep_client_id;

  -- What the repeats' held times and the alerts about the old profile say follows the profile that stays.
  select btrim(c.first_name || ' ' || c.last_name) into v_keep_name from public.clients c where c.id = p_keep_client_id;
  update public.calendar_blocks cb set title = 'Held for ' || coalesce(nullif(v_keep_name, ''), 'a client') || ' (repeat)'
  where cb.series_id = any(v_series) and cb.kind = 'series_hold';
  update public.notification_deliveries d set link_path = '/admin/clients/' || p_keep_client_id::text
  where d.channel = 'in_app' and d.link_path = '/admin/clients/' || p_remove_client_id::text;

  insert into public.client_notes(client_id, author_user_id, note)
  values (p_keep_client_id, auth.uid(),
    format('Combined with another profile on %s: %s%s%s.', to_char(clock_timestamp() at time zone 'Europe/London', 'FMDD FMMon YYYY'),
      btrim(v_remove.first_name || ' ' || v_remove.last_name), coalesce(', ' || v_remove.email, ''), coalesce(', ' || v_remove.phone, '')));

  perform public.mark_duplicate_alerts_read(p_remove_client_id);

  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type,
    request_fingerprint, status, result_reference, completed_at)
  values (v_scope, p_request_id::text, 'admin', 'admin', auth.uid()::text, 'admin_merge_clients', v_fingerprint,
    'succeeded', v_merge_id::text, clock_timestamp());
  return v_summary;
end;
$function$;
