-- ARC Portal initial schema.
--
-- Design notes that are load-bearing, not preference:
--   * tenant_id is on every row from line one, at one tenant, because
--     retrofitting tenancy later is error-prone and a leak ends the business.
--   * `events` is append-only and is the single source for every number in the
--     portal. Adding a new automation later needs a new event_type, not a
--     migration, so event_type is deliberately unconstrained text. It is
--     validated at the ingest boundary instead.
--   * `alerts` is the only mutable table, because acknowledged/resolved state
--     cannot live in an append-only log.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null unique,
  -- Required, not optional. "Yesterday this location received zero leads" is
  -- meaningless on a UTC day boundary; restoration is a local business and UTC
  -- bucketing manufactures false watermark alarms.
  timezone    text        not null default 'America/New_York',
  status      text        not null default 'onboarding'
                check (status in ('onboarding', 'active', 'paused')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tenant_members: maps Supabase auth users to tenants
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_members (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  role       text        not null default 'owner'
               check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

create index if not exists tenant_members_tenant_idx
  on public.tenant_members (tenant_id);

-- ---------------------------------------------------------------------------
-- events: append-only log, the source for every displayed number
-- ---------------------------------------------------------------------------

create table if not exists public.events (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,

  -- lead_received | call_missed | sms_sent | routed | reply_received
  -- canary_expectation | canary_check | watermark_check | schema_assert
  event_type    text        not null,

  workflow_id   text,
  execution_id  text,

  -- Threads one lead's lifecycle together: lead_received -> sms_sent -> routed.
  -- Without this the event feed cannot group and response time is uncomputable.
  correlation_id uuid,

  status        text        not null default 'success'
                  check (status in ('success', 'failure')),
  payload       jsonb       not null default '{}'::jsonb,
  latency_ms    integer,

  -- Canaries traverse the LIVE pipeline, so they emit real lead_received and
  -- sms_sent rows. Without this flag, synthetic traffic inflates client-facing
  -- counts and the portal reports numbers it cannot defend.
  is_canary     boolean     not null default false,

  -- When it happened in the real world, vs. when we recorded it. n8n retries
  -- and backfills would otherwise scramble the timeline.
  occurred_at   timestamptz not null,
  created_at    timestamptz not null default now(),

  -- Idempotency. n8n retries on transient failure; without this, leads
  -- double-count and every number on the page becomes indefensible.
  event_key     text
);

create unique index if not exists events_tenant_event_key_uniq
  on public.events (tenant_id, event_key)
  where event_key is not null;

-- Feed: most recent real events for one tenant.
create index if not exists events_feed_idx
  on public.events (tenant_id, occurred_at desc)
  where is_canary = false;

-- Metric rollups by type over a window.
create index if not exists events_type_window_idx
  on public.events (tenant_id, event_type, occurred_at desc);

-- Correlation lookups for response-time computation.
create index if not exists events_correlation_idx
  on public.events (tenant_id, correlation_id)
  where correlation_id is not null;

-- ---------------------------------------------------------------------------
-- ingest_tokens: per-tenant bearer tokens for POST /api/ingest
-- ---------------------------------------------------------------------------

create table if not exists public.ingest_tokens (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  -- SHA-256 hex of the raw token. The raw value is shown once at creation and
  -- never stored, so a database read cannot be replayed as pipeline write access.
  token_hash   text        not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists ingest_tokens_tenant_idx
  on public.ingest_tokens (tenant_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- alerts: the only mutable table
-- ---------------------------------------------------------------------------

create table if not exists public.alerts (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  event_id        uuid        references public.events(id) on delete set null,
  check_type      text        not null
                    check (check_type in ('canary', 'watermark', 'schema')),
  severity        text        not null default 'critical'
                    check (severity in ('info', 'warning', 'critical')),
  message         text        not null,
  fired_at        timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);

-- Alert dedup: at most one unresolved alert per (tenant, check_type), so one
-- broken pipeline cannot send sixty texts overnight and train Ben to ignore them.
create unique index if not exists alerts_one_open_per_check
  on public.alerts (tenant_id, check_type)
  where resolved_at is null;

create index if not exists alerts_tenant_fired_idx
  on public.alerts (tenant_id, fired_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- security definer so policies on tenant_members do not recurse into themselves.
create or replace function public.is_tenant_member(t uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenant_members
    where tenant_id = t and user_id = auth.uid()
  );
$$;

alter table public.tenants        enable row level security;
alter table public.tenant_members enable row level security;
alter table public.events         enable row level security;
alter table public.alerts         enable row level security;
alter table public.ingest_tokens  enable row level security;

-- Clients may read only their own tenant. No client writes anywhere: every
-- write path goes through the server with the service role.
drop policy if exists tenants_select_own on public.tenants;
create policy tenants_select_own on public.tenants
  for select to authenticated
  using (public.is_tenant_member(id));

drop policy if exists tenant_members_select_own on public.tenant_members;
create policy tenant_members_select_own on public.tenant_members
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists events_select_own_tenant on public.events;
create policy events_select_own_tenant on public.events
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists alerts_select_own_tenant on public.alerts;
create policy alerts_select_own_tenant on public.alerts
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- ingest_tokens intentionally has RLS enabled and NO policy: with no policy,
-- authenticated clients can read nothing. Only the service role touches it.

-- ---------------------------------------------------------------------------
-- Realtime: the live event feed subscribes to inserts on events.
-- RLS above still applies to realtime, so a subscriber receives only its own
-- tenant's rows.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;
