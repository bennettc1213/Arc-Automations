-- ===========================================================================
-- 0019 — workflow manifest, versions, deployments and assignments (ARC-230)
-- ===========================================================================
--
-- 0018 let ARC dispatch an attempt to a shared n8n workflow. It trusted whoever built the
-- runner to name the right workflow, and nothing checked the module's own posture: a Lead
-- Recovery action — a module the registry says may never use n8n (ADR ARC-010 §11) —
-- could be dispatched. This migration puts both under ARC's control (§21, §29, §30):
--
--   runner_workflow_versions     every workflow version ARC knows, registered from the
--                                source-controlled manifest (n8n/manifest.json): what it
--                                executes, what it may do outside ARC, the checksum of the
--                                reviewed content, its error handler, and a review status
--                                (draft → approved → deprecated → disabled).
--   runner_workflow_deployments  the environment lookup: which n8n workflow id and webhook
--                                a version has in staging, development or test. The only
--                                table an n8n id appears in (§29.1). Production waits on
--                                the licensing gate (§26) — the check below says so.
--   runner_workflow_assignments  which approved version executes one action type of one
--                                module version. Changing it retires the old row and adds
--                                a new one; nothing is ever rewritten, so history stays.
--
-- And on `runner_dispatches`, what each dispatched attempt actually ran: the assignment,
-- the deployment, the workflow's checksum, its error handler and whether ARC may retry it
-- — written by ARC from these tables, never from the runner's say-so, and never changed
-- afterwards. `runner_attempt_attribution` reads it next to the attempt, for ARC-OPT-460.
--
-- The rules, enforced here:
--
--   * A module version whose registry posture is `prohibited`, or whose execution mode is
--     `direct`, is never assigned a workflow. Lead Recovery v1 is both.
--   * A new assignment needs an approved action workflow of the same module, reviewed
--     against that module version, that executes the action type, speaks the bridge's
--     contract, and requires no capability the module version does not.
--   * A dispatch needs an active assignment for its run's module version and action type,
--     a version that is not disabled, and a deployment in this environment.
--
-- Registration, approval, deployment and assignment are operator decisions, made through
-- service-role functions that check the operator. No browser role writes or runs any of it.
--
-- Forward-only, except one thing dropped on purpose: 0018's seven-argument
-- `record_runner_dispatch`, which could record an unattributed dispatch. It has never been
-- applied to a hosted database; its replacement below takes an assignment instead.

-- ---------------------------------------------------------------------------
-- 0. helpers
-- ---------------------------------------------------------------------------

create or replace function public.bridge_require_operator(p_actor uuid)
returns void
language plpgsql
stable
set search_path = public
as $fn$
begin
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_bridge:forbidden: this is an operator decision' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_bridge:forbidden: the actor must be the signed-in caller' using errcode = 'P0001';
  end if;
end;
$fn$;

create or replace function public.effect_class_rank(p_class text)
returns integer
language sql
immutable
as $fn$
  select case p_class when 'none' then 0 when 'external_read' then 1 when 'external_effect' then 2 end
$fn$;

-- ---------------------------------------------------------------------------
-- 1. workflow versions
-- ---------------------------------------------------------------------------

create table if not exists public.runner_workflow_versions (
  id                       uuid primary key default gen_random_uuid(),
  runner_key               text not null check (runner_key ~ '^[a-z][a-z0-9-]{2,80}$'),
  workflow_version         text not null check (workflow_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  role                     text not null check (role in ('action', 'error_handler')),
  display_name             text not null check (char_length(btrim(display_name)) between 1 and 120),
  module_key               text references public.registry_modules(key) on delete restrict,
  module_versions          integer[] not null default '{}',
  action_types             text[] not null default '{}',
  runner_kind              text not null check (runner_kind = 'n8n'),
  checksum                 text not null check (checksum ~ '^sha256:[0-9a-f]{64}$'),
  input_contract_version   integer not null check (input_contract_version = 1),
  output_contract_version  integer not null check (output_contract_version = 1),
  effect_class             text not null check (effect_class in ('none', 'external_read', 'external_effect')),
  required_capabilities    text[] not null default '{}',
  auto_retry               boolean not null,
  timeout_ambiguous        boolean not null,
  error_handler_key        text,
  error_handler_version    text,
  owner                    text check (owner is null or char_length(owner) <= 120),

  -- draft: registered, not reviewed. approved: may be assigned and run. deprecated: runs
  -- where it is still assigned, may not be newly assigned. disabled: never runs again.
  status                   text not null default 'draft' check (status in ('draft', 'approved', 'deprecated', 'disabled')),
  registered_by            uuid not null,
  registered_at            timestamptz not null default now(),
  status_changed_by        uuid,
  status_changed_at        timestamptz,
  status_reason            text check (status_reason is null or char_length(status_reason) <= 300),

  unique (runner_key, workflow_version),

  constraint runner_workflow_versions_timeout check (effect_class <> 'external_effect' or timeout_ambiguous),
  constraint runner_workflow_versions_handler_whole check ((error_handler_key is null) = (error_handler_version is null)),
  constraint runner_workflow_versions_role_shape check (
    case role
      when 'error_handler' then module_key is null and module_versions = '{}' and action_types = '{}' and error_handler_key is null
      else module_key is not null and cardinality(module_versions) > 0 and cardinality(action_types) > 0 and error_handler_key is not null
    end
  ),
  constraint runner_workflow_versions_no_secrets check (
    not public.scheduler_secret_shaped(display_name) and not public.scheduler_secret_shaped(coalesce(owner, ''))
  ),

  foreign key (error_handler_key, error_handler_version)
    references public.runner_workflow_versions (runner_key, workflow_version) on delete restrict
);

-- What was reviewed never changes; only the status moves, and only forward.
create or replace function public.runner_workflow_versions_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_handler public.runner_workflow_versions;
  v_type    text;
  v_bad     text;
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_bridge:workflow_history: workflow versions are never deleted — disable them' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'arc_bridge:workflow_history: a workflow version is registered as a draft' using errcode = 'P0001';
    end if;
    -- one runner key is always the same role.
    if exists (select 1 from public.runner_workflow_versions w where w.runner_key = new.runner_key and w.role <> new.role) then
      raise exception 'arc_bridge:invalid_manifest: % is already a different role', new.runner_key using errcode = 'P0001';
    end if;
    if new.role = 'action' then
      select * into v_handler from public.runner_workflow_versions w
       where w.runner_key = new.error_handler_key and w.workflow_version = new.error_handler_version;
      if not found or v_handler.role <> 'error_handler' then
        raise exception 'arc_bridge:invalid_manifest: % is not a registered error handler', new.error_handler_key using errcode = 'P0001';
      end if;
      select v into v_bad from unnest(new.module_versions) v
       where not exists (select 1 from public.registry_module_versions m where m.module_key = new.module_key and m.version = v) limit 1;
      if v_bad is not null then
        raise exception 'arc_bridge:invalid_manifest: % has no version %', new.module_key, v_bad using errcode = 'P0001';
      end if;
      foreach v_type in array new.action_types loop
        if not exists (select 1 from public.automation_action_types t
                        where t.key = v_type and t.dispatcher = 'scheduler'
                          and public.effect_class_rank(t.effect_class) <= public.effect_class_rank(new.effect_class)) then
          raise exception 'arc_bridge:invalid_manifest: % is not a scheduler action type this workflow''s effect class covers', v_type using errcode = 'P0001';
        end if;
      end loop;
    end if;
    select c into v_bad from unnest(new.required_capabilities) c
     where not exists (select 1 from public.registry_capabilities r where r.key = c) limit 1;
    if v_bad is not null then
      raise exception 'arc_bridge:invalid_manifest: % is not a registered capability', v_bad using errcode = 'P0001';
    end if;
    new.registered_at := now();
    return new;
  end if;

  if (to_jsonb(new) - 'status' - 'status_changed_by' - 'status_changed_at' - 'status_reason')
     is distinct from (to_jsonb(old) - 'status' - 'status_changed_by' - 'status_changed_at' - 'status_reason') then
    raise exception 'arc_bridge:workflow_history: a registered workflow version is immutable — publish a new version' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('approved', 'disabled'))
    or (old.status = 'approved' and new.status in ('deprecated', 'disabled'))
    or (old.status = 'deprecated' and new.status = 'disabled')) then
    raise exception 'arc_bridge:illegal_status: a workflow version does not go from % to %', old.status, new.status using errcode = 'P0001';
  end if;
  new.status_changed_at := now();
  return new;
end;
$fn$;

drop trigger if exists runner_workflow_versions_guard on public.runner_workflow_versions;
create trigger runner_workflow_versions_guard
  before insert or update or delete on public.runner_workflow_versions
  for each row execute function public.runner_workflow_versions_guard();

-- ---------------------------------------------------------------------------
-- 2. deployments — the environment lookup
-- ---------------------------------------------------------------------------

create table if not exists public.runner_workflow_deployments (
  id               uuid primary key default gen_random_uuid(),
  runner_key       text not null,
  workflow_version text not null,
  -- production is not an environment n8n serves until the licensing gate (§26) closes;
  -- lifting this is a migration, which is the recorded decision the gate asks for.
  environment      text not null check (environment in ('staging', 'development', 'test')),
  n8n_workflow_id  text not null check (n8n_workflow_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- an action workflow's webhook. an error handler has none: n8n calls it on failure.
  webhook_url      text check (webhook_url is null or webhook_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[^\s?#]*$'),
  registered_by    uuid not null,
  registered_at    timestamptz not null default now(),
  retired_by       uuid,
  retired_at       timestamptz,

  constraint runner_workflow_deployments_retired check ((retired_at is null) = (retired_by is null)),
  foreign key (runner_key, workflow_version)
    references public.runner_workflow_versions (runner_key, workflow_version) on delete restrict
);

create unique index if not exists runner_workflow_deployments_live
  on public.runner_workflow_deployments (runner_key, workflow_version, environment) where retired_at is null;
create unique index if not exists runner_workflow_deployments_n8n_id
  on public.runner_workflow_deployments (environment, n8n_workflow_id) where retired_at is null;

create or replace function public.runner_workflow_deployments_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_bridge:workflow_history: deployments are retired, never deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and ((to_jsonb(new) - 'retired_by' - 'retired_at') is distinct from (to_jsonb(old) - 'retired_by' - 'retired_at')
                           or old.retired_at is not null) then
    raise exception 'arc_bridge:workflow_history: a deployment is only ever retired, once' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists runner_workflow_deployments_guard on public.runner_workflow_deployments;
create trigger runner_workflow_deployments_guard
  before update or delete on public.runner_workflow_deployments
  for each row execute function public.runner_workflow_deployments_guard();

-- ---------------------------------------------------------------------------
-- 3. assignments
-- ---------------------------------------------------------------------------

create table if not exists public.runner_workflow_assignments (
  id               uuid primary key default gen_random_uuid(),
  module_key       text not null,
  module_version   integer not null,
  action_type      text not null references public.automation_action_types(key) on delete restrict,
  runner_kind      text not null check (runner_kind = 'n8n'),
  runner_key       text not null,
  workflow_version text not null,
  status           text not null default 'active' check (status in ('active', 'retired')),
  assigned_by      uuid not null,
  assigned_at      timestamptz not null default now(),
  retired_by       uuid,
  retired_at       timestamptz,
  retire_reason    text check (retire_reason is null or char_length(retire_reason) <= 300),

  constraint runner_workflow_assignments_retired check ((status = 'retired') = (retired_at is not null)),
  foreign key (module_key, module_version)
    references public.registry_module_versions (module_key, version) on delete restrict,
  foreign key (runner_key, workflow_version)
    references public.runner_workflow_versions (runner_key, workflow_version) on delete restrict
);

create unique index if not exists runner_workflow_assignments_active
  on public.runner_workflow_assignments (module_key, module_version, action_type) where status = 'active';

create or replace function public.runner_workflow_assignments_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_bridge:workflow_history: assignments are retired, never deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and ((to_jsonb(new) - 'status' - 'retired_by' - 'retired_at' - 'retire_reason')
                            is distinct from (to_jsonb(old) - 'status' - 'retired_by' - 'retired_at' - 'retire_reason')
                           or old.status = 'retired') then
    raise exception 'arc_bridge:workflow_history: an assignment is only ever retired, once — assign a new one instead' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists runner_workflow_assignments_guard on public.runner_workflow_assignments;
create trigger runner_workflow_assignments_guard
  before update or delete on public.runner_workflow_assignments
  for each row execute function public.runner_workflow_assignments_guard();

-- ---------------------------------------------------------------------------
-- 4. attribution on every dispatch
-- ---------------------------------------------------------------------------

alter table public.runner_dispatches
  add column if not exists assignment_id         uuid references public.runner_workflow_assignments(id) on delete restrict,
  add column if not exists deployment_id         uuid references public.runner_workflow_deployments(id) on delete restrict,
  add column if not exists workflow_checksum     text check (workflow_checksum is null or workflow_checksum ~ '^sha256:[0-9a-f]{64}$'),
  add column if not exists error_handler_key     text,
  add column if not exists error_handler_version text,
  add column if not exists auto_retry            boolean;

-- every dispatch from here on is attributed. (not valid: 0018 was never applied to a
-- hosted database, and a local one holds no unattributed row worth refusing.)
alter table public.runner_dispatches drop constraint if exists runner_dispatches_attributed;
alter table public.runner_dispatches add constraint runner_dispatches_attributed
  check (assignment_id is not null and deployment_id is not null and workflow_checksum is not null and auto_retry is not null)
  not valid;

-- 0018's guard, with the attribution columns part of a dispatch's fixed identity.
create or replace function public.runner_dispatches_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_bridge:dispatch_history: dispatches are history and are never deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    if new.runner_execution_id is not null or new.envelope_opened_at is not null or new.voided_at is not null
       or new.callback is not null then
      raise exception 'arc_bridge:dispatch_history: a dispatch begins unanswered' using errcode = 'P0001';
    end if;
    new.issued_at := now();
    return new;
  end if;

  if (new.attempt_id, new.tenant_id, new.action_id, new.run_id, new.runner_kind, new.runner_key,
      new.workflow_version, new.nonce, new.issued_at, new.expires_at,
      new.assignment_id, new.deployment_id, new.workflow_checksum, new.error_handler_key, new.error_handler_version, new.auto_retry)
     is distinct from
     (old.attempt_id, old.tenant_id, old.action_id, old.run_id, old.runner_kind, old.runner_key,
      old.workflow_version, old.nonce, old.issued_at, old.expires_at,
      old.assignment_id, old.deployment_id, old.workflow_checksum, old.error_handler_key, old.error_handler_version, old.auto_retry) then
    raise exception 'arc_bridge:dispatch_history: a dispatch''s identity is fixed' using errcode = 'P0001';
  end if;
  if (old.runner_execution_id is not null and new.runner_execution_id is distinct from old.runner_execution_id)
     or (old.envelope_opened_at is not null and new.envelope_opened_at is distinct from old.envelope_opened_at)
     or (old.voided_at is not null and (new.voided_at, new.void_reason) is distinct from (old.voided_at, old.void_reason))
     or (old.callback is not null and (new.callback, new.callback_digest, new.callback_received_at)
                                       is distinct from (old.callback, old.callback_digest, old.callback_received_at)) then
    raise exception 'arc_bridge:dispatch_history: what a dispatch recorded is written once' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

-- the attempt and what it ran, side by side. Row security is the caller's: operators see
-- it, nobody else does (both tables are operator-read only).
create or replace view public.runner_attempt_attribution
  with (security_invoker = true) as
select p.id                   as attempt_id,
       p.tenant_id,
       p.action_id,
       p.run_id,
       p.attempt_no,
       p.runner_kind,
       p.status               as attempt_status,
       d.assignment_id,
       d.runner_key,
       d.workflow_version,
       d.workflow_checksum,
       d.error_handler_key,
       d.error_handler_version,
       d.runner_execution_id,
       d.issued_at            as dispatched_at
  from public.automation_action_attempts p
  left join public.runner_dispatches d on d.attempt_id = p.id and d.tenant_id = p.tenant_id;

-- ---------------------------------------------------------------------------
-- 5. operator decisions
-- ---------------------------------------------------------------------------

-- Register one manifest entry as a draft. The same entry again is a no-op; the same key
-- and version with different content is refused — a published version is never replaced.
create or replace function public.register_runner_workflow_version(p_actor uuid, p_entry jsonb)
returns table (id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row      public.runner_workflow_versions;
  v_existing public.runner_workflow_versions;
  v_fields   text[] := array['role', 'display_name', 'module_key', 'module_versions', 'action_types', 'runner_kind',
                             'checksum', 'input_contract_version', 'output_contract_version', 'effect_class',
                             'required_capabilities', 'auto_retry', 'timeout_ambiguous', 'error_handler_key',
                             'error_handler_version', 'owner'];
  v_key      text;
  v_same     boolean := true;
begin
  perform public.bridge_require_operator(p_actor);
  if jsonb_typeof(p_entry) <> 'object' then
    raise exception 'arc_bridge:invalid_manifest: an entry is an object' using errcode = 'P0001';
  end if;

  v_row := jsonb_populate_record(null::public.runner_workflow_versions, jsonb_build_object(
    'runner_key', p_entry->>'runner_key',
    'workflow_version', p_entry->>'workflow_version',
    'role', p_entry->>'role',
    'display_name', p_entry->>'display_name',
    'module_key', p_entry->'module_key',
    'module_versions', coalesce(p_entry->'module_versions', '[]'::jsonb),
    'action_types', coalesce(p_entry->'action_types', '[]'::jsonb),
    'runner_kind', p_entry->>'runner_kind',
    'checksum', p_entry->>'checksum',
    'input_contract_version', p_entry->'input_contract_version',
    'output_contract_version', p_entry->'output_contract_version',
    'effect_class', p_entry->>'effect_class',
    'required_capabilities', coalesce(p_entry->'required_capabilities', '[]'::jsonb),
    'auto_retry', p_entry->'auto_retry',
    'timeout_ambiguous', p_entry->'timeout_ambiguous',
    'error_handler_key', p_entry->'error_handler'->>'runner_key',
    'error_handler_version', p_entry->'error_handler'->>'workflow_version',
    'owner', p_entry->'owner'
  ));

  select * into v_existing from public.runner_workflow_versions w
   where w.runner_key = v_row.runner_key and w.workflow_version = v_row.workflow_version;
  if found then
    foreach v_key in array v_fields loop
      if (to_jsonb(v_existing)->v_key) is distinct from (to_jsonb(v_row)->v_key) then
        v_same := false;
      end if;
    end loop;
    if not v_same then
      raise exception 'arc_bridge:version_conflict: %@% is already registered with different content — publish a new version',
        v_row.runner_key, v_row.workflow_version using errcode = 'P0001';
    end if;
    return query select v_existing.id, false;
    return;
  end if;

  insert into public.runner_workflow_versions (
    runner_key, workflow_version, role, display_name, module_key, module_versions, action_types, runner_kind, checksum,
    input_contract_version, output_contract_version, effect_class, required_capabilities, auto_retry, timeout_ambiguous,
    error_handler_key, error_handler_version, owner, registered_by
  ) values (
    v_row.runner_key, v_row.workflow_version, v_row.role, v_row.display_name, v_row.module_key, v_row.module_versions,
    v_row.action_types, v_row.runner_kind, v_row.checksum, v_row.input_contract_version, v_row.output_contract_version,
    v_row.effect_class, v_row.required_capabilities, v_row.auto_retry, v_row.timeout_ambiguous,
    v_row.error_handler_key, v_row.error_handler_version, v_row.owner, p_actor
  ) returning * into v_row;
  return query select v_row.id, true;
end;
$fn$;

create or replace function public.set_runner_workflow_status(
  p_actor uuid, p_runner_key text, p_workflow_version text, p_status text, p_reason text
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old text;
begin
  perform public.bridge_require_operator(p_actor);
  select w.status into v_old from public.runner_workflow_versions w
   where w.runner_key = p_runner_key and w.workflow_version = p_workflow_version for update;
  if not found then
    raise exception 'arc_bridge:not_found: no such workflow version' using errcode = 'P0001';
  end if;
  if v_old = p_status then
    return p_status;
  end if;
  update public.runner_workflow_versions w
     set status = p_status, status_changed_by = p_actor, status_reason = public.scheduler_safe_text(p_reason, 300)
   where w.runner_key = p_runner_key and w.workflow_version = p_workflow_version;
  return p_status;
end;
$fn$;

-- Where a version runs in one environment. A redeployment retires the previous row.
create or replace function public.register_runner_workflow_deployment(
  p_actor uuid, p_runner_key text, p_workflow_version text, p_environment text, p_n8n_workflow_id text, p_webhook_url text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_version public.runner_workflow_versions;
  v_live    public.runner_workflow_deployments;
  v_id      uuid;
begin
  perform public.bridge_require_operator(p_actor);
  select * into v_version from public.runner_workflow_versions w
   where w.runner_key = p_runner_key and w.workflow_version = p_workflow_version;
  if not found then
    raise exception 'arc_bridge:not_found: no such workflow version' using errcode = 'P0001';
  end if;
  if v_version.status = 'disabled' then
    raise exception 'arc_bridge:workflow_disabled: a disabled version is not deployed' using errcode = 'P0001';
  end if;
  if (v_version.role = 'action') <> (p_webhook_url is not null) then
    raise exception 'arc_bridge:invalid_deployment: an action workflow has a webhook; an error handler has none' using errcode = 'P0001';
  end if;

  select * into v_live from public.runner_workflow_deployments d
   where d.runner_key = p_runner_key and d.workflow_version = p_workflow_version and d.environment = p_environment and d.retired_at is null
     for update;
  if found and v_live.n8n_workflow_id = p_n8n_workflow_id and v_live.webhook_url is not distinct from p_webhook_url then
    return v_live.id;
  end if;
  if found then
    update public.runner_workflow_deployments set retired_at = now(), retired_by = p_actor where id = v_live.id;
  end if;
  insert into public.runner_workflow_deployments (runner_key, workflow_version, environment, n8n_workflow_id, webhook_url, registered_by)
  values (p_runner_key, p_workflow_version, p_environment, p_n8n_workflow_id, p_webhook_url, p_actor)
  returning id into v_id;
  return v_id;
end;
$fn$;

-- Bind one action type of one module version to an approved workflow version. The
-- current binding, if any, is retired; history is never rewritten.
create or replace function public.assign_runner_workflow(
  p_actor uuid, p_module_key text, p_module_version integer, p_action_type text,
  p_runner_key text, p_workflow_version text, p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_module  public.registry_module_versions;
  v_type    public.automation_action_types;
  v_version public.runner_workflow_versions;
  v_current public.runner_workflow_assignments;
  v_missing text;
  v_id      uuid;
begin
  perform public.bridge_require_operator(p_actor);

  select * into v_module from public.registry_module_versions m where m.module_key = p_module_key and m.version = p_module_version;
  if not found then
    raise exception 'arc_bridge:not_found: no such module version' using errcode = 'P0001';
  end if;
  if v_module.n8n_posture = 'prohibited' or v_module.execution_mode = 'direct' then
    raise exception 'arc_bridge:n8n_prohibited: %@% runs directly and may not use n8n (ADR ARC-010 §11, §30)', p_module_key, p_module_version
      using errcode = 'P0001';
  end if;

  select * into v_type from public.automation_action_types t where t.key = p_action_type;
  if not found or v_type.dispatcher <> 'scheduler' then
    raise exception 'arc_bridge:not_scheduler_action: % is not dispatched by the scheduler', p_action_type using errcode = 'P0001';
  end if;

  select * into v_version from public.runner_workflow_versions w
   where w.runner_key = p_runner_key and w.workflow_version = p_workflow_version;
  if not found then
    raise exception 'arc_bridge:not_found: no such workflow version' using errcode = 'P0001';
  end if;
  if v_version.status <> 'approved' then
    raise exception 'arc_bridge:workflow_not_approved: only an approved version is assigned (this one is %)', v_version.status using errcode = 'P0001';
  end if;
  if v_version.role <> 'action' or v_version.module_key <> p_module_key or not (p_module_version = any (v_version.module_versions)) then
    raise exception 'arc_bridge:incompatible_workflow: %@% was not reviewed for %@%', p_runner_key, p_workflow_version, p_module_key, p_module_version
      using errcode = 'P0001';
  end if;
  if not (p_action_type = any (v_version.action_types)) then
    raise exception 'arc_bridge:incompatible_workflow: %@% does not execute %', p_runner_key, p_workflow_version, p_action_type using errcode = 'P0001';
  end if;
  select c into v_missing from unnest(v_version.required_capabilities) c
   where not exists (
     select 1 from public.registry_module_requirements r
       join public.registry_module_requirement_capabilities rc on rc.requirement_id = r.id
      where r.module_version_id = v_module.id and rc.capability_key = c)
   limit 1;
  if v_missing is not null then
    raise exception 'arc_bridge:incompatible_workflow: it needs %, which %@% does not declare', v_missing, p_module_key, p_module_version
      using errcode = 'P0001';
  end if;

  select * into v_current from public.runner_workflow_assignments a
   where a.module_key = p_module_key and a.module_version = p_module_version and a.action_type = p_action_type and a.status = 'active'
     for update;
  if found and v_current.runner_key = p_runner_key and v_current.workflow_version = p_workflow_version then
    return v_current.id;
  end if;
  if found then
    update public.runner_workflow_assignments
       set status = 'retired', retired_at = now(), retired_by = p_actor, retire_reason = 'superseded'
     where id = v_current.id;
  end if;
  insert into public.runner_workflow_assignments (module_key, module_version, action_type, runner_kind, runner_key, workflow_version, assigned_by)
  values (p_module_key, p_module_version, p_action_type, 'n8n', p_runner_key, p_workflow_version, p_actor)
  returning id into v_id;
  return v_id;
end;
$fn$;

create or replace function public.retire_runner_workflow_assignment(p_actor uuid, p_assignment uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.bridge_require_operator(p_actor);
  update public.runner_workflow_assignments
     set status = 'retired', retired_at = now(), retired_by = p_actor, retire_reason = public.scheduler_safe_text(p_reason, 300)
   where id = p_assignment and status = 'active';
  return case when found then 'retired' else 'not_active' end;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. resolving and recording a dispatch
-- ---------------------------------------------------------------------------

-- What executes this action type of this module version here, or why nothing may.
create or replace function public.resolve_runner_workflow(
  p_module_key text, p_module_version integer, p_action_type text, p_environment text
)
returns table (code text, assignment_id uuid, runner_key text, workflow_version text, webhook_url text)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_module     public.registry_module_versions;
  v_assignment public.runner_workflow_assignments;
  v_version    public.runner_workflow_versions;
  v_deployment public.runner_workflow_deployments;
begin
  select * into v_module from public.registry_module_versions m where m.module_key = p_module_key and m.version = p_module_version;
  if not found or v_module.n8n_posture = 'prohibited' or v_module.execution_mode = 'direct' then
    return query select 'n8n_prohibited', null::uuid, null::text, null::text, null::text;
    return;
  end if;
  select * into v_assignment from public.runner_workflow_assignments a
   where a.module_key = p_module_key and a.module_version = p_module_version and a.action_type = p_action_type and a.status = 'active';
  if not found then
    return query select 'no_assignment', null::uuid, null::text, null::text, null::text;
    return;
  end if;
  select * into v_version from public.runner_workflow_versions w
   where w.runner_key = v_assignment.runner_key and w.workflow_version = v_assignment.workflow_version;
  if v_version.status not in ('approved', 'deprecated') then
    return query select 'workflow_' || v_version.status, v_assignment.id, v_assignment.runner_key, v_assignment.workflow_version, null::text;
    return;
  end if;
  select * into v_deployment from public.runner_workflow_deployments d
   where d.runner_key = v_assignment.runner_key and d.workflow_version = v_assignment.workflow_version
     and d.environment = p_environment and d.retired_at is null;
  if not found then
    return query select 'not_deployed', v_assignment.id, v_assignment.runner_key, v_assignment.workflow_version, null::text;
    return;
  end if;
  return query select 'ok', v_assignment.id, v_assignment.runner_key, v_assignment.workflow_version, v_deployment.webhook_url;
end;
$fn$;

drop function if exists public.record_runner_dispatch(uuid, uuid, text, text, text, uuid, timestamptz);

-- A dispatch is attributed by ARC, from the assignment — never from what the runner says
-- it is sending. Everything is re-checked under the attempt's lock.
create or replace function public.record_runner_dispatch(
  p_attempt     uuid,
  p_tenant      uuid,
  p_runner_kind text,
  p_assignment  uuid,
  p_environment text,
  p_nonce       uuid,
  p_expires_at  timestamptz
)
returns table (runner_key text, workflow_version text, workflow_checksum text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_attempt    public.automation_action_attempts;
  v_action     public.scheduled_actions;
  v_run        public.automation_runs;
  v_assignment public.runner_workflow_assignments;
  v_version    public.runner_workflow_versions;
  v_deployment public.runner_workflow_deployments;
begin
  select * into v_attempt from public.automation_action_attempts p
   where p.id = p_attempt and p.tenant_id = p_tenant
     for update;
  if not found then
    raise exception 'arc_bridge:not_found: no such attempt for this tenant' using errcode = 'P0001';
  end if;
  if v_attempt.status <> 'running' then
    raise exception 'arc_bridge:attempt_not_running: only a started attempt is dispatched (it is %)', v_attempt.status using errcode = 'P0001';
  end if;
  if v_attempt.runner_kind is distinct from p_runner_kind then
    raise exception 'arc_bridge:runner_mismatch: the attempt was started for another runner' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.runner_dispatches d where d.attempt_id = p_attempt) then
    raise exception 'arc_bridge:already_dispatched: an attempt is dispatched once' using errcode = 'P0001';
  end if;

  select * into v_action from public.scheduled_actions a where a.id = v_attempt.action_id and a.tenant_id = p_tenant;
  select * into v_run from public.automation_runs r where r.id = v_attempt.run_id and r.tenant_id = p_tenant;
  select * into v_assignment from public.runner_workflow_assignments a where a.id = p_assignment for share;
  if not found or v_assignment.status <> 'active' then
    raise exception 'arc_bridge:assignment_retired: that assignment is not the active one' using errcode = 'P0001';
  end if;
  if v_assignment.module_key <> v_run.module_key or v_assignment.module_version is distinct from v_run.module_version
     or v_assignment.action_type <> v_action.action_type then
    raise exception 'arc_bridge:assignment_mismatch: the assignment is for another module version or action type' using errcode = 'P0001';
  end if;
  select * into v_version from public.runner_workflow_versions w
   where w.runner_key = v_assignment.runner_key and w.workflow_version = v_assignment.workflow_version;
  if v_version.status not in ('approved', 'deprecated') then
    raise exception 'arc_bridge:workflow_disabled: %@% is %', v_version.runner_key, v_version.workflow_version, v_version.status using errcode = 'P0001';
  end if;
  select * into v_deployment from public.runner_workflow_deployments d
   where d.runner_key = v_version.runner_key and d.workflow_version = v_version.workflow_version
     and d.environment = p_environment and d.retired_at is null;
  if not found then
    raise exception 'arc_bridge:not_deployed: %@% is not deployed in %', v_version.runner_key, v_version.workflow_version, p_environment using errcode = 'P0001';
  end if;

  insert into public.runner_dispatches (
    attempt_id, tenant_id, action_id, run_id, runner_kind, runner_key, workflow_version, nonce, expires_at,
    assignment_id, deployment_id, workflow_checksum, error_handler_key, error_handler_version, auto_retry
  ) values (
    p_attempt, p_tenant, v_attempt.action_id, v_attempt.run_id, p_runner_kind, v_version.runner_key, v_version.workflow_version,
    p_nonce, p_expires_at, v_assignment.id, v_deployment.id, v_version.checksum, v_version.error_handler_key,
    v_version.error_handler_version, v_version.auto_retry
  );
  insert into public.runner_bridge_log (tenant_id, attempt_id, direction, disposition, code)
  values (p_tenant, p_attempt, 'dispatch', 'accepted', 'dispatch_recorded');

  return query select v_version.runner_key, v_version.workflow_version, v_version.checksum;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------------

alter table public.runner_workflow_versions    enable row level security;
alter table public.runner_workflow_deployments enable row level security;
alter table public.runner_workflow_assignments enable row level security;

drop policy if exists runner_workflow_versions_admin_read on public.runner_workflow_versions;
create policy runner_workflow_versions_admin_read on public.runner_workflow_versions
  for select to authenticated using (public.is_arc_admin());

drop policy if exists runner_workflow_deployments_admin_read on public.runner_workflow_deployments;
create policy runner_workflow_deployments_admin_read on public.runner_workflow_deployments
  for select to authenticated using (public.is_arc_admin());

drop policy if exists runner_workflow_assignments_admin_read on public.runner_workflow_assignments;
create policy runner_workflow_assignments_admin_read on public.runner_workflow_assignments
  for select to authenticated using (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- 8. privileges
-- ---------------------------------------------------------------------------

revoke all on function public.bridge_require_operator(uuid) from public, anon, authenticated;
revoke all on function public.effect_class_rank(text) from public, anon, authenticated;
revoke all on function public.runner_workflow_versions_guard() from public, anon, authenticated;
revoke all on function public.runner_workflow_deployments_guard() from public, anon, authenticated;
revoke all on function public.runner_workflow_assignments_guard() from public, anon, authenticated;
revoke all on function public.runner_dispatches_guard() from public, anon, authenticated;
revoke all on function public.register_runner_workflow_version(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_runner_workflow_status(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.register_runner_workflow_deployment(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.assign_runner_workflow(uuid, text, integer, text, text, text, text) from public, anon, authenticated;
revoke all on function public.retire_runner_workflow_assignment(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.resolve_runner_workflow(text, integer, text, text) from public, anon, authenticated;
revoke all on function public.record_runner_dispatch(uuid, uuid, text, uuid, text, uuid, timestamptz) from public, anon, authenticated;

-- the view reads through its caller's row security (security_invoker), so a signed-in
-- non-operator sees nothing; a signed-out caller is not given it at all.
revoke all on public.runner_attempt_attribution from anon;

grant execute on function public.register_runner_workflow_version(uuid, jsonb) to service_role;
grant execute on function public.set_runner_workflow_status(uuid, text, text, text, text) to service_role;
grant execute on function public.register_runner_workflow_deployment(uuid, text, text, text, text, text) to service_role;
grant execute on function public.assign_runner_workflow(uuid, text, integer, text, text, text, text) to service_role;
grant execute on function public.retire_runner_workflow_assignment(uuid, uuid, text) to service_role;
grant execute on function public.resolve_runner_workflow(text, integer, text, text) to service_role;
grant execute on function public.record_runner_dispatch(uuid, uuid, text, uuid, text, uuid, timestamptz) to service_role;
