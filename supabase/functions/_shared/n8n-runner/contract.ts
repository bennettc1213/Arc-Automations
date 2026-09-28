/**
 * ARC-220 — the bridge's three messages, exactly as ADR ARC-010 §18 and §19 define them.
 *
 *   dispatch   ARC → n8n. Identifiers and version references only: never configuration
 *              values, templates, credentials, a phone number or a message body.
 *   envelope   n8n → ARC → n8n. The one place the backend learns what to do: the
 *              references and the scheduler's own payload, fetched once, signed, and only
 *              while ARC still allows the action.
 *   callback   n8n → ARC. A proposal about one attempt; ARC validates it and decides.
 *
 * Every parser rejects unknown fields rather than ignoring them, and every one is a pure
 * function over already-verified bytes: signatures are checked before anything here runs.
 */

import { canonicalJson } from '../canonical-json.ts';
import { findSecretShaped, isPlainObject } from '../scheduler/model.ts';
import { RUNNER_CONTRACT_VERSION, type RunnerRequest, type RunnerResult } from '../runner/model.ts';

export const BRIDGE_CONTRACT_VERSION = RUNNER_CONTRACT_VERSION;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
export const RUNNER_KEY = /^[a-z][a-z0-9-]{2,80}$/;
export const WORKFLOW_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

type Check<T> = { ok: true; value: T } | { ok: false; problem: string };
const bad = <T>(problem: string): Check<T> => ({ ok: false, problem });

function exactFields(v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): string | null {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(v).filter((k) => !allowed.has(k));
  if (unknown.length) return `unknown fields: ${unknown.join(', ')}`;
  const missing = required.filter((k) => !(k in v));
  return missing.length ? `missing fields: ${missing.join(', ')}` : null;
}

/* ── dispatch ─────────────────────────────────────────────── */

export interface DispatchRoute {
  runnerKey: string;
  workflowVersion: string;
}

export interface DispatchBody {
  contract_version: number;
  job_id: string;
  action_id: string;
  tenant_id: string;
  module_key: string;
  module_version: number | null;
  runner_key: string;
  workflow_version: string;
  attempt: number;
  config_refs: { config_snapshot_id: string };
  idempotency_key: string;
  issued_at: string;
  expires_at: string;
  correlation_id: string;
  nonce: string;
}

/** §18's envelope-reference, built from a request that already passed the runner contract. */
export function dispatchBody(request: RunnerRequest, route: DispatchRoute, nonce: string, issuedAt: string, expiresAt: string): DispatchBody {
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    job_id: request.attemptId,
    action_id: request.actionId,
    tenant_id: request.tenantId,
    module_key: request.moduleKey,
    module_version: request.moduleVersion,
    runner_key: route.runnerKey,
    workflow_version: route.workflowVersion,
    attempt: request.attemptNumber,
    config_refs: { config_snapshot_id: request.configSnapshotId },
    idempotency_key: request.idempotencyKey,
    issued_at: issuedAt,
    expires_at: expiresAt,
    correlation_id: request.correlationId,
    nonce,
  };
}

/* ── envelope ─────────────────────────────────────────────── */

export interface EnvelopeRequest {
  contract_version: number;
  job_id: string;
  action_id: string;
  tenant_id: string;
  /** the dispatch's nonce: an envelope is fetched with the dispatch that authorised it. */
  nonce: string;
}

export function parseEnvelopeRequest(value: unknown): Check<EnvelopeRequest> {
  if (!isPlainObject(value)) return bad('the request is not an object');
  const shape = exactFields(value, ['contract_version', 'job_id', 'action_id', 'tenant_id', 'nonce']);
  if (shape) return bad(shape);
  for (const k of ['job_id', 'action_id', 'tenant_id', 'nonce'] as const) {
    if (typeof value[k] !== 'string' || !UUID.test(value[k] as string)) return bad(`${k} is a uuid`);
  }
  if (typeof value.contract_version !== 'number') return bad('contract_version is a number');
  return { ok: true, value: value as unknown as EnvelopeRequest };
}

export interface Envelope {
  contract_version: number;
  job_id: string;
  action_id: string;
  tenant_id: string;
  run_id: string;
  module_key: string;
  module_version: number | null;
  action_type: string;
  effect_class: string;
  run_mode: string;
  attempt: number;
  config_refs: { config_snapshot_id: string };
  idempotency_key: string;
  correlation_id: string;
  /** the connection a provider call goes through — resolved by ARC's gateway, never here. */
  connection: { connection_id: string; connector_key: string | null } | null;
  payload: Record<string, unknown>;
  expires_at: string;
}

/** The sanitized envelope for a request ARC has just rebuilt from its own rows. */
export function envelopeFrom(request: RunnerRequest, expiresAt: string): Envelope {
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    job_id: request.attemptId,
    action_id: request.actionId,
    tenant_id: request.tenantId,
    run_id: request.runId,
    module_key: request.moduleKey,
    module_version: request.moduleVersion,
    action_type: request.actionType,
    effect_class: request.effectClass,
    run_mode: request.runMode,
    attempt: request.attemptNumber,
    config_refs: { config_snapshot_id: request.configSnapshotId },
    idempotency_key: request.idempotencyKey,
    correlation_id: request.correlationId,
    connection: request.connection ? { connection_id: request.connection.connectionId, connector_key: request.connection.connectorKey } : null,
    payload: request.payload,
    expires_at: expiresAt,
  };
}

/* ── callback ─────────────────────────────────────────────── */

export const CALLBACK_STATUSES = ['succeeded', 'failed', 'ambiguous', 'skipped'] as const;

export interface Callback {
  contract_version: number;
  job_id: string;
  action_id: string;
  tenant_id: string;
  arc_attempt: number;
  n8n_execution_id: string;
  runner_key: string;
  workflow_version: string;
  status: typeof CALLBACK_STATUSES[number];
  provider_refs: string[];
  safe_output_meta: Record<string, unknown>;
  error_category: string | null;
  retryable: boolean;
  completed_at: string;
  correlation_id: string;
  idempotency_key: string;
  elapsed_ms?: number;
  diagnostics?: { node: string; code: string }[];
}

const CALLBACK_REQUIRED = [
  'contract_version', 'job_id', 'action_id', 'tenant_id', 'arc_attempt', 'n8n_execution_id', 'runner_key',
  'workflow_version', 'status', 'provider_refs', 'safe_output_meta', 'error_category', 'retryable', 'completed_at',
  'correlation_id', 'idempotency_key',
] as const;

/** A callback, strictly. The contract version is checked by the caller, so it can answer 400 vs 409 apart. */
export function parseCallback(value: unknown): Check<Callback> {
  if (!isPlainObject(value)) return bad('the callback is not an object');
  const v = value;
  const shape = exactFields(v, CALLBACK_REQUIRED, ['elapsed_ms', 'diagnostics']);
  if (shape) return bad(shape);
  for (const k of ['job_id', 'action_id', 'tenant_id', 'correlation_id'] as const) {
    if (typeof v[k] !== 'string' || !UUID.test(v[k] as string)) return bad(`${k} is a uuid`);
  }
  if (typeof v.contract_version !== 'number') return bad('contract_version is a number');
  if (!Number.isInteger(v.arc_attempt) || (v.arc_attempt as number) < 1) return bad('arc_attempt is ARC\'s attempt number');
  if (typeof v.n8n_execution_id !== 'string' || !v.n8n_execution_id.trim() || v.n8n_execution_id.length > 200) return bad('n8n_execution_id names the execution');
  if (typeof v.runner_key !== 'string' || !RUNNER_KEY.test(v.runner_key)) return bad('runner_key is a runner key');
  if (typeof v.workflow_version !== 'string' || !WORKFLOW_VERSION.test(v.workflow_version)) return bad('workflow_version is a version');
  if (!(CALLBACK_STATUSES as readonly string[]).includes(v.status as string)) return bad(`status is ${CALLBACK_STATUSES.join(', ')}`);
  if (!Array.isArray(v.provider_refs) || v.provider_refs.length > 10
      || !v.provider_refs.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 200)) {
    return bad('provider_refs is at most ten references');
  }
  if (!isPlainObject(v.safe_output_meta) || JSON.stringify(v.safe_output_meta).length > 4000) return bad('safe_output_meta is a small object');
  if (v.error_category !== null && (typeof v.error_category !== 'string' || !CODE.test(v.error_category))) return bad('error_category is a lower-case code or null');
  if ((v.status === 'failed' || v.status === 'ambiguous') && !v.error_category) return bad('a failure names its error_category');
  if (typeof v.retryable !== 'boolean') return bad('retryable is a boolean');
  if (v.retryable && v.status !== 'failed') return bad('only a failure is retryable');
  if (typeof v.completed_at !== 'string' || Number.isNaN(Date.parse(v.completed_at))) return bad('completed_at is a timestamp');
  if (typeof v.idempotency_key !== 'string' || !v.idempotency_key.trim() || v.idempotency_key.length > 200) return bad('idempotency_key is ARC\'s key');
  if ('elapsed_ms' in v && (!Number.isInteger(v.elapsed_ms) || (v.elapsed_ms as number) < 0)) return bad('elapsed_ms is a whole number of milliseconds');
  if ('diagnostics' in v) {
    const d = v.diagnostics;
    if (!Array.isArray(d) || d.length > 20 || !d.every((x) => isPlainObject(x) && Object.keys(x).length === 2
        && typeof x.node === 'string' && x.node.length > 0 && x.node.length <= 100 && typeof x.code === 'string' && CODE.test(x.code))) {
      return bad('diagnostics is at most twenty { node, code } pairs');
    }
  }
  const secret = findSecretShaped(v, '$callback');
  if (secret) return bad(`${secret} looks like a credential — a callback never carries one`);
  return { ok: true, value: v as unknown as Callback };
}

/**
 * What makes two callbacks for one attempt the same report: the outcome and what it rests
 * on — not the bytes. A retried delivery re-serialised, or stamped with a later
 * `completed_at`, is a duplicate; a different status, category or retryability is a
 * conflict (§19: the first terminal status wins).
 */
export function callbackOutcome(c: Callback): string {
  return canonicalJson({
    status: c.status, error_category: c.error_category, retryable: c.retryable,
    n8n_execution_id: c.n8n_execution_id, provider_refs: [...c.provider_refs].sort(),
  });
}

/** What the callback proposes, in the runner contract's terms. `validateRunnerResult` still runs on it. */
export function callbackToResult(c: Callback): RunnerResult {
  const failed = c.status === 'failed' || c.status === 'ambiguous';
  return {
    status: c.status === 'ambiguous' ? 'failed' : c.status,
    ambiguous: c.status === 'ambiguous',
    retryable: c.status === 'failed' && c.retryable,
    errorCode: failed ? c.error_category : null,
    message: null,
    evidence: {
      runner_key: c.runner_key,
      workflow_version: c.workflow_version,
      provider_refs: c.provider_refs,
      output: c.safe_output_meta,
      ...(c.elapsed_ms !== undefined ? { elapsed_ms: c.elapsed_ms } : {}),
      ...(c.diagnostics ? { diagnostics: c.diagnostics } : {}),
    },
    evidenceRef: null,
    externalRequestId: c.provider_refs[0] ?? null,
    runnerExecutionId: c.n8n_execution_id,
  };
}
