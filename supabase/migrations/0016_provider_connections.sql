-- ===========================================================================
-- 0016 — Tenant provider connections, OAuth sessions and Vault-held
--        credentials (ARC-130)
-- ===========================================================================
--
-- Decision: ADR ARC-010 §20a (accepted 2026-09-25, Bennett Church) — tenant
-- OAuth tokens, refresh tokens, API keys and every other tenant-scoped secret
-- are stored in **Supabase Vault**, and nowhere else. Raw secrets exist only in
-- Vault and, briefly, in the memory of the one trusted server function using
-- them. Ordinary tables hold non-secret metadata; the opaque Vault references
-- live in `arc_private`, a schema no API role can see.
--
--   public.provider_connections        one row per tenant connection: status,
--                                      its optimistic lock, the verified account,
--                                      scopes, capabilities, expiry, health.
--                                      No secret, no Vault reference.
--   public.provider_connection_events  append-only security and transition
--                                      history. No secret.
--   public.connection_transition_rules the legal transitions, seeded from
--                                      `_shared/connections/model.ts` and
--                                      drift-tested against it.
--   arc_private.credential_versions    every credential version: kind, status,
--                                      and the Vault secret id. Retired
--                                      versions resolve nothing.
--   arc_private.authorization_sessions OAuth sessions: the SHA-256 of state and
--                                      nonce, the Vault id of the PKCE verifier,
--                                      the server-derived redirect, a bounded
--                                      return path, expiry, one-time consumption.
--
-- ---------------------------------------------------------------------------
-- Who can do what
-- ---------------------------------------------------------------------------
--
-- Browsers (`anon`, `authenticated`): nothing in Vault, nothing in
-- `arc_private`, no connection function. A signed-in tenant member or operator
-- may SELECT the safe columns of their tenant's connections and events.
--
-- The service role (the edge functions): SELECT on the public tables, EXECUTE
-- on the `public.connection_*` wrappers below, and nothing else — no Vault
-- schema, no `vault.decrypted_secrets`, no `arc_private`, no direct writes to
-- any connection table. Every write goes through a wrapper, which re-checks the
-- ACTOR (an operator in `arc_admins`, or the tenant's `owner` member) for every
-- person-initiated change: holding the service-role key does not make a caller
-- a connection manager.
--
-- The wrappers are SECURITY DEFINER with `search_path = ''` and fully-qualified
-- objects; each is a one-line call into `arc_private`, where the logic is. There
-- is no generic "get secret by id": a secret is resolved only for a named
-- operation, on a connection of the named tenant and provider, whose status
-- permits that operation now, through its single active credential version.
--
-- ---------------------------------------------------------------------------
-- Vault availability
-- ---------------------------------------------------------------------------
--
-- On Supabase, `supabase_vault` is installed (or installable) in schema `vault`.
-- Anywhere it is not, this migration FAILS — unless the session explicitly
-- declares the local PGlite test harness (`arc.vault_test_double = 'pglite'`)
-- AND that harness has created its contract-compatible `vault` double. A hosted
-- database never sets that, so a hosted database without Vault cannot apply
-- 0016 and cannot store a credential anywhere else.
--
-- No secret is inserted by this migration.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Vault
-- ---------------------------------------------------------------------------

do $vault$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'supabase_vault') then
    create extension if not exists supabase_vault with schema vault;
  elsif pg_catalog.current_setting('arc.vault_test_double', true) = 'pglite'
        and pg_catalog.to_regprocedure('vault.create_secret(text,text,text,uuid)') is not null then
    raise notice 'ARC-130: the local test harness Vault double is in use — never valid outside tests';
  else
    raise exception 'arc_connection:vault_unavailable: Supabase Vault is not available in this database; ARC-130 stores credentials nowhere else'
      using errcode = 'P0001';
  end if;
end;
$vault$;

-- Direct Vault access: none for any API role. (Supabase grants its own roles
-- what Vault needs; the migration owner keeps access and uses it only inside
-- the functions below.)
revoke all on schema vault from public, anon, authenticated, service_role;
revoke all on all tables in schema vault from public, anon, authenticated, service_role;
revoke all on all sequences in schema vault from public, anon, authenticated, service_role;
revoke all on all functions in schema vault from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. the private schema
-- ---------------------------------------------------------------------------

create schema if not exists arc_private;
revoke all on schema arc_private from public, anon, authenticated, service_role;
alter default privileges in schema arc_private revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema arc_private revoke all on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. tables
-- ---------------------------------------------------------------------------

create table if not exists public.connection_transition_rules (
  event        text not null,
  from_status  text not null,
  to_status    text not null,
  actor_type   text not null check (actor_type in ('manager', 'system')),
  primary key (event, from_status, actor_type)
);

insert into public.connection_transition_rules (event, from_status, to_status, actor_type) values
  ('authorization_failed',     'authorization_pending',    'failed',                   'manager'),
  ('authorization_failed',     'authorization_pending',    'failed',                   'system'),
  ('authorization_failed',     'connected_unverified',     'connected_unverified',     'manager'),
  ('authorization_failed',     'connected_unverified',     'connected_unverified',     'system'),
  ('authorization_failed',     'degraded',                 'degraded',                 'manager'),
  ('authorization_failed',     'degraded',                 'degraded',                 'system'),
  ('authorization_failed',     'failed',                   'failed',                   'manager'),
  ('authorization_failed',     'failed',                   'failed',                   'system'),
  ('authorization_failed',     'reauthorization_required', 'reauthorization_required', 'manager'),
  ('authorization_failed',     'reauthorization_required', 'reauthorization_required', 'system'),
  ('authorization_failed',     'verified',                 'verified',                 'manager'),
  ('authorization_failed',     'verified',                 'verified',                 'system'),
  ('begin_authorization',      'authorization_pending',    'authorization_pending',    'manager'),
  ('begin_authorization',      'connected_unverified',     'connected_unverified',     'manager'),
  ('begin_authorization',      'degraded',                 'degraded',                 'manager'),
  ('begin_authorization',      'failed',                   'authorization_pending',    'manager'),
  ('begin_authorization',      'reauthorization_required', 'reauthorization_required', 'manager'),
  ('begin_authorization',      'verified',                 'verified',                 'manager'),
  ('complete_authorization',   'authorization_pending',    'connected_unverified',     'manager'),
  ('complete_authorization',   'connected_unverified',     'connected_unverified',     'manager'),
  ('complete_authorization',   'degraded',                 'connected_unverified',     'manager'),
  ('complete_authorization',   'failed',                   'connected_unverified',     'manager'),
  ('complete_authorization',   'reauthorization_required', 'connected_unverified',     'manager'),
  ('complete_authorization',   'verified',                 'connected_unverified',     'manager'),
  ('credential_rotated',       'connected_unverified',     'connected_unverified',     'manager'),
  ('credential_rotated',       'connected_unverified',     'connected_unverified',     'system'),
  ('credential_rotated',       'degraded',                 'degraded',                 'manager'),
  ('credential_rotated',       'degraded',                 'degraded',                 'system'),
  ('credential_rotated',       'verified',                 'verified',                 'manager'),
  ('credential_rotated',       'verified',                 'verified',                 'system'),
  ('disconnect',               'authorization_pending',    'disconnected',             'manager'),
  ('disconnect',               'connected_unverified',     'disconnected',             'manager'),
  ('disconnect',               'degraded',                 'disconnected',             'manager'),
  ('disconnect',               'failed',                   'disconnected',             'manager'),
  ('disconnect',               'reauthorization_required', 'disconnected',             'manager'),
  ('disconnect',               'verified',                 'disconnected',             'manager'),
  ('provider_degraded',        'degraded',                 'degraded',                 'system'),
  ('provider_degraded',        'verified',                 'degraded',                 'system'),
  ('reauthorization_required', 'connected_unverified',     'reauthorization_required', 'manager'),
  ('reauthorization_required', 'connected_unverified',     'reauthorization_required', 'system'),
  ('reauthorization_required', 'degraded',                 'reauthorization_required', 'manager'),
  ('reauthorization_required', 'degraded',                 'reauthorization_required', 'system'),
  ('reauthorization_required', 'reauthorization_required', 'reauthorization_required', 'manager'),
  ('reauthorization_required', 'reauthorization_required', 'reauthorization_required', 'system'),
  ('reauthorization_required', 'verified',                 'reauthorization_required', 'manager'),
  ('reauthorization_required', 'verified',                 'reauthorization_required', 'system'),
  ('revoke',                   'authorization_pending',    'revoked',                  'manager'),
  ('revoke',                   'authorization_pending',    'revoked',                  'system'),
  ('revoke',                   'connected_unverified',     'revoked',                  'manager'),
  ('revoke',                   'connected_unverified',     'revoked',                  'system'),
  ('revoke',                   'degraded',                 'revoked',                  'manager'),
  ('revoke',                   'degraded',                 'revoked',                  'system'),
  ('revoke',                   'failed',                   'revoked',                  'manager'),
  ('revoke',                   'failed',                   'revoked',                  'system'),
  ('revoke',                   'reauthorization_required', 'revoked',                  'manager'),
  ('revoke',                   'reauthorization_required', 'revoked',                  'system'),
  ('revoke',                   'verified',                 'revoked',                  'manager'),
  ('revoke',                   'verified',                 'revoked',                  'system'),
  ('verification_failed',      'connected_unverified',     'reauthorization_required', 'manager'),
  ('verification_failed',      'connected_unverified',     'reauthorization_required', 'system'),
  ('verification_failed',      'degraded',                 'reauthorization_required', 'manager'),
  ('verification_failed',      'degraded',                 'reauthorization_required', 'system'),
  ('verification_failed',      'verified',                 'reauthorization_required', 'manager'),
  ('verification_failed',      'verified',                 'reauthorization_required', 'system'),
  ('verification_succeeded',   'connected_unverified',     'verified',                 'manager'),
  ('verification_succeeded',   'connected_unverified',     'verified',                 'system'),
  ('verification_succeeded',   'degraded',                 'verified',                 'manager'),
  ('verification_succeeded',   'degraded',                 'verified',                 'system'),
  ('verification_succeeded',   'verified',                 'verified',                 'manager'),
  ('verification_succeeded',   'verified',                 'verified',                 'system')
on conflict do nothing;

create or replace function arc_private.connection_rules_are_immutable()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'arc_connection:illegal_transition: the connection transition rules are fixed by migration' using errcode = 'P0001';
end;
$fn$;

drop trigger if exists connection_transition_rules_immutable on public.connection_transition_rules;
create trigger connection_transition_rules_immutable
  before insert or update or delete on public.connection_transition_rules
  for each statement execute function arc_private.connection_rules_are_immutable();

create table if not exists public.provider_connections (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id) on delete restrict,
  connector_key           text not null check (connector_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  connector_version       integer not null check (connector_version > 0),
  auth_method             text not null check (auth_method in ('oauth2', 'api_key')),
  status                  text not null check (status in (
                            'authorization_pending', 'connected_unverified', 'verified', 'degraded',
                            'reauthorization_required', 'revoked', 'disconnected', 'failed')),
  status_version          bigint not null default 1 check (status_version > 0),
  external_account_id     text check (external_account_id is null or char_length(external_account_id) between 1 and 255),
  external_account_label  text check (external_account_label is null or char_length(external_account_label) <= 200),
  display_metadata        jsonb not null default '{}'::jsonb check (jsonb_typeof(display_metadata) = 'object'),
  granted_scopes          text[] not null default '{}',
  verified_capabilities   text[] not null default '{}',
  credential_version      integer not null default 0 check (credential_version >= 0),
  credential_hint         text check (credential_hint is null or char_length(credential_hint) <= 4),
  access_expires_at       timestamptz,
  refreshable             boolean not null default false,
  last_verified_at        timestamptz,
  last_refresh_attempt_at timestamptz,
  last_refresh_result     text check (last_refresh_result is null or last_refresh_result in (
                            'succeeded', 'rotated', 'temporary_failure', 'permanent_failure',
                            'storage_failed', 'incomplete_response', 'abandoned')),
  refresh_lease_token     uuid,
  refresh_lease_until     timestamptz,
  health_status           text not null default 'unverified'
                            check (health_status in ('unverified', 'healthy', 'degraded', 'failing')),
  health_reason           text check (health_reason is null or char_length(health_reason) <= 300),
  health_checked_at       timestamptz,
  connected_by            uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  ended_at                timestamptz,
  unique (id, tenant_id),
  constraint provider_connections_ended check ((status in ('revoked', 'disconnected')) = (ended_at is not null)),
  constraint provider_connections_no_secrets check (
    display_metadata::text !~* '(access_?token|refresh_?token|id_?token|api[_-]?key|secret|password|bearer |eyJ[A-Za-z0-9_-]{8,}\.)'
    and coalesce(external_account_label, '') !~* '(bearer |eyJ[A-Za-z0-9_-]{8,}\.)'
  )
);

-- one live connection per tenant and provider; a failed attempt or an ended
-- connection does not hold the slot.
create unique index if not exists provider_connections_one_live
  on public.provider_connections (tenant_id, connector_key)
  where status not in ('revoked', 'disconnected', 'failed');
create index if not exists provider_connections_tenant on public.provider_connections (tenant_id, status);

create table if not exists public.provider_connection_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  connection_id    uuid,
  session_id       uuid,
  event_type       text not null check (event_type in (
                     'begin_authorization', 'complete_authorization', 'authorization_failed',
                     'verification_succeeded', 'verification_failed', 'provider_degraded',
                     'credential_rotated', 'reauthorization_required', 'disconnect', 'revoke',
                     'authorization_initiated', 'authorization_completed', 'authorization_denied',
                     'authorization_expired', 'authorization_replayed', 'connection_replaced',
                     'credential_retired', 'credential_purged', 'credential_purge_failed',
                     'refresh_failed', 'security_denial')),
  from_status      text,
  to_status        text,
  status_version   bigint,
  actor_type       text not null check (actor_type in ('manager', 'system')),
  actor_id         uuid,
  reason_code      text not null check (reason_code ~ '^[a-z][a-z0-9_]{1,60}$'),
  correlation_id   text check (correlation_id is null or char_length(correlation_id) <= 120),
  idempotency_key  text check (idempotency_key is null or char_length(idempotency_key) <= 200),
  metadata         jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at       timestamptz not null default now(),
  foreign key (connection_id, tenant_id) references public.provider_connections (id, tenant_id),
  constraint provider_connection_events_no_secrets check (
    metadata::text !~* '(access_?token|refresh_?token|id_?token|code_?verifier|client_?secret|api[_-]?key|password|bearer |eyJ[A-Za-z0-9_-]{8,}\.|vault)'
  )
);

create unique index if not exists provider_connection_events_idempotency
  on public.provider_connection_events (tenant_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists provider_connection_events_connection
  on public.provider_connection_events (tenant_id, connection_id, created_at desc);

create table if not exists arc_private.credential_versions (
  id               uuid primary key default gen_random_uuid(),
  connection_id    uuid not null,
  tenant_id        uuid not null,
  version          integer not null check (version > 0),
  kind             text not null check (kind in ('oauth_tokens', 'api_key')),
  status           text not null check (status in ('active', 'retired', 'purged', 'purge_failed')),
  vault_secret_id  uuid unique,
  hint             text check (hint is null or char_length(hint) <= 4),
  created_at       timestamptz not null default now(),
  retired_at       timestamptz,
  retire_reason    text check (retire_reason is null or retire_reason ~ '^[a-z][a-z0-9_]{1,60}$'),
  purged_at        timestamptz,
  unique (connection_id, version),
  foreign key (connection_id, tenant_id) references public.provider_connections (id, tenant_id),
  constraint credential_versions_retired check ((status = 'active') = (retired_at is null)),
  constraint credential_versions_purged check ((status = 'purged') = (vault_secret_id is null)),
  constraint credential_versions_purged_at check ((status = 'purged') = (purged_at is not null))
);

create unique index if not exists credential_versions_one_active
  on arc_private.credential_versions (connection_id) where status = 'active';

create table if not exists arc_private.authorization_sessions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id) on delete restrict,
  connection_id           uuid not null,
  connector_key           text not null,
  connector_version       integer not null,
  purpose                 text not null check (purpose in ('connect', 'reauthorize', 'replace')),
  initiated_by            uuid not null,
  state_digest            text not null unique check (state_digest ~ '^[0-9a-f]{64}$'),
  nonce_digest            text check (nonce_digest is null or nonce_digest ~ '^[0-9a-f]{64}$'),
  pkce_method             text check (pkce_method is null or pkce_method = 'S256'),
  pkce_verifier_secret_id uuid unique,
  requested_scopes        text[] not null,
  requested_capabilities  text[] not null,
  redirect_uri            text not null check (redirect_uri ~ '^https?://[^?#[:space:]]+$'),
  return_path             text not null check (return_path ~ '^/(portal/dashboard|ops/console)(/[A-Za-z0-9._~-]{1,64}){0,6}/?$'),
  expected_status_version bigint not null,
  created_at              timestamptz not null default now(),
  expires_at              timestamptz not null,
  consumed_at             timestamptz,
  outcome                 text not null default 'pending'
                            check (outcome in ('pending', 'exchanging', 'completed', 'denied', 'expired', 'failed')),
  failure_code            text check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{1,60}$'),
  idempotency_key         text not null check (char_length(idempotency_key) <= 200),
  correlation_id          text check (correlation_id is null or char_length(correlation_id) <= 120),
  unique (tenant_id, idempotency_key),
  foreign key (connection_id, tenant_id) references public.provider_connections (id, tenant_id),
  constraint authorization_sessions_short_lived check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  constraint authorization_sessions_verifier check (pkce_method is not null or pkce_verifier_secret_id is null),
  constraint authorization_sessions_consumed check ((outcome = 'pending') = (consumed_at is null))
);

create index if not exists authorization_sessions_open
  on arc_private.authorization_sessions (tenant_id, expires_at) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 4. guards (they bind the table owner too)
-- ---------------------------------------------------------------------------

create or replace function arc_private.provider_connection_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'arc_connection:illegal_transition: connection history is append-only (attempted %)', tg_op using errcode = 'P0001';
end;
$fn$;

drop trigger if exists provider_connection_events_append_only on public.provider_connection_events;
create trigger provider_connection_events_append_only
  before update or delete on public.provider_connection_events
  for each row execute function arc_private.provider_connection_events_append_only();

create or replace function arc_private.provider_connections_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_connection:illegal_transition: a connection is never deleted — disconnect it' using errcode = 'P0001';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.connector_key <> old.connector_key
     or new.auth_method <> old.auth_method or new.created_at <> old.created_at then
    raise exception 'arc_connection:illegal_transition: a connection''s identity is immutable' using errcode = 'P0001';
  end if;
  if old.status in ('revoked', 'disconnected') and new.status <> old.status then
    raise exception 'arc_connection:illegal_transition: % is terminal — reconnect as a new connection', old.status using errcode = 'P0001';
  end if;
  if new.status <> old.status and not exists (
    select 1 from public.connection_transition_rules r
     where r.from_status = old.status and r.to_status = new.status
  ) then
    raise exception 'arc_connection:illegal_transition: % to % is not a legal connection transition', old.status, new.status using errcode = 'P0001';
  end if;
  if (new.status <> old.status or new.credential_version <> old.credential_version
      or new.external_account_id is distinct from old.external_account_id
      or new.verified_capabilities <> old.verified_capabilities or new.granted_scopes <> old.granted_scopes)
     and new.status_version <> old.status_version + 1 then
    raise exception 'arc_connection:stale_version: a connection change must advance its status version by one' using errcode = 'P0001';
  end if;
  if new.status_version < old.status_version then
    raise exception 'arc_connection:stale_version: a status version never goes backwards' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists provider_connections_guard on public.provider_connections;
create trigger provider_connections_guard
  before update or delete on public.provider_connections
  for each row execute function arc_private.provider_connections_guard();

create or replace function arc_private.credential_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_connection:illegal_transition: credential history is kept — retire, then purge' using errcode = 'P0001';
  end if;
  if new.id <> old.id or new.connection_id <> old.connection_id or new.tenant_id <> old.tenant_id
     or new.version <> old.version or new.kind <> old.kind or new.created_at <> old.created_at then
    raise exception 'arc_connection:illegal_transition: a credential version is immutable' using errcode = 'P0001';
  end if;
  if new.vault_secret_id is distinct from old.vault_secret_id and new.vault_secret_id is not null then
    raise exception 'arc_connection:illegal_transition: a credential version never points at another secret' using errcode = 'P0001';
  end if;
  if old.status <> new.status and not (
       (old.status = 'active' and new.status = 'retired')
    or (old.status = 'retired' and new.status in ('purged', 'purge_failed'))
    or (old.status = 'purge_failed' and new.status = 'purged')
  ) then
    raise exception 'arc_connection:illegal_transition: a credential version cannot go from % to %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists credential_versions_guard on arc_private.credential_versions;
create trigger credential_versions_guard
  before update or delete on arc_private.credential_versions
  for each row execute function arc_private.credential_versions_guard();

-- ---------------------------------------------------------------------------
-- 5. helpers
-- ---------------------------------------------------------------------------

create or replace function arc_private.refuse(p_code text, p_message text)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'arc_connection:%: %', p_code, p_message using errcode = 'P0001';
end;
$fn$;

create or replace function arc_private.req_text(p jsonb, k text, p_required boolean default true, p_max integer default 200)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare v text;
begin
  if p is null or jsonb_typeof(p -> k) is distinct from 'string' then
    if p_required or (p ? k and jsonb_typeof(p -> k) <> 'null') then
      perform arc_private.refuse('invalid_request', format('%s is required', k));
    end if;
    return null;
  end if;
  v := p ->> k;
  if char_length(v) = 0 or char_length(v) > p_max or v ~ '[[:cntrl:]]' then
    perform arc_private.refuse('invalid_request', format('%s is empty, too long or not printable', k));
  end if;
  return v;
end;
$fn$;

create or replace function arc_private.req_uuid(p jsonb, k text, p_required boolean default true)
returns uuid
language plpgsql
immutable
set search_path = ''
as $fn$
declare v text;
begin
  v := arc_private.req_text(p, k, p_required, 36);
  if v is null then return null; end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform arc_private.refuse('invalid_request', format('%s is not an id', k));
  end if;
  return v::uuid;
end;
$fn$;

create or replace function arc_private.req_int(p jsonb, k text, p_required boolean default true)
returns bigint
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  if p is null or jsonb_typeof(p -> k) is distinct from 'number' then
    if p_required or (p ? k and jsonb_typeof(p -> k) <> 'null') then
      perform arc_private.refuse('invalid_request', format('%s must be a number', k));
    end if;
    return null;
  end if;
  if (p ->> k) !~ '^[0-9]{1,15}$' then perform arc_private.refuse('invalid_request', format('%s must be a whole number', k)); end if;
  return (p ->> k)::bigint;
end;
$fn$;

create or replace function arc_private.req_words(p jsonb, k text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $fn$
declare v text[];
begin
  if p is null or not (p ? k) or jsonb_typeof(p -> k) = 'null' then return '{}'; end if;
  if jsonb_typeof(p -> k) <> 'array' or jsonb_array_length(p -> k) > 50 then
    perform arc_private.refuse('invalid_request', format('%s must be a short list', k));
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v from jsonb_array_elements_text(p -> k) x;
  if exists (select 1 from unnest(v) x where x !~ '^[A-Za-z0-9_.:/-]{1,120}$') then
    perform arc_private.refuse('invalid_request', format('%s holds a value that is not a scope or capability', k));
  end if;
  return v;
end;
$fn$;

create or replace function arc_private.req_code(p jsonb, k text, p_required boolean default true)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare v text;
begin
  v := arc_private.req_text(p, k, p_required, 60);
  if v is not null and v !~ '^[a-z][a-z0-9_]{1,60}$' then
    perform arc_private.refuse('invalid_request', format('%s is not a code', k));
  end if;
  return v;
end;
$fn$;

create or replace function arc_private.req_metadata(p jsonb, k text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare v jsonb;
begin
  v := coalesce(p -> k, '{}'::jsonb);
  if jsonb_typeof(v) = 'null' then return '{}'::jsonb; end if;
  if jsonb_typeof(v) <> 'object' or char_length(v::text) > 2000 then
    perform arc_private.refuse('invalid_request', format('%s must be a small object', k));
  end if;
  return v;
end;
$fn$;

-- a person may manage a tenant's connections if they are an operator or the
-- tenant's owner — re-checked here, whoever called.
create or replace function arc_private.require_manager(p_tenant uuid, p_actor uuid)
returns void
language plpgsql
stable
set search_path = ''
as $fn$
begin
  if p_actor is null or not (
       exists (select 1 from public.arc_admins a where a.user_id = p_actor)
    or exists (select 1 from public.tenant_members m where m.tenant_id = p_tenant and m.user_id = p_actor and m.role = 'owner')
  ) then
    perform arc_private.refuse('forbidden', 'managing this client''s connections needs an operator or the client''s owner');
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    perform arc_private.refuse('forbidden', 'the actor must be the signed-in caller');
  end if;
end;
$fn$;

create or replace function arc_private.legal_status(p_event text, p_from text, p_actor_type text)
returns text
language plpgsql
stable
set search_path = ''
as $fn$
declare v_to text;
begin
  if p_from not in ('authorization_pending', 'connected_unverified', 'verified', 'degraded',
                    'reauthorization_required', 'revoked', 'disconnected', 'failed') then
    perform arc_private.refuse('connection_status_unknown', 'the stored connection status is not one this build knows');
  end if;
  select r.to_status into v_to from public.connection_transition_rules r
   where r.event = p_event and r.from_status = p_from and r.actor_type = p_actor_type;
  if v_to is null then
    if exists (select 1 from public.connection_transition_rules r where r.event = p_event and r.from_status = p_from) then
      perform arc_private.refuse('forbidden', format('%s from %s is not something the %s may do', p_event, p_from, p_actor_type));
    end if;
    perform arc_private.refuse('illegal_transition', format('%s is not allowed from %s', p_event, p_from));
  end if;
  return v_to;
end;
$fn$;

create or replace function arc_private.record_event(
  p_tenant uuid, p_connection uuid, p_session uuid, p_event text, p_from text, p_to text,
  p_status_version bigint, p_actor_type text, p_actor uuid, p_reason text,
  p_correlation text, p_idempotency text, p_metadata jsonb
)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  insert into public.provider_connection_events (
    tenant_id, connection_id, session_id, event_type, from_status, to_status, status_version,
    actor_type, actor_id, reason_code, correlation_id, idempotency_key, metadata
  ) values (
    p_tenant, p_connection, p_session, p_event, p_from, p_to, p_status_version,
    p_actor_type, p_actor, p_reason, p_correlation, p_idempotency, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$fn$;

-- the safe shape of a connection. never a secret, never a reference.
create or replace function arc_private.connection_json(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'id', c.id, 'tenant_id', c.tenant_id, 'connector_key', c.connector_key,
    'connector_version', c.connector_version, 'auth_method', c.auth_method,
    'status', c.status, 'status_version', c.status_version,
    'external_account_id', c.external_account_id, 'external_account_label', c.external_account_label,
    'display_metadata', c.display_metadata, 'granted_scopes', to_jsonb(c.granted_scopes),
    'verified_capabilities', to_jsonb(c.verified_capabilities), 'credential_version', c.credential_version,
    'credential_hint', c.credential_hint, 'access_expires_at', c.access_expires_at,
    'refreshable', c.refreshable, 'last_verified_at', c.last_verified_at,
    'last_refresh_attempt_at', c.last_refresh_attempt_at, 'last_refresh_result', c.last_refresh_result,
    'health_status', c.health_status, 'health_reason', c.health_reason,
    'health_checked_at', c.health_checked_at, 'connected_by', c.connected_by,
    'created_at', c.created_at, 'updated_at', c.updated_at, 'ended_at', c.ended_at)
  from public.provider_connections c where c.id = p_id
$fn$;

create or replace function arc_private.credential_json(p_connection uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object('connection_id', v.connection_id, 'version', v.version, 'kind', v.kind,
                            'status', v.status, 'hint', v.hint, 'created_at', v.created_at, 'retired_at', v.retired_at)
    from arc_private.credential_versions v
   where v.connection_id = p_connection and v.status = 'active'
$fn$;

-- a replayed idempotency key: the connection as it is now, marked replayed.
create or replace function arc_private.replayed(p_tenant uuid, p_key text)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object('replayed', true, 'event_type', e.event_type,
                            'connection', arc_private.connection_json(e.connection_id),
                            'credential', arc_private.credential_json(e.connection_id))
    from public.provider_connection_events e
   where e.tenant_id = p_tenant and e.idempotency_key = p_key
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Vault, reached only from here
-- ---------------------------------------------------------------------------

-- store a new credential version and make it the only active one: the new
-- secret is written to Vault FIRST, then the old version is retired, then the
-- new version row is inserted — one transaction, so a failure anywhere leaves
-- the previous credential exactly as it was.
create or replace function arc_private.store_secret(
  p_tenant uuid, p_connection uuid, p_kind text, p_secret text, p_hint text, p_reason text
)
returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  v_version integer;
  v_secret  uuid;
begin
  if p_secret is null or char_length(p_secret) = 0 or char_length(p_secret) > 16384 then
    perform arc_private.refuse('invalid_credential', 'the credential is empty or too large');
  end if;
  select coalesce(max(v.version), 0) + 1 into v_version
    from arc_private.credential_versions v where v.connection_id = p_connection;
  v_secret := vault.create_secret(p_secret, format('arc130:%s:v%s', p_connection, v_version), 'ARC-130 tenant credential');
  update arc_private.credential_versions
     set status = 'retired', retired_at = now(), retire_reason = p_reason
   where connection_id = p_connection and status = 'active';
  insert into arc_private.credential_versions (connection_id, tenant_id, version, kind, status, vault_secret_id, hint)
  values (p_connection, p_tenant, v_version, p_kind, 'active', v_secret, p_hint);
  return v_version;
end;
$fn$;

-- delete retired secrets from Vault. each one in its own sub-transaction: a
-- failure is recorded as purge_failed (and an event) and never undoes the
-- retirement — a retired version resolves nothing whether or not its secret is
-- gone yet.
create or replace function arc_private.purge_retired(p_tenant uuid, p_connection uuid)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  r record;
  v_purged integer := 0;
  v_failed integer := 0;
begin
  for r in
    select v.id, v.version, v.vault_secret_id from arc_private.credential_versions v
     where v.connection_id = p_connection and v.tenant_id = p_tenant
       and v.status in ('retired', 'purge_failed') and v.vault_secret_id is not null
     order by v.version
  loop
    begin
      delete from vault.secrets s where s.id = r.vault_secret_id;
      update arc_private.credential_versions
         set status = 'purged', vault_secret_id = null, purged_at = now()
       where id = r.id;
      v_purged := v_purged + 1;
    exception when others then
      update arc_private.credential_versions set status = 'purge_failed' where id = r.id and status = 'retired';
      perform arc_private.record_event(p_tenant, p_connection, null, 'credential_purge_failed', null, null, null,
        'system', null, 'purge_failed', null, null, jsonb_build_object('credential_version', r.version));
      v_failed := v_failed + 1;
    end;
  end loop;
  if v_purged > 0 then
    perform arc_private.record_event(p_tenant, p_connection, null, 'credential_purged', null, null, null,
      'system', null, 'retired_credentials_purged', null, null, jsonb_build_object('purged', v_purged));
  end if;
  return jsonb_build_object('purged', v_purged, 'failed', v_failed);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. the operations
-- ---------------------------------------------------------------------------

create or replace function arc_private.begin_authorization(p jsonb, p_verifier text)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant    uuid    := arc_private.req_uuid(p, 'tenant_id');
  v_actor     uuid    := arc_private.req_uuid(p, 'actor_id');
  v_connector text    := arc_private.req_code(p, 'connector_key');
  v_cversion  bigint  := arc_private.req_int(p, 'connector_version');
  v_method    text    := arc_private.req_code(p, 'auth_method');
  v_purpose   text    := arc_private.req_code(p, 'purpose');
  v_target    uuid    := arc_private.req_uuid(p, 'target_connection_id', false);
  v_expected  bigint  := arc_private.req_int(p, 'expected_status_version', false);
  v_state     text    := arc_private.req_text(p, 'state_digest', true, 64);
  v_nonce     text    := arc_private.req_text(p, 'nonce_digest', false, 64);
  v_pkce      text    := arc_private.req_text(p, 'pkce_method', false, 8);
  v_scopes    text[]  := arc_private.req_words(p, 'requested_scopes');
  v_caps      text[]  := arc_private.req_words(p, 'requested_capabilities');
  v_redirect  text    := arc_private.req_text(p, 'redirect_uri', true, 500);
  v_return    text    := arc_private.req_text(p, 'return_path', true, 200);
  v_ttl       bigint  := arc_private.req_int(p, 'ttl_seconds');
  v_key       text    := arc_private.req_text(p, 'idempotency_key', true, 200);
  v_corr      text    := arc_private.req_text(p, 'correlation_id', false, 120);
  v_conn      public.provider_connections%rowtype;
  v_existing  arc_private.authorization_sessions%rowtype;
  v_to        text;
  v_secret    uuid;
  v_session   uuid;
  v_expires   timestamptz;
begin
  perform arc_private.require_manager(v_tenant, v_actor);
  if v_method <> 'oauth2' then perform arc_private.refuse('unsupported_auth_method', 'only an OAuth connection is authorised by redirect'); end if;
  if v_purpose not in ('connect', 'reauthorize', 'replace') then perform arc_private.refuse('invalid_request', 'purpose is connect, reauthorize or replace'); end if;
  if v_ttl < 60 or v_ttl > 900 then perform arc_private.refuse('invalid_request', 'an authorisation session lives between one and fifteen minutes'); end if;
  if v_pkce is not null and v_pkce <> 'S256' then perform arc_private.refuse('pkce_failed', 'only S256 PKCE is accepted'); end if;
  if (v_pkce is null) <> (p_verifier is null) then perform arc_private.refuse('pkce_failed', 'a PKCE method and verifier come together or not at all'); end if;
  if p_verifier is not null and p_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then perform arc_private.refuse('pkce_failed', 'the PKCE verifier is malformed'); end if;
  if v_state !~ '^[0-9a-f]{64}$' or (v_nonce is not null and v_nonce !~ '^[0-9a-f]{64}$') then
    perform arc_private.refuse('invalid_request', 'state and nonce are stored as SHA-256 digests only');
  end if;

  -- idempotency: the same request twice is one session.
  select * into v_existing from arc_private.authorization_sessions s
   where s.tenant_id = v_tenant and s.idempotency_key = v_key;
  if found then
    if v_existing.connector_key <> v_connector or v_existing.initiated_by <> v_actor or v_existing.state_digest <> v_state then
      perform arc_private.refuse('idempotency_conflict', 'this idempotency key was used for a different authorisation');
    end if;
    return jsonb_build_object('replayed', true, 'session_id', v_existing.id, 'connection_id', v_existing.connection_id,
                              'expires_at', v_existing.expires_at);
  end if;

  -- abuse control: a handful of open sessions per client, no more.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('arc130:sessions:' || v_tenant::text, 0));
  if (select count(*) from arc_private.authorization_sessions s
       where s.tenant_id = v_tenant and s.consumed_at is null and s.expires_at > now()) >= 5 then
    perform arc_private.refuse('rate_limited', 'too many authorisations are already open for this client — finish or wait for one');
  end if;

  if v_purpose = 'connect' then
    if v_target is not null then perform arc_private.refuse('invalid_request', 'a new connection names no target'); end if;
    select * into v_conn from public.provider_connections c
     where c.tenant_id = v_tenant and c.connector_key = v_connector and c.status not in ('revoked', 'disconnected', 'failed')
     for update;
    if found and v_conn.status <> 'authorization_pending' then
      perform arc_private.refuse('connection_exists', 'this client already has that provider connected — reauthorise or replace it');
    end if;
    if not found then
      insert into public.provider_connections (tenant_id, connector_key, connector_version, auth_method, status, connected_by)
      values (v_tenant, v_connector, v_cversion, 'oauth2', 'authorization_pending', v_actor)
      returning * into v_conn;
      perform arc_private.record_event(v_tenant, v_conn.id, null, 'begin_authorization', null, 'authorization_pending',
        v_conn.status_version, 'manager', v_actor, 'connection_started', v_corr, null, '{}'::jsonb);
    end if;
  else
    if v_target is null or v_expected is null then
      perform arc_private.refuse('invalid_request', 'reauthorising or replacing names the connection and the version read');
    end if;
    select * into v_conn from public.provider_connections c where c.id = v_target and c.tenant_id = v_tenant for update;
    if not found then perform arc_private.refuse('not_found', 'no such connection for this client'); end if;
    if v_conn.connector_key <> v_connector then perform arc_private.refuse('session_binding_mismatch', 'the connection is for another provider'); end if;
    if v_conn.status_version <> v_expected then
      perform arc_private.refuse('stale_version', format('the connection is at version %s, not %s — reload before acting', v_conn.status_version, v_expected));
    end if;
  end if;

  v_to := arc_private.legal_status('begin_authorization', v_conn.status, 'manager');
  if v_to <> v_conn.status then
    update public.provider_connections
       set status = v_to, status_version = status_version + 1
     where id = v_conn.id
     returning * into v_conn;
  end if;

  if p_verifier is not null then
    v_secret := vault.create_secret(p_verifier, format('arc130:pkce:%s', v_state), 'ARC-130 PKCE verifier (single use)');
  end if;
  v_expires := now() + make_interval(secs => v_ttl);
  insert into arc_private.authorization_sessions (
    tenant_id, connection_id, connector_key, connector_version, purpose, initiated_by, state_digest,
    nonce_digest, pkce_method, pkce_verifier_secret_id, requested_scopes, requested_capabilities,
    redirect_uri, return_path, expected_status_version, expires_at, idempotency_key, correlation_id
  ) values (
    v_tenant, v_conn.id, v_connector, v_cversion, v_purpose, v_actor, v_state,
    v_nonce, v_pkce, v_secret, v_scopes, v_caps,
    v_redirect, v_return, v_conn.status_version, v_expires, v_key, v_corr
  ) returning id into v_session;

  perform arc_private.record_event(v_tenant, v_conn.id, v_session, 'authorization_initiated', v_conn.status, v_conn.status,
    v_conn.status_version, 'manager', v_actor, v_purpose, v_corr, null,
    jsonb_build_object('purpose', v_purpose, 'scopes', to_jsonb(v_scopes), 'pkce', coalesce(v_pkce, 'none')));

  return jsonb_build_object('replayed', false, 'session_id', v_session, 'connection_id', v_conn.id, 'expires_at', v_expires);
end;
$fn$;

-- the one-time claim of a callback's state. refusals that are security events
-- are RECORDED and RETURNED (not raised), so the record survives the refusal.
create or replace function arc_private.claim_authorization(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_state   text := arc_private.req_text(p, 'state_digest', true, 64);
  v_actor   uuid := arc_private.req_uuid(p, 'actor_id');
  s         arc_private.authorization_sessions%rowtype;
  v_conn    public.provider_connections%rowtype;
  v_to      text;
  v_verifier text;
begin
  if v_state !~ '^[0-9a-f]{64}$' then perform arc_private.refuse('invalid_state', 'the authorisation state is malformed'); end if;
  select * into s from arc_private.authorization_sessions x where x.state_digest = v_state for update;
  if not found then
    return jsonb_build_object('refused', 'invalid_state', 'message', 'no authorisation matches this state — start again');
  end if;

  if s.consumed_at is not null then
    if s.outcome = 'completed' and s.initiated_by = v_actor then
      return jsonb_build_object('refused', null, 'already_completed', true, 'session_id', s.id, 'tenant_id', s.tenant_id,
        'connection_id', s.connection_id, 'connector_key', s.connector_key, 'connector_version', s.connector_version,
        'purpose', s.purpose, 'return_path', s.return_path);
    end if;
    perform arc_private.record_event(s.tenant_id, s.connection_id, s.id, 'authorization_replayed', null, null, null,
      'manager', v_actor, 'state_replayed', s.correlation_id, null, '{}'::jsonb);
    return jsonb_build_object('refused', 'state_replayed', 'message', 'this authorisation was already used — start again');
  end if;

  if s.initiated_by <> v_actor then
    perform arc_private.record_event(s.tenant_id, s.connection_id, s.id, 'security_denial', null, null, null,
      'manager', v_actor, 'session_binding_mismatch', s.correlation_id, null, '{}'::jsonb);
    return jsonb_build_object('refused', 'session_binding_mismatch', 'message', 'this authorisation was started by someone else');
  end if;

  if s.expires_at <= now() then
    if s.pkce_verifier_secret_id is not null then
      delete from vault.secrets v where v.id = s.pkce_verifier_secret_id;
    end if;
    update arc_private.authorization_sessions
       set consumed_at = now(), outcome = 'expired', failure_code = 'state_expired', pkce_verifier_secret_id = null
     where id = s.id;
    select * into v_conn from public.provider_connections c where c.id = s.connection_id for update;
    v_to := arc_private.legal_status('authorization_failed', v_conn.status, 'system');
    if v_to <> v_conn.status then
      update public.provider_connections set status = v_to, status_version = status_version + 1 where id = v_conn.id;
    end if;
    perform arc_private.record_event(s.tenant_id, s.connection_id, s.id, 'authorization_expired', v_conn.status, v_to, null,
      'system', null, 'state_expired', s.correlation_id, null, '{}'::jsonb);
    return jsonb_build_object('refused', 'state_expired', 'message', 'this authorisation took too long — start again');
  end if;

  -- membership can change between the redirect and the callback.
  if not (exists (select 1 from public.arc_admins a where a.user_id = v_actor)
       or exists (select 1 from public.tenant_members m where m.tenant_id = s.tenant_id and m.user_id = v_actor and m.role = 'owner')) then
    perform arc_private.record_event(s.tenant_id, s.connection_id, s.id, 'security_denial', null, null, null,
      'manager', v_actor, 'forbidden', s.correlation_id, null, '{}'::jsonb);
    return jsonb_build_object('refused', 'forbidden', 'message', 'you can no longer manage this client''s connections');
  end if;

  if s.pkce_verifier_secret_id is not null then
    select d.decrypted_secret into v_verifier from vault.decrypted_secrets d where d.id = s.pkce_verifier_secret_id;
    if v_verifier is null then perform arc_private.refuse('pkce_failed', 'the PKCE verifier for this authorisation is gone'); end if;
    delete from vault.secrets v where v.id = s.pkce_verifier_secret_id;
  end if;
  update arc_private.authorization_sessions
     set consumed_at = now(), outcome = 'exchanging', pkce_verifier_secret_id = null
   where id = s.id;

  return jsonb_build_object('refused', null, 'already_completed', false, 'session_id', s.id, 'tenant_id', s.tenant_id,
    'connection_id', s.connection_id, 'connector_key', s.connector_key, 'connector_version', s.connector_version,
    'purpose', s.purpose, 'requested_scopes', to_jsonb(s.requested_scopes),
    'requested_capabilities', to_jsonb(s.requested_capabilities), 'redirect_uri', s.redirect_uri,
    'return_path', s.return_path, 'nonce_digest', s.nonce_digest, 'verifier', v_verifier);
end;
$fn$;

create or replace function arc_private.complete_authorization(p jsonb, p_secret text)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_session  uuid    := arc_private.req_uuid(p, 'session_id');
  v_tenant   uuid    := arc_private.req_uuid(p, 'tenant_id');
  v_actor    uuid    := arc_private.req_uuid(p, 'actor_id');
  v_account  text    := arc_private.req_text(p, 'external_account_id', true, 255);
  v_label    text    := arc_private.req_text(p, 'external_account_label', false, 200);
  v_meta     jsonb   := arc_private.req_metadata(p, 'display_metadata');
  v_scopes   text[]  := arc_private.req_words(p, 'granted_scopes');
  v_expires  text    := arc_private.req_text(p, 'access_expires_at', false, 40);
  v_confirm  boolean := coalesce((p ->> 'confirm_account_replacement')::boolean, false);
  v_refresh  boolean := coalesce((p ->> 'refreshable')::boolean, false);
  v_corr     text    := arc_private.req_text(p, 'correlation_id', false, 120);
  v_key      text;
  s          arc_private.authorization_sessions%rowtype;
  v_conn     public.provider_connections%rowtype;
  v_to       text;
  v_version  integer;
  v_replaced boolean := false;
  v_from     text;
begin
  v_key := 'oauth:complete:' || v_session::text;
  if exists (select 1 from public.provider_connection_events e where e.tenant_id = v_tenant and e.idempotency_key = v_key) then
    return arc_private.replayed(v_tenant, v_key);
  end if;

  select * into s from arc_private.authorization_sessions x where x.id = v_session for update;
  if not found or s.tenant_id <> v_tenant then perform arc_private.refuse('invalid_state', 'no such authorisation for this client'); end if;
  if s.initiated_by <> v_actor then perform arc_private.refuse('session_binding_mismatch', 'this authorisation was started by someone else'); end if;
  if s.outcome <> 'exchanging' then perform arc_private.refuse('state_replayed', 'this authorisation is not awaiting completion'); end if;
  perform arc_private.require_manager(v_tenant, v_actor);

  select * into v_conn from public.provider_connections c where c.id = s.connection_id and c.tenant_id = v_tenant for update;
  if v_conn.status_version <> s.expected_status_version then
    perform arc_private.refuse('stale_version', 'the connection changed while this authorisation was open — start again');
  end if;
  if v_conn.external_account_id is not null and v_conn.external_account_id <> v_account then
    if s.purpose <> 'replace' then
      perform arc_private.refuse('account_mismatch', 'a different account was authorised than the one this connection belongs to');
    end if;
    if not v_confirm then
      perform arc_private.refuse('account_replacement_unconfirmed', 'replacing the connected account needs explicit confirmation');
    end if;
    v_replaced := true;
  end if;

  v_from := v_conn.status;
  v_to := arc_private.legal_status('complete_authorization', v_from, 'manager');
  v_version := arc_private.store_secret(v_tenant, v_conn.id, 'oauth_tokens', p_secret, null, 'reauthorized');

  update public.provider_connections
     set status = v_to,
         status_version = status_version + 1,
         external_account_id = v_account,
         external_account_label = v_label,
         display_metadata = v_meta,
         granted_scopes = v_scopes,
         verified_capabilities = '{}',
         credential_version = v_version,
         credential_hint = null,
         access_expires_at = v_expires::timestamptz,
         refreshable = v_refresh,
         refresh_lease_token = null,
         refresh_lease_until = null,
         health_status = 'unverified',
         health_reason = null,
         connected_by = coalesce(connected_by, v_actor)
   where id = v_conn.id
   returning * into v_conn;

  update arc_private.authorization_sessions set outcome = 'completed' where id = s.id;

  if v_replaced then
    perform arc_private.record_event(v_tenant, v_conn.id, s.id, 'connection_replaced', null, null, v_conn.status_version,
      'manager', v_actor, 'account_replaced', v_corr, null, jsonb_build_object('explicitly_confirmed', true));
  end if;
  perform arc_private.record_event(v_tenant, v_conn.id, s.id, 'complete_authorization', v_from, v_to, v_conn.status_version,
    'manager', v_actor, 'authorization_completed', v_corr, v_key,
    jsonb_build_object('credential_version', v_version, 'scopes', to_jsonb(v_scopes), 'purpose', s.purpose));

  return jsonb_build_object('replayed', false, 'connection', arc_private.connection_json(v_conn.id),
                            'credential', arc_private.credential_json(v_conn.id));
end;
$fn$;

create or replace function arc_private.fail_authorization(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_session uuid := arc_private.req_uuid(p, 'session_id');
  v_tenant  uuid := arc_private.req_uuid(p, 'tenant_id');
  v_actor   uuid := arc_private.req_uuid(p, 'actor_id', false);
  v_code    text := arc_private.req_code(p, 'code');
  s         arc_private.authorization_sessions%rowtype;
  v_conn    public.provider_connections%rowtype;
  v_to      text;
begin
  select * into s from arc_private.authorization_sessions x where x.id = v_session and x.tenant_id = v_tenant for update;
  if not found then perform arc_private.refuse('not_found', 'no such authorisation for this client'); end if;
  if s.outcome in ('completed', 'denied', 'expired', 'failed') then
    return jsonb_build_object('changed', false);
  end if;
  if v_actor is not null and s.initiated_by <> v_actor then
    perform arc_private.refuse('session_binding_mismatch', 'this authorisation was started by someone else');
  end if;
  if s.pkce_verifier_secret_id is not null then
    delete from vault.secrets v where v.id = s.pkce_verifier_secret_id;
  end if;
  update arc_private.authorization_sessions
     set consumed_at = coalesce(consumed_at, now()), pkce_verifier_secret_id = null,
         outcome = case when v_code = 'provider_denied' then 'denied' else 'failed' end, failure_code = v_code
   where id = s.id;
  select * into v_conn from public.provider_connections c where c.id = s.connection_id for update;
  v_to := arc_private.legal_status('authorization_failed', v_conn.status, 'system');
  if v_to <> v_conn.status then
    update public.provider_connections set status = v_to, status_version = status_version + 1 where id = v_conn.id
    returning * into v_conn;
  end if;
  perform arc_private.record_event(v_tenant, v_conn.id, s.id,
    case when v_code = 'provider_denied' then 'authorization_denied' else 'authorization_failed' end,
    null, v_to, v_conn.status_version, case when v_actor is null then 'system' else 'manager' end, v_actor,
    v_code, s.correlation_id, null, '{}'::jsonb);
  return jsonb_build_object('changed', true);
end;
$fn$;

create or replace function arc_private.store_api_key(p jsonb, p_secret text)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant    uuid    := arc_private.req_uuid(p, 'tenant_id');
  v_actor     uuid    := arc_private.req_uuid(p, 'actor_id');
  v_id        uuid    := arc_private.req_uuid(p, 'connection_id', false);
  v_connector text    := arc_private.req_code(p, 'connector_key');
  v_cversion  bigint  := arc_private.req_int(p, 'connector_version');
  v_expected  bigint  := arc_private.req_int(p, 'expected_status_version', false);
  v_expcred   bigint  := arc_private.req_int(p, 'expected_credential_version', false);
  v_hint      text    := arc_private.req_text(p, 'hint', false, 4);
  v_verified  boolean := coalesce((p ->> 'verified')::boolean, false);
  v_account   text    := arc_private.req_text(p, 'external_account_id', false, 255);
  v_label     text    := arc_private.req_text(p, 'external_account_label', false, 200);
  v_meta      jsonb   := arc_private.req_metadata(p, 'display_metadata');
  v_caps      text[]  := arc_private.req_words(p, 'verified_capabilities');
  v_confirm   boolean := coalesce((p ->> 'confirm_account_replacement')::boolean, false);
  v_key       text    := arc_private.req_text(p, 'idempotency_key', true, 200);
  v_corr      text    := arc_private.req_text(p, 'correlation_id', false, 120);
  v_conn      public.provider_connections%rowtype;
  v_from      text;
  v_to        text;
  v_event     text;
  v_version   integer;
begin
  perform arc_private.require_manager(v_tenant, v_actor);
  if exists (select 1 from public.provider_connection_events e where e.tenant_id = v_tenant and e.idempotency_key = v_key) then
    return arc_private.replayed(v_tenant, v_key);
  end if;
  if v_verified and v_account is null then
    perform arc_private.refuse('invalid_request', 'a verified key names the account it belongs to');
  end if;

  if v_id is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('arc130:connect:' || v_tenant::text || ':' || v_connector, 0));
    if exists (select 1 from public.provider_connections c where c.tenant_id = v_tenant and c.connector_key = v_connector
                 and c.status not in ('revoked', 'disconnected', 'failed')) then
      perform arc_private.refuse('connection_exists', 'this client already has that provider connected — rotate its key instead');
    end if;
    insert into public.provider_connections (tenant_id, connector_key, connector_version, auth_method, status, connected_by)
    values (v_tenant, v_connector, v_cversion, 'api_key', 'authorization_pending', v_actor)
    returning * into v_conn;
    v_from := null;
    v_event := 'complete_authorization';
  else
    select * into v_conn from public.provider_connections c where c.id = v_id and c.tenant_id = v_tenant for update;
    if not found or v_conn.connector_key <> v_connector then perform arc_private.refuse('not_found', 'no such connection for this client'); end if;
    if v_conn.auth_method <> 'api_key' then perform arc_private.refuse('unsupported_auth_method', 'this connection is not an API-key connection'); end if;
    if v_expected is null or v_expcred is null or v_conn.status_version <> v_expected or v_conn.credential_version <> v_expcred then
      perform arc_private.refuse('stale_version', 'the connection changed since it was read — reload before rotating');
    end if;
    v_from := v_conn.status;
    v_event := case when v_conn.status in ('verified', 'degraded', 'connected_unverified') then 'credential_rotated' else 'complete_authorization' end;
    if v_event = 'credential_rotated' and v_conn.status in ('verified', 'degraded') and not v_verified then
      perform arc_private.refuse('invalid_credential', 'a working key is replaced only by one the provider has accepted');
    end if;
    if v_conn.external_account_id is not null and v_account is not null and v_account <> v_conn.external_account_id and not v_confirm then
      perform arc_private.refuse('account_replacement_unconfirmed', 'the new key belongs to a different account — confirm the replacement explicitly');
    end if;
  end if;

  v_to := arc_private.legal_status(v_event, v_conn.status, 'manager');
  v_version := arc_private.store_secret(v_tenant, v_conn.id, 'api_key', p_secret, v_hint, 'rotated');

  -- step 1: the credential is stored (complete_authorization or credential_rotated).
  update public.provider_connections
     set status = v_to,
         status_version = status_version + 1,
         external_account_id = coalesce(v_account, external_account_id),
         external_account_label = coalesce(v_label, external_account_label),
         verified_capabilities = case when v_verified and v_to = 'verified' then verified_capabilities else '{}' end,
         credential_version = v_version,
         credential_hint = v_hint,
         health_status = case when v_verified and v_to = 'verified' then health_status else 'unverified' end
   where id = v_conn.id
   returning * into v_conn;
  perform arc_private.record_event(v_tenant, v_conn.id, null, v_event, v_from, v_conn.status, v_conn.status_version,
    'manager', v_actor, case when v_id is null then 'api_key_stored' else 'api_key_rotated' end, v_corr, v_key,
    jsonb_build_object('credential_version', v_version, 'verified', v_verified));

  -- step 2: the provider already accepted it, so it is verified — a separate, legal step.
  if v_verified then
    v_from := v_conn.status;
    v_to := arc_private.legal_status('verification_succeeded', v_from, 'manager');
    update public.provider_connections
       set status = v_to,
           status_version = status_version + 1,
           display_metadata = v_meta,
           verified_capabilities = v_caps,
           last_verified_at = now(),
           health_status = 'healthy',
           health_reason = null,
           health_checked_at = now()
     where id = v_conn.id
     returning * into v_conn;
    perform arc_private.record_event(v_tenant, v_conn.id, null, 'verification_succeeded', v_from, v_to, v_conn.status_version,
      'manager', v_actor, 'api_key_verified', v_corr, null, jsonb_build_object('capabilities', to_jsonb(v_caps)));
  end if;
  perform arc_private.purge_retired(v_tenant, v_conn.id);
  return jsonb_build_object('replayed', false, 'connection', arc_private.connection_json(v_conn.id),
                            'credential', arc_private.credential_json(v_conn.id));
end;
$fn$;

create or replace function arc_private.record_connection_event(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant   uuid   := arc_private.req_uuid(p, 'tenant_id');
  v_id       uuid   := arc_private.req_uuid(p, 'connection_id');
  v_event    text   := arc_private.req_code(p, 'event');
  v_atype    text   := arc_private.req_code(p, 'actor_type');
  v_actor    uuid   := arc_private.req_uuid(p, 'actor_id', false);
  v_expected bigint := arc_private.req_int(p, 'expected_status_version', false);
  v_reason   text   := arc_private.req_code(p, 'reason_code');
  v_key      text   := arc_private.req_text(p, 'idempotency_key', true, 200);
  v_corr     text   := arc_private.req_text(p, 'correlation_id', false, 120);
  v_meta     jsonb  := arc_private.req_metadata(p, 'metadata');
  v_ver      jsonb  := p -> 'verification';
  v_health   jsonb  := p -> 'health';
  v_conn     public.provider_connections%rowtype;
  v_from     text;
  v_to       text;
  v_account  text;
  v_hstatus  text;
begin
  if v_event not in ('verification_succeeded', 'verification_failed', 'provider_degraded', 'reauthorization_required') then
    perform arc_private.refuse('illegal_transition', format('%s is not recorded this way', v_event));
  end if;
  if v_atype not in ('manager', 'system') then perform arc_private.refuse('invalid_request', 'actor_type is manager or system'); end if;
  if v_atype = 'manager' then
    perform arc_private.require_manager(v_tenant, v_actor);
    if v_expected is null then perform arc_private.refuse('stale_version', 'expected_status_version is required for a person''s change'); end if;
  elsif v_actor is not null then
    perform arc_private.refuse('invalid_request', 'the system acts without a person');
  end if;
  if exists (select 1 from public.provider_connection_events e where e.tenant_id = v_tenant and e.idempotency_key = v_key) then
    return arc_private.replayed(v_tenant, v_key);
  end if;

  select * into v_conn from public.provider_connections c where c.id = v_id and c.tenant_id = v_tenant for update;
  if not found then perform arc_private.refuse('not_found', 'no such connection for this client'); end if;
  if v_expected is not null and v_conn.status_version <> v_expected then
    perform arc_private.refuse('stale_version', format('the connection is at version %s, not %s — reload before acting', v_conn.status_version, v_expected));
  end if;
  v_from := v_conn.status;
  v_to := arc_private.legal_status(v_event, v_from, v_atype);

  if v_event in ('verification_succeeded', 'verification_failed') then
    if v_ver is null or jsonb_typeof(v_ver) <> 'object' then perform arc_private.refuse('invalid_request', 'a verification result is required'); end if;
    v_account := arc_private.req_text(v_ver, 'account_id', true, 255);
    if v_conn.external_account_id is not null and v_account <> v_conn.external_account_id then
      perform arc_private.record_event(v_tenant, v_id, null, 'security_denial', v_from, v_from, v_conn.status_version,
        v_atype, v_actor, 'account_mismatch', v_corr, null, '{}'::jsonb);
      v_event := 'verification_failed';
      v_to := arc_private.legal_status('verification_failed', v_from, v_atype);
      v_reason := 'account_mismatch';
    end if;
    update public.provider_connections
       set status = v_to,
           status_version = status_version + 1,
           granted_scopes = arc_private.req_words(v_ver, 'granted_scopes'),
           verified_capabilities = case when v_event = 'verification_succeeded' then arc_private.req_words(v_ver, 'verified_capabilities') else '{}' end,
           external_account_label = coalesce(arc_private.req_text(v_ver, 'label', false, 200), external_account_label),
           last_verified_at = case when v_event = 'verification_succeeded' then now() else last_verified_at end,
           health_status = case when v_event = 'verification_succeeded' then 'healthy' else 'failing' end,
           health_reason = case when v_event = 'verification_succeeded' then null else v_reason end,
           health_checked_at = now()
     where id = v_id
     returning * into v_conn;
  else
    v_hstatus := case when v_event = 'provider_degraded' then 'degraded' else 'failing' end;
    if v_health is not null and jsonb_typeof(v_health) = 'object' and (v_health ->> 'status') in ('degraded', 'failing') then
      v_hstatus := v_health ->> 'status';
    end if;
    update public.provider_connections
       set status = v_to,
           status_version = status_version + 1,
           verified_capabilities = case when v_to = 'reauthorization_required' then '{}' else verified_capabilities end,
           health_status = v_hstatus,
           health_reason = v_reason,
           health_checked_at = now(),
           refresh_lease_token = case when v_to = 'reauthorization_required' then null else refresh_lease_token end,
           refresh_lease_until = case when v_to = 'reauthorization_required' then null else refresh_lease_until end
     where id = v_id
     returning * into v_conn;
  end if;

  perform arc_private.record_event(v_tenant, v_id, null, v_event, v_from, v_to, v_conn.status_version,
    v_atype, v_actor, v_reason, v_corr, v_key, v_meta);
  return jsonb_build_object('replayed', false, 'connection', arc_private.connection_json(v_id),
                            'credential', arc_private.credential_json(v_id));
end;
$fn$;

create or replace function arc_private.end_connection(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant   uuid   := arc_private.req_uuid(p, 'tenant_id');
  v_id       uuid   := arc_private.req_uuid(p, 'connection_id');
  v_event    text   := arc_private.req_code(p, 'event');
  v_atype    text   := arc_private.req_code(p, 'actor_type');
  v_actor    uuid   := arc_private.req_uuid(p, 'actor_id', false);
  v_expected bigint := arc_private.req_int(p, 'expected_status_version', false);
  v_revoc    text   := arc_private.req_code(p, 'provider_revocation');
  v_reason   text   := arc_private.req_code(p, 'reason_code');
  v_key      text   := arc_private.req_text(p, 'idempotency_key', true, 200);
  v_corr     text   := arc_private.req_text(p, 'correlation_id', false, 120);
  v_conn     public.provider_connections%rowtype;
  v_from     text;
  v_to       text;
  v_retired  integer;
  v_purge    jsonb;
begin
  if v_event not in ('disconnect', 'revoke') then perform arc_private.refuse('illegal_transition', 'ending is disconnect or revoke'); end if;
  if v_revoc not in ('revoked', 'unsupported', 'ambiguous', 'not_attempted') then
    perform arc_private.refuse('invalid_request', 'provider_revocation is revoked, unsupported, ambiguous or not_attempted');
  end if;
  if v_atype = 'manager' then
    perform arc_private.require_manager(v_tenant, v_actor);
    if v_expected is null then perform arc_private.refuse('stale_version', 'expected_status_version is required to end a connection'); end if;
  elsif v_atype = 'system' then
    if v_actor is not null then perform arc_private.refuse('invalid_request', 'the system acts without a person'); end if;
  else
    perform arc_private.refuse('invalid_request', 'actor_type is manager or system');
  end if;
  if exists (select 1 from public.provider_connection_events e where e.tenant_id = v_tenant and e.idempotency_key = v_key) then
    return arc_private.replayed(v_tenant, v_key);
  end if;

  select * into v_conn from public.provider_connections c where c.id = v_id and c.tenant_id = v_tenant for update;
  if not found then perform arc_private.refuse('not_found', 'no such connection for this client'); end if;
  if v_expected is not null and v_conn.status_version <> v_expected then
    perform arc_private.refuse('stale_version', format('the connection is at version %s, not %s — reload before acting', v_conn.status_version, v_expected));
  end if;
  v_from := v_conn.status;
  v_to := arc_private.legal_status(v_event, v_from, v_atype);

  -- local use stops HERE, in this transaction, whatever the provider said.
  update arc_private.credential_versions
     set status = 'retired', retired_at = now(), retire_reason = v_event
   where connection_id = v_id and status = 'active';
  get diagnostics v_retired = row_count;

  update public.provider_connections
     set status = v_to, status_version = status_version + 1, ended_at = now(),
         verified_capabilities = '{}', refresh_lease_token = null, refresh_lease_until = null,
         health_status = 'failing', health_reason = v_event, health_checked_at = now()
   where id = v_id
   returning * into v_conn;

  -- open authorisation sessions for it can never complete now.
  update arc_private.authorization_sessions
     set consumed_at = now(), outcome = 'failed', failure_code = 'connection_ended'
   where connection_id = v_id and consumed_at is null;

  perform arc_private.record_event(v_tenant, v_id, null, v_event, v_from, v_to, v_conn.status_version,
    v_atype, v_actor, v_reason, v_corr, v_key, jsonb_build_object('provider_revocation', v_revoc));
  if v_retired > 0 then
    perform arc_private.record_event(v_tenant, v_id, null, 'credential_retired', null, null, v_conn.status_version,
      v_atype, v_actor, v_event, v_corr, null, jsonb_build_object('retired', v_retired));
  end if;
  v_purge := arc_private.purge_retired(v_tenant, v_id);

  return jsonb_build_object('replayed', false, 'connection', arc_private.connection_json(v_id), 'credential', null,
                            'purge', v_purge);
end;
$fn$;

create or replace function arc_private.resolve_credential(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant    uuid := arc_private.req_uuid(p, 'tenant_id');
  v_id        uuid := arc_private.req_uuid(p, 'connection_id');
  v_connector text := arc_private.req_code(p, 'connector_key');
  v_operation text := arc_private.req_code(p, 'operation');
  v_cap       text := arc_private.req_code(p, 'capability', false);
  v_conn      public.provider_connections%rowtype;
  v_cred      arc_private.credential_versions%rowtype;
  v_secret    text;
begin
  if v_operation not in ('provider_operation', 'verify', 'refresh', 'revoke') then
    perform arc_private.refuse('operation_not_permitted', 'a credential is resolved only for a named operation');
  end if;
  select * into v_conn from public.provider_connections c where c.id = v_id and c.tenant_id = v_tenant for share;
  -- another tenant's connection and no connection are the same answer.
  if not found or v_conn.connector_key <> v_connector then
    perform arc_private.refuse('not_found', 'no such connection for this client');
  end if;
  if v_conn.status not in ('authorization_pending', 'connected_unverified', 'verified', 'degraded',
                           'reauthorization_required', 'revoked', 'disconnected', 'failed') then
    perform arc_private.refuse('connection_status_unknown', 'the stored connection status is not one this build knows');
  end if;
  if v_operation = 'provider_operation' then
    if v_conn.status not in ('verified', 'degraded') then
      perform arc_private.refuse('credential_unavailable', format('the connection is %s — nothing may use it', v_conn.status));
    end if;
    if v_cap is null or not (v_cap = any (v_conn.verified_capabilities)) then
      perform arc_private.refuse('operation_not_permitted', 'the connection is not verified for that capability');
    end if;
  elsif v_operation in ('verify', 'refresh') then
    if v_conn.status not in ('connected_unverified', 'verified', 'degraded') then
      perform arc_private.refuse('credential_unavailable', format('the connection is %s', v_conn.status));
    end if;
  elsif v_conn.status in ('revoked', 'disconnected', 'failed', 'authorization_pending') then
    perform arc_private.refuse('credential_unavailable', format('the connection is %s', v_conn.status));
  end if;

  select * into v_cred from arc_private.credential_versions v
   where v.connection_id = v_id and v.tenant_id = v_tenant and v.status = 'active';
  if not found or v_cred.version <> v_conn.credential_version or v_cred.vault_secret_id is null then
    perform arc_private.refuse('credential_unavailable', 'no active credential is stored for this connection');
  end if;
  select d.decrypted_secret into v_secret from vault.decrypted_secrets d where d.id = v_cred.vault_secret_id;
  if v_secret is null then perform arc_private.refuse('credential_unavailable', 'the stored credential could not be read'); end if;
  return jsonb_build_object('secret', v_secret, 'credential_version', v_cred.version, 'access_expires_at', v_conn.access_expires_at);
end;
$fn$;

create or replace function arc_private.begin_refresh(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant    uuid   := arc_private.req_uuid(p, 'tenant_id');
  v_id        uuid   := arc_private.req_uuid(p, 'connection_id');
  v_connector text   := arc_private.req_code(p, 'connector_key');
  v_expcred   bigint := arc_private.req_int(p, 'expected_credential_version');
  v_seconds   bigint := arc_private.req_int(p, 'lease_seconds');
  v_conn      public.provider_connections%rowtype;
  v_lease     uuid;
begin
  if v_seconds < 5 or v_seconds > 120 then perform arc_private.refuse('invalid_request', 'a refresh lease is 5 to 120 seconds'); end if;
  select * into v_conn from public.provider_connections c where c.id = v_id and c.tenant_id = v_tenant for update;
  if not found or v_conn.connector_key <> v_connector then perform arc_private.refuse('not_found', 'no such connection for this client'); end if;
  if v_conn.status not in ('connected_unverified', 'verified', 'degraded') or not v_conn.refreshable then
    perform arc_private.refuse('credential_unavailable', 'this connection cannot be refreshed');
  end if;
  if v_conn.credential_version <> v_expcred then
    perform arc_private.refuse('stale_version', 'the credential was already rotated — use the current one');
  end if;
  if v_conn.refresh_lease_until is not null and v_conn.refresh_lease_until > now() then
    perform arc_private.refuse('refresh_in_progress', 'another refresh of this connection is in progress');
  end if;
  v_lease := gen_random_uuid();
  update public.provider_connections
     set refresh_lease_token = v_lease, refresh_lease_until = now() + make_interval(secs => v_seconds),
         last_refresh_attempt_at = now()
   where id = v_id;
  return jsonb_build_object('lease_token', v_lease, 'credential_version', v_conn.credential_version);
end;
$fn$;

create or replace function arc_private.commit_refresh(p jsonb, p_secret text)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant    uuid    := arc_private.req_uuid(p, 'tenant_id');
  v_id        uuid    := arc_private.req_uuid(p, 'connection_id');
  v_connector text    := arc_private.req_code(p, 'connector_key');
  v_lease     uuid    := arc_private.req_uuid(p, 'lease_token');
  v_expcred   bigint  := arc_private.req_int(p, 'expected_credential_version');
  v_expires   text    := arc_private.req_text(p, 'access_expires_at', false, 40);
  v_refresh   boolean := coalesce((p ->> 'refreshable')::boolean, false);
  v_rotated   boolean := coalesce((p ->> 'rotated')::boolean, false);
  v_key       text    := arc_private.req_text(p, 'idempotency_key', true, 200);
  v_corr      text    := arc_private.req_text(p, 'correlation_id', false, 120);
  v_conn      public.provider_connections%rowtype;
  v_to        text;
  v_version   integer;
begin
  if exists (select 1 from public.provider_connection_events e where e.tenant_id = v_tenant and e.idempotency_key = v_key) then
    return arc_private.replayed(v_tenant, v_key);
  end if;
  select * into v_conn from public.provider_connections c where c.id = v_id and c.tenant_id = v_tenant for update;
  if not found or v_conn.connector_key <> v_connector then perform arc_private.refuse('not_found', 'no such connection for this client'); end if;
  if v_conn.refresh_lease_token is distinct from v_lease or v_conn.refresh_lease_until is null or v_conn.refresh_lease_until <= now() then
    perform arc_private.refuse('refresh_in_progress', 'this refresh no longer holds the lease — its result is discarded');
  end if;
  if v_conn.credential_version <> v_expcred then
    perform arc_private.refuse('stale_version', 'the credential was rotated by someone else');
  end if;
  v_to := arc_private.legal_status('credential_rotated', v_conn.status, 'system');
  v_version := arc_private.store_secret(v_tenant, v_id, 'oauth_tokens', p_secret, null, 'refreshed');
  update public.provider_connections
     set status_version = status_version + 1,
         credential_version = v_version,
         access_expires_at = v_expires::timestamptz,
         granted_scopes = case when p ? 'granted_scopes' and jsonb_typeof(p -> 'granted_scopes') = 'array'
                               then arc_private.req_words(p, 'granted_scopes') else granted_scopes end,
         refreshable = v_refresh,
         last_refresh_result = case when v_rotated then 'rotated' else 'succeeded' end,
         refresh_lease_token = null, refresh_lease_until = null
   where id = v_id
   returning * into v_conn;
  perform arc_private.record_event(v_tenant, v_id, null, 'credential_rotated', v_to, v_to, v_conn.status_version,
    'system', null, case when v_rotated then 'refresh_token_rotated' else 'access_token_refreshed' end, v_corr, v_key,
    jsonb_build_object('credential_version', v_version, 'rotated', v_rotated));
  perform arc_private.purge_retired(v_tenant, v_id);
  return jsonb_build_object('replayed', false, 'connection', arc_private.connection_json(v_id),
                            'credential', arc_private.credential_json(v_id));
end;
$fn$;

create or replace function arc_private.release_refresh(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  v_tenant uuid := arc_private.req_uuid(p, 'tenant_id');
  v_id     uuid := arc_private.req_uuid(p, 'connection_id');
  v_lease  uuid := arc_private.req_uuid(p, 'lease_token');
  v_result text := arc_private.req_code(p, 'result');
  v_n      integer;
begin
  if v_result not in ('temporary_failure', 'permanent_failure', 'storage_failed', 'incomplete_response', 'abandoned') then
    perform arc_private.refuse('invalid_request', 'not a refresh result');
  end if;
  update public.provider_connections
     set refresh_lease_token = null, refresh_lease_until = null, last_refresh_result = v_result
   where id = v_id and tenant_id = v_tenant and refresh_lease_token = v_lease;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform arc_private.record_event(v_tenant, v_id, null, 'refresh_failed', null, null, null,
      'system', null, v_result, null, null, '{}'::jsonb);
  end if;
  return jsonb_build_object('released', v_n > 0);
end;
$fn$;

create or replace function arc_private.credential_metadata(p jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('connection_id', v.connection_id, 'version', v.version, 'kind', v.kind,
                                               'status', v.status, 'hint', v.hint, 'created_at', v.created_at,
                                               'retired_at', v.retired_at) order by v.version), '[]'::jsonb)
    from arc_private.credential_versions v
   where v.tenant_id = (p ->> 'tenant_id')::uuid and v.connection_id = (p ->> 'connection_id')::uuid
$fn$;

-- which mechanism is serving: production code refuses anything but the real one.
create or replace function arc_private.credential_store_status()
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'vault', pg_catalog.to_regprocedure('vault.create_secret(text,text,text,uuid)') is not null,
    'mechanism', case
      when exists (select 1 from pg_catalog.pg_extension e where e.extname = 'supabase_vault') then 'supabase_vault'
      when pg_catalog.to_regprocedure('vault.create_secret(text,text,text,uuid)') is not null then 'test_double'
      else 'none' end)
$fn$;

-- ---------------------------------------------------------------------------
-- 8. the Data API surface: service-role-only wrappers, one line each
-- ---------------------------------------------------------------------------

create or replace function public.connection_begin_authorization(p_request jsonb, p_pkce_verifier text default null)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.begin_authorization(p_request, p_pkce_verifier) $fn$;

create or replace function public.connection_claim_authorization(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.claim_authorization(p_request) $fn$;

create or replace function public.connection_complete_authorization(p_request jsonb, p_secret text)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.complete_authorization(p_request, p_secret) $fn$;

create or replace function public.connection_fail_authorization(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.fail_authorization(p_request) $fn$;

create or replace function public.connection_store_api_key(p_request jsonb, p_secret text)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.store_api_key(p_request, p_secret) $fn$;

create or replace function public.connection_record_event(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.record_connection_event(p_request) $fn$;

create or replace function public.connection_end(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.end_connection(p_request) $fn$;

create or replace function public.connection_resolve_credential(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.resolve_credential(p_request) $fn$;

create or replace function public.connection_begin_refresh(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.begin_refresh(p_request) $fn$;

create or replace function public.connection_commit_refresh(p_request jsonb, p_secret text)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.commit_refresh(p_request, p_secret) $fn$;

create or replace function public.connection_release_refresh(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.release_refresh(p_request) $fn$;

create or replace function public.connection_purge_retired(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.purge_retired(arc_private.req_uuid(p_request, 'tenant_id'), arc_private.req_uuid(p_request, 'connection_id')) $fn$;

create or replace function public.connection_credential_metadata(p_request jsonb)
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.credential_metadata(p_request) $fn$;

create or replace function public.connection_credential_store_status()
returns jsonb language sql security definer set search_path = ''
as $fn$ select arc_private.credential_store_status() $fn$;

-- ---------------------------------------------------------------------------
-- 9. RLS and privileges
-- ---------------------------------------------------------------------------

alter table public.provider_connections        enable row level security;
alter table public.provider_connection_events  enable row level security;
alter table public.connection_transition_rules enable row level security;
alter table arc_private.credential_versions    enable row level security;
alter table arc_private.authorization_sessions enable row level security;

drop policy if exists provider_connections_read on public.provider_connections;
create policy provider_connections_read on public.provider_connections
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists provider_connection_events_read on public.provider_connection_events;
create policy provider_connection_events_read on public.provider_connection_events
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists connection_transition_rules_read on public.connection_transition_rules;
create policy connection_transition_rules_read on public.connection_transition_rules
  for select to authenticated using (true);

revoke all on public.provider_connections, public.provider_connection_events, public.connection_transition_rules
  from public, anon, authenticated, service_role;
-- the edge functions read; they never write a connection table directly.
grant select on public.provider_connections, public.provider_connection_events, public.connection_transition_rules
  to service_role;
-- browsers read their own tenant's safe columns — never the refresh lease.
grant select (
  id, tenant_id, connector_key, connector_version, auth_method, status, status_version,
  external_account_id, external_account_label, display_metadata, granted_scopes, verified_capabilities,
  credential_version, credential_hint, access_expires_at, refreshable, last_verified_at,
  last_refresh_attempt_at, last_refresh_result, health_status, health_reason, health_checked_at,
  connected_by, created_at, updated_at, ended_at
) on public.provider_connections to authenticated;
grant select on public.provider_connection_events, public.connection_transition_rules to authenticated;

revoke all on all tables in schema arc_private from public, anon, authenticated, service_role;
revoke all on all functions in schema arc_private from public, anon, authenticated, service_role;

revoke all on function public.connection_begin_authorization(jsonb, text)    from public, anon, authenticated;
revoke all on function public.connection_claim_authorization(jsonb)          from public, anon, authenticated;
revoke all on function public.connection_complete_authorization(jsonb, text) from public, anon, authenticated;
revoke all on function public.connection_fail_authorization(jsonb)           from public, anon, authenticated;
revoke all on function public.connection_store_api_key(jsonb, text)          from public, anon, authenticated;
revoke all on function public.connection_record_event(jsonb)                 from public, anon, authenticated;
revoke all on function public.connection_end(jsonb)                          from public, anon, authenticated;
revoke all on function public.connection_resolve_credential(jsonb)           from public, anon, authenticated;
revoke all on function public.connection_begin_refresh(jsonb)                from public, anon, authenticated;
revoke all on function public.connection_commit_refresh(jsonb, text)         from public, anon, authenticated;
revoke all on function public.connection_release_refresh(jsonb)              from public, anon, authenticated;
revoke all on function public.connection_purge_retired(jsonb)                from public, anon, authenticated;
revoke all on function public.connection_credential_metadata(jsonb)          from public, anon, authenticated;
revoke all on function public.connection_credential_store_status()           from public, anon, authenticated;

grant execute on function public.connection_begin_authorization(jsonb, text)    to service_role;
grant execute on function public.connection_claim_authorization(jsonb)          to service_role;
grant execute on function public.connection_complete_authorization(jsonb, text) to service_role;
grant execute on function public.connection_fail_authorization(jsonb)           to service_role;
grant execute on function public.connection_store_api_key(jsonb, text)          to service_role;
grant execute on function public.connection_record_event(jsonb)                 to service_role;
grant execute on function public.connection_end(jsonb)                          to service_role;
grant execute on function public.connection_resolve_credential(jsonb)           to service_role;
grant execute on function public.connection_begin_refresh(jsonb)                to service_role;
grant execute on function public.connection_commit_refresh(jsonb, text)         to service_role;
grant execute on function public.connection_release_refresh(jsonb)              to service_role;
grant execute on function public.connection_purge_retired(jsonb)                to service_role;
grant execute on function public.connection_credential_metadata(jsonb)          to service_role;
grant execute on function public.connection_credential_store_status()           to service_role;

-- ---------------------------------------------------------------------------
-- 10. prove it: an API role that can still reach Vault or arc_private stops
--     the migration. (On a hosted project where a revoke above could not take
--     effect, this is where it says so — ARC-130 must not run there.)
-- ---------------------------------------------------------------------------

do $assert$
declare
  r      record;
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_schema_privilege(v_role, 'vault', 'USAGE') then
      raise exception 'arc_connection:vault_unavailable: % can still use the vault schema', v_role using errcode = 'P0001';
    end if;
    if pg_catalog.has_schema_privilege(v_role, 'arc_private', 'USAGE') then
      raise exception 'arc_connection:vault_unavailable: % can still use arc_private', v_role using errcode = 'P0001';
    end if;
    for r in select c.oid::regclass as rel from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname in ('vault', 'arc_private') and c.relkind in ('r', 'v', 'm') loop
      if pg_catalog.has_table_privilege(v_role, r.rel, 'SELECT') then
        raise exception 'arc_connection:vault_unavailable: % can still read %', v_role, r.rel using errcode = 'P0001';
      end if;
    end loop;
    for r in select p.oid::regprocedure as fn from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('vault', 'arc_private') loop
      if pg_catalog.has_function_privilege(v_role, r.fn, 'EXECUTE') then
        raise exception 'arc_connection:vault_unavailable: % can still execute %', v_role, r.fn using errcode = 'P0001';
      end if;
    end loop;
  end loop;
end;
$assert$;
