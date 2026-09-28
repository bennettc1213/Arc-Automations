-- ===========================================================================
-- 0018 — the runner bridge's ledger (ARC-220)
-- ===========================================================================
--
-- ARC-210 gave ARC one `AutomationRunner` interface. ARC-220 adds the first runner that
-- answers later instead of at once: a signed dispatch leaves ARC, the backend fetches a
-- sanitized envelope with a signed request, and reports back with a signed callback
-- (ADR ARC-010 §15, §18, §19). None of that may live only in memory or in the backend's
-- own execution history, so this migration records it:
--
--   runner_dispatches   one row per dispatched attempt: the single-use nonce the dispatch
--                       was signed with, its short expiry, the runner key and workflow
--                       version it was sent to, the backend's execution id once known,
--                       whether the envelope was opened, whether the dispatch was voided,
--                       and the first callback received — the one that counts.
--   runner_nonces       every nonce presented on an inbound request, kept past the
--                       signature window so a replayed request is refused.
--   runner_bridge_log   append-only: every dispatch, envelope and callback, accepted or
--                       not, with a flag on anything a person should look at.
--
-- The rules, enforced here:
--
--   * A dispatch exists before it is sent, and only for an attempt that has started
--     under the runner it names. One dispatch per attempt.
--   * The envelope opens once, for the right tenant, action and nonce, before the
--     dispatch expires, while the attempt still runs, and only if the scheduler's gate
--     (0017) still allows the action. Anything else voids the dispatch.
--   * A voided dispatch never opens. The backend holds no credential and learns the
--     payload only from the envelope, so an attempt whose dispatch was voided before its
--     envelope opened cannot have taken effect — that is what lets ARC retry it rather
--     than leave it for a person.
--   * The first verified callback for an attempt is kept; a repeat of it is a duplicate
--     and a different one is a conflict. Nothing here settles an attempt: the callback
--     handler settles it through 0017's `settle_automation_attempt`, under the lease.
--
-- The production n8n runner stays disabled (ADR §26); this ledger is what a staging or
-- local bridge writes, and what a production one will write once the gate is closed.
--
-- No browser role, on any of it. Forward-only: nothing is dropped but triggers and
-- policies being replaced.

-- ---------------------------------------------------------------------------
-- 1. dispatches
-- ---------------------------------------------------------------------------

create table if not exists public.runner_dispatches (
  attempt_id           uuid primary key,
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  action_id            uuid not null,
  run_id               uuid not null,
  runner_kind          text not null check (runner_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- ARC's stable name for the workflow and its immutable version — never a backend's id.
  runner_key           text not null check (runner_key ~ '^[a-z][a-z0-9-]{2,80}$'),
  workflow_version     text not null check (workflow_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  nonce                uuid not null unique,
  issued_at            timestamptz not null default now(),
  expires_at           timestamptz not null,

  runner_execution_id  text check (runner_execution_id is null or char_length(runner_execution_id) between 1 and 200),
  correlated_at        timestamptz,
  envelope_opened_at   timestamptz,
  voided_at            timestamptz,
  void_reason          text check (void_reason is null or void_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- the digest of the first callback's outcome (status, category, retryability, execution,
  -- provider references) — not of its bytes, so a re-sent report is a duplicate.
  callback_digest      text check (callback_digest is null or callback_digest ~ '^[0-9a-f]{64}$'),
  callback_received_at timestamptz,
  callback             jsonb check (callback is null or jsonb_typeof(callback) = 'object'),

  unique (attempt_id, tenant_id),

  -- minutes, not hours (§18).
  constraint runner_dispatches_window check (expires_at > issued_at and expires_at <= issued_at + interval '15 minutes'),
  constraint runner_dispatches_open_or_void check (envelope_opened_at is null or voided_at is null),
  constraint runner_dispatches_void_reason check ((voided_at is null) = (void_reason is null)),
  constraint runner_dispatches_correlated check ((runner_execution_id is null) = (correlated_at is null)),
  constraint runner_dispatches_callback_whole check (
    (callback is null) = (callback_digest is null) and (callback is null) = (callback_received_at is null)
  ),
  constraint runner_dispatches_no_secrets check (callback is null or not public.scheduler_secret_shaped(callback::text)),

  foreign key (attempt_id, tenant_id)
    references public.automation_action_attempts (id, tenant_id) on delete cascade,
  foreign key (action_id, tenant_id)
    references public.scheduled_actions (id, tenant_id) on delete cascade,
  foreign key (run_id, tenant_id)
    references public.automation_runs (id, tenant_id) on delete cascade
);

create index if not exists runner_dispatches_action_idx on public.runner_dispatches (tenant_id, action_id, issued_at desc);

-- Identity never moves; everything else is written once, from null.
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
      new.workflow_version, new.nonce, new.issued_at, new.expires_at)
     is distinct from
     (old.attempt_id, old.tenant_id, old.action_id, old.run_id, old.runner_kind, old.runner_key,
      old.workflow_version, old.nonce, old.issued_at, old.expires_at) then
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

drop trigger if exists runner_dispatches_guard on public.runner_dispatches;
create trigger runner_dispatches_guard
  before insert or update or delete on public.runner_dispatches
  for each row execute function public.runner_dispatches_guard();

-- ---------------------------------------------------------------------------
-- 2. nonces
-- ---------------------------------------------------------------------------

create table if not exists public.runner_nonces (
  nonce      text primary key check (nonce ~ '^[A-Za-z0-9_-]{16,100}$'),
  purpose    text not null check (purpose in ('envelope', 'callback')),
  seen_at    timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint runner_nonces_ttl check (expires_at > seen_at)
);

create index if not exists runner_nonces_expiry_idx on public.runner_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- 3. the log
-- ---------------------------------------------------------------------------

create table if not exists public.runner_bridge_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  -- set only once the request was tied to a tenant by ARC's own rows, never by its body.
  tenant_id    uuid references public.tenants(id) on delete cascade,
  attempt_id   uuid,
  direction    text not null check (direction in ('dispatch', 'envelope', 'callback')),
  disposition  text not null check (disposition in ('accepted', 'applied', 'duplicate', 'late', 'conflict', 'rejected', 'voided')),
  code         text not null check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- a person should look: a security event (a bad signature, a replay, another tenant's
  -- job) or a contradiction (a conflicting callback, a version ARC did not dispatch).
  alert        boolean not null default false,
  detail       text check (detail is null or (char_length(detail) <= 300 and not public.scheduler_secret_shaped(detail))),
  body_digest  text check (body_digest is null or body_digest ~ '^[0-9a-f]{64}$')
);

create index if not exists runner_bridge_log_tenant_idx on public.runner_bridge_log (tenant_id, at desc);
create index if not exists runner_bridge_log_alert_idx on public.runner_bridge_log (at desc) where alert;

create or replace function public.runner_bridge_log_append_only()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'arc_bridge:log_append_only: the bridge log is only ever appended to' using errcode = 'P0001';
end;
$fn$;

drop trigger if exists runner_bridge_log_append_only on public.runner_bridge_log;
create trigger runner_bridge_log_append_only
  before update or delete on public.runner_bridge_log
  for each row execute function public.runner_bridge_log_append_only();

-- ---------------------------------------------------------------------------
-- 4. writing a dispatch — before it is sent
-- ---------------------------------------------------------------------------

create or replace function public.record_runner_dispatch(
  p_attempt          uuid,
  p_tenant           uuid,
  p_runner_kind      text,
  p_runner_key       text,
  p_workflow_version text,
  p_nonce            uuid,
  p_expires_at       timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_attempt public.automation_action_attempts;
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

  insert into public.runner_dispatches (attempt_id, tenant_id, action_id, run_id, runner_kind, runner_key, workflow_version, nonce, expires_at)
  values (p_attempt, p_tenant, v_attempt.action_id, v_attempt.run_id, p_runner_kind, p_runner_key, p_workflow_version, p_nonce, p_expires_at);

  insert into public.runner_bridge_log (tenant_id, attempt_id, direction, disposition, code)
  values (p_tenant, p_attempt, 'dispatch', 'accepted', 'dispatch_recorded');
end;
$fn$;

-- The backend's execution id, once. A different second answer is a conflict, not an update.
create or replace function public.correlate_runner_dispatch(p_attempt uuid, p_tenant uuid, p_execution_id text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_existing text;
begin
  update public.runner_dispatches d
     set runner_execution_id = p_execution_id, correlated_at = now()
   where d.attempt_id = p_attempt and d.tenant_id = p_tenant and d.runner_execution_id is null;
  if found then
    return 'ok';
  end if;
  select d.runner_execution_id into v_existing from public.runner_dispatches d
   where d.attempt_id = p_attempt and d.tenant_id = p_tenant;
  if not found then
    return 'not_found';
  end if;
  return case when v_existing = p_execution_id then 'duplicate' else 'conflict' end;
end;
$fn$;

-- Void a dispatch whose envelope has not opened: after this it never will, so the attempt
-- provably took no effect. Returns voided, already_void, envelope_opened or not_found.
create or replace function public.void_runner_dispatch(p_attempt uuid, p_tenant uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.runner_dispatches;
begin
  if p_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'arc_bridge:invalid_code: a void reason is a lower-case code' using errcode = 'P0001';
  end if;
  select * into v_row from public.runner_dispatches d
   where d.attempt_id = p_attempt and d.tenant_id = p_tenant
     for update;
  if not found then
    return 'not_found';
  end if;
  if v_row.voided_at is not null then
    return 'already_void';
  end if;
  if v_row.envelope_opened_at is not null then
    return 'envelope_opened';
  end if;
  update public.runner_dispatches set voided_at = now(), void_reason = p_reason where attempt_id = p_attempt;
  insert into public.runner_bridge_log (tenant_id, attempt_id, direction, disposition, code)
  values (p_tenant, p_attempt, 'dispatch', 'voided', p_reason);
  return 'voided';
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. the envelope — once, and only while everything still allows it
-- ---------------------------------------------------------------------------

-- The tenant is ARC's, read from the dispatch; the one the caller named is compared, never
-- trusted. A refusal after the caller proved who it is voids the dispatch, so a late or
-- repeated attempt to open it gets nothing either.
create or replace function public.open_runner_envelope(p_attempt uuid, p_tenant uuid, p_action uuid, p_nonce uuid)
returns table (code text, detail text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row     public.runner_dispatches;
  v_attempt public.automation_action_attempts;
  v_action  public.scheduled_actions;
  v_gate    record;
  v_code    text;
  v_detail  text;
begin
  select * into v_row from public.runner_dispatches d where d.attempt_id = p_attempt for update;
  if not found then
    return query select 'unknown_job', 'no dispatch has this job id';
    return;
  end if;
  if v_row.tenant_id <> p_tenant then
    return query select 'tenant_mismatch', 'the job belongs to another tenant';
    return;
  end if;
  if v_row.action_id <> p_action then
    return query select 'action_mismatch', 'the job is for another action';
    return;
  end if;
  if v_row.nonce <> p_nonce then
    return query select 'nonce_mismatch', 'the nonce is not the one this job was dispatched with';
    return;
  end if;
  if v_row.voided_at is not null then
    return query select 'dispatch_void', v_row.void_reason;
    return;
  end if;
  if v_row.envelope_opened_at is not null then
    return query select 'envelope_already_opened', 'an envelope is handed over once';
    return;
  end if;

  select * into v_attempt from public.automation_action_attempts p where p.id = p_attempt and p.tenant_id = p_tenant;
  select * into v_action from public.scheduled_actions a where a.id = v_row.action_id and a.tenant_id = p_tenant for update;

  if v_row.expires_at <= now() then
    v_code := 'dispatch_expired';
    v_detail := 'the dispatch expired before its envelope was fetched';
  elsif v_attempt.status <> 'running' or v_action.status <> 'running' or v_action.lease_token is distinct from v_attempt.lease_token then
    v_code := 'attempt_not_running';
    v_detail := format('the attempt is %s', v_attempt.status);
  else
    select * into v_gate from public.scheduler_action_gate(v_action);
    if v_gate.verdict <> 'claim' then
      v_code := 'gate_refused';
      v_detail := left(v_gate.code || ': ' || coalesce(v_gate.detail, ''), 300);
    end if;
  end if;

  if v_code is not null then
    update public.runner_dispatches set voided_at = now(), void_reason = v_code where attempt_id = p_attempt;
    return query select v_code, v_detail;
    return;
  end if;

  update public.runner_dispatches set envelope_opened_at = now() where attempt_id = p_attempt;
  return query select 'ok', null::text;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. the callback — the first one counts
-- ---------------------------------------------------------------------------

-- Returns first, duplicate or conflict when the callback is ARC's to hear, or the reason
-- it is not: unknown_job, tenant_mismatch, action_mismatch, attempt_mismatch,
-- idempotency_mismatch, version_mismatch.
create or replace function public.record_runner_callback(
  p_attempt          uuid,
  p_tenant           uuid,
  p_action           uuid,
  p_attempt_no       integer,
  p_idempotency_key  text,
  p_runner_key       text,
  p_workflow_version text,
  p_digest           text,
  p_callback         jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row     public.runner_dispatches;
  v_attempt public.automation_action_attempts;
  v_key     text;
begin
  select * into v_row from public.runner_dispatches d where d.attempt_id = p_attempt for update;
  if not found then
    return 'unknown_job';
  end if;
  if v_row.tenant_id <> p_tenant then
    return 'tenant_mismatch';
  end if;
  if v_row.action_id <> p_action then
    return 'action_mismatch';
  end if;
  select * into v_attempt from public.automation_action_attempts p where p.id = p_attempt and p.tenant_id = p_tenant;
  if v_attempt.attempt_no <> p_attempt_no then
    return 'attempt_mismatch';
  end if;
  select a.idempotency_key into v_key from public.scheduled_actions a where a.id = v_row.action_id and a.tenant_id = p_tenant;
  if v_key is distinct from p_idempotency_key then
    return 'idempotency_mismatch';
  end if;
  if v_row.runner_key <> p_runner_key or v_row.workflow_version <> p_workflow_version then
    return 'version_mismatch';
  end if;

  if v_row.callback_digest is null then
    update public.runner_dispatches
       set callback = p_callback, callback_digest = p_digest, callback_received_at = now()
     where attempt_id = p_attempt;
    return 'first';
  end if;
  return case when v_row.callback_digest = p_digest then 'duplicate' else 'conflict' end;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. nonces and the log
-- ---------------------------------------------------------------------------

-- True the first time a nonce is presented, false on any replay. Nonces older than their
-- expiry are pruned; the expiry outlives the signature window, so a pruned nonce's request
-- is already refused for its timestamp.
create or replace function public.claim_runner_nonce(p_nonce text, p_purpose text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows integer;
begin
  if p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'arc_bridge:invalid_request: a nonce is kept for 60 seconds to a day' using errcode = 'P0001';
  end if;
  delete from public.runner_nonces n where n.expires_at < now();
  insert into public.runner_nonces (nonce, purpose, expires_at)
  values (p_nonce, p_purpose, now() + make_interval(secs => p_ttl_seconds))
  on conflict (nonce) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$fn$;

-- A tenant is recorded only if it exists: an unverified body can name any uuid.
create or replace function public.log_runner_bridge_event(
  p_tenant      uuid,
  p_attempt     uuid,
  p_direction   text,
  p_disposition text,
  p_code        text,
  p_alert       boolean,
  p_detail      text,
  p_digest      text
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.runner_bridge_log (tenant_id, attempt_id, direction, disposition, code, alert, detail, body_digest)
  values (
    (select t.id from public.tenants t where t.id = p_tenant),
    p_attempt, p_direction, p_disposition, p_code, coalesce(p_alert, false),
    public.scheduler_safe_text(p_detail, 300), p_digest
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------

-- Operators read everything; nobody else reads anything, and no role has a write policy.
alter table public.runner_dispatches  enable row level security;
alter table public.runner_nonces      enable row level security;
alter table public.runner_bridge_log  enable row level security;

drop policy if exists runner_dispatches_admin_read on public.runner_dispatches;
create policy runner_dispatches_admin_read on public.runner_dispatches
  for select to authenticated using (public.is_arc_admin());

drop policy if exists runner_bridge_log_admin_read on public.runner_bridge_log;
create policy runner_bridge_log_admin_read on public.runner_bridge_log
  for select to authenticated using (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- 9. privileges
-- ---------------------------------------------------------------------------

revoke all on function public.runner_dispatches_guard() from public, anon, authenticated;
revoke all on function public.runner_bridge_log_append_only() from public, anon, authenticated;
revoke all on function public.record_runner_dispatch(uuid, uuid, text, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.correlate_runner_dispatch(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.void_runner_dispatch(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.open_runner_envelope(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_runner_callback(uuid, uuid, uuid, integer, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_runner_nonce(text, text, integer) from public, anon, authenticated;
revoke all on function public.log_runner_bridge_event(uuid, uuid, text, text, text, boolean, text, text) from public, anon, authenticated;

-- the bridge surface: the service role, which means the worker and the bridge function.
grant execute on function public.record_runner_dispatch(uuid, uuid, text, text, text, uuid, timestamptz) to service_role;
grant execute on function public.correlate_runner_dispatch(uuid, uuid, text) to service_role;
grant execute on function public.void_runner_dispatch(uuid, uuid, text) to service_role;
grant execute on function public.open_runner_envelope(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.record_runner_callback(uuid, uuid, uuid, integer, text, text, text, text, jsonb) to service_role;
grant execute on function public.claim_runner_nonce(text, text, integer) to service_role;
grant execute on function public.log_runner_bridge_event(uuid, uuid, text, text, text, boolean, text, text) to service_role;
