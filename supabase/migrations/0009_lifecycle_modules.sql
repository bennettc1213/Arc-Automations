-- The revenue lifecycle modules: estimate recovery, reviews & service recovery,
-- memberships, and install & warranty.
--
-- What this migration does NOT do is the important part. It adds no tables for
-- estimates, reviews, memberships or installs, because the portal already has a
-- place that state belongs: the append-only `events` log. A record's current
-- state is folded out of its own events on every render
-- (src/portal/lib/lifecycle.js), exactly the way a lead's pipeline has always
-- been folded out of its correlated events by buildThreads().
--
-- The alternative — a `estimates` table synced from the client's CRM — is a
-- second copy of somebody else's system of record. It would be stale between
-- syncs, it would drift on every failed one, and the first time the portal and
-- the CRM disagreed about whether a quote was approved, the client would stop
-- believing both. The CRM stays the system of record. Arc stores the evidence of
-- what it observed and what it did, and derives everything else.
--
-- So this migration is small and entirely additive:
--
--   1. six nullable columns on `events`, giving the module event contract
--      first-class fields instead of conventions buried in a jsonb blob
--   2. two partial indexes for the queries those columns enable
--   3. `tenants.modules` — which modules a client actually bought
--   4. `tenants.response_sla_seconds` — their speed-to-lead target
--
-- Deliberately absent: a `module` column. A module is derived from `event_type`
-- by one map in src/portal/lib/types.js. Storing it as well would create a
-- second source of truth that could disagree with the event type sitting next to
-- it, and every figure in this product depends on facts having one definition.
--
-- ---------------------------------------------------------------------------
-- Safety and ordering
-- ---------------------------------------------------------------------------
--
-- Every statement is additive and idempotent. No column is dropped, no
-- constraint is tightened on existing rows, nothing is backfilled, and nothing
-- rewrites the events table. All new columns are nullable, so every row written
-- before this migration remains valid and readable.
--
-- Deploy order does not matter. A browser bundle carrying this release against a
-- database that has not had it applied falls back to the previous column set
-- (see isMissingColumn() in src/portal/lib/dashboard.js) and renders the lead
-- pipeline exactly as it did before. A database with the migration applied and
-- an older bundle in front of it is unaffected — the new columns are simply not
-- selected.
--
-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
-- Fully reversible. To undo, in this order:
--
--   drop index if exists public.events_entity_idx;
--   drop index if exists public.events_error_idx;
--   alter table public.events
--     drop column if exists entity_type,
--     drop column if exists entity_id,
--     drop column if exists source_system,
--     drop column if exists external_id,
--     drop column if exists actor,
--     drop column if exists error_class;
--   alter table public.tenants
--     drop column if exists modules,
--     drop column if exists response_sla_seconds;
--
-- Dropping those columns discards the lifecycle metadata on any events already
-- ingested — the events themselves, their payloads and every pre-existing figure
-- survive untouched, since nothing derived before this release reads them. No
-- RLS policy is added or altered by this migration, so there is nothing to
-- restore on that side: the new columns are covered by the existing per-table
-- policies, which is the point of putting them on `events` rather than in new
-- tables.

-- ---------------------------------------------------------------------------
-- 1. the module event contract, as columns
-- ---------------------------------------------------------------------------

-- entity_type / entity_id: which record this event is about. An estimate's five
-- events share one entity_id, which is what lets them fold back into one row.
-- correlation_id is NOT reused for this: correlation threads one lead's pipeline
-- over minutes, an entity is a CRM record with a life measured in weeks, and one
-- lead can produce several of them.
alter table public.events add column if not exists entity_type text;
alter table public.events add column if not exists entity_id   text;

-- Which system the record came out of, and its id there. Stored so an operator
-- chasing a bad row can open it in the system that owns it, and so the portal
-- never has to guess which vendor an adapter was talking to.
alter table public.events add column if not exists source_system text;
alter table public.events add column if not exists external_id   text;

-- automation | human | system. The reviews module needs this to enforce that a
-- sensitive response was approved by a person, and the activity feed needs it to
-- separate what a workflow did from what somebody's team did.
alter table public.events add column if not exists actor text;

-- A small, searchable classification of how something failed. Free-text error
-- strings are unsearchable and a hundred-value enum goes unmaintained, so this
-- stays coarse: auth, delivery, schema, rate_limit, timeout, upstream, config,
-- unknown.
alter table public.events add column if not exists error_class text;

-- Validated at the ingest boundary (supabase/functions/ingest/validate.ts)
-- rather than by check constraints here — the same decision event_type itself
-- was given in 0001. A new source system or entity type is a deploy of the edge
-- function, not a migration, and a value that reaches the table has already been
-- checked once.

-- ---------------------------------------------------------------------------
-- 2. indexes
-- ---------------------------------------------------------------------------

-- Every module fold is "all events for this tenant's records, newest last".
-- Partial on entity_id so the index carries only lifecycle rows: the lead
-- pipeline's events have no entity_id, and they are the overwhelming majority.
create index if not exists events_entity_idx
  on public.events (tenant_id, entity_type, entity_id, occurred_at desc)
  where entity_id is not null;

-- "What is failing, and how" — the query behind module health and the failures
-- filter on the activity feed. Partial for the same reason: a healthy pipeline
-- writes almost no rows into it.
create index if not exists events_error_idx
  on public.events (tenant_id, error_class, occurred_at desc)
  where error_class is not null;

-- ---------------------------------------------------------------------------
-- 3. which modules a client actually has
-- ---------------------------------------------------------------------------

-- The column that lets the portal tell three different things apart:
--
--   declared + events observed  → live, show the numbers
--   declared + nothing observed → awaiting connection, say so
--   not declared + observed     → live (observation always wins; an operator
--                                 forgetting to tick a box must never hide a
--                                 client's own data from them)
--   not declared + nothing      → the page does not exist for this client
--
-- Without it, a module mid-build is indistinguishable from a module having a
-- quiet month, and the portal would print zeros for both. Default '{}' rather
-- than null so a newly created tenant has no modules rather than an unknown
-- number of them; lead capture is treated as always-on in code, since it is what
-- the ingest pipeline itself is.
alter table public.tenants
  add column if not exists modules text[] not null default '{}';

-- Their speed-to-lead target, in seconds. Null means the five-minute default in
-- src/portal/lib/lifecycle.js. A per-tenant column because "inside SLA" is a
-- promise made to a specific client, and a shared constant would quietly rewrite
-- everybody's target the day one of them negotiated a different one.
alter table public.tenants
  add column if not exists response_sla_seconds integer
  check (response_sla_seconds is null or response_sla_seconds between 10 and 86400);

-- No new policies. `events` and `tenants` already carry their select policies
-- (is_tenant_member() or is_arc_admin()) and their admin-only write policies
-- from 0001 and 0003, and columns added to a table inherit them. Clients gain
-- read access to their own modules list and SLA, which is theirs; they gain no
-- write path, because no client write path exists anywhere in this schema.
