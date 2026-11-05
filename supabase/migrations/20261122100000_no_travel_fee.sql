-- "No travel fee" for a client (Vadim, 31 Oct 2026).
--
-- The travel fee comes from the client's area. From this migration the Admin can switch it off for one client (Clients > the client >
-- "No travel fee"). While it is on, that client's new bookings have no travel fee: when they book in the app while signed in, when they book
-- through their own AI assistant, and when the Admin books for them. The congestion charge still applies. Bookings already made keep their price.
-- Edit address to another area brings that area's congestion charge but, for this client, no travel fee.
--
-- How: the quote every booking path uses (compute_client_booking_quote) now knows the client. The Admin's paths pass the client; a client's own
-- paths find it from who is signed in. The old quote is kept, renamed compute_area_booking_quote, and does the sums as before.
--
-- To take this back: drop compute_client_booking_quote(uuid,jsonb,uuid[],uuid) and admin_quote_booking(uuid,jsonb,uuid[],uuid), rename
-- compute_area_booking_quote back to compute_client_booking_quote, run admin_quote_booking from 20261008120000_admin_new_booking.sql (with its revoke and
-- grant), admin_create_booking from 20261104100000_single_address.sql and admin_change_booking_address from 20261118100000_area_postcodes.sql again,
-- and drop the column clients.no_travel_fee.

-- ---------------------------------------------------------------------------------------------
-- 1. The switch
-- ---------------------------------------------------------------------------------------------
-- Only the Admin can change it: clients can read their own record but not write it.
alter table public.clients add column no_travel_fee boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- 2. The quote, for a client
-- ---------------------------------------------------------------------------------------------
alter function public.compute_client_booking_quote(uuid, jsonb, uuid[]) rename to compute_area_booking_quote;

-- p_client_id is the client the Admin is booking for. Left out, it is the signed-in client (never the Admin's own record).
create function public.compute_client_booking_quote(p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[], p_client_id uuid default null)
returns table (service_area_name text, primary_service_id uuid, treatment_duration_minutes integer, service_subtotal_gbp numeric(10,2),
  enhancements_total_gbp numeric(10,2), travel_fee_gbp numeric(10,2), congestion_fee_gbp numeric(10,2), total_gbp numeric(10,2))
language plpgsql security definer set search_path = '' as $$
declare v_free boolean := false;
begin
  if p_client_id is not null then
    select coalesce(bool_or(c.no_travel_fee), false) into v_free from public.clients c where c.id = p_client_id;
  elsif auth.uid() is not null and not public.is_booking_admin() then
    select coalesce(bool_or(c.no_travel_fee), false) into v_free from public.clients c where c.auth_user_id = auth.uid();
  end if;
  return query
    select q.service_area_name, q.primary_service_id, q.treatment_duration_minutes, q.service_subtotal_gbp, q.enhancements_total_gbp,
      (case when v_free then 0 else q.travel_fee_gbp end)::numeric(10,2), q.congestion_fee_gbp,
      (case when v_free then q.total_gbp - q.travel_fee_gbp else q.total_gbp end)::numeric(10,2)
    from public.compute_area_booking_quote(p_service_area_id, p_sessions, p_enhancement_ids) q;
end; $$;
revoke all on function public.compute_client_booking_quote(uuid, jsonb, uuid[], uuid) from public, anon, authenticated;
revoke all on function public.compute_area_booking_quote(uuid, jsonb, uuid[]) from public, anon, authenticated;

-- The Admin's quote, now for the client being booked (the New booking screen sends it).
drop function public.admin_quote_booking(uuid, jsonb, uuid[]);
create function public.admin_quote_booking(p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[] default '{}'::uuid[], p_client_id uuid default null)
returns table (service_area_name text, primary_service_id uuid, treatment_duration_minutes integer, service_subtotal_gbp numeric(10,2),
  enhancements_total_gbp numeric(10,2), travel_fee_gbp numeric(10,2), congestion_fee_gbp numeric(10,2), total_gbp numeric(10,2))
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if coalesce(cardinality(p_enhancement_ids),0)>50 or octet_length(p_sessions::text)>16000 then
    raise exception 'Booking selection is too large' using errcode='22023';
  end if;
  return query select * from public.compute_client_booking_quote(p_service_area_id,p_sessions,p_enhancement_ids,p_client_id);
end; $$;
revoke all on function public.admin_quote_booking(uuid, jsonb, uuid[], uuid) from public, anon;
grant execute on function public.admin_quote_booking(uuid, jsonb, uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The Admin's new booking: as 20261104100000_single_address.sql, with the client passed to the quote
-- ---------------------------------------------------------------------------------------------
-- (Repeat bookings go through this one too.)
CREATE OR REPLACE FUNCTION public.admin_create_booking(p_request jsonb, p_request_id uuid)
 RETURNS TABLE(booking_id uuid, booking_reference text, booking_status text, payment_status text, total_gbp numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_scope text := 'admin-booking:' || auth.uid()::text; v_fingerprint text;
  v_command public.command_requests%rowtype; v_client public.clients%rowtype; v_address public.client_addresses%rowtype;
  v_date date; v_start integer; v_area_id uuid; v_sessions jsonb; v_enhancement_ids uuid[];
  v_quote record; v_now timestamptz; v_booking_id uuid := gen_random_uuid(); v_reference text;
  v_payment text; v_payment_method text; v_payment_status text; v_note text;
  v_session jsonb; v_session_id uuid; v_position integer:=0; v_service_id uuid; v_duration integer;
  v_service_name text; v_price numeric(10,2); v_recipient text; v_preferences uuid[]; v_enhancement public.enhancements%rowtype;
  v_any boolean := false; v_today date; v_past boolean := false; v_started boolean; v_paid_at timestamptz;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_request_id is null or p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>32000 then
    raise exception 'Booking details and request key are required' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_request) k where k not in
    ('client_id','saved_address_id','address','service_area_id','sessions','enhancement_ids','date','start_minutes','payment_arrangement','note','any_time','past')) then
    raise exception 'Unsupported booking fields' using errcode='22023';
  end if;
  -- "Any time": the Admin chose a time the app would not normally offer (see the time check below).
  if p_request ? 'any_time' then
    if jsonb_typeof(p_request->'any_time') is distinct from 'boolean' then raise exception 'Unsupported booking fields' using errcode='22023'; end if;
    v_any:=(p_request->>'any_time')::boolean;
  end if;
  -- "Past": the Admin is recording an appointment that has already happened (see the time check below).
  if p_request ? 'past' then
    if jsonb_typeof(p_request->'past') is distinct from 'boolean' then raise exception 'Unsupported booking fields' using errcode='22023'; end if;
    v_past:=(p_request->>'past')::boolean;
    if v_past and v_any then raise exception 'Unsupported booking fields' using errcode='22023'; end if;
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
    v_address.entry_instructions:=nullif(btrim(p_request->'address'->>'entry_instructions'),'');
    if p_request->'address' ? 'address' then
      -- The address as one text, tidied (line breaks become commas). The old parts are left empty.
      v_address.address:=public.clean_address(p_request->'address'->>'address');
      if v_address.address is null then raise exception 'Address is required' using errcode='22023'; end if;
      if length(v_address.address)>400 then raise exception 'That address is too long' using errcode='22023'; end if;
    else
      v_address.address_line_1:=nullif(btrim(p_request->'address'->>'address_line_1'),'');
      v_address.address_line_2:=nullif(btrim(p_request->'address'->>'address_line_2'),'');
      v_address.city:=nullif(btrim(p_request->'address'->>'city'),'');
      v_address.postcode:=upper(nullif(btrim(p_request->'address'->>'postcode'),''));
      if v_address.address_line_1 is null or v_address.city is null or v_address.postcode is null then
        raise exception 'Address, city and postcode are required' using errcode='22023';
      end if;
      v_address.address:=public.clean_address(concat_ws(', ',v_address.address_line_1,v_address.address_line_2,v_address.city,v_address.postcode));
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
  select * into v_quote from public.admin_quote_booking(v_area_id,v_sessions,v_enhancement_ids,v_client.id);
  if v_past then
    -- Recording what has already happened, on purpose (a time that has begun is refused without "past", exactly as before):
    -- working hours, the usual gap and blocked time do not apply. A double booking is still refused.
    v_today:=(v_now at time zone 'Europe/London')::date;
    v_started:=(v_date+make_interval(mins=>v_start)) at time zone 'Europe/London'<=v_now;
    if not v_started then raise exception 'That time has not happened yet. Turn off "It has already happened" to book it.' using errcode='22023'; end if;
    if v_date<v_today-365 then raise exception 'Choose a date within the last 365 days' using errcode='22023'; end if;
    if v_start+v_quote.treatment_duration_minutes>1440 then raise exception 'That appointment would run past midnight. Choose an earlier time.' using errcode='22023'; end if;
    if public.admin_time_clash(v_date,v_start,v_quote.treatment_duration_minutes,v_now) then
      raise exception 'That time overlaps another appointment, so it cannot be recorded. Choose another time.' using errcode='PT409';
    end if;
    if exists(select 1 from public.booking_holds h where h.date=v_date and h.status='active' and h.expires_at>v_now) then
      raise exception 'A client is in the middle of booking that day. Try again in a few minutes.' using errcode='PT409';
    end if;
  elsif v_any then
    -- The usual run of appointments, the gap between them and working hours are set aside on purpose. A double booking is not.
    v_today:=(v_now at time zone 'Europe/London')::date;
    if v_date<v_today or v_date>v_today+365 then raise exception 'Choose a date within the next 365 days' using errcode='22023'; end if;
    if v_start+v_quote.treatment_duration_minutes>1440 then raise exception 'That appointment would run past midnight. Choose an earlier time.' using errcode='22023'; end if;
    if (v_date+make_interval(mins=>v_start)) at time zone 'Europe/London'<=v_now then raise exception 'That time is in the past. Choose another time.' using errcode='PT409'; end if;
    if public.admin_time_clash(v_date,v_start,v_quote.treatment_duration_minutes,v_now) then
      raise exception 'That time overlaps another appointment, so it is not available. Choose another time.' using errcode='PT409';
    end if;
    -- A client who is part-way through booking has a time held for them, and it is only confirmed if it is still one of the usual times
    -- when they press Confirm. An appointment at an unusual time elsewhere that day could take that away, so unusual times wait until
    -- no client is booking that day (a hold lasts a few minutes).
    if exists(select 1 from public.booking_holds h where h.date=v_date and h.status='active' and h.expires_at>v_now) then
      raise exception 'A client is in the middle of booking that day. Try again in a few minutes.' using errcode='PT409';
    end if;
  elsif not exists(select 1 from public.admin_booking_availability(v_date,v_quote.treatment_duration_minutes) a where a.start_minutes=v_start) then
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
    address_line_1_snapshot,address_line_2_snapshot,city_snapshot,postcode_snapshot,address_snapshot,entry_instructions_snapshot,service_area_name_snapshot,
    service_subtotal_gbp,enhancements_total_gbp,travel_fee_gbp,congestion_fee_gbp,total_gbp,booking_email_snapshot,payment_reservation_expires_at,client_note)
  values(v_booking_id,v_reference,v_client.id,v_address.id,v_area_id,v_date,v_start,v_quote.treatment_duration_minutes,60,'confirmed','admin','admin',auth.uid()::text,
    v_address.address_line_1,v_address.address_line_2,v_address.city,v_address.postcode,v_address.address,v_address.entry_instructions,v_quote.service_area_name,
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
  -- Something that has already happened was paid for at the time, as far as anyone knows, so a paid one is dated the day of the appointment (never
  -- later than now) and a receipt for it reads right. The Admin's check of it is dated now, which is when she recorded it.
  v_paid_at:=case when v_past then least(v_now,(v_date+make_interval(mins=>v_start)) at time zone 'Europe/London') else v_now end;
  insert into public.booking_payments(booking_id,method,status,amount_gbp,payment_reference,paid_at,verified_at,verified_by)
    values(v_booking_id,v_payment_method,v_payment_status,v_quote.total_gbp,v_reference,
      case when v_payment_status='paid' then v_paid_at end,case when v_payment='bank_received' then v_now end,case when v_payment='bank_received' then auth.uid() end);
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_create_booking',v_fingerprint,'succeeded',v_booking_id::text,v_now) returning * into v_command;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.created','booking',v_booking_id,v_command.id,'booking.created:' || v_booking_id::text,
      jsonb_build_object('booking_id',v_booking_id,'booking_reference',v_reference,'client_id',v_client.id,'booking_status','confirmed',
        'payment_status',v_payment_status,'date',v_date,'start_minutes',v_start,'total_gbp',v_quote.total_gbp,'actor_id',auth.uid())
        || case when v_past then jsonb_build_object('past',true) else '{}'::jsonb end);
  -- Recorded as paid, it is a visit that happened and was paid for: completed straight away, through the one step the status guard allows
  -- (confirmed to completed), so the history shows both. Unpaid, it stays confirmed for the Admin to finish. No email goes either way.
  if v_past and v_payment_status='paid' then
    update public.bookings set booking_status='completed' where id=v_booking_id;
    perform public.admin_lifecycle_event('booking.completed',v_command.id,v_booking_id,'{}'::jsonb);
  end if;
  return query select v_booking_id,v_reference,(case when v_past and v_payment_status='paid' then 'completed' else 'confirmed' end)::text,v_payment_status,v_quote.total_gbp::numeric(10,2);
end; $function$;

-- ---------------------------------------------------------------------------------------------
-- 4. Edit address: as 20261118100000_area_postcodes.sql, with no travel fee in a new area for this client
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_change_booking_address(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz,
  p_address text, p_entry_instructions text, p_service_area_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; p public.booking_payments%rowtype; c public.command_requests%rowtype; a public.service_areas%rowtype;
  v_date date; v_now timestamptz; v_scope text := 'admin-booking-address:' || auth.uid()::text; v_fingerprint text;
  v_address text := public.clean_address(p_address); v_entry text := nullif(btrim(coalesce(p_entry_instructions, '')), '');
  v_travel numeric(10,2); v_congestion numeric(10,2); v_total numeric(10,2);
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_service_area_id is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  if v_address is null then raise exception 'Please write the address.' using errcode='22023'; end if;
  if length(v_address) > 400 then raise exception 'That address is too long.' using errcode='22023'; end if;
  if v_entry is not null and length(v_entry) > 200 then raise exception 'Please keep the entry instructions under 200 characters.' using errcode='22023'; end if;
  v_fingerprint := md5(concat_ws('|','admin_change_booking_address',p_booking_id::text,extract(epoch from p_booking_updated_at)::text,v_address,coalesce(v_entry,''),p_service_area_id::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests cr where cr.scope=v_scope and cr.idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as the other booking commands.
  perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if b.booking_status not in ('awaiting_transfer','awaiting_payment_verification','awaiting_cash_approval','confirmed') then
    raise exception 'Only an appointment still to happen can have its address changed.' using errcode='22023';
  end if;
  select * into a from public.service_areas where id=p_service_area_id;
  -- The area it already has may have been hidden since; a new one must be in use.
  if not found or (not a.active and p_service_area_id is distinct from b.service_area_id) then
    raise exception 'That area is not available.' using errcode='22023';
  end if;
  -- The same area keeps the fees it was booked with (prices apply to new bookings only); another area brings its own.
  if p_service_area_id is not distinct from b.service_area_id then
    v_travel := b.travel_fee_gbp; v_congestion := b.congestion_fee_gbp;
  else
    -- A client with "No travel fee" pays none in the new area either.
    v_travel := case when exists(select 1 from public.clients cl where cl.id=b.client_id and cl.no_travel_fee) then 0 else a.travel_surcharge_gbp end;
    v_congestion := a.congestion_fee_gbp;
  end if;
  v_total := b.service_subtotal_gbp + b.enhancements_total_gbp + v_travel + v_congestion;
  if v_total is distinct from b.total_gbp and p.id is not null and p.status not in ('awaiting_transfer','awaiting_approval','approved') then
    raise exception '%', format('The client has already paid or sent %s, so the price cannot change. Keep the area as %s, or sort out the difference with them first.',
      public.notification_money(b.total_gbp), coalesce(b.service_area_name_snapshot, 'it is')) using errcode='22023';
  end if;
  v_now := clock_timestamp();
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_change_booking_address',v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set address_snapshot=v_address, address_line_1_snapshot=null, address_line_2_snapshot=null, city_snapshot=null,
    postcode_snapshot=public.address_postcode(v_address), entry_instructions_snapshot=v_entry,
    service_area_id=a.id, service_area_name_snapshot=a.name, travel_fee_gbp=v_travel, congestion_fee_gbp=v_congestion, total_gbp=v_total,
    area_check=null
  where id=b.id;
  if p.id is not null and v_total is distinct from b.total_gbp then
    update public.booking_payments set amount_gbp=v_total where id=p.id;
  end if;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.address_changed','booking',b.id,c.id,'admin-booking-address:' || c.id::text,
      jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'previous_address',b.address_snapshot,'previous_area',b.service_area_name_snapshot,
        'previous_total_gbp',b.total_gbp,'total_gbp',v_total));
  return b.id;
end; $$;

notify pgrst, 'reload schema';
