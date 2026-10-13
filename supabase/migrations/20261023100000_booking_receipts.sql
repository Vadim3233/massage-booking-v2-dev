-- VAD Massage Booking V2
-- Receipts: a receipt for a booking whose payment has been received, for the Admin to send to a client who asks.
--
-- A receipt is made from the booking and its payment the first time the Admin opens it, gets the next number
-- (VM-2026-0001, 0002 and so on, with no gaps), and is kept as it was that day: changing a price or her business
-- details later never alters a receipt that exists. She can correct the wording on one receipt (who it is for, a note,
-- the words of each line, her details); the amounts, the receipt number, and how and when it was paid always come from
-- the booking and cannot be edited here. If the appointment is moved afterwards she can bring the date and time on the
-- receipt up to date in one tap. Every earlier version is kept. Sending uses what is already there: the email goes
-- through the same queue and sender as every other email, and sharing uses the same text.
--
-- Not a VAT invoice: it says nothing about VAT. Only a confirmed or completed booking whose payment has been marked as
-- received can have a receipt: never a cancelled booking, a missed appointment, or a refunded payment. If a booking is
-- cancelled (or marked as missed, or its payment refunded) after a receipt was made, the receipt stays on record but can no
-- longer be sent or changed, and a receipt email that was still waiting to go is stopped.

-- ---------------------------------------------------------------------------------------------
-- 1. Where receipts live (nobody reads or writes these tables directly; everything goes through the commands below)
-- ---------------------------------------------------------------------------------------------
create table public.receipt_counters (
  year integer primary key,
  last_number integer not null check (last_number > 0)
);
create table public.booking_receipts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete restrict,
  receipt_number text not null unique,
  issued_at timestamptz not null default clock_timestamp(),
  issued_by uuid references auth.users(id) on delete set null,
  snapshot jsonb not null,
  emailed_at timestamptz,
  emailed_to text,
  edited_at timestamptz,
  edited_by uuid references auth.users(id) on delete set null,
  edit_count integer not null default 0 check (edit_count >= 0),
  constraint booking_receipts_snapshot_is_object check (jsonb_typeof(snapshot) = 'object')
);
-- Every version a receipt had before an edit, oldest first, so what a client was sent can always be shown.
create table public.booking_receipt_revisions (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.booking_receipts(id) on delete restrict,
  revision integer not null,
  snapshot jsonb not null,
  edited_by uuid references auth.users(id) on delete set null,
  edited_at timestamptz not null default clock_timestamp(),
  unique (receipt_id, revision)
);
alter table public.receipt_counters enable row level security;
alter table public.booking_receipts enable row level security;
alter table public.booking_receipt_revisions enable row level security;
revoke all on table public.receipt_counters from public, anon, authenticated;
revoke all on table public.booking_receipts from public, anon, authenticated;
revoke all on table public.booking_receipt_revisions from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The words of a receipt, written in one place: the email and the shared message use the same text
-- ---------------------------------------------------------------------------------------------
-- The sender swaps a "{link}" in an email for a web address, so that word never belongs in a receipt. Taking one out can leave another
-- behind ("{li{link}nk}"), so it is taken out again until none is left.
create function public.receipt_strip_link(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := p_text;
begin
  while v like '%{link}%' loop v := replace(v, '{link}', ''); end loop;
  return v;
end;
$$;

create function public.receipt_message(p_snapshot jsonb)
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
    nullif(concat_ws(' · ', nullif(p_snapshot#>>'{business,phone}', ''), nullif(p_snapshot#>>'{business,email}', '')), ''),
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
    case when nullif(btrim(p_snapshot->>'note'), '') is not null then E'\n' || (p_snapshot->>'note') end,
    case when nullif(btrim(p_snapshot#>>'{business,closing}'), '') is not null then E'\n' || (p_snapshot#>>'{business,closing}') end
  ));
$$;

-- Tidies one piece of text. Every kind of line break becomes a plain one; a single-line field then has its line breaks and tabs turned
-- into spaces, and a multi-line field keeps its line breaks. Characters that change how text reads or is shown (control characters, and the
-- ones that flip the direction of text) are refused when the Admin typed them (p_reject), and quietly removed from text that came from
-- elsewhere. Marks that cannot be seen at all (zero-width space, direction marks, the byte order mark, the word joiner) are always dropped.
create function public.receipt_clean_text(p_value text, p_multiline boolean, p_reject boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := p_value;
begin
  if v is null then return null; end if;
  if v ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\x202A-\x202E\x2066-\x2069]' then
    if p_reject then raise exception 'That contains characters that cannot be used' using errcode = '22023'; end if;
    v := regexp_replace(v, '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\x202A-\x202E\x2066-\x2069]', '', 'g');
  end if;
  v := regexp_replace(v, '[\x200B\x200E\x200F\x061C\x2060\xFEFF]', '', 'g');
  v := regexp_replace(v, '\r\n|\r|\x2028|\x2029', E'\n', 'g');
  if not p_multiline then v := regexp_replace(v, '[\t\n]+', ' ', 'g'); end if;
  return nullif(btrim(v, E' \t\n'), '');
end;
$$;

-- Receipt commands queue up behind any cancel, move, no-show, refund or payment command on the same day, the way those commands queue
-- behind each other (the same day lock), so a receipt is never made, changed or sent from a booking that is being cancelled at that moment;
-- then behind any other receipt command on the same booking.
create function public.receipt_lock_booking(p_booking_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_date date;
begin
  select b.date into v_date from public.bookings b where b.id = p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  perform pg_advisory_xact_lock(hashtext('receipt:' || p_booking_id::text));
end;
$$;

-- Why a receipt may not be made (p_making) or sent and changed (not p_making) for this booking and payment, or null if it may.
create function public.receipt_refusal(b public.bookings, p public.booking_payments, p_making boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when b.booking_status = 'cancelled' then
      case when p_making then 'A cancelled booking has no receipt' else 'This booking was cancelled, so its receipt can no longer be sent or changed' end
    when b.booking_status = 'no_show' then
      case when p_making then 'A missed appointment has no receipt' else 'This appointment was marked as missed, so its receipt can no longer be sent or changed' end
    when p.status = 'refunded' then
      case when p_making then 'This payment was refunded, so there is no receipt' else 'This payment was refunded, so its receipt can no longer be sent or changed' end
    when p.status is distinct from 'paid' or b.booking_status not in ('confirmed', 'completed') then
      case when p_making then 'A receipt can be made once the payment is marked as received' else 'The payment is no longer marked as received, so its receipt can no longer be sent or changed' end
  end;
$$;

-- What the screen is given for one receipt: the receipt itself, what became of the latest email of it, and whether the booking has
-- moved on since (so the screen never says more than is true).
create function public.receipt_json(p_receipt public.booking_receipts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', p_receipt.id, 'number', p_receipt.receipt_number, 'issued_at', p_receipt.issued_at, 'snapshot', p_receipt.snapshot,
    'message', public.receipt_message(p_receipt.snapshot), 'emailed_at', p_receipt.emailed_at, 'emailed_to', p_receipt.emailed_to,
    'edited_at', p_receipt.edited_at, 'edit_count', p_receipt.edit_count,
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
-- 3. Her details, shown at the top of every receipt made after she saves them
-- ---------------------------------------------------------------------------------------------
create function public.receipt_check_business(p_business jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := public.receipt_clean_text(p_business->>'name', false, true);
  v_phone text := public.receipt_clean_text(p_business->>'phone', false, true);
  v_email text := lower(public.receipt_clean_text(p_business->>'email', false, true));
  v_address text := public.receipt_clean_text(p_business->>'address', true, true);
  v_closing text := public.receipt_clean_text(p_business->>'closing', false, true);
begin
  if p_business is null or jsonb_typeof(p_business) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_business) k where k not in ('name', 'phone', 'email', 'address', 'closing')) then
    raise exception 'Invalid receipt details' using errcode = '22023';
  end if;
  if v_name is null then raise exception 'Enter your business name' using errcode = '22023'; end if;
  if v_phone is null and v_email is null then raise exception 'Add a phone number or an email address for the receipt' using errcode = '22023'; end if;
  if length(v_name) > 120 or length(coalesce(v_phone, '')) > 40 or length(coalesce(v_address, '')) > 300 or length(coalesce(v_closing, '')) > 200 then
    raise exception 'That is too long' using errcode = '22023';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then
    raise exception 'That email address does not look right' using errcode = '22023';
  end if;
  return jsonb_strip_nulls(jsonb_build_object('name', v_name, 'phone', v_phone, 'email', v_email, 'address', v_address, 'closing', v_closing));
end;
$$;

create function public.admin_receipt_details()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return (select value from public.business_settings where key = 'receipt_details');
end;
$$;

create function public.admin_save_receipt_details(p_details jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business jsonb;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  v_business := public.receipt_check_business(p_details);
  insert into public.business_settings(key, value, updated_by) values ('receipt_details', v_business, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Making a receipt: only from a payment that has been received, and only if the prices add up
-- ---------------------------------------------------------------------------------------------
create function public.build_receipt_snapshot(p_booking_id uuid)
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

  return jsonb_build_object(
    'business', v_details,
    'billed_to', left(coalesce(public.receipt_clean_text(concat_ws(' ', c.first_name, c.last_name), false, false), 'Client'), 120),
    'reference', b.booking_reference,
    'appointment', jsonb_build_object('date', b.date, 'start_minutes', b.start_minutes, 'duration_minutes', b.treatment_duration_minutes),
    'lines', v_lines,
    'total', b.total_gbp,
    'payment', jsonb_build_object('method', p.method, 'paid_at', p.paid_at));
end;
$$;

-- Opening a receipt makes it if it does not exist yet, and gives the same one every time after.
create function public.admin_issue_receipt(p_booking_id uuid)
returns jsonb
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
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_booking_id is null then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform public.receipt_lock_booking(p_booking_id);
  select * into r from public.booking_receipts x where x.booking_id = p_booking_id;
  if found then return public.receipt_json(r); end if;
  v_snapshot := public.build_receipt_snapshot(p_booking_id);
  insert into public.receipt_counters(year, last_number) values (v_year, 1)
  on conflict (year) do update set last_number = public.receipt_counters.last_number + 1
  returning last_number into v_number;
  v_text := 'VM-' || v_year || '-' || lpad(v_number::text, 4, '0');
  insert into public.booking_receipts(booking_id, receipt_number, issued_by, snapshot)
  values (p_booking_id, v_text, auth.uid(), v_snapshot || jsonb_build_object('number', v_text, 'issued_on', (clock_timestamp() at time zone 'Europe/London')::date))
  returning * into r;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.receipt_issued', 'booking', p_booking_id, 'booking.receipt_issued:' || r.id::text, jsonb_build_object('receipt_id', r.id, 'number', v_text, 'actor_id', auth.uid()));
  return public.receipt_json(r);
end;
$$;

-- Looking at a receipt that already exists, without making one. Empty if there is none.
create function public.admin_get_receipt(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.booking_receipts%rowtype;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  select * into r from public.booking_receipts x where x.booking_id = p_booking_id;
  if not found then return null; end if;
  return public.receipt_json(r);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Correcting the words on one receipt. Amounts, number, dates and how it was paid are never taken from here.
-- The one thing that can be brought up to date from the booking is the appointment (if it was moved afterwards).
-- Two people changing the same receipt at once: the last save wins, and the earlier version is kept in its history.
-- ---------------------------------------------------------------------------------------------
create function public.admin_edit_receipt(p_booking_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.booking_receipts%rowtype;
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  s jsonb;
  v_billed text;
  v_note text;
  v_labels jsonb;
  v_lines jsonb;
  i integer;
  v_label text;
  v_refusal text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_booking_id is null or p_changes is null or jsonb_typeof(p_changes) <> 'object' or length(p_changes::text) > 6000
     or exists (select 1 from jsonb_object_keys(p_changes) k where k not in ('billed_to', 'note', 'lines', 'business', 'sync_appointment')) then
    raise exception 'Invalid receipt changes' using errcode = '22023';
  end if;
  perform public.receipt_lock_booking(p_booking_id);
  select * into r from public.booking_receipts x where x.booking_id = p_booking_id for update;
  if not found then raise exception 'This booking has no receipt yet' using errcode = 'P0002'; end if;
  select * into b from public.bookings x where x.id = p_booking_id;
  select * into p from public.booking_payments x where x.booking_id = p_booking_id;
  v_refusal := public.receipt_refusal(b, p, false);
  if v_refusal is not null then raise exception '%', v_refusal using errcode = 'PT409'; end if;
  s := r.snapshot;
  if p_changes ? 'billed_to' then
    v_billed := public.receipt_clean_text(p_changes->>'billed_to', false, true);
    if v_billed is null then raise exception 'Enter who the receipt is for' using errcode = '22023'; end if;
    if length(v_billed) > 120 then raise exception 'That is too long' using errcode = '22023'; end if;
    s := s || jsonb_build_object('billed_to', v_billed);
  end if;
  if p_changes ? 'note' then
    v_note := public.receipt_clean_text(p_changes->>'note', true, true);
    if length(coalesce(v_note, '')) > 300 then raise exception 'That is too long' using errcode = '22023'; end if;
    s := case when v_note is null then s - 'note' else s || jsonb_build_object('note', v_note) end;
  end if;
  if p_changes ? 'lines' then
    v_labels := p_changes->'lines';
    if jsonb_typeof(v_labels) <> 'array' or jsonb_array_length(v_labels) <> jsonb_array_length(s->'lines') then
      raise exception 'Every line of the receipt needs its words' using errcode = '22023';
    end if;
    v_lines := '[]'::jsonb;
    for i in 0 .. jsonb_array_length(v_labels) - 1 loop
      if jsonb_typeof(v_labels->i) <> 'string' then raise exception 'Every line of the receipt needs its words' using errcode = '22023'; end if;
      v_label := public.receipt_clean_text(v_labels->>i, false, true);
      if v_label is null then raise exception 'Every line of the receipt needs its words' using errcode = '22023'; end if;
      if length(v_label) > 120 then raise exception 'That is too long' using errcode = '22023'; end if;
      -- Only the words are taken: the amount stays what it was.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('label', v_label, 'amount', (s->'lines'->i)->'amount'));
    end loop;
    s := s || jsonb_build_object('lines', v_lines);
  end if;
  if p_changes ? 'business' then
    s := s || jsonb_build_object('business', public.receipt_check_business(p_changes->'business'));
  end if;
  if p_changes ? 'sync_appointment' then
    if jsonb_typeof(p_changes->'sync_appointment') <> 'boolean' then raise exception 'Invalid receipt changes' using errcode = '22023'; end if;
    if (p_changes->>'sync_appointment')::boolean then
      s := s || jsonb_build_object('appointment', jsonb_build_object('date', b.date, 'start_minutes', b.start_minutes, 'duration_minutes', b.treatment_duration_minutes));
    end if;
  end if;
  if s is not distinct from r.snapshot then return public.receipt_json(r); end if;
  insert into public.booking_receipt_revisions(receipt_id, revision, snapshot, edited_by) values (r.id, r.edit_count + 1, r.snapshot, auth.uid());
  update public.booking_receipts set snapshot = s, edited_at = clock_timestamp(), edited_by = auth.uid(), edit_count = r.edit_count + 1
  where id = r.id returning * into r;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.receipt_edited', 'booking', p_booking_id, 'booking.receipt_edited:' || r.id::text || ':' || r.edit_count::text,
    jsonb_build_object('receipt_id', r.id, 'number', r.receipt_number, 'edit_count', r.edit_count, 'actor_id', auth.uid()));
  return public.receipt_json(r);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Emailing it to the client: queued like every other email and sent later by the same sender (usually within a few minutes).
-- The same request key sent twice queues one email. The receipt records what became of it (queued, sent, failed).
-- ---------------------------------------------------------------------------------------------
create function public.admin_email_receipt(p_booking_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.booking_receipts%rowtype;
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.clients%rowtype;
  v_email text;
  v_event uuid;
  v_title text;
  v_body text;
  v_refusal text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_booking_id is null or p_request_id is null then raise exception 'Booking unavailable' using errcode = 'P0002'; end if;
  perform public.receipt_lock_booking(p_booking_id);
  select * into r from public.booking_receipts x where x.booking_id = p_booking_id for update;
  if not found then raise exception 'This booking has no receipt yet' using errcode = 'P0002'; end if;
  select * into b from public.bookings x where x.id = p_booking_id;
  select * into p from public.booking_payments x where x.booking_id = p_booking_id;
  v_refusal := public.receipt_refusal(b, p, false);
  if v_refusal is not null then raise exception '%', v_refusal using errcode = 'PT409'; end if;
  select * into c from public.clients x where x.id = b.client_id;
  v_email := lower(coalesce(nullif(btrim(b.booking_email_snapshot), ''), nullif(btrim(c.email), '')));
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'There is no email address on this booking' using errcode = 'PT409';
  end if;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.receipt_emailed', 'booking', p_booking_id, 'booking.receipt_emailed:' || p_request_id::text,
    jsonb_build_object('receipt_id', r.id, 'number', r.receipt_number, 'actor_id', auth.uid()))
  on conflict (deduplication_key) do nothing
  returning id into v_event;
  if v_event is null then return public.receipt_json(r); end if;
  v_title := format('Your receipt from %s (%s)', coalesce(nullif(r.snapshot#>>'{business,name}', ''), 'your appointment'), r.receipt_number);
  v_body := public.receipt_strip_link(format(E'Hello %s,\n\nHere is your receipt for your appointment on %s at %s.\n\n%s\n\nWarm wishes,\nVad',
    coalesce(public.receipt_clean_text(c.first_name, false, false), 'there'),
    to_char((r.snapshot#>>'{appointment,date}')::date, 'FMDay FMDD FMMonth YYYY'),
    lpad(((r.snapshot#>>'{appointment,start_minutes}')::integer / 60)::text, 2, '0') || ':' || lpad(((r.snapshot#>>'{appointment,start_minutes}')::integer % 60)::text, 2, '0'),
    public.receipt_message(r.snapshot)));
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
  values (v_event, 'email', 'client', v_email, v_title, v_body, null);
  update public.booking_receipts set emailed_at = clock_timestamp(), emailed_to = v_email where id = r.id returning * into r;
  return public.receipt_json(r);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. A receipt email that has not gone yet is stopped when its booking is cancelled or marked as missed, or its payment is refunded.
-- Otherwise the sender, which runs later, would still deliver "Total paid" for money that was handed back. An email already being handed
-- to the mail service at that very moment cannot be stopped. The reason is not shown to anyone; the receipt just reports it as failed.
-- ---------------------------------------------------------------------------------------------
create function public.stop_receipt_emails()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notification_deliveries d
     set status = 'failed', attempt_count = 5, last_error = 'The receipt can no longer be sent', next_attempt_at = clock_timestamp()
    from public.event_outbox e
   where e.id = d.event_id and e.event_type = 'booking.receipt_emailed'
     and e.aggregate_id = (to_jsonb(new) ->> tg_argv[0])::uuid
     and d.status in ('pending', 'failed') and d.attempt_count < 5;
  return null;
end;
$$;
create trigger bookings_stop_receipt_emails
after update of booking_status on public.bookings
for each row when (new.booking_status in ('cancelled', 'no_show') and old.booking_status is distinct from new.booking_status)
execute function public.stop_receipt_emails('id');
create trigger booking_payments_stop_receipt_emails
after update of status on public.booking_payments
for each row when (old.status = 'paid' and new.status <> 'paid')
execute function public.stop_receipt_emails('booking_id');

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------
revoke all on function public.receipt_strip_link(text) from public, anon, authenticated;
revoke all on function public.receipt_lock_booking(uuid) from public, anon, authenticated;
revoke all on function public.stop_receipt_emails() from public, anon, authenticated;
revoke all on function public.receipt_message(jsonb) from public, anon, authenticated;
revoke all on function public.receipt_clean_text(text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.receipt_refusal(public.bookings, public.booking_payments, boolean) from public, anon, authenticated;
revoke all on function public.receipt_json(public.booking_receipts) from public, anon, authenticated;
revoke all on function public.receipt_check_business(jsonb) from public, anon, authenticated;
revoke all on function public.build_receipt_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.admin_receipt_details() from public, anon;
revoke all on function public.admin_save_receipt_details(jsonb) from public, anon;
revoke all on function public.admin_issue_receipt(uuid) from public, anon;
revoke all on function public.admin_get_receipt(uuid) from public, anon;
revoke all on function public.admin_edit_receipt(uuid, jsonb) from public, anon;
revoke all on function public.admin_email_receipt(uuid, uuid) from public, anon;
grant execute on function public.admin_receipt_details() to authenticated;
grant execute on function public.admin_save_receipt_details(jsonb) to authenticated;
grant execute on function public.admin_issue_receipt(uuid) to authenticated;
grant execute on function public.admin_get_receipt(uuid) to authenticated;
grant execute on function public.admin_edit_receipt(uuid, jsonb) to authenticated;
grant execute on function public.admin_email_receipt(uuid, uuid) to authenticated;
