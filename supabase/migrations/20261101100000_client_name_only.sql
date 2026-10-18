-- VAD Massage Booking V2
-- Adding a client needs only a name.
--
-- Until now the Admin could not add a client without a phone number or an email, and a new client always had to come with a full
-- address. Often neither is known (a name from a list, someone who is simply known to her), so now:
--   * a client needs only a first name; last name, phone, email and address are all optional;
--   * an email or phone, when given, still has to look right, and still cannot belong to another client;
--   * an address is optional as a whole: leave it out, or give the street, city and postcode. A bare city (the screens fill in
--     London) does not count as an address; anything else does, and then all three parts are needed.
-- Editing a client follows the same rule: contact details can be left empty or cleared.
-- Nothing else changes: the duplicate checks, the request key that makes a retry safe, the event, who may call these.
-- It is safe to apply before the screens change: the old screens send the same details as before.

create or replace function public.admin_create_client(p_details jsonb,p_request_id uuid)
returns setof public.clients
language plpgsql security definer set search_path = '' as $$
declare
  v_scope text := 'admin-client:' || auth.uid()::text;
  v_fingerprint text; v_command public.command_requests%rowtype;
  v_client public.clients%rowtype; v_email text; v_phone text; v_matches uuid[]; v_has_address boolean;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_request_id is null or p_details is null or jsonb_typeof(p_details)<>'object' then
    raise exception 'Client details and request key are required' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_details) k where k not in
    ('first_name','last_name','email','phone','address_line_1','address_line_2','city','postcode','entry_instructions'))
    or length(p_details::text)>12000 then raise exception 'Invalid client details' using errcode='22023'; end if;
  v_fingerprint := md5(p_details::text);
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_command from public.command_requests c where c.scope=v_scope and c.idempotency_key=p_request_id::text for update;
  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if v_command.status='succeeded' then return query select c.* from public.clients c where c.id=v_command.result_reference::uuid; return; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  v_email := lower(nullif(btrim(p_details->>'email'),''));
  v_phone := nullif(regexp_replace(coalesce(p_details->>'phone',''),'[^0-9]','','g'),'');
  -- Only the name is needed; an email or phone, if there is one, has to look right.
  if nullif(btrim(p_details->>'first_name'),'') is null or length(p_details->>'first_name')>120
    or length(coalesce(p_details->>'last_name',''))>120
    or (v_email is not null and (length(v_email)>254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'))
    or (v_phone is not null and length(v_phone) not between 7 and 20) then
    raise exception 'A name is required, and an email or phone must be valid if you give one' using errcode='22023';
  end if;
  -- An address is optional as a whole. A bare city is not an address; any other part makes it one, and then it needs all three.
  v_has_address := nullif(btrim(p_details->>'address_line_1'),'') is not null or nullif(btrim(p_details->>'address_line_2'),'') is not null
    or nullif(btrim(p_details->>'postcode'),'') is not null or nullif(btrim(p_details->>'entry_instructions'),'') is not null;
  if v_has_address and (nullif(btrim(p_details->>'address_line_1'),'') is null or nullif(btrim(p_details->>'city'),'') is null
    or nullif(btrim(p_details->>'postcode'),'') is null) then
    raise exception 'Address, city and postcode are required' using errcode='22023';
  end if;
  -- Same email namespace as authenticated account activation. Guest identity
  -- deliberately does not merge unverified contacts; no global uniqueness change.
  if v_email is not null then perform pg_advisory_xact_lock(hashtext('client-auth-email:' || v_email)); end if;
  if v_phone is not null then perform pg_advisory_xact_lock(hashtext('client-phone:' || v_phone)); end if;
  select array_agg(m.id) into v_matches from (select c.id from public.clients c
    where (v_email is not null and c.normalized_email=v_email) or (v_phone is not null and c.normalized_phone=v_phone)
    order by c.id limit 20) m;
  if cardinality(v_matches)>0 then
    raise exception 'An existing client uses this email or phone. Select that client instead.'
      using errcode='PT409',detail=array_to_json(v_matches)::text;
  end if;
  insert into public.clients(first_name,last_name,email,phone)
    values(btrim(p_details->>'first_name'),btrim(coalesce(p_details->>'last_name','')),v_email,nullif(btrim(p_details->>'phone'),'')) returning * into v_client;
  if v_has_address then
    insert into public.client_addresses(client_id,address_line_1,address_line_2,city,postcode,entry_instructions,is_default)
      values(v_client.id,p_details->>'address_line_1',p_details->>'address_line_2',p_details->>'city',p_details->>'postcode',p_details->>'entry_instructions',true);
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_create_client',v_fingerprint,'succeeded',v_client.id::text,clock_timestamp()) returning * into v_command;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('client.created','client',v_client.id,v_command.id,'admin-client:' || v_command.id::text,jsonb_build_object('client_id',v_client.id,'actor_id',auth.uid()));
  return next v_client;
end; $$;

create or replace function public.admin_update_client(p_client_id uuid, p_details jsonb)
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
  -- Only the name is needed; an email or phone, if there is one, has to look right (and either may be cleared).
  if nullif(btrim(p_details->>'first_name'), '') is null or length(p_details->>'first_name') > 120
     or length(coalesce(p_details->>'last_name', '')) > 120
     or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'))
     or (v_phone is not null and length(v_phone) not between 7 and 20) then
    raise exception 'A name is required, and an email or phone must be valid if you give one' using errcode = '22023';
  end if;
  -- The same locks as creating a client, so two edits cannot both claim one email or phone.
  if v_email is not null then perform pg_advisory_xact_lock(hashtext('client-auth-email:' || v_email)); end if;
  if v_phone is not null then perform pg_advisory_xact_lock(hashtext('client-phone:' || v_phone)); end if;
  select * into v_client from public.clients where id = p_client_id for update;
  if not found then raise exception 'Client unavailable' using errcode = 'P0002'; end if;
  select array_agg(m.id) into v_matches from (
    select c.id from public.clients c
    where c.id <> p_client_id
      and ((v_email is not null and v_email is distinct from v_client.normalized_email and c.normalized_email = v_email)
        or (v_phone is not null and v_phone is distinct from v_client.normalized_phone and c.normalized_phone = v_phone))
      and not exists (select 1 from public.client_not_same n where n.client_a = least(c.id, p_client_id) and n.client_b = greatest(c.id, p_client_id))
    order by c.id limit 20) m;
  if cardinality(v_matches) > 0 then
    raise exception 'Another client already uses this email or phone.' using errcode = 'PT409', detail = array_to_json(v_matches)::text;
  end if;
  return query update public.clients set first_name = btrim(p_details->>'first_name'), last_name = btrim(coalesce(p_details->>'last_name', '')),
    email = v_email, phone = nullif(btrim(p_details->>'phone'), '') where id = p_client_id returning *;
end;
$$;
