-- Narrow Admin payment commands. Never deploy/apply to hosted Supabase without review.
-- Existing client SECURITY DEFINER commands remain the only client write path.
-- Remove the former direct Admin write shortcut for these two authoritative tables.
-- Default Supabase privileges also include TRUNCATE, which is not protected by RLS.
revoke insert, update, delete, truncate on public.bookings, public.booking_payments from authenticated;

create function public.admin_verify_bank_transfer(
  p_booking_id uuid, p_request_id uuid,
  p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_verify_bank_transfer', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or not (b.booking_status = 'awaiting_payment_verification' and p.method = 'bank_transfer' and p.status = 'awaiting_verification') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_verify_bank_transfer',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='confirmed', payment_reservation_expires_at=null where id=b.id;
  update public.booking_payments set status='paid', verified_at=v_now, verified_by=auth.uid(), paid_at=v_now where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.bank_transfer_verified','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $$;
revoke all on function public.admin_verify_bank_transfer(uuid,uuid,timestamptz,timestamptz) from public, anon;
grant execute on function public.admin_verify_bank_transfer(uuid,uuid,timestamptz,timestamptz) to authenticated;

create function public.admin_approve_cash_request(
  p_booking_id uuid, p_request_id uuid,
  p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_approve_cash_request', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or not (b.booking_status = 'awaiting_cash_approval' and p.method = 'cash' and p.status = 'awaiting_approval') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_approve_cash_request',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='confirmed', payment_reservation_expires_at=null where id=b.id;
  update public.booking_payments set status='approved' where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.cash_approved','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $$;
revoke all on function public.admin_approve_cash_request(uuid,uuid,timestamptz,timestamptz) from public, anon;
grant execute on function public.admin_approve_cash_request(uuid,uuid,timestamptz,timestamptz) to authenticated;

create function public.admin_reject_cash_request(
  p_booking_id uuid, p_request_id uuid,
  p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_reject_cash_request', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or not (b.booking_status = 'awaiting_cash_approval' and p.method = 'cash' and p.status = 'awaiting_approval') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_reject_cash_request',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.bookings set booking_status='cancelled', cancelled_at=v_now, cancelled_by_actor_type='admin', cancelled_by_actor_id=auth.uid()::text, payment_reservation_expires_at=null where id=b.id;
  update public.booking_payments set status='rejected' where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.cash_rejected','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $$;
revoke all on function public.admin_reject_cash_request(uuid,uuid,timestamptz,timestamptz) from public, anon;
grant execute on function public.admin_reject_cash_request(uuid,uuid,timestamptz,timestamptz) to authenticated;

create function public.admin_record_payment_received(
  p_booking_id uuid, p_request_id uuid,
  p_booking_updated_at timestamptz, p_payment_updated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings%rowtype;
  p public.booking_payments%rowtype;
  c public.command_requests%rowtype;
  v_date date;
  v_now timestamptz := clock_timestamp();
  v_scope text := 'admin-payment:' || auth.uid()::text;
  v_fingerprint text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_booking_id is null or p_request_id is null or p_booking_updated_at is null or p_payment_updated_at is null then
    raise exception 'Missing command arguments' using errcode='22023';
  end if;
  v_fingerprint := md5(concat_ws('|', 'admin_record_payment_received', p_booking_id::text,
    extract(epoch from p_booking_updated_at)::text, extract(epoch from p_payment_updated_at)::text));
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into c from public.command_requests
    where scope=v_scope and idempotency_key=p_request_id::text for update;
  if found then
    if c.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode='22023';
    end if;
    if c.status='succeeded' then return c.result_reference::uuid; end if;
    raise exception 'Command in progress' using errcode='PT409';
  end if;

  select date into v_date from public.bookings where id=p_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002'; end if;
  -- Same date-before-booking-before-payment lock order as client payment commands.
  perform pg_advisory_xact_lock(42420, hashtext(v_date::text));
  select * into b from public.bookings where id=p_booking_id for update;
  select * into p from public.booking_payments where booking_id=p_booking_id for update;
  if b.id is null or p.id is null or b.date is distinct from v_date
     or b.updated_at is distinct from p_booking_updated_at
     or p.updated_at is distinct from p_payment_updated_at
     or not (b.booking_status in ('confirmed','completed') and p.method = 'cash' and p.status = 'approved') then
    raise exception 'Booking state changed' using errcode='PT409';
  end if;
  if p.amount_gbp is distinct from b.total_gbp then
    raise exception 'Payment amount needs review' using errcode='22023';
  end if;
  insert into public.command_requests(scope,idempotency_key,source_channel,actor_type,actor_id,
    command_type,request_fingerprint,status,result_reference,completed_at)
  values(v_scope,p_request_id::text,'admin','admin',auth.uid()::text,'admin_record_payment_received',
    v_fingerprint,'succeeded',b.id::text,v_now) returning * into c;
  update public.booking_payments set status='paid', paid_at=v_now where id=p.id;
  insert into public.event_outbox(event_type,aggregate_type,aggregate_id,source_command_id,deduplication_key,payload)
  select 'booking.cash_received','booking',b.id,c.id,'admin-payment:' || c.id::text,
    jsonb_build_object('booking_id',b.id,'actor_id',auth.uid(),'payment_id',p.id,
      'previous_booking_status',b.booking_status,'previous_payment_status',p.status,
      'booking_status',nb.booking_status,'payment_status',np.status,'amount_gbp',np.amount_gbp)
  from public.bookings nb join public.booking_payments np on np.booking_id=nb.id where nb.id=b.id;
  return b.id;
end; $$;
revoke all on function public.admin_record_payment_received(uuid,uuid,timestamptz,timestamptz) from public, anon;
grant execute on function public.admin_record_payment_received(uuid,uuid,timestamptz,timestamptz) to authenticated;

-- Queue intentionally excludes approved cash: receipt is a separate detail action.
-- Return at most 51 rows (50 + next-page sentinel), never all history.
create function public.admin_payment_review_queue(p_offset integer default 0)
returns setof public.bookings language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
     or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode='42501';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 10000 then
    raise exception 'Invalid page' using errcode='22023';
  end if;
  return query select b.* from public.bookings b
  join public.booking_payments p on p.booking_id=b.id
  where (b.booking_status='awaiting_payment_verification' and p.method='bank_transfer' and p.status='awaiting_verification')
     or (b.booking_status='awaiting_cash_approval' and p.method='cash' and p.status='awaiting_approval')
  order by b.date, b.start_minutes, b.id offset p_offset limit 51;
end; $$;
revoke all on function public.admin_payment_review_queue(integer) from public, anon;
grant execute on function public.admin_payment_review_queue(integer) to authenticated;
