-- ===========================================================================
-- 0011 — Lead Recovery execution safety: tenant-scoped claiming, lease
--        fencing, durable external-effect attempts, immutable config snapshots
-- ===========================================================================
--
-- ARC-015. This migration closes the four defects the repository audit and
-- section 37 of the execution-boundary ADR identified in the 0010 engine:
--
--   1. `claim_scheduled_actions` took no tenant argument, so the operator
--      canary drained other tenants' due work into a recording sender.
--   2. Completion filtered on the action id alone — no tenant, no lease — so a
--      stale worker could close out a row another worker had reclaimed.
--   3. Nothing durable was written before the provider call, so a timeout, a
--      crash or a lease race could send the same text twice.
--   4. `config_version` was a counter with no history, so "which configuration
--      did this run actually use" had no answer.
--
-- The through-line of all four is the same: **a side effect must be reserved
-- before it is performed, and only the worker holding the current lease may
-- reserve it.** Everything below exists to make that sentence enforceable in
-- Postgres rather than remembered in TypeScript.
--
-- Additive. No table is dropped, no column is removed, no row is deleted. The
-- one destructive act is dropping the old `claim_scheduled_actions(integer,
-- text, integer)` function, which is deliberate: leaving an unscoped global
-- claim callable is the defect. Its replacements are named so that the global
-- one cannot be reached for by accident.

-- ---------------------------------------------------------------------------
-- 1. lease fencing on scheduled_actions
-- ---------------------------------------------------------------------------

-- `locked_by` is not a fence. The dispatcher's worker name is a constant, so
-- the same identifier reclaims the same row a minute later and a stale worker's
-- late write would still match. A fence has to be unique per claim.
--
--   lease_token — a fresh uuid on every claim. The thing a worker must present.
--   fence       — monotonically increasing per action. Cheap to compare, and it
--                 makes "is this write from an older claim?" a < rather than a
--                 token lookup.

alter table public.scheduled_actions
  add column if not exists lease_token uuid,
  add column if not exists fence       bigint not null default 0,
  -- which snapshot the action was queued under. carried so a claim can refuse
  -- to execute an action whose run predates snapshotting (see §4).
  add column if not exists config_snapshot_id uuid;

-- 'blocked' is new: a legacy action that cannot prove which configuration it
-- was authorised under. It is not pending (a worker must not take it) and not
-- cancelled (an operator may still review and release it).
alter table public.scheduled_actions
  drop constraint if exists scheduled_actions_status_check;
alter table public.scheduled_actions
  add constraint scheduled_actions_status_check
  check (status in ('pending', 'claimed', 'done', 'cancelled', 'failed', 'blocked'));

create index if not exists scheduled_actions_lease_token_idx
  on public.scheduled_actions (lease_token)
  where lease_token is not null;

create index if not exists scheduled_actions_blocked_idx
  on public.scheduled_actions (tenant_id, run_at)
  where status = 'blocked';

-- ---------------------------------------------------------------------------
-- 2. immutable configuration snapshots
-- ---------------------------------------------------------------------------

-- ARC-110 will build the general versioned-configuration engine. This is the
-- narrow thing ARC-015 needs and no more: the exact validated, non-secret
-- configuration payload a run began under, frozen, addressable, and hashed so
-- two runs under identical configuration share one row.
--
-- Deliberately NOT a history of `module_configs`. It records what a *run* used,
-- which is the question the engine has to answer, and it stays true even if the
-- module_configs row is later edited, reverted or deleted.

create table if not exists public.lead_recovery_config_snapshots (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  module_key     text not null default 'lead_recovery' check (module_key in ('lead_recovery')),

  -- the counter the mutable row carried at snapshot time. kept for forensics and
  -- for ARC-110 to correlate against, never trusted on its own as identity.
  config_version integer not null,
  schema_version integer not null default 1,

  -- the validated payload. the same check constraint 0010 put on
  -- module_configs.config applies here: nothing secret-shaped may be stored.
  config         jsonb not null,
  -- sha-256 of the canonical serialisation, computed by the engine. identity.
  config_hash    text not null check (char_length(config_hash) = 64),

  created_at     timestamptz not null default now(),

  -- one row per distinct configuration per tenant. a thousand runs under one
  -- unchanged configuration share a single snapshot.
  unique (tenant_id, config_hash),
  -- lets automation_runs carry a composite FK and so be structurally unable to
  -- reference another tenant's snapshot.
  unique (id, tenant_id)
);

-- the same refusal 0010 applied to module_configs.config. a snapshot is read
-- back and handed to the engine, so it must not be able to carry a credential.
alter table public.lead_recovery_config_snapshots
  drop constraint if exists lead_recovery_config_snapshots_no_secrets;
alter table public.lead_recovery_config_snapshots
  add constraint lead_recovery_config_snapshots_no_secrets
  check (
    config::text !~* '(auth_token|api_key|secret|password|private_key|bearer)\s*"\s*:\s*"[^"]{8,}'
  );

create index if not exists lead_recovery_config_snapshots_tenant_idx
  on public.lead_recovery_config_snapshots (tenant_id, created_at desc);

-- Immutability is the whole point, so it is enforced rather than asserted.
-- Absent policies stop a browser; this stops the service role too.
create or replace function public.lead_recovery_snapshots_are_immutable()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'lead_recovery_config_snapshots is append-only (attempted %)', tg_op
    using errcode = 'P0001';
end;
$fn$;

drop trigger if exists lead_recovery_config_snapshots_immutable
  on public.lead_recovery_config_snapshots;
create trigger lead_recovery_config_snapshots_immutable
  before update or delete on public.lead_recovery_config_snapshots
  for each row execute function public.lead_recovery_snapshots_are_immutable();

-- runs point at the snapshot they began under.
alter table public.automation_runs
  add column if not exists config_snapshot_id uuid;

alter table public.automation_runs
  drop constraint if exists automation_runs_config_snapshot_fk;
alter table public.automation_runs
  add constraint automation_runs_config_snapshot_fk
  foreign key (config_snapshot_id, tenant_id)
  references public.lead_recovery_config_snapshots (id, tenant_id)
  on delete restrict;

-- ---------------------------------------------------------------------------
-- 3. durable external-effect attempts
-- ---------------------------------------------------------------------------

-- One row per *logical* customer- or employee-affecting side effect, created
-- BEFORE the provider is called. This is the send-once mechanism: reservation
-- is an insert that either succeeds (this worker owns the effect) or collides
-- (somebody already owns it, so do not send).
--
-- "Effectively once", not "exactly once". No database can make an external
-- provider call atomic with a local commit. What this buys is: a second send
-- never happens *silently*. An ambiguous outcome is parked in a state that
-- refuses automatic retry and asks for a human or a reconciler.

create table if not exists public.lead_recovery_effect_attempts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- what this effect belongs to. run and lead are composite-keyed to the tenant
  -- so a cross-tenant reference cannot be written at all.
  run_id        uuid,
  lead_id       uuid,
  action_id     uuid,
  conversation_id uuid,

  effect_type   text not null check (effect_type in (
    'customer_sms', 'staff_sms'
  )),

  -- the stable identity of the side effect itself: "the first response for run
  -- X", "the staff alert to +1555… for lead Y". Retrying an effect reuses this
  -- key; it never generates a new one.
  effect_key    text not null,
  -- what is handed to the provider when the provider supports idempotency.
  idempotency_key text not null,

  -- who reserved it, under which claim. a stale worker cannot advance a row it
  -- does not hold the lease for.
  worker        text,
  lease_token   uuid,
  fence         bigint not null default 0,
  attempt_no    integer not null default 1 check (attempt_no >= 1),

  provider      text not null default 'twilio',
  -- masked at the boundary. the full destination already lives on leads /
  -- module_configs; duplicating it here would widen the blast radius for no gain.
  destination_ref text,

  -- the state machine. see docs/architecture/ARC_LEAD_RECOVERY_SAFETY_AND_PINNING.md.
  state         text not null default 'reserved' check (state in (
    'reserved',               -- claimed by a worker, provider not yet called
    'cancelled_before_send',  -- a guard fired between reservation and dispatch
    'dispatching',            -- provider call in flight
    'accepted',               -- provider took it; delivery not yet confirmed
    'confirmed',              -- provider confirmed delivery
    'rejected',               -- provider refused it; provably not sent
    'failed_retryable',       -- provably not accepted; safe to try again
    'failed_terminal',        -- will not succeed; do not retry
    'outcome_unknown',        -- we do not know whether it was accepted
    'reconciliation_required' -- unknown, and it needs a human or a reconciler
  )),

  provider_message_id text,
  error_category text,
  error_detail   text,
  retryable      boolean,

  is_canary      boolean not null default false,

  reserved_at          timestamptz not null default now(),
  dispatch_started_at  timestamptz,
  accepted_at          timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz not null default now(),

  -- THE send-once constraint. One row per logical effect per tenant. A second
  -- worker attempting to reserve the same effect collides here rather than
  -- reaching Twilio.
  unique (tenant_id, effect_key),
  unique (id, tenant_id),

  foreign key (run_id, tenant_id)
    references public.automation_runs (id, tenant_id) on delete cascade,
  foreign key (lead_id, tenant_id)
    references public.leads (id, tenant_id) on delete cascade
);

-- a provider reference, once we have one, identifies exactly one attempt. this
-- is what makes a delivery callback idempotent and a duplicate callback a no-op.
create unique index if not exists lead_recovery_effect_attempts_provider_uniq
  on public.lead_recovery_effect_attempts (tenant_id, provider, provider_message_id)
  where provider_message_id is not null;

create index if not exists lead_recovery_effect_attempts_action_idx
  on public.lead_recovery_effect_attempts (tenant_id, action_id);

create index if not exists lead_recovery_effect_attempts_run_idx
  on public.lead_recovery_effect_attempts (tenant_id, run_id);

-- the operator's queue: everything that needs a human or a reconciler.
create index if not exists lead_recovery_effect_attempts_open_idx
  on public.lead_recovery_effect_attempts (tenant_id, updated_at desc)
  where state in ('outcome_unknown', 'reconciliation_required', 'dispatching');

create or replace function public.lead_recovery_effect_attempts_touch()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  -- reserved_at and effect_key are identity. a caller that could change them
  -- could launder a second send through an existing reservation.
  new.reserved_at := old.reserved_at;
  new.effect_key  := old.effect_key;
  new.tenant_id   := old.tenant_id;
  return new;
end;
$fn$;

drop trigger if exists lead_recovery_effect_attempts_touch
  on public.lead_recovery_effect_attempts;
create trigger lead_recovery_effect_attempts_touch
  before update on public.lead_recovery_effect_attempts
  for each row execute function public.lead_recovery_effect_attempts_touch();

-- ---------------------------------------------------------------------------
-- 4. legacy pending actions
-- ---------------------------------------------------------------------------

-- Every action queued before this migration belongs to a run with no snapshot.
-- We cannot know what configuration it was authorised under, and reconstructing
-- one from today's mutable row would be inventing history, not recovering it.
--
-- Policy: block, do not cancel and do not guess. The work is preserved, an
-- operator can see it, and nothing sends on an unprovable authorisation.
-- `last_error` carries the reason so the console can explain itself.

update public.scheduled_actions a
   set status = 'blocked',
       last_error = coalesce(
         nullif(a.last_error, ''),
         'blocked by 0011: queued before configuration snapshots existed, so the configuration it was authorised under cannot be proven'
       )
 where a.status in ('pending', 'claimed')
   and exists (
     select 1 from public.automation_runs r
      where r.id = a.run_id
        and r.tenant_id = a.tenant_id
        and r.config_snapshot_id is null
   );

-- ---------------------------------------------------------------------------
-- 5. claiming: one global path, one tenant-scoped path, both fenced
-- ---------------------------------------------------------------------------

-- The unscoped function is removed outright. It is the S-C1 defect: a canary
-- that meant "run my synthetic action" said "run whatever is due anywhere".
drop function if exists public.claim_scheduled_actions(integer, text, integer);

-- Shared body. Not called directly by anything outside this file's two wrappers;
-- `p_tenant` null means every tenant, which is exactly the behaviour that has to
-- be spelled out at the call site rather than defaulted into.
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
      -- a claim must never hand back an action whose run cannot prove its
      -- configuration. 'blocked' is excluded by the status test below, and this
      -- join keeps a run that lost its snapshot from slipping through.
      join public.automation_runs r
        on r.id = a.run_id and r.tenant_id = a.tenant_id
     where (p_tenant is null or a.tenant_id = p_tenant)
       and r.config_snapshot_id is not null
       and (
         (a.status = 'pending' and a.run_at <= now())
         or (a.status = 'claimed'
             and a.locked_at is not null
             and a.locked_at < now() - make_interval(secs => greatest(p_lease_seconds, 30)))
       )
       -- an action that has burned its attempts is never re-offered. 0010 let an
       -- expired lease resurrect one past its cap (S-L2).
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

-- The production dispatcher. Named so that "global" is a thing you typed.
create or replace function public.claim_scheduled_actions_global(
  p_limit         integer default 25,
  p_worker        text default 'dispatcher',
  p_lease_seconds integer default 120
)
returns setof public.scheduled_actions
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query select * from public.claim_actions_internal(
    null, p_limit, p_worker, p_lease_seconds, false
  );
end;
$fn$;

-- The canary / diagnostic path. `p_tenant` is not optional and a null one is a
-- hard error rather than a silent widening — the exact failure mode the audit
-- warned about ("do not implement an optional tenant parameter where NULL
-- silently means all tenants").
create or replace function public.claim_tenant_scheduled_actions(
  p_tenant        uuid,
  p_limit         integer default 10,
  p_worker        text default 'ops-canary',
  p_lease_seconds integer default 120,
  p_canary_only   boolean default true
)
returns setof public.scheduled_actions
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_tenant is null then
    raise exception 'claim_tenant_scheduled_actions requires an explicit tenant'
      using errcode = 'P0001';
  end if;
  return query select * from public.claim_actions_internal(
    p_tenant, p_limit, p_worker, p_lease_seconds, p_canary_only
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. fenced mutation
-- ---------------------------------------------------------------------------

-- Every worker state change goes through one of these two, and both require
-- (action, tenant, lease_token). A stale worker matches zero rows and gets
-- `false` back — which the store turns into a typed lost-lease result rather
-- than treating it as success.

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
         lease_token  = null
   where id = p_action
     and tenant_id = p_tenant
     and lease_token = p_lease
     and status = 'claimed';

  get diagnostics v_rows = row_count;
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
         lease_token = null
   where id = p_action
     and tenant_id = p_tenant
     and lease_token = p_lease
     and status = 'claimed';

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. effect reservation
-- ---------------------------------------------------------------------------

-- The atomic step between "this action is authorised" and "call Twilio".
--
-- Returns the attempt row plus `reserved`: true means this caller owns the
-- effect and may call the provider. False means somebody else already does, or
-- already did, and the caller must not send.
--
-- A retry is allowed only from a state that proves the provider never accepted
-- the message: rejected, failed_retryable, cancelled_before_send. Every
-- ambiguous state — dispatching, accepted, confirmed, outcome_unknown,
-- reconciliation_required — refuses, which is the behaviour that turns a
-- duplicate text into an operator task.

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
  v_row public.lead_recovery_effect_attempts%rowtype;
begin
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

-- Advancing an attempt. Fenced on the lease that reserved it, so a worker whose
-- lease expired mid-dispatch cannot record an outcome for a reservation another
-- worker has since taken over.
create or replace function public.settle_lead_recovery_effect(
  p_attempt   uuid,
  p_tenant    uuid,
  p_lease     uuid,
  p_state     text,
  p_provider_message_id text default null,
  p_error_category text default null,
  p_error_detail text default null,
  p_retryable boolean default null,
  p_now       timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows integer;
begin
  update public.lead_recovery_effect_attempts
     set state               = p_state,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         error_category      = p_error_category,
         error_detail        = p_error_detail,
         retryable           = p_retryable,
         dispatch_started_at = case when p_state = 'dispatching'
                                    then coalesce(dispatch_started_at, p_now)
                                    else dispatch_started_at end,
         accepted_at         = case when p_state in ('accepted', 'confirmed')
                                    then coalesce(accepted_at, p_now)
                                    else accepted_at end,
         completed_at        = case when p_state in ('confirmed', 'rejected',
                                                     'failed_terminal', 'cancelled_before_send')
                                    then p_now else completed_at end
   where id = p_attempt
     and tenant_id = p_tenant
     and lease_token = p_lease;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$fn$;

-- Provider callbacks arrive without a lease — they are not workers. They are
-- fenced on the provider reference instead, which only the provider knows, and
-- they may only move an attempt forward along the delivery axis.
create or replace function public.record_lead_recovery_delivery(
  p_tenant   uuid,
  p_provider_message_id text,
  p_state    text,
  p_error_category text default null,
  p_error_detail text default null,
  p_now      timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows integer;
begin
  if p_state not in ('confirmed', 'failed_terminal', 'accepted') then
    raise exception 'record_lead_recovery_delivery: % is not a delivery state', p_state
      using errcode = 'P0001';
  end if;

  update public.lead_recovery_effect_attempts
     set state          = p_state,
         error_category = coalesce(p_error_category, error_category),
         error_detail   = coalesce(p_error_detail, error_detail),
         completed_at   = case when p_state in ('confirmed', 'failed_terminal')
                               then p_now else completed_at end
   where tenant_id = p_tenant
     and provider_message_id = p_provider_message_id
     -- a late callback cannot reopen a settled attempt, and a duplicate
     -- callback for an already-confirmed attempt is a no-op rather than a churn.
     and state <> p_state
     and state not in ('rejected', 'cancelled_before_send');

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------

alter table public.lead_recovery_config_snapshots enable row level security;
alter table public.lead_recovery_effect_attempts  enable row level security;

-- Operator-readable only. Neither table is client-facing: a snapshot carries the
-- tenant's whole rule set including staff numbers, and an attempt carries a
-- destination reference. 0010's client-visible tables stop at leads and messages
-- and that line is not moved here.
drop policy if exists lead_recovery_config_snapshots_admin_read
  on public.lead_recovery_config_snapshots;
create policy lead_recovery_config_snapshots_admin_read
  on public.lead_recovery_config_snapshots
  for select to authenticated using (public.is_arc_admin());

drop policy if exists lead_recovery_effect_attempts_admin_read
  on public.lead_recovery_effect_attempts;
create policy lead_recovery_effect_attempts_admin_read
  on public.lead_recovery_effect_attempts
  for select to authenticated using (public.is_arc_admin());

-- As in 0010: no insert, update or delete policy for any role. The absence is
-- the write protection. Only the service role, which means only an edge
-- function, writes these tables.

-- ---------------------------------------------------------------------------
-- 9. function privileges
-- ---------------------------------------------------------------------------

-- A browser holding an anon key or a signed-in client session must not be able
-- to claim work, close an action out, reserve a send, or forge a delivery. 0010
-- revoked the claim function; every worker RPC added here gets the same
-- treatment, and `claim_actions_internal` is additionally kept away from every
-- caller but its two wrappers.

revoke all on function public.claim_actions_internal(uuid, integer, text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.claim_scheduled_actions_global(integer, text, integer)
  from public, anon, authenticated;
revoke all on function public.claim_tenant_scheduled_actions(uuid, integer, text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.complete_scheduled_action(uuid, uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.reschedule_scheduled_action(uuid, uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.reserve_lead_recovery_effect(uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function public.settle_lead_recovery_effect(uuid, uuid, uuid, text, text, text, text, boolean, timestamptz)
  from public, anon, authenticated;
revoke all on function public.record_lead_recovery_delivery(uuid, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.lead_recovery_snapshots_are_immutable()
  from public, anon, authenticated;
revoke all on function public.lead_recovery_effect_attempts_touch()
  from public, anon, authenticated;
