-- Admin orchestration reuses the private quote and scheduling engines.
-- Local migration only: hosted application requires a separate migration review.

create function public.admin_search_clients(p_query text default '')
returns table(id uuid, first_name text, last_name text, email text, phone text)
language plpgsql security definer set search_path = '' as $$
declare v_query text := lower(btrim(coalesce(p_query,''))); v_phone text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if length(v_query)>200 then raise exception 'Search is too long' using errcode='22023'; end if;
  v_phone := regexp_replace(v_query,'[^0-9]','','g');
  return query select c.id,c.first_name,c.last_name,c.email,c.phone from public.clients c
    where v_query='' or strpos(lower(c.first_name || ' ' || c.last_name),v_query)>0
      or strpos(coalesce(c.normalized_email,''),v_query)>0
      or (v_phone<>'' and strpos(coalesce(c.normalized_phone,''),v_phone)>0)
    order by c.updated_at desc,c.id limit 20;
end; $$;

create function public.admin_client_addresses(p_client_id uuid)
returns setof public.client_addresses
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  return query select a.* from public.client_addresses a where a.client_id=p_client_id
    order by a.is_default desc,a.created_at desc,a.id limit 50;
end; $$;

create function public.admin_create_client(p_details jsonb,p_request_id uuid)
returns setof public.clients
language plpgsql security definer set search_path = '' as $$
declare
  v_scope text := 'admin-client:' || auth.uid()::text;
  v_fingerprint text; v_command public.command_requests%rowtype;
  v_client public.clients%rowtype; v_email text; v_phone text; v_matches uuid[];
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
  if nullif(btrim(p_details->>'first_name'),'') is null or length(p_details->>'first_name')>120
    or length(coalesce(p_details->>'last_name',''))>120
    or (v_email is null and v_phone is null)
    or (v_email is not null and (length(v_email)>254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'))
    or (v_phone is not null and length(v_phone) not between 7 and 20) then
    raise exception 'Name and a valid email or phone are required' using errcode='22023';
  end if;
  if nullif(btrim(p_details->>'address_line_1'),'') is null or nullif(btrim(p_details->>'city'),'') is null
    or nullif(btrim(p_details->>'postcode'),'') is null then
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
  insert into public.client_addresses(client_id,address_line_1,address_line_2,city,postcode,entry_instructions,is_default)
    values(v_client.id,p_details->>'address_line_1',p_details->>'address_line_2',p_details->>'city',p_details->>'postcode',p_details->>'entry_instructions',true);
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_create_client',v_fingerprint,'succeeded',v_client.id::text,clock_timestamp()) returning * into v_command;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('client.created','client',v_client.id,v_command.id,'admin-client:' || v_command.id::text,jsonb_build_object('client_id',v_client.id,'actor_id',auth.uid()));
  return next v_client;
end; $$;

create function public.admin_quote_booking(p_service_area_id uuid,p_sessions jsonb,p_enhancement_ids uuid[] default '{}'::uuid[])
returns table(service_area_name text,primary_service_id uuid,treatment_duration_minutes integer,service_subtotal_gbp numeric(10,2),
  enhancements_total_gbp numeric(10,2),travel_fee_gbp numeric(10,2),congestion_fee_gbp numeric(10,2),total_gbp numeric(10,2))
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if coalesce(cardinality(p_enhancement_ids),0)>50 or octet_length(p_sessions::text)>16000 then
    raise exception 'Booking selection is too large' using errcode='22023';
  end if;
  return query select * from public.compute_client_booking_quote(p_service_area_id,p_sessions,p_enhancement_ids);
end; $$;

create function public.admin_booking_availability(p_date date,p_treatment_duration_minutes integer)
returns table(start_minutes integer)
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_today date;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  v_today := (v_now at time zone 'Europe/London')::date;
  if p_date is null or p_date<v_today or p_date>v_today+365 then
    raise exception 'Choose a date within the next 365 days' using errcode='22023';
  end if;
  if p_treatment_duration_minutes is null or p_treatment_duration_minutes not between 60 and 240 or mod(p_treatment_duration_minutes,30)<>0 then
    raise exception 'Booking duration is invalid' using errcode='22023';
  end if;
  return query select a.start_minutes from public.compute_booking_availability(p_date,p_treatment_duration_minutes,v_now,60,null) a
    where (p_date + make_interval(mins=>a.start_minutes)) at time zone 'Europe/London' > v_now
    order by a.start_minutes;
end; $$;

create function public.admin_create_booking(p_request jsonb,p_request_id uuid)
returns table(booking_id uuid,booking_reference text,booking_status text,payment_status text,total_gbp numeric(10,2))
language plpgsql security definer set search_path = '' as $$
declare
  v_scope text := 'admin-booking:' || auth.uid()::text; v_fingerprint text;
  v_command public.command_requests%rowtype; v_client public.clients%rowtype; v_address public.client_addresses%rowtype;
  v_date date; v_start integer; v_area_id uuid; v_sessions jsonb; v_enhancement_ids uuid[];
  v_quote record; v_now timestamptz; v_booking_id uuid := gen_random_uuid(); v_reference text;
  v_payment text; v_payment_method text; v_payment_status text; v_note text;
  v_session jsonb; v_session_id uuid; v_position integer:=0; v_service_id uuid; v_duration integer;
  v_service_name text; v_price numeric(10,2); v_recipient text; v_preferences uuid[]; v_enhancement public.enhancements%rowtype;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_request_id is null or p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>32000 then
    raise exception 'Booking details and request key are required' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_request) k where k not in
    ('client_id','saved_address_id','address','service_area_id','sessions','enhancement_ids','date','start_minutes','payment_arrangement','note')) then
    raise exception 'Unsupported booking fields' using errcode='22023';
  end if;
  v_fingerprint:=md5(p_request::text);
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_command from public.command_requests c where c.scope=v_scope and c.idempotency_key=p_request_id::text for update;
  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if v_command.status='succeeded' then
      return query select b.id,b.booking_reference,b.booking_status,p.status,b.total_gbp from public.bookings b
        join public.booking_payments p on p.booking_id=b.id where b.id=v_command.result_reference::uuid;
      return;
    end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  v_date := (p_request->>'date')::date; v_start := (p_request->>'start_minutes')::integer;
  if v_date is null or v_start is null or v_start not between 0 and 1439 or mod(v_start,30)<>0 then
    raise exception 'Booking date and a 30-minute start boundary are required' using errcode='22023';
  end if;
  -- Every supported booking/hold/payment writer takes this date namespace.
  perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
  v_now:=clock_timestamp();
  select * into v_client from public.clients c where c.id=(p_request->>'client_id')::uuid for share;
  if not found then raise exception 'Client unavailable' using errcode='22023'; end if;
  if nullif(p_request->>'saved_address_id','') is not null then
    if p_request->'address' is not null and p_request->'address'<>'null'::jsonb then
      raise exception 'Choose a saved address or a one-off address' using errcode='22023';
    end if;
    select * into v_address from public.client_addresses a where a.id=(p_request->>'saved_address_id')::uuid and a.client_id=v_client.id for share;
    if not found then raise exception 'Address does not belong to this client' using errcode='22023'; end if;
  else
    if jsonb_typeof(p_request->'address') is distinct from 'object' then raise exception 'Booking address is required' using errcode='22023'; end if;
    v_address.address_line_1:=nullif(btrim(p_request->'address'->>'address_line_1'),'');
    v_address.address_line_2:=nullif(btrim(p_request->'address'->>'address_line_2'),'');
    v_address.city:=nullif(btrim(p_request->'address'->>'city'),'');
    v_address.postcode:=upper(nullif(btrim(p_request->'address'->>'postcode'),''));
    v_address.entry_instructions:=nullif(btrim(p_request->'address'->>'entry_instructions'),'');
    if v_address.address_line_1 is null or v_address.city is null or v_address.postcode is null then
      raise exception 'Address, city and postcode are required' using errcode='22023';
    end if;
  end if;
  v_area_id:=(p_request->>'service_area_id')::uuid; v_sessions:=p_request->'sessions';
  if p_request ? 'enhancement_ids' and jsonb_typeof(p_request->'enhancement_ids')<>'array' then
    raise exception 'Enhancements must be an array' using errcode='22023';
  end if;
  select coalesce(array_agg(e::uuid),'{}'::uuid[]) into v_enhancement_ids from jsonb_array_elements_text(coalesce(p_request->'enhancement_ids','[]'::jsonb)) e;
  if cardinality(v_enhancement_ids)>50 then raise exception 'Too many enhancements' using errcode='22023'; end if;
  -- Prevent catalogue edits between the authoritative quote and the snapshots.
  -- Lock selected rows in deterministic table/id order before reading prices.
  perform 1 from public.service_areas a where a.id=v_area_id for share;
  if jsonb_typeof(v_sessions) is distinct from 'array' then raise exception 'Booking sessions must be an array' using errcode='22023'; end if;
  perform 1 from public.services s where s.id in(select (j->>'service_id')::uuid from jsonb_array_elements(v_sessions) j) order by s.id for share;
  perform 1 from public.service_duration_prices d where d.service_id in(select (j->>'service_id')::uuid from jsonb_array_elements(v_sessions) j) order by d.service_id,d.duration_minutes for share;
  perform 1 from public.enhancements e where e.id=any(v_enhancement_ids) order by e.id for share;
  select * into v_quote from public.admin_quote_booking(v_area_id,v_sessions,v_enhancement_ids);
  if not exists(select 1 from public.admin_booking_availability(v_date,v_quote.treatment_duration_minutes) a where a.start_minutes=v_start) then
    raise exception 'This time is no longer available. Choose another time.' using errcode='PT409';
  end if;
  v_payment:=p_request->>'payment_arrangement';
  if v_payment is null or v_payment not in ('bank_pending','bank_received','cash_appointment','cash_received') then
    raise exception 'Choose a payment arrangement' using errcode='22023';
  end if;
  v_payment_method:=case when v_payment in ('bank_pending','bank_received') then 'bank_transfer' else 'cash' end;
  v_payment_status:=case v_payment when 'bank_pending' then 'awaiting_transfer' when 'cash_appointment' then 'approved' else 'paid' end;
  v_note:=nullif(btrim(p_request->>'note'),'');
  if length(v_note)>4000 then raise exception 'Appointment note is too long' using errcode='22023'; end if;
  v_reference:='VDM-' || to_char(v_now at time zone 'UTC','YYYYMMDDHH24MISS') || '-' || upper(substr(replace(v_booking_id::text,'-',''),1,8));
  insert into public.bookings(id,booking_reference,client_id,saved_address_id,service_area_id,date,start_minutes,treatment_duration_minutes,
    travel_buffer_minutes,booking_status,source_channel,created_by_actor_type,created_by_actor_id,
    address_line_1_snapshot,address_line_2_snapshot,city_snapshot,postcode_snapshot,entry_instructions_snapshot,service_area_name_snapshot,
    service_subtotal_gbp,enhancements_total_gbp,travel_fee_gbp,congestion_fee_gbp,total_gbp,booking_email_snapshot,payment_reservation_expires_at,client_note)
  values(v_booking_id,v_reference,v_client.id,v_address.id,v_area_id,v_date,v_start,v_quote.treatment_duration_minutes,60,'confirmed','admin','admin',auth.uid()::text,
    v_address.address_line_1,v_address.address_line_2,v_address.city,v_address.postcode,v_address.entry_instructions,v_quote.service_area_name,
    v_quote.service_subtotal_gbp,v_quote.enhancements_total_gbp,v_quote.travel_fee_gbp,v_quote.congestion_fee_gbp,v_quote.total_gbp,v_client.email,null,v_note);
  for v_session in select value from jsonb_array_elements(v_sessions) loop
    v_position:=v_position+1; v_service_id:=(v_session->>'service_id')::uuid; v_duration:=(v_session->>'duration_minutes')::integer;
    v_recipient:=nullif(btrim(v_session->>'recipient_name'),'');
    if v_recipient is null or length(v_recipient)>120 then raise exception 'Each session needs a recipient name of at most 120 characters' using errcode='22023'; end if;
    select s.name,d.price_gbp into v_service_name,v_price from public.services s join public.service_duration_prices d on d.service_id=s.id
      where s.id=v_service_id and d.duration_minutes=v_duration and s.active and d.active;
    insert into public.booking_sessions(booking_id,position,service_id,duration_minutes,service_name_snapshot,unit_price_gbp,recipient_name)
      values(v_booking_id,v_position,v_service_id,v_duration,v_service_name,v_price,v_recipient) returning id into v_session_id;
    if v_session ? 'preference_ids' and jsonb_typeof(v_session->'preference_ids')<>'array' then
      raise exception 'Session preferences must be an array' using errcode='22023';
    end if;
    select coalesce(array_agg(p::uuid),'{}'::uuid[]) into v_preferences from jsonb_array_elements_text(coalesce(v_session->'preference_ids','[]'::jsonb)) p;
    if cardinality(v_preferences)>50 or cardinality(v_preferences)<>(select count(distinct p) from unnest(v_preferences) p) then
      raise exception 'Session preference selection contains duplicates or too many entries' using errcode='22023';
    end if;
    perform 1 from public.session_preferences p where p.id=any(v_preferences) order by p.id for share;
    if (select count(*) from public.session_preferences p where p.id=any(v_preferences) and p.active)<>cardinality(v_preferences) then
      raise exception 'Selected session preference is no longer available' using errcode='22023';
    end if;
    if exists(select 1 from public.session_preference_conflicts c where c.preference_id=any(v_preferences) and c.conflicting_preference_id=any(v_preferences)) then
      raise exception 'Selected session preferences conflict' using errcode='22023';
    end if;
    insert into public.booking_session_preferences(booking_session_id,preference_id,preference_label_snapshot,preference_category_snapshot)
      select v_session_id,p.id,p.label,p.category from public.session_preferences p where p.id=any(v_preferences);
  end loop;
  for v_enhancement in select e.* from public.enhancements e where e.id=any(v_enhancement_ids) loop
    insert into public.booking_enhancements(booking_id,enhancement_id,enhancement_name_snapshot,quantity,unit_price_gbp,duration_minutes_snapshot)
      values(v_booking_id,v_enhancement.id,v_enhancement.name,1,v_enhancement.price_gbp,0);
  end loop;
  v_now:=clock_timestamp();
  insert into public.booking_payments(booking_id,method,status,amount_gbp,payment_reference,paid_at,verified_at,verified_by)
    values(v_booking_id,v_payment_method,v_payment_status,v_quote.total_gbp,v_reference,
      case when v_payment_status='paid' then v_now end,case when v_payment='bank_received' then v_now end,case when v_payment='bank_received' then auth.uid() end);
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_create_booking',v_fingerprint,'succeeded',v_booking_id::text,v_now) returning * into v_command;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.created','booking',v_booking_id,v_command.id,'booking.created:' || v_booking_id::text,
      jsonb_build_object('booking_id',v_booking_id,'booking_reference',v_reference,'client_id',v_client.id,'booking_status','confirmed',
        'payment_status',v_payment_status,'date',v_date,'start_minutes',v_start,'total_gbp',v_quote.total_gbp,'actor_id',auth.uid()));
  return query select v_booking_id,v_reference,'confirmed'::text,v_payment_status,v_quote.total_gbp::numeric(10,2);
end; $$;

create function public.admin_record_bank_transfer_received(p_booking_id uuid,p_request_id uuid,p_booking_updated_at timestamptz,p_payment_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; p public.booking_payments%rowtype; c public.command_requests%rowtype;
  v_date date; v_now timestamptz; v_scope text:='admin-payment:' || auth.uid()::text; v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint:=md5(concat_ws('|','admin_record_bank_transfer_received',p_booking_id::text,extract(epoch from p_booking_updated_at)::text,extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests cr where cr.scope=v_scope and cr.idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at
    or p.updated_at is distinct from p_payment_updated_at or b.booking_status not in ('confirmed','completed')
    or p.method<>'bank_transfer' or p.status<>'awaiting_transfer' then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp then raise exception 'Payment amount needs review' using errcode='22023'; end if;
  v_now:=clock_timestamp();
  update public.booking_payments set status='paid',paid_at=v_now,verified_at=v_now,verified_by=auth.uid() where id=p.id;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_record_bank_transfer_received',v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.bank_transfer_received','booking',b.id,c.id,'admin-payment:' || c.id::text,
      jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,'previous_payment_status',p.status,'payment_status','paid','booking_status',b.booking_status,'amount_gbp',p.amount_gbp));
  return b.id;
end; $$;

revoke all on function public.admin_search_clients(text),public.admin_client_addresses(uuid),public.admin_create_client(jsonb,uuid),
  public.admin_quote_booking(uuid,jsonb,uuid[]),public.admin_booking_availability(date,integer),public.admin_create_booking(jsonb,uuid),
  public.admin_record_bank_transfer_received(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.admin_search_clients(text),public.admin_client_addresses(uuid),public.admin_create_client(jsonb,uuid),
  public.admin_quote_booking(uuid,jsonb,uuid[]),public.admin_booking_availability(date,integer),public.admin_create_booking(jsonb,uuid),
  public.admin_record_bank_transfer_received(uuid,uuid,timestamptz,timestamptz) to authenticated;
-- Explicitly retain the existing browser mutation boundary.
revoke insert,update,delete,truncate on public.bookings,public.booking_payments from authenticated;
