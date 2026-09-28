-- ===========================================================================
-- 0017 — durable runs, actions, attempts and scheduling (ARC-200)
-- ===========================================================================
--
-- 0010 built a durable queue for one module: `automation_runs` (one per lead),
-- `scheduled_actions` (what happens next, claimed `for update skip locked`), and
-- 0011/0013/0015 fenced, pinned and lifecycle-gated it. Everything it can run is a
-- Lead Recovery action handed to one dispatcher (engine/runtime.ts).
--
-- ARC-200 makes that queue the platform's, without building a second one. There is
-- still one table of runs, one table of actions, one lease and fence, one
-- idempotency constraint. This migration adds what a generic scheduler needs and the
-- 0010 queue lacked:
--
--   automation_action_types     the reviewed vocabulary of action types, and for each
--                               one the policy the scheduler applies: who dispatches
--                               it, whether it can reach the outside world, whether it
--                               may proceed while its module is paused, which
--                               connection state it needs, and its retry policy.
--   automation_runs             a run is no longer necessarily a lead conversation. It
--                               has a kind, a generic status, a correlation id, an
--                               idempotency key, the registry module version and the
--                               lifecycle state it began under, and who created it.
--   scheduled_actions           the module it belongs to, when it was first due, a
--                               stored lease expiry, a connection reference, and the
--                               last gate verdict — plus `running`, `skipped` and
--                               `dead_letter`.
--   automation_action_attempts  one row per claim. Retrying never overwrites a prior
--                               attempt; an attempt records its runner, outcome, safe
--                               error, provider/runner references, whether the outcome
--                               is ambiguous and whether it may be retried.
--
-- ---------------------------------------------------------------------------
-- Two dispatchers, one queue
-- ---------------------------------------------------------------------------
--
-- The Lead Recovery dispatcher claims every due action it knows and decides at
-- execution time: a paused module's contact actions are cancelled, its bookkeeping
-- still runs. The ARC-200 scheduler holds work instead — a paused module's actions
-- stay pending, visible and unclaimed, and resume with the module. Both are right for
-- their callers, and changing Lead Recovery's is ARC-LR-430's decision, not this
-- migration's. So each action type names its dispatcher, and each claim path claims
-- only its own: the Lead Recovery claim can never be handed a scheduler action it has
-- no handler for, and the scheduler claim never takes a text message away from the
-- engine that knows how to stop it. For the same reason 0015's pause, which cancels a
-- module's queued work, now cancels only the Lead Recovery engine's (§12) — the
-- scheduler's is held, and released by the resume. A deselection still ends both.
--
-- ---------------------------------------------------------------------------
-- The rules, enforced here rather than remembered in TypeScript
-- ---------------------------------------------------------------------------
--
--   * An action is claimable only when due, pinned to its run's snapshot, not held
--     by a gate, and not terminal. "Claimable" is derived, never stored: storing it
--     would need a clock to flip it.
--   * The gate is re-read at the claim and again when an attempt starts: run status,
--     tenant status, the lifecycle (0015) for the run's mode, module health, and the
--     connection (0016) the action names. Only an action type with no external effect
--     may proceed while its module or run is paused.
--   * A lease is a token, a fence and a stored expiry. Only the holder can start,
--     settle or release; an expired lease is reclaimed by the next sweep.
--   * An attempt that had STARTED an external effect when its lease expired is not
--     retried: its outcome is unknown, so it is recorded as ambiguous and the action
--     is blocked until a person reconciles it. The same holds when a runner reports an
--     ambiguous outcome. Nothing resends an effect that may already have happened.
--   * Retries back off by the action type's policy, create a new attempt, and stop at
--     `max_attempts` in `dead_letter`.
--
-- ---------------------------------------------------------------------------
-- Who can write
-- ---------------------------------------------------------------------------
--
-- No browser role, on any of it — the 0010 pattern. Every write is a security
-- definer function executable by the service role alone, and the triggers bind the
-- service role too. Operators read everything; a tenant member reads their own runs
-- (0010's policy, unchanged) and nothing of the queue, its attempts or its vocabulary.
--
-- Forward-only. Nothing is dropped except one inline check constraint on
-- scheduled_actions.action_type (replaced by a foreign key to the vocabulary),
-- triggers being replaced by name, and two check constraints widened in place.
-- Existing Lead Recovery rows keep working: their actions are typed by the
-- vocabulary seeded below, and their runs are lead conversations.

-- ---------------------------------------------------------------------------
-- 0. re-runnable: the guards below are recreated further down
-- ---------------------------------------------------------------------------

drop trigger if exists automation_runs_scheduler_guard on public.automation_runs;
drop trigger if exists scheduled_actions_scheduler_guard on public.scheduled_actions;

-- ---------------------------------------------------------------------------
-- 1. two shared predicates
-- ---------------------------------------------------------------------------

-- The blunt instrument every table since 0010 carries, as one function so the checks
-- and the sanitiser below cannot drift from each other. The last alternative is a JWT.
create or replace function public.scheduler_secret_shaped(p text)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(p, '') ~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer |eyJ[A-Za-z0-9_-]{8,}\.)';
$fn$;

-- Error text that reaches a console. Engine and runner messages are written by our
-- code, but one that quotes a provider could carry anything: a secret-shaped message
-- is replaced rather than refused, because refusing would fail the completion it
-- describes.
create or replace function public.scheduler_safe_text(p text, p_max integer default 500)
returns text
language sql
immutable
set search_path = public
as $fn$
  select case
    when p is null then null
    when public.scheduler_secret_shaped(p) then '[redacted: the message looked like it carried a credential]'
    else left(p, greatest(p_max, 1))
  end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. the vocabulary of action types
-- ---------------------------------------------------------------------------

create table if not exists public.automation_action_types (
  key                    text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- which claim path may take it. 'lead_recovery_engine' is engine/runtime.ts,
  -- 'scheduler' is _shared/scheduler.
  dispatcher             text not null check (dispatcher in ('lead_recovery_engine', 'scheduler')),
  -- none            touches nothing outside ARC.
  -- external_read   calls out but changes nothing there (a model, a connection
  --                 test) — safe to repeat.
  -- external_effect sends or mutates something outside ARC — never repeated on an
  --                 unknown outcome.
  effect_class           text not null check (effect_class in ('none', 'external_read', 'external_effect')),
  -- hold     not claimable while its module, tenant or run is paused or blocked.
  -- proceed  claimable anyway: bookkeeping that puts a person on something.
  -- engine   the Lead Recovery engine decides at execution (see the header).
  paused_policy          text not null check (paused_policy in ('hold', 'proceed', 'engine')),
  -- none      no tenant connection.
  -- testable  a connection that exists and has not ended: what a connection test needs.
  -- verified  a connection that serves (verified or degraded), per ARC-130.
  connection_requirement text not null check (connection_requirement in ('none', 'testable', 'verified')),
  default_max_attempts   integer not null check (default_max_attempts between 1 and 20),
  retry_base_seconds     integer not null check (retry_base_seconds between 1 and 86400),
  retry_ceiling_seconds  integer not null check (retry_ceiling_seconds between 1 and 604800),
  description            text not null check (char_length(description) between 1 and 300),

  constraint automation_action_types_backoff_bounded check (retry_ceiling_seconds >= retry_base_seconds),
  -- the Lead Recovery engine decides its own pause behaviour, and only it does.
  constraint automation_action_types_engine_decides
    check ((dispatcher = 'lead_recovery_engine') = (paused_policy = 'engine')),
  -- nothing that can reach the outside world proceeds while its module is paused.
  constraint automation_action_types_effects_hold
    check (effect_class = 'none' or paused_policy <> 'proceed'),
  -- a type that touches nothing outside ARC needs no connection.
  constraint automation_action_types_internal_needs_no_connection
    check (effect_class <> 'none' or connection_requirement = 'none')
);

-- Seeded from, and drift-tested against, ACTION_TYPES in
-- supabase/functions/_shared/scheduler/model.ts.
insert into public.automation_action_types
  (key, dispatcher, effect_class, paused_policy, connection_requirement,
   default_max_attempts, retry_base_seconds, retry_ceiling_seconds, description)
values
  -- Lead Recovery's seven, exactly as the engine already runs them. Retry numbers are
  -- the engine's own (runtime.ts RETRY_BASE_SECONDS / RETRY_CEILING_SECONDS).
  ('send_first_response', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800,
   'Lead Recovery: the first text back to a missed caller or form lead.'),
  ('send_followup',       'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800,
   'Lead Recovery: a follow-up text in the sequence.'),
  ('notify_staff',        'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800,
   'Lead Recovery: alert the contractor''s staff.'),
  ('route_to_contractor', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800,
   'Lead Recovery: assign a qualified lead and alert staff.'),
  ('open_handoff',        'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800,
   'Lead Recovery: hand the lead to a person and alert staff.'),
  ('classify_reply',      'lead_recovery_engine', 'external_read',   'engine', 'none', 5, 60, 1800,
   'Lead Recovery: classify a reply; deterministic rules decide safety.'),
  ('close_run',           'lead_recovery_engine', 'none',            'engine', 'none', 5, 60, 1800,
   'Lead Recovery: close a quiet run out.'),
  -- the scheduler's. Handlers arrive with the runner (ARC-210); the vocabulary and its
  -- safety policy are fixed here, before anything can execute them.
  ('send_message',                  'scheduler', 'external_effect', 'hold',    'verified', 5, 60, 1800,
   'Send a message through a tenant connection.'),
  ('call_provider_operation',       'scheduler', 'external_effect', 'hold',    'verified', 5, 60, 1800,
   'Perform a mutating operation against a tenant''s provider.'),
  ('enqueue_runner_execution',      'scheduler', 'external_effect', 'hold',    'none',     5, 60, 1800,
   'Hand an approved execution to an external runner, whose effects are unknown to ARC.'),
  ('test_connection',               'scheduler', 'external_read',   'hold',    'testable', 3, 30, 600,
   'Verify a tenant connection with a read-only provider call.'),
  ('evaluate_reply',                'scheduler', 'external_read',   'hold',    'none',     3, 30, 600,
   'Evaluate an inbound reply; deterministic rules still decide safety.'),
  ('schedule_follow_up',            'scheduler', 'none',            'hold',    'none',     3, 30, 600,
   'Decide and queue the next step of a sequence from pinned configuration.'),
  ('record_observation_checkpoint', 'scheduler', 'none',            'proceed', 'none',     3, 30, 600,
   'Record a checkpoint at the end of an observation window. Records; decides nothing.'),
  ('request_human_review',          'scheduler', 'none',            'proceed', 'none',     3, 30, 600,
   'Put a person on something.'),
  ('remind_operator',               'scheduler', 'none',            'proceed', 'none',     3, 30, 600,
   'Surface a due reminder to an operator.')
on conflict (key) do nothing;

-- the vocabulary changes by migration and reviewed code, never at run time. a new
-- type is a new row in a new migration; an existing type's policy never changes
-- under actions already queued with it.
create or replace function public.automation_action_types_are_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'arc_scheduler:vocabulary_immutable: action types change by migration and reviewed code (attempted %)', tg_op
    using errcode = 'P0001';
end;
$fn$;

drop trigger if exists automation_action_types_immutable on public.automation_action_types;
create trigger automation_action_types_immutable
  before update or delete on public.automation_action_types
  for each row execute function public.automation_action_types_are_immutable();

-- ---------------------------------------------------------------------------
-- 3. runs: not only lead conversations
-- ---------------------------------------------------------------------------

alter table public.automation_runs
  add column if not exists run_kind                 text not null default 'lead_conversation',
  add column if not exists status                   text not null default 'running',
  add column if not exists status_reason            text,
  add column if not exists terminal_code            text,
  add column if not exists correlation_id           uuid,
  add column if not exists idempotency_key          text,
  add column if not exists runner_kind              text,
  add column if not exists module_version           integer,
  add column if not exists lifecycle_state_at_start text,
  add column if not exists created_by_type          text not null default 'system',
  add column if not exists created_by               uuid,
  add column if not exists created_at               timestamptz not null default now();

-- a connector test or an observation window has no lead. a lead conversation still
-- must, and 0010's one-run-per-lead key is unchanged.
alter table public.automation_runs alter column lead_id drop not null;
-- and it has not started when it is created: its first claim starts it. a lead
-- conversation starts when it is created, as it always has (the default stays).
alter table public.automation_runs alter column started_at drop not null;

-- rows from before this migration: they were all lead conversations, created when
-- they started, and their status is their state machine's (see the guard below).
update public.automation_runs r
   set created_at     = r.started_at,
       correlation_id = coalesce(r.correlation_id,
                          (select l.correlation_id from public.leads l where l.id = r.lead_id and l.tenant_id = r.tenant_id)),
       status = case
         when r.state = 'failed' then 'failed'
         when r.state in ('booked', 'closed') then 'completed'
         when r.state = 'suppressed' then 'cancelled'
         when r.state in ('handoff_required', 'handed_off') then 'blocked'
         else 'running'
       end
 where r.run_kind = 'lead_conversation';

do $$
begin
  alter table public.automation_runs add constraint automation_runs_kind_check
    check (run_kind in ('lead_conversation', 'connector_test', 'observation_window'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.automation_runs add constraint automation_runs_status_check
    check (status in ('pending', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.automation_runs add constraint automation_runs_lead_matches_kind
    check ((run_kind = 'lead_conversation') = (lead_id is not null));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.automation_runs add constraint automation_runs_started
    check (started_at is not null or run_kind <> 'lead_conversation');
exception when duplicate_object then null;
end $$;

-- a run with no lead is keyed by its caller, so a retried "start this test" is one run.
do $$
begin
  alter table public.automation_runs add constraint automation_runs_keyed
    check (run_kind = 'lead_conversation' or (idempotency_key is not null and correlation_id is not null));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.automation_runs add constraint automation_runs_fields_shaped check (
        (idempotency_key is null or char_length(idempotency_key) between 1 and 200)
    and (runner_kind is null or runner_kind ~ '^[a-z][a-z0-9_]{1,40}$')
    and (terminal_code is null or terminal_code ~ '^[a-z][a-z0-9_]{0,63}$')
    and (status_reason is null or char_length(status_reason) <= 300)
    and (lifecycle_state_at_start is null
         or lifecycle_state_at_start in ('unselected', 'configuring', 'testing', 'shadow', 'active', 'paused'))
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.automation_runs add constraint automation_runs_no_secrets
    check (not public.scheduler_secret_shaped(status_reason));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.automation_runs add constraint automation_runs_creator
    check ((created_by_type = 'operator' and created_by is not null)
        or (created_by_type = 'system' and created_by is null));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.automation_runs add constraint automation_runs_module_version_fk
    foreign key (module_key, module_version)
    references public.registry_module_versions (module_key, version);
exception when duplicate_object then null;
end $$;

create unique index if not exists automation_runs_idempotency_uniq
  on public.automation_runs (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists automation_runs_tenant_status_idx
  on public.automation_runs (tenant_id, status, updated_at desc);

-- ── 0013/0014's snapshot guard, with the lead comparison made null-safe ──
-- The body is 0014's. One line differs: `new.lead_id <> old.lead_id` was null for a
-- run with no lead, so a lead could have been attached to a connector test after the
-- fact. `is distinct from` refuses that.
create or replace function public.automation_runs_guard_snapshot()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_module  text;
  v_schema  integer;
  v_sources uuid;
begin
  if tg_op = 'INSERT' then
    if new.config_snapshot_id is null then
      raise exception 'automation_runs: a new run must be pinned to a configuration snapshot'
        using errcode = 'P0001';
    end if;

    select s.module_key, s.schema_version, s.module_config_version_id
      into v_module, v_schema, v_sources
      from public.lead_recovery_config_snapshots s
     where s.id = new.config_snapshot_id
       and s.tenant_id = new.tenant_id;
    if not found then
      raise exception 'automation_runs: snapshot % does not belong to tenant %',
        new.config_snapshot_id, new.tenant_id
        using errcode = 'P0001';
    end if;

    if v_module <> new.module_key then
      raise exception 'automation_runs: snapshot is for module %, not %', v_module, new.module_key
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1
        from public.registry_module_versions mv
       where mv.module_key = new.module_key
         and mv.status in ('pilot', 'available')
         and mv.config_schema_key is not null
         and mv.config_schema_version = v_schema
    ) then
      raise exception 'automation_runs: schema version % is not a registered configuration schema for %',
        v_schema, new.module_key
        using errcode = 'P0001';
    end if;

    if v_sources is null and exists (
      select 1 from public.module_config_versions m
       where m.tenant_id = new.tenant_id and m.module_key = new.module_key
    ) then
      raise exception 'automation_runs: % configuration for this tenant is versioned, so a new run must be pinned to a snapshot that names its versions',
        new.module_key
        using errcode = 'P0001';
    end if;

    return new;
  end if;

  if new.config_snapshot_id is distinct from old.config_snapshot_id then
    raise exception 'automation_runs: a run''s configuration snapshot is fixed when it is created'
      using errcode = 'P0001';
  end if;
  -- ── ARC-200: null-safe ──
  if new.tenant_id <> old.tenant_id
     or new.lead_id is distinct from old.lead_id
     or new.module_key <> old.module_key then
    raise exception 'automation_runs: tenant, lead and module are fixed when a run is created'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

-- ── 0015's lifecycle guard, with the synthetic-lead rule scoped to runs that have a lead ──
-- The body is 0015's. One rule differs: "a test run is a synthetic lead" is kept for
-- lead conversations and does not apply to a run that has no lead to be synthetic —
-- a connector test or an observation window in test mode. Every lifecycle-state rule
-- for every mode is unchanged, and a run with no lead can never reserve a Lead
-- Recovery effect (0015 §8 refuses a synthetic effect without a synthetic lead, and a
-- live one without a live run).
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
  select * into v_life from public.tenant_modules tm
   where tm.tenant_id = new.tenant_id and tm.module_key = new.module_key
     for share;
  v_found := found;

  if new.run_mode = 'test' then
    -- ── ARC-200: only a run with a lead has one to be synthetic ──
    if new.lead_id is not null and v_canary is not true then
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

-- A lead conversation's generic status is its state machine's, derived here so the
-- two can never disagree: a person holding the lead blocks automation, a booked or
-- closed run completed, an opted-out one was cancelled.
create or replace function public.lead_conversation_status(p_state text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select case
    when p_state = 'failed' then 'failed'
    when p_state in ('booked', 'closed') then 'completed'
    when p_state = 'suppressed' then 'cancelled'
    when p_state in ('handoff_required', 'handed_off') then 'blocked'
    else 'running'
  end;
$fn$;

-- Named to fire after the snapshot and lifecycle guards (alphabetical within an event).
create or replace function public.automation_runs_scheduler_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_correlation uuid;
  v_version     integer;
begin
  if tg_op = 'INSERT' then
    -- what the database knows, it writes: the run cannot claim a lifecycle state or a
    -- module version it did not start under.
    select tm.state into new.lifecycle_state_at_start
      from public.tenant_modules tm
     where tm.tenant_id = new.tenant_id and tm.module_key = new.module_key;

    select mv.version into v_version
      from public.registry_module_versions mv
      join public.lead_recovery_config_snapshots s
        on s.id = new.config_snapshot_id and s.tenant_id = new.tenant_id
     where mv.module_key = new.module_key
       and mv.status in ('pilot', 'available')
       and mv.config_schema_version = s.schema_version
     order by mv.version desc
     limit 1;
    if new.module_version is not null and new.module_version is distinct from v_version then
      raise exception 'arc_scheduler:module_version_mismatch: this run''s snapshot is for module version %, not %',
        v_version, new.module_version
        using errcode = 'P0001';
    end if;
    new.module_version := v_version;

    if new.run_kind = 'lead_conversation' then
      select l.correlation_id into v_correlation
        from public.leads l where l.id = new.lead_id and l.tenant_id = new.tenant_id;
      if new.correlation_id is not null and new.correlation_id is distinct from v_correlation then
        raise exception 'arc_scheduler:correlation_mismatch: a lead conversation carries its lead''s correlation id'
          using errcode = 'P0001';
      end if;
      new.correlation_id := v_correlation;
      new.status := public.lead_conversation_status(new.state);
    else
      -- a run with no lead begins pending: nothing has been claimed for it yet.
      new.status := 'pending';
      new.started_at := null;
      new.completed_at := null;
      new.stopped_at := null;
    end if;

    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE. what the run is, and where it came from, does not move.
  if new.run_kind is distinct from old.run_kind
     or new.correlation_id is distinct from old.correlation_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.module_version is distinct from old.module_version
     or new.lifecycle_state_at_start is distinct from old.lifecycle_state_at_start
     or new.created_by_type is distinct from old.created_by_type
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'arc_scheduler:run_identity_fixed: a run''s kind, keys, origin and starting context are fixed when it is created'
      using errcode = 'P0001';
  end if;
  -- a runner may be assigned once, never swapped.
  if old.runner_kind is not null and new.runner_kind is distinct from old.runner_kind then
    raise exception 'arc_scheduler:run_identity_fixed: a run''s runner is assigned once'
      using errcode = 'P0001';
  end if;

  if new.run_kind = 'lead_conversation' then
    new.status := public.lead_conversation_status(new.state);
  elsif old.status in ('completed', 'failed', 'cancelled') and new.status is distinct from old.status then
    raise exception 'arc_scheduler:run_finished: a % run does not change status', old.status
      using errcode = 'P0001';
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

create trigger automation_runs_scheduler_guard
  before insert or update on public.automation_runs
  for each row execute function public.automation_runs_scheduler_guard();

-- ---------------------------------------------------------------------------
-- 4. actions: typed, located, gated
-- ---------------------------------------------------------------------------

-- the closed list 0010 wrote inline becomes a reference to the vocabulary.
alter table public.scheduled_actions
  drop constraint if exists scheduled_actions_action_type_check;

do $$
begin
  alter table public.scheduled_actions add constraint scheduled_actions_action_type_fk
    foreign key (action_type) references public.automation_action_types (key);
exception when duplicate_object then null;
end $$;

-- 0011's list plus running (an attempt has started), skipped (the gate or its
-- handler found nothing to do) and dead_letter (retries exhausted).
alter table public.scheduled_actions
  drop constraint if exists scheduled_actions_status_check;
alter table public.scheduled_actions
  add constraint scheduled_actions_status_check
  check (status in ('pending', 'claimed', 'running', 'done', 'cancelled', 'failed', 'blocked', 'skipped', 'dead_letter'));

alter table public.scheduled_actions
  add column if not exists module_key       text,
  -- first due. `run_at` is when it is next due, and moves on every retry.
  add column if not exists scheduled_for    timestamptz,
  -- stored, not recomputed from the claimer's own lease length: 0011 compared
  -- `locked_at` with whatever lease the NEXT claimer asked for, so a sweep with a
  -- short lease could reclaim work another worker was entitled to for longer.
  add column if not exists lease_expires_at timestamptz,
  add column if not exists connector_key    text,
  add column if not exists connection_id    uuid,
  add column if not exists gate_code        text,
  add column if not exists gate_detail      text,
  add column if not exists gate_checked_at  timestamptz,
  add column if not exists updated_at       timestamptz not null default now();

update public.scheduled_actions a
   set module_key    = coalesce(a.module_key, r.module_key),
       -- the original time is not recoverable after a retry moved run_at; run_at is
       -- the best evidence there is, and it is written down as that.
       scheduled_for = coalesce(a.scheduled_for, a.run_at),
       lease_expires_at = case
         when a.status = 'claimed' and a.locked_at is not null and a.lease_expires_at is null
           then a.locked_at + interval '120 seconds'
         else a.lease_expires_at end
  from public.automation_runs r
 where r.id = a.run_id and r.tenant_id = a.tenant_id;

alter table public.scheduled_actions alter column module_key set not null;
alter table public.scheduled_actions alter column scheduled_for set not null;

do $$
begin
  alter table public.scheduled_actions add constraint scheduled_actions_id_tenant_key unique (id, tenant_id);
exception when duplicate_object or duplicate_table then null;
end $$;

-- a connection reference is ARC's connection metadata (0016), of the same tenant.
-- never a credential: 0016 keeps those where no API role can reach them.
do $$
begin
  alter table public.scheduled_actions add constraint scheduled_actions_connection_fk
    foreign key (connection_id, tenant_id) references public.provider_connections (id, tenant_id);
exception when duplicate_object then null;
end $$;

-- NOT VALID: new and updated rows are checked; rows already queued in a hosted
-- database are not re-judged by this migration.
do $$
begin
  alter table public.scheduled_actions add constraint scheduled_actions_shaped check (
        jsonb_typeof(payload) = 'object'
    and char_length(idempotency_key) between 1 and 200
    and (gate_code is null or gate_code ~ '^[a-z][a-z0-9_]{0,63}$')
    and (gate_detail is null or char_length(gate_detail) <= 300)
    and (connector_key is null or connector_key ~ '^[a-z][a-z0-9_]{1,40}$')
  ) not valid;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.scheduled_actions add constraint scheduled_actions_no_secrets
    check (not public.scheduler_secret_shaped(payload::text) and not public.scheduler_secret_shaped(gate_detail)) not valid;
exception when duplicate_object then null;
end $$;

create index if not exists scheduled_actions_scheduler_due_idx
  on public.scheduled_actions (run_at)
  where status = 'pending';
create index if not exists scheduled_actions_lease_expiry_idx
  on public.scheduled_actions (lease_expires_at)
  where status in ('claimed', 'running');
create index if not exists scheduled_actions_tenant_status_idx
  on public.scheduled_actions (tenant_id, status, run_at);

create or replace function public.scheduled_actions_scheduler_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_type   public.automation_action_types;
  v_run    public.automation_runs;
  v_conn   text;
begin
  select * into v_type from public.automation_action_types t where t.key = new.action_type;

  if tg_op = 'INSERT' then
    select * into v_run from public.automation_runs r where r.id = new.run_id and r.tenant_id = new.tenant_id;
    if new.module_key is not null and new.module_key is distinct from v_run.module_key then
      raise exception 'arc_scheduler:module_mismatch: an action belongs to its run''s module (%)', v_run.module_key
        using errcode = 'P0001';
    end if;
    new.module_key := v_run.module_key;
    new.scheduled_for := new.run_at;

    if new.connection_id is not null then
      select c.connector_key into v_conn
        from public.provider_connections c
       where c.id = new.connection_id and c.tenant_id = new.tenant_id;
      if new.connector_key is not null and new.connector_key is distinct from v_conn then
        raise exception 'arc_scheduler:connection_mismatch: that connection is a % connection', v_conn
          using errcode = 'P0001';
      end if;
      new.connector_key := v_conn;
    end if;

    if v_type.dispatcher = 'scheduler' then
      if v_type.connection_requirement <> 'none' and new.connection_id is null then
        raise exception 'arc_scheduler:connection_required: % needs a connection', new.action_type
          using errcode = 'P0001';
      end if;
      if v_run.status in ('completed', 'failed', 'cancelled') then
        raise exception 'arc_scheduler:run_finished: the run is % — nothing more is queued against it', v_run.status
          using errcode = 'P0001';
      end if;
      if new.status is distinct from 'pending' then
        raise exception 'arc_scheduler:illegal_status: an action is queued pending' using errcode = 'P0001';
      end if;
    end if;

    new.updated_at := now();
    return new;
  end if;

  -- UPDATE. what the action is, and when it was first due, does not move.
  if new.action_type is distinct from old.action_type
     or new.module_key is distinct from old.module_key
     or new.scheduled_for is distinct from old.scheduled_for
     or new.idempotency_key is distinct from old.idempotency_key
     or new.connection_id is distinct from old.connection_id
     or new.connector_key is distinct from old.connector_key then
    raise exception 'arc_scheduler:action_identity_fixed: an action''s type, module, key, connection and first due time are fixed when it is queued'
      using errcode = 'P0001';
  end if;

  if v_type.dispatcher = 'scheduler' then
    -- a retry sends what was queued, not what somebody later wished had been.
    if new.payload is distinct from old.payload then
      raise exception 'arc_scheduler:action_identity_fixed: an action''s payload is fixed when it is queued'
        using errcode = 'P0001';
    end if;
    -- terminal is terminal. (Lead Recovery's `retryAction` re-queues a failed action,
    -- so this binds the scheduler's own types only.)
    if old.status in ('done', 'cancelled', 'failed', 'skipped', 'dead_letter') and new.status is distinct from old.status then
      raise exception 'arc_scheduler:action_finished: a % action does not change status', old.status
        using errcode = 'P0001';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

create trigger scheduled_actions_scheduler_guard
  before insert or update on public.scheduled_actions
  for each row execute function public.scheduled_actions_scheduler_guard();

-- ---------------------------------------------------------------------------
-- 5. attempts
-- ---------------------------------------------------------------------------

create table if not exists public.automation_action_attempts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  action_id           uuid not null,
  run_id              uuid not null,
  -- 1, 2, 3 … per action, never reused. Not the action's `attempts` counter: that one
  -- counts charged attempts and Lead Recovery's retryAction resets it.
  attempt_no          integer not null check (attempt_no >= 1),

  worker              text not null check (char_length(worker) between 1 and 100),
  lease_token         uuid not null,
  fence               bigint not null,
  runner_kind         text check (runner_kind is null or runner_kind ~ '^[a-z][a-z0-9_]{1,40}$'),

  -- claimed        the lease is held; nothing has started.
  -- running        the holder started it — for an external effect, the point after
  --                which its outcome may be unknown.
  -- succeeded / failed / skipped / cancelled   settled by the holder.
  -- ambiguous      the effect may or may not have happened. never retried by itself.
  -- lease_expired  the holder vanished before starting, or during something safe to repeat.
  -- released       the gate refused the start; the charge was refunded.
  status              text not null check (status in (
    'claimed', 'running', 'succeeded', 'failed', 'ambiguous', 'lease_expired', 'released', 'cancelled', 'skipped'
  )),

  claimed_at          timestamptz not null default now(),
  lease_expires_at    timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,

  error_code          text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  error_message       text check (error_message is null or char_length(error_message) <= 500),
  external_request_id text check (external_request_id is null or char_length(external_request_id) <= 200),
  runner_execution_id text check (runner_execution_id is null or char_length(runner_execution_id) <= 200),
  ambiguous           boolean not null default false,
  retryable           boolean,
  evidence            jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  evidence_ref        text check (evidence_ref is null or char_length(evidence_ref) <= 300),

  -- how a person settled an ambiguous outcome. set once.
  reconciliation      text check (reconciliation is null or reconciliation in ('effect_happened', 'effect_absent')),
  reconciled_by       uuid,
  reconciled_at       timestamptz,
  reconciliation_note text check (reconciliation_note is null or char_length(reconciliation_note) <= 300),

  unique (action_id, attempt_no),
  unique (id, tenant_id),

  constraint automation_action_attempts_ambiguity check (ambiguous = (status = 'ambiguous')),
  constraint automation_action_attempts_reconciled
    check ((reconciliation is null) = (reconciled_at is null)
       and (reconciliation is null or status = 'ambiguous')),
  constraint automation_action_attempts_no_secrets check (
    not public.scheduler_secret_shaped(evidence::text)
    and not public.scheduler_secret_shaped(error_message)
    and not public.scheduler_secret_shaped(evidence_ref)
    and not public.scheduler_secret_shaped(reconciliation_note)
  ),

  foreign key (action_id, tenant_id)
    references public.scheduled_actions (id, tenant_id) on delete cascade,
  foreign key (run_id, tenant_id)
    references public.automation_runs (id, tenant_id) on delete cascade
);

create index if not exists automation_action_attempts_action_idx
  on public.automation_action_attempts (action_id, attempt_no desc);
create index if not exists automation_action_attempts_run_idx
  on public.automation_action_attempts (tenant_id, run_id, claimed_at);
create index if not exists automation_action_attempts_ambiguous_idx
  on public.automation_action_attempts (tenant_id, completed_at desc)
  where status = 'ambiguous';

-- An attempt moves forward once and is never deleted, even by the service role.
create or replace function public.automation_action_attempts_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_effect text;
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_scheduler:attempt_history: attempts are history and are never deleted' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'claimed' then
      raise exception 'arc_scheduler:attempt_history: an attempt begins claimed' using errcode = 'P0001';
    end if;
    new.claimed_at := now();
    return new;
  end if;

  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.action_id <> old.action_id
     or new.run_id <> old.run_id or new.attempt_no <> old.attempt_no or new.worker <> old.worker
     or new.lease_token <> old.lease_token or new.fence <> old.fence or new.claimed_at <> old.claimed_at then
    raise exception 'arc_scheduler:attempt_history: an attempt''s identity is fixed' using errcode = 'P0001';
  end if;

  if old.status in ('succeeded', 'failed', 'lease_expired', 'released', 'cancelled', 'skipped') then
    raise exception 'arc_scheduler:attempt_history: a % attempt is settled', old.status using errcode = 'P0001';
  end if;

  if old.status = 'ambiguous' then
    -- the only thing that may happen to an ambiguous attempt: a person reconciles it, once.
    if old.reconciliation is not null
       or new.status <> old.status
       or new.reconciliation is null
       or (new.error_code, new.error_message, new.external_request_id, new.runner_execution_id, new.evidence, new.evidence_ref, new.completed_at, new.retryable)
          is distinct from
          (old.error_code, old.error_message, old.external_request_id, old.runner_execution_id, old.evidence, old.evidence_ref, old.completed_at, old.retryable) then
      raise exception 'arc_scheduler:attempt_history: an ambiguous attempt is only ever reconciled, once' using errcode = 'P0001';
    end if;
    new.reconciled_at := now();
    return new;
  end if;

  -- a started external effect whose worker vanished did not "expire" — its outcome is
  -- unknown. the claim records it as ambiguous; this refuses anything that says otherwise.
  if old.status = 'running' and new.status in ('lease_expired', 'released') then
    select t.effect_class into v_effect
      from public.scheduled_actions a join public.automation_action_types t on t.key = a.action_type
     where a.id = old.action_id;
    if v_effect = 'external_effect' then
      raise exception 'arc_scheduler:ambiguous_outcome: a started external effect is ambiguous, not expired' using errcode = 'P0001';
    end if;
  end if;
  if old.status = 'running' and new.status = 'claimed' then
    raise exception 'arc_scheduler:attempt_history: a started attempt does not un-start' using errcode = 'P0001';
  end if;

  if new.status in ('succeeded', 'failed', 'ambiguous', 'lease_expired', 'released', 'cancelled', 'skipped') then
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end;
$fn$;

drop trigger if exists automation_action_attempts_guard on public.automation_action_attempts;
create trigger automation_action_attempts_guard
  before insert or update or delete on public.automation_action_attempts
  for each row execute function public.automation_action_attempts_guard();

-- ---------------------------------------------------------------------------
-- 6. the gate
-- ---------------------------------------------------------------------------

-- One verdict for one action, from current state, never from the action's own
-- memory of it:
--
--   claim  run it.
--   hold   not now; leave it pending and say why (a pause, a connection not ready).
--   skip   nothing left to do: the run finished or the client left.
--   block  cannot be proven safe to run; a person must look (a revoked connection, a
--          pin that disagrees with its run).
--
-- Read at the claim and again when an attempt starts, so a pause committed between
-- the two still stops the start.
create or replace function public.scheduler_action_gate(p_action public.scheduled_actions)
returns table (verdict text, code text, detail text)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_type    public.automation_action_types;
  v_run     public.automation_runs;
  v_tenant  text;
  v_life    public.tenant_modules;
  v_found   boolean;
  v_conn    public.provider_connections;
  v_proceed boolean;
begin
  select * into v_type from public.automation_action_types t where t.key = p_action.action_type;
  if not found or v_type.dispatcher <> 'scheduler' then
    return query select 'block', 'not_scheduler_action', 'this action type is not dispatched by the scheduler';
    return;
  end if;
  v_proceed := v_type.paused_policy = 'proceed';

  select * into v_run from public.automation_runs r
   where r.id = p_action.run_id and r.tenant_id = p_action.tenant_id;
  if not found then
    return query select 'block', 'run_missing', 'the run behind this action does not exist';
    return;
  end if;
  if v_run.config_snapshot_id is null or p_action.config_snapshot_id is distinct from v_run.config_snapshot_id then
    return query select 'block', 'snapshot_mismatch', 'this action is not pinned to its run''s configuration snapshot';
    return;
  end if;
  if v_run.status in ('completed', 'failed', 'cancelled') then
    return query select 'skip', 'run_finished', format('the run is %s', v_run.status);
    return;
  end if;
  if v_run.run_mode is null then
    return query select 'block', 'run_authorization_unproven', 'this run predates lifecycle authorisation';
    return;
  end if;
  if v_run.run_mode = 'shadow' then
    return query select 'block', 'shadow_no_effects', 'a shadow run acts on nothing';
    return;
  end if;
  if v_run.status in ('paused', 'blocked') and not v_proceed then
    return query select 'hold', 'run_' || v_run.status,
      coalesce(v_run.status_reason, format('the run is %s', v_run.status));
    return;
  end if;

  select t.status into v_tenant from public.tenants t where t.id = p_action.tenant_id;
  if v_tenant is null or v_tenant = 'archived' then
    return query select 'skip', 'tenant_archived', 'the client is archived';
    return;
  end if;
  if v_tenant = 'paused' and not v_proceed then
    return query select 'hold', 'tenant_paused', 'the client is paused';
    return;
  end if;

  if not v_proceed then
    select * into v_life from public.tenant_modules tm
     where tm.tenant_id = p_action.tenant_id and tm.module_key = v_run.module_key;
    v_found := found;
    if v_run.run_mode = 'live' and (not v_found or v_life.state <> 'active') then
      if v_found and v_life.state = 'paused' then
        return query select 'hold', 'module_paused', 'the module is paused';
      else
        return query select 'hold', 'module_not_active',
          format('the module is %s, and a live run acts only while it is active', coalesce(v_life.state, 'unselected'));
      end if;
      return;
    end if;
    if v_run.run_mode = 'test' and (not v_found or v_life.state not in ('testing', 'shadow', 'active', 'paused')) then
      return query select 'hold', 'module_not_active',
        format('the module is %s, and a test run acts only in testing, shadow, active or paused', coalesce(v_life.state, 'unselected'));
      return;
    end if;
    if v_found and v_life.health_status in ('failing', 'blocking') then
      return query select 'hold', 'health_blocks_execution', format('module health is %s', v_life.health_status);
      return;
    end if;
  end if;

  if v_type.connection_requirement <> 'none' then
    select * into v_conn from public.provider_connections c
     where c.id = p_action.connection_id and c.tenant_id = p_action.tenant_id;
    if p_action.connection_id is null or not found then
      return query select 'block', 'connection_missing', 'this action needs a connection and names none';
      return;
    end if;
    if v_conn.status in ('revoked', 'disconnected') then
      return query select 'block', 'connection_revoked', format('the %s connection was %s', v_conn.connector_key, v_conn.status);
      return;
    end if;
    if v_type.connection_requirement = 'verified' and v_conn.status not in ('verified', 'degraded') then
      return query select 'hold', 'connection_not_ready', format('the %s connection is %s', v_conn.connector_key, v_conn.status);
      return;
    end if;
    if v_type.connection_requirement = 'testable' and v_conn.status not in ('connected_unverified', 'verified', 'degraded') then
      return query select 'hold', 'connection_not_ready', format('the %s connection is %s', v_conn.connector_key, v_conn.status);
      return;
    end if;
    if v_conn.access_expires_at is not null and v_conn.access_expires_at <= now() and not v_conn.refreshable then
      return query select 'hold', 'connection_expired', format('the %s authorisation has expired and cannot be refreshed', v_conn.connector_key);
      return;
    end if;
  end if;

  return query select 'claim', 'ok', null::text;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. claiming
-- ---------------------------------------------------------------------------

-- Row by row under `for update skip locked`, so two sweeps take disjoint rows and a
-- held row costs a read, not a write (its gate is rewritten only when the verdict
-- changes). Rows held last time sort after fresh ones, so a backlog of paused work
-- cannot starve due work behind it within the scan window.
create or replace function public.scheduler_claim_internal(
  p_tenant        uuid,
  p_limit         integer,
  p_worker        text,
  p_lease_seconds integer
)
returns setof public.scheduled_actions
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 500);
  v_secs    integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 3600);
  v_worker  text    := left(coalesce(nullif(trim(p_worker), ''), 'scheduler'), 100);
  v_claimed integer := 0;
  v_row     public.scheduled_actions;
  v_type    public.automation_action_types;
  v_prior   public.automation_action_attempts;
  v_gate    record;
  v_lease   uuid;
  v_no      integer;
begin
  for v_row in
    select a.*
      from public.scheduled_actions a
      join public.automation_action_types t on t.key = a.action_type and t.dispatcher = 'scheduler'
     where (p_tenant is null or a.tenant_id = p_tenant)
       and a.config_snapshot_id is not null
       and ((a.status = 'pending' and a.run_at <= now())
         or (a.status in ('claimed', 'running') and a.lease_expires_at < now()))
     order by (a.status = 'pending' and a.gate_code is not null and a.gate_code <> 'ok'), a.run_at, a.id
     limit v_limit * 20
     for update of a skip locked
  loop
    exit when v_claimed >= v_limit;
    select * into v_type from public.automation_action_types t where t.key = v_row.action_type;

    -- ── an expired lease: settle what the last holder left before anything else ──
    if v_row.status in ('claimed', 'running') then
      select * into v_prior from public.automation_action_attempts p
       where p.action_id = v_row.id and p.tenant_id = v_row.tenant_id and p.status in ('claimed', 'running')
       order by p.attempt_no desc limit 1
       for update;

      if found and v_prior.status = 'running' and v_type.effect_class = 'external_effect' then
        update public.automation_action_attempts
           set status = 'ambiguous', ambiguous = true, retryable = false,
               error_code = 'lease_expired_mid_effect',
               error_message = 'the worker''s lease expired after it started an external effect, so whether the effect happened is unknown'
         where id = v_prior.id;
        update public.scheduled_actions
           set status = 'blocked', gate_code = 'ambiguous_outcome',
               gate_detail = 'an external effect may already have happened; a person must reconcile it before anything is resent',
               gate_checked_at = now(), last_error = 'ambiguous outcome after an expired lease',
               locked_at = null, locked_by = null, lease_token = null, lease_expires_at = null
         where id = v_row.id;
        continue;
      end if;

      if found then
        update public.automation_action_attempts
           set status = 'lease_expired', error_code = 'lease_expired', retryable = true,
               error_message = 'the worker''s lease expired before it settled this attempt'
         where id = v_prior.id;
      end if;

      if v_row.attempts >= v_row.max_attempts then
        update public.scheduled_actions
           set status = 'dead_letter', gate_code = 'attempts_exhausted', gate_detail = null, gate_checked_at = now(),
               last_error = 'the lease expired on the last permitted attempt', completed_at = now(),
               locked_at = null, locked_by = null, lease_token = null, lease_expires_at = null
         where id = v_row.id;
        continue;
      end if;

      update public.scheduled_actions
         set status = 'pending', locked_at = null, locked_by = null, lease_token = null, lease_expires_at = null
       where id = v_row.id
      returning * into v_row;
    end if;

    if v_row.attempts >= v_row.max_attempts then
      update public.scheduled_actions
         set status = 'dead_letter', gate_code = 'attempts_exhausted', gate_checked_at = now(), completed_at = now()
       where id = v_row.id;
      continue;
    end if;

    -- ── the gate ──
    select * into v_gate from public.scheduler_action_gate(v_row);
    if v_gate.verdict = 'hold' then
      if v_row.gate_code is distinct from v_gate.code or v_row.gate_detail is distinct from v_gate.detail then
        update public.scheduled_actions
           set gate_code = v_gate.code, gate_detail = left(v_gate.detail, 300), gate_checked_at = now()
         where id = v_row.id;
      end if;
      continue;
    elsif v_gate.verdict = 'skip' then
      update public.scheduled_actions
         set status = 'skipped', gate_code = v_gate.code, gate_detail = left(v_gate.detail, 300), gate_checked_at = now(),
             last_error = left(v_gate.detail, 300), completed_at = now()
       where id = v_row.id;
      continue;
    elsif v_gate.verdict = 'block' then
      update public.scheduled_actions
         set status = 'blocked', gate_code = v_gate.code, gate_detail = left(v_gate.detail, 300), gate_checked_at = now(),
             last_error = left(v_gate.detail, 300)
       where id = v_row.id;
      continue;
    end if;

    -- ── claim it ──
    v_lease := gen_random_uuid();
    select coalesce(max(p.attempt_no), 0) + 1 into v_no
      from public.automation_action_attempts p where p.action_id = v_row.id;

    update public.scheduled_actions a
       set status = 'claimed', locked_at = now(), locked_by = v_worker, lease_token = v_lease,
           lease_expires_at = now() + make_interval(secs => v_secs),
           fence = a.fence + 1, attempts = a.attempts + 1,
           gate_code = 'ok', gate_detail = null, gate_checked_at = now()
     where a.id = v_row.id
    returning a.* into v_row;

    insert into public.automation_action_attempts
      (tenant_id, action_id, run_id, attempt_no, worker, lease_token, fence, status, lease_expires_at)
    values
      (v_row.tenant_id, v_row.id, v_row.run_id, v_no, v_worker, v_lease, v_row.fence, 'claimed', v_row.lease_expires_at);

    update public.automation_runs
       set status = 'running', started_at = coalesce(started_at, now())
     where id = v_row.run_id and tenant_id = v_row.tenant_id and status = 'pending';

    v_claimed := v_claimed + 1;
    return next v_row;
  end loop;
  return;
end;
$fn$;

-- As 0011: "every tenant" is a function you name, and a tenant claim with no tenant
-- is an error rather than a silent widening.
create or replace function public.claim_automation_actions_global(
  p_limit         integer default 25,
  p_worker        text default 'scheduler',
  p_lease_seconds integer default 120
)
returns setof public.scheduled_actions
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query select * from public.scheduler_claim_internal(null, p_limit, p_worker, p_lease_seconds);
end;
$fn$;

create or replace function public.claim_tenant_automation_actions(
  p_tenant        uuid,
  p_limit         integer default 10,
  p_worker        text default 'scheduler',
  p_lease_seconds integer default 120
)
returns setof public.scheduled_actions
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_tenant is null then
    raise exception 'arc_scheduler:tenant_required: claim_tenant_automation_actions requires an explicit tenant'
      using errcode = 'P0001';
  end if;
  return query select * from public.scheduler_claim_internal(p_tenant, p_limit, p_worker, p_lease_seconds);
end;
$fn$;

-- ── Lead Recovery's claim: 0013's body, restricted to its own types, now recording attempts ──
-- Three additions, nothing removed: it takes only actions its engine dispatches, it
-- stores the lease expiry, and every claim writes an attempt row (a reclaim closes
-- the previous holder's as lease_expired). Its pause behaviour is untouched.
create or replace function public.claim_actions_internal(
  p_tenant        uuid,
  p_limit         integer,
  p_worker        text,
  p_lease_seconds integer,
  p_canary_only   boolean
)
returns setof public.scheduled_actions
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_lease uuid := gen_random_uuid();
  v_secs  integer := greatest(p_lease_seconds, 30);
begin
  return query
  with due as (
    select a.id
      from public.scheduled_actions a
      join public.automation_runs r
        on r.id = a.run_id and r.tenant_id = a.tenant_id
      -- ── ARC-200: only what this engine dispatches ──
      join public.automation_action_types t
        on t.key = a.action_type and t.dispatcher = 'lead_recovery_engine'
     where (p_tenant is null or a.tenant_id = p_tenant)
       and r.config_snapshot_id is not null
       and a.config_snapshot_id is not null
       and a.config_snapshot_id = r.config_snapshot_id
       and (
         (a.status = 'pending' and a.run_at <= now())
         or (a.status = 'claimed'
             and a.locked_at is not null
             and a.locked_at < now() - make_interval(secs => v_secs))
       )
       and a.attempts < a.max_attempts
       and (
         not p_canary_only
         or exists (
           select 1 from public.leads l
            where l.id = r.lead_id and l.tenant_id = r.tenant_id and l.is_canary
         )
       )
     order by a.run_at
     limit greatest(p_limit, 1)
     -- the action and its run, as 0011 locked them — never the vocabulary row, which
     -- every claim shares and a skip-locked claim would otherwise skip wholesale.
     for update of a, r skip locked
  ),
  claimed as (
    update public.scheduled_actions a
       set status      = 'claimed',
           locked_at   = now(),
           locked_by   = coalesce(nullif(trim(p_worker), ''), 'dispatcher'),
           lease_token = v_lease,
           lease_expires_at = now() + make_interval(secs => v_secs),
           fence       = a.fence + 1,
           attempts    = a.attempts + 1
      from due
     where a.id = due.id
    returning a.*
  ),
  -- ── ARC-200: the previous holder's attempt, if this is a reclaim ──
  expired as (
    update public.automation_action_attempts p
       set status = 'lease_expired', error_code = 'lease_expired', retryable = true,
           error_message = 'the worker''s lease expired before it settled this attempt'
      from claimed c
     where p.action_id = c.id and p.tenant_id = c.tenant_id and p.status = 'claimed'
    returning p.id
  ),
  -- ── ARC-200: and this claim's ──
  recorded as (
    insert into public.automation_action_attempts
      (tenant_id, action_id, run_id, attempt_no, worker, lease_token, fence, status, lease_expires_at)
    select c.tenant_id, c.id, c.run_id,
           coalesce((select max(p.attempt_no) from public.automation_action_attempts p where p.action_id = c.id), 0) + 1,
           left(c.locked_by, 100), c.lease_token, c.fence, 'claimed', c.lease_expires_at
      from claimed c
    returning id
  )
  -- data-modifying CTEs always run to completion, read or not.
  select c.* from claimed c;
end;
$fn$;

-- ── Lead Recovery's two fenced writes: 0011's bodies, now settling the attempt too ──
create or replace function public.complete_scheduled_action(
  p_action  uuid,
  p_tenant  uuid,
  p_lease   uuid,
  p_status  text,
  p_error   text,
  p_now     timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows integer;
begin
  if p_status not in ('done', 'failed', 'cancelled') then
    raise exception 'complete_scheduled_action: % is not a terminal status', p_status
      using errcode = 'P0001';
  end if;

  update public.scheduled_actions
     set status       = p_status,
         last_error   = p_error,
         completed_at = p_now,
         locked_at    = null,
         locked_by    = null,
         lease_token  = null,
         lease_expires_at = null
   where id = p_action
     and tenant_id = p_tenant
     and lease_token = p_lease
     and status = 'claimed';

  get diagnostics v_rows = row_count;

  -- ── ARC-200 ──
  if v_rows = 1 then
    update public.automation_action_attempts
       set status = case p_status when 'done' then 'succeeded' when 'failed' then 'failed' else 'cancelled' end,
           error_message = public.scheduler_safe_text(p_error),
           retryable = case when p_status = 'failed' then false else null end,
           completed_at = p_now
     where action_id = p_action and tenant_id = p_tenant and lease_token = p_lease and status = 'claimed';
  end if;

  return v_rows = 1;
end;
$fn$;

create or replace function public.reschedule_scheduled_action(
  p_action uuid,
  p_tenant uuid,
  p_lease  uuid,
  p_run_at timestamptz,
  p_error  text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows integer;
begin
  update public.scheduled_actions
     set status      = 'pending',
         run_at      = p_run_at,
         last_error  = p_error,
         locked_at   = null,
         locked_by   = null,
         lease_token = null,
         lease_expires_at = null
   where id = p_action
     and tenant_id = p_tenant
     and lease_token = p_lease
     and status = 'claimed';

  get diagnostics v_rows = row_count;

  -- ── ARC-200 ──
  if v_rows = 1 then
    update public.automation_action_attempts
       set status = 'failed', retryable = true, error_code = 'retry_scheduled',
           error_message = public.scheduler_safe_text(p_error)
     where action_id = p_action and tenant_id = p_tenant and lease_token = p_lease and status = 'claimed';
  end if;

  return v_rows = 1;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. scheduling
-- ---------------------------------------------------------------------------

-- Idempotent on (tenant, idempotency key): the same key returns the action it already
-- names, with `created = false`. The same key for a DIFFERENT action — another run,
-- type or payload — is refused, because "one key, one logical action" is what makes a
-- retried webhook queue one message.
create or replace function public.schedule_automation_action(
  p_tenant          uuid,
  p_run             uuid,
  p_action_type     text,
  p_run_at          timestamptz,
  p_idempotency_key text,
  p_payload         jsonb default '{}'::jsonb,
  p_max_attempts    integer default null,
  p_connection      uuid default null
)
returns table (action_id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_type     public.automation_action_types;
  v_existing public.scheduled_actions;
  v_id       uuid;
begin
  select * into v_type from public.automation_action_types t where t.key = p_action_type;
  if not found then
    raise exception 'arc_scheduler:unknown_action_type: % is not in the vocabulary', p_action_type using errcode = 'P0001';
  end if;
  if v_type.dispatcher <> 'scheduler' then
    raise exception 'arc_scheduler:not_scheduler_action: % is dispatched by the Lead Recovery engine', p_action_type
      using errcode = 'P0001';
  end if;
  if p_run_at is null then
    raise exception 'arc_scheduler:invalid_action: an action is due at a time' using errcode = 'P0001';
  end if;
  if p_max_attempts is not null and (p_max_attempts < 1 or p_max_attempts > 20) then
    raise exception 'arc_scheduler:invalid_action: max attempts is between 1 and 20' using errcode = 'P0001';
  end if;

  -- a replay is answered from what exists before anything is inserted, so a replay
  -- after the run finished returns the action it queued rather than a refusal.
  select * into v_existing from public.scheduled_actions a
   where a.tenant_id = p_tenant and a.idempotency_key = p_idempotency_key;

  if not found then
    insert into public.scheduled_actions
      (tenant_id, run_id, action_type, run_at, idempotency_key, payload, max_attempts, connection_id, status)
    values
      (p_tenant, p_run, p_action_type, p_run_at, p_idempotency_key, coalesce(p_payload, '{}'::jsonb),
       coalesce(p_max_attempts, v_type.default_max_attempts), p_connection, 'pending')
    on conflict (tenant_id, idempotency_key) do nothing
    returning id into v_id;

    if v_id is not null then
      return query select v_id, true;
      return;
    end if;

    -- lost a race to another caller with the same key: judge theirs.
    select * into v_existing from public.scheduled_actions a
     where a.tenant_id = p_tenant and a.idempotency_key = p_idempotency_key;
  end if;

  if v_existing.run_id is distinct from p_run
     or v_existing.action_type is distinct from p_action_type
     or v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb)
     or v_existing.connection_id is distinct from p_connection then
    raise exception 'arc_scheduler:idempotency_conflict: that idempotency key already names a different action'
      using errcode = 'P0001';
  end if;
  return query select v_existing.id, false;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. the holder's writes: start, settle
-- ---------------------------------------------------------------------------

-- Starting is the durable line between "claimed" and "may have happened". For an
-- external effect it must be crossed before the effect is attempted, and the gate is
-- re-read under the action's lock first: nothing starts on yesterday's answer.
create or replace function public.start_automation_attempt(
  p_action      uuid,
  p_tenant      uuid,
  p_lease       uuid,
  p_runner_kind text default null
)
returns table (started boolean, code text, detail text, attempt_id uuid, attempt_number integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row     public.scheduled_actions;
  v_type    public.automation_action_types;
  v_attempt public.automation_action_attempts;
  v_gate    record;
begin
  if p_runner_kind is not null and p_runner_kind !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'arc_scheduler:invalid_runner: runner kinds are lower-case identifiers' using errcode = 'P0001';
  end if;

  select * into v_row from public.scheduled_actions a
   where a.id = p_action and a.tenant_id = p_tenant
     for update;
  if not found then
    return query select false, 'not_found', 'no such action for this tenant', null::uuid, null::integer;
    return;
  end if;
  select * into v_type from public.automation_action_types t where t.key = v_row.action_type;
  if v_type.dispatcher <> 'scheduler' then
    return query select false, 'not_scheduler_action', 'this action is dispatched by the Lead Recovery engine', null::uuid, null::integer;
    return;
  end if;
  if v_row.lease_token is distinct from p_lease or v_row.status <> 'claimed' then
    return query select false, 'lost_lease',
      format('the action is %s under another lease', v_row.status), null::uuid, null::integer;
    return;
  end if;
  if v_row.lease_expires_at <= now() then
    return query select false, 'lease_expired', 'this lease has expired; nothing may start under it', null::uuid, null::integer;
    return;
  end if;

  select * into v_attempt from public.automation_action_attempts p
   where p.action_id = v_row.id and p.tenant_id = p_tenant and p.lease_token = p_lease and p.status = 'claimed'
     for update;
  if not found then
    return query select false, 'attempt_missing', 'this claim recorded no attempt', null::uuid, null::integer;
    return;
  end if;

  select * into v_gate from public.scheduler_action_gate(v_row);
  if v_gate.verdict <> 'claim' then
    -- released: the charge is refunded, because nothing was attempted.
    update public.automation_action_attempts
       set status = 'released', error_code = v_gate.code, error_message = public.scheduler_safe_text(v_gate.detail)
     where id = v_attempt.id;
    update public.scheduled_actions a
       set status = case v_gate.verdict when 'hold' then 'pending' when 'skip' then 'skipped' else 'blocked' end,
           attempts = greatest(a.attempts - 1, 0),
           gate_code = v_gate.code, gate_detail = left(v_gate.detail, 300), gate_checked_at = now(),
           last_error = case when v_gate.verdict = 'hold' then a.last_error else left(v_gate.detail, 300) end,
           completed_at = case when v_gate.verdict = 'skip' then now() else a.completed_at end,
           locked_at = null, locked_by = null, lease_token = null, lease_expires_at = null
     where a.id = v_row.id;
    return query select false, v_gate.code, v_gate.detail, v_attempt.id, v_attempt.attempt_no;
    return;
  end if;

  update public.automation_action_attempts
     set status = 'running', started_at = now(), runner_kind = p_runner_kind
   where id = v_attempt.id;
  update public.scheduled_actions set status = 'running' where id = v_row.id;
  if p_runner_kind is not null then
    update public.automation_runs r set runner_kind = p_runner_kind
     where r.id = v_row.run_id and r.tenant_id = p_tenant and r.runner_kind is null;
  end if;

  return query select true, 'ok', null::text, v_attempt.id, v_attempt.attempt_no;
end;
$fn$;

-- One settlement per attempt, fenced on the lease that claimed it.
--
--   succeeded  the action is done.
--   skipped    the handler found nothing to do.
--   ambiguous  the effect may or may not have happened: the action is blocked for a
--              person, and nothing retries it.
--   failed     retryable and under the cap: back on the queue after the type's
--              backoff (a caller may ask for later, never for sooner). retryable at
--              the cap: dead_letter. not retryable: failed.
--
-- An external effect settles only from `running`: an outcome for an effect nobody
-- recorded starting cannot be told apart from one that started twice.
create or replace function public.settle_automation_attempt(
  p_action              uuid,
  p_tenant              uuid,
  p_lease               uuid,
  p_outcome             text,
  p_error_code          text default null,
  p_error_message       text default null,
  p_retryable           boolean default null,
  p_external_request_id text default null,
  p_runner_execution_id text default null,
  p_evidence            jsonb default '{}'::jsonb,
  p_evidence_ref        text default null,
  p_retry_at            timestamptz default null
)
returns table (settled boolean, code text, action_status text, next_run_at timestamptz)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row     public.scheduled_actions;
  v_type    public.automation_action_types;
  v_attempt public.automation_action_attempts;
  v_status  text;
  v_next    timestamptz;
  v_backoff integer;
  v_message text := public.scheduler_safe_text(p_error_message);
begin
  if p_outcome not in ('succeeded', 'failed', 'ambiguous', 'skipped') then
    raise exception 'arc_scheduler:invalid_outcome: % is not an outcome', p_outcome using errcode = 'P0001';
  end if;

  select * into v_row from public.scheduled_actions a
   where a.id = p_action and a.tenant_id = p_tenant
     for update;
  if not found then
    return query select false, 'not_found', null::text, null::timestamptz;
    return;
  end if;
  select * into v_type from public.automation_action_types t where t.key = v_row.action_type;
  if v_type.dispatcher <> 'scheduler' then
    return query select false, 'not_scheduler_action', v_row.status, null::timestamptz;
    return;
  end if;
  if v_row.lease_token is distinct from p_lease or v_row.status not in ('claimed', 'running') then
    return query select false,
      case when v_row.status in ('claimed', 'running') then 'lost_lease' else 'already_completed' end,
      v_row.status, null::timestamptz;
    return;
  end if;
  if v_type.effect_class = 'external_effect' and p_outcome <> 'skipped' and v_row.status <> 'running' then
    return query select false, 'not_started', v_row.status, null::timestamptz;
    return;
  end if;

  select * into v_attempt from public.automation_action_attempts p
   where p.action_id = v_row.id and p.tenant_id = p_tenant and p.lease_token = p_lease
     and p.status in ('claimed', 'running')
     for update;

  if p_outcome = 'succeeded' then
    v_status := 'done';
  elsif p_outcome = 'skipped' then
    v_status := 'skipped';
  elsif p_outcome = 'ambiguous' then
    v_status := 'blocked';
  elsif p_retryable is not true then
    v_status := 'failed';
  elsif v_row.attempts >= v_row.max_attempts then
    v_status := 'dead_letter';
  else
    v_status := 'pending';
    -- in floating point, capped, then converted: an integer product overflows first.
    v_backoff := least(v_type.retry_ceiling_seconds::double precision,
                       v_type.retry_base_seconds * power(2::double precision, least(greatest(v_row.attempts - 1, 0), 30)))::integer;
    v_next := greatest(now() + make_interval(secs => v_backoff), coalesce(p_retry_at, now()));
  end if;

  update public.automation_action_attempts
     set status = p_outcome,
         ambiguous = (p_outcome = 'ambiguous'),
         retryable = case when p_outcome = 'ambiguous' then false
                          when p_outcome = 'failed' then coalesce(p_retryable, false)
                          else null end,
         error_code = coalesce(p_error_code, case p_outcome when 'ambiguous' then 'ambiguous_outcome' else null end),
         error_message = v_message,
         external_request_id = p_external_request_id,
         runner_execution_id = p_runner_execution_id,
         evidence = coalesce(p_evidence, '{}'::jsonb),
         evidence_ref = p_evidence_ref
   where id = v_attempt.id;

  update public.scheduled_actions a
     set status = v_status,
         run_at = coalesce(v_next, a.run_at),
         last_error = case when v_status = 'done' then null else coalesce(v_message, a.last_error) end,
         completed_at = case when v_status in ('done', 'skipped', 'failed', 'dead_letter') then now() else null end,
         gate_code = case v_status
           when 'blocked' then 'ambiguous_outcome'
           when 'dead_letter' then 'attempts_exhausted'
           else a.gate_code end,
         gate_detail = case v_status
           when 'blocked' then 'an external effect may already have happened; a person must reconcile it before anything is resent'
           else a.gate_detail end,
         gate_checked_at = case when v_status in ('blocked', 'dead_letter') then now() else a.gate_checked_at end,
         locked_at = null, locked_by = null, lease_token = null, lease_expires_at = null
   where a.id = v_row.id;

  return query select true, 'ok', v_status, v_next;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. reconciling an ambiguous outcome — a person's decision
-- ---------------------------------------------------------------------------

create or replace function public.scheduler_require_operator(p_actor uuid)
returns void
language plpgsql
stable
set search_path = public
as $fn$
begin
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_scheduler:forbidden: this is an operator decision' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_scheduler:forbidden: the actor must be the signed-in caller' using errcode = 'P0001';
  end if;
end;
$fn$;

-- effect_happened: the action is done — nothing is resent.
-- effect_absent:   it goes back on the queue for a new attempt, or to dead_letter if
--                  it has none left. Never back to a worker without a person saying so.
create or replace function public.resolve_ambiguous_automation_action(
  p_tenant     uuid,
  p_action     uuid,
  p_resolution text,
  p_actor      uuid,
  p_note       text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row    public.scheduled_actions;
  v_status text;
begin
  perform public.scheduler_require_operator(p_actor);
  if p_resolution not in ('effect_happened', 'effect_absent') then
    raise exception 'arc_scheduler:invalid_resolution: % is not a resolution', p_resolution using errcode = 'P0001';
  end if;

  select * into v_row from public.scheduled_actions a
   where a.id = p_action and a.tenant_id = p_tenant
     for update;
  if not found or v_row.status <> 'blocked' or v_row.gate_code is distinct from 'ambiguous_outcome' then
    raise exception 'arc_scheduler:not_ambiguous: only an action blocked on an ambiguous outcome is reconciled here'
      using errcode = 'P0001';
  end if;

  update public.automation_action_attempts p
     set reconciliation = p_resolution, reconciled_by = p_actor,
         reconciliation_note = public.scheduler_safe_text(p_note, 300)
   where p.id = (
     select q.id from public.automation_action_attempts q
      where q.action_id = p_action and q.tenant_id = p_tenant and q.status = 'ambiguous' and q.reconciliation is null
      order by q.attempt_no desc limit 1
   );

  if p_resolution = 'effect_happened' then
    v_status := 'done';
  elsif v_row.attempts >= v_row.max_attempts then
    v_status := 'dead_letter';
  else
    v_status := 'pending';
  end if;

  update public.scheduled_actions a
     set status = v_status,
         run_at = case when v_status = 'pending' then now() else a.run_at end,
         gate_code = 'reconciled_' || p_resolution,
         gate_detail = null, gate_checked_at = now(),
         completed_at = case when v_status = 'pending' then null else now() end
   where a.id = p_action;

  return v_status;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 11. run control
-- ---------------------------------------------------------------------------

-- Pause, block and resume a run the scheduler owns. A lead conversation is refused:
-- its status is its state machine's, moved by takeover, suppression and close.
-- Resuming is an operator's — the system pauses and blocks, and never un-pauses.
create or replace function public.set_automation_run_status(
  p_tenant     uuid,
  p_run        uuid,
  p_status     text,
  p_code       text,
  p_reason     text,
  p_actor_type text,
  p_actor      uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_run public.automation_runs;
begin
  if p_status not in ('paused', 'blocked', 'running') then
    raise exception 'arc_scheduler:invalid_status: a run is paused, blocked or resumed here' using errcode = 'P0001';
  end if;
  if p_actor_type not in ('operator', 'system') then
    raise exception 'arc_scheduler:invalid_actor: operator or system' using errcode = 'P0001';
  end if;
  if p_actor_type = 'operator' then
    perform public.scheduler_require_operator(p_actor);
  elsif p_status = 'running' then
    raise exception 'arc_scheduler:forbidden: the system never resumes a run — an operator does' using errcode = 'P0001';
  end if;

  select * into v_run from public.automation_runs r where r.id = p_run and r.tenant_id = p_tenant for update;
  if not found then
    raise exception 'arc_scheduler:not_found: no such run for this tenant' using errcode = 'P0001';
  end if;
  if v_run.run_kind = 'lead_conversation' then
    raise exception 'arc_scheduler:lead_conversation: a lead conversation is controlled by takeover, suppression and close, not here'
      using errcode = 'P0001';
  end if;
  if v_run.status in ('completed', 'failed', 'cancelled') then
    raise exception 'arc_scheduler:run_finished: the run is %', v_run.status using errcode = 'P0001';
  end if;
  if p_status = 'running' and v_run.status not in ('paused', 'blocked') then
    raise exception 'arc_scheduler:invalid_status: only a paused or blocked run is resumed' using errcode = 'P0001';
  end if;

  update public.automation_runs r
     set status = p_status,
         terminal_code = case when p_status = 'running' then null else p_code end,
         status_reason = case when p_status = 'running' then null else public.scheduler_safe_text(p_reason, 300) end
   where r.id = p_run;
  return p_status;
end;
$fn$;

-- Cancel what is still waiting. Never what a worker holds — its lease settles it, and
-- the gate then skips anything further — and never an ambiguous outcome, which only
-- a person can close.
create or replace function public.cancel_automation_run_actions(
  p_tenant uuid,
  p_run    uuid,
  p_reason text,
  p_types  text[] default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows integer;
begin
  update public.scheduled_actions a
     set status = 'cancelled', last_error = public.scheduler_safe_text(p_reason, 300), completed_at = now(),
         gate_code = 'cancelled', gate_checked_at = now()
   where a.tenant_id = p_tenant
     and a.run_id = p_run
     and (a.status = 'pending'
          or (a.status = 'blocked' and a.gate_code is distinct from 'ambiguous_outcome'))
     and (p_types is null or a.action_type = any(p_types));
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$fn$;

-- Finishing a run. Completed or failed only once nothing is outstanding; cancelled
-- at any time, cancelling what waits and leaving what is in flight or ambiguous.
create or replace function public.finish_automation_run(
  p_tenant uuid,
  p_run    uuid,
  p_status text,
  p_code   text,
  p_reason text default null
)
returns table (run_status text, cancelled_actions integer, in_flight_actions integer, ambiguous_actions integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_run       public.automation_runs;
  v_open      integer;
  v_cancelled integer := 0;
  v_flight    integer;
  v_ambiguous integer;
begin
  if p_status not in ('completed', 'failed', 'cancelled') then
    raise exception 'arc_scheduler:invalid_status: a run finishes completed, failed or cancelled' using errcode = 'P0001';
  end if;
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'arc_scheduler:invalid_code: a finished run names why, as a code' using errcode = 'P0001';
  end if;

  select * into v_run from public.automation_runs r where r.id = p_run and r.tenant_id = p_tenant for update;
  if not found then
    raise exception 'arc_scheduler:not_found: no such run for this tenant' using errcode = 'P0001';
  end if;
  if v_run.run_kind = 'lead_conversation' then
    raise exception 'arc_scheduler:lead_conversation: a lead conversation finishes through its own state machine'
      using errcode = 'P0001';
  end if;
  if v_run.status in ('completed', 'failed', 'cancelled') then
    raise exception 'arc_scheduler:run_finished: the run is already %', v_run.status using errcode = 'P0001';
  end if;

  select count(*) filter (where a.status in ('pending', 'claimed', 'running')
                             or (a.status = 'blocked' and a.gate_code = 'ambiguous_outcome')),
         count(*) filter (where a.status in ('claimed', 'running')),
         count(*) filter (where a.status = 'blocked' and a.gate_code = 'ambiguous_outcome')
    into v_open, v_flight, v_ambiguous
    from public.scheduled_actions a where a.tenant_id = p_tenant and a.run_id = p_run;

  if p_status <> 'cancelled' and v_open > 0 then
    raise exception 'arc_scheduler:actions_outstanding: % action(s) are still waiting, in flight or ambiguous', v_open
      using errcode = 'P0001';
  end if;
  if p_status = 'cancelled' then
    v_cancelled := public.cancel_automation_run_actions(p_tenant, p_run, coalesce(p_reason, 'the run was cancelled'));
  end if;

  update public.automation_runs r
     set status = p_status, terminal_code = p_code,
         status_reason = public.scheduler_safe_text(p_reason, 300),
         completed_at = now(),
         stopped_at = case when p_status = 'completed' then r.stopped_at else now() end
   where r.id = p_run;

  return query select p_status, v_cancelled, v_flight, v_ambiguous;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 12. a pause cancels the Lead Recovery engine's work, and holds the scheduler's
-- ---------------------------------------------------------------------------

-- 0015's transition function, unchanged except for one clause in the cancellation
-- (marked). A pause cancelled every pending action of a non-test run of the module
-- but a handoff or a close — correct for the seven Lead Recovery types it was written
-- for, whose engine cancels contact on a pause. Applied to the scheduler's actions it
-- would turn "pause holds, resume releases" into "pause destroys", so on a pause it now
-- cancels only what the Lead Recovery engine dispatches; the scheduler's actions stay
-- pending and the gate holds them. A deselection still cancels both: a module that is
-- no longer selected has nothing to resume to.
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
         -- ── ARC-200: a pause holds the scheduler's work; a deselection still ends it ──
         and (p_transition = 'deselect' or exists (
           select 1 from public.automation_action_types t
            where t.key = a.action_type and t.dispatcher = 'lead_recovery_engine'
         ))
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
-- 13. RLS
-- ---------------------------------------------------------------------------

-- Operators read everything. A tenant member reads their own runs (0010's policy,
-- unchanged) and nothing of the queue, its attempts or its vocabulary: those are
-- internal machinery, and the client's view of what happened is the run log built
-- from events. No write policy for any role, on any table.

alter table public.automation_action_types    enable row level security;
alter table public.automation_action_attempts enable row level security;

drop policy if exists automation_action_types_admin_read on public.automation_action_types;
create policy automation_action_types_admin_read on public.automation_action_types
  for select to authenticated using (public.is_arc_admin());

drop policy if exists automation_action_attempts_admin_read on public.automation_action_attempts;
create policy automation_action_attempts_admin_read on public.automation_action_attempts
  for select to authenticated using (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- 14. privileges
-- ---------------------------------------------------------------------------

-- `create or replace` keeps a function's grants; restated so this file is correct on
-- its own, as 0013 did.
revoke all on function public.apply_tenant_module_transition(uuid, text, text, bigint, text, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.apply_tenant_module_transition(uuid, text, text, bigint, text, uuid, text, text, text, jsonb, text)
  to service_role;

revoke all on function public.scheduler_secret_shaped(text) from public, anon, authenticated;
revoke all on function public.scheduler_safe_text(text, integer) from public, anon, authenticated;
revoke all on function public.automation_action_types_are_immutable() from public, anon, authenticated;
revoke all on function public.lead_conversation_status(text) from public, anon, authenticated;
revoke all on function public.automation_runs_guard_snapshot() from public, anon, authenticated;
revoke all on function public.automation_runs_lifecycle_guard() from public, anon, authenticated;
revoke all on function public.automation_runs_scheduler_guard() from public, anon, authenticated;
revoke all on function public.scheduled_actions_scheduler_guard() from public, anon, authenticated;
revoke all on function public.automation_action_attempts_guard() from public, anon, authenticated;
revoke all on function public.scheduler_action_gate(public.scheduled_actions) from public, anon, authenticated;
revoke all on function public.scheduler_claim_internal(uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.claim_automation_actions_global(integer, text, integer) from public, anon, authenticated;
revoke all on function public.claim_tenant_automation_actions(uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.claim_actions_internal(uuid, integer, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.complete_scheduled_action(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.reschedule_scheduled_action(uuid, uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.schedule_automation_action(uuid, uuid, text, timestamptz, text, jsonb, integer, uuid) from public, anon, authenticated;
revoke all on function public.start_automation_attempt(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.settle_automation_attempt(uuid, uuid, uuid, text, text, text, boolean, text, text, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.scheduler_require_operator(uuid) from public, anon, authenticated;
revoke all on function public.resolve_ambiguous_automation_action(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.set_automation_run_status(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.cancel_automation_run_actions(uuid, uuid, text, text[]) from public, anon, authenticated;
revoke all on function public.finish_automation_run(uuid, uuid, text, text, text) from public, anon, authenticated;

-- the worker surface: the service role, which means an edge function, and nothing else.
grant execute on function public.claim_automation_actions_global(integer, text, integer) to service_role;
grant execute on function public.claim_tenant_automation_actions(uuid, integer, text, integer) to service_role;
grant execute on function public.schedule_automation_action(uuid, uuid, text, timestamptz, text, jsonb, integer, uuid) to service_role;
grant execute on function public.start_automation_attempt(uuid, uuid, uuid, text) to service_role;
grant execute on function public.settle_automation_attempt(uuid, uuid, uuid, text, text, text, boolean, text, text, jsonb, text, timestamptz) to service_role;
grant execute on function public.resolve_ambiguous_automation_action(uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.set_automation_run_status(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.cancel_automation_run_actions(uuid, uuid, text, text[]) to service_role;
grant execute on function public.finish_automation_run(uuid, uuid, text, text, text) to service_role;
grant execute on function public.scheduler_action_gate(public.scheduled_actions) to service_role;
grant execute on function public.scheduler_secret_shaped(text) to service_role;
grant execute on function public.scheduler_safe_text(text, integer) to service_role;
