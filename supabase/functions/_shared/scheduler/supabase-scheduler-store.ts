/**
 * The production adapter for ARC-200's scheduler (0017).
 *
 * Every column is named explicitly in both directions — the ARC-015B defect was an insert
 * that left one out. Runs are inserted directly (0013–0017's triggers validate and stamp
 * them); every action write is an RPC, because each one is a decision made under a row
 * lock and must not be split across requests. The database's refusals arrive as
 * `arc_scheduler:<code>: …` (or `arc_lifecycle:<code>: …`) and become `SchedulerError`.
 */

import {
  type ActionAttempt,
  type ActionLease,
  type AutomationAction,
  type AutomationRun,
  parseSchedulerError,
  SchedulerError,
} from './model.ts';
import type { FinishResult, NewAction, NewRun, SchedulerStore, SettleResult, Settlement, StartResult } from './store.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

/**
 * A refusal the database made on purpose becomes a `SchedulerError`: our own coded ones,
 * the pin guards 0011/0013 wrote before codes existed, a reference to another tenant's row
 * (a composite foreign key), and a check constraint (the secret-shaped refusals among
 * them). Anything else is a real failure, named after what was attempted.
 */
function raise(what: string, error: { message?: string; code?: string | null } | null): never {
  const message = error?.message ?? 'unknown database error';
  const parsed = parseSchedulerError(message);
  if (parsed) throw parsed;
  if (/^(automation_runs|scheduled_actions): /.test(message)) throw new SchedulerError('guard_refused', message);
  if (error?.code === '23503') throw new SchedulerError('reference_invalid', message);
  if (error?.code === '23514') throw new SchedulerError('constraint_refused', message);
  throw new Error(`${what}: ${message}`);
}

/** supabase-js returns timestamps as strings; a driver may return Dates. */
const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
const isoRequired = (value: unknown): string => iso(value) ?? '';

// deno-lint-ignore no-explicit-any
export const toRun = (row: any): AutomationRun => ({
  id: row.id,
  tenantId: row.tenant_id,
  runKind: row.run_kind,
  moduleKey: row.module_key,
  moduleVersion: row.module_version ?? null,
  leadId: row.lead_id ?? null,
  configSnapshotId: row.config_snapshot_id ?? null,
  runMode: row.run_mode ?? null,
  lifecycleStateAtStart: row.lifecycle_state_at_start ?? null,
  runnerKind: row.runner_kind ?? null,
  status: row.status,
  statusReason: row.status_reason ?? null,
  terminalCode: row.terminal_code ?? null,
  correlationId: row.correlation_id ?? null,
  idempotencyKey: row.idempotency_key ?? null,
  createdByType: row.created_by_type,
  createdBy: row.created_by ?? null,
  createdAt: isoRequired(row.created_at),
  startedAt: iso(row.started_at),
  completedAt: iso(row.completed_at),
  updatedAt: isoRequired(row.updated_at),
});

// deno-lint-ignore no-explicit-any
export const toAction = (row: any): AutomationAction => ({
  id: row.id,
  tenantId: row.tenant_id,
  runId: row.run_id,
  moduleKey: row.module_key,
  actionType: row.action_type,
  scheduledFor: isoRequired(row.scheduled_for),
  runAt: isoRequired(row.run_at),
  status: row.status,
  idempotencyKey: row.idempotency_key,
  attempts: Number(row.attempts ?? 0),
  maxAttempts: Number(row.max_attempts ?? 0),
  lockedBy: row.locked_by ?? null,
  leaseToken: row.lease_token ?? null,
  leaseExpiresAt: iso(row.lease_expires_at),
  fence: Number(row.fence ?? 0),
  connectorKey: row.connector_key ?? null,
  connectionId: row.connection_id ?? null,
  payload: row.payload ?? {},
  configSnapshotId: row.config_snapshot_id ?? null,
  gate: row.gate_code ? { code: row.gate_code, detail: row.gate_detail ?? null, checkedAt: iso(row.gate_checked_at) } : null,
  lastError: row.last_error ?? null,
  createdAt: isoRequired(row.created_at),
  updatedAt: isoRequired(row.updated_at),
  completedAt: iso(row.completed_at),
});

// deno-lint-ignore no-explicit-any
export const toAttempt = (row: any): ActionAttempt => ({
  id: row.id,
  tenantId: row.tenant_id,
  actionId: row.action_id,
  runId: row.run_id,
  attemptNo: Number(row.attempt_no),
  worker: row.worker,
  runnerKind: row.runner_kind ?? null,
  status: row.status,
  claimedAt: isoRequired(row.claimed_at),
  leaseExpiresAt: iso(row.lease_expires_at),
  startedAt: iso(row.started_at),
  completedAt: iso(row.completed_at),
  errorCode: row.error_code ?? null,
  errorMessage: row.error_message ?? null,
  externalRequestId: row.external_request_id ?? null,
  runnerExecutionId: row.runner_execution_id ?? null,
  ambiguous: row.ambiguous === true,
  retryable: row.retryable ?? null,
  evidence: row.evidence ?? {},
  evidenceRef: row.evidence_ref ?? null,
  reconciliation: row.reconciliation ?? null,
  reconciledBy: row.reconciled_by ?? null,
  reconciledAt: iso(row.reconciled_at),
});

/** A single-row RPC result, whichever way the client shaped it. */
// deno-lint-ignore no-explicit-any
const first = (data: any) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

export function supabaseSchedulerStore(db: Db): SchedulerStore {
  const store: SchedulerStore = {
    async createRun(input: NewRun) {
      const { data, error } = await db
        .from('automation_runs')
        .insert({
          tenant_id: input.tenantId,
          run_kind: input.runKind,
          module_key: input.moduleKey,
          config_snapshot_id: input.configSnapshotId,
          run_mode: input.runMode,
          correlation_id: input.correlationId,
          idempotency_key: input.idempotencyKey,
          runner_kind: input.runnerKind,
          created_by_type: input.createdBy.type,
          created_by: input.createdBy.id,
          // a run with no lead has not started; the database sets status and module version.
          lead_id: null,
          started_at: null,
        })
        .select('*')
        .single();
      if (!error) return { run: toRun(data), created: true };
      if (error.code !== '23505') raise('run insert', error);

      /* the key is taken: the same logical run, or a conflict. */
      const existing = await store.getRunByKey(input.tenantId, input.idempotencyKey);
      if (!existing) raise('run insert', error);
      if (existing.runKind !== input.runKind || existing.moduleKey !== input.moduleKey
          || existing.configSnapshotId !== input.configSnapshotId || existing.runMode !== input.runMode) {
        throw new SchedulerError('idempotency_conflict', 'that idempotency key already names a different run');
      }
      return { run: existing, created: false };
    },

    async getRun(tenantId, runId) {
      const { data, error } = await db.from('automation_runs').select('*').eq('tenant_id', tenantId).eq('id', runId).maybeSingle();
      if (error) raise('run read', error);
      return data ? toRun(data) : null;
    },

    async getRunByKey(tenantId, idempotencyKey) {
      const { data, error } = await db.from('automation_runs').select('*')
        .eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (error) raise('run read by key', error);
      return data ? toRun(data) : null;
    },

    async scheduleAction(input: NewAction) {
      const { data, error } = await db.rpc('schedule_automation_action', {
        p_tenant: input.tenantId,
        p_run: input.runId,
        p_action_type: input.actionType,
        p_run_at: input.runAt,
        p_idempotency_key: input.idempotencyKey,
        p_payload: input.payload,
        p_max_attempts: input.maxAttempts,
        p_connection: input.connectionId,
      });
      if (error) raise('schedule action', error);
      const row = first(data);
      const action = await store.getAction(input.tenantId, row.action_id);
      if (!action) throw new Error('schedule action: the action it returned cannot be read back');
      return { action, created: row.created === true };
    },

    async getAction(tenantId, actionId) {
      const { data, error } = await db.from('scheduled_actions').select('*').eq('tenant_id', tenantId).eq('id', actionId).maybeSingle();
      if (error) raise('action read', error);
      return data ? toAction(data) : null;
    },

    async claimActions({ tenantId, limit, worker, leaseSeconds }) {
      const { data, error } = tenantId === null
        ? await db.rpc('claim_automation_actions_global', { p_limit: limit, p_worker: worker, p_lease_seconds: leaseSeconds })
        : await db.rpc('claim_tenant_automation_actions', { p_tenant: tenantId, p_limit: limit, p_worker: worker, p_lease_seconds: leaseSeconds });
      if (error) raise('claim actions', error);
      return (data ?? []).map(toAction);
    },

    async startAttempt(lease: ActionLease, runnerKind): Promise<StartResult> {
      const { data, error } = await db.rpc('start_automation_attempt', {
        p_action: lease.actionId,
        p_tenant: lease.tenantId,
        p_lease: lease.leaseToken,
        p_runner_kind: runnerKind,
      });
      if (error) raise('start attempt', error);
      const row = first(data);
      return {
        started: row?.started === true,
        code: row?.code ?? 'unknown',
        detail: row?.detail ?? null,
        attemptId: row?.attempt_id ?? null,
        attemptNo: row?.attempt_number ?? null,
      };
    },

    async settleAttempt(lease: ActionLease, s: Settlement): Promise<SettleResult> {
      const { data, error } = await db.rpc('settle_automation_attempt', {
        p_action: lease.actionId,
        p_tenant: lease.tenantId,
        p_lease: lease.leaseToken,
        p_outcome: s.outcome,
        p_error_code: s.errorCode,
        p_error_message: s.errorMessage,
        p_retryable: s.retryable,
        p_external_request_id: s.externalRequestId,
        p_runner_execution_id: s.runnerExecutionId,
        p_evidence: s.evidence,
        p_evidence_ref: s.evidenceRef,
        p_retry_at: s.retryAt,
      });
      if (error) raise('settle attempt', error);
      const row = first(data);
      return {
        settled: row?.settled === true,
        code: row?.code ?? 'unknown',
        actionStatus: row?.action_status ?? null,
        nextRunAt: iso(row?.next_run_at),
      };
    },

    async resolveAmbiguous({ tenantId, actionId, resolution, actorId, note }) {
      const { data, error } = await db.rpc('resolve_ambiguous_automation_action', {
        p_tenant: tenantId, p_action: actionId, p_resolution: resolution, p_actor: actorId, p_note: note,
      });
      if (error) raise('resolve ambiguous action', error);
      return String(data);
    },

    async setRunStatus({ tenantId, runId, status, code, reason, actor }) {
      const { data, error } = await db.rpc('set_automation_run_status', {
        p_tenant: tenantId, p_run: runId, p_status: status, p_code: code, p_reason: reason,
        p_actor_type: actor.type, p_actor: actor.id,
      });
      if (error) raise('set run status', error);
      return String(data);
    },

    async cancelRunActions({ tenantId, runId, reason, types }) {
      const { data, error } = await db.rpc('cancel_automation_run_actions', {
        p_tenant: tenantId, p_run: runId, p_reason: reason, p_types: types,
      });
      if (error) raise('cancel run actions', error);
      return Number(data ?? 0);
    },

    async finishRun({ tenantId, runId, status, code, reason }): Promise<FinishResult> {
      const { data, error } = await db.rpc('finish_automation_run', {
        p_tenant: tenantId, p_run: runId, p_status: status, p_code: code, p_reason: reason,
      });
      if (error) raise('finish run', error);
      const row = first(data);
      return {
        runStatus: row.run_status,
        cancelledActions: Number(row.cancelled_actions ?? 0),
        inFlightActions: Number(row.in_flight_actions ?? 0),
        ambiguousActions: Number(row.ambiguous_actions ?? 0),
      };
    },

    async listDueActions({ tenantId, asOf, limit }) {
      let query = db.from('scheduled_actions').select('*').eq('status', 'pending').lte('run_at', asOf);
      if (tenantId !== null) query = query.eq('tenant_id', tenantId);
      const { data, error } = await query.order('run_at', { ascending: true }).limit(limit);
      if (error) raise('due action list', error);
      return (data ?? []).map(toAction);
    },

    async listUpcomingActions({ tenantId, from, until, limit }) {
      let query = db.from('scheduled_actions').select('*').eq('status', 'pending').gt('run_at', from).lte('run_at', until);
      if (tenantId !== null) query = query.eq('tenant_id', tenantId);
      const { data, error } = await query.order('run_at', { ascending: true }).limit(limit);
      if (error) raise('upcoming action list', error);
      return (data ?? []).map(toAction);
    },

    async listActionsForRun(tenantId, runId) {
      const { data, error } = await db.from('scheduled_actions').select('*')
        .eq('tenant_id', tenantId).eq('run_id', runId).order('scheduled_for', { ascending: true });
      if (error) raise('run action list', error);
      return (data ?? []).map(toAction);
    },

    async listAttemptsForRun(tenantId, runId) {
      const { data, error } = await db.from('automation_action_attempts').select('*')
        .eq('tenant_id', tenantId).eq('run_id', runId).order('claimed_at', { ascending: true });
      if (error) raise('run attempt list', error);
      return (data ?? []).map(toAttempt);
    },

    async listAttemptsForAction(tenantId, actionId) {
      const { data, error } = await db.from('automation_action_attempts').select('*')
        .eq('tenant_id', tenantId).eq('action_id', actionId).order('attempt_no', { ascending: true });
      if (error) raise('action attempt list', error);
      return (data ?? []).map(toAttempt);
    },
  };
  return store;
}
