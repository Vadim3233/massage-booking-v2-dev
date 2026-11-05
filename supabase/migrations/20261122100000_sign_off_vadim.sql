-- Client messages now end "Take care, Vadim" instead of "Warm wishes, Vad", and say "contact Vadim".
-- Many functions write client messages, each with the old sign-off in it. Rather than rewrite every one of them, the sign-off is changed in one
-- place: as a message is saved, a sign-off of "Warm wishes, Vad" at its very end becomes "Take care, Vadim".

create or replace function public.notification_sign_off()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.body := regexp_replace(new.body, E'\n\nWarm wishes,\nVad$', E'\n\nTake care,\nVadim');
  return new;
end;
$$;
revoke all on function public.notification_sign_off() from public, anon, authenticated;

create trigger notification_deliveries_sign_off before insert on public.notification_deliveries
  for each row execute function public.notification_sign_off();

-- The Telegram copy of a client email leaves out the link line and the sign-off, and ends by saying where to change or cancel.
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
    'booking.rescheduled', 'booking.cancelled', 'booking.pending_removed', 'booking.cash_rejected', 'booking.refund_recorded') then
    return null;
  end if;
  select b.client_id into v_client from public.bookings b where b.id = v_booking;
  if v_client is null then return null; end if;
  v_body := replace(replace(replace(new.body, E'\n\nSee or change your booking: {link}', ''), E'\n\nTake care,\nVadim', ''), E'\n\nWarm wishes,\nVad', '')
    || case when v_event in ('booking.created', 'booking.bank_transfer_verified', 'booking.cash_approved', 'booking.confirmed_payment_due', 'booking.rescheduled')
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

-- A WhatsApp message the Admin saved in Settings keeps his own wording; only an old "Warm wishes, Vad" at its end is changed.
update public.business_settings
set value = to_jsonb(regexp_replace(value #>> '{}', E'\n\nWarm wishes,\nVad$', E'\n\nTake care,\nVadim'))
where key = 'share_message' and jsonb_typeof(value) = 'string' and value #>> '{}' ~ E'\n\nWarm wishes,\nVad$';
