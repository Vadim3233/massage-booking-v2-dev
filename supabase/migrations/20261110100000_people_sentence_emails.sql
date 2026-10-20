-- Client emails say who, how long and the price in the same sentence as the booking screens (Vadim's change request 2, 20 Oct 2026;
-- docs/change-requests-2026-10-20.md), e.g. "One 2-hour massage for 1 person – £170.00", on its own line, where they said only "(120 minutes)".
-- The sentence is made by people_sentence(), which is word for word src/booking/bookingWords.js peopleSentence (checked by the test
-- server/bookingSentence.integration.test.js). Only the three booking emails and the regular-booking email change; nothing else does.

-- "One 2-hour massage for 1 person", "Three 60-minute massages for 3 people, one after the other – 3 hours in total",
-- "Two massages for 2 people, one after the other (60 min + 90 min) – 2 hours 30 minutes in total".
create function public.people_sentence(p_durations integer[], p_noun text)
returns text
language sql
immutable
set search_path = ''
as $$
  with parts as (
    select coalesce(array_length(p_durations, 1), 0) as people,
      (select sum(d) from unnest(p_durations) d)::integer as total,
      (select bool_and(d = p_durations[1]) from unnest(p_durations) d) as same
  ), words as (
    select people, total, same,
      case when p_durations[1] >= 120 and p_durations[1] % 60 = 0 then (p_durations[1] / 60) || '-hour' else p_durations[1] || '-minute' end as first_length,
      coalesce((array['One', 'Two', 'Three', 'Four'])[people], people::text) as count_word,
      concat_ws(' ',
        case when total / 60 > 0 then (total / 60) || case when total / 60 = 1 then ' hour' else ' hours' end end,
        case when total % 60 > 0 then (total % 60) || ' minutes' end) as total_words
    from parts
  )
  select case
    when people = 0 then null
    when people = 1 then format('One %s %s for 1 person', first_length, p_noun)
    when same then format('%s %s %ss for %s people, one after the other – %s in total', count_word, first_length, p_noun, people, total_words)
    else format('%s %ss for %s people, one after the other (%s) – %s in total', count_word, p_noun, people,
      (select string_agg(d || ' min', ' + ' order by o) from unnest(p_durations) with ordinality u(d, o)), total_words)
  end
  from words;
$$;

-- The sentence for a booking, from its sessions in order, with its price unless asked not to: "One 2-hour massage for 1 person – £170.00".
create function public.booking_people_sentence(p_booking_id uuid, p_with_price boolean default true)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.people_sentence(
      array(select s.duration_minutes from public.booking_sessions s where s.booking_id = b.id order by s.position),
      case when (select s.service_name_snapshot from public.booking_sessions s where s.booking_id = b.id order by s.position limit 1) ~* 'massage' then 'massage' else 'session' end)
    || case when p_with_price then ' – ' || public.notification_money(b.total_gbp) else '' end
  from public.bookings b where b.id = p_booking_id;
$$;
revoke all on function public.people_sentence(integer[], text) from public, anon, authenticated;
revoke all on function public.booking_people_sentence(uuid, boolean) from public, anon, authenticated;
grant execute on function public.people_sentence(integer[], text) to service_role;

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
        v_client_body := format('Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference);
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
      v_client_body := format('Your appointment is now on %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
        case when v_initiated = 'client' and v_fee > 0 then format(E'\n\nBecause this change was inside %s hours, a late fee of %s applies. I will be in touch about it.', public.business_setting_int('free_cancellation_hours', 24), public.notification_money(v_fee)) else '' end;
    when 'booking.bank_transfer_verified', 'booking.cash_approved' then
      v_client_title := 'Your appointment is confirmed';
      v_client_body := format('Thank you. Your appointment is confirmed for %s at %s.' || E'\n%s.\nReference: %s', v_when, v_where, coalesce(public.booking_people_sentence(b.id), b.treatment_duration_minutes || ' minutes'), b.booking_reference) ||
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
    v_client_body := format('Your next regular appointment is booked for %s at %s.' || E'\n%s.', v_when, v_where, coalesce(public.booking_people_sentence(b.id, false), b.treatment_duration_minutes || ' minutes')) ||
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
