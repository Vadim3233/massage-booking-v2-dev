-- VAD Massage Booking V2
-- One address box: an address is one text, the way it is written or pasted (ADR-059).
--
-- Until now an address was four boxes (street, flat or building, city, postcode). It is now one text, kept in `client_addresses.address` and, as it was
-- on the day, in `bookings.address_snapshot`. Every address that exists is moved into it (the four parts put together with commas), so nothing is lost.
-- Entry instructions and a saved address's label stay as the separate small boxes they were.
--
-- This is the first of two steps and is safe to apply at any time, before or after the screens change: the old four columns stay (they are no longer
-- required), the database keeps filling the one text from them when an old screen writes them, and every command accepts the address either way. The
-- second step, a small clean-up that removes the old columns, comes once the new screens have been live for a day or so.
--
-- To take this back: drop the new columns and the two triggers added here, set the four old columns back to NOT NULL, and run the previous definitions of the
-- functions below again (`normalize_client_address_fields` from 20260923171500_foundation_identity.sql, `admin_create_booking` and `admin_create_series` from
-- 20261027100000 and 20261103100000, `admin_create_client` from 20261101100000, `admin_merge_clients` from 20261022100000, `get_my_booking` from
-- 20261026100000, `plan_event_notifications` from 20261027100000, `plan_series_notifications` from
-- 20261020100000, `finalize_client_booking` from 20261017100000, dropping the new 16-argument one first).

-- ---------------------------------------------------------------------------------------------
-- 1. Tidying an address, and the new columns
-- ---------------------------------------------------------------------------------------------
-- Line breaks become commas, runs of spaces become one, doubled commas become one, and commas and spaces at either end go. Nothing else is changed.
create function public.clean_address(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p_text, ''), '[\r\n]+', ',', 'g'), '\s+', ' ', 'g'), '(\s*,\s*)+', ', ', 'g'), ' ,'), '');
$$;
revoke all on function public.clean_address(text) from public, anon, authenticated;
grant execute on function public.clean_address(text) to authenticated, service_role;

alter table public.client_addresses add column address text, add column normalized_address text;
alter table public.bookings add column address_snapshot text;

-- Every existing address, and the address every existing booking was made for, moved into the one text. The "updated" times are not touched.
alter table public.bookings disable trigger bookings_set_updated_at;
alter table public.client_addresses disable trigger client_addresses_set_updated_at;
update public.client_addresses
  set address = public.clean_address(concat_ws(', ', nullif(btrim(address_line_1), ''), nullif(btrim(address_line_2), ''), nullif(btrim(city), ''), nullif(btrim(postcode), '')));
update public.client_addresses set normalized_address = lower(regexp_replace(address, '[^a-zA-Z0-9]+', '', 'g'));
update public.bookings
  set address_snapshot = public.clean_address(concat_ws(', ', nullif(btrim(address_line_1_snapshot), ''), nullif(btrim(address_line_2_snapshot), ''),
    nullif(btrim(city_snapshot), ''), nullif(btrim(postcode_snapshot), '')));
alter table public.bookings enable trigger bookings_set_updated_at;
alter table public.client_addresses enable trigger client_addresses_set_updated_at;

alter table public.client_addresses
  alter column address set not null,
  alter column normalized_address set not null,
  add constraint client_addresses_address_valid check (length(btrim(address)) between 1 and 400),
  alter column address_line_1 drop not null,
  alter column city drop not null,
  alter column postcode drop not null,
  alter column normalized_postcode drop not null;
alter table public.bookings
  alter column address_snapshot set not null,
  add constraint bookings_address_snapshot_valid check (length(btrim(address_snapshot)) between 1 and 400),
  alter column address_line_1_snapshot drop not null,
  alter column city_snapshot drop not null,
  alter column postcode_snapshot drop not null;
create index client_addresses_client_normalized_address_idx on public.client_addresses (client_id, normalized_address);

-- ---------------------------------------------------------------------------------------------
-- 2. Keeping the one text right, whoever writes it
-- ---------------------------------------------------------------------------------------------
-- An address row: the text is tidied, and its letters-and-numbers form is kept for telling two copies of one address apart. A screen that still writes the old
-- parts (and not the text) gets the text put together from them; a screen that writes only the text leaves the old parts empty, so they cannot say anything stale.
create or replace function public.normalize_client_address_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.label = nullif(btrim(new.label), '');
  new.address_line_1 = nullif(btrim(new.address_line_1), '');
  new.address_line_2 = nullif(btrim(new.address_line_2), '');
  new.city = nullif(btrim(new.city), '');
  new.postcode = nullif(upper(btrim(new.postcode)), '');
  new.normalized_postcode = nullif(regexp_replace(coalesce(new.postcode, ''), '[^A-Z0-9]+', '', 'g'), '');
  if tg_op = 'UPDATE' then
    if new.address is not distinct from old.address
       and (new.address_line_1, new.address_line_2, new.city, new.postcode) is distinct from (old.address_line_1, old.address_line_2, old.city, old.postcode) then
      -- Only the old parts were changed: the text follows them.
      new.address = null;
    elsif new.address is distinct from old.address
       and (new.address_line_1, new.address_line_2, new.city, new.postcode) is not distinct from (old.address_line_1, old.address_line_2, old.city, old.postcode) then
      -- Only the text was changed: the old parts no longer describe it.
      new.address_line_1 = null; new.address_line_2 = null; new.city = null; new.postcode = null; new.normalized_postcode = null;
    end if;
  end if;
  new.address = public.clean_address(coalesce(new.address, concat_ws(', ', new.address_line_1, new.address_line_2, new.city, new.postcode)));
  new.normalized_address = lower(regexp_replace(coalesce(new.address, ''), '[^a-zA-Z0-9]+', '', 'g'));
  new.entry_instructions = nullif(btrim(new.entry_instructions), '');
  return new;
end;
$$;

-- A booking row: the address it was made for as one text, put together from the old parts when only those were written.
create function public.derive_booking_address_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.address_snapshot = public.clean_address(coalesce(new.address_snapshot, concat_ws(', ', nullif(btrim(new.address_line_1_snapshot), ''),
    nullif(btrim(new.address_line_2_snapshot), ''), nullif(btrim(new.city_snapshot), ''), nullif(upper(btrim(new.postcode_snapshot)), ''))));
  return new;
end;
$$;
revoke all on function public.derive_booking_address_snapshot() from public, anon, authenticated;
create trigger bookings_derive_address_snapshot before insert on public.bookings
  for each row execute function public.derive_booking_address_snapshot();

-- ---------------------------------------------------------------------------------------------
-- 3. The commands: the address as one text, or in its old parts
-- ---------------------------------------------------------------------------------------------
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
  select * into v_quote from public.admin_quote_booking(v_area_id,v_sessions,v_enhancement_ids);
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

CREATE OR REPLACE FUNCTION public.admin_create_client(p_details jsonb, p_request_id uuid)
 RETURNS SETOF clients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_scope text := 'admin-client:' || auth.uid()::text;
  v_fingerprint text; v_command public.command_requests%rowtype;
  v_client public.clients%rowtype; v_email text; v_phone text; v_matches uuid[]; v_has_address boolean; v_text text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_request_id is null or p_details is null or jsonb_typeof(p_details)<>'object' then
    raise exception 'Client details and request key are required' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_details) k where k not in
    ('first_name','last_name','email','phone','address','address_line_1','address_line_2','city','postcode','entry_instructions'))
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
  if p_details ? 'address' then
    -- The address as one text, whatever was pasted, tidied. Entry instructions need an address to belong to.
    v_text := public.clean_address(p_details->>'address');
    v_has_address := v_text is not null;
    if v_text is null and nullif(btrim(p_details->>'entry_instructions'),'') is not null then
      raise exception 'Address is required' using errcode='22023';
    end if;
    if length(v_text)>400 then raise exception 'That address is too long' using errcode='22023'; end if;
  else
    v_has_address := nullif(btrim(p_details->>'address_line_1'),'') is not null or nullif(btrim(p_details->>'address_line_2'),'') is not null
      or nullif(btrim(p_details->>'postcode'),'') is not null or nullif(btrim(p_details->>'entry_instructions'),'') is not null;
    if v_has_address and (nullif(btrim(p_details->>'address_line_1'),'') is null or nullif(btrim(p_details->>'city'),'') is null
      or nullif(btrim(p_details->>'postcode'),'') is null) then
      raise exception 'Address, city and postcode are required' using errcode='22023';
    end if;
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
  if v_has_address and v_text is not null then
    insert into public.client_addresses(client_id,address,entry_instructions,is_default)
      values(v_client.id,v_text,p_details->>'entry_instructions',true);
  elsif v_has_address then
    insert into public.client_addresses(client_id,address_line_1,address_line_2,city,postcode,entry_instructions,is_default)
      values(v_client.id,p_details->>'address_line_1',p_details->>'address_line_2',p_details->>'city',p_details->>'postcode',p_details->>'entry_instructions',true);
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_create_client',v_fingerprint,'succeeded',v_client.id::text,clock_timestamp()) returning * into v_command;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('client.created','client',v_client.id,v_command.id,'admin-client:' || v_command.id::text,jsonb_build_object('client_id',v_client.id,'actor_id',auth.uid()));
  return next v_client;
end; $function$;

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

CREATE OR REPLACE FUNCTION public.get_my_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_result jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select jsonb_build_object(
  'id',b.id,'booking_reference',b.booking_reference,'booking_status',b.booking_status,
  'booking_email_snapshot',b.booking_email_snapshot,'date',b.date,'start_minutes',b.start_minutes,
  'treatment_duration_minutes',b.treatment_duration_minutes,'total_gbp',b.total_gbp,
  'service_area_name_snapshot',b.service_area_name_snapshot,
  'address_line_1_snapshot',b.address_line_1_snapshot,'address_line_2_snapshot',b.address_line_2_snapshot,
  'city_snapshot',b.city_snapshot,'postcode_snapshot',b.postcode_snapshot,'address_snapshot',b.address_snapshot,
  'late_fee_status',b.late_fee_status,'late_fee_due_gbp',b.late_fee_due_gbp,'refund_due_gbp',b.refund_due_gbp,
  'cancelled_at',b.cancelled_at,
  'booking_sessions',(select coalesce(jsonb_agg(jsonb_build_object('position',s.position,'duration_minutes',s.duration_minutes,
    'recipient_name',s.recipient_name,'service_name_snapshot',s.service_name_snapshot) order by s.position),'[]'::jsonb)
    from public.booking_sessions s where s.booking_id=b.id),
  'booking_payments',jsonb_build_object('method',p.method,'status',p.status,'payment_reference',p.payment_reference,
    'transfer_declared_at',p.transfer_declared_at)
 ) into v_result from public.bookings b join public.clients c on c.id=b.client_id
 join public.booking_payments p on p.booking_id=b.id
 where b.id=p_booking_id and (c.auth_user_id=auth.uid()
   or (c.id::text=coalesce(auth.jwt()->>'link_client','') and b.id::text=coalesce(auth.jwt()->>'link_booking','')));
 if v_result is null then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 return v_result;
end; $function$;

-- ---------------------------------------------------------------------------------------------
-- 4. What clients are told: the address is the one text
-- ---------------------------------------------------------------------------------------------
-- (The morning reminder, plan_day_of_reminders, reads the same text. It is created by 20261029100000_day_of_reminders.sql, which is not applied online
-- on purpose, so it is not touched here: that file now reads the one text, for whenever the reminder is switched on.)
CREATE OR REPLACE FUNCTION public.plan_event_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
  v_name text;
  v_email text;
  v_when text;
  v_total text;
  v_initiated text := new.payload->>'initiated_by';
  v_source text := new.payload->>'source';
  v_admin_title text;
  v_admin_body text;
  v_client_title text;
  v_client_body text;
  v_fee numeric := coalesce((new.payload->>'late_fee_due_gbp')::numeric, 0);
  v_refund numeric := coalesce((new.payload->>'refund_due_gbp')::numeric, 0);
  v_admin_link text;
  v_client_link text;
  v_where text;
  v_sign text := E'\n\nWarm wishes,\nVad';
begin
  if new.aggregate_type <> 'booking' then return null; end if;
  select * into b from public.bookings where id = new.aggregate_id;
  if not found then return null; end if;
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
  v_name := coalesce(nullif(v_name, ''), 'A client');
  v_email := nullif(btrim(b.booking_email_snapshot), '');
  v_when := public.notification_when(b.date, b.start_minutes);
  v_total := public.notification_money(b.total_gbp);
  v_admin_link := '/admin/bookings/' || b.id::text;
  v_client_link := '/account?booking=' || b.id::text;
  v_where := b.address_snapshot;

  case new.event_type
    when 'booking.created' then
      if new.payload ? 'actor_id' then
        v_client_title := 'Your appointment is booked';
        v_client_body := format('Your appointment is confirmed for %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference);
      else
        v_admin_title := 'New booking request';
        v_admin_body := format('%s: %s, %s minutes, %s. Waiting for payment.', v_name, v_when, b.treatment_duration_minutes, v_total);
      end if;
    when 'booking.transfer_declared' then
      v_admin_title := format('%s says the transfer is made', v_name);
      v_admin_body := format('%s for %s. Check your bank, then verify the payment.', v_total, v_when);
    when 'booking.cash_requested' then
      v_admin_title := format('%s would like to pay cash', v_name);
      v_admin_body := format('%s for %s. Approve the request when you are happy to.', v_total, v_when);
    when 'booking.cancelled' then
      if v_source = 'client' then
        v_admin_title := format('%s cancelled', v_name);
        v_admin_body := format('%s (%s).', v_when, v_total) ||
          case when v_fee > 0 then format(' Late fee of %s recorded as due.', public.notification_money(v_fee)) else ' No late fee.' end ||
          case when v_refund > 0 then format(' Refund of %s to send.', public.notification_money(v_refund)) else '' end;
      end if;
      if v_initiated = 'client' then
        v_client_title := 'Your appointment is cancelled';
        v_client_body := format('I have cancelled your appointment for %s as you asked.', v_when) ||
          case when v_fee > 0 then format(E'\n\nBecause this was inside %s hours, a late fee of %s applies. I will be in touch about it.', public.business_setting_int('free_cancellation_hours', 24), public.notification_money(v_fee)) else '' end ||
          case when v_refund > 0 then format(E'\n\nA refund of %s is on its way to you.', public.notification_money(v_refund)) else '' end;
      else
        v_client_title := 'Your appointment has been cancelled';
        v_client_body := format('I am sorry, I have had to cancel your appointment for %s. Please get in touch if you would like to find another time.', v_when) ||
          case when v_refund > 0 then format(E'\n\nA refund of %s is on its way to you.', public.notification_money(v_refund)) else '' end;
      end if;
    when 'booking.pending_removed', 'booking.cash_rejected' then
      v_client_title := 'Your appointment request has been cancelled';
      v_client_body := format('I have not been able to confirm your appointment request for %s. If you think this is a mistake, or you would like to find another time, please get in touch.', v_when);
    when 'booking.rescheduled' then
      if v_source = 'client' then
        v_admin_title := format('%s moved their appointment', v_name);
        v_admin_body := format('From %s to %s (%s).', public.notification_when((new.payload->>'from_date')::date, (new.payload->>'from_start_minutes')::integer), v_when, v_total) ||
          case when v_fee > 0 then format(' Late fee of %s recorded as due.', public.notification_money(v_fee)) else '' end;
      end if;
      v_client_title := 'Your appointment has moved';
      v_client_body := format('Your appointment is now on %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference) ||
        case when v_initiated = 'client' and v_fee > 0 then format(E'\n\nBecause this change was inside %s hours, a late fee of %s applies. I will be in touch about it.', public.business_setting_int('free_cancellation_hours', 24), public.notification_money(v_fee)) else '' end;
    when 'booking.bank_transfer_verified', 'booking.cash_approved' then
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Thank you. Your appointment is confirmed for %s (%s minutes) at %s.' || E'\nReference: %s', v_when, b.treatment_duration_minutes, v_where, b.booking_reference) ||
        case when new.event_type = 'booking.cash_approved' then E'\n\nPlease pay the full amount in cash at your appointment.' else E'\n\nI have received your payment.' end;
    when 'booking.refund_recorded' then
      v_client_title := 'Your refund has been sent';
      v_client_body := format('I have sent your refund of %s for the appointment on %s.', public.notification_money((new.payload->>'refunded_gbp')::numeric), v_when);
    else
      null;
  end case;

  -- A booking the Admin recorded after it had happened was never announced to the client, so nothing that happens to it while it is still in
  -- the past (cancelling it again, a payment arriving later) is announced to them either. Moved to a time still to come, it is an appointment
  -- the client should hear about, and then it is.
  if v_client_title is not null
     and ((b.date + make_interval(mins => b.start_minutes)) at time zone 'Europe/London') <= clock_timestamp()
     and exists (select 1 from public.event_outbox o
                 where o.aggregate_type = 'booking' and o.aggregate_id = b.id and o.event_type = 'booking.created'
                   and coalesce((o.payload->>'past')::boolean, false)) then
    v_client_title := null;
  end if;
  if v_admin_title is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (new.id, 'in_app', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'telegram', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link),
           (new.id, 'email', 'admin', 'admin', v_admin_title, v_admin_body, v_admin_link);
  end if;
  if v_client_title is not null and v_email is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'email', 'client', v_email, v_client_title, v_client_body || E'\n\nSee or change your booking: {link}' || v_sign, v_client_link);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.plan_series_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_name text;
  v_email text;
  v_when text;
  v_where text;
  v_admin_title text;
  v_admin_body text;
  v_admin_link text;
  v_client_title text;
  v_client_body text;
  v_free integer := public.business_setting_int('free_cancellation_hours', 24);
  v_date date;
  v_client uuid;
begin
  if new.event_type = 'booking.series_due' and new.aggregate_type = 'booking' then
    select * into b from public.bookings where id = new.aggregate_id;
    if not found then return null; end if;
    select * into p from public.booking_payments where booking_id = b.id;
    select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = b.client_id;
    v_name := coalesce(nullif(v_name, ''), 'A client');
    v_email := nullif(btrim(b.booking_email_snapshot), '');
    v_when := public.notification_when(b.date, b.start_minutes);
    v_where := b.address_snapshot;
    v_admin_link := '/admin/bookings/' || b.id::text;
    v_admin_title := format('Next repeat booking for %s', v_name);
    v_admin_body := format('%s, %s minutes, %s.', v_when, b.treatment_duration_minutes, public.notification_money(b.total_gbp)) ||
      case when p.method = 'bank_transfer' then ' Waiting for the bank transfer.' else ' To be paid in cash at the appointment.' end;
    v_client_title := case when p.method = 'bank_transfer' then 'Time to pay for your next appointment' else 'Your next regular appointment' end;
    v_client_body := format('Your next regular appointment is booked for %s (%s minutes) at %s.', v_when, b.treatment_duration_minutes, v_where) ||
      case when p.method = 'bank_transfer'
        then format(E'\n\nThe cost is %s. Please pay by bank transfer before the day; the bank details are on your booking page.', public.notification_money(b.total_gbp))
        else format(E'\n\nThe cost is %s, to be paid in cash at the appointment.', public.notification_money(b.total_gbp)) end ||
      format(E'\n\nIf that day does not suit, you can cancel or move it from the same page. It is free more than %s hours before the appointment.', v_free) ||
      E'\nReference: ' || b.booking_reference;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (new.id, 'in_app', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'telegram', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link),
           (new.id, 'email', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link);
    if v_email is not null then
      insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
      values (new.id, 'email', 'client', v_email, v_client_title,
              v_client_body || E'\n\nSee or change your booking: {link}' || E'\n\nWarm wishes,\nVad', '/account?booking=' || b.id::text);
    end if;
  elsif new.event_type = 'series.clash' and new.aggregate_type = 'series' then
    v_date := (new.payload->>'date')::date;
    v_client := (new.payload->>'client_id')::uuid;
    select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) into v_name from public.clients c where c.id = v_client;
    v_admin_title := 'A repeat booking could not be made';
    v_admin_body := format('%s: %s could not be booked because the time is no longer free. That date has been skipped. Open the client to decide what to do.',
      coalesce(nullif(v_name, ''), 'A client'), to_char(v_date, 'FMDy FMDD FMMon'));
    v_admin_link := '/admin/clients/' || v_client::text;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (new.id, 'in_app', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link, 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (new.id, 'telegram', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link),
           (new.id, 'email', 'admin', 'admin-series', v_admin_title, v_admin_body, v_admin_link);
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Finalizing a client's booking: one more argument, the address as one text (the old four still work, and nothing is asked twice)
-- ---------------------------------------------------------------------------------------------
drop function public.finalize_client_booking(uuid, uuid, text, uuid, jsonb, uuid[], uuid, text, text, text, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.finalize_client_booking(p_hold_id uuid, p_hold_token uuid, p_hold_client_key text, p_service_area_id uuid, p_sessions jsonb, p_enhancement_ids uuid[], p_saved_address_id uuid, p_address_line_1 text, p_address_line_2 text, p_city text, p_postcode text, p_entry_instructions text, p_client_note text, p_payment_method text, p_idempotency_key text, p_address text DEFAULT NULL::text)
 RETURNS TABLE(booking_id uuid, booking_reference text, booking_status text, payment_status text, total_gbp numeric, payment_reference text, saved_address_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := now();
  v_london_today date := (now() at time zone 'Europe/London')::date;
  v_london_now_minutes integer := (
    extract(hour from now() at time zone 'Europe/London')::integer * 60
    + extract(minute from now() at time zone 'Europe/London')::integer
  );
  v_user_id uuid := auth.uid();
  v_client public.clients%rowtype;
  v_hold public.booking_holds%rowtype;
  v_address public.client_addresses%rowtype;
  v_quote record;
  v_command public.command_requests%rowtype;
  v_command_id uuid;
  v_scope text;
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text;
  v_enhancement_ids uuid[] := coalesce(p_enhancement_ids, '{}'::uuid[]);
  v_sorted_enhancement_ids text;
  v_booking_id uuid;
  v_booking_reference text;
  v_booking_status text;
  v_payment_status text;
  v_payment_reference text;
  v_is_returning boolean := false;
  v_active_future_count integer := 0;
  v_is_default_address boolean := false;
  v_address_text text;
  v_session jsonb;
  v_session_id uuid;
  v_service_id uuid;
  v_duration integer;
  v_recipient_name text;
  v_position integer := 0;
  v_unit_price numeric(10,2);
  v_service_name text;
  v_preference_ids uuid[];
  v_preference_count integer;
  v_enhancement_id uuid;
  v_enhancement public.enhancements%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if public.is_booking_admin() then
    raise exception 'Admin accounts must use the Admin booking contract'
      using errcode = '42501';
  end if;

  select c.*
  into v_client
  from public.clients c
  where c.auth_user_id = v_user_id
  for update;

  if not found then
    raise exception 'Client account is not activated'
      using errcode = '42501';
  end if;

  if not v_client.online_booking_enabled then
    raise exception 'Online booking is disabled for this client'
      using errcode = '42501';
  end if;

  if length(v_idempotency_key) < 8 or length(v_idempotency_key) > 200 then
    raise exception 'A valid idempotency key is required'
      using errcode = '22023';
  end if;

  if p_payment_method not in ('bank_transfer', 'cash') then
    raise exception 'Payment method must be bank_transfer or cash'
      using errcode = '22023';
  end if;

  if p_hold_id is null
     or p_hold_token is null
     or btrim(coalesce(p_hold_client_key, '')) = '' then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  select string_agg(e_id::text, ',' order by e_id::text)
  into v_sorted_enhancement_ids
  from unnest(v_enhancement_ids) e_id;

  v_scope := 'client-finalize:' || v_client.id::text;
  v_fingerprint := md5(concat_ws(
    '|',
    p_hold_id::text,
    p_hold_token::text,
    btrim(p_hold_client_key),
    p_service_area_id::text,
    p_sessions::text,
    coalesce(v_sorted_enhancement_ids, ''),
    coalesce(p_saved_address_id::text, ''),
    coalesce(btrim(p_address_line_1), ''),
    coalesce(btrim(p_address_line_2), ''),
    coalesce(btrim(p_city), ''),
    coalesce(upper(btrim(p_postcode)), ''),
    coalesce(btrim(p_entry_instructions), ''),
    coalesce(btrim(p_client_note), ''),
    p_payment_method,
    btrim(p_address)
  ));

  perform pg_advisory_xact_lock(
    hashtext(v_scope || ':' || v_idempotency_key)
  );

  select cr.*
  into v_command
  from public.command_requests cr
  where cr.scope = v_scope
    and cr.idempotency_key = v_idempotency_key
  for update;

  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Idempotency key was already used for a different request'
        using errcode = '22023';
    end if;

    if v_command.status = 'succeeded' and v_command.result_reference is not null then
      return query
      select
        b.id,
        b.booking_reference,
        b.booking_status,
        bp.status,
        b.total_gbp,
        bp.payment_reference,
        b.saved_address_id
      from public.bookings b
      join public.booking_payments bp on bp.booking_id = b.id
      where b.id = v_command.result_reference::uuid;
      return;
    end if;

    raise exception 'Booking request is already in progress'
      using errcode = '40001';
  end if;

  select *
  into v_quote
  from public.compute_client_booking_quote(
    p_service_area_id,
    p_sessions,
    v_enhancement_ids
  );

  -- Match hold creation lock order: browser key first, then business date.
  perform pg_advisory_xact_lock(
    hashtext('booking-hold-client:' || btrim(p_hold_client_key))
  );

  select h.*
  into v_hold
  from public.booking_holds h
  where h.id = p_hold_id;

  if not found then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  perform pg_advisory_xact_lock(42420, hashtext(v_hold.date::text));

  select h.*
  into v_hold
  from public.booking_holds h
  where h.id = p_hold_id
  for update;

  if not found
     or v_hold.hold_token <> p_hold_token
     or v_hold.client_key is distinct from btrim(p_hold_client_key)
     or v_hold.status <> 'active'
     or v_hold.expires_at <= v_now
     or v_hold.treatment_duration_minutes <> v_quote.treatment_duration_minutes
     or v_hold.travel_buffer_minutes <> 60 then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  if v_hold.date < v_london_today then
    raise exception 'Booking date cannot be in the past'
      using errcode = '22023';
  end if;

  if v_hold.date > v_london_today + public.business_setting_int('booking_horizon_days', 40) then
    raise exception '%', format('Online appointments can currently be arranged up to %s days ahead. Please choose an earlier date.', public.business_setting_int('booking_horizon_days', 40))
      using errcode = '22023';
  end if;

  if ((v_hold.date + make_interval(mins => v_hold.start_minutes)) at time zone 'Europe/London') < clock_timestamp() + make_interval(mins => public.business_setting_int('minimum_notice_minutes', 120)) then
    raise exception '%', format('Online appointments need at least %s notice. Please choose a later time.', public.notice_text(public.business_setting_int('minimum_notice_minutes', 120)))
      using errcode = '23P01';
  end if;

  -- Serialize client booking-limit decisions.
  perform pg_advisory_xact_lock(
    hashtext('client-booking-limit:' || v_client.id::text)
  );

  select exists (
    select 1
    from public.bookings b
    join public.booking_payments bp on bp.booking_id = b.id
    where b.client_id = v_client.id
      and b.booking_status = 'completed'
      and bp.status = 'paid'
  )
  into v_is_returning;

  select count(*)::integer
  into v_active_future_count
  from public.bookings b
  join public.booking_payments bp on bp.booking_id = b.id
  where b.client_id = v_client.id
    and b.booking_status in (
      'awaiting_transfer',
      'awaiting_payment_verification',
      'awaiting_cash_approval',
      'confirmed'
    )
    and bp.status not in ('rejected', 'refunded')
    and (
      b.date > v_london_today
      or (
        b.date = v_london_today
        and b.start_minutes > v_london_now_minutes
      )
    );

  if not v_is_returning and v_active_future_count >= public.business_setting_int('new_client_booking_limit', 1) then
    raise exception 'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.'
      using errcode = '22023';
  end if;

  if v_is_returning and v_active_future_count >= public.business_setting_int('returning_client_booking_limit', 5) then
    raise exception '%', format('You already have %s upcoming appointments. Please manage one of those appointments before adding another.', public.count_word(public.business_setting_int('returning_client_booking_limit', 5)))
      using errcode = '22023';
  end if;

  -- Exclude the caller's own hold from the shared availability calculation.
  -- Any later error rolls this update back with the rest of the transaction.
  update public.booking_holds h
  set
    status = 'consumed',
    client_id = v_client.id
  where h.id = v_hold.id;

  if not exists (
    select 1
    from public.compute_booking_availability(
      v_hold.date,
      v_hold.treatment_duration_minutes,
      v_now,
      v_hold.travel_buffer_minutes
    ) a
    where a.start_minutes = v_hold.start_minutes
  ) then
    raise exception 'Time slot is no longer available'
      using errcode = '23P01';
  end if;

  if p_saved_address_id is not null then
    select a.*
    into v_address
    from public.client_addresses a
    where a.id = p_saved_address_id
      and a.client_id = v_client.id
    for update;

    if not found then
      raise exception 'Saved address is not available to this client'
        using errcode = '42501';
    end if;
  else
    -- The address as one text (the new screens), or put together from its parts (the old ones).
    v_address_text := public.clean_address(coalesce(p_address, concat_ws(', ', nullif(btrim(p_address_line_1), ''), nullif(btrim(p_address_line_2), ''),
      nullif(btrim(p_city), ''), upper(nullif(btrim(p_postcode), '')))));
    if p_address is not null then
      if v_address_text is null then
        raise exception 'A complete booking address is required'
          using errcode = '22023';
      end if;
    elsif nullif(btrim(p_address_line_1), '') is null
       or nullif(btrim(p_city), '') is null
       or nullif(btrim(p_postcode), '') is null then
      raise exception 'A complete booking address is required'
        using errcode = '22023';
    end if;
    if length(v_address_text) > 400 then
      raise exception 'That address is too long'
        using errcode = '22023';
    end if;

    select a.*
    into v_address
    from public.client_addresses a
    where a.client_id = v_client.id
      and a.normalized_address = lower(regexp_replace(v_address_text, '[^a-zA-Z0-9]+', '', 'g'))
    order by a.is_default desc, a.created_at
    limit 1;

    if not found then
      select not exists (
        select 1
        from public.client_addresses existing
        where existing.client_id = v_client.id
      )
      into v_is_default_address;

      insert into public.client_addresses (
        client_id,
        label,
        address,
        address_line_1,
        address_line_2,
        city,
        postcode,
        normalized_postcode,
        entry_instructions,
        is_default
      )
      values (
        v_client.id,
        case when v_is_default_address then 'Home' else 'Saved address' end,
        v_address_text,
        case when p_address is null then btrim(p_address_line_1) end,
        case when p_address is null then nullif(btrim(p_address_line_2), '') end,
        case when p_address is null then btrim(p_city) end,
        case when p_address is null then upper(btrim(p_postcode)) end,
        case when p_address is null then regexp_replace(upper(btrim(p_postcode)), '[^A-Z0-9]+', '', 'g') end,
        nullif(btrim(p_entry_instructions), ''),
        v_is_default_address
      )
      returning * into v_address;
    end if;
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
    v_idempotency_key,
    'web',
    'client',
    v_user_id::text,
    'finalize_client_booking',
    v_fingerprint,
    'started'
  )
  returning id into v_command_id;

  v_booking_id := gen_random_uuid();
  v_booking_reference :=
    'VDM-'
    || to_char(v_now at time zone 'UTC', 'YYYYMMDDHH24MISS')
    || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  if p_payment_method = 'bank_transfer' then
    v_booking_status := 'awaiting_transfer';
    v_payment_status := 'awaiting_transfer';
  else
    v_booking_status := 'awaiting_cash_approval';
    v_payment_status := 'awaiting_approval';
  end if;

  v_payment_reference := v_booking_reference;

  insert into public.bookings (
    id,
    booking_reference,
    client_id,
    saved_address_id,
    service_area_id,
    date,
    start_minutes,
    treatment_duration_minutes,
    travel_buffer_minutes,
    booking_status,
    source_channel,
    created_by_actor_type,
    created_by_actor_id,
    address_line_1_snapshot,
    address_line_2_snapshot,
    city_snapshot,
    postcode_snapshot,
    address_snapshot,
    entry_instructions_snapshot,
    service_area_name_snapshot,
    service_subtotal_gbp,
    enhancements_total_gbp,
    travel_fee_gbp,
    congestion_fee_gbp,
    total_gbp,
    booking_email_snapshot,
    payment_reservation_expires_at,
    client_note
  )
  values (
    v_booking_id,
    v_booking_reference,
    v_client.id,
    v_address.id,
    p_service_area_id,
    v_hold.date,
    v_hold.start_minutes,
    v_quote.treatment_duration_minutes,
    v_hold.travel_buffer_minutes,
    v_booking_status,
    'web',
    'client',
    v_user_id::text,
    v_address.address_line_1,
    v_address.address_line_2,
    v_address.city,
    v_address.postcode,
    v_address.address,
    v_address.entry_instructions,
    v_quote.service_area_name,
    v_quote.service_subtotal_gbp,
    v_quote.enhancements_total_gbp,
    v_quote.travel_fee_gbp,
    v_quote.congestion_fee_gbp,
    v_quote.total_gbp,
    v_client.email,
    null,
    nullif(btrim(p_client_note), '')
  );

  for v_session in
    select value
    from jsonb_array_elements(p_sessions)
  loop
    v_position := v_position + 1;
    v_service_id := (v_session ->> 'service_id')::uuid;
    v_duration := (v_session ->> 'duration_minutes')::integer;
    v_recipient_name := nullif(btrim(v_session ->> 'recipient_name'), '');

    if v_recipient_name is not null and length(v_recipient_name) > 120 then
      raise exception 'Session recipient name is too long'
        using errcode = '22023';
    end if;

    select s.name, p.price_gbp
    into v_service_name, v_unit_price
    from public.services s
    join public.service_duration_prices p
      on p.service_id = s.id
    where s.id = v_service_id
      and s.active
      and p.duration_minutes = v_duration
      and p.active;

    insert into public.booking_sessions (
      booking_id,
      position,
      service_id,
      duration_minutes,
      service_name_snapshot,
      unit_price_gbp,
      recipient_name
    )
    values (
      v_booking_id,
      v_position,
      v_service_id,
      v_duration,
      v_service_name,
      v_unit_price,
      v_recipient_name
    )
    returning id into v_session_id;

    if v_session ? 'preference_ids' then
      if jsonb_typeof(v_session -> 'preference_ids') <> 'array' then
        raise exception 'Session preferences must be an array'
          using errcode = '22023';
      end if;

      select coalesce(array_agg(pref_id), '{}'::uuid[])
      into v_preference_ids
      from (
        select value::uuid as pref_id
        from jsonb_array_elements_text(v_session -> 'preference_ids')
      ) pref;

      select count(distinct pref_id)::integer
      into v_preference_count
      from unnest(v_preference_ids) pref_id;

      if v_preference_count <> cardinality(v_preference_ids) then
        raise exception 'Session preference selection contains duplicates'
          using errcode = '22023';
      end if;

      if (
        select count(*)::integer
        from public.session_preferences sp
        where sp.id = any(v_preference_ids)
          and sp.active
      ) <> cardinality(v_preference_ids) then
        raise exception 'Selected session preference is no longer available'
          using errcode = '22023';
      end if;

      if exists (
        select 1
        from public.session_preference_conflicts c
        where c.preference_id = any(v_preference_ids)
          and c.conflicting_preference_id = any(v_preference_ids)
      ) then
        raise exception 'Selected session preferences conflict'
          using errcode = '22023';
      end if;

      insert into public.booking_session_preferences (
        booking_session_id,
        preference_id,
        preference_label_snapshot,
        preference_category_snapshot
      )
      select
        v_session_id,
        sp.id,
        sp.label,
        sp.category
      from public.session_preferences sp
      where sp.id = any(v_preference_ids);
    end if;
  end loop;

  foreach v_enhancement_id in array v_enhancement_ids
  loop
    select e.*
    into v_enhancement
    from public.enhancements e
    where e.id = v_enhancement_id
      and e.active;

    insert into public.booking_enhancements (
      booking_id,
      enhancement_id,
      enhancement_name_snapshot,
      quantity,
      unit_price_gbp,
      duration_minutes_snapshot
    )
    values (
      v_booking_id,
      v_enhancement.id,
      v_enhancement.name,
      1,
      v_enhancement.price_gbp,
      0
    );
  end loop;

  insert into public.booking_payments (
    booking_id,
    method,
    status,
    amount_gbp,
    payment_reference
  )
  values (
    v_booking_id,
    p_payment_method,
    v_payment_status,
    v_quote.total_gbp,
    v_payment_reference
  );

  insert into public.event_outbox (
    event_type,
    aggregate_type,
    aggregate_id,
    source_command_id,
    deduplication_key,
    payload
  )
  values (
    'booking.created',
    'booking',
    v_booking_id,
    v_command_id,
    'booking.created:' || v_booking_id::text,
    jsonb_build_object(
      'booking_id', v_booking_id,
      'booking_reference', v_booking_reference,
      'client_id', v_client.id,
      'booking_status', v_booking_status,
      'payment_status', v_payment_status,
      'date', v_hold.date,
      'start_minutes', v_hold.start_minutes,
      'total_gbp', v_quote.total_gbp
    )
  );

  update public.command_requests cr
  set
    status = 'succeeded',
    result_reference = v_booking_id::text,
    completed_at = v_now
  where cr.id = v_command_id;

  return query
  select
    v_booking_id,
    v_booking_reference,
    v_booking_status,
    v_payment_status,
    v_quote.total_gbp::numeric(10,2),
    v_payment_reference,
    v_address.id;
end;
$function$;
revoke all on function public.finalize_client_booking(uuid, uuid, text, uuid, jsonb, uuid[], uuid, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.finalize_client_booking(uuid, uuid, text, uuid, jsonb, uuid[], uuid, text, text, text, text, text, text, text, text, text) to authenticated, service_role;
