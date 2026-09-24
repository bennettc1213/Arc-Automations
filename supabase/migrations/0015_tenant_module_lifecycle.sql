-- ===========================================================================
-- 0015 — Tenant module lifecycle and activation (ARC-120)
-- ===========================================================================
--
-- Until now "is this module live for this client" was one boolean,
-- `module_configs.enabled` (0010), set by an ops action that checked an
-- onboarding checklist, and read by the engine at intake and before each send.
-- Nothing recorded which configuration the switch was turned on for, so an
-- operator could activate a module, publish a new sending number an hour later,
-- and the engine would text customers from it without anyone re-approving it.
--
-- This migration gives each tenant module one lifecycle record and makes the
-- switch a mirror of it:
--
--   tenant_modules              the state, its version (the optimistic lock),
--                               the requirements a published change imposed,
--                               the configuration versions it last evaluated,
--                               tested, shadowed and AUTHORISED, and the health
--                               overlay — kept apart from the state.
--   tenant_module_transitions   append-only history. exactly one row per change
--                               to a lifecycle, written first, in the same
--                               transaction, and checked against the rules.
--   tenant_module_evidence      append-only, version-bound, always simulated:
--                               synthetic tests, shadow observations, shadow
--                               reviews. no figure on any page reads it.
--   lifecycle_transition_rules  the legal transitions, seeded from the typed
--                               policy (`_shared/lifecycle/model.ts`) and
--                               drift-tested against it. a history row carries
--                               a foreign key to its rule.
--
-- The rule the whole thing rests on: a NEW live run may start only on exactly
-- the configuration versions an operator authorised, and a live effect may be
-- reserved only while the module is active. Both are enforced here, under a row
-- lock on the lifecycle, so a pause committed a millisecond before a send stops
-- it. Existing runs keep their pinned snapshots; nothing is repinned.
--
-- ---------------------------------------------------------------------------
-- Who can write
-- ---------------------------------------------------------------------------
--
-- No browser role, on any of it — the 0010 pattern. Every change goes through
-- `apply_tenant_module_transition()`, executable by the service role only, which
-- re-checks an operator actor against `arc_admins`, locks the lifecycle,
-- compares the caller's expected state version and replays an idempotency key.
-- The triggers bind the service role as well: a lifecycle row cannot change
-- without its history row, cannot be deleted, cannot become active without a
-- passing test of exactly the current versions, and cannot carry authorisation
-- to new versions unless the registry's recorded change impact says it may.
--
-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- Conservative, and it changes behaviour on purpose:
--
--   module_configs row, switched off   → `configuring` (it had been set up)
--   module_configs row, switched ON    → `paused`, requiring retest, review and
--                                        reactivation. The old activation named
--                                        no configuration version, so nothing
--                                        proves what was approved. The switch is
--                                        turned off. An operator runs the canary
--                                        and resumes — DEPLOYMENT.md §10.
--   no row                             → no lifecycle (unselected).
--
-- Nothing is activated and nobody is contacted by this migration.
--
-- Forward-only and additive. One function is redefined with its signature
-- unchanged (`reserve_lead_recovery_effect`, §8: the lifecycle check is added
-- in front of the 0011 body, which is otherwise identical). Nothing is dropped.

-- ---------------------------------------------------------------------------
-- 1. the legal transitions
-- ---------------------------------------------------------------------------

create table if not exists public.lifecycle_transition_rules (
  transition text not null check (transition ~ '^[a-z][a-z_]{1,40}$'),
  from_state text not null check (from_state in ('unselected', 'configuring', 'testing', 'shadow', 'active', 'paused')),
  to_state   text not null check (to_state   in ('unselected', 'configuring', 'testing', 'shadow', 'active', 'paused')),
  actor_type text not null check (actor_type in ('operator', 'system')),
  primary key (transition, from_state, actor_type)
);

insert into public.lifecycle_transition_rules (transition, from_state, to_state, actor_type) values
  ('select',               'unselected',  'configuring', 'operator'),
  ('begin_testing',        'configuring', 'testing',     'operator'),
  ('begin_testing',        'paused',      'testing',     'operator'),
  ('stop_testing',         'testing',     'configuring', 'operator'),
  ('enter_shadow',         'testing',     'shadow',      'operator'),
  ('enter_shadow',         'paused',      'shadow',      'operator'),
  ('exit_shadow',          'shadow',      'testing',     'operator'),
  ('activate',             'testing',     'active',      'operator'),
  ('activate',             'shadow',      'active',      'operator'),
  ('pause',                'active',      'paused',      'operator'),
  ('resume',               'paused',      'active',      'operator'),
  ('deselect',             'configuring', 'unselected',  'operator'),
  ('deselect',             'testing',     'unselected',  'operator'),
  ('deselect',             'shadow',      'unselected',  'operator'),
  ('deselect',             'active',      'unselected',  'operator'),
  ('deselect',             'paused',      'unselected',  'operator'),
  ('system_pause',         'active',      'paused',      'system'),
  ('apply_config_change',  'configuring', 'configuring', 'system'),
  ('apply_config_change',  'testing',     'testing',     'system'),
  ('apply_config_change',  'shadow',      'shadow',      'system'),
  ('apply_config_change',  'active',      'active',      'system'),
  ('apply_config_change',  'paused',      'paused',      'system'),
  ('record_test',          'testing',     'testing',     'operator'),
  ('record_test',          'shadow',      'shadow',      'operator'),
  ('record_test',          'active',      'active',      'operator'),
  ('record_test',          'paused',      'paused',      'operator'),
  ('record_shadow_review', 'shadow',      'shadow',      'operator'),
  ('report_health',        'configuring', 'configuring', 'operator'),
  ('report_health',        'configuring', 'configuring', 'system'),
  ('report_health',        'testing',     'testing',     'operator'),
  ('report_health',        'testing',     'testing',     'system'),
  ('report_health',        'shadow',      'shadow',      'operator'),
  ('report_health',        'shadow',      'shadow',      'system'),
  ('report_health',        'active',      'active',      'operator'),
  ('report_health',        'active',      'active',      'system'),
  ('report_health',        'paused',      'paused',      'operator'),
  ('report_health',        'paused',      'paused',      'system'),
  ('backfill_selected',    'unselected',  'configuring', 'system'),
  ('backfill_paused',      'unselected',  'paused',      'system')
on conflict (transition, from_state, actor_type) do nothing;

create or replace function public.lifecycle_transition_rules_are_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'lifecycle_transition_rules change through reviewed code and a migration (attempted %)', tg_op
    using errcode = 'P0001';
end;
$fn$;

drop trigger if exists lifecycle_transition_rules_immutable on public.lifecycle_transition_rules;
create trigger lifecycle_transition_rules_immutable
  before update or delete on public.lifecycle_transition_rules
  for each row execute function public.lifecycle_transition_rules_are_immutable();

-- ---------------------------------------------------------------------------
-- 2. the lifecycle record
-- ---------------------------------------------------------------------------

-- Every configuration-version reference is a composite foreign key through
-- (id, tenant_id[, module_key]), so a lifecycle can never point at another
-- tenant's or another module's version — the 0010/0014 trick.
create table if not exists public.tenant_modules (
  id                                  uuid primary key default gen_random_uuid(),
  tenant_id                           uuid not null references public.tenants(id) on delete cascade,
  module_key                          text not null references public.registry_modules(key) on delete restrict,
  state                               text not null
    check (state in ('unselected', 'configuring', 'testing', 'shadow', 'active', 'paused')),
  -- the optimistic lock: +1 on every change, each with exactly one history row.
  state_version                       bigint not null check (state_version >= 1),
  pending_requirements                text[] not null default '{}'
    check (pending_requirements <@ array['retest', 'shadow', 'review', 'reactivation']::text[]),

  observed_tenant_config_version_id   uuid,
  observed_module_config_version_id   uuid,
  authorized_tenant_config_version_id uuid,
  authorized_module_config_version_id uuid,
  tested_tenant_config_version_id     uuid,
  tested_module_config_version_id     uuid,
  test_evidence_id                    uuid,
  shadow_tenant_config_version_id     uuid,
  shadow_module_config_version_id     uuid,
  shadow_evidence_id                  uuid,

  health_status                       text not null default 'unverified'
    check (health_status in ('unverified', 'healthy', 'degraded', 'failing', 'blocking')),
  health_reason                       text check (health_reason is null or length(health_reason) <= 300),
  health_evidence                     jsonb not null default '{}'::jsonb,
  health_checked_at                   timestamptz,

  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now(),

  unique (tenant_id, module_key),
  unique (id, tenant_id, module_key),

  constraint tenant_modules_observed_paired
    check ((observed_tenant_config_version_id is null) = (observed_module_config_version_id is null)),
  constraint tenant_modules_authorized_paired
    check ((authorized_tenant_config_version_id is null) = (authorized_module_config_version_id is null)),
  constraint tenant_modules_tested_paired
    check ((tested_tenant_config_version_id is null) = (tested_module_config_version_id is null)
       and (tested_tenant_config_version_id is null) = (test_evidence_id is null)),
  constraint tenant_modules_shadow_paired
    check ((shadow_tenant_config_version_id is null) = (shadow_module_config_version_id is null)
       and (shadow_tenant_config_version_id is null) = (shadow_evidence_id is null)),
  constraint tenant_modules_active_is_authorized
    check (state <> 'active' or authorized_tenant_config_version_id is not null),
  constraint tenant_modules_no_secrets check (
    health_evidence::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
    and coalesce(health_reason, '') !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|private[_-]?key|bearer )'
  ),

  foreign key (observed_tenant_config_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (observed_module_config_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (authorized_tenant_config_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (authorized_module_config_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (tested_tenant_config_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (tested_module_config_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (shadow_tenant_config_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (shadow_module_config_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key)
);

create index if not exists tenant_modules_tenant_idx on public.tenant_modules (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. evidence — append-only, version-bound, always simulated
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_module_evidence (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  module_key                text not null,
  lifecycle_id              uuid not null,
  kind                      text not null check (kind in ('test', 'shadow_observation', 'shadow_review')),
  outcome                   text not null check (outcome in ('passed', 'failed', 'observed')),
  run_mode                  text check (run_mode in ('test', 'shadow')),
  tenant_config_version_id  uuid not null,
  module_config_version_id  uuid not null,
  config_hash               text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  -- the capabilities the evaluation treated as available: the connector context tested.
  capabilities              text[] not null default '{}',
  run_id                    uuid,
  -- nothing in this table is a real outcome. the column exists so no query can forget it.
  simulated                 boolean not null default true check (simulated),
  summary                   jsonb not null default '{}'::jsonb,
  actor_type                text not null check (actor_type in ('operator', 'system')),
  recorded_by               uuid,
  recorded_at               timestamptz not null default now(),

  unique (id, tenant_id, module_key),

  constraint tenant_module_evidence_shape check (
       (kind = 'test'               and run_id is not null and run_mode = 'test'   and outcome in ('passed', 'failed'))
    or (kind = 'shadow_observation' and run_id is not null and run_mode = 'shadow' and outcome = 'observed')
    or (kind = 'shadow_review'      and run_id is null     and run_mode is null    and outcome in ('passed', 'failed'))
  ),
  constraint tenant_module_evidence_no_secrets check (
    summary::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  ),

  foreign key (lifecycle_id, tenant_id, module_key)
    references public.tenant_modules (id, tenant_id, module_key),
  foreign key (tenant_config_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (module_config_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (run_id, tenant_id)
    references public.automation_runs (id, tenant_id)
);

create index if not exists tenant_module_evidence_lookup_idx
  on public.tenant_module_evidence (tenant_id, module_key, kind, module_config_version_id);

-- the lifecycle names the evidence it accepted — of its own tenant and module.
do $$
begin
  alter table public.tenant_modules
    add constraint tenant_modules_test_evidence_fkey
    foreign key (test_evidence_id, tenant_id, module_key)
    references public.tenant_module_evidence (id, tenant_id, module_key);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.tenant_modules
    add constraint tenant_modules_shadow_evidence_fkey
    foreign key (shadow_evidence_id, tenant_id, module_key)
    references public.tenant_module_evidence (id, tenant_id, module_key);
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 4. history — append-only, one row per change
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_module_transitions (
  id                                 uuid primary key default gen_random_uuid(),
  tenant_id                          uuid not null references public.tenants(id) on delete cascade,
  module_key                         text not null,
  lifecycle_id                       uuid not null,
  state_version                      bigint not null check (state_version >= 1),
  transition                         text not null,
  from_state                         text not null,
  to_state                           text not null
    check (to_state in ('unselected', 'configuring', 'testing', 'shadow', 'active', 'paused')),
  actor_type                         text not null check (actor_type in ('operator', 'system')),
  -- a plain uuid, like 0014's published_by: deleting a login must not rewrite history.
  actor_id                           uuid,
  reason_code                        text not null check (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  reason                             text check (reason is null or length(reason) <= 300),
  idempotency_key                    text not null check (length(idempotency_key) between 1 and 200),
  correlation_id                     text check (correlation_id is null or length(correlation_id) <= 200),
  tenant_config_version_id           uuid,
  module_config_version_id           uuid,
  previous_tenant_config_version_id  uuid,
  previous_module_config_version_id  uuid,
  evidence_id                        uuid,
  impact                             jsonb not null default '{}'::jsonb,
  policy                             jsonb not null default '{}'::jsonb,
  pending_before                     text[] not null default '{}',
  pending_after                      text[] not null default '{}',
  health_before                      text,
  health_after                       text,
  metadata                           jsonb not null default '{}'::jsonb,
  occurred_at                        timestamptz not null default now(),

  unique (lifecycle_id, state_version),
  unique (tenant_id, module_key, idempotency_key),

  constraint tenant_module_transitions_versions_paired
    check ((tenant_config_version_id is null) = (module_config_version_id is null)),
  constraint tenant_module_transitions_previous_paired
    check ((previous_tenant_config_version_id is null) = (previous_module_config_version_id is null)),
  constraint tenant_module_transitions_actor
    check ((actor_type = 'operator' and actor_id is not null) or (actor_type = 'system' and actor_id is null)),
  constraint tenant_module_transitions_no_secrets check (
    (impact::text || policy::text || metadata::text || coalesce(reason, ''))
      !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  ),

  -- legality is a foreign key: a history row names an existing rule, or it does not exist.
  foreign key (transition, from_state, actor_type)
    references public.lifecycle_transition_rules (transition, from_state, actor_type),
  foreign key (lifecycle_id, tenant_id, module_key)
    references public.tenant_modules (id, tenant_id, module_key),
  foreign key (tenant_config_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (module_config_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (previous_tenant_config_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (previous_module_config_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (evidence_id, tenant_id, module_key)
    references public.tenant_module_evidence (id, tenant_id, module_key)
);

create index if not exists tenant_module_transitions_lookup_idx
  on public.tenant_module_transitions (tenant_id, module_key, state_version desc);

-- ---------------------------------------------------------------------------
-- 5. runs state the mode they were authorised in
-- ---------------------------------------------------------------------------

-- Null on every run created before this migration: nothing proves those were
-- authorised by a lifecycle, so the engine refuses to let them act
-- (`run_authorization_unproven`) and the reservation below refuses their effects.
alter table public.automation_runs
  add column if not exists run_mode text check (run_mode in ('live', 'test', 'shadow'));

-- ---------------------------------------------------------------------------
-- 6. backfill — before any guard exists, so it is the migration's alone
-- ---------------------------------------------------------------------------

with legacy as (
  select mc.tenant_id, mc.module_key, mc.enabled, mc.config_version, mc.schema_version
    from public.module_configs mc
   where exists (select 1 from public.registry_modules rm where rm.key = mc.module_key)
     and not exists (
       select 1 from public.tenant_modules tm
        where tm.tenant_id = mc.tenant_id and tm.module_key = mc.module_key
     )
),
heads as (
  select l.*,
         (select v.id from public.tenant_config_versions v where v.tenant_id = l.tenant_id order by v.version desc limit 1) as tenant_head,
         (select v.id from public.module_config_versions v where v.tenant_id = l.tenant_id and v.module_key = l.module_key order by v.version desc limit 1) as module_head
    from legacy l
),
inserted as (
  insert into public.tenant_modules (
    tenant_id, module_key, state, state_version, pending_requirements,
    observed_tenant_config_version_id, observed_module_config_version_id
  )
  select h.tenant_id, h.module_key,
         case when h.enabled then 'paused' else 'configuring' end,
         1,
         case when h.enabled then array['retest', 'review', 'reactivation']::text[] else '{}'::text[] end,
         case when h.tenant_head is not null and h.module_head is not null then h.tenant_head end,
         case when h.tenant_head is not null and h.module_head is not null then h.module_head end
    from heads h
  returning id, tenant_id, module_key, state, pending_requirements
)
insert into public.tenant_module_transitions (
  tenant_id, module_key, lifecycle_id, state_version, transition, from_state, to_state,
  actor_type, actor_id, reason_code, reason, idempotency_key, pending_before, pending_after,
  health_before, health_after, metadata
)
select i.tenant_id, i.module_key, i.id, 1,
       case when i.state = 'paused' then 'backfill_paused' else 'backfill_selected' end,
       'unselected', i.state, 'system', null,
       case when i.state = 'paused' then 'legacy_activation_unbound' else 'legacy_configuration_present' end,
       case when i.state = 'paused'
         then 'switched on before 0015 — that activation named no configuration version, so it must be tested and resumed'
         else 'configured before 0015 and never switched on'
       end,
       'backfill:0015', '{}', i.pending_requirements, null, 'unverified',
       jsonb_build_object(
         'migration', '0015_tenant_module_lifecycle',
         'legacy_enabled', i.state = 'paused',
         'legacy_steps_done', coalesce((
           select jsonb_agg(o.step_key order by o.step_key)
             from public.module_onboarding o
            where o.tenant_id = i.tenant_id and o.module_key = i.module_key and o.done_at is not null
         ), '[]'::jsonb)
       )
  from inserted i;

-- the switch now follows the lifecycle, and no legacy row is left switched on
-- without an active lifecycle behind it.
update public.module_configs mc
   set enabled = false
 where mc.enabled
   and not exists (
     select 1 from public.tenant_modules tm
      where tm.tenant_id = mc.tenant_id and tm.module_key = mc.module_key and tm.state = 'active'
   );

-- ---------------------------------------------------------------------------
-- 7. the guards
-- ---------------------------------------------------------------------------

-- The current published pair for a tenant module. Null columns when either scope
-- has no version.
create or replace function public.lifecycle_heads(p_tenant uuid, p_module_key text)
returns table (tenant_version_id uuid, module_version_id uuid)
language sql
stable
set search_path = public
as $fn$
  select (select v.id from public.tenant_config_versions v where v.tenant_id = p_tenant order by v.version desc limit 1),
         (select v.id from public.module_config_versions v
           where v.tenant_id = p_tenant and v.module_key = p_module_key order by v.version desc limit 1);
$fn$;

-- One version's recorded change impact (0014 `change_impact`, written from the
-- registry's flags when it was published), classified for one module. The same
-- reading as `classifyRecordedImpact()` in `_shared/lifecycle/policy.ts`; the
-- database test compares the two.
create or replace function public.lifecycle_impact_classes(p_impact jsonb, p_scope text, p_module_key text)
returns text[]
language plpgsql
immutable
set search_path = public
as $fn$
declare
  v_out text[] := '{}';
begin
  if p_impact is null or jsonb_typeof(p_impact) <> 'object'
     or jsonb_typeof(p_impact -> 'requires_retest') is distinct from 'boolean'
     or jsonb_typeof(p_impact -> 'requires_shadow') is distinct from 'boolean'
     or jsonb_typeof(p_impact -> 'requires_reactivation') is distinct from 'boolean'
     or jsonb_typeof(p_impact -> 'unknown_fields') is distinct from 'array' then
    return array['unclassified'];
  end if;
  if p_scope = 'tenant' then
    if jsonb_typeof(p_impact -> 'affected_modules') is distinct from 'array' then
      return array['unclassified'];
    end if;
    if not ((p_impact -> 'affected_modules') ? p_module_key) then
      return array['no_consequence'];
    end if;
  end if;
  if jsonb_array_length(p_impact -> 'unknown_fields') > 0 then v_out := v_out || 'unknown_field'::text; end if;
  if (p_impact ->> 'requires_retest')::boolean then v_out := v_out || 'requires_retest'::text; end if;
  if (p_impact ->> 'requires_shadow')::boolean then v_out := v_out || 'requires_shadow'::text; end if;
  if (p_impact ->> 'requires_reactivation')::boolean then v_out := v_out || 'requires_reactivation'::text; end if;
  if cardinality(v_out) = 0 then return array['no_consequence']; end if;
  return v_out;
end;
$fn$;

-- Every classification between two version pairs, both scopes. Unclassified
-- when either end is not this tenant's, or the chain runs backwards.
create or replace function public.lifecycle_chain_classes(
  p_tenant uuid, p_module_key text,
  p_from_tenant uuid, p_from_module uuid, p_to_tenant uuid, p_to_module uuid
)
returns text[]
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_from_t integer;
  v_to_t   integer;
  v_from_m integer;
  v_to_m   integer;
  v_out    text[] := '{}';
  r        record;
begin
  select v.version into v_from_t from public.tenant_config_versions v where v.id = p_from_tenant and v.tenant_id = p_tenant;
  select v.version into v_to_t   from public.tenant_config_versions v where v.id = p_to_tenant   and v.tenant_id = p_tenant;
  select v.version into v_from_m from public.module_config_versions v
   where v.id = p_from_module and v.tenant_id = p_tenant and v.module_key = p_module_key;
  select v.version into v_to_m   from public.module_config_versions v
   where v.id = p_to_module and v.tenant_id = p_tenant and v.module_key = p_module_key;
  if v_from_t is null or v_to_t is null or v_from_m is null or v_to_m is null
     or v_from_t > v_to_t or v_from_m > v_to_m then
    return array['unclassified'];
  end if;
  for r in
    select v.change_impact from public.tenant_config_versions v
     where v.tenant_id = p_tenant and v.version > v_from_t and v.version <= v_to_t
  loop
    v_out := v_out || public.lifecycle_impact_classes(r.change_impact, 'tenant', p_module_key);
  end loop;
  for r in
    select v.change_impact from public.module_config_versions v
     where v.tenant_id = p_tenant and v.module_key = p_module_key and v.version > v_from_m and v.version <= v_to_m
  loop
    v_out := v_out || public.lifecycle_impact_classes(r.change_impact, 'module', p_module_key);
  end loop;
  return array(select distinct c from unnest(v_out) c order by c);
end;
$fn$;

-- The operator check, as 0014 makes it, in this migration's words.
create or replace function public.lifecycle_require_operator(p_actor uuid)
returns void
language plpgsql
stable
set search_path = public
as $fn$
begin
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_lifecycle:forbidden: lifecycle transitions are an operator action'
      using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_lifecycle:forbidden: the actor must be the signed-in caller'
      using errcode = 'P0001';
  end if;
end;
$fn$;

-- ── history: legal, sequential, append-only ──
create or replace function public.tenant_module_transitions_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_rule_to  text;
  v_state    text;
  v_version  bigint;
begin
  if tg_op <> 'INSERT' then
    raise exception 'arc_lifecycle:illegal_transition: lifecycle history is append-only (attempted %)', tg_op
      using errcode = 'P0001';
  end if;

  select r.to_state into v_rule_to
    from public.lifecycle_transition_rules r
   where r.transition = new.transition and r.from_state = new.from_state and r.actor_type = new.actor_type;
  if not found or v_rule_to <> new.to_state then
    raise exception 'arc_lifecycle:illegal_transition: % from % by % does not land on %',
      new.transition, new.from_state, new.actor_type, new.to_state
      using errcode = 'P0001';
  end if;
  if new.actor_type = 'operator' then
    perform public.lifecycle_require_operator(new.actor_id);
  end if;

  select tm.state, tm.state_version into v_state, v_version
    from public.tenant_modules tm where tm.id = new.lifecycle_id;
  if exists (select 1 from public.tenant_module_transitions t where t.lifecycle_id = new.lifecycle_id) then
    -- a change: written before the lifecycle row moves, naming where it moves from.
    if new.state_version <> v_version + 1 or new.from_state <> v_state then
      raise exception 'arc_lifecycle:stale_state: history for version % from % does not follow version % (%)',
        new.state_version, new.from_state, v_version, v_state
        using errcode = 'P0001';
    end if;
  elsif new.state_version <> v_version or new.from_state <> 'unselected' or new.to_state <> v_state then
    -- the first row: the lifecycle was just inserted, selected.
    raise exception 'arc_lifecycle:illegal_transition: the first history row records how the lifecycle began'
      using errcode = 'P0001';
  end if;

  new.occurred_at := now();
  return new;
end;
$fn$;

drop trigger if exists tenant_module_transitions_guard on public.tenant_module_transitions;
create trigger tenant_module_transitions_guard
  before insert or update or delete on public.tenant_module_transitions
  for each row execute function public.tenant_module_transitions_guard();

-- ── evidence: tied to what it claims to be evidence of ──
create or replace function public.tenant_module_evidence_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_run    public.automation_runs;
  v_canary boolean;
  v_pair_t uuid;
  v_pair_m uuid;
  v_state  text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'arc_lifecycle:evidence_invalid: evidence is append-only (attempted %)', tg_op
      using errcode = 'P0001';
  end if;

  if new.run_id is not null then
    select * into v_run from public.automation_runs r where r.id = new.run_id and r.tenant_id = new.tenant_id;
    if not found or v_run.module_key <> new.module_key then
      raise exception 'arc_lifecycle:evidence_invalid: no such run of this tenant and module' using errcode = 'P0001';
    end if;
    select s.tenant_config_version_id, s.module_config_version_id into v_pair_t, v_pair_m
      from public.lead_recovery_config_snapshots s
     where s.id = v_run.config_snapshot_id and s.tenant_id = new.tenant_id;
    if v_pair_t is distinct from new.tenant_config_version_id or v_pair_m is distinct from new.module_config_version_id then
      raise exception 'arc_lifecycle:evidence_invalid: evidence is only for the versions its run was pinned to'
        using errcode = 'P0001';
    end if;
  end if;

  if new.kind = 'test' then
    if v_run.run_mode is distinct from 'test' then
      raise exception 'arc_lifecycle:evidence_invalid: only a run in test mode is evidence of a test' using errcode = 'P0001';
    end if;
    select l.is_canary into v_canary from public.leads l where l.id = v_run.lead_id and l.tenant_id = new.tenant_id;
    if v_canary is not true then
      raise exception 'arc_lifecycle:evidence_invalid: a test is a synthetic lead' using errcode = 'P0001';
    end if;
  elsif new.kind = 'shadow_observation' then
    if v_run.run_mode is distinct from 'shadow' then
      raise exception 'arc_lifecycle:evidence_invalid: a shadow observation describes a shadow run' using errcode = 'P0001';
    end if;
    select tm.state into v_state from public.tenant_modules tm where tm.id = new.lifecycle_id;
    if v_state is distinct from 'shadow' then
      raise exception 'arc_lifecycle:module_not_active: shadow observations are recorded only in shadow' using errcode = 'P0001';
    end if;
  elsif new.kind = 'shadow_review' then
    if new.actor_type <> 'operator' then
      raise exception 'arc_lifecycle:forbidden: a shadow review is an operator''s' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.tenant_module_evidence e
       where e.tenant_id = new.tenant_id and e.module_key = new.module_key and e.kind = 'shadow_observation'
         and e.tenant_config_version_id = new.tenant_config_version_id
         and e.module_config_version_id = new.module_config_version_id
    ) then
      raise exception 'arc_lifecycle:shadow_observations_missing: nothing was observed in shadow under these versions'
        using errcode = 'P0001';
    end if;
  end if;

  if new.actor_type = 'operator' then
    perform public.lifecycle_require_operator(new.recorded_by);
  elsif new.recorded_by is not null then
    raise exception 'arc_lifecycle:forbidden: the system records evidence as nobody in particular' using errcode = 'P0001';
  end if;

  new.recorded_at := now();
  new.simulated := true;
  return new;
end;
$fn$;

drop trigger if exists tenant_module_evidence_guard on public.tenant_module_evidence;
create trigger tenant_module_evidence_guard
  before insert or update or delete on public.tenant_module_evidence
  for each row execute function public.tenant_module_evidence_guard();

-- ── the lifecycle row: no change without history, no activation without evidence ──
create or replace function public.tenant_modules_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_h        public.tenant_module_transitions;
  v_head_t   uuid;
  v_head_m   uuid;
  v_e        public.tenant_module_evidence;
  v_classes  text[];
  v_shadow   boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_lifecycle:illegal_transition: a lifecycle is never deleted — deselect it' using errcode = 'P0001';
  end if;

  select h.tenant_version_id, h.module_version_id into v_head_t, v_head_m
    from public.lifecycle_heads(new.tenant_id, new.module_key) h;

  if tg_op = 'INSERT' then
    if new.state <> 'configuring' or new.state_version <> 1 or cardinality(new.pending_requirements) > 0
       or new.authorized_tenant_config_version_id is not null or new.tested_tenant_config_version_id is not null
       or new.shadow_tenant_config_version_id is not null or new.health_status <> 'unverified' then
      raise exception 'arc_lifecycle:illegal_transition: a lifecycle begins selected, unproven and unauthorised'
        using errcode = 'P0001';
    end if;
    if new.observed_tenant_config_version_id is not null
       and (new.observed_tenant_config_version_id is distinct from v_head_t or new.observed_module_config_version_id is distinct from v_head_m) then
      raise exception 'arc_lifecycle:illegal_transition: the baseline is the current published versions' using errcode = 'P0001';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.module_key <> old.module_key or new.created_at <> old.created_at then
    raise exception 'arc_lifecycle:illegal_transition: a lifecycle''s identity is fixed' using errcode = 'P0001';
  end if;
  if new.state_version <> old.state_version + 1 then
    raise exception 'arc_lifecycle:stale_state: the state version moves by exactly one per change' using errcode = 'P0001';
  end if;
  select * into v_h from public.tenant_module_transitions t
   where t.lifecycle_id = new.id and t.state_version = new.state_version;
  if not found or v_h.from_state <> old.state or v_h.to_state <> new.state then
    raise exception 'arc_lifecycle:illegal_transition: every change is recorded in the history first' using errcode = 'P0001';
  end if;
  if new.health_status <> old.health_status and v_h.transition <> 'report_health' then
    raise exception 'arc_lifecycle:illegal_transition: health changes only by a health report' using errcode = 'P0001';
  end if;

  -- the evaluated baseline and live authorisation only ever point at the current versions.
  if (new.observed_tenant_config_version_id, new.observed_module_config_version_id)
       is distinct from (old.observed_tenant_config_version_id, old.observed_module_config_version_id)
     and (new.observed_tenant_config_version_id is distinct from v_head_t or new.observed_module_config_version_id is distinct from v_head_m) then
    raise exception 'arc_lifecycle:illegal_transition: the baseline can only move to the current published versions' using errcode = 'P0001';
  end if;
  if new.authorized_tenant_config_version_id is not null
     and (new.authorized_tenant_config_version_id, new.authorized_module_config_version_id)
       is distinct from (old.authorized_tenant_config_version_id, old.authorized_module_config_version_id)
     and (new.authorized_tenant_config_version_id is distinct from v_head_t or new.authorized_module_config_version_id is distinct from v_head_m) then
    raise exception 'arc_lifecycle:authorization_stale: only the current published versions can be authorised' using errcode = 'P0001';
  end if;

  -- accepted evidence is exactly what it claims.
  if new.test_evidence_id is distinct from old.test_evidence_id and new.test_evidence_id is not null then
    select * into v_e from public.tenant_module_evidence e where e.id = new.test_evidence_id;
    if v_e.kind <> 'test' or v_e.outcome <> 'passed'
       or v_e.tenant_config_version_id is distinct from new.tested_tenant_config_version_id
       or v_e.module_config_version_id is distinct from new.tested_module_config_version_id then
      raise exception 'arc_lifecycle:evidence_invalid: accepted test evidence is a passing test of exactly the tested versions'
        using errcode = 'P0001';
    end if;
  end if;
  if new.shadow_evidence_id is distinct from old.shadow_evidence_id and new.shadow_evidence_id is not null then
    select * into v_e from public.tenant_module_evidence e where e.id = new.shadow_evidence_id;
    if v_e.kind <> 'shadow_review' or v_e.outcome <> 'passed'
       or v_e.tenant_config_version_id is distinct from new.shadow_tenant_config_version_id
       or v_e.module_config_version_id is distinct from new.shadow_module_config_version_id then
      raise exception 'arc_lifecycle:evidence_invalid: accepted shadow evidence is a passing review of exactly the shadowed versions'
        using errcode = 'P0001';
    end if;
  end if;

  if new.state = 'active' and old.state <> 'active' then
    -- going live: an operator, on exactly the current, evaluated, tested versions,
    -- with nothing left pending and no negative health evidence.
    if v_h.actor_type <> 'operator' then
      raise exception 'arc_lifecycle:forbidden: only an operator switches a module on' using errcode = 'P0001';
    end if;
    if v_head_t is null or new.authorized_tenant_config_version_id is distinct from v_head_t
       or new.authorized_module_config_version_id is distinct from v_head_m then
      raise exception 'arc_lifecycle:authorization_stale: activation authorises exactly the current published versions' using errcode = 'P0001';
    end if;
    if new.observed_tenant_config_version_id is distinct from v_head_t or new.observed_module_config_version_id is distinct from v_head_m then
      raise exception 'arc_lifecycle:requirements_pending: a published change has not been evaluated' using errcode = 'P0001';
    end if;
    if new.test_evidence_id is null or new.tested_tenant_config_version_id is distinct from v_head_t
       or new.tested_module_config_version_id is distinct from v_head_m then
      raise exception 'arc_lifecycle:test_evidence_missing: no passing test of the current versions' using errcode = 'P0001';
    end if;
    if cardinality(new.pending_requirements) > 0 then
      raise exception 'arc_lifecycle:requirements_pending: still pending: %', array_to_string(new.pending_requirements, ', ')
        using errcode = 'P0001';
    end if;
    if new.health_status in ('failing', 'blocking') then
      raise exception 'arc_lifecycle:health_blocks_activation: health is %', new.health_status using errcode = 'P0001';
    end if;
    v_shadow := 'shadow' = any(old.pending_requirements) or exists (
      select 1 from public.registry_module_versions mv
       where mv.module_key = new.module_key and mv.status in ('pilot', 'available') and mv.requires_shadow_mode
    );
    if v_shadow and (new.shadow_evidence_id is null or new.shadow_tenant_config_version_id is distinct from v_head_t
                     or new.shadow_module_config_version_id is distinct from v_head_m) then
      raise exception 'arc_lifecycle:shadow_evidence_missing: no passing shadow review of the current versions' using errcode = 'P0001';
    end if;
  elsif new.state = 'active' and old.state = 'active'
        and (new.authorized_tenant_config_version_id, new.authorized_module_config_version_id)
          is distinct from (old.authorized_tenant_config_version_id, old.authorized_module_config_version_id) then
    -- staying live on new versions: only what the registry's recorded impact allows.
    if new.observed_tenant_config_version_id is distinct from v_head_t or new.observed_module_config_version_id is distinct from v_head_m then
      raise exception 'arc_lifecycle:authorization_stale: live authorisation moves only to evaluated versions' using errcode = 'P0001';
    end if;
    v_classes := public.lifecycle_chain_classes(
      new.tenant_id, new.module_key,
      old.authorized_tenant_config_version_id, old.authorized_module_config_version_id,
      new.authorized_tenant_config_version_id, new.authorized_module_config_version_id
    );
    if v_h.transition = 'apply_config_change' and v_h.actor_type = 'system' then
      if not (v_classes <@ array['no_consequence']::text[]) then
        raise exception 'arc_lifecycle:requirements_pending: a change with consequences (%) cannot carry live authorisation forward',
          array_to_string(v_classes, ', ')
          using errcode = 'P0001';
      end if;
    elsif v_h.transition = 'record_test' and v_h.actor_type = 'operator' then
      if new.test_evidence_id is null or new.tested_tenant_config_version_id is distinct from v_head_t
         or new.tested_module_config_version_id is distinct from v_head_m or cardinality(new.pending_requirements) > 0 then
        raise exception 'arc_lifecycle:test_evidence_missing: a retest authorises the versions it passed for, with nothing else pending'
          using errcode = 'P0001';
      end if;
      if not (v_classes <@ array['no_consequence', 'requires_retest']::text[]) then
        raise exception 'arc_lifecycle:requirements_pending: a change that needed more than a retest (%) needs an operator''s reactivation',
          array_to_string(v_classes, ', ')
          using errcode = 'P0001';
      end if;
    else
      raise exception 'arc_lifecycle:illegal_transition: live authorisation moves only by activation, a consequence-free change or a passing retest'
        using errcode = 'P0001';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists tenant_modules_guard on public.tenant_modules;
create trigger tenant_modules_guard
  before insert or update or delete on public.tenant_modules
  for each row execute function public.tenant_modules_guard();

-- At commit: a lifecycle row whose version has no history row does not exist.
-- Deferred, so the order of the two inserts inside one transaction is free.
create or replace function public.tenant_modules_history_required()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if not exists (
    select 1 from public.tenant_module_transitions t
     where t.lifecycle_id = new.id and t.state_version = new.state_version and t.to_state = new.state
  ) then
    raise exception 'arc_lifecycle:illegal_transition: lifecycle % version % has no history row', new.id, new.state_version
      using errcode = 'P0001';
  end if;
  return null;
end;
$fn$;

drop trigger if exists tenant_modules_history_required on public.tenant_modules;
create constraint trigger tenant_modules_history_required
  after insert or update on public.tenant_modules
  deferrable initially deferred
  for each row execute function public.tenant_modules_history_required();

-- ── the switch is a mirror, and nothing else moves it ──
-- An insert takes the lifecycle's value rather than arguing with it: 0014's
-- publish function ensures the row with `insert … on conflict do nothing`, and a
-- BEFORE INSERT trigger fires before the conflict is found, so the default
-- `false` would otherwise refuse every publication for an active module. An
-- update that disagrees with the lifecycle is refused outright.
create or replace function public.module_configs_enabled_follows_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_active boolean;
begin
  select tm.state = 'active' into v_active
    from public.tenant_modules tm
   where tm.tenant_id = new.tenant_id and tm.module_key = new.module_key;
  if tg_op = 'INSERT' then
    new.enabled := coalesce(v_active, false);
    return new;
  end if;
  if new.enabled is distinct from coalesce(v_active, false) then
    raise exception 'arc_lifecycle:illegal_transition: module_configs.enabled mirrors the lifecycle (0015) — activate, pause or resume the module instead'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists module_configs_enabled_follows_lifecycle on public.module_configs;
create trigger module_configs_enabled_follows_lifecycle
  before insert or update of enabled on public.module_configs
  for each row execute function public.module_configs_enabled_follows_lifecycle();

-- ── a new run is authorised in the transaction that creates it ──
-- Named to fire after 0013's `automation_runs_guard_snapshot` (triggers on one
-- event fire alphabetically), so an unpinned run is still refused as unpinned.
create or replace function public.automation_runs_lifecycle_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_canary boolean;
  v_life   public.tenant_modules;
  v_found  boolean;
  v_pair_t uuid;
  v_pair_m uuid;
begin
  if tg_op = 'UPDATE' then
    if new.run_mode is distinct from old.run_mode then
      raise exception 'automation_runs: a run''s mode is fixed when it is created' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.run_mode is null then
    raise exception 'arc_lifecycle:invalid_run_mode: a new run states its mode — live, test or shadow' using errcode = 'P0001';
  end if;
  select l.is_canary into v_canary from public.leads l where l.id = new.lead_id and l.tenant_id = new.tenant_id;
  -- a share lock: a transition holding the row waits for this insert, or this
  -- insert waits for the transition and reads what it committed.
  select * into v_life from public.tenant_modules tm
   where tm.tenant_id = new.tenant_id and tm.module_key = new.module_key
     for share;
  v_found := found;

  if new.run_mode = 'test' then
    if v_canary is not true then
      raise exception 'arc_lifecycle:mode_not_permitted: a test run is a synthetic lead' using errcode = 'P0001';
    end if;
    if not v_found or v_life.state not in ('testing', 'shadow', 'active', 'paused') then
      raise exception 'arc_lifecycle:module_not_active: a test run needs the module in testing, shadow, active or paused'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if v_canary is true then
    raise exception 'arc_lifecycle:mode_not_permitted: a synthetic lead cannot start a % run', new.run_mode using errcode = 'P0001';
  end if;
  select s.tenant_config_version_id, s.module_config_version_id into v_pair_t, v_pair_m
    from public.lead_recovery_config_snapshots s
   where s.id = new.config_snapshot_id and s.tenant_id = new.tenant_id;

  if new.run_mode = 'shadow' then
    if not v_found or v_life.state <> 'shadow' then
      raise exception 'arc_lifecycle:module_not_active: a shadow run needs the module in shadow' using errcode = 'P0001';
    end if;
    if v_pair_t is null then
      raise exception 'arc_lifecycle:snapshot_missing: a shadow run is pinned to published versions' using errcode = 'P0001';
    end if;
    if v_life.health_status = 'blocking' then
      raise exception 'arc_lifecycle:health_blocks_execution: health is blocking' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- live
  if not v_found or v_life.state <> 'active' then
    if v_found and v_life.state = 'paused' then
      raise exception 'arc_lifecycle:module_paused: a live run needs the module active — it is paused' using errcode = 'P0001';
    end if;
    raise exception 'arc_lifecycle:module_not_active: a live run needs the module active' using errcode = 'P0001';
  end if;
  if cardinality(v_life.pending_requirements) > 0 then
    raise exception 'arc_lifecycle:requirements_pending: pending: %', array_to_string(v_life.pending_requirements, ', ')
      using errcode = 'P0001';
  end if;
  if v_life.health_status in ('failing', 'blocking') then
    raise exception 'arc_lifecycle:health_blocks_execution: health is %', v_life.health_status using errcode = 'P0001';
  end if;
  if v_pair_t is null or v_pair_t is distinct from v_life.authorized_tenant_config_version_id
     or v_pair_m is distinct from v_life.authorized_module_config_version_id then
    raise exception 'arc_lifecycle:authorization_stale: a live run is pinned to exactly the versions an operator authorised'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists automation_runs_lifecycle_guard on public.automation_runs;
create trigger automation_runs_lifecycle_guard
  before insert or update on public.automation_runs
  for each row execute function public.automation_runs_lifecycle_guard();

-- ── a shadow run acts on nothing, so nothing is queued against it ──
create or replace function public.scheduled_actions_lifecycle_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if exists (
    select 1 from public.automation_runs r
     where r.id = new.run_id and r.tenant_id = new.tenant_id and r.run_mode = 'shadow'
  ) then
    raise exception 'arc_lifecycle:shadow_no_effects: a shadow run records what would have happened and queues nothing'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists scheduled_actions_lifecycle_guard on public.scheduled_actions;
create trigger scheduled_actions_lifecycle_guard
  before insert on public.scheduled_actions
  for each row execute function public.scheduled_actions_lifecycle_guard();

-- ---------------------------------------------------------------------------
-- 8. the reservation re-reads the lifecycle
-- ---------------------------------------------------------------------------

-- 0011's function, with one block added in front: a live effect is reserved
-- only while its module is active, its health is not failing or blocking, and
-- its run was started live — read under a share lock, so a pause committed
-- before this call refuses it. A synthetic effect must belong to a synthetic
-- lead. The rest of the body is 0011's, unchanged.
create or replace function public.reserve_lead_recovery_effect(
  p_tenant       uuid,
  p_effect_key   text,
  p_effect_type  text,
  p_idempotency  text,
  p_worker       text,
  p_lease        uuid,
  p_run          uuid default null,
  p_lead         uuid default null,
  p_action       uuid default null,
  p_conversation uuid default null,
  p_destination  text default null,
  p_is_canary    boolean default false
)
returns table (attempt_id uuid, reserved boolean, state text, attempt_no integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row    public.lead_recovery_effect_attempts%rowtype;
  v_module text;
  v_mode   text;
  v_life   public.tenant_modules;
begin
  -- ── 0015: the lifecycle, in the same transaction as the reservation ──
  select r.module_key, r.run_mode into v_module, v_mode
    from public.automation_runs r where r.id = p_run and r.tenant_id = p_tenant;
  if p_is_canary then
    if p_lead is null or not exists (
      select 1 from public.leads l where l.id = p_lead and l.tenant_id = p_tenant and l.is_canary
    ) then
      raise exception 'arc_lifecycle:mode_not_permitted: a synthetic effect must belong to a synthetic lead' using errcode = 'P0001';
    end if;
  else
    select * into v_life from public.tenant_modules tm
     where tm.tenant_id = p_tenant and tm.module_key = coalesce(v_module, 'lead_recovery')
       for share;
    if not found or v_life.state <> 'active' then
      if found and v_life.state = 'paused' then
        raise exception 'arc_lifecycle:module_paused: the module is paused — nothing live may be reserved' using errcode = 'P0001';
      end if;
      raise exception 'arc_lifecycle:module_not_active: the module is not active — nothing live may be reserved' using errcode = 'P0001';
    end if;
    if v_life.health_status in ('failing', 'blocking') then
      raise exception 'arc_lifecycle:health_blocks_execution: health is %', v_life.health_status using errcode = 'P0001';
    end if;
    if p_run is not null and v_mode is distinct from 'live' then
      if v_mode is null then
        raise exception 'arc_lifecycle:run_authorization_unproven: this run predates lifecycle authorisation' using errcode = 'P0001';
      end if;
      raise exception 'arc_lifecycle:mode_not_permitted: only a live run reserves a live effect' using errcode = 'P0001';
    end if;
  end if;
  -- ── end 0015 ──

  -- the fast path: nothing has ever claimed this effect.
  insert into public.lead_recovery_effect_attempts (
    tenant_id, run_id, lead_id, action_id, conversation_id,
    effect_type, effect_key, idempotency_key,
    worker, lease_token, destination_ref, is_canary, state
  )
  values (
    p_tenant, p_run, p_lead, p_action, p_conversation,
    p_effect_type, p_effect_key, p_idempotency,
    p_worker, p_lease, p_destination, p_is_canary, 'reserved'
  )
  on conflict (tenant_id, effect_key) do nothing
  returning * into v_row;

  if found then
    return query select v_row.id, true, v_row.state, v_row.attempt_no;
    return;
  end if;

  -- somebody holds it. take the row under a lock and decide.
  select * into v_row
    from public.lead_recovery_effect_attempts
   where tenant_id = p_tenant and effect_key = p_effect_key
   for update;

  if v_row.state in ('rejected', 'failed_retryable', 'cancelled_before_send') then
    update public.lead_recovery_effect_attempts
       set state            = 'reserved',
           worker           = p_worker,
           lease_token      = p_lease,
           attempt_no       = v_row.attempt_no + 1,
           error_category   = null,
           error_detail     = null,
           retryable        = null,
           dispatch_started_at = null,
           completed_at     = null
     where id = v_row.id
    returning * into v_row;
    return query select v_row.id, true, v_row.state, v_row.attempt_no;
    return;
  end if;

  -- reserved / dispatching / accepted / confirmed / outcome_unknown /
  -- reconciliation_required / failed_terminal — all refuse.
  return query select v_row.id, false, v_row.state, v_row.attempt_no;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. every lifecycle change — one transaction
-- ---------------------------------------------------------------------------

-- The engine (`_shared/lifecycle/engine.ts`) has evaluated readiness and the
-- change impact and hands over the resulting change; this function proves the
-- structure of it and writes it: the actor, the lock, the expected version, the
-- idempotency key, the legal destination (from the rules table, never from the
-- caller), the evidence, the history row, the lifecycle row (which its trigger
-- re-checks), the switch, the cancellation of queued live work, the audit row.
create or replace function public.apply_tenant_module_transition(
  p_tenant                 uuid,
  p_module_key             text,
  p_transition             text,
  p_expected_state_version bigint,
  p_actor_type             text,
  p_actor                  uuid,
  p_reason_code            text,
  p_reason                 text,
  p_idempotency_key        text,
  p_change                 jsonb default '{}'::jsonb,
  p_correlation_id         text default null
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_row       public.tenant_modules;
  v_existing  boolean;
  v_from      text;
  v_to        text;
  v_version   bigint;
  v_prev      public.tenant_module_transitions;
  v_evidence  public.tenant_module_evidence;
  v_history   public.tenant_module_transitions;
  v_heads     record;
  v_ev        jsonb := p_change -> 'evidence';
  v_apply     text := p_change ->> 'apply_evidence_as';
  v_pending   text[];
  v_cancelled integer := 0;
  v_change    jsonb := coalesce(p_change, '{}'::jsonb);
begin
  -- who
  if p_actor_type = 'operator' then
    perform public.lifecycle_require_operator(p_actor);
  elsif p_actor_type = 'system' then
    if p_actor is not null then
      raise exception 'arc_lifecycle:forbidden: the system acts as nobody in particular' using errcode = 'P0001';
    end if;
  else
    raise exception 'arc_lifecycle:forbidden: unknown actor type %', p_actor_type using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.registry_modules rm where rm.key = p_module_key) then
    raise exception 'arc_lifecycle:module_not_found: % is not a registered module', p_module_key using errcode = 'P0001';
  end if;
  if p_transition in ('backfill_selected', 'backfill_paused') then
    raise exception 'arc_lifecycle:illegal_transition: the backfill is the migration''s' using errcode = 'P0001';
  end if;

  -- one writer per lifecycle, including the first
  perform pg_advisory_xact_lock(hashtextextended('arc_lifecycle:' || p_tenant::text || ':' || p_module_key, 0));

  -- a repeated key is the first answer
  select * into v_prev from public.tenant_module_transitions t
   where t.tenant_id = p_tenant and t.module_key = p_module_key and t.idempotency_key = p_idempotency_key;
  if found then
    if v_prev.transition <> p_transition then
      raise exception 'arc_lifecycle:idempotency_conflict: that key was used for %', v_prev.transition using errcode = 'P0001';
    end if;
    select * into v_row from public.tenant_modules tm where tm.id = v_prev.lifecycle_id;
    return jsonb_build_object(
      'replayed', true,
      'transition', to_jsonb(v_prev),
      'lifecycle', to_jsonb(v_row),
      'evidence', (select to_jsonb(e) from public.tenant_module_evidence e where e.id = v_prev.evidence_id),
      'cancelled_actions', 0
    );
  end if;

  select * into v_row from public.tenant_modules tm
   where tm.tenant_id = p_tenant and tm.module_key = p_module_key
     for update;
  v_existing := found;
  v_from := case when v_existing then v_row.state else 'unselected' end;
  v_version := case when v_existing then v_row.state_version else 0 end;
  if p_expected_state_version is distinct from v_version then
    raise exception 'arc_lifecycle:stale_state: the lifecycle is at version %, not %', v_version, p_expected_state_version
      using errcode = 'P0001';
  end if;

  select r.to_state into v_to from public.lifecycle_transition_rules r
   where r.transition = p_transition and r.from_state = v_from and r.actor_type = p_actor_type;
  if not found then
    if exists (select 1 from public.lifecycle_transition_rules r where r.transition = p_transition and r.from_state = v_from) then
      raise exception 'arc_lifecycle:forbidden: % from % is not a % action', p_transition, v_from, p_actor_type using errcode = 'P0001';
    end if;
    raise exception 'arc_lifecycle:illegal_transition: a module that is % cannot %', v_from, replace(p_transition, '_', ' ')
      using errcode = 'P0001';
  end if;
  if p_transition = 'select' and not exists (
    select 1 from public.registry_module_versions mv where mv.module_key = p_module_key and mv.status in ('pilot', 'available')
  ) then
    raise exception 'arc_lifecycle:module_unavailable: % has no selectable version', p_module_key using errcode = 'P0001';
  end if;

  v_pending := coalesce(array(select jsonb_array_elements_text(v_change -> 'pending_requirements')), '{}'::text[]);
  select h.tenant_version_id, h.module_version_id into v_heads from public.lifecycle_heads(p_tenant, p_module_key) h;

  if not v_existing then
    -- the first selection: the lifecycle row, then its first history row.
    insert into public.tenant_modules (
      tenant_id, module_key, state, state_version,
      observed_tenant_config_version_id, observed_module_config_version_id
    ) values (
      p_tenant, p_module_key, v_to, 1,
      (v_change -> 'observed' ->> 'tenant_version_id')::uuid,
      (v_change -> 'observed' ->> 'module_version_id')::uuid
    )
    returning * into v_row;
  else
    if v_ev is not null and jsonb_typeof(v_ev) = 'object' then
      insert into public.tenant_module_evidence (
        tenant_id, module_key, lifecycle_id, kind, outcome, run_mode,
        tenant_config_version_id, module_config_version_id, config_hash, capabilities,
        run_id, summary, actor_type, recorded_by
      ) values (
        p_tenant, p_module_key, v_row.id, v_ev ->> 'kind', v_ev ->> 'outcome', v_ev ->> 'run_mode',
        (v_ev ->> 'tenant_version_id')::uuid, (v_ev ->> 'module_version_id')::uuid, v_ev ->> 'config_hash',
        coalesce(array(select jsonb_array_elements_text(v_ev -> 'capabilities')), '{}'::text[]),
        (v_ev ->> 'run_id')::uuid, coalesce(v_ev -> 'summary', '{}'::jsonb), p_actor_type, p_actor
      )
      returning * into v_evidence;
    end if;
    if v_apply is not null then
      if v_evidence.id is null or v_evidence.outcome <> 'passed'
         or v_evidence.tenant_config_version_id is distinct from v_heads.tenant_version_id
         or v_evidence.module_config_version_id is distinct from v_heads.module_version_id
         or (v_apply = 'test' and v_evidence.kind <> 'test')
         or (v_apply = 'shadow' and v_evidence.kind <> 'shadow_review')
         or v_apply not in ('test', 'shadow') then
        raise exception 'arc_lifecycle:evidence_invalid: only a pass for the current published versions is accepted'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  insert into public.tenant_module_transitions (
    tenant_id, module_key, lifecycle_id, state_version, transition, from_state, to_state,
    actor_type, actor_id, reason_code, reason, idempotency_key, correlation_id,
    tenant_config_version_id, module_config_version_id,
    previous_tenant_config_version_id, previous_module_config_version_id,
    evidence_id, impact, policy, pending_before, pending_after, health_before, health_after, metadata
  ) values (
    p_tenant, p_module_key, v_row.id, v_version + 1, p_transition, v_from, v_to,
    p_actor_type, p_actor, p_reason_code, left(p_reason, 300), p_idempotency_key, p_correlation_id,
    (v_change -> 'versions' ->> 'tenant_version_id')::uuid, (v_change -> 'versions' ->> 'module_version_id')::uuid,
    (v_change -> 'previous_versions' ->> 'tenant_version_id')::uuid, (v_change -> 'previous_versions' ->> 'module_version_id')::uuid,
    v_evidence.id,
    coalesce(v_change -> 'impact', '{}'::jsonb), coalesce(v_change -> 'policy', '{}'::jsonb),
    case when v_existing then v_row.pending_requirements else '{}'::text[] end,
    case when v_existing then v_pending else '{}'::text[] end,
    case when v_existing then v_row.health_status end,
    case when v_existing and v_change ? 'health' then v_change -> 'health' ->> 'status' else v_row.health_status end,
    coalesce(v_change -> 'metadata', '{}'::jsonb)
  )
  returning * into v_history;

  if v_existing then
    update public.tenant_modules tm set
      state = v_to,
      state_version = v_version + 1,
      pending_requirements = v_pending,
      observed_tenant_config_version_id = case when v_change ? 'observed'
        then (v_change -> 'observed' ->> 'tenant_version_id')::uuid else tm.observed_tenant_config_version_id end,
      observed_module_config_version_id = case when v_change ? 'observed'
        then (v_change -> 'observed' ->> 'module_version_id')::uuid else tm.observed_module_config_version_id end,
      authorized_tenant_config_version_id = case when v_change ? 'authorized'
        then (v_change -> 'authorized' ->> 'tenant_version_id')::uuid else tm.authorized_tenant_config_version_id end,
      authorized_module_config_version_id = case when v_change ? 'authorized'
        then (v_change -> 'authorized' ->> 'module_version_id')::uuid else tm.authorized_module_config_version_id end,
      tested_tenant_config_version_id = case when v_apply = 'test' then v_evidence.tenant_config_version_id else tm.tested_tenant_config_version_id end,
      tested_module_config_version_id = case when v_apply = 'test' then v_evidence.module_config_version_id else tm.tested_module_config_version_id end,
      test_evidence_id = case when v_apply = 'test' then v_evidence.id else tm.test_evidence_id end,
      shadow_tenant_config_version_id = case when v_apply = 'shadow' then v_evidence.tenant_config_version_id else tm.shadow_tenant_config_version_id end,
      shadow_module_config_version_id = case when v_apply = 'shadow' then v_evidence.module_config_version_id else tm.shadow_module_config_version_id end,
      shadow_evidence_id = case when v_apply = 'shadow' then v_evidence.id else tm.shadow_evidence_id end,
      health_status = case when v_change ? 'health' then v_change -> 'health' ->> 'status' else tm.health_status end,
      health_reason = case when v_change ? 'health' then left(v_change -> 'health' ->> 'reason', 300) else tm.health_reason end,
      health_evidence = case when v_change ? 'health' then coalesce(v_change -> 'health' -> 'evidence', '{}'::jsonb) else tm.health_evidence end,
      health_checked_at = case when v_change ? 'health' then now() else tm.health_checked_at end
    where tm.id = v_row.id
    returning * into v_row;
  end if;

  -- the switch mirrors the lifecycle. a module whose own tables have no switch
  -- row (every module but Lead Recovery today) simply has none.
  if p_transition = 'select' then
    begin
      insert into public.module_configs (tenant_id, module_key) values (p_tenant, p_module_key)
      on conflict (tenant_id, module_key) do nothing;
    exception when check_violation then null;
    end;
  end if;
  update public.module_configs mc set enabled = (v_row.state = 'active')
   where mc.tenant_id = p_tenant and mc.module_key = p_module_key and mc.enabled is distinct from (v_row.state = 'active');

  -- leaving live: queued work that would reach somebody is cancelled. a handoff
  -- or a close still runs — it puts a person on the lead or closes it, and any
  -- message it would send is refused at the reservation. synthetic runs are left.
  if p_transition in ('pause', 'system_pause', 'deselect') then
    with cancelled as (
      update public.scheduled_actions a
         set status = 'cancelled',
             last_error = 'the module was ' || case when p_transition = 'deselect' then 'deselected' else 'paused' end
                          || ' (' || p_reason_code || ')',
             completed_at = now()
        from public.automation_runs r
       where a.tenant_id = p_tenant and a.status = 'pending'
         and r.id = a.run_id and r.tenant_id = a.tenant_id and r.module_key = p_module_key
         and r.run_mode is distinct from 'test'
         and a.action_type not in ('open_handoff', 'close_run')
      returning a.id
    )
    select count(*) into v_cancelled from cancelled;
  end if;

  insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
  values (
    p_actor, 'module.' || p_transition, 'tenant', p_tenant::text,
    jsonb_build_object(
      'module_key', p_module_key,
      'from_state', v_from,
      'to_state', v_row.state,
      'state_version', v_row.state_version,
      'reason_code', p_reason_code,
      'transition_id', v_history.id,
      'evidence_id', v_evidence.id,
      'pending', to_jsonb(v_row.pending_requirements),
      'cancelled_actions', v_cancelled
    )
  );

  return jsonb_build_object(
    'replayed', false,
    'transition', to_jsonb(v_history),
    'lifecycle', to_jsonb(v_row),
    'evidence', case when v_evidence.id is null then null else to_jsonb(v_evidence) end,
    'cancelled_actions', v_cancelled
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------------

-- A tenant member may read their own modules' lifecycle — whether Lead Recovery
-- is live for their business, and why not — and nothing of anyone else's.
-- History and evidence carry operators' reasons and synthetic-run detail and are
-- operator material, like configuration (0014). No write policy for any role.

alter table public.lifecycle_transition_rules enable row level security;
alter table public.tenant_modules             enable row level security;
alter table public.tenant_module_transitions  enable row level security;
alter table public.tenant_module_evidence     enable row level security;

drop policy if exists lifecycle_transition_rules_read on public.lifecycle_transition_rules;
create policy lifecycle_transition_rules_read on public.lifecycle_transition_rules
  for select to authenticated using (true);

drop policy if exists tenant_modules_read on public.tenant_modules;
create policy tenant_modules_read on public.tenant_modules
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists tenant_module_transitions_admin_read on public.tenant_module_transitions;
create policy tenant_module_transitions_admin_read on public.tenant_module_transitions
  for select to authenticated using (public.is_arc_admin());

drop policy if exists tenant_module_evidence_admin_read on public.tenant_module_evidence;
create policy tenant_module_evidence_admin_read on public.tenant_module_evidence
  for select to authenticated using (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- 11. privileges
-- ---------------------------------------------------------------------------

revoke all on function public.apply_tenant_module_transition(uuid, text, text, bigint, text, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.reserve_lead_recovery_effect(uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function public.lifecycle_heads(uuid, text) from public, anon, authenticated;
revoke all on function public.lifecycle_impact_classes(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.lifecycle_chain_classes(uuid, text, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.lifecycle_require_operator(uuid) from public, anon, authenticated;
revoke all on function public.lifecycle_transition_rules_are_immutable() from public, anon, authenticated;
revoke all on function public.tenant_module_transitions_guard() from public, anon, authenticated;
revoke all on function public.tenant_module_evidence_guard() from public, anon, authenticated;
revoke all on function public.tenant_modules_guard() from public, anon, authenticated;
revoke all on function public.tenant_modules_history_required() from public, anon, authenticated;
revoke all on function public.module_configs_enabled_follows_lifecycle() from public, anon, authenticated;
revoke all on function public.automation_runs_lifecycle_guard() from public, anon, authenticated;
revoke all on function public.scheduled_actions_lifecycle_guard() from public, anon, authenticated;

grant execute on function public.apply_tenant_module_transition(uuid, text, text, bigint, text, uuid, text, text, text, jsonb, text)
  to service_role;
grant execute on function public.reserve_lead_recovery_effect(uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, text, boolean)
  to service_role;
grant execute on function public.lifecycle_heads(uuid, text) to service_role;
grant execute on function public.lifecycle_impact_classes(jsonb, text, text) to service_role;
grant execute on function public.lifecycle_chain_classes(uuid, text, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.lifecycle_require_operator(uuid) to service_role;
