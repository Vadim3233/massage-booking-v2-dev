begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_temp;

select plan(19);

select set_config(
  'test.finalize_date1',
  ((now() at time zone 'Europe/London')::date + 10)::text,
  true
);
select set_config(
  'test.finalize_date2',
  ((now() at time zone 'Europe/London')::date + 11)::text,
  true
);

-- Catalogue fixtures.
insert into public.services (id, slug, name, active, display_order)
values (
  '00000000-0000-0000-0000-000000004001',
  'quote-finalize-test-service',
  'Quote Finalize Test Service',
  true,
  990
);

insert into public.service_duration_prices (
  service_id, duration_minutes, price_gbp, active
)
values
  ('00000000-0000-0000-0000-000000004001', 60, 85, true),
  ('00000000-0000-0000-0000-000000004001', 90, 115, true),
  ('00000000-0000-0000-0000-000000004001', 120, 160, true);

insert into public.service_areas (
  id, slug, name, active, travel_surcharge_gbp, congestion_fee_gbp, display_order
)
values (
  '00000000-0000-0000-0000-000000004101',
  'quote-finalize-test-area',
  'Quote Finalize Test Area',
  true,
  12,
  8,
  990
);

insert into public.enhancements (
  id, slug, name, price_gbp, duration_minutes, active, display_order
)
values (
  '00000000-0000-0000-0000-000000004201',
  'quote-finalize-test-enhancement',
  'Quote Finalize Test Enhancement',
  10,
  15,
  true,
  990
);

insert into public.session_preferences (
  id, slug, label, category, active, display_order
)
values (
  '00000000-0000-0000-0000-000000004301',
  'quote-finalize-test-preference',
  'More neck',
  'Focus area',
  true,
  990
);

-- Future scheduling fixture.
delete from public.working_hours_overrides
where date in (
  current_setting('test.finalize_date1')::date,
  current_setting('test.finalize_date2')::date
);

insert into public.working_hours_overrides (
  date, available, start_minutes, end_minutes, start_mode, fixed_start_minutes
)
values
  (current_setting('test.finalize_date1')::date, true, 600, 1200, 'flexible', null),
  (current_setting('test.finalize_date2')::date, true, 600, 1200, 'flexible', null);

-- Auth/client fixture.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000004401',
  'authenticated',
  'authenticated',
  'finalize-client@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into public.clients (
  id, auth_user_id, first_name, last_name, email, phone
)
values (
  '00000000-0000-0000-0000-000000004501',
  '00000000-0000-0000-0000-000000004401',
  'Finalize',
  'Client',
  'finalize-client@example.test',
  '+44 7700 900555'
);

-- 1-4: public quote is server-authoritative and V1-compatible.
set local role anon;

select is(
  (
    select q.service_subtotal_gbp
    from public.quote_client_booking(
      '00000000-0000-0000-0000-000000004101',
      '[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60},{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":90}]'::jsonb,
      array['00000000-0000-0000-0000-000000004201'::uuid]
    ) q
  ),
  200.00::numeric,
  'quote sums configured session prices rather than browser totals'
);

select is(
  (
    select q.treatment_duration_minutes
    from public.quote_client_booking(
      '00000000-0000-0000-0000-000000004101',
      '[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60},{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":90}]'::jsonb,
      array['00000000-0000-0000-0000-000000004201'::uuid]
    ) q
  ),
  150,
  'public enhancement does not change reserved treatment duration'
);

select is(
  (
    select q.enhancements_total_gbp
    from public.quote_client_booking(
      '00000000-0000-0000-0000-000000004101',
      '[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60}]'::jsonb,
      array['00000000-0000-0000-0000-000000004201'::uuid]
    ) q
  ),
  10.00::numeric,
  'quote prices an appointment enhancement once'
);

select is(
  (
    select q.total_gbp
    from public.quote_client_booking(
      '00000000-0000-0000-0000-000000004101',
      '[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60}]'::jsonb,
      array['00000000-0000-0000-0000-000000004201'::uuid]
    ) q
  ),
  115.00::numeric,
  'quote includes service, enhancement, travel and congestion fees'
);

reset role;

-- Create a pre-auth 60-minute hold.
set local role anon;
select lives_ok(
  $$select * from public.create_booking_hold(
    current_setting('test.finalize_date1')::date,
    600,
    60,
    'finalize-hold-client-key-0000001'
  )$$,
  'pre-auth hold exists before finalization'
);
reset role;

-- Capture hold proof privately.
do $capture$
begin
  perform set_config(
    'test.finalize_hold_id',
    (
      select h.id::text
      from public.booking_holds h
      where h.client_key = 'finalize-hold-client-key-0000001'
        and h.status = 'active'
      limit 1
    ),
    true
  );
  perform set_config(
    'test.finalize_hold_token',
    (
      select h.hold_token::text
      from public.booking_holds h
      where h.client_key = 'finalize-hold-client-key-0000001'
        and h.status = 'active'
      limit 1
    ),
    true
  );
end;
$capture$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004401',
  true
);
set local role authenticated;

-- 6. Atomic bank-transfer finalization succeeds.
select lives_ok(
  format(
    $sql$select * from public.finalize_client_booking(
      %L::uuid,
      %L::uuid,
      %L,
      %L::uuid,
      %L::jsonb,
      %L::uuid[],
      null,
      %L,
      null,
      %L,
      %L,
      %L,
      %L,
      %L,
      %L
    )$sql$,
    current_setting('test.finalize_hold_id'),
    current_setting('test.finalize_hold_token'),
    'finalize-hold-client-key-0000001',
    '00000000-0000-0000-0000-000000004101',
    '[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60,"recipient_name":"Guest 1","preference_ids":["00000000-0000-0000-0000-000000004301"]}]',
    '{00000000-0000-0000-0000-000000004201}',
    '10 Test Street',
    'London',
    'SW1A 1AA',
    'Ring bell 2',
    'Please focus on shoulders',
    'bank_transfer',
    'finalize-test-key-0001'
  ),
  'authenticated client can atomically finalize the held booking'
);

reset role;

-- 7. Booking uses server-calculated amount, not any browser amount.
select is(
  (
    select b.total_gbp
    from public.bookings b
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
  ),
  115.00::numeric,
  'finalized booking stores the authoritative server total'
);

-- 8. 60-minute session remains a separate session row.
select is(
  (
    select count(*)::integer
    from public.booking_sessions bs
    join public.bookings b on b.id = bs.booking_id
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
      and bs.duration_minutes = 60
  ),
  1,
  'finalization creates the explicit session row'
);

-- 9. Session preference snapshot is stored.
select is(
  (
    select count(*)::integer
    from public.booking_session_preferences bsp
    join public.booking_sessions bs on bs.id = bsp.booking_session_id
    join public.bookings b on b.id = bs.booking_id
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
      and bsp.preference_label_snapshot = 'More neck'
  ),
  1,
  'finalization snapshots selected session preferences'
);

-- 10. Appointment enhancement is stored once at booking level.
select is(
  (
    select count(*)::integer
    from public.booking_enhancements be
    join public.bookings b on b.id = be.booking_id
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
      and be.enhancement_id = '00000000-0000-0000-0000-000000004201'
  ),
  1,
  'finalization snapshots the appointment enhancement once'
);

-- 11. Bank transfer is awaiting verification and not falsely paid.
select is(
  (
    select bp.status
    from public.booking_payments bp
    join public.bookings b on b.id = bp.booking_id
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
  ),
  'awaiting_verification',
  'bank transfer remains awaiting Admin verification'
);

-- 12. Booking state matches bank-transfer review state.
select is(
  (
    select b.booking_status
    from public.bookings b
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
  ),
  'awaiting_payment_verification',
  'bank-transfer booking remains awaiting payment verification'
);

-- 13. Hold is consumed in the same committed transaction.
select is(
  (
    select h.status
    from public.booking_holds h
    where h.id = current_setting('test.finalize_hold_id')::uuid
  ),
  'consumed',
  'successful finalization consumes the hold'
);

-- 14. New address is saved and snapshotted.
select is(
  (
    select b.postcode_snapshot
    from public.bookings b
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
  ),
  'SW1A 1AA',
  'booking stores an immutable address snapshot'
);

-- 15. Outbox event comes from committed booking state.
select is(
  (
    select count(*)::integer
    from public.event_outbox eo
    join public.bookings b on b.id = eo.aggregate_id
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
      and eo.event_type = 'booking.created'
      and eo.delivery_status = 'pending'
  ),
  1,
  'finalization creates one committed booking outbox event'
);

-- 16. Idempotent retry returns the existing booking and creates no duplicate.
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004401',
  true
);
set local role authenticated;

select lives_ok(
  format(
    $sql$select * from public.finalize_client_booking(
      %L::uuid,
      %L::uuid,
      %L,
      %L::uuid,
      %L::jsonb,
      %L::uuid[],
      null,
      %L,
      null,
      %L,
      %L,
      %L,
      %L,
      %L,
      %L
    )$sql$,
    current_setting('test.finalize_hold_id'),
    current_setting('test.finalize_hold_token'),
    'finalize-hold-client-key-0000001',
    '00000000-0000-0000-0000-000000004101',
    '[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60,"recipient_name":"Guest 1","preference_ids":["00000000-0000-0000-0000-000000004301"]}]',
    '{00000000-0000-0000-0000-000000004201}',
    '10 Test Street',
    'London',
    'SW1A 1AA',
    'Ring bell 2',
    'Please focus on shoulders',
    'bank_transfer',
    'finalize-test-key-0001'
  ),
  'idempotent retry succeeds without needing an active hold again'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.bookings b
    where b.client_id = '00000000-0000-0000-0000-000000004501'
      and b.date = current_setting('test.finalize_date1')::date
  ),
  1,
  'idempotent retry creates no duplicate booking'
);

-- 18. First-time client cannot create a second active future reservation.
set local role anon;
select lives_ok(
  $$select * from public.create_booking_hold(
    current_setting('test.finalize_date2')::date,
    600,
    60,
    'finalize-hold-client-key-0000002'
  )$$,
  'second pre-auth hold may exist before client booking-limit validation'
);
reset role;

do $capture2$
begin
  perform set_config(
    'test.finalize_hold2_id',
    (
      select h.id::text
      from public.booking_holds h
      where h.client_key = 'finalize-hold-client-key-0000002'
        and h.status = 'active'
      limit 1
    ),
    true
  );
  perform set_config(
    'test.finalize_hold2_token',
    (
      select h.hold_token::text
      from public.booking_holds h
      where h.client_key = 'finalize-hold-client-key-0000002'
        and h.status = 'active'
      limit 1
    ),
    true
  );
end;
$capture2$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000004401',
  true
);
set local role authenticated;

select throws_ok(
  format(
    $sql$select * from public.finalize_client_booking(
      %L::uuid,
      %L::uuid,
      %L,
      %L::uuid,
      %L::jsonb,
      %L::uuid[],
      null,
      %L,
      null,
      %L,
      %L,
      null,
      null,
      %L,
      %L
    )$sql$,
    current_setting('test.finalize_hold2_id'),
    current_setting('test.finalize_hold2_token'),
    'finalize-hold-client-key-0000002',
    '00000000-0000-0000-0000-000000004101',
    '[{"service_id":"00000000-0000-0000-0000-000000004001","duration_minutes":60}]',
    '{}',
    '10 Test Street',
    'London',
    'SW1A 1AA',
    'bank_transfer',
    'finalize-test-key-0002'
  ),
  '22023',
  'Your first appointment is already reserved. Once it has been completed and paid, you''ll be able to arrange future appointments more freely.',
  'first-time client cannot add a second active future appointment'
);

reset role;

select * from finish();
rollback;
