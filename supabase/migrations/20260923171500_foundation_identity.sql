-- VAD Massage Booking V2
-- Foundation migration 1: explicit admin authorization and canonical client identity.
-- This migration intentionally contains no booking/payment tables yet.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create policy "admin users can read own authorization"
on public.admin_users
for select
to authenticated
using (user_id = auth.uid());

create or replace function public.is_booking_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = auth.uid()
  );
$$;

revoke all on function public.is_booking_admin() from public;
grant execute on function public.is_booking_admin() to authenticated;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  first_name text not null,
  last_name text not null default '',
  email text,
  normalized_email text,
  phone text,
  normalized_phone text,
  online_booking_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_first_name_not_blank
    check (length(btrim(first_name)) > 0),
  constraint clients_email_not_blank
    check (email is null or length(btrim(email)) > 0),
  constraint clients_phone_not_blank
    check (phone is null or length(btrim(phone)) > 0)
);

create or replace function public.normalize_client_contact_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email = nullif(btrim(new.email), '');
  new.phone = nullif(btrim(new.phone), '');

  new.normalized_email = case
    when new.email is null then null
    else lower(new.email)
  end;

  new.normalized_phone = case
    when new.phone is null then null
    else nullif(regexp_replace(new.phone, '[^0-9]+', '', 'g'), '')
  end;

  return new;
end;
$$;

create trigger normalize_client_contact_fields_before_write
before insert or update of email, phone
on public.clients
for each row
execute function public.normalize_client_contact_fields();

create trigger clients_set_updated_at
before update
on public.clients
for each row
execute function public.set_updated_at();

create index clients_normalized_email_idx
  on public.clients (normalized_email)
  where normalized_email is not null;

create index clients_normalized_phone_idx
  on public.clients (normalized_phone)
  where normalized_phone is not null;

alter table public.clients enable row level security;

create policy "clients can read own canonical record"
on public.clients
for select
to authenticated
using (auth_user_id = auth.uid());

create policy "admins can manage clients"
on public.clients
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.client_addresses (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  label text,
  address_line_1 text not null,
  address_line_2 text,
  city text not null,
  postcode text not null,
  normalized_postcode text not null,
  entry_instructions text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_addresses_line_1_not_blank
    check (length(btrim(address_line_1)) > 0),
  constraint client_addresses_city_not_blank
    check (length(btrim(city)) > 0),
  constraint client_addresses_postcode_not_blank
    check (length(btrim(postcode)) > 0)
);

create or replace function public.normalize_client_address_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.label = nullif(btrim(new.label), '');
  new.address_line_1 = btrim(new.address_line_1);
  new.address_line_2 = nullif(btrim(new.address_line_2), '');
  new.city = btrim(new.city);
  new.postcode = upper(btrim(new.postcode));
  new.normalized_postcode = regexp_replace(new.postcode, '[^A-Z0-9]+', '', 'g');
  new.entry_instructions = nullif(btrim(new.entry_instructions), '');

  return new;
end;
$$;

create trigger normalize_client_address_fields_before_write
before insert or update
on public.client_addresses
for each row
execute function public.normalize_client_address_fields();

create trigger client_addresses_set_updated_at
before update
on public.client_addresses
for each row
execute function public.set_updated_at();

create unique index client_addresses_one_default_per_client_idx
  on public.client_addresses (client_id)
  where is_default;

create index client_addresses_client_id_idx
  on public.client_addresses (client_id);

alter table public.client_addresses enable row level security;

create policy "clients can read own addresses"
on public.client_addresses
for select
to authenticated
using (
  exists (
    select 1
    from public.clients
    where clients.id = client_addresses.client_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "clients can add own addresses"
on public.client_addresses
for insert
to authenticated
with check (
  exists (
    select 1
    from public.clients
    where clients.id = client_addresses.client_id
      and clients.auth_user_id = auth.uid()
      and clients.online_booking_enabled
  )
);

create policy "clients can update own addresses"
on public.client_addresses
for update
to authenticated
using (
  exists (
    select 1
    from public.clients
    where clients.id = client_addresses.client_id
      and clients.auth_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.clients
    where clients.id = client_addresses.client_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "clients can delete own addresses"
on public.client_addresses
for delete
to authenticated
using (
  exists (
    select 1
    from public.clients
    where clients.id = client_addresses.client_id
      and clients.auth_user_id = auth.uid()
  )
);

create policy "admins can manage client addresses"
on public.client_addresses
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

create table public.client_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  note text not null,
  created_at timestamptz not null default now(),
  constraint client_notes_note_not_blank
    check (length(btrim(note)) > 0)
);

create index client_notes_client_created_idx
  on public.client_notes (client_id, created_at desc);

alter table public.client_notes enable row level security;

create policy "admins can manage client notes"
on public.client_notes
for all
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

revoke all on table public.admin_users from anon;
revoke all on table public.clients from anon;
revoke all on table public.client_addresses from anon;
revoke all on table public.client_notes from anon;

grant select on table public.admin_users to authenticated;
grant select, insert, update, delete on table public.clients to authenticated;
grant select, insert, update, delete on table public.client_addresses to authenticated;
grant select, insert, update, delete on table public.client_notes to authenticated;
