-- VAD Massage Booking V2
-- Deleting a client.
--
-- The Admin can delete a client who has no bookings and no weekly repeat: someone added by mistake, a profile made twice, a
-- made-up test profile. What goes: the profile, its saved addresses and notes, the waiting-list requests they made, the alerts that
-- name the client, the combine history that holds another profile's details, and the client's online account if they have one (so
-- that email can be used again).
--
-- A client who has bookings is never deleted here. Bookings, payments and receipts are her records, and the database already
-- refuses to remove a client they point at (on delete restrict). These commands say so in plain words instead of leaving it to
-- that error.
--
-- Nothing is deleted while anyone is in the middle of booking: a time held for a visitor has no client attached until the very end
-- of their booking, so there is no way to tell whose profile they are using, and deleting it under them would break their booking.
--
-- The question she is asked and the deletion are tied together: the deletion carries what the question said would go, and refuses
-- (so she is asked again) if anything about it changed in between.
--
-- A short private record is kept of the deletion itself (when, by whom, how much went) and never of who the client was.

-- ---------------------------------------------------------------------------------------------
-- 1. The record of what was done
-- ---------------------------------------------------------------------------------------------
-- No details about the client are kept, on purpose: only the id (which points at nothing any more) and counts. It can be read from
-- the Supabase dashboard; nothing in the app shows it.
create table public.client_deletions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  summary jsonb not null,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default clock_timestamp()
);
create index client_deletions_client_idx on public.client_deletions (client_id);
alter table public.client_deletions enable row level security;
revoke all on table public.client_deletions from public;
revoke all on table public.client_deletions from anon;
revoke all on table public.client_deletions from authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. What would go, counted in one place
-- ---------------------------------------------------------------------------------------------
-- The question on the page and the deletion both use this, so they cannot disagree about what is removed. A waiting-list request
-- belongs to the client when it is linked to them, or when it was made by their own login (a visitor who joined the waiting list
-- before their profile existed leaves a request that is not linked).
create function public.client_delete_scope(p_client_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'addresses', (select count(*)::integer from public.client_addresses a where a.client_id = c.id),
    'notes', (select count(*)::integer from public.client_notes n where n.client_id = c.id),
    'waitlist', (select count(*)::integer from public.waitlist_requests w
                 where w.client_id = c.id or (c.auth_user_id is not null and w.created_by = c.auth_user_id)),
    'login', public.client_login_kind(c.auth_user_id))
  from public.clients c
  where c.id = p_client_id;
$$;
revoke all on function public.client_delete_scope(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. What the Admin sees before she decides
-- ---------------------------------------------------------------------------------------------
-- Whether the client can be deleted, and if not, the one reason that matters most, plus what would go. The page shows this; the
-- delete command below checks everything again inside its own lock, so a stale page cannot delete anything it should not.
create function public.admin_client_delete_check(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_bookings integer;
  v_repeats integer;
  v_reason text;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  select * into v_client from public.clients c where c.id = p_client_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select count(*)::integer into v_bookings from public.bookings b where b.client_id = p_client_id;
  select count(*)::integer into v_repeats from public.booking_series s where s.client_id = p_client_id;
  v_reason := case
    when v_client.auth_user_id is not null and exists (select 1 from public.admin_users a where a.user_id = v_client.auth_user_id) then 'admin'
    when v_bookings > 0 then 'bookings'
    when v_repeats > 0 then 'repeats'
    when exists (select 1 from public.booking_holds h where h.status = 'active' and h.expires_at > clock_timestamp()) then 'booking_now'
    else null
  end;
  return jsonb_build_object('found', true, 'can_delete', v_reason is null, 'reason', v_reason,
    'bookings', v_bookings, 'repeats', v_repeats) || public.client_delete_scope(p_client_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Deleting
-- ---------------------------------------------------------------------------------------------
-- p_expected is what the question said would go (addresses, notes, waitlist, login), as the check reported it.
create function public.admin_delete_client(p_client_id uuid, p_request_id uuid, p_expected jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command_scope text := 'admin-client-delete:' || coalesce(auth.uid()::text, '');
  v_fingerprint text := md5(coalesce(p_client_id::text, ''));
  v_command public.command_requests%rowtype;
  v_logged public.client_deletions%rowtype;
  v_client public.clients%rowtype;
  v_email text;
  v_scope jsonb;
  v_waitlist uuid[];
  v_alerts integer;
  v_history integer;
  v_summary jsonb;
  v_deletion_id uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) or not public.is_booking_admin() then
    raise exception 'Admin authorization required' using errcode = '42501';
  end if;
  if p_client_id is null or p_request_id is null then
    raise exception 'Choose a client' using errcode = '22023';
  end if;
  if p_expected is null or jsonb_typeof(p_expected) <> 'object' then
    raise exception 'Say what is being deleted' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_command_scope || ':' || p_request_id::text));
  select * into v_command from public.command_requests c where c.scope = v_command_scope and c.idempotency_key = p_request_id::text for update;
  if found then
    if v_command.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Request key reused' using errcode = '22023';
    end if;
    if v_command.status = 'succeeded' then
      -- The same press arriving twice (a dropped connection, a second tab) is answered, not done again.
      select * into v_logged from public.client_deletions d where d.id = v_command.result_reference::uuid;
      return v_logged.summary || jsonb_build_object('repeat', true);
    end if;
    raise exception 'Command in progress' using errcode = 'PT409';
  end if;

  -- The same email lock as signing up, adding a client and combining, so a registration on this email waits for this to finish.
  select c.normalized_email into v_email from public.clients c where c.id = p_client_id;
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtext('client-auth-email:' || v_email));
  end if;
  -- Anything that points at the client (a booking, a repeat) takes a share of this row first, so from here on it either is already
  -- visible below or waits until this is done and then finds the client gone.
  select * into v_client from public.clients c where c.id = p_client_id for update;
  if not found then
    raise exception 'That client is no longer there. They may already have been deleted or combined.' using errcode = 'P0002';
  end if;

  if v_client.auth_user_id is not null and exists (select 1 from public.admin_users a where a.user_id = v_client.auth_user_id) then
    raise exception 'This client is signed in as an Admin, so they cannot be deleted here.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.bookings b where b.client_id = p_client_id) then
    raise exception 'This client has bookings, so they cannot be deleted. Bookings, payments and receipts are your records.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.booking_series s where s.client_id = p_client_id) then
    raise exception 'This client has a repeating booking, so they cannot be deleted.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.booking_holds h where h.status = 'active' and h.expires_at > clock_timestamp()) then
    raise exception 'Someone is in the middle of booking right now. Try again in a few minutes.' using errcode = 'PT409';
  end if;

  -- What goes is what she was told would go. If an address or note was added, a waiting-list request made, or the person signed up
  -- since the question was put, she is asked again instead of deleting something she was not told about.
  v_scope := public.client_delete_scope(p_client_id);
  if jsonb_build_object('addresses', p_expected->'addresses', 'notes', p_expected->'notes', 'waitlist', p_expected->'waitlist', 'login', p_expected->'login')
     is distinct from v_scope then
    raise exception 'Something changed while you were deciding. Please look at the question again.' using errcode = 'PT409';
  end if;

  select coalesce(array_agg(w.id), '{}'::uuid[]) into v_waitlist
  from public.waitlist_requests w
  where w.client_id = p_client_id or (v_client.auth_user_id is not null and w.created_by = v_client.auth_user_id);

  -- The alerts that name this client (a question about the same person, a waiting-list request) go with them. The events behind
  -- them hold ids only.
  with gone as (
    delete from public.notification_deliveries d
    using public.event_outbox e
    where e.id = d.event_id
      and (e.payload->>'client_id' = p_client_id::text
        or e.payload->>'other_client_id' = p_client_id::text
        or (e.event_type = 'waitlist.joined' and e.aggregate_id = any(v_waitlist)))
    returning d.id)
  select count(*)::integer into v_alerts from gone;
  delete from public.waitlist_requests w where w.id = any(v_waitlist);
  -- Profiles that were once combined into this one are saved whole in the combine history, and so are the ones combined into those
  -- before: they are this person's details too.
  with recursive chain(id) as (
    select p_client_id
    union
    select m.removed_client_id from public.client_merges m join chain on m.kept_client_id = chain.id
  ), gone as (
    delete from public.client_merges m where m.kept_client_id in (select id from chain) returning m.id)
  select count(*)::integer into v_history from gone;

  -- The profile, with its addresses, notes, old held times and "different people" answers (all removed with it by the database).
  delete from public.clients c where c.id = p_client_id;
  -- Their login, so that email can register again and the sign-in service no longer holds their account.
  if v_client.auth_user_id is not null then
    delete from auth.users u where u.id = v_client.auth_user_id;
  end if;

  v_summary := jsonb_build_object('deleted', true, 'addresses', v_scope->'addresses', 'notes', v_scope->'notes', 'waitlist', cardinality(v_waitlist),
    'alerts', v_alerts, 'history', v_history, 'login', v_scope->'login');
  insert into public.client_deletions(client_id, summary, deleted_by)
  values (p_client_id, v_summary, auth.uid())
  returning id into v_deletion_id;
  insert into public.command_requests(scope, idempotency_key, source_channel, actor_type, actor_id, command_type,
    request_fingerprint, status, result_reference, completed_at)
  values (v_command_scope, p_request_id::text, 'admin', 'admin', auth.uid()::text, 'admin_delete_client', v_fingerprint,
    'succeeded', v_deletion_id::text, clock_timestamp());
  return v_summary;
end;
$$;

-- Admin commands: open to a signed-in caller, who is then checked as the Admin inside.
revoke all on function public.admin_client_delete_check(uuid) from public, anon;
revoke all on function public.admin_delete_client(uuid, uuid, jsonb) from public, anon;
grant execute on function public.admin_client_delete_check(uuid) to authenticated;
grant execute on function public.admin_delete_client(uuid, uuid, jsonb) to authenticated;
