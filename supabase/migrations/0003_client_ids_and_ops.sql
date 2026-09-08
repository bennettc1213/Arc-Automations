-- Client IDs, the ops console, and the connection registry.
--
-- Three things arrive together here because they are one change:
--
--   1. A client signs in with a client ID, not an email address. The ID is the
--      thing Ben hands over at the end of onboarding; an email address is the
--      thing a client forgets they used. The ID never authenticates on its own —
--      it selects the account, and the magic link still goes to a mailbox that
--      has to be reachable. See supabase/functions/client-login.
--
--   2. Ben needs to read every tenant, and no client may ever read another.
--      That is one predicate — is_arc_admin() — added to the existing policies
--      rather than a second set of tables. A separate admin schema is how two
--      copies of "what is a lead" start disagreeing.
--
--   3. `connections` records what each client is wired to: the n8n instance, the
--      Twilio number, the GHL sub-account. It is declared rather than observed,
--      which is exactly why the ops console shows it beside the observed event
--      log rather than instead of it — the gap between "what we said we hooked
--      up" and "what has actually sent an event" is the interesting number.

-- ---------------------------------------------------------------------------
-- tenants: the client ID, and who the account belongs to
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column if not exists client_id     text,
  -- where the sign-in link is sent once a client ID resolves. deliberately a
  -- column and not a join through tenant_members: the login path runs before
  -- there is a session, so it cannot read auth.users, and the address Ben
  -- invited is the one fact that path needs.
  add column if not exists login_email   text,
  add column if not exists contact_name  text,
  add column if not exists contact_phone text,
  add column if not exists company       text,
  add column if not exists plan          text,
  add column if not exists notes         text,
  add column if not exists onboarded_at  timestamptz;

-- 'archived' joins the set so a finished engagement can leave the roster
-- without deleting the event history that proves what it did.
alter table public.tenants drop constraint if exists tenants_status_check;
alter table public.tenants add constraint tenants_status_check
  check (status in ('onboarding', 'active', 'paused', 'archived'));

create unique index if not exists tenants_client_id_uniq
  on public.tenants (client_id) where client_id is not null;

-- ---------------------------------------------------------------------------
-- client ID generation
-- ---------------------------------------------------------------------------

-- Crockford base32 minus I, L, O and U: no character pair a client can misread
-- off a phone screen or mishear over a phone call, and no accidental words.
-- ARC-XXXX-XXXX is 40 bits — far past guessing, short enough to read aloud.
--
-- gen_random_bytes rather than random(): this string is quoted in support email
-- and typed into a sign-in box, so one ID should not be predictable from
-- another. 32 divides 256 exactly, so the modulo below is unbiased.
create or replace function public.gen_client_id()
returns text
language plpgsql
volatile
as $fn$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
  i int;
begin
  loop
    candidate := 'ARC-';
    for i in 1..8 loop
      candidate := candidate
        || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
      if i = 4 then
        candidate := candidate || '-';
      end if;
    end loop;
    exit when not exists (select 1 from public.tenants where client_id = candidate);
  end loop;
  return candidate;
end;
$fn$;

-- every tenant that predates this migration gets one, so no account is
-- unreachable through the new sign-in box.
update public.tenants set client_id = public.gen_client_id() where client_id is null;

alter table public.tenants alter column client_id set default public.gen_client_id();

-- ---------------------------------------------------------------------------
-- arc_admins: who Ben is
-- ---------------------------------------------------------------------------

-- A table rather than a JWT claim. A claim is set in a dashboard nobody has open
-- when they are debugging why the console is empty, and it goes stale inside an
-- already-issued token; a row is inspectable, revocable, and takes effect on the
-- next query.
create table if not exists public.arc_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  label      text,
  created_at timestamptz not null default now()
);

alter table public.arc_admins enable row level security;

-- security definer for the same reason is_tenant_member is: a policy on
-- arc_admins that called this would recurse into itself.
create or replace function public.is_arc_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.arc_admins where user_id = auth.uid());
$fn$;

-- an admin may see the admin list; anyone else may only confirm their own row,
-- which is what the console calls to decide whether to render at all.
drop policy if exists arc_admins_select_self on public.arc_admins;
create policy arc_admins_select_self on public.arc_admins
  for select to authenticated
  using (user_id = auth.uid() or public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- connections: what each client is wired to
-- ---------------------------------------------------------------------------

create table if not exists public.connections (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- n8n | twilio | gohighlevel | webhook | database | crm | calendar | other
  kind        text not null default 'other',
  label       text not null,

  -- where it lives: an n8n instance URL, a phone number, a sub-account id.
  -- Never a secret. Credentials belong in n8n and in Supabase function secrets,
  -- and a table the browser can read is the wrong place to keep one.
  endpoint    text,

  -- what Ben last set by hand. The live column in the console is computed from
  -- the event log instead — a row that reads "live" because somebody typed it is
  -- the exact kind of number this product exists not to print.
  status      text not null default 'planned'
                check (status in ('planned', 'connected', 'paused', 'retired')),

  -- ties this connection to the events it should be producing, so the console
  -- can say "declared, and last sent something four minutes ago".
  workflow_id text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists connections_tenant_idx on public.connections (tenant_id);

alter table public.connections enable row level security;

-- ---------------------------------------------------------------------------
-- Policies: admin reads everything, clients keep reading only their own
-- ---------------------------------------------------------------------------

-- The client-facing policies are recreated with `or public.is_arc_admin()`
-- appended. The tenant predicate is untouched: a bug in the admin branch can
-- widen what Ben sees, never what a client sees.

drop policy if exists tenants_select_own on public.tenants;
create policy tenants_select_own on public.tenants
  for select to authenticated
  using (public.is_tenant_member(id) or public.is_arc_admin());

drop policy if exists events_select_own_tenant on public.events;
create policy events_select_own_tenant on public.events
  for select to authenticated
  using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists alerts_select_own_tenant on public.alerts;
create policy alerts_select_own_tenant on public.alerts
  for select to authenticated
  using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists tenant_members_select_own on public.tenant_members;
create policy tenant_members_select_own on public.tenant_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_arc_admin());

-- Admin writes. Note there is no delete policy on tenants: a tenant delete
-- cascades its whole event history, and "archive" is what removing a client
-- from the roster actually means.
drop policy if exists tenants_admin_insert on public.tenants;
create policy tenants_admin_insert on public.tenants
  for insert to authenticated with check (public.is_arc_admin());

drop policy if exists tenants_admin_update on public.tenants;
create policy tenants_admin_update on public.tenants
  for update to authenticated
  using (public.is_arc_admin()) with check (public.is_arc_admin());

drop policy if exists tenant_members_admin_write on public.tenant_members;
create policy tenant_members_admin_write on public.tenant_members
  for all to authenticated
  using (public.is_arc_admin()) with check (public.is_arc_admin());

-- acknowledged / resolved are the only mutable state in the schema, and this is
-- the surface that mutates them.
drop policy if exists alerts_admin_update on public.alerts;
create policy alerts_admin_update on public.alerts
  for update to authenticated
  using (public.is_arc_admin()) with check (public.is_arc_admin());

drop policy if exists connections_select on public.connections;
create policy connections_select on public.connections
  for select to authenticated
  using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists connections_admin_write on public.connections;
create policy connections_admin_write on public.connections
  for all to authenticated
  using (public.is_arc_admin()) with check (public.is_arc_admin());

-- ingest_tokens: 0001 left this with RLS on and no policy, so no browser could
-- read it at all. The ops console needs to list and mint them, so admins get
-- one — and only admins. token_hash is a SHA-256 of a value that was shown once
-- and never stored, so a row read here cannot be replayed as pipeline write
-- access.
drop policy if exists ingest_tokens_admin on public.ingest_tokens;
create policy ingest_tokens_admin on public.ingest_tokens
  for all to authenticated
  using (public.is_arc_admin()) with check (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- Bootstrap
-- ---------------------------------------------------------------------------
--
-- Nothing above grants anyone admin. After signing in once at /login with the
-- address you want to use for the console, run this in the SQL editor:
--
--   insert into public.arc_admins (user_id, email, label)
--   select id, email, 'ben'
--     from auth.users
--    where email = 'you@example.com'
--   on conflict (user_id) do nothing;
--
-- Deliberately manual, and deliberately not seeded with an address: a migration
-- that granted admin to a hardcoded email in a public repo would be a back door
-- with a comment above it.
