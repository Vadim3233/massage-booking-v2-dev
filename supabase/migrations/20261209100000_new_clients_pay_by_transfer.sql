-- New clients pay by bank transfer; cash from their second visit (Vadim, 12 Nov 2026).
--
-- As new clients start to find Vadim on Google, cash from a stranger is the risk: he travels to their home with nothing paid.
-- From this migration:
--   * A client may choose cash only once they have had a visit that is completed and paid (the same "returning" test as the
--     new-client booking limit), or when Vadim has marked them Trusted (`clients.cash_trusted`, on the client's page).
--     Only the Admin can change it: clients can read their own record but not write it.
--   * The database refuses a client's own switch to cash (in the app, as a guest, through an offer or their AI assistant)
--     when neither is true. The booking page hides the Cash tile for them, so they never meet the refusal.
--   * The Admin is never refused: Vadim can still approve, book or change to cash for anyone. His "Confirm, pay later" and
--     "Approve cash" ask him once more on a first booking (admin_client_payment_trust).
-- Cash requests already made are not touched.
--
-- To take this back: drop the trigger booking_payments_cash_for_returning, the functions booking_payments_cash_for_returning,
-- client_may_pay_cash, client_has_paid_visit, my_cash_allowed and admin_client_payment_trust, and the column clients.cash_trusted.

alter table public.clients add column cash_trusted boolean not null default false;

-- A completed visit that has been paid: the client is no longer new.
create function public.client_has_paid_visit(p_client_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.bookings b join public.booking_payments bp on bp.booking_id = b.id
    where b.client_id = p_client_id and b.booking_status = 'completed' and bp.status = 'paid'
  );
$$;
revoke all on function public.client_has_paid_visit(uuid) from public, anon, authenticated;

create function public.client_may_pay_cash(p_client_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select c.cash_trusted from public.clients c where c.id = p_client_id), false)
      or public.client_has_paid_visit(p_client_id);
$$;
revoke all on function public.client_may_pay_cash(uuid) from public, anon, authenticated;

-- For the booking page and the AI assistant: may the signed-in client choose cash?
create function public.my_cash_allowed()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.client_may_pay_cash(c.id) from public.clients c where c.auth_user_id = auth.uid()), false);
$$;
revoke all on function public.my_cash_allowed() from public, anon;
grant execute on function public.my_cash_allowed() to authenticated;

-- For the Admin: is this client still new (no paid visit yet), and are they Trusted?
create function public.admin_client_payment_trust(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_booking_admin() then raise exception 'Admin access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'has_paid_visit', public.client_has_paid_visit(p_client_id),
    'trusted', coalesce((select c.cash_trusted from public.clients c where c.id = p_client_id), false));
end; $$;
revoke all on function public.admin_client_payment_trust(uuid) from public, anon;
grant execute on function public.admin_client_payment_trust(uuid) to authenticated;

-- The rule itself, wherever cash is chosen: a client's own change to cash is refused unless they may pay cash.
-- Only requests made as a signed-in user (the API's authenticated role) are checked; the Admin is not, nor the system's own jobs
-- and maintenance run directly in the database.
create function public.booking_payments_cash_for_returning()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client uuid;
begin
  if new.method is distinct from 'cash' then return new; end if;
  if tg_op = 'UPDATE' and old.method = 'cash' then return new; end if;
  if coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon') then return new; end if;
  if auth.uid() is null or public.is_booking_admin() then return new; end if;
  select b.client_id into v_client from public.bookings b where b.id = new.booking_id;
  if v_client is null or public.client_may_pay_cash(v_client) then return new; end if;
  raise exception 'For your first visit, please pay by bank transfer to secure your booking. Cash is welcome from your second visit.'
    using errcode = '22023';
end; $$;
revoke all on function public.booking_payments_cash_for_returning() from public, anon, authenticated;

create trigger booking_payments_cash_for_returning
  before insert or update of method on public.booking_payments
  for each row execute function public.booking_payments_cash_for_returning();
