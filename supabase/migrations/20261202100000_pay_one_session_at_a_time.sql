-- Booking several sessions: pay for one at a time (Vadim, 9 Nov 2026).
--
-- A client can book as many sessions as they like, but pays only for the next one. Each later session is paid after the one before it.
-- Until now every booking's payment step asked for a bank transfer straight away, so a client booking a few sessions thought she had to pay
-- for all of them. From this migration:
--   * book_my_session_pay_later: on the payment step of a bank-transfer booking, a client who already has an earlier session still to come
--     says "Nothing to pay yet". The booking is linked to that earlier session (bookings.pay_after_booking_id). If the earlier session is
--     already confirmed, this one is confirmed straight away; if not, it is confirmed automatically the moment the earlier one is. The payment
--     stays "awaiting_transfer", as with "Confirm, pay later". Vadim can switch the automatic confirming off in Booking rules
--     (business setting auto_confirm_later_sessions, on to start with): a later session then waits for him like any request, and his
--     "Confirm, pay later" tells the client there is nothing to pay yet instead of asking for the money now.
--   * plan_next_session_payments: once the earlier session is over (or cancelled or missed), the client is sent the amount, the reference and
--     the bank details for this one, by email and Telegram. The sender calls it each time it runs, beside the morning reminders.
--   * get_my_booking tells the payment step which earlier session there is (earlier_session) and which one this booking waits for
--     (pay_after_session); list_my_bookings adds the date of that earlier session, for "Pay after your 12 Nov session".
-- Cash bookings, bookings outside the areas and the Admin's own bookings are unchanged.
--
-- To take this back: drop the triggers bookings_confirm_pay_after and notification_deliveries_pay_after_wording and the functions
-- confirm_later_sessions, book_my_session_pay_later, confirm_pay_after_session, plan_next_session_payments, earlier_session_to_pay_first,
-- auto_confirm_later_sessions, admin_auto_confirm_later_sessions, admin_save_auto_confirm_later_sessions and pay_after_confirmation_wording;
-- delete the business setting auto_confirm_later_sessions; run get_my_booking from
-- 20261118100000_area_postcodes.sql, list_my_bookings from 20261012100000_client_self_service.sql and mirror_client_email_to_telegram from
-- 20261125100000_sign_off_vadim.sql again; then drop the column bookings.pay_after_booking_id.

alter table public.bookings add column pay_after_booking_id uuid references public.bookings(id) on delete set null,
  add constraint bookings_pay_after_not_self check (pay_after_booking_id is distinct from id);
comment on column public.bookings.pay_after_booking_id is
  'The client''s earlier session this booking is paid after (book_my_session_pay_later). Null for a booking paid in the usual way.';
create index bookings_pay_after_booking_id_idx on public.bookings(pay_after_booking_id) where pay_after_booking_id is not null;

-- Whether later sessions are confirmed automatically (true to start with, Vadim's choice on 9 Nov 2026).
insert into public.business_settings(key, value) values ('auto_confirm_later_sessions', 'true') on conflict (key) do nothing;
create function public.auto_confirm_later_sessions()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value = 'true'::jsonb from public.business_settings s where s.key = 'auto_confirm_later_sessions'), true);
$$;
revoke all on function public.auto_confirm_later_sessions() from public, anon, authenticated;

create function public.admin_auto_confirm_later_sessions()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return public.auto_confirm_later_sessions();
end; $$;
revoke all on function public.admin_auto_confirm_later_sessions() from public, anon;
grant execute on function public.admin_auto_confirm_later_sessions() to authenticated;

create function public.admin_save_auto_confirm_later_sessions(p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_on is null then raise exception 'Choose on or off' using errcode = '22023'; end if;
  insert into public.business_settings(key, value, updated_by) values ('auto_confirm_later_sessions', to_jsonb(p_on), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end; $$;
revoke all on function public.admin_save_auto_confirm_later_sessions(boolean) from public, anon;
grant execute on function public.admin_save_auto_confirm_later_sessions(boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. The earlier session to pay first
-- ---------------------------------------------------------------------------------------------
-- The same client's session just before this one that has not ended yet and is not cancelled or missed. A session waiting for payment or
-- for Vadim counts too: booking two sessions in one go, the first is usually still waiting for its transfer to be checked.
create function public.earlier_session_to_pay_first(p_booking_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id
  from public.bookings b
  join public.bookings e on e.client_id = b.client_id and e.id <> b.id
  where b.id = p_booking_id
    and e.booking_status in ('confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
    and (e.date, e.start_minutes) < (b.date, b.start_minutes)
    and ((e.date + make_interval(mins => e.start_minutes + e.treatment_duration_minutes)) at time zone 'Europe/London') > clock_timestamp()
  order by e.date desc, e.start_minutes desc, e.id
  limit 1;
$$;
revoke all on function public.earlier_session_to_pay_first(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Confirming a later session (internal)
-- ---------------------------------------------------------------------------------------------
-- Confirms a later session whose earlier session is confirmed, and tells the client (email, and Telegram through the mirror) and Vadim.
-- Called by book_my_session_pay_later and by the trigger below. Does nothing to a booking that is no longer waiting.
create function public.confirm_pay_after_session(p_booking_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; p public.booking_payments%rowtype; e public.bookings%rowtype; v_event uuid; v_name text; v_first text;
  v_when text; v_earlier text; v_email text; v_sign text := E'\n\nWarm wishes,\nVadim';
begin
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.id is null or p.id is null or b.pay_after_booking_id is null or b.booking_status <> 'awaiting_transfer'
    or p.method <> 'bank_transfer' or p.status <> 'awaiting_transfer' then
    return false;
  end if;
  select * into e from public.bookings where id = b.pay_after_booking_id;
  if e.booking_status is distinct from 'confirmed' then return false; end if;
  update public.bookings set booking_status = 'confirmed', payment_reservation_expires_at = null where id = b.id;
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('booking.confirmed_pay_after', 'booking', b.id, 'booking.confirmed_pay_after:' || b.id::text,
    jsonb_build_object('booking_id', b.id, 'pay_after_booking_id', e.id, 'booking_status', 'confirmed', 'payment_status', p.status, 'amount_gbp', p.amount_gbp))
  on conflict (deduplication_key) do nothing
  returning id into v_event;
  if v_event is null then return true; end if;
  select btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), nullif(btrim(c.first_name), '') into v_name, v_first
    from public.clients c where c.id = b.client_id;
  v_name := coalesce(nullif(v_name, ''), 'A client');
  v_when := public.notification_when(b.date, b.start_minutes);
  v_earlier := public.notification_when(e.date, e.start_minutes);
  v_email := nullif(btrim(b.booking_email_snapshot), '');
  if v_email is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'email', 'client', v_email, 'Your appointment is confirmed',
      format('Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, b.address_snapshot,
        coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference)
      || format(E'\n\nThere is nothing to pay yet. After your appointment on %s, I''ll send you the details to pay %s for this one.',
        v_earlier, public.notification_money(coalesce(p.amount_gbp, b.total_gbp)))
      || E'\n\nSee or change your booking: {link}' || v_sign,
      '/account?booking=' || b.id::text);
  end if;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
  values (v_event, 'in_app', 'admin', 'admin', format('%s booked another session', v_name),
    format('%s, %s minutes, %s. Confirmed automatically, to be paid after their session on %s.', v_when, b.treatment_duration_minutes,
      public.notification_money(b.total_gbp), v_earlier), '/admin/bookings/' || b.id::text, 'sent', clock_timestamp());
  return true;
end; $$;
revoke all on function public.confirm_pay_after_session(uuid) from public, anon, authenticated;

-- When a session is confirmed (by Vadim, or by this same rule), the later sessions waiting for it are confirmed too.
create function public.confirm_later_sessions()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.auto_confirm_later_sessions() then return null; end if;
  for v_id in select l.id from public.bookings l where l.pay_after_booking_id = new.id and l.booking_status = 'awaiting_transfer' order by l.date, l.start_minutes loop
    perform public.confirm_pay_after_session(v_id);
  end loop;
  return null;
end; $$;
revoke all on function public.confirm_later_sessions() from public, anon, authenticated;
create trigger bookings_confirm_pay_after after update of booking_status on public.bookings
  for each row when (new.booking_status = 'confirmed' and old.booking_status is distinct from 'confirmed')
  execute function public.confirm_later_sessions();

-- ---------------------------------------------------------------------------------------------
-- 3. The client's choice: "Nothing to pay yet"
-- ---------------------------------------------------------------------------------------------
-- Same locks and checks as complete_client_payment. Pressing it twice, or after a lost answer, returns the booking as it is.
create function public.book_my_session_pay_later(p_booking_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_date date; b public.bookings%rowtype; p public.booking_payments%rowtype; v_earlier uuid; v_event uuid;
  v_name text; e public.bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select c.id into v_client from public.clients c where c.auth_user_id = auth.uid() for update;
  select bk.date into v_date from public.bookings bk where bk.id = p_booking_id and bk.client_id = v_client;
  if not found then raise exception 'Booking is not available to this client' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id = p_booking_id for update;
  select * into p from public.booking_payments where booking_id = p_booking_id for update;
  if b.pay_after_booking_id is not null then return public.get_my_booking(p_booking_id); end if;
  if b.booking_status <> 'awaiting_transfer' or p.status <> 'awaiting_transfer' or p.method <> 'bank_transfer' or b.area_check is not null then
    raise exception 'This payment request can no longer be changed' using errcode = '22023';
  end if;
  v_earlier := public.earlier_session_to_pay_first(b.id);
  if v_earlier is null then
    raise exception 'You have no earlier appointment to pay for first, so this one is paid now.' using errcode = '22023';
  end if;
  select * into e from public.bookings where id = v_earlier for share;
  update public.bookings set pay_after_booking_id = v_earlier, payment_reservation_expires_at = null where id = b.id;
  if e.booking_status = 'confirmed' and public.auto_confirm_later_sessions() then
    perform public.confirm_pay_after_session(b.id);
  else
    -- Confirmed automatically once the earlier session is (that one is usually still waiting for its transfer to be checked), or, with
    -- the switch off, by Vadim with "Confirm, pay later". He is told now.
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('booking.pay_after_requested', 'booking', b.id, 'booking.pay_after_requested:' || b.id::text,
      jsonb_build_object('booking_id', b.id, 'pay_after_booking_id', e.id))
    on conflict (deduplication_key) do nothing
    returning id into v_event;
    if v_event is not null then
      select coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'A client') into v_name
        from public.clients c where c.id = b.client_id;
      insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
      values (v_event, 'in_app', 'admin', 'admin', format('%s booked another session', v_name),
        format('%s, %s minutes, %s, to be paid after their session on %s. %s',
          public.notification_when(b.date, b.start_minutes), b.treatment_duration_minutes, public.notification_money(b.total_gbp),
          public.notification_when(e.date, e.start_minutes),
          case when public.auto_confirm_later_sessions() then 'It is confirmed automatically when that session is.'
            else 'Confirm it with "Confirm, pay later" when you are happy to: they will pay after that session.' end),
        '/admin/bookings/' || b.id::text, 'sent', clock_timestamp());
      -- With the switch off, Vadim has something to do, so he hears about it where he hears about any request.
      if not public.auto_confirm_later_sessions() then
        insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
        select v_event, ch, 'admin', 'admin', d.title, d.body, d.link_path
        from public.notification_deliveries d cross join (values ('telegram'), ('email')) c(ch)
        where d.event_id = v_event and d.channel = 'in_app';
      end if;
    end if;
  end if;
  return public.get_my_booking(p_booking_id);
end; $$;
revoke all on function public.book_my_session_pay_later(uuid) from public, anon;
grant execute on function public.book_my_session_pay_later(uuid) to authenticated;

-- With the switch off, Vadim confirms a later session with "Confirm, pay later". Its email would ask for the money now; for a later session
-- whose earlier one is still to come it says there is nothing to pay yet instead (the payment details follow after that session).
create function public.pay_after_confirmation_wording()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_event text; b public.bookings%rowtype; e public.bookings%rowtype;
begin
  select o.event_type into v_event from public.event_outbox o where o.id = new.event_id and o.aggregate_type = 'booking';
  if v_event is distinct from 'booking.confirmed_payment_due' then return new; end if;
  select bk.* into b from public.bookings bk join public.event_outbox o on o.aggregate_id = bk.id where o.id = new.event_id;
  if b.pay_after_booking_id is null then return new; end if;
  select * into e from public.bookings where id = b.pay_after_booking_id;
  if e.booking_status not in ('confirmed', 'awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval')
    or ((e.date + make_interval(mins => e.start_minutes + e.treatment_duration_minutes)) at time zone 'Europe/London') <= clock_timestamp() then
    return new;
  end if;
  new.body := regexp_replace(new.body, E'\n\nPayment of .*?(\n\nSee or change your booking: [{]link[}])',
    format(E'\n\nThere is nothing to pay yet. After your appointment on %s, I''ll send you the details to pay %s for this one.',
      public.notification_when(e.date, e.start_minutes), public.notification_money(b.total_gbp)) || E'\\1');
  return new;
end; $$;
revoke all on function public.pay_after_confirmation_wording() from public, anon, authenticated;
create trigger notification_deliveries_pay_after_wording before insert on public.notification_deliveries
  for each row when (new.audience = 'client' and new.channel = 'email')
  execute function public.pay_after_confirmation_wording();

-- ---------------------------------------------------------------------------------------------
-- 4. After the earlier session: the details to pay for the next one
-- ---------------------------------------------------------------------------------------------
-- A confirmed later session still waiting for its bank transfer, whose earlier session has ended (or was cancelled or missed, or has been moved
-- after it), and which is still to come. Each is sent once (the event's deduplication key). Returns how many were sent.
create function public.plan_next_session_payments(p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_event uuid; v_made integer := 0; v_bank jsonb; v_sign text := E'\n\nWarm wishes,\nVadim';
begin
  v_bank := (select s.value from public.business_settings s where s.key = 'bank_details');
  for r in
    select l.id, l.date, l.start_minutes, l.total_gbp, l.booking_reference, l.booking_email_snapshot, p.amount_gbp, p.payment_reference,
           nullif(btrim(c.first_name), '') as first_name, e.booking_status as earlier_status,
           ((e.date + make_interval(mins => e.start_minutes + e.treatment_duration_minutes)) at time zone 'Europe/London') <= p_now as earlier_over
      from public.bookings l
      join public.booking_payments p on p.booking_id = l.id
      join public.bookings e on e.id = l.pay_after_booking_id
      join public.clients c on c.id = l.client_id
     where l.booking_status = 'confirmed'
       and p.method = 'bank_transfer' and p.status = 'awaiting_transfer'
       and nullif(btrim(l.booking_email_snapshot), '') is not null
       and ((l.date + make_interval(mins => l.start_minutes)) at time zone 'Europe/London') > p_now
       and (e.booking_status in ('cancelled', 'no_show')
         or ((e.date + make_interval(mins => e.start_minutes + e.treatment_duration_minutes)) at time zone 'Europe/London') <= p_now
         or (e.date, e.start_minutes) >= (l.date, l.start_minutes))
     order by l.date, l.start_minutes, l.id
  loop
    v_event := null;
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('booking.next_payment_due', 'booking', r.id, 'booking.next_payment_due:' || r.id::text, jsonb_build_object('booking_id', r.id))
    on conflict (deduplication_key) do nothing
    returning id into v_event;
    if v_event is null then continue; end if;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'email', 'client', btrim(r.booking_email_snapshot), 'Payment for your next appointment',
      format(E'Hi %s,\n\n', coalesce(r.first_name, 'there'))
      || case when r.earlier_over and r.earlier_status in ('confirmed', 'completed') then 'Thank you for your appointment. ' else '' end
      || format('Your next appointment is on %s, and you can pay for it now: %s by bank transfer, using the reference %s.',
           public.notification_when(r.date, r.start_minutes), public.notification_money(coalesce(r.amount_gbp, r.total_gbp)),
           coalesce(r.payment_reference, r.booking_reference))
      || case when v_bank ? 'sort_code' and v_bank ? 'account_number' then
           format(E'\n\nAccount name: %s\nSort code: %s\nAccount number: %s', v_bank->>'account_name', v_bank->>'sort_code', v_bank->>'account_number')
             || case when v_bank ? 'bank_name' then format(E'\nBank: %s', v_bank->>'bank_name') else '' end
         else E'\n\nIf you need the bank details, just ask me.' end
      || E'\n\nSee or change your booking: {link}' || v_sign,
      '/account?booking=' || r.id::text);
    v_made := v_made + 1;
  end loop;
  return v_made;
end; $$;
revoke all on function public.plan_next_session_payments(timestamptz) from public, anon, authenticated;
grant execute on function public.plan_next_session_payments(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Telegram copies of the two new client emails
-- ---------------------------------------------------------------------------------------------
-- As 20261125100000_sign_off_vadim.sql, with booking.confirmed_pay_after and booking.next_payment_due among the copied events.
create or replace function public.mirror_client_email_to_telegram()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text;
  v_booking uuid;
  v_client uuid;
  v_body text;
begin
  select e.event_type, e.aggregate_id into v_event, v_booking
  from public.event_outbox e where e.id = new.event_id and e.aggregate_type = 'booking';
  if v_event is null or v_event not in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.confirmed_payment_due',
    'booking.confirmed_pay_after', 'booking.next_payment_due',
    'booking.rescheduled', 'booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected', 'booking.refund_recorded') then
    return null;
  end if;
  select b.client_id into v_client from public.bookings b where b.id = v_booking;
  if v_client is null then return null; end if;
  v_body := replace(replace(replace(new.body, E'\n\nSee or change your booking: {link}', ''), E'\n\nWarm wishes,\nVadim', ''), E'\n\nWarm wishes,\nVad', '')
    || case when v_event in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.confirmed_payment_due',
         'booking.confirmed_pay_after', 'booking.next_payment_due', 'booking.rescheduled')
         then E'\n\nTo change or cancel, use the link in your email, or contact Vadim.' else '' end;
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body)
  select new.event_id, 'telegram_client', 'client', l.chat_id::text, new.title, v_body
  from public.client_telegram_links l
  where l.client_id = v_client and l.stopped_at is null
  on conflict (event_id, channel, recipient) do nothing;
  return null;
end;
$$;
revoke all on function public.mirror_client_email_to_telegram() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. What the client's pages read
-- ---------------------------------------------------------------------------------------------
-- As 20261118100000_area_postcodes.sql, with earlier_session (the session this one could be paid after, while the choice is still open) and
-- pay_after_session (the one it is paid after, once chosen), each saying whether later sessions are confirmed automatically (auto_confirm).
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
    'transfer_declared_at',p.transfer_declared_at),
  'pay_after_session',(select jsonb_build_object('id',e.id,'date',e.date,'start_minutes',e.start_minutes,'booking_status',e.booking_status,
      'auto_confirm',public.auto_confirm_later_sessions())
    from public.bookings e where e.id=b.pay_after_booking_id),
  'earlier_session',case when b.pay_after_booking_id is null and b.booking_status='awaiting_transfer' and p.status='awaiting_transfer'
      and p.method='bank_transfer' and b.area_check is null then
    (select jsonb_build_object('id',e.id,'date',e.date,'start_minutes',e.start_minutes,'booking_status',e.booking_status,
      'auto_confirm',public.auto_confirm_later_sessions())
      from public.bookings e where e.id=public.earlier_session_to_pay_first(b.id)) end
 ) into v_result from public.bookings b join public.clients c on c.id=b.client_id
 join public.booking_payments p on p.booking_id=b.id
 where b.id=p_booking_id and (c.auth_user_id=auth.uid()
   or (c.id::text=coalesce(auth.jwt()->>'link_client','') and b.id::text=coalesce(auth.jwt()->>'link_booking','')));
 if v_result is null then raise exception 'Booking is not available to this client' using errcode='42501'; end if;
 return v_result;
end; $function$;

-- As 20261012100000_client_self_service.sql, with the date and time of the session a booking is paid after.
create or replace function public.list_my_bookings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row order by (row->>'date') desc, (row->>'start_minutes')::integer desc) from (
    select jsonb_build_object('id', b.id, 'booking_reference', b.booking_reference, 'booking_status', b.booking_status,
      'date', b.date, 'start_minutes', b.start_minutes, 'treatment_duration_minutes', b.treatment_duration_minutes,
      'total_gbp', b.total_gbp, 'payment_method', p.method, 'payment_status', p.status,
      'late_fee_status', b.late_fee_status, 'late_fee_due_gbp', b.late_fee_due_gbp, 'refund_due_gbp', b.refund_due_gbp,
      'pay_after_date', e.date, 'pay_after_start_minutes', e.start_minutes,
      'services', (select string_agg(s.service_name_snapshot, ', ' order by s.position) from public.booking_sessions s where s.booking_id = b.id)) as row
    from public.bookings b
    join public.clients c on c.id = b.client_id
    join public.booking_payments p on p.booking_id = b.id
    left join public.bookings e on e.id = b.pay_after_booking_id
    where c.auth_user_id = auth.uid()
    order by b.date desc, b.start_minutes desc limit 50) q), '[]'::jsonb);
end;
$$;
