/**
 * ARC-200 — the vocabulary of ARC's durable execution: runs, actions, attempts.
 *
 * The database (0017) is the authority. Everything here is either a mirror of a rule the
 * database enforces — drift-tested against the migration text (`tests/scheduler.test.js`)
 * — or a pure function over rows it returned. Nothing in this file decides whether an
 * action may run: the gate lives in `scheduler_action_gate`, read under the action's lock
 * at the claim and again at the start, because a decision made here would be made on a
 * copy of state that may already be stale.
 *
 * The scheduler knows durable timing, ownership, idempotency and execution safety, and
 * nothing about Lead Recovery or optimisation. A payload is data it carries, never data it
 * reads.
 */

/* ── action types ─────────────────────────────────────────── */

export const DISPATCHERS = ['lead_recovery_engine', 'scheduler'] as const;
export type Dispatcher = typeof DISPATCHERS[number];

/** none: touches nothing outside ARC. external_read: calls out, changes nothing — safe to
 *  repeat. external_effect: sends or mutates outside ARC — never repeated on an unknown outcome. */
export const EFFECT_CLASSES = ['none', 'external_read', 'external_effect'] as const;
export type EffectClass = typeof EFFECT_CLASSES[number];

/** hold: not claimable while paused. proceed: claimable anyway (bookkeeping only).
 *  engine: the Lead Recovery engine decides at execution. */
export const PAUSED_POLICIES = ['hold', 'proceed', 'engine'] as const;
export type PausedPolicy = typeof PAUSED_POLICIES[number];

/** testable: a connection that exists and has not ended. verified: one that serves (ARC-130). */
export const CONNECTION_REQUIREMENTS = ['none', 'testable', 'verified'] as const;
export type ConnectionRequirement = typeof CONNECTION_REQUIREMENTS[number];

export interface ActionTypeDefinition {
  key: string;
  dispatcher: Dispatcher;
  effectClass: EffectClass;
  pausedPolicy: PausedPolicy;
  connectionRequirement: ConnectionRequirement;
  defaultMaxAttempts: number;
  retryBaseSeconds: number;
  retryCeilingSeconds: number;
}

const t = (
  key: string,
  dispatcher: Dispatcher,
  effectClass: EffectClass,
  pausedPolicy: PausedPolicy,
  connectionRequirement: ConnectionRequirement,
  defaultMaxAttempts: number,
  retryBaseSeconds: number,
  retryCeilingSeconds: number,
): ActionTypeDefinition =>
  Object.freeze({ key, dispatcher, effectClass, pausedPolicy, connectionRequirement, defaultMaxAttempts, retryBaseSeconds, retryCeilingSeconds });

/**
 * Exactly the rows 0017 seeds into `automation_action_types`. A new type is a row there, in
 * a migration, and a row here — the test fails on any difference.
 */
export const ACTION_TYPES: readonly ActionTypeDefinition[] = Object.freeze([
  t('send_first_response', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800),
  t('send_followup', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800),
  t('notify_staff', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800),
  t('route_to_contractor', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800),
  t('open_handoff', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800),
  t('classify_reply', 'lead_recovery_engine', 'external_read', 'engine', 'none', 5, 60, 1800),
  t('close_run', 'lead_recovery_engine', 'none', 'engine', 'none', 5, 60, 1800),
  t('send_message', 'scheduler', 'external_effect', 'hold', 'verified', 5, 60, 1800),
  t('call_provider_operation', 'scheduler', 'external_effect', 'hold', 'verified', 5, 60, 1800),
  t('enqueue_runner_execution', 'scheduler', 'external_effect', 'hold', 'none', 5, 60, 1800),
  t('test_connection', 'scheduler', 'external_read', 'hold', 'testable', 3, 30, 600),
  t('evaluate_reply', 'scheduler', 'external_read', 'hold', 'none', 3, 30, 600),
  t('schedule_follow_up', 'scheduler', 'none', 'hold', 'none', 3, 30, 600),
  t('record_observation_checkpoint', 'scheduler', 'none', 'proceed', 'none', 3, 30, 600),
  t('request_human_review', 'scheduler', 'none', 'proceed', 'none', 3, 30, 600),
  t('remind_operator', 'scheduler', 'none', 'proceed', 'none', 3, 30, 600),
]);

export function actionType(key: unknown): ActionTypeDefinition | null {
  return typeof key === 'string' ? ACTION_TYPES.find((d) => d.key === key) ?? null : null;
}

/** The types the ARC-200 scheduler dispatches — the only ones `scheduleAutomationAction` accepts. */
export function schedulerActionTypes(): string[] {
  return ACTION_TYPES.filter((d) => d.dispatcher === 'scheduler').map((d) => d.key);
}

/**
 * The retry delay after `attempts` charged attempts, as `settle_automation_attempt`
 * computes it: base × 2^(attempts−1), capped at the ceiling. Deterministic and unjittered,
 * like the Lead Recovery engine's. A caller may ask for a later retry, never a sooner one.
 */
export function backoffSeconds(type: Pick<ActionTypeDefinition, 'retryBaseSeconds' | 'retryCeilingSeconds'>, attempts: number): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 30);
  return Math.floor(Math.min(type.retryCeilingSeconds, type.retryBaseSeconds * 2 ** exponent));
}

/* ── runs ─────────────────────────────────────────────────── */

/** A lead conversation is created by the Lead Recovery engine; the scheduler creates the others.
 *  `crm_message` (0026, ARC-370) is one message a person wrote, queued with its run in one
 *  transaction by `crm_queue_message`. */
export const RUN_KINDS = ['lead_conversation', 'connector_test', 'observation_window', 'crm_message'] as const;
export type RunKind = typeof RUN_KINDS[number];
export const SCHEDULER_RUN_KINDS: readonly RunKind[] = ['connector_test', 'observation_window', 'crm_message'];

export const RUN_STATUSES = ['pending', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = typeof RUN_STATUSES[number];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export const RUN_MODES = ['live', 'test', 'shadow'] as const;
export type RunMode = typeof RUN_MODES[number];

export interface AutomationRun {
  id: string;
  tenantId: string;
  runKind: RunKind;
  moduleKey: string;
  /** the registry version whose schema the run's snapshot was written for — set by the database. */
  moduleVersion: number | null;
  leadId: string | null;
  configSnapshotId: string | null;
  runMode: RunMode | null;
  /** the module's lifecycle state when the run was created — set by the database. */
  lifecycleStateAtStart: string | null;
  /** requested or assigned; never hard-coded to a particular runner. */
  runnerKind: string | null;
  status: RunStatus;
  statusReason: string | null;
  terminalCode: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  createdByType: 'system' | 'operator';
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

/* ── actions ──────────────────────────────────────────────── */

export const ACTION_STATUSES = [
  'pending', 'claimed', 'running', 'done', 'cancelled', 'failed', 'blocked', 'skipped', 'dead_letter',
] as const;
export type ActionStatus = typeof ACTION_STATUSES[number];
/** For a scheduler action these never change again (0017's guard). */
export const TERMINAL_ACTION_STATUSES: readonly ActionStatus[] = ['done', 'cancelled', 'failed', 'skipped', 'dead_letter'];

export interface ActionGate {
  code: string;
  detail: string | null;
  checkedAt: string | null;
}

export interface AutomationAction {
  id: string;
  tenantId: string;
  runId: string;
  moduleKey: string;
  actionType: string;
  /** when it was first due. */
  scheduledFor: string;
  /** when it is next due — moves on every retry. */
  runAt: string;
  status: ActionStatus;
  /** stable across every retry of this logical action; unique per tenant. */
  idempotencyKey: string;
  /** charged attempts. an attempt refused at its start is refunded. */
  attempts: number;
  maxAttempts: number;
  /** the lease owner. */
  lockedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  fence: number;
  connectorKey: string | null;
  /** ARC connection metadata (0016) — never a credential. */
  connectionId: string | null;
  payload: Record<string, unknown>;
  configSnapshotId: string | null;
  /** the last verdict of the gate, when it held, skipped or blocked this action. */
  gate: ActionGate | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/**
 * Due and waiting — derived, never stored, because storing it would need a clock to flip
 * it. Claimable here means "the claim will ask the gate"; the gate may still hold it.
 */
export function isDue(action: Pick<AutomationAction, 'status' | 'runAt'>, nowIso: string): boolean {
  return action.status === 'pending' && Date.parse(action.runAt) <= Date.parse(nowIso);
}

/** Blocked on an outcome nobody knows — a person reconciles it; nothing retries it. */
export function isAmbiguous(action: Pick<AutomationAction, 'status' | 'gate'>): boolean {
  return action.status === 'blocked' && action.gate?.code === 'ambiguous_outcome';
}

/** What a worker must present for everything after the claim. */
export interface ActionLease {
  actionId: string;
  tenantId: string;
  leaseToken: string;
}

export function leaseOf(action: Pick<AutomationAction, 'id' | 'tenantId' | 'leaseToken'>): ActionLease | null {
  return action.leaseToken ? { actionId: action.id, tenantId: action.tenantId, leaseToken: action.leaseToken } : null;
}

/* ── attempts ─────────────────────────────────────────────── */

export const ATTEMPT_STATUSES = [
  'claimed', 'running', 'succeeded', 'failed', 'ambiguous', 'lease_expired', 'released', 'cancelled', 'skipped',
] as const;
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];

export const ATTEMPT_OUTCOMES = ['succeeded', 'failed', 'ambiguous', 'skipped'] as const;
export type AttemptOutcome = typeof ATTEMPT_OUTCOMES[number];

export interface ActionAttempt {
  id: string;
  tenantId: string;
  actionId: string;
  runId: string;
  attemptNo: number;
  worker: string;
  runnerKind: string | null;
  status: AttemptStatus;
  claimedAt: string;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  /** safe to display: the database replaces a secret-shaped message rather than store it. */
  errorMessage: string | null;
  externalRequestId: string | null;
  runnerExecutionId: string | null;
  ambiguous: boolean;
  retryable: boolean | null;
  evidence: Record<string, unknown>;
  evidenceRef: string | null;
  reconciliation: 'effect_happened' | 'effect_absent' | null;
  reconciledBy: string | null;
  reconciledAt: string | null;
}

/* ── secrets ──────────────────────────────────────────────── */

/**
 * The regex every ARC table has carried since 0010, as `scheduler_secret_shaped` holds it
 * in 0017. The database refuses on it; checking here as well turns the refusal into a typed
 * answer before any write, and names the path of the offending value.
 */
const SECRET_SHAPED = /(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer |eyJ[A-Za-z0-9_-]{8,}\.)/i;

/** Field names that only ever hold a credential. Narrower than ARC-130's log redaction list
 *  on purpose: `code` and `state` are ordinary words in a payload. */
const SECRET_KEYS = /^(access_?token|refresh_?token|id_?token|client_?secret|secret|api_?key|apikey|password|passwd|authorization|auth_?token|private_?key|bearer|credentials?|vault_?secret_?id)$/i;

/** The path of the first secret-shaped key or value in `value`, or null when there is none. */
export function findSecretShaped(value: unknown, path = '$', depth = 0): string | null {
  if (depth > 12) return `${path} (nested too deeply to inspect)`;
  if (typeof value === 'string') return SECRET_SHAPED.test(value) || SECRET_SHAPED.test(JSON.stringify(value)) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findSecretShaped(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(key) || SECRET_SHAPED.test(JSON.stringify(key))) return `${path}.${key}`;
      const hit = findSecretShaped(v, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/* ── errors ───────────────────────────────────────────────── */

/**
 * Every refusal the scheduler can give, from either side of the boundary. The database's
 * arrive as `arc_scheduler:<code>: …` (or 0015's `arc_lifecycle:<code>: …` when a run is
 * refused at its creation) and are parsed into the same codes.
 */
export const SCHEDULER_ERROR_CODES = [
  // input
  'invalid_request', 'unknown_action_type', 'not_scheduler_action', 'secret_in_payload', 'secret_in_evidence',
  'connection_required', 'connection_mismatch', 'module_mismatch', 'module_version_mismatch', 'correlation_mismatch',
  'idempotency_conflict', 'invalid_action', 'invalid_outcome', 'invalid_status', 'invalid_code', 'invalid_actor',
  'invalid_runner', 'invalid_resolution', 'illegal_status', 'tenant_required',
  // state
  'not_found', 'run_finished', 'action_finished', 'actions_outstanding', 'lead_conversation', 'not_ambiguous',
  'run_identity_fixed', 'action_identity_fixed', 'attempt_history', 'vocabulary_immutable', 'ambiguous_outcome',
  // the lease
  'lost_lease', 'already_completed', 'lease_expired', 'not_started', 'attempt_missing',
  // authority
  'forbidden',
  // the database refused a row: a pin guard, another tenant's reference, a check constraint
  'guard_refused', 'reference_invalid', 'constraint_refused',
] as const;
export type SchedulerErrorCode = typeof SCHEDULER_ERROR_CODES[number] | string;

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;
  constructor(code: SchedulerErrorCode, message: string) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

/** `arc_scheduler:<code>: detail` or `arc_lifecycle:<code>: detail` → a SchedulerError. */
export function parseSchedulerError(message: string | null | undefined): SchedulerError | null {
  const match = /arc_(scheduler|lifecycle):([a-z_]+):\s*(.*)$/s.exec(String(message ?? ''));
  return match ? new SchedulerError(match[2], match[3].trim()) : null;
}

export type SchedulerResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SchedulerErrorCode; message: string };

export const ok = <T>(value: T): SchedulerResult<T> => ({ ok: true, value });
export const refuse = <T = never>(code: SchedulerErrorCode, message: string): SchedulerResult<T> => ({ ok: false, code, message });
