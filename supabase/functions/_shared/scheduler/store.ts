/**
 * The seam between the ARC-200 scheduler service and the database.
 *
 * One implementation: `supabaseSchedulerStore`, over 0017's tables and functions. There
 * is deliberately no in-memory twin. Every rule that matters — the gate, the lease, the
 * send-once refusals, the backoff — is enforced inside one Postgres function under one row
 * lock, and a JavaScript copy of it would be the thing that drifts (the ARC-015B defect
 * lived exactly in the gap between an in-memory store and the real one).
 * `tests/scheduler-db.test.js` runs the service against real SQL through PGlite.
 *
 * Every method either returns what the database returned or throws a `SchedulerError`
 * carrying the database's own refusal code.
 */

import type {
  ActionAttempt,
  ActionLease,
  AttemptOutcome,
  AutomationAction,
  AutomationRun,
  RunKind,
  RunMode,
} from './model.ts';

export interface NewRun {
  tenantId: string;
  runKind: RunKind;
  moduleKey: string;
  configSnapshotId: string;
  runMode: RunMode;
  correlationId: string;
  idempotencyKey: string;
  runnerKind: string | null;
  createdBy: { type: 'system'; id: null } | { type: 'operator'; id: string };
}

export interface NewAction {
  tenantId: string;
  runId: string;
  actionType: string;
  runAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts: number | null;
  connectionId: string | null;
}

export interface StartResult {
  started: boolean;
  code: string;
  detail: string | null;
  attemptId: string | null;
  attemptNo: number | null;
}

export interface Settlement {
  outcome: AttemptOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
  externalRequestId: string | null;
  runnerExecutionId: string | null;
  evidence: Record<string, unknown>;
  evidenceRef: string | null;
  /** a later retry than the backoff; never an earlier one. */
  retryAt: string | null;
}

export interface SettleResult {
  settled: boolean;
  code: string;
  actionStatus: string | null;
  nextRunAt: string | null;
}

export interface FinishResult {
  runStatus: string;
  cancelledActions: number;
  inFlightActions: number;
  ambiguousActions: number;
}

export interface SchedulerStore {
  /** insert, or return the run this tenant's idempotency key already names. */
  createRun(input: NewRun): Promise<{ run: AutomationRun; created: boolean }>;
  getRun(tenantId: string, runId: string): Promise<AutomationRun | null>;
  getRunByKey(tenantId: string, idempotencyKey: string): Promise<AutomationRun | null>;

  scheduleAction(input: NewAction): Promise<{ action: AutomationAction; created: boolean }>;
  getAction(tenantId: string, actionId: string): Promise<AutomationAction | null>;

  /** `tenantId: null` claims for every tenant and has to be written out. */
  claimActions(options: { tenantId: string | null; limit: number; worker: string; leaseSeconds: number }): Promise<AutomationAction[]>;
  startAttempt(lease: ActionLease, runnerKind: string | null): Promise<StartResult>;
  settleAttempt(lease: ActionLease, settlement: Settlement): Promise<SettleResult>;

  resolveAmbiguous(args: { tenantId: string; actionId: string; resolution: 'effect_happened' | 'effect_absent'; actorId: string; note: string | null }): Promise<string>;
  setRunStatus(args: { tenantId: string; runId: string; status: 'paused' | 'blocked' | 'running'; code: string | null; reason: string | null; actor: { type: 'system' | 'operator'; id: string | null } }): Promise<string>;
  cancelRunActions(args: { tenantId: string; runId: string; reason: string; types: string[] | null }): Promise<number>;
  finishRun(args: { tenantId: string; runId: string; status: 'completed' | 'failed' | 'cancelled'; code: string; reason: string | null }): Promise<FinishResult>;

  /** pending, due at or before `asOf`, oldest first. `tenantId: null` is every tenant. */
  listDueActions(args: { tenantId: string | null; asOf: string; limit: number }): Promise<AutomationAction[]>;
  /** pending, due after `from` and at or before `until`: the future the scheduler holds. */
  listUpcomingActions(args: { tenantId: string | null; from: string; until: string; limit: number }): Promise<AutomationAction[]>;
  listActionsForRun(tenantId: string, runId: string): Promise<AutomationAction[]>;
  listAttemptsForRun(tenantId: string, runId: string): Promise<ActionAttempt[]>;
  listAttemptsForAction(tenantId: string, actionId: string): Promise<ActionAttempt[]>;
}
