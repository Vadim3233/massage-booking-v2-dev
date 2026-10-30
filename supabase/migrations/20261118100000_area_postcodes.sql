-- Postcodes for areas, the out-of-area check, and Edit address (Vadim, 30 Oct 2026).
--
-- Until now a client picked an area (Chelsea, Mayfair...) and typed their address, and nothing checked that the two agreed. From this migration:
--   * Each area can list the postcodes it covers (`service_areas.postcodes`), edited in More > Areas: whole districts such as "SW3" or "W1"
--     (W1 covers W1K, W1J and the rest), or a narrower sector such as "W2 1". The most specific match wins, and no two areas may list the same one.
--   * When a client books, the postcode in their address is checked against those lists. In another area than the one they chose, the booking is
--     refused with a sentence telling them which area to choose (the booking screen says so before they get that far). In none of the areas, or with
--     no postcode at all, the booking is still made but marked (`bookings.area_check` = 'outside' or 'no_postcode'): the client is told not to pay
--     yet, the Admin's "New booking request" says why, and the Admin confirms it (Confirm, pay later, or approve the cash) or removes it as usual.
--     Until at least one area has postcodes, nothing is checked and booking works exactly as before.
--   * admin_change_booking_address: the Admin changes the address of a booking that is still to happen. A different area brings that area's travel and
--     congestion fees and a new total (refused once the client has paid or said the transfer is made, so money already sent never disagrees with the price).
--     The client is told by email and Telegram. The calendar copy follows by itself (its trigger already watches the address).
-- Bookings the Admin makes, and bookings already made, are not checked.
--
-- To take this back: drop the trigger bookings_postcode_area and the functions check_booking_area, admin_change_booking_address, postcode_area,
-- address_postcode and normalize_area_postcodes (with its trigger), drop the columns bookings.area_check and service_areas.postcodes, and run
-- get_my_booking from 20261104100000_single_address.sql and plan_event_notifications from 20261116100000_confirm_pay_later.sql again.

-- ---------------------------------------------------------------------------------------------
-- 1. Reading a postcode, and which area it is in
-- ---------------------------------------------------------------------------------------------
-- The postcode inside an address, written as postcodes are ("sw31aa" becomes "SW3 1AA"), or null. The same rule as postcodeOf in src/lib/address.js.
create function public.address_postcode(p_text text)
returns text language sql immutable set search_path = '' as $$
  select upper(m[2] || ' ' || m[3])
  from (select regexp_match(coalesce(p_text, ''), '(^|[^A-Za-z0-9])([A-Za-z]{1,2}[0-9][A-Za-z0-9]?) *([0-9][A-Za-z]{2})([^A-Za-z0-9]|$)') as m) x
  where m is not null;
$$;
revoke all on function public.address_postcode(text) from public, anon;
grant execute on function public.address_postcode(text) to authenticated, service_role;

alter table public.service_areas add column postcodes text[] not null default '{}';
alter table public.bookings add column area_check text,
  add constraint bookings_area_check_valid check (area_check in ('outside', 'no_postcode'));

-- An area's list is tidied (capitals, single spaces, no repeats, in order), each entry must be a district ("SW3", "W1", "SW1A") or a sector
-- ("W2 1"), and an entry may belong to one area only, so a postcode is never in two.
create function public.normalize_area_postcodes()
returns trigger language plpgsql set search_path = '' as $$
declare v_code text; v_other text;
begin
  select coalesce(array_agg(distinct code order by code), '{}') into new.postcodes
  from (select upper(btrim(regexp_replace(value, '\s+', ' ', 'g'))) as code from unnest(coalesce(new.postcodes, '{}')) value) t
  where code <> '';
  foreach v_code in array new.postcodes loop
    if v_code !~ '^[A-Z]{1,2}[0-9][A-Z0-9]?( [0-9])?$' then
      raise exception '%', format('"%s" is not the start of a postcode. Write a district such as SW3 or W1, or a sector such as W2 1.', v_code) using errcode = '22023';
    end if;
    select a.name into v_other from public.service_areas a where a.id <> new.id and v_code = any(a.postcodes) limit 1;
    if v_other is not null then
      raise exception '%', format('%s is already in %s. A postcode can be in one area only.', v_code, v_other) using errcode = '22023';
    end if;
  end loop;
  return new;
end; $$;
revoke all on function public.normalize_area_postcodes() from public, anon, authenticated;
create trigger service_areas_normalize_postcodes before insert or update of postcodes on public.service_areas
  for each row execute function public.normalize_area_postcodes();

-- The active area a full postcode is in, or null. "W2 1AB" is looked for as the sector "W2 1", then the district "W2"; "W1K 2AB" as "W1K 2",
-- "W1K", then "W1". The same rule as areaForPostcode in src/lib/address.js.
create function public.postcode_area(p_postcode text)
returns uuid language sql stable set search_path = '' as $$
  with p as (select split_part(public.address_postcode(p_postcode), ' ', 1) as outward, split_part(public.address_postcode(p_postcode), ' ', 2) as inward),
  wanted as (
    select outward || ' ' || left(inward, 1) as code, 1 as rank from p where outward <> ''
    union all select outward, 2 from p where outward <> ''
    union all select left(outward, -1), 3 from p where outward ~ '[0-9][A-Z]$'
  )
  select a.id from wanted w join public.service_areas a on a.active and w.code = any(a.postcodes) order by w.rank, a.display_order limit 1;
$$;
revoke all on function public.postcode_area(text) from public, anon;
grant execute on function public.postcode_area(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. The check on a client's booking
-- ---------------------------------------------------------------------------------------------
-- Runs after bookings_derive_address_snapshot (triggers of one kind run in name order), so the address is already the one text.
create function public.check_booking_area()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_postcode text; v_area uuid; v_area_name text; v_chosen text;
begin
  if new.created_by_actor_type is distinct from 'client' then return new; end if;
  if not exists (select 1 from public.service_areas a where a.active and cardinality(a.postcodes) > 0) then return new; end if;
  v_postcode := public.address_postcode(coalesce(new.address_snapshot, new.postcode_snapshot));
  if v_postcode is null then
    new.area_check := 'no_postcode';
    return new;
  end if;
  v_area := public.postcode_area(v_postcode);
  if v_area is null then
    new.area_check := 'outside';
  elsif v_area is distinct from new.service_area_id then
    select name into v_area_name from public.service_areas where id = v_area;
    select name into v_chosen from public.service_areas where id = new.service_area_id;
    raise exception '%', format('%s is in %s, not %s. Please go back to the first step and choose %s.', v_postcode, v_area_name, coalesce(v_chosen, 'the area you chose'), v_area_name)
      using errcode = '22023';
  else
    new.area_check := null;
  end if;
  return new;
end; $$;
revoke all on function public.check_booking_area() from public, anon, authenticated;
create trigger bookings_postcode_area before insert on public.bookings
  for each row execute function public.check_booking_area();

-- ---------------------------------------------------------------------------------------------
-- 3. Edit address
-- ---------------------------------------------------------------------------------------------
create function public.admin_change_booking_address(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz,
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
    v_travel := a.travel_surcharge_gbp; v_congestion := a.congestion_fee_gbp;
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
revoke all on function public.admin_change_booking_address(uuid,uuid,timestamptz,text,text,uuid) from public,anon;
grant execute on function public.admin_change_booking_address(uuid,uuid,timestamptz,text,text,uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. What the Admin and the client are told
-- ---------------------------------------------------------------------------------------------
-- As 20261116100000_confirm_pay_later.sql, with the reason in the Admin's "New booking request" when the address needs a look, and a new case,
-- booking.address_changed, for the client.
CREATE OR REPLACE FUNCTION public.plan_event_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  v_bank jsonb;
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
        v_client_body := format('Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference);
      else
        v_admin_title := 'New booking request';
        v_admin_body := format('%s: %s, %s minutes, %s. Waiting for payment.', v_name, v_when, b.treatment_duration_minutes, v_total);
        -- A postcode outside every area, or no postcode at all: the client was told not to pay until the Admin has looked.
        if b.area_check = 'outside' then
          v_admin_title := 'New booking request, outside your areas';
          v_admin_body := format('%s: %s, %s minutes, %s. %s is outside your areas. The client will not pay until you confirm it.', v_name, v_when, b.treatment_duration_minutes, v_total, coalesce(public.address_postcode(b.address_snapshot), 'The postcode'));
        elsif b.area_check = 'no_postcode' then
          v_admin_title := 'New booking request, no postcode';
          v_admin_body := format('%s: %s, %s minutes, %s. The address has no postcode, so check it before you confirm. The client will not pay until you do.', v_name, v_when, b.treatment_duration_minutes, v_total);
        end if;
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
      v_client_body := format('Your appointment is now on %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
        case when v_initiated = 'client' and v_fee > 0 then format(E'\n\nBecause this change was inside %s hours, a late fee of %s applies. I will be in touch about it.', public.business_setting_int('free_cancellation_hours', 24), public.notification_money(v_fee)) else '' end;
    when 'booking.bank_transfer_verified', 'booking.cash_approved' then
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Thank you. Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
        case when new.event_type = 'booking.cash_approved' then E'\n\nPlease pay the full amount in cash at your appointment.' else E'\n\nI have received your payment.' end;
    when 'booking.confirmed_payment_due' then
      -- Confirmed by the Admin before the money arrived ("Confirm, pay later"): the same confirmation, then what is still to pay and how.
      select * into p from public.booking_payments where booking_id = b.id;
      v_bank := (select s.value from public.business_settings s where s.key = 'bank_details');
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
        format(E'\n\nPayment of %s is still due. Please pay by bank transfer when you can, using the reference %s.', public.notification_money(coalesce(p.amount_gbp, b.total_gbp)), coalesce(p.payment_reference, b.booking_reference)) ||
        case when v_bank ? 'sort_code' and v_bank ? 'account_number' then
          format(E'\n\nAccount name: %s\nSort code: %s\nAccount number: %s', v_bank->>'account_name', v_bank->>'sort_code', v_bank->>'account_number')
            || case when v_bank ? 'bank_name' then format(E'\nBank: %s', v_bank->>'bank_name') else '' end
        else E'\n\nIf you need the bank details, just ask me.' end;
    when 'booking.address_changed' then
      v_client_title := 'Your appointment address has changed';
      v_client_body := format('I have updated the address for your appointment on %s. It is now:' || E'\n%s', v_when, v_where) ||
        case when (new.payload->>'previous_total_gbp')::numeric is distinct from b.total_gbp
          then format(E'\n\nWith the travel for this area, the price is now %s (it was %s).', v_total, public.notification_money((new.payload->>'previous_total_gbp')::numeric)) else '' end ||
        E'\n\nIf this is not right, please let me know.';
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

-- As 20261104100000_single_address.sql, with area_check, so the booking screens can tell the client not to pay yet.
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
  'city_snapshot',b.city_snapshot,'postcode_snapshot',b.postcode_snapshot,'address_snapshot',b.address_snapshot,'area_check',b.area_check,
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
