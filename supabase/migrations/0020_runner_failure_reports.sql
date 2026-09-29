-- ===========================================================================
-- 0020 — failure reports from the shared n8n error handler (ARC-240)
-- ===========================================================================
--
-- When a shared workflow's execution fails, n8n runs its error workflow
-- (arc-runner-error-handler-v1) with the failed execution's id, the failed workflow's n8n
-- id and the error — never the job it was running. The handler reports those, and ARC
-- finds the rest in its own rows: `correlate_runner_dispatch` (0018) recorded which
-- execution each accepted dispatch became. This migration adds that lookup, and lets the
-- bridge's nonce ledger and log name the new route.
--
--   resolve_runner_failure   the dispatch a failed execution was, refused when the failed
--                            workflow is not the one the dispatch's deployment (0019) names,
--                            or the reporting handler is not the one the dispatch recorded.
--
-- It creates no rows and changes no existing row. The decision about the attempt — failed,
-- retryable or ambiguous — is taken in `_shared/n8n-runner/failures.ts` and recorded
-- through 0018's `record_runner_callback`, exactly as a workflow's own callback is, so the
-- first report for an attempt still wins.
--
-- To roll back:
--   drop function if exists public.resolve_runner_failure(text, text, text, text);
--   drop index if exists public.runner_dispatches_execution;
--   (and restore the two check constraints below to 0018's lists, once no 'failure' rows exist)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. the new route in the nonce ledger and the log
-- ---------------------------------------------------------------------------

alter table public.runner_nonces drop constraint if exists runner_nonces_purpose_check;
alter table public.runner_nonces add constraint runner_nonces_purpose_check
  check (purpose in ('envelope', 'callback', 'failure'));

alter table public.runner_bridge_log drop constraint if exists runner_bridge_log_direction_check;
alter table public.runner_bridge_log add constraint runner_bridge_log_direction_check
  check (direction in ('dispatch', 'envelope', 'callback', 'failure'));

-- ---------------------------------------------------------------------------
-- 2. finding a dispatch by the execution it became
-- ---------------------------------------------------------------------------

create index if not exists runner_dispatches_execution
  on public.runner_dispatches (runner_execution_id) where runner_execution_id is not null;

-- Returns ok, unknown_execution, execution_ambiguous, workflow_mismatch or handler_mismatch,
-- with the attempt and tenant when the dispatch was found. Reads only.
create or replace function public.resolve_runner_failure(
  p_execution_id    text,
  p_n8n_workflow_id text,
  p_handler_key     text,
  p_handler_version text
)
returns table (code text, attempt_id uuid, tenant_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_count    integer;
  v_dispatch public.runner_dispatches;
  v_n8n_id   text;
begin
  select count(*) into v_count from public.runner_dispatches d where d.runner_execution_id = p_execution_id;
  if v_count = 0 then
    return query select 'unknown_execution'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_count > 1 then
    return query select 'execution_ambiguous'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_dispatch from public.runner_dispatches d where d.runner_execution_id = p_execution_id;
  select w.n8n_workflow_id into v_n8n_id
    from public.runner_workflow_deployments w where w.id = v_dispatch.deployment_id;
  if v_n8n_id is null or v_n8n_id <> p_n8n_workflow_id then
    return query select 'workflow_mismatch'::text, v_dispatch.attempt_id, v_dispatch.tenant_id;
    return;
  end if;
  if v_dispatch.error_handler_key is distinct from p_handler_key
     or v_dispatch.error_handler_version is distinct from p_handler_version then
    return query select 'handler_mismatch'::text, v_dispatch.attempt_id, v_dispatch.tenant_id;
    return;
  end if;
  return query select 'ok'::text, v_dispatch.attempt_id, v_dispatch.tenant_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. privileges
-- ---------------------------------------------------------------------------

revoke all on function public.resolve_runner_failure(text, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_runner_failure(text, text, text, text) to service_role;
