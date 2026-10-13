-- VAD Massage Booking V2
-- The Admin can record an appointment that has already happened.
--
-- She asked to be able to create bookings in the past (an appointment from last week that was never put in the app). It is a deliberate
-- act: the request must say "past", and a time that has begun is refused without it, so a form left open cannot do it by accident.
--  * Paid (bank transfer or cash already received): the appointment is recorded as completed straight away, so it counts as a visit and
--    in what the client has paid, and can have a receipt. Not paid yet: it stays confirmed, for her to finish like any other.
--  * The client is not emailed and nothing is alerted: the appointment was not new to them. That holds for what happens to it afterwards
--    while it is still in the past too (cancelling it again, a payment arriving later); moved to a time still to come it is announced like any.
--  * Working hours, the usual gap and blocked time do not apply to something that has already happened; a double booking is still refused.
--  * Up to a year back. Not for a repeating booking.
-- Nothing changes for a booking made as before.

-- ---------------------------------------------------------------------------------------------
-- 1. The times of one past day
-- ---------------------------------------------------------------------------------------------
create function public.admin_past_booking_times(p_date date, p_treatment_duration_minutes integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date;
  v_open boolean;
  v_from integer;
  v_to integer;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  v_today := (v_now at time zone 'Europe/London')::date;
  if p_date is null or p_date < v_today - 365 or p_date > v_today then
    raise exception 'Choose a date within the last 365 days' using errcode = '22023';
  end if;
  if p_treatment_duration_minutes is null or p_treatment_duration_minutes not between 60 and 240 or mod(p_treatment_duration_minutes, 30) <> 0 then
    raise exception 'Booking duration is invalid' using errcode = '22023';
  end if;
  select o.available, o.start_minutes, o.end_minutes into v_open, v_from, v_to from public.working_hours_overrides o where o.date = p_date;
  if not found then
    select w.available, w.start_minutes, w.end_minutes into v_open, v_from, v_to from public.working_hours w where w.weekday = extract(isodow from p_date)::smallint;
  end if;
  return jsonb_build_object(
    'working', jsonb_build_object('open', coalesce(v_open, false), 'start', v_from, 'end', v_to),
    'buffer_minutes', 60,
    'client_booking', exists (select 1 from public.booking_holds h where h.date = p_date and h.status = 'active' and h.expires_at > v_now),
    'booked', coalesce((
      select jsonb_agg(jsonb_build_object('start', x.start_minutes, 'end', x.end_minutes, 'label', x.label, 'kind', x.kind) order by x.start_minutes, x.end_minutes)
      from (
        select b.start_minutes, b.start_minutes + b.treatment_duration_minutes as end_minutes,
               nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') as label, 'booking'::text as kind
          from public.bookings b join public.clients c on c.id = b.client_id
         where b.date = p_date and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed')
        union all
        select h.start_minutes, h.start_minutes + h.treatment_duration_minutes, null::text, 'hold'::text
          from public.booking_holds h where h.date = p_date and h.status = 'active' and h.expires_at > v_now
      ) x), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object('start', cb.start_minutes, 'end', cb.end_minutes, 'title', coalesce(nullif(btrim(cb.title), ''), 'Blocked time'), 'series', cb.series_id is not null) order by cb.start_minutes, cb.end_minutes)
      from public.calendar_blocks cb where cb.date = p_date), '[]'::jsonb),
    'slots', coalesce((
      select jsonb_agg(jsonb_build_object('start', s.start_minutes, 'usual', false,
               'clash', public.admin_time_clash(p_date, s.start_minutes, p_treatment_duration_minutes, v_now)) order by s.start_minutes)
      from (select g as start_minutes from generate_series(360, 1440 - p_treatment_duration_minutes, 30) g) s
      where (p_date + make_interval(mins => s.start_minutes)) at time zone 'Europe/London' <= v_now), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_past_booking_times(date, integer) from public, anon;
grant execute on function public.admin_past_booking_times(date, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The Admin's booking command: the same, with an optional "past" (yes or no) in the request
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_create_booking(p_request jsonb,p_request_id uuid)
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
  v_any boolean := false; v_today date; v_past boolean := false; v_started boolean;
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
        'payment_status',v_payment_status,'date',v_date,'start_minutes',v_start,'total_gbp',v_quote.total_gbp,'actor_id',auth.uid())
        || case when v_past then jsonb_build_object('past',true) else '{}'::jsonb end);
  -- Recorded as paid, it is a visit that happened and was paid for: completed straight away, through the one step the status guard allows
  -- (confirmed to completed), so the history shows both. Unpaid, it stays confirmed for the Admin to finish. No email goes either way.
  if v_past and v_payment_status='paid' then
    update public.bookings set booking_status='completed' where id=v_booking_id;
    perform public.admin_lifecycle_event('booking.completed',v_command.id,v_booking_id,'{}'::jsonb);
  end if;
  return query select v_booking_id,v_reference,(case when v_past and v_payment_status='paid' then 'completed' else 'confirmed' end)::text,v_payment_status,v_quote.total_gbp::numeric(10,2);
end; $$;

-- ---------------------------------------------------------------------------------------------
-- 3. A repeating booking never starts in the past
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_create_series(p_request jsonb, p_end_date date, p_request_id uuid)
returns table(series_id uuid, booking_id uuid, booking_reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first record;
  v_booking public.bookings%rowtype;
  v_series uuid;
  v_template jsonb;
  v_arrangement text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'Booking details are required' using errcode = '22023';
  end if;
  -- The weekly bookings that follow are made at the usual times only, so a repeat cannot start from an unusual one.
  if p_request ? 'any_time' then
    raise exception 'A repeat uses the usual times only' using errcode = '22023';
  end if;
  if p_request ? 'past' then
    raise exception 'A repeat cannot start with an appointment that has already happened' using errcode = '22023';
  end if;
  select c.* into v_first from public.admin_create_booking(p_request, p_request_id) c;
  select * into v_booking from public.bookings b where b.id = v_first.booking_id;
  if v_booking.series_id is not null then
    -- The same request was sent again: answer with the repeat it already made.
    return query select v_booking.series_id, v_booking.id, v_booking.booking_reference;
    return;
  end if;
  if p_end_date is not null and p_end_date < v_booking.date then
    raise exception 'The repeat cannot end before it starts' using errcode = '22023';
  end if;
  if p_end_date is not null and p_end_date > v_booking.date + 1100 then
    raise exception 'A repeat can run for up to three years' using errcode = '22023';
  end if;
  v_arrangement := case when p_request->>'payment_arrangement' in ('bank_pending', 'bank_received') then 'bank_pending' else 'cash_appointment' end;
  v_template := (p_request - 'date' - 'start_minutes') || jsonb_build_object('payment_arrangement', v_arrangement);
  insert into public.booking_series (client_id, weekday, first_date, end_date, start_minutes, treatment_duration_minutes, request, created_by)
  values (v_booking.client_id, extract(isodow from v_booking.date)::integer, v_booking.date, p_end_date, v_booking.start_minutes,
          v_booking.treatment_duration_minutes, v_template, auth.uid())
  returning id into v_series;
  update public.bookings set series_id = v_series where id = v_booking.id;
  perform public.refresh_series_holds(v_series);
  return query select v_series, v_booking.id, v_booking.booking_reference;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. No email to the client about an appointment recorded after the fact
-- ---------------------------------------------------------------------------------------------
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
  v_where := concat_ws(', ', b.address_line_1_snapshot, b.city_snapshot, b.postcode_snapshot);

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
