-- Gift vouchers: the buyer can cancel, or ask for their money back, from their own gift page (Vadim, 15 Nov 2026).
--
-- In plain words:
--   1. Before paying ("One last step"), the buyer can cancel the gift. If they have not said they made the transfer, it is cancelled at once.
--      If they have, it is cancelled and a refund is owed in case the money arrives.
--   2. After paying, within 14 days of buying and while the voucher is unused (the terms they ticked), the buyer can ask for their money back.
--      The code stops working straight away, so nobody can book with it while the refund is on its way.
--   3. Vadim gets an alert (app, Telegram, email) naming the amount and the reference. The voucher shows "Refund to send" in More › Gift vouchers
--      until he presses "Refund sent", which emails the buyer.
--   4. After 14 days, or once used, the page explains why and offers to message Vadim.
--
-- Safe to run again: columns are "if not exists" and every function is create or replace.
-- Undo: drop gift_buyer_cancel and admin_gift_refund_sent, put back get_my_gift_purchase (20261214100000) and admin_gift_vouchers
-- (20261215100000), and drop the two columns.

alter table public.gift_vouchers add column if not exists refund_requested_at timestamptz;
alter table public.gift_vouchers add column if not exists refunded_at timestamptz;

-- The buyer's own page: what they bought and, once paid, its code; now also whether they can still cancel or ask for a refund.
create or replace function public.get_my_gift_purchase(p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', g.status, 'reference', g.payment_reference, 'amount', g.price_gbp, 'recipient_name', g.recipient_name,
    'minutes', g.minutes, 'people', g.people, 'transfer_declared', g.transfer_declared_at is not null, 'delivery', g.delivery,
    'recipient_email', g.recipient_email, 'send_at', g.send_at,
    'code', case when g.status in ('ready', 'used') then public.gift_code_shown(g.code) end,
    'bank', case when g.status = 'awaiting_payment' then (select value from public.business_settings where key = 'bank_details') end,
    'refund_until', g.created_at + interval '14 days',
    'can_refund', g.status = 'ready' and g.created_at + interval '14 days' > clock_timestamp(),
    'refund_requested', g.refund_requested_at is not null,
    'refunded', g.refunded_at is not null)
  from public.gift_vouchers g where g.buyer_token = p_token;
$$;

-- "Cancel this gift" / "Ask for a refund" on the buyer's page.
create or replace function public.gift_buyer_cancel(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype; v_now timestamptz := clock_timestamp(); v_refund boolean;
begin
  select * into v from public.gift_vouchers g where g.buyer_token = p_token for update;
  if not found then raise exception 'That link doesn''t work. Please message Vadim.' using errcode = 'PT404'; end if;
  if v.status = 'cancelled' then return public.get_my_gift_purchase(p_token); end if;
  if v.status = 'used' then
    raise exception 'This voucher has already been used, so it can''t be refunded.' using errcode = 'PT409';
  end if;
  if v.status = 'ready' and v.created_at + interval '14 days' <= v_now then
    raise exception 'Refunds are possible within 14 days of buying, and that time has passed. Please message Vadim if something has gone wrong.' using errcode = 'PT409';
  end if;

  -- Money may be on its way (they said they sent it) or has arrived (paid): a refund is owed.
  v_refund := v.status = 'ready' or v.transfer_declared_at is not null;
  update public.gift_vouchers g set status = 'cancelled', refund_requested_at = case when v_refund then v_now end
  where g.id = v.id returning * into v;

  if v_refund then
    perform public.gift_notify(v, 'refund_requested',
      format('%s asked for a gift voucher refund', v.buyer_name),
      format('%s, reference %s, for %s.', public.notification_money(v.price_gbp), v.payment_reference, v.recipient_name)
        || case when v.paid_at is null then ' You had not marked it paid yet: if the money arrives, send it back.' else '' end
        || ' The code no longer works. Send the money back to the account it came from, then press Refund sent in More › Gift vouchers.',
      v.buyer_email, 'Your gift voucher is cancelled',
      format('Hi %s,', split_part(btrim(v.buyer_name), ' ', 1)) || E'\n\n'
        || format('Your gift voucher for %s is cancelled, as you asked. ', v.recipient_name)
        || case when v.paid_at is null
             then format('If your transfer of %s has already left your account, I''ll send it back to the account it came from as soon as it arrives.', public.notification_money(v.price_gbp))
             else format('I''ll send your %s back to the account it came from within 3 working days, and email you when it''s on its way.', public.notification_money(v.price_gbp)) end,
      null, 'gift.refund_requested:' || v.id::text);
  else
    perform public.gift_notify(v, 'buyer_cancelled',
      format('%s cancelled a gift voucher before paying', v.buyer_name),
      format('%s, reference %s, for %s. Nothing to do, unless that money arrives after all.', public.notification_money(v.price_gbp), v.payment_reference, v.recipient_name),
      null, null, null, null, 'gift.buyer_cancelled:' || v.id::text);
  end if;
  return public.get_my_gift_purchase(p_token);
end; $$;

-- "Refund sent" in More › Gift vouchers: the buyer is emailed. For a gift cancelled before Vadim saw the money, "The money never came"
-- (p_money_came false) just clears it, with no email.
create or replace function public.admin_gift_refund_sent(p_voucher_id uuid, p_money_came boolean default true)
returns public.gift_vouchers language plpgsql security definer set search_path = '' as $$
declare v public.gift_vouchers%rowtype;
begin
  perform public.require_booking_admin();
  update public.gift_vouchers g set refunded_at = clock_timestamp()
  where g.id = p_voucher_id and g.status = 'cancelled' and g.refund_requested_at is not null and g.refunded_at is null returning * into v;
  if not found then raise exception 'That refund has already been recorded.' using errcode = 'PT409'; end if;
  if not p_money_came then return v; end if;
  perform public.gift_notify(v, 'refund_sent', null, null, v.buyer_email, 'Your gift voucher refund is on its way',
    format('Hi %s,', split_part(btrim(v.buyer_name), ' ', 1)) || E'\n\n'
      || format('I''ve sent your %s back to the account it came from (reference %s). It usually arrives within a few hours.', public.notification_money(v.price_gbp), v.payment_reference),
    null, 'gift.refund_sent:' || v.id::text);
  return v;
end; $$;

-- More › Gift vouchers: a voucher with a refund still to send stays in the list until it is sent.
create or replace function public.admin_gift_vouchers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_booking_admin();
  return coalesce((select jsonb_agg(to_jsonb(g) - 'buyer_token' || jsonb_build_object(
      'code_shown', public.gift_code_shown(g.code),
      'expired', g.status = 'ready' and g.expires_at <= clock_timestamp(),
      'refund_to_send', g.refund_requested_at is not null and g.refunded_at is null,
      'booking', (select jsonb_build_object('id', b.id, 'date', b.date, 'start_minutes', b.start_minutes, 'status', b.booking_status,
                    'client_name', btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')))
                  from public.bookings b left join public.clients c on c.id = b.client_id where b.id = g.booking_id))
    order by case when g.refund_requested_at is not null and g.refunded_at is null then -1
                  else case g.status when 'awaiting_payment' then 0 when 'ready' then 1 when 'used' then 2 else 3 end end, g.created_at desc)
    from public.gift_vouchers g
    where g.status <> 'cancelled' or g.updated_at > clock_timestamp() - interval '30 days'
       or (g.refund_requested_at is not null and g.refunded_at is null)), '[]'::jsonb);
end; $$;

revoke all on function public.gift_buyer_cancel(uuid), public.admin_gift_refund_sent(uuid, boolean) from public;
grant execute on function public.gift_buyer_cancel(uuid) to anon, authenticated;
revoke all on function public.admin_gift_refund_sent(uuid, boolean) from anon;
grant execute on function public.admin_gift_refund_sent(uuid, boolean) to authenticated;
