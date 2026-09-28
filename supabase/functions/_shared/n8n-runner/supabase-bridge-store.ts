/**
 * The production adapter for the runner bridge (0018). Every write is one RPC — each is a
 * decision taken under a row lock — and the two reads are plain selects by the service
 * role. The database's refusals arrive as `arc_bridge:<code>: …` and become `BridgeError`.
 */

import {
  type AttemptLease,
  BridgeError,
  type BridgeStore,
  type CallbackRecord,
  type Dispatch,
  type DispatchAttribution,
  type LogEntry,
  type NewDispatch,
  parseBridgeError,
  type VoidResult,
  type WorkflowRoute,
} from './store.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

function raise(what: string, error: { message?: string } | null): never {
  const parsed = parseBridgeError(error?.message);
  if (parsed) throw parsed;
  throw new Error(`${what}: ${error?.message ?? 'unknown database error'}`);
}

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);

// deno-lint-ignore no-explicit-any
const first = (data: any) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

// deno-lint-ignore no-explicit-any
const toDispatch = (row: any): Dispatch => ({
  attemptId: row.attempt_id,
  tenantId: row.tenant_id,
  actionId: row.action_id,
  runId: row.run_id,
  runnerKind: row.runner_kind,
  runnerKey: row.runner_key,
  workflowVersion: row.workflow_version,
  nonce: row.nonce,
  issuedAt: iso(row.issued_at) ?? '',
  expiresAt: iso(row.expires_at) ?? '',
  runnerExecutionId: row.runner_execution_id ?? null,
  envelopeOpenedAt: iso(row.envelope_opened_at),
  voidedAt: iso(row.voided_at),
  voidReason: row.void_reason ?? null,
  callbackDigest: row.callback_digest ?? null,
  assignmentId: row.assignment_id ?? null,
  workflowChecksum: row.workflow_checksum ?? null,
  errorHandlerKey: row.error_handler_key ?? null,
  errorHandlerVersion: row.error_handler_version ?? null,
  autoRetry: row.auto_retry ?? null,
});

export function supabaseBridgeStore(db: Db): BridgeStore {
  const scalar = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) raise(fn, error);
    const value = first(data);
    return value && typeof value === 'object' ? Object.values(value)[0] : value;
  };

  return {
    async resolveWorkflow(moduleKey, moduleVersion, actionType, environment): Promise<WorkflowRoute> {
      const { data, error } = await db.rpc('resolve_runner_workflow', {
        p_module_key: moduleKey, p_module_version: moduleVersion, p_action_type: actionType, p_environment: environment,
      });
      if (error) raise('workflow resolve', error);
      const row = first(data);
      if (!row) throw new BridgeError('workflow_unresolved', 'resolve_runner_workflow returned nothing');
      return {
        code: row.code, assignmentId: row.assignment_id ?? null, runnerKey: row.runner_key ?? null,
        workflowVersion: row.workflow_version ?? null, webhookUrl: row.webhook_url ?? null,
      };
    },

    async recordDispatch(input: NewDispatch): Promise<DispatchAttribution> {
      const { data, error } = await db.rpc('record_runner_dispatch', {
        p_attempt: input.attemptId,
        p_tenant: input.tenantId,
        p_runner_kind: input.runnerKind,
        p_assignment: input.assignmentId,
        p_environment: input.environment,
        p_nonce: input.nonce,
        p_expires_at: input.expiresAt,
      });
      if (error) raise('dispatch record', error);
      const row = first(data);
      if (!row) throw new BridgeError('dispatch_not_recorded', 'record_runner_dispatch returned nothing');
      return { runnerKey: row.runner_key, workflowVersion: row.workflow_version, workflowChecksum: row.workflow_checksum };
    },

    async correlate(attemptId, tenantId, executionId) {
      return await scalar('correlate_runner_dispatch', { p_attempt: attemptId, p_tenant: tenantId, p_execution_id: executionId }) as
        'ok' | 'duplicate' | 'conflict' | 'not_found';
    },

    async voidDispatch(attemptId, tenantId, reason) {
      return await scalar('void_runner_dispatch', { p_attempt: attemptId, p_tenant: tenantId, p_reason: reason }) as VoidResult;
    },

    async getDispatch(attemptId) {
      const { data, error } = await db.from('runner_dispatches').select('*').eq('attempt_id', attemptId).maybeSingle();
      if (error) raise('dispatch read', error);
      return data ? toDispatch(data) : null;
    },

    async getAttemptLease(attemptId, tenantId): Promise<AttemptLease | null> {
      const { data, error } = await db.from('automation_action_attempts')
        .select('id, tenant_id, action_id, run_id, attempt_no, status, lease_token')
        .eq('id', attemptId).eq('tenant_id', tenantId).maybeSingle();
      if (error) raise('attempt read', error);
      return data ? {
        attemptId: data.id, tenantId: data.tenant_id, actionId: data.action_id, runId: data.run_id,
        attemptNo: Number(data.attempt_no), status: data.status, leaseToken: data.lease_token,
      } : null;
    },

    async claimNonce(nonce, purpose, ttlSeconds) {
      return await scalar('claim_runner_nonce', { p_nonce: nonce, p_purpose: purpose, p_ttl_seconds: ttlSeconds }) === true;
    },

    async openEnvelope(input) {
      const { data, error } = await db.rpc('open_runner_envelope', {
        p_attempt: input.attemptId, p_tenant: input.tenantId, p_action: input.actionId, p_nonce: input.nonce,
      });
      if (error) raise('envelope open', error);
      const row = first(data);
      if (!row) throw new BridgeError('envelope_unanswered', 'open_runner_envelope returned nothing');
      return { code: row.code, detail: row.detail ?? null };
    },

    async recordCallback(input: CallbackRecord) {
      return String(await scalar('record_runner_callback', {
        p_attempt: input.attemptId,
        p_tenant: input.tenantId,
        p_action: input.actionId,
        p_attempt_no: input.attemptNo,
        p_idempotency_key: input.idempotencyKey,
        p_runner_key: input.runnerKey,
        p_workflow_version: input.workflowVersion,
        p_digest: input.digest,
        p_callback: input.callback,
      }));
    },

    async log(entry: LogEntry) {
      const { error } = await db.rpc('log_runner_bridge_event', {
        p_tenant: entry.tenantId,
        p_attempt: entry.attemptId,
        p_direction: entry.direction,
        p_disposition: entry.disposition,
        p_code: entry.code,
        p_alert: entry.alert,
        p_detail: entry.detail,
        p_digest: entry.bodyDigest,
      });
      if (error) raise('bridge log', error);
    },
  };
}
