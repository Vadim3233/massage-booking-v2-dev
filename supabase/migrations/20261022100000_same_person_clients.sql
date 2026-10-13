-- VAD Massage Booking V2
-- "Is this the same person?": the Admin decides when two client profiles belong to one person.
--
-- Why: someone who booked once as a guest and later registers with the same email used to be turned away with
-- "This email is already linked to another client account". A guest's email is never trusted (nobody has proved the
-- address is theirs), so the two profiles must stay apart until a person decides. Instead of guessing, the database
-- now notices profiles that share an email or a phone number and tells the Admin; she sees the two side by side and
-- combines them only when she says so. Nothing is ever combined automatically.
--
-- What combining does: the bookings, notes, addresses, repeat bookings and waitlist requests of one profile move to the
-- other, which keeps its login. The profile that goes is saved whole in client_merges, so a mistake can be put right by
-- hand. Two profiles that each have their own login can never be combined.
--
-- Also here: a profile that shares an email or phone with another can be corrected again (admin_update_client now checks
-- only a value that is being changed), because the people she says are "different" will often share one.

-- ---------------------------------------------------------------------------------------------
-- 1. Registering is never blocked by a guest's profile
--
-- Only a different real login on the same email still blocks (as before). A profile that belongs to a guest session does
-- not: the registration gets its own profile and the pair is flagged for the Admin (section 4).
-- ---------------------------------------------------------------------------------------------
create or replace function public.activate_my_client_account(
  p_first_name text default null,
  p_last_name text default null,
  p_phone text default null
)
returns table (
  client_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  online_booking_enabled boolean,
  created_new_client boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_auth_email text;
  v_first_name text := nullif(btrim(p_first_name), '');
  v_last_name text := nullif(btrim(p_last_name), '');
  v_phone text := nullif(btrim(p_phone), '');
  v_client public.clients%rowtype;
  v_candidate_id uuid;
  v_candidate_count integer;
  v_created boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if public.is_booking_admin() then
    raise exception 'Admin accounts cannot be activated as client accounts'
      using errcode = '42501';
  end if;

  select lower(btrim(u.email))
  into v_auth_email
  from auth.users u
  where u.id = v_user_id
    and u.email_confirmed_at is not null
    and nullif(btrim(u.email), '') is not null;

  if v_auth_email is null then
    raise exception 'A confirmed email address is required'
      using errcode = '42501';
  end if;

  -- Serialize account activation both by Auth user and confirmed email.
  perform pg_advisory_xact_lock(
    hashtext('client-auth-user:' || v_user_id::text)
  );
  perform pg_advisory_xact_lock(
    hashtext('client-auth-email:' || v_auth_email)
  );

  -- Repeated activation is idempotent for an already-linked canonical client.
  select c.*
  into v_client
  from public.clients c
  where c.auth_user_id = v_user_id
  for update;

  if found then
    update public.clients c
    set
      first_name = coalesce(v_first_name, c.first_name),
      last_name = coalesce(v_last_name, c.last_name),
      email = v_auth_email,
      phone = coalesce(v_phone, c.phone)
    where c.id = v_client.id
    returning c.* into v_client;

    client_id := v_client.id;
    first_name := v_client.first_name;
    last_name := v_client.last_name;
    email := v_client.email;
    phone := v_client.phone;
    online_booking_enabled := v_client.online_booking_enabled;
    created_new_client := false;
    return next;
    return;
  end if;

  -- A confirmed email cannot silently take over a client already linked to a different login. A guest's profile does
  -- not count: nobody proved the email was theirs, so it is neither taken over nor a reason to turn the registration
  -- away. The Admin is asked about the pair instead.
  if exists (
    select 1
    from public.clients c
    join auth.users owner on owner.id = c.auth_user_id
    where c.normalized_email = v_auth_email
      and c.auth_user_id <> v_user_id
      and not coalesce(owner.is_anonymous, false)
  ) then
    raise exception 'This email is already linked to another client account'
      using errcode = '23505';
  end if;

  select count(*)::integer
  into v_candidate_count
  from public.clients c
  where c.normalized_email = v_auth_email
    and c.auth_user_id is null;

  if v_candidate_count > 1 then
    raise exception 'Multiple client records use this email. Please contact Vad to link the correct account.'
      using errcode = 'P0001';
  end if;

  if v_candidate_count = 1 then
    select c.id
    into v_candidate_id
    from public.clients c
    where c.normalized_email = v_auth_email
      and c.auth_user_id is null
    limit 1;

    update public.clients c
    set
      auth_user_id = v_user_id,
      first_name = coalesce(v_first_name, c.first_name),
      last_name = coalesce(v_last_name, c.last_name),
      email = v_auth_email,
      phone = coalesce(v_phone, c.phone)
    where c.id = v_candidate_id
      and c.auth_user_id is null
    returning c.* into v_client;

    if not found then
      raise exception 'Client account linking changed while activation was in progress'
        using errcode = '40001';
    end if;
  else
    if v_first_name is null then
      raise exception 'First name is required for a new client account'
        using errcode = '22023';
    end if;

    insert into public.clients (
      auth_user_id,
      first_name,
      last_name,
      email,
      phone
    )
    values (
      v_user_id,
      v_first_name,
      coalesce(v_last_name, ''),
      v_auth_email,
      v_phone
    )
    returning * into v_client;

    v_created := true;
  end if;

  client_id := v_client.id;
  first_name := v_client.first_name;
  last_name := v_client.last_name;
  email := v_client.email;
  phone := v_client.phone;
  online_booking_enabled := v_client.online_booking_enabled;
  created_new_client := v_created;
  return next;
end;
$$;

revoke all on function public.activate_my_client_account(text, text, text) from public;
revoke all on function public.activate_my_client_account(text, text, text) from anon;
grant execute on function public.activate_my_client_account(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Small helpers
-- ---------------------------------------------------------------------------------------------
-- The last ten digits of a phone number, so 07700 900123 and +44 7700 900123 count as one number.
create function public.phone_match_key(p_normalized_phone text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case when length(p_normalized_phone) >= 7 then right(p_normalized_phone, 10) end;
$$;
-- So the match is found by looking it up, not by reading every client, however many there are.
create index clients_phone_match_idx on public.clients (public.phone_match_key(normalized_phone));

-- How a profile is signed in: 'registered' (a real login), 'guest' (a guest session) or 'added' (made by the Admin, no login).
create function public.client_login_kind(p_auth_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_auth_user_id is null then 'added'
    when exists (select 1 from auth.users u where u.id = p_auth_user_id and coalesce(u.is_anonymous, false)) then 'guest'
    when exists (select 1 from auth.users u where u.id = p_auth_user_id) then 'registered'
    else 'added'
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. What the Admin has decided
-- ---------------------------------------------------------------------------------------------
-- Pairs she has said are different people, so she is not asked again. A pair is stored once, the smaller id first.
create table public.client_not_same (
  client_a uuid not null references public.clients(id) on delete cascade,
  client_b uuid not null references public.clients(id) on delete cascade,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default clock_timestamp(),
  primary key (client_a, client_b),
  constraint client_not_same_ordered check (client_a < client_b)
);
create index client_not_same_b_idx on public.client_not_same (client_b);
alter table public.client_not_same enable row level security;
revoke all on table public.client_not_same from public;
revoke all on table public.client_not_same from anon;
revoke all on table public.client_not_same from authenticated;

-- A history line for every combine: the profile that went (whole), what moved, who did it and when. Nothing here is
-- ever rewritten by the app. It has no link to clients on purpose, so it outlives both profiles.
create table public.client_merges (
  id uuid primary key default gen_random_uuid(),
  kept_client_id uuid not null,
  removed_client_id uuid not null,
  removed_client jsonb not null,
  removed_kind text not null,
  moved jsonb not null,
  summary jsonb not null,
  merged_by uuid references auth.users(id) on delete set null,
  merged_at timestamptz not null default clock_timestamp()
);
create index client_merges_kept_idx on public.client_merges (kept_client_id);
create index client_merges_removed_idx on public.client_merges (removed_client_id);
alter table public.client_merges enable row level security;
create policy "admins can read the combine history" on public.client_merges
  for select to authenticated using (public.is_booking_admin());
revoke all on table public.client_merges from public;
revoke all on table public.client_merges from anon;
revoke all on table public.client_merges from authenticated;
grant select on table public.client_merges to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Noticing profiles that might be one person
--
-- Two profiles are a possible match when they share an email, or a phone number (by its last ten digits), unless the
-- Admin has said they are different people. Two profiles that each have their own login are never offered: they cannot
-- be combined, and two real accounts on one phone are most likely two people.
-- ---------------------------------------------------------------------------------------------
-- The pairs worth looking at, found by lookup rather than by reading every client. With a profile given, only the pairs it is in
-- (this runs whenever a profile is saved, so it has to stay quick however many clients there are); with none, every pair.
create function public.client_pair_candidates(p_client uuid default null)
returns table(a_id uuid, b_id uuid)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_client is null then
    return query
      select x.id, y.id from public.clients x join public.clients y on y.normalized_email = x.normalized_email and y.id > x.id
      union
      select x.id, y.id from public.clients x join public.clients y on public.phone_match_key(y.normalized_phone) = public.phone_match_key(x.normalized_phone) and y.id > x.id;
  else
    return query
      select least(x.id, y.id), greatest(x.id, y.id) from public.clients x join public.clients y on y.normalized_email = x.normalized_email and y.id <> x.id where x.id = p_client
      union
      select least(x.id, y.id), greatest(x.id, y.id) from public.clients x join public.clients y on public.phone_match_key(y.normalized_phone) = public.phone_match_key(x.normalized_phone) and y.id <> x.id where x.id = p_client;
  end if;
end;
$$;

create function public.client_duplicate_pairs(p_client uuid default null)
returns table(client_a uuid, client_b uuid, matched_on text[])
language sql
stable
set search_path = ''
as $$
  select a.id, b.id,
    array_remove(array[
      case when a.normalized_email is not null and a.normalized_email = b.normalized_email then 'email' end,
      case when public.phone_match_key(a.normalized_phone) is not null and public.phone_match_key(a.normalized_phone) = public.phone_match_key(b.normalized_phone) then 'phone' end
    ], null)
  from public.client_pair_candidates(p_client) cand
  join public.clients a on a.id = cand.a_id
  join public.clients b on b.id = cand.b_id
  where not (public.client_login_kind(a.auth_user_id) = 'registered' and public.client_login_kind(b.auth_user_id) = 'registered')
    and not exists (select 1 from public.client_not_same n where n.client_a = a.id and n.client_b = b.id);
$$;

-- Whenever a profile is saved with an email or phone it raises at most one new question: about the best pair it is in that has
-- something to combine (a booking on either side) and that nobody has been asked about yet. A pair with a login comes first, then
-- the pair with more bookings. Other pairs stay on the Clients page and raise no alert, so nobody can flood the Alerts page by
-- making many profiles with one email.
create function public.flag_possible_duplicate_clients()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select p.client_a, p.client_b, p.matched_on into r
  from public.client_duplicate_pairs(new.id) p
  where exists (select 1 from public.bookings b where b.client_id in (p.client_a, p.client_b))
    and not exists (select 1 from public.event_outbox e
      where e.deduplication_key = 'client.possible_duplicate:' || p.client_a::text || ':' || p.client_b::text)
  order by (public.client_login_kind((select c.auth_user_id from public.clients c where c.id = p.client_a)) = 'registered'
         or public.client_login_kind((select c.auth_user_id from public.clients c where c.id = p.client_b)) = 'registered') desc,
    (select count(*) from public.bookings b where b.client_id in (p.client_a, p.client_b)) desc, p.client_a, p.client_b
  limit 1;
  if found then
    insert into public.event_outbox(event_type, aggregate_type, aggregate_id, deduplication_key, payload)
    values ('client.possible_duplicate', 'client', new.id,
      'client.possible_duplicate:' || r.client_a::text || ':' || r.client_b::text,
      jsonb_build_object('client_id', new.id, 'other_client_id', case when r.client_a = new.id then r.client_b else r.client_a end,
        'matched_on', to_jsonb(r.matched_on)))
    on conflict (deduplication_key) do nothing;
  end if;
  return null;
end;
$$;
create trigger clients_flag_possible_duplicates after insert or update of email, phone on public.clients
  for each row execute function public.flag_possible_duplicate_clients();

-- The alert. It is quiet on purpose: in the app only, no Telegram message or email, because nothing here is urgent. It says what
-- matched and does not claim when anything happened (it can be raised when a profile is saved again). The profile with a login is
-- named first, then one the Admin added, then a guest.
create function public.plan_client_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.clients%rowtype;
  v_b public.clients%rowtype;
  v_swap public.clients%rowtype;
  v_order text[] := array['registered', 'added', 'guest'];
  v_matched jsonb := new.payload->'matched_on';
  v_reason text;
  v_body text;
begin
  if new.event_type <> 'client.possible_duplicate' then return null; end if;
  select * into v_a from public.clients c where c.id = (new.payload->>'client_id')::uuid;
  if not found then return null; end if;
  select * into v_b from public.clients c where c.id = (new.payload->>'other_client_id')::uuid;
  if not found then return null; end if;
  if array_position(v_order, public.client_login_kind(v_b.auth_user_id)) < array_position(v_order, public.client_login_kind(v_a.auth_user_id)) then
    v_swap := v_a; v_a := v_b; v_b := v_swap;
  end if;
  v_reason := case
    when v_matched @> '["email","phone"]'::jsonb then 'email and phone number'
    when v_matched @> '["phone"]'::jsonb then 'phone number'
    else 'email' end;
  v_body := format('%s (%s) and %s (%s) have the same %s. Look at them side by side and combine them if they are one person.',
    coalesce(nullif(btrim(v_a.first_name || ' ' || v_a.last_name), ''), 'A client'),
    case public.client_login_kind(v_a.auth_user_id) when 'registered' then 'has a login' when 'guest' then 'booked as a guest' else 'added by you' end,
    coalesce(nullif(btrim(v_b.first_name || ' ' || v_b.last_name), ''), 'a client'),
    case public.client_login_kind(v_b.auth_user_id) when 'registered' then 'has a login' when 'guest' then 'booked as a guest' else 'added by you' end,
    v_reason);
  insert into public.notification_deliveries(event_id, channel, audience, recipient, title, body, link_path, status, sent_at)
  values (new.id, 'in_app', 'admin', 'admin-clients', 'Is this the same person?', v_body,
    '/admin/clients/combine?a=' || v_a.id::text || '&b=' || v_b.id::text, 'sent', clock_timestamp());
  return null;
end;
$$;
create trigger event_outbox_plan_client_notifications after insert on public.event_outbox
  for each row execute function public.plan_client_notifications();

-- Once she has decided, the alerts about the pair (or about a profile that is gone) are marked as read.
create function public.mark_duplicate_alerts_read(p_client_a uuid, p_client_b uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notification_deliveries d set read_at = clock_timestamp()
  from public.event_outbox e
  where e.id = d.event_id and e.event_type = 'client.possible_duplicate' and d.channel = 'in_app' and d.read_at is null
    and ((p_client_b is null and (e.payload->>'client_id' = p_client_a::text or e.payload->>'other_client_id' = p_client_a::text))
      or (p_client_b is not null and e.payload->>'client_id' in (p_client_a::text, p_client_b::text)
          and e.payload->>'other_client_id' in (p_client_a::text, p_client_b::text)));
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. What the Admin sees
-- ---------------------------------------------------------------------------------------------
-- The list on the Clients page, newest first.
create function public.admin_possible_duplicates()
returns table(client_a uuid, client_b uuid, a_name text, b_name text, a_kind text, b_kind text, matched_on text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  return query
    select p.client_a, p.client_b,
      coalesce(nullif(btrim(a.first_name || ' ' || a.last_name), ''), 'Client'), coalesce(nullif(btrim(b.first_name || ' ' || b.last_name), ''), 'Client'),
      public.client_login_kind(a.auth_user_id), public.client_login_kind(b.auth_user_id), p.matched_on
    from public.client_duplicate_pairs() p
    join public.clients a on a.id = p.client_a
    join public.clients b on b.id = p.client_b
    order by greatest(a.created_at, b.created_at) desc, p.client_a
    limit 50;
end;
$$;

-- What each profile holds, for the screen that shows two of them side by side.
create function public.client_combine_profile(p_client_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email, 'phone', c.phone,
    'kind', public.client_login_kind(c.auth_user_id), 'created_at', c.created_at, 'online_booking_enabled', c.online_booking_enabled,
    'bookings', (select count(*) from public.bookings b where b.client_id = c.id),
    'upcoming', (select count(*) from public.bookings b where b.client_id = c.id
      and b.booking_status in ('awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed')
      and b.date >= (clock_timestamp() at time zone 'Europe/London')::date),
    'dates', (select coalesce(jsonb_agg(d.date order by d.date desc), '[]'::jsonb)
      from (select distinct b.date from public.bookings b where b.client_id = c.id order by b.date desc limit 3) d),
    'notes', (select count(*) from public.client_notes n where n.client_id = c.id),
    'addresses', (select count(*) from public.client_addresses a where a.client_id = c.id),
    'repeats', (select count(*) from public.booking_series s where s.client_id = c.id and s.status <> 'ended'))
  from public.clients c where c.id = p_client_id;
$$;

create function public.admin_combine_preview(p_client_a uuid, p_client_b uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.clients%rowtype;
  b public.clients%rowtype;
  v_pa jsonb;
  v_pb jsonb;
  v_both boolean;
  v_keep uuid;
  v_rank_a integer;
  v_rank_b integer;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_client_a is null or p_client_b is null or p_client_a = p_client_b then
    raise exception 'Choose two different clients' using errcode = '22023';
  end if;
  select * into a from public.clients c where c.id = p_client_a;
  if not found then raise exception 'One of these clients is no longer there. They may already have been combined.' using errcode = 'P0002'; end if;
  select * into b from public.clients c where c.id = p_client_b;
  if not found then raise exception 'One of these clients is no longer there. They may already have been combined.' using errcode = 'P0002'; end if;
  v_pa := public.client_combine_profile(a.id);
  v_pb := public.client_combine_profile(b.id);
  v_both := v_pa->>'kind' = 'registered' and v_pb->>'kind' = 'registered';
  -- Who should stay: the one with a login; otherwise one the Admin added rather than a guest (a guest's profile can be reached from the
  -- browser that made it, and nothing proves who is behind it); then the one with more bookings; then the older one.
  v_rank_a := case v_pa->>'kind' when 'registered' then 0 when 'added' then 1 else 2 end;
  v_rank_b := case v_pb->>'kind' when 'registered' then 0 when 'added' then 1 else 2 end;
  v_keep := case
    when v_rank_a < v_rank_b then a.id
    when v_rank_a > v_rank_b then b.id
    when (v_pa->>'bookings')::integer > (v_pb->>'bookings')::integer then a.id
    when (v_pa->>'bookings')::integer < (v_pb->>'bookings')::integer then b.id
    when a.created_at <= b.created_at then a.id
    else b.id end;
  return jsonb_build_object(
    'profiles', jsonb_build_array(v_pa, v_pb),
    'matched_on', to_jsonb(array_remove(array[
      case when a.normalized_email is not null and a.normalized_email = b.normalized_email then 'email' end,
      case when public.phone_match_key(a.normalized_phone) is not null and public.phone_match_key(a.normalized_phone) = public.phone_match_key(b.normalized_phone) then 'phone' end
    ], null)),
    'can_combine', not v_both,
    'keep_id', v_keep,
    'kept_separate', exists (select 1 from public.client_not_same n where n.client_a = least(a.id, b.id) and n.client_b = greatest(a.id, b.id)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. "No, different people": remembered, so she is not asked again
-- ---------------------------------------------------------------------------------------------
create function public.admin_keep_clients_separate(p_client_a uuid, p_client_b uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_client_a is null or p_client_b is null or p_client_a = p_client_b then
    raise exception 'Choose two different clients' using errcode = '22023';
  end if;
  if (select count(*) from public.clients c where c.id in (p_client_a, p_client_b)) <> 2 then
    raise exception 'One of these clients is no longer there. They may already have been combined.' using errcode = 'P0002';
  end if;
  insert into public.client_not_same(client_a, client_b, decided_by)
  values (least(p_client_a, p_client_b), greatest(p_client_a, p_client_b), auth.uid())
  on conflict do nothing;
  perform public.mark_duplicate_alerts_read(p_client_a, p_client_b);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. "Yes, combine them"
--
-- One command, all or nothing. The profile that is kept never changes who it is; it gains the other one's bookings,
-- notes, addresses, repeat bookings, waitlist requests and any time still held, and any email, phone or last name it
-- lacked. Online booking stays switched off if it was switched off on either. The profile that goes is saved whole in
-- client_merges, and a private note on the kept profile says what was combined. The same request key returns the same
-- result, so a second tap or a retry does nothing more.
-- ---------------------------------------------------------------------------------------------
create function public.admin_merge_clients(p_keep_client_id uuid, p_remove_client_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text := 'admin-client-merge:' || coalesce(auth.uid()::text, '');
  v_fingerprint text := md5(coalesce(p_keep_client_id::text, '') || ':' || coalesce(p_remove_client_id::text, ''));
  v_command public.command_requests%rowtype;
  v_logged public.client_merges%rowtype;
  v_keep public.clients%rowtype;
  v_remove public.clients%rowtype;
  v_keep_kind text;
  v_remove_kind text;
  v_message text;
  v_lock text;
  v_bookings uuid[];
  v_series uuid[];
  v_notes uuid[];
  v_addresses uuid[];
  v_waitlist uuid[];
  v_holds uuid[];
  v_duplicates jsonb;
  v_keep_had_default boolean;
  v_remove_default uuid;
  v_keep_name text;
  v_moved jsonb;
  v_summary jsonb;
  v_merge_id uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_keep_client_id is null or p_remove_client_id is null or p_request_id is null or p_keep_client_id = p_remove_client_id then
    raise exception 'Choose two different clients' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_scope || ':' || p_request_id::text));
  select * into v_command from public.command_requests c where c.scope = v_scope and c.idempotency_key = p_request_id::text for update;
  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode = '22023';
    end if;
    if v_command.status = 'succeeded' then
      select * into v_logged from public.client_merges m where m.id = v_command.result_reference::uuid;
      return v_logged.summary || jsonb_build_object('repeat', true);
    end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;

  -- The same email lock as signing up and adding a client, so a registration on either email waits for this to finish.
  for v_lock in
    select distinct 'client-auth-email:' || c.normalized_email from public.clients c
    where c.id in (p_keep_client_id, p_remove_client_id) and c.normalized_email is not null order by 1
  loop
    perform pg_advisory_xact_lock(hashtext(v_lock));
  end loop;
  -- The repeat job locks a repeat and then its client; this does the same, so the two never wait on each other.
  perform 1 from public.booking_series s where s.client_id = p_remove_client_id order by s.id for update;
  perform 1 from public.clients c where c.id in (p_keep_client_id, p_remove_client_id) order by c.id for update;

  select * into v_keep from public.clients c where c.id = p_keep_client_id;
  if not found then
    raise exception 'One of these clients is no longer there. They may already have been combined.' using errcode = 'P0002';
  end if;
  select * into v_remove from public.clients c where c.id = p_remove_client_id;
  if not found then
    -- Already combined by an earlier request, for example from a second tab.
    select * into v_logged from public.client_merges m
      where m.kept_client_id = p_keep_client_id and m.removed_client_id = p_remove_client_id order by m.merged_at desc limit 1;
    if found then return v_logged.summary || jsonb_build_object('repeat', true); end if;
    raise exception 'One of these clients is no longer there. They may already have been combined.' using errcode = 'P0002';
  end if;

  v_keep_kind := public.client_login_kind(v_keep.auth_user_id);
  v_remove_kind := public.client_login_kind(v_remove.auth_user_id);
  if v_remove_kind = 'registered' then
    v_message := case when v_keep_kind = 'registered'
      then 'Two clients who each have their own login cannot be combined.'
      else 'The client with the login is the one that stays.' end;
    raise exception '%', v_message using errcode = 'PT409';
  end if;

  -- Bookings keep everything about themselves (status, payment, fees, the address they were made for); only the owner changes.
  with moved as (update public.bookings b set client_id = p_keep_client_id where b.client_id = p_remove_client_id returning b.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_bookings from moved;
  with moved as (update public.booking_series s set client_id = p_keep_client_id where s.client_id = p_remove_client_id returning s.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_series from moved;
  with moved as (update public.client_notes n set client_id = p_keep_client_id where n.client_id = p_remove_client_id returning n.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_notes from moved;
  with moved as (update public.waitlist_requests w set client_id = p_keep_client_id where w.client_id = p_remove_client_id returning w.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_waitlist from moved;
  with moved as (update public.booking_holds h set client_id = p_keep_client_id where h.client_id = p_remove_client_id returning h.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_holds from moved;

  -- Addresses: an address the kept profile already has is not copied. Bookings that used the copy now point at the original.
  v_keep_had_default := exists (select 1 from public.client_addresses a where a.client_id = p_keep_client_id and a.is_default);
  select a.id into v_remove_default from public.client_addresses a where a.client_id = p_remove_client_id and a.is_default;
  -- Entry instructions are never lost: two copies count as one only when their instructions agree or one has none, and what the
  -- copy knew that the original did not (instructions, a label) is kept on the original. The whole copy is saved in the history too.
  select coalesce(jsonb_agg(jsonb_build_object('removed', d.removed_id, 'kept', d.kept_id, 'address', d.removed_row)), '[]'::jsonb) into v_duplicates
  from (
    select distinct on (r.id) r.id as removed_id, k.id as kept_id, to_jsonb(r) as removed_row
    from public.client_addresses r
    join public.client_addresses k on k.client_id = p_keep_client_id
      and k.normalized_postcode = r.normalized_postcode
      and lower(btrim(k.address_line_1)) = lower(btrim(r.address_line_1))
      and lower(btrim(coalesce(k.address_line_2, ''))) = lower(btrim(coalesce(r.address_line_2, '')))
      and (nullif(btrim(coalesce(r.entry_instructions, '')), '') is null or nullif(btrim(coalesce(k.entry_instructions, '')), '') is null
        or lower(btrim(r.entry_instructions)) = lower(btrim(k.entry_instructions)))
    where r.client_id = p_remove_client_id
    order by r.id, k.is_default desc, k.created_at, k.id
  ) d;
  update public.client_addresses k set
    entry_instructions = coalesce(nullif(btrim(coalesce(k.entry_instructions, '')), ''), nullif(btrim(coalesce(r.entry_instructions, '')), '')),
    label = coalesce(nullif(btrim(coalesce(k.label, '')), ''), nullif(btrim(coalesce(r.label, '')), ''))
  from (select (e->>'removed')::uuid as removed_id, (e->>'kept')::uuid as kept_id from jsonb_array_elements(v_duplicates) e) d
  join public.client_addresses r on r.id = d.removed_id
  where k.id = d.kept_id;
  update public.bookings b set saved_address_id = d.kept_id
  from (select (e->>'removed')::uuid as removed_id, (e->>'kept')::uuid as kept_id from jsonb_array_elements(v_duplicates) e) d
  where b.saved_address_id = d.removed_id;
  delete from public.client_addresses a where a.id in (select (e->>'removed')::uuid from jsonb_array_elements(v_duplicates) e);
  if v_keep_had_default then
    update public.client_addresses a set is_default = false where a.client_id = p_remove_client_id and a.is_default;
  end if;
  with moved as (update public.client_addresses a set client_id = p_keep_client_id where a.client_id = p_remove_client_id returning a.id)
  select coalesce(array_agg(moved.id), '{}'::uuid[]) into v_addresses from moved;
  if not v_keep_had_default and v_remove_default is not null
     and not exists (select 1 from public.client_addresses a where a.id = v_remove_default) then
    -- The default address was a copy: the original the kept profile has becomes the default.
    update public.client_addresses a set is_default = true
    where a.id = (select (e->>'kept')::uuid from jsonb_array_elements(v_duplicates) e where (e->>'removed')::uuid = v_remove_default);
  end if;

  -- A repeat keeps a copy of the booking it makes each week, naming the client and perhaps a saved address. Both follow the move, or
  -- every later session of the repeat would fail to be made.
  update public.booking_series s set request = jsonb_set(s.request, '{client_id}', to_jsonb(p_keep_client_id::text))
  where s.id = any(v_series);
  update public.booking_series s set request = jsonb_set(s.request, '{saved_address_id}', to_jsonb(d.kept_id::text))
  from (select (e->>'removed')::uuid as removed_id, (e->>'kept')::uuid as kept_id from jsonb_array_elements(v_duplicates) e) d
  where s.id = any(v_series) and s.request->>'saved_address_id' = d.removed_id::text;

  v_summary := jsonb_build_object('kept_id', v_keep.id, 'removed_id', v_remove.id,
    'bookings', cardinality(v_bookings), 'repeats', cardinality(v_series), 'notes', cardinality(v_notes),
    'addresses', cardinality(v_addresses), 'waitlist', cardinality(v_waitlist));
  v_moved := jsonb_build_object('bookings', to_jsonb(v_bookings), 'repeats', to_jsonb(v_series), 'notes', to_jsonb(v_notes),
    'addresses', to_jsonb(v_addresses), 'duplicate_addresses', v_duplicates, 'waitlist', to_jsonb(v_waitlist), 'holds', to_jsonb(v_holds));
  insert into public.client_merges(kept_client_id, removed_client_id, removed_client, removed_kind, moved, summary, merged_by)
  values (v_keep.id, v_remove.id, to_jsonb(v_remove), v_remove_kind, v_moved, v_summary, auth.uid())
  returning id into v_merge_id;

  -- "Not the same person" answers about the profile that goes now apply to the one that stays.
  insert into public.client_not_same(client_a, client_b, decided_by, decided_at)
  select least(n.other, p_keep_client_id), greatest(n.other, p_keep_client_id), n.decided_by, n.decided_at
  from (select case when s.client_a = p_remove_client_id then s.client_b else s.client_a end as other, s.decided_by, s.decided_at
        from public.client_not_same s where p_remove_client_id in (s.client_a, s.client_b)) n
  where n.other <> p_keep_client_id
  on conflict do nothing;

  -- Everything has moved, so nothing else is removed with the profile.
  delete from public.clients c where c.id = p_remove_client_id;

  update public.clients c set
    created_at = least(c.created_at, v_remove.created_at),
    last_name = case when btrim(c.last_name) = '' then v_remove.last_name else c.last_name end,
    email = coalesce(c.email, v_remove.email),
    phone = coalesce(c.phone, v_remove.phone),
    online_booking_enabled = c.online_booking_enabled and v_remove.online_booking_enabled
  where c.id = p_keep_client_id;

  -- What the repeats' held times and the alerts about the old profile say follows the profile that stays.
  select btrim(c.first_name || ' ' || c.last_name) into v_keep_name from public.clients c where c.id = p_keep_client_id;
  update public.calendar_blocks cb set title = 'Held for ' || coalesce(nullif(v_keep_name, ''), 'a client') || ' (repeat)'
  where cb.series_id = any(v_series) and cb.kind = 'series_hold';
  update public.notification_deliveries d set link_path = '/admin/clients/' || p_keep_client_id::text
  where d.channel = 'in_app' and d.link_path = '/admin/clients/' || p_remove_client_id::text;

  insert into public.client_notes(client_id, author_user_id, note)
  values (p_keep_client_id, auth.uid(),
    format('Combined with another profile on %s: %s%s%s.', to_char(clock_timestamp() at time zone 'Europe/London', 'FMDD FMMon YYYY'),
      btrim(v_remove.first_name || ' ' || v_remove.last_name), coalesce(', ' || v_remove.email, ''), coalesce(', ' || v_remove.phone, '')));

  perform public.mark_duplicate_alerts_read(p_remove_client_id);

  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type,
    request_fingerprint, status, result_reference, completed_at)
  values (v_scope, p_request_id::text, 'admin', 'admin', auth.uid()::text, 'admin_merge_clients', v_fingerprint,
    'succeeded', v_merge_id::text, clock_timestamp());
  return v_summary;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. Correcting a profile that shares its email or phone with another
--
-- Saving a client used to be refused whenever any other profile had the same email or phone, even when neither was being changed,
-- so a pair she has said are different people (a family on one phone) could not have a name corrected. Now only a value that is
-- being changed can collide with someone else's, and not with a profile she has said is a different person.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_update_client(p_client_id uuid, p_details jsonb)
returns setof public.clients
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_email text;
  v_phone text;
  v_matches uuid[];
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_client_id is null or p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'Client details are required' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_details) k where k not in ('first_name', 'last_name', 'email', 'phone'))
     or length(p_details::text) > 2000 then
    raise exception 'Invalid client details' using errcode = '22023';
  end if;
  v_email := lower(nullif(btrim(p_details->>'email'), ''));
  v_phone := nullif(regexp_replace(coalesce(p_details->>'phone', ''), '[^0-9]', '', 'g'), '');
  if nullif(btrim(p_details->>'first_name'), '') is null or length(p_details->>'first_name') > 120
     or length(coalesce(p_details->>'last_name', '')) > 120
     or (v_email is null and v_phone is null)
     or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'))
     or (v_phone is not null and length(v_phone) not between 7 and 20) then
    raise exception 'Name and a valid email or phone are required' using errcode = '22023';
  end if;
  -- The same locks as creating a client, so two edits cannot both claim one email or phone.
  if v_email is not null then perform pg_advisory_xact_lock(hashtext('client-auth-email:' || v_email)); end if;
  if v_phone is not null then perform pg_advisory_xact_lock(hashtext('client-phone:' || v_phone)); end if;
  select * into v_client from public.clients where id = p_client_id for update;
  if not found then raise exception 'Client unavailable' using errcode = 'P0002'; end if;
  select array_agg(m.id) into v_matches from (
    select c.id from public.clients c
    where c.id <> p_client_id
      and ((v_email is not null and v_email is distinct from v_client.normalized_email and c.normalized_email = v_email)
        or (v_phone is not null and v_phone is distinct from v_client.normalized_phone and c.normalized_phone = v_phone))
      and not exists (select 1 from public.client_not_same n where n.client_a = least(c.id, p_client_id) and n.client_b = greatest(c.id, p_client_id))
    order by c.id limit 20) m;
  if cardinality(v_matches) > 0 then
    raise exception 'Another client already uses this email or phone.' using errcode = 'PT409', detail = array_to_json(v_matches)::text;
  end if;
  return query update public.clients set first_name = btrim(p_details->>'first_name'), last_name = btrim(coalesce(p_details->>'last_name', '')),
    email = v_email, phone = nullif(btrim(p_details->>'phone'), '') where id = p_client_id returning *;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------------------------
revoke all on function public.phone_match_key(text) from public, anon, authenticated;
revoke all on function public.client_login_kind(uuid) from public, anon, authenticated;
revoke all on function public.client_pair_candidates(uuid) from public, anon, authenticated;
revoke all on function public.client_duplicate_pairs(uuid) from public, anon, authenticated;
revoke all on function public.flag_possible_duplicate_clients() from public, anon, authenticated;
revoke all on function public.plan_client_notifications() from public, anon, authenticated;
revoke all on function public.mark_duplicate_alerts_read(uuid, uuid) from public, anon, authenticated;
revoke all on function public.client_combine_profile(uuid) from public, anon, authenticated;
revoke all on function public.admin_possible_duplicates() from public, anon;
revoke all on function public.admin_combine_preview(uuid, uuid) from public, anon;
revoke all on function public.admin_keep_clients_separate(uuid, uuid) from public, anon;
revoke all on function public.admin_merge_clients(uuid, uuid, uuid) from public, anon;
grant execute on function public.admin_possible_duplicates() to authenticated;
grant execute on function public.admin_combine_preview(uuid, uuid) to authenticated;
grant execute on function public.admin_keep_clients_separate(uuid, uuid) to authenticated;
grant execute on function public.admin_merge_clients(uuid, uuid, uuid) to authenticated;
revoke all on function public.admin_update_client(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_client(uuid, jsonb) to authenticated;
