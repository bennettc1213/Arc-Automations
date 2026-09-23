-- ===========================================================================
-- 0013 — Lead Recovery snapshot pinning, enforced where the data lives
-- ===========================================================================
--
-- ARC-015B. 0011 gave every run a configuration snapshot and made the claim
-- functions refuse any run without one. The engine built the snapshot and handed
-- its id to `createRun` — and the production store's insert left
-- `config_snapshot_id` out. Every production run was therefore unpinned, every
-- claim refused its work, and Lead Recovery ran nothing: no first response, no
-- follow-up, no handoff alert, and a canary that could never reach
-- `awaiting_reply`, so `canary_passed` could never be ticked and no client could
-- be activated. The in-memory test store kept the whole object, so the suite never
-- saw it. `scheduled_actions.config_snapshot_id` had the same shape of problem: a
-- column 0011 added and nothing wrote.
--
-- The adapter is fixed in TypeScript. This migration makes the rule the
-- database's, so the next adapter that drops a column fails loudly at the insert
-- rather than silently at the claim:
--
--   1. a new run must carry a snapshot of its own tenant, for its own module, at a
--      configuration schema the module registry (0012) says that module runs;
--   2. a new action carries exactly its run's snapshot — derived from the run when
--      the caller leaves it out, refused when the caller disagrees;
--   3. once set, neither pin can change, nor can the tenant or parent it hangs on;
--   4. a claim offers an action only when it and its run carry the same non-null
--      snapshot.
--
-- Legacy rows are not guessed at. A run with no snapshot keeps none: nothing here
-- reads `module_configs` or reconstructs what an old run was authorised under. The
-- only pin this migration writes is an action's copy of its own run's pin, which is
-- derivation from an immutable fact, not invention (§1).
--
-- Additive and forward-only: no table, column or row is dropped, and 0011/0012 are
-- untouched. `claim_actions_internal` is redefined with the same signature.

-- ---------------------------------------------------------------------------
-- 0. re-runnable: the guards below are recreated at the end of the file
-- ---------------------------------------------------------------------------

drop trigger if exists automation_runs_guard_snapshot on public.automation_runs;
drop trigger if exists scheduled_actions_guard_snapshot on public.scheduled_actions;

-- ---------------------------------------------------------------------------
-- 1. actions of a pinned run inherit that run's pin
-- ---------------------------------------------------------------------------

-- Copies the run's own snapshot id onto its actions and nothing else. Against a
-- database that ran the defective adapter this matches no rows (no run was ever
-- pinned); it exists so that the equality rule in §3 can never strand an action
-- whose run *is* pinned.
update public.scheduled_actions a
   set config_snapshot_id = r.config_snapshot_id
  from public.automation_runs r
 where r.id = a.run_id
   and r.tenant_id = a.tenant_id
   and r.config_snapshot_id is not null
   and a.config_snapshot_id is null;

-- ---------------------------------------------------------------------------
-- 2. unpinned work stays blocked — the 0011 policy, applied again
-- ---------------------------------------------------------------------------

-- 0011 blocked every action queued before snapshots existed. Anything queued
-- since, by the adapter that dropped the pin, sits `pending` against an unpinned
-- run: unclaimable, but looking alive. Block it with the reason, exactly as 0011
-- did. Not cancelled — an operator can still see it and decide — and not pinned,
-- because which configuration it was authorised under cannot be proven.
update public.scheduled_actions a
   set status = 'blocked',
       last_error = coalesce(
         nullif(a.last_error, ''),
         'blocked by 0013: queued against a run that was never pinned to a configuration snapshot, so what it was authorised under cannot be proven'
       )
 where a.status in ('pending', 'claimed')
   and a.config_snapshot_id is null;

-- ---------------------------------------------------------------------------
-- 3. structural equality between an action's pin and its run's
-- ---------------------------------------------------------------------------

-- A composite foreign key rather than only a trigger, so the equality holds even
-- if a trigger is ever dropped: an action can only name the (run, tenant,
-- snapshot) triple its run actually has. MATCH SIMPLE leaves a null pin
-- unchecked, which is what keeps legacy rows valid; §5 stops a new row from
-- having one.
alter table public.scheduled_actions
  drop constraint if exists scheduled_actions_run_pin_fk;
alter table public.automation_runs
  drop constraint if exists automation_runs_pin_key;

alter table public.automation_runs
  add constraint automation_runs_pin_key unique (id, tenant_id, config_snapshot_id);

alter table public.scheduled_actions
  add constraint scheduled_actions_run_pin_fk
  foreign key (run_id, tenant_id, config_snapshot_id)
  references public.automation_runs (id, tenant_id, config_snapshot_id)
  on delete cascade;

-- ---------------------------------------------------------------------------
-- 4. runs: born pinned, and the pin never moves
-- ---------------------------------------------------------------------------

-- Invoker rights: the only writer is the service role, which can read every table
-- this consults. The fixed search_path is so a caller cannot shadow `public`.
create or replace function public.automation_runs_guard_snapshot()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_module text;
  v_schema integer;
begin
  if tg_op = 'INSERT' then
    if new.config_snapshot_id is null then
      raise exception 'automation_runs: a new run must be pinned to a configuration snapshot'
        using errcode = 'P0001';
    end if;

    -- the composite foreign key from 0011 already refuses another tenant's
    -- snapshot; reading it here as well lets the refusal say so in words.
    select s.module_key, s.schema_version
      into v_module, v_schema
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

    -- the module registry is the vocabulary: a snapshot is only good for a module
    -- version a tenant may currently be given, at the schema that version names.
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

    return new;
  end if;

  -- UPDATE. state, timestamps and errors move freely — that is the state machine.
  -- what the run *is* does not: which tenant, which lead, which module, and which
  -- configuration it began under. a legacy unpinned run stays unpinned, because
  -- giving it a pin now would be claiming to know what it was authorised under.
  if new.config_snapshot_id is distinct from old.config_snapshot_id then
    raise exception 'automation_runs: a run''s configuration snapshot is fixed when it is created'
      using errcode = 'P0001';
  end if;
  if new.tenant_id <> old.tenant_id
     or new.lead_id <> old.lead_id
     or new.module_key <> old.module_key then
    raise exception 'automation_runs: tenant, lead and module are fixed when a run is created'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

create trigger automation_runs_guard_snapshot
  before insert or update on public.automation_runs
  for each row execute function public.automation_runs_guard_snapshot();

-- ---------------------------------------------------------------------------
-- 5. actions: the run's pin, derived here, and fixed
-- ---------------------------------------------------------------------------

create or replace function public.scheduled_actions_guard_snapshot()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_run_snapshot uuid;
begin
  if tg_op = 'INSERT' then
    select r.config_snapshot_id
      into v_run_snapshot
      from public.automation_runs r
     where r.id = new.run_id
       and r.tenant_id = new.tenant_id;
    if not found then
      raise exception 'scheduled_actions: run % does not belong to tenant %', new.run_id, new.tenant_id
        using errcode = 'P0001';
    end if;
    if v_run_snapshot is null then
      raise exception 'scheduled_actions: run % has no configuration snapshot — nothing may be queued against it',
        new.run_id
        using errcode = 'P0001';
    end if;

    -- derived, not trusted: an omitted pin is filled from the run, and a supplied
    -- one must already agree with it.
    if new.config_snapshot_id is null then
      new.config_snapshot_id := v_run_snapshot;
    elsif new.config_snapshot_id <> v_run_snapshot then
      raise exception 'scheduled_actions: snapshot % is not the snapshot of run % (%)',
        new.config_snapshot_id, new.run_id, v_run_snapshot
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE. status, lease, attempts and timing are the worker's to move. the pin,
  -- the tenant and the run it belongs to are not.
  if new.config_snapshot_id is distinct from old.config_snapshot_id then
    raise exception 'scheduled_actions: an action''s configuration snapshot is fixed when it is queued'
      using errcode = 'P0001';
  end if;
  if new.tenant_id <> old.tenant_id or new.run_id <> old.run_id then
    raise exception 'scheduled_actions: tenant and run are fixed when an action is queued'
      using errcode = 'P0001';
  end if;

  -- a legacy unpinned action may be cancelled, failed, blocked or left alone. it may
  -- not be put back on the queue: it could never be claimed, so `pending` would be a
  -- row that looks alive and never runs.
  if new.config_snapshot_id is null
     and new.status in ('pending', 'claimed')
     and new.status is distinct from old.status then
    raise exception 'scheduled_actions: an action with no configuration snapshot cannot be put back on the queue'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

create trigger scheduled_actions_guard_snapshot
  before insert or update on public.scheduled_actions
  for each row execute function public.scheduled_actions_guard_snapshot();

-- ---------------------------------------------------------------------------
-- 6. claiming: both pins present and equal
-- ---------------------------------------------------------------------------

-- 0011's body, unchanged except for the two pin conditions. The composite key in
-- §3 already makes a mismatch unstorable; saying it here as well means a claim
-- never depends on that key existing.
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
begin
  return query
  with due as (
    select a.id
      from public.scheduled_actions a
      join public.automation_runs r
        on r.id = a.run_id and r.tenant_id = a.tenant_id
     where (p_tenant is null or a.tenant_id = p_tenant)
       and r.config_snapshot_id is not null
       and a.config_snapshot_id is not null
       and a.config_snapshot_id = r.config_snapshot_id
       and (
         (a.status = 'pending' and a.run_at <= now())
         or (a.status = 'claimed'
             and a.locked_at is not null
             and a.locked_at < now() - make_interval(secs => greatest(p_lease_seconds, 30)))
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
     for update skip locked
  )
  update public.scheduled_actions a
     set status      = 'claimed',
         locked_at   = now(),
         locked_by   = coalesce(nullif(trim(p_worker), ''), 'dispatcher'),
         lease_token = v_lease,
         fence       = a.fence + 1,
         attempts    = a.attempts + 1
    from due
   where a.id = due.id
  returning a.*;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. privileges
-- ---------------------------------------------------------------------------

-- `create or replace` keeps a function's existing grants; restated so this file
-- is correct on its own. None of these is callable from a browser.
revoke all on function public.claim_actions_internal(uuid, integer, text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.automation_runs_guard_snapshot()
  from public, anon, authenticated;
revoke all on function public.scheduled_actions_guard_snapshot()
  from public, anon, authenticated;

-- No policy is added or changed. `automation_runs` and `scheduled_actions` still
-- have no insert, update or delete policy for any browser role (0010), so the
-- service role remains the only writer and these triggers bind it too.
