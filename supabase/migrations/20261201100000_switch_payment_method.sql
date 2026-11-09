-- Change how a confirmed booking is paid: bank transfer to cash, or cash to bank transfer.
--
-- A client can pick the wrong way to pay (or change their mind at the door). Vadim can now switch it on the booking:
--   * not paid yet: bank transfer (waiting for the transfer, or the client said it was sent) becomes cash agreed for the appointment
--     ("approved"), and cash agreed becomes a bank transfer still to come ("awaiting_transfer"), as "Confirm, pay later" leaves it;
--   * already paid: it stays paid, only the method changes, and the receipt (if one was made) is corrected to match, keeping the old
--     wording as a revision, as an edit of the receipt does.
-- Only confirmed or completed bookings, and never a payment that was rejected or refunded. No message goes to the client.
--
-- The payment status guard only knew the moves of one method. It now also allows, when the method itself changes,
-- awaiting_transfer / awaiting_verification -> approved and approved -> awaiting_transfer. Nothing else changes for it.

create or replace function public.guard_booking_payment_status_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'awaiting_transfer'
      and new.status in ('awaiting_verification', 'awaiting_approval', 'paid', 'rejected'))
    or (old.status = 'awaiting_verification'
      and new.status in ('paid', 'rejected'))
    or (old.status = 'awaiting_approval'
      and new.status in ('approved', 'rejected'))
    or (old.status = 'approved'
      and new.status in ('paid', 'rejected'))
    or (old.status = 'paid'
      and new.status = 'refunded')
    -- Switching the method of an unpaid, confirmed booking (admin_switch_payment_method).
    or (new.method is distinct from old.method and old.method = 'bank_transfer' and new.method = 'cash'
      and old.status in ('awaiting_transfer', 'awaiting_verification') and new.status = 'approved')
    or (new.method is distinct from old.method and old.method = 'cash' and new.method = 'bank_transfer'
      and old.status = 'approved' and new.status = 'awaiting_transfer')
  ) then
    raise exception 'Payment status change not allowed: % to %', old.status, new.status
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create function public.admin_switch_payment_method(p_booking_id uuid, p_request_id uuid, p_booking_updated_at timestamptz,
  p_payment_updated_at timestamptz, p_method text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; p public.booking_payments%rowtype; c public.command_requests%rowtype; r public.booking_receipts%rowtype;
  v_date date; v_now timestamptz; v_scope text:='admin-payment:' || auth.uid()::text; v_fingerprint text; v_status text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null
    or p_method is null or p_method not in ('cash','bank_transfer') then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint:=md5(concat_ws('|','admin_switch_payment_method',p_booking_id::text,extract(epoch from p_booking_updated_at)::text,
    extract(epoch from p_payment_updated_at)::text,p_method));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests cr where cr.scope=v_scope and cr.idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then raise exception 'Request key reused' using errcode='22023'; end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;
  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as the other payment commands.
  perform pg_advisory_xact_lock(42420,hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date or b.updated_at is distinct from p_booking_updated_at
    or p.updated_at is distinct from p_payment_updated_at or b.booking_status not in ('confirmed','completed')
    or p.method = p_method
    or not ((p_method='cash' and p.status in ('awaiting_transfer','awaiting_verification','paid'))
         or (p_method='bank_transfer' and p.status in ('approved','paid'))) then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  v_status:=case when p.status='paid' then 'paid' when p_method='cash' then 'approved' else 'awaiting_transfer' end;
  v_now:=clock_timestamp();
  update public.booking_payments set method=p_method, status=v_status,
    -- A transfer the client said they sent is not part of a cash payment; a bank transfer needs a reference to quote.
    transfer_declared_at=case when p_method='cash' then null else transfer_declared_at end,
    payment_reference=coalesce(payment_reference, b.booking_reference)
  where id=p.id;
  -- A paid booking's receipt says how it was paid, so it is corrected too, keeping what it said before.
  select * into r from public.booking_receipts x where x.booking_id=b.id for update;
  if found and r.snapshot ? 'payment' then
    insert into public.booking_receipt_revisions(receipt_id, revision, snapshot, edited_by) values (r.id, r.edit_count + 1, r.snapshot, auth.uid());
    update public.booking_receipts set snapshot=jsonb_set(r.snapshot,'{payment,method}',to_jsonb(p_method)),
      edited_at=v_now, edited_by=auth.uid(), edit_count=r.edit_count + 1 where id=r.id;
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,command_type,request_fingerprint,status,result_reference,completed_at)
    values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_switch_payment_method',v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
    values('booking.payment_method_changed','booking',b.id,c.id,'admin-payment:' || c.id::text,
      jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,'previous_method',p.method,'method',p_method,
        'previous_payment_status',p.status,'payment_status',v_status,'booking_status',b.booking_status,'amount_gbp',p.amount_gbp));
  return b.id;
end; $$;
revoke all on function public.admin_switch_payment_method(uuid,uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.admin_switch_payment_method(uuid,uuid,timestamptz,timestamptz,text) to authenticated;
