-- Gift voucher emails that reach the inbox (ADR-110, 2026-11-20). Vadim's own test: Gmail filed the voucher email under Promotions.
-- 1. The email to the person receiving the voucher has a personal subject: "Sonia, Vadim has sent you a gift 🎁"
--    (was "Vadim has sent you a gift"). plan_gift_messages as 20261214100000_gift_vouchers.sql with only that line changed.
-- 2. The buyer's emails about an emailed voucher ("one last step" and "ready") say it may land in Promotions or Junk.
--    gift_notify as 20261221100000_gift_voucher_records.sql plus that paragraph.
-- (The sender name "Vadim" on gift emails is set in server/notifications.js, not here.) Safe to run more than once.

create or replace function public.plan_gift_messages(p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_made integer := 0;
begin
  for v in select * from public.gift_vouchers g where g.status = 'ready' and g.delivery = 'email' and g.recipient_sent_at is null
             and g.send_at <= p_now and g.expires_at > p_now for update skip locked loop
    perform public.gift_notify(v, 'arrived', null, null, v.recipient_email,
      format('%s, %s has sent you a gift 🎁', btrim(v.recipient_name), v.from_name),
      format('Hi %s,', v.recipient_name) || E'\n\n' || format('%s has sent you a gift. Open it here:', v.from_name) || E'\n{link}',
      public.gift_link_path(v.code) || '?open=1', 'gift.arrived:' || v.id::text);
    update public.gift_vouchers g set recipient_sent_at = p_now where g.id = v.id;
    v_made := v_made + 1;
  end loop;
  for v in select * from public.gift_vouchers g where g.status = 'ready' and g.reminder_sent_at is null
             and g.expires_at > p_now and g.expires_at <= p_now + interval '30 days' and g.paid_at < p_now - interval '60 days'
             for update skip locked loop
    perform public.gift_notify(v, 'reminder', null, null, coalesce(v.recipient_email, v.buyer_email),
      'Your massage gift voucher ends soon',
      format('Hi %s,', case when v.recipient_email is not null then v.recipient_name else split_part(btrim(v.buyer_name), ' ', 1) end) || E'\n\n'
        || format('A friendly reminder: the gift voucher for %s (%s, from %s) can be used until %s. Choose a day here:',
             v.recipient_name, public.gift_words(v.minutes, v.people), v.from_name, public.gift_london_date(v.expires_at)) || E'\n{link}',
      public.gift_link_path(v.code), 'gift.reminder:' || v.id::text);
    update public.gift_vouchers g set reminder_sent_at = p_now where g.id = v.id;
    v_made := v_made + 1;
  end loop;
  return v_made;
end; $$;
revoke all on function public.plan_gift_messages(timestamptz) from public, anon, authenticated;
grant execute on function public.plan_gift_messages(timestamptz) to service_role;

create or replace function public.gift_notify(p_voucher public.gift_vouchers, p_kind text, p_admin_title text, p_admin_body text,
  p_client_email text, p_client_title text, p_client_body text, p_client_link text, p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_event uuid; v_body text := p_client_body;
begin
  insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
  values ('gift.' || p_kind, 'gift_voucher', p_voucher.id, coalesce(p_dedupe, 'gift.' || p_kind || ':' || p_voucher.id::text || ':' || clock_timestamp()::text),
          jsonb_build_object('gift_voucher_id', p_voucher.id))
  on conflict (deduplication_key) do nothing
  returning id into v_event;
  if v_event is null then return null; end if;
  if p_admin_title is not null then
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
    values (v_event, 'in_app', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts', 'sent', clock_timestamp());
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'telegram', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts'),
           (v_event, 'email', 'admin', 'admin', p_admin_title, p_admin_body, '/admin/gifts');
  end if;
  if p_client_title is not null and nullif(btrim(coalesce(p_client_email, '')), '') is not null then
    if p_kind in ('bought', 'ready', 'refund_requested', 'refund_sent') and lower(btrim(p_client_email)) = lower(coalesce(p_voucher.buyer_email, '')) then
      v_body := v_body || E'\n\n' || case p_kind
        when 'bought' then 'Your gift page, to say you''ve paid or to cancel: '
        when 'ready' then 'Your receipt and your gift page: '
        else 'Your gift page: ' end || '{site}/gift?t=' || p_voucher.buyer_token::text;
    end if;
    -- An emailed voucher: the buyer is told where it may land, so they can tell the person (Gmail often files gifts under Promotions).
    if p_kind in ('bought', 'ready') and p_voucher.delivery = 'email' and lower(btrim(p_client_email)) = lower(coalesce(p_voucher.buyer_email, '')) then
      v_body := v_body || E'\n\n' || format('The voucher is emailed to %s from Vadim. Some inboxes put gifts in Promotions or Junk, so if they can''t see it, tell them to look there.',
        btrim(p_voucher.recipient_name));
    end if;
    insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path)
    values (v_event, 'email', 'client', btrim(p_client_email), p_client_title, v_body || E'\n\nWarm wishes,\nVadim', p_client_link);
  end if;
  return v_event;
end; $$;
revoke all on function public.gift_notify(public.gift_vouchers, text, text, text, text, text, text, text, text) from public, anon, authenticated;
