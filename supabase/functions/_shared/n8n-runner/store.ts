/**
 * ARC-220 — the seam between the bridge and 0018.
 *
 * Two surfaces. `BridgeLedger` is all the runner may touch: it records that a dispatch is
 * about to leave, correlates the backend's execution id, and voids a dispatch whose
 * envelope never opened. That is transport bookkeeping — it cannot change an action or an
 * attempt, which only the scheduler's service writes. `BridgeStore` adds what the inbound
 * handlers need. One implementation, over 0018's functions (`supabase-bridge-store.ts`);
 * like the scheduler, no in-memory twin, because every rule here is a decision taken under
 * a row lock.
 */

export class BridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly effectPossible: boolean;
  constructor(code: string, message: string, options: { retryable?: boolean; effectPossible?: boolean } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.effectPossible = options.effectPossible ?? true;
  }
}

/** `arc_bridge:<code>: detail` → a BridgeError. */
export function parseBridgeError(message: string | null | undefined): BridgeError | null {
  const match = /arc_bridge:([a-z][a-z0-9_]*):\s*(.*)$/s.exec(String(message ?? ''));
  return match ? new BridgeError(match[1], match[2].trim()) : null;
}

export interface NewDispatch {
  attemptId: string;
  tenantId: string;
  runnerKind: string;
  /** the assignment the runner resolved. ARC attributes the dispatch from it (0019), not from the runner. */
  assignmentId: string;
  environment: string;
  nonce: string;
  expiresAt: string;
}

/** What ARC recorded the dispatch as running. */
export interface DispatchAttribution {
  runnerKey: string;
  workflowVersion: string;
  workflowChecksum: string;
}

/** Which workflow executes an action type here (0019's `resolve_runner_workflow`). */
export interface WorkflowRoute {
  /** `ok`, or why nothing may: n8n_prohibited, no_assignment, workflow_draft, workflow_disabled, not_deployed. */
  code: string;
  assignmentId: string | null;
  runnerKey: string | null;
  workflowVersion: string | null;
  webhookUrl: string | null;
}

export type VoidResult = 'voided' | 'already_void' | 'envelope_opened' | 'not_found';

export interface BridgeLedger {
  resolveWorkflow(moduleKey: string, moduleVersion: number, actionType: string, environment: string): Promise<WorkflowRoute>;
  recordDispatch(input: NewDispatch): Promise<DispatchAttribution>;
  correlate(attemptId: string, tenantId: string, executionId: string): Promise<'ok' | 'duplicate' | 'conflict' | 'not_found'>;
  voidDispatch(attemptId: string, tenantId: string, reason: string): Promise<VoidResult>;
}

export interface Dispatch {
  attemptId: string;
  tenantId: string;
  actionId: string;
  runId: string;
  runnerKind: string;
  runnerKey: string;
  workflowVersion: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  runnerExecutionId: string | null;
  envelopeOpenedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  callbackDigest: string | null;
  assignmentId: string | null;
  workflowChecksum: string | null;
  errorHandlerKey: string | null;
  errorHandlerVersion: string | null;
  /** whether ARC may retry a failure this workflow reports as retryable. */
  autoRetry: boolean | null;
}

/** The attempt as the bridge needs it: whether it still runs, and the lease it runs under. */
export interface AttemptLease {
  attemptId: string;
  tenantId: string;
  actionId: string;
  runId: string;
  attemptNo: number;
  status: string;
  leaseToken: string;
}

/**
 * Which dispatch a failed execution was, from ARC's rows (0020's `resolve_runner_failure`):
 * `ok`, or unknown_execution, execution_ambiguous, workflow_mismatch, handler_mismatch.
 */
export interface FailureRoute {
  code: string;
  attemptId: string | null;
  tenantId: string | null;
}

export interface LogEntry {
  tenantId: string | null;
  attemptId: string | null;
  direction: 'dispatch' | 'envelope' | 'callback' | 'failure';
  disposition: 'accepted' | 'applied' | 'duplicate' | 'late' | 'conflict' | 'rejected' | 'voided';
  code: string;
  alert: boolean;
  detail: string | null;
  bodyDigest: string | null;
}

export interface CallbackRecord {
  attemptId: string;
  tenantId: string;
  actionId: string;
  attemptNo: number;
  idempotencyKey: string;
  runnerKey: string;
  workflowVersion: string;
  digest: string;
  callback: Record<string, unknown>;
}

export interface BridgeStore extends BridgeLedger {
  getDispatch(attemptId: string): Promise<Dispatch | null>;
  getAttemptLease(attemptId: string, tenantId: string): Promise<AttemptLease | null>;
  /** true the first time; false on a replay. */
  claimNonce(nonce: string, purpose: 'envelope' | 'callback' | 'failure', ttlSeconds: number): Promise<boolean>;
  /** the dispatch a failed execution was — checked against the failed workflow and the reporting handler. */
  resolveFailure(input: { executionId: string; n8nWorkflowId: string; handlerKey: string; handlerVersion: string }): Promise<FailureRoute>;
  openEnvelope(input: { attemptId: string; tenantId: string; actionId: string; nonce: string }): Promise<{ code: string; detail: string | null }>;
  /** first, duplicate, conflict — or why the callback is not ARC's to hear. */
  recordCallback(input: CallbackRecord): Promise<string>;
  log(entry: LogEntry): Promise<void>;
}
