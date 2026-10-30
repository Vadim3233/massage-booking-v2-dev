-- Receipts for insurance claims (Vadim, 30 Oct 2026).
--
-- A client needed more on a receipt to claim back a treatment from his health insurer. From this migration:
--   * Every receipt carries the practitioner's credentials (full name, professional title, professional association and membership
--     number), kept in Receipt details next to the business name, with a website and a short line under the name. A receipt is not made
--     without the credentials. They are filled in here for Vadim, only where nothing is saved for them yet.
--   * New receipts are numbered VAD-2026-0001 and so on. The count carries on from the receipts already made (VM-...), which keep their numbers.
--   * A receipt is made by itself when a payment is marked as received (bank transfer, cash, or a past booking entered as paid), at the end
--     of that same save. If one cannot be made then (no Receipt details yet, or the prices do not add up), nothing else is held up: the
--     Admin can still make it from the booking as before. A booking confirmed with payment still awaited gets no receipt.
--   * A receipt keeps the treatments as they were booked (name, length, and who had it), so the PDF can show them.
--   * The screen is told what the receipt now stands for: paid, refunded, cancelled, missed, or no longer marked as paid. The PDF says so.
--   * A client can fetch the receipt for their own booking (signed in, or from the private link in their email), to download it as a PDF.
-- Booking, payment and scheduling rules are unchanged.

-- ---------------------------------------------------------------------------------------------
-- 1. Receipt details: the credentials, a website and a short line under the business name
-- ---------------------------------------------------------------------------------------------
create or replace function public.receipt_check_business(p_business jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := public.receipt_clean_text(p_business->>'name', false, true);
  v_tagline text := public.receipt_clean_text(p_business->>'tagline', false, true);
  v_phone text := public.receipt_clean_text(p_business->>'phone', false, true);
  v_email text := lower(public.receipt_clean_text(p_business->>'email', false, true));
  v_website text := public.receipt_clean_text(p_business->>'website', false, true);
  v_address text := public.receipt_clean_text(p_business->>'address', true, true);
  v_closing text := public.receipt_clean_text(p_business->>'closing', false, true);
  v_practitioner text := public.receipt_clean_text(p_business->>'practitioner_name', false, true);
  v_title text := public.receipt_clean_text(p_business->>'practitioner_title', false, true);
  v_association text := public.receipt_clean_text(p_business->>'association', false, true);
  v_membership text := public.receipt_clean_text(p_business->>'membership_number', false, true);
begin
  if p_business is null or jsonb_typeof(p_business) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_business) k where k not in ('name', 'tagline', 'phone', 'email', 'website', 'address', 'closing',
       'practitioner_name', 'practitioner_title', 'association', 'membership_number')) then
    raise exception 'Invalid receipt details' using errcode = '22023';
  end if;
  if v_name is null then raise exception 'Enter your business name' using errcode = '22023'; end if;
  if v_phone is null and v_email is null and v_website is null then
    raise exception 'Add a phone number, an email address or a website for the receipt' using errcode = '22023';
  end if;
  if length(v_name) > 120 or length(coalesce(v_tagline, '')) > 160 or length(coalesce(v_phone, '')) > 40 or length(coalesce(v_website, '')) > 120
     or length(coalesce(v_address, '')) > 300 or length(coalesce(v_closing, '')) > 200 or length(coalesce(v_practitioner, '')) > 120
     or length(coalesce(v_title, '')) > 120 or length(coalesce(v_association, '')) > 160 or length(coalesce(v_membership, '')) > 40 then
    raise exception 'That is too long' using errcode = '22023';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then
    raise exception 'That email address does not look right' using errcode = '22023';
  end if;
  if v_practitioner is null or v_association is null or v_membership is null then
    raise exception 'Add your full name, professional association and membership number' using errcode = '22023';
  end if;
  return jsonb_strip_nulls(jsonb_build_object('name', v_name, 'tagline', v_tagline, 'phone', v_phone, 'email', v_email, 'website', v_website,
    'address', v_address, 'closing', v_closing, 'practitioner_name', v_practitioner, 'practitioner_title', v_title,
    'association', v_association, 'membership_number', v_membership));
end;
$$;

-- Vadim's details, from his request. Anything already saved stays as it is; only what is missing is added.
insert into public.business_settings(key, value)
values ('receipt_details', jsonb_build_object(
  'name', 'VAD Soft Tissue & Massage Therapy',
  'tagline', 'Professional Massage & Soft Tissue Therapy · Mobile therapy services, London, UK',
  'website', 'vadmassage.com',
  'practitioner_name', 'Vadim Susarin',
  'practitioner_title', 'Level 5 Soft Tissue Therapist',
  'association', 'Institute for Soft Tissue Therapists (ISRM)',
  'membership_number', '9555'))
on conflict (key) do update set value = excluded.value || public.business_settings.value, updated_at = now();

-- ---------------------------------------------------------------------------------------------
-- 2. The words of a receipt for email and WhatsApp: now with the website and the credentials
-- ---------------------------------------------------------------------------------------------
create or replace function public.receipt_message(p_snapshot jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select public.receipt_strip_link(concat_ws(E'\n',
    'Receipt ' || (p_snapshot->>'number'),
    'Issued ' || to_char((p_snapshot->>'issued_on')::date, 'FMDD FMMonth YYYY'),
    '',
    nullif(p_snapshot#>>'{business,name}', ''),
    nullif(concat_ws(' · ', nullif(p_snapshot#>>'{business,phone}', ''), nullif(p_snapshot#>>'{business,email}', ''), nullif(p_snapshot#>>'{business,website}', '')), ''),
    nullif(p_snapshot#>>'{business,address}', ''),
    '',
    'Received from: ' || (p_snapshot->>'billed_to'),
    'Booking reference: ' || (p_snapshot->>'reference'),
    'Appointment: ' || to_char((p_snapshot#>>'{appointment,date}')::date, 'FMDay FMDD FMMonth YYYY') || ' at '
      || lpad(((p_snapshot#>>'{appointment,start_minutes}')::integer / 60)::text, 2, '0') || ':' || lpad(((p_snapshot#>>'{appointment,start_minutes}')::integer % 60)::text, 2, '0')
      || ' (' || (p_snapshot#>>'{appointment,duration_minutes}') || ' minutes)',
    '',
    (select string_agg((l.value->>'label') || ': ' || public.notification_money((l.value->>'amount')::numeric), E'\n' order by l.ordinality)
       from jsonb_array_elements(p_snapshot->'lines') with ordinality l(value, ordinality)),
    'Total paid: ' || public.notification_money((p_snapshot->>'total')::numeric),
    'Paid by ' || case p_snapshot#>>'{payment,method}' when 'bank_transfer' then 'bank transfer' when 'cash' then 'cash'
        else replace(coalesce(p_snapshot#>>'{payment,method}', 'payment'), '_', ' ') end
      || ' on ' || to_char(((p_snapshot#>>'{payment,paid_at}')::timestamptz at time zone 'Europe/London')::date, 'FMDD FMMonth YYYY') || '.',
    case when nullif(p_snapshot#>>'{business,practitioner_name}', '') is not null then
      E'\nPractitioner: ' || concat_ws(', ', p_snapshot#>>'{business,practitioner_name}', nullif(p_snapshot#>>'{business,practitioner_title}', ''))
      || concat_ws(', ', E'\n' || nullif(p_snapshot#>>'{business,association}', ''),
           'membership number ' || nullif(p_snapshot#>>'{business,membership_number}', '')) end,
    case when nullif(btrim(p_snapshot->>'note'), '') is not null then E'\n' || (p_snapshot->>'note') end,
    case when nullif(btrim(p_snapshot#>>'{business,closing}'), '') is not null then E'\n' || (p_snapshot#>>'{business,closing}') end
  ));
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. What a receipt stands for now. It is kept whatever happens later; the PDF says if it no longer shows money received.
-- ---------------------------------------------------------------------------------------------
create function public.receipt_standing(p_booking_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'status', case
      when p.status = 'refunded' then 'refunded'
      when b.booking_status = 'cancelled' then 'cancelled'
      when b.booking_status = 'no_show' then 'missed'
      when p.status is distinct from 'paid' then 'unpaid'
      else 'paid' end,
    'refunded_at', case when p.status = 'refunded' then p.refunded_at end,
    'refunded_gbp', case when p.status = 'refunded' then p.refunded_gbp end)
  from public.bookings b left join public.booking_payments p on p.booking_id = b.id
  where b.id = p_booking_id;
$$;

create or replace function public.receipt_json(p_receipt public.booking_receipts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', p_receipt.id, 'number', p_receipt.receipt_number, 'issued_at', p_receipt.issued_at, 'snapshot', p_receipt.snapshot,
    'message', public.receipt_message(p_receipt.snapshot), 'emailed_at', p_receipt.emailed_at, 'emailed_to', p_receipt.emailed_to,
    'edited_at', p_receipt.edited_at, 'edit_count', p_receipt.edit_count,
    'standing', public.receipt_standing(p_receipt.booking_id),
    'email', (select jsonb_build_object('status', d.status, 'to', d.recipient, 'queued_at', d.created_at, 'sent_at', d.sent_at, 'attempts', d.attempt_count)
                from public.event_outbox e join public.notification_deliveries d on d.event_id = e.id
               where e.aggregate_id = p_receipt.booking_id and e.event_type = 'booking.receipt_emailed' and d.channel = 'email'
               order by d.created_at desc limit 1),
    'changes', (select jsonb_build_object(
                  'appointment', b.date is distinct from (p_receipt.snapshot#>>'{appointment,date}')::date
                    or b.start_minutes is distinct from (p_receipt.snapshot#>>'{appointment,start_minutes}')::integer
                    or b.treatment_duration_minutes is distinct from (p_receipt.snapshot#>>'{appointment,duration_minutes}')::integer,
                  'total', b.total_gbp is distinct from (p_receipt.snapshot->>'total')::numeric)
                from public.bookings b where b.id = p_receipt.booking_id));
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Making a receipt: as before, plus the credentials must be there, and the treatments are kept as booked
-- ---------------------------------------------------------------------------------------------
create or replace function public.build_receipt_snapshot(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.clients%rowtype;
  v_details jsonb;
  v_lines jsonb;
  v_extra jsonb;
  v_treatments jsonb;
  v_refusal text;
  v_travel_label text;
begin
  select * into b from public.bookings x where x.id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  select * into p from public.booking_payments x where x.booking_id = b.id;
  v_refusal := public.receipt_refusal(b, p, true);
  if v_refusal is not null then raise exception '%', v_refusal using errcode = 'PT409'; end if;
  select value into v_details from public.business_settings where key = 'receipt_details';
  if v_details is null or nullif(btrim(v_details->>'name'), '') is null then
    raise exception 'Save your receipt details first' using errcode = 'PT409';
  end if;
  -- Insurers ask for the practitioner and their register, so a receipt is never made without them.
  if nullif(btrim(v_details->>'practitioner_name'), '') is null or nullif(btrim(v_details->>'association'), '') is null
     or nullif(btrim(v_details->>'membership_number'), '') is null then
    raise exception 'Save your receipt details first' using errcode = 'PT409';
  end if;
  if p.amount_gbp <> b.total_gbp then
    raise exception 'The amount paid does not match the booking, so a receipt cannot be made' using errcode = 'PT409';
  end if;
  select * into c from public.clients x where x.id = b.client_id;

  -- What the Admin sees on the booking: each treatment and extra, then travel and congestion. If the booking's own subtotals disagree
  -- with those lines, the subtotals are used instead; if neither adds up to the total, no receipt is made rather than a wrong one.
  -- The words on each line come from names the Admin typed elsewhere, so they are tidied the same way as anything typed here.
  v_travel_label := left(coalesce(public.receipt_clean_text('Travel' || coalesce(', ' || nullif(btrim(b.service_area_name_snapshot), ''), ''), false, false), 'Travel'), 120);
  v_extra := coalesce((select jsonb_agg(jsonb_build_object('label', left(coalesce(public.receipt_clean_text(t.label, false, false), 'Treatment'), 120), 'amount', t.amount) order by t.sort, t.pos, t.label) from (
      select 1 as sort, s.position as pos, s.service_name_snapshot || ', ' || s.duration_minutes || ' minutes' as label, s.unit_price_gbp as amount
        from public.booking_sessions s where s.booking_id = b.id
      union all
      select 2, 0, e.enhancement_name_snapshot || case when e.quantity > 1 then ' × ' || e.quantity else '' end, e.unit_price_gbp * e.quantity
        from public.booking_enhancements e where e.booking_id = b.id
      union all
      select 2, s2.position, se.enhancement_name_snapshot || case when se.quantity > 1 then ' × ' || se.quantity else '' end, se.unit_price_gbp * se.quantity
        from public.booking_session_enhancements se join public.booking_sessions s2 on s2.id = se.booking_session_id where s2.booking_id = b.id
    ) t), '[]'::jsonb);
  v_lines := v_extra
    || case when b.travel_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', v_travel_label, 'amount', b.travel_fee_gbp)) else '[]'::jsonb end
    || case when b.congestion_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Congestion charge', 'amount', b.congestion_fee_gbp)) else '[]'::jsonb end;
  if (select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(v_lines) l) <> b.total_gbp then
    v_lines := (case when b.service_subtotal_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Treatment', 'amount', b.service_subtotal_gbp)) else '[]'::jsonb end)
      || (case when b.enhancements_total_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Extras', 'amount', b.enhancements_total_gbp)) else '[]'::jsonb end)
      || (case when b.travel_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', v_travel_label, 'amount', b.travel_fee_gbp)) else '[]'::jsonb end)
      || (case when b.congestion_fee_gbp > 0 then jsonb_build_array(jsonb_build_object('label', 'Congestion charge', 'amount', b.congestion_fee_gbp)) else '[]'::jsonb end);
    if (select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(v_lines) l) <> b.total_gbp then
      raise exception 'The prices on this booking do not add up to its total, so a receipt cannot be made' using errcode = 'PT409';
    end if;
  end if;
  -- Each treatment as booked: its name, its length, and who it was for (when the booking names them), for the treatment section of the PDF.
  v_treatments := coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', left(coalesce(public.receipt_clean_text(s.service_name_snapshot, false, false), 'Treatment'), 120),
      'duration_minutes', s.duration_minutes,
      'recipient', left(public.receipt_clean_text(s.recipient_name, false, false), 120))) order by s.position)
    from public.booking_sessions s where s.booking_id = b.id), '[]'::jsonb);

  return jsonb_build_object(
    'business', v_details,
    'billed_to', left(coalesce(public.receipt_clean_text(concat_ws(' ', c.first_name, c.last_name), false, false), 'Client'), 120),
    'reference', b.booking_reference,
    'appointment', jsonb_build_object('date', b.date, 'start_minutes', b.start_minutes, 'duration_minutes', b.treatment_duration_minutes),
    'treatments', v_treatments,
    'lines', v_lines,
    'total', b.total_gbp,
    'payment', jsonb_build_object('method', p.method, 'paid_at', p.paid_at, 'amount', p.amount_gbp));
end;
$$;

-- One receipt per booking, numbered in order with no gaps. Calling it again gives the receipt already made.
create function public.issue_receipt(p_booking_id uuid, p_actor uuid)
returns public.booking_receipts
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.booking_receipts%rowtype;
  v_snapshot jsonb;
  v_year integer := extract(year from (clock_timestamp() at time zone 'Europe/London'))::integer;
  v_number integer;
  v_text text;
begin
  perform public.receipt_lock_booking(p_booking_id);
  select * into r from public.booking_receipts x where x.booking_id = p_booking_id;
  if found then return r; end if;
  v_snapshot := public.build_receipt_snapshot(p_booking_id);
  insert into public.receipt_counters(year, last_number) values (v_year, 1)
  on conflict (year) do update set last_number = public.receipt_counters.last_number + 1
  returning last_number into v_number;
  v_text := 'VAD-' || v_year || '-' || lpad(v_number::text, 4, '0');
  insert into public.booking_receipts(booking_id, receipt_number, issued_by, snapshot)
  values (p_booking_id, v_text, p_actor, v_snapshot || jsonb_build_object('number', v_text, 'issued_on', (clock_timestamp() at time zone 'Europe/London')::date))
  returning * into r;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.receipt_issued', 'booking', p_booking_id, 'booking.receipt_issued:' || r.id::text, jsonb_build_object('receipt_id', r.id, 'number', v_text, 'actor_id', p_actor));
  return r;
end;
$$;

create or replace function public.admin_issue_receipt(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_booking_id is null then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  return public.receipt_json(public.issue_receipt(p_booking_id, auth.uid()));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Made by itself once the payment is received. This runs at the end of the save, after the booking and its payment have both been
-- written (whichever came first), and never stops that save: if a receipt cannot be made, the Admin can make it later from the booking.
-- ---------------------------------------------------------------------------------------------
create function public.auto_issue_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
begin
  if exists (select 1 from public.booking_receipts r where r.booking_id = v_booking) then return null; end if;
  if not exists (select 1 from public.bookings b join public.booking_payments p on p.booking_id = b.id
                 where b.id = v_booking and p.status = 'paid' and b.booking_status in ('confirmed', 'completed')) then
    return null;
  end if;
  begin
    perform public.issue_receipt(v_booking, auth.uid());
  exception when others then
    raise warning 'Receipt for booking % not made: %', v_booking, sqlerrm;
  end;
  return null;
end;
$$;
create constraint trigger booking_payments_auto_receipt_insert
after insert on public.booking_payments
deferrable initially deferred
for each row when (new.status = 'paid')
execute function public.auto_issue_receipt('booking_id');
create constraint trigger booking_payments_auto_receipt_update
after update of status on public.booking_payments
deferrable initially deferred
for each row when (new.status = 'paid' and old.status is distinct from 'paid')
execute function public.auto_issue_receipt('booking_id');
create constraint trigger bookings_auto_receipt
after update of booking_status on public.bookings
deferrable initially deferred
for each row when (new.booking_status in ('confirmed', 'completed') and old.booking_status is distinct from new.booking_status)
execute function public.auto_issue_receipt('id');

-- ---------------------------------------------------------------------------------------------
-- 6. The client's own receipt, to download as a PDF. Only the receipt itself and what it now stands for: nothing about emails or edits.
-- Empty when the booking has no receipt. Someone else's booking is refused the same way as the booking itself.
-- ---------------------------------------------------------------------------------------------
create function public.client_receipt_json(p_booking_id uuid, p_client uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.booking_receipts%rowtype;
begin
  if p_client is null or not exists (select 1 from public.bookings b where b.id = p_booking_id and b.client_id = p_client) then
    raise exception 'Booking is not available to this client' using errcode = '42501';
  end if;
  select * into r from public.booking_receipts x where x.booking_id = p_booking_id;
  if not found then return null; end if;
  return jsonb_build_object('number', r.receipt_number, 'snapshot', r.snapshot, 'standing', public.receipt_standing(p_booking_id));
end;
$$;

create function public.get_my_receipt(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select c.id into v_client from public.clients c where c.auth_user_id = auth.uid();
  return public.client_receipt_json(p_booking_id, v_client);
end;
$$;

create function public.receipt_by_key(p_booking_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_result jsonb;
begin
  v_result := public.client_receipt_json(p_booking_id, public.booking_link_client(p_booking_id, p_key));
  perform public.booking_link_end(v_claims, v_sub);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------
revoke all on function public.receipt_standing(uuid) from public, anon, authenticated;
revoke all on function public.issue_receipt(uuid, uuid) from public, anon, authenticated;
revoke all on function public.auto_issue_receipt() from public, anon, authenticated;
revoke all on function public.client_receipt_json(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_my_receipt(uuid) from public, anon;
revoke all on function public.receipt_by_key(uuid, text) from public;
grant execute on function public.get_my_receipt(uuid) to authenticated;
grant execute on function public.receipt_by_key(uuid, text) to anon, authenticated;
