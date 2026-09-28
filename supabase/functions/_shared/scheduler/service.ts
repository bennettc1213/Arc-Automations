/**
 * ARC-200 — the scheduler's service API.
 *
 * What a worker, an ops handler or a later module calls. Each function validates its input,
 * refuses anything secret-shaped before it can be written, and makes one store call; the
 * decision itself — may this run, who holds it, what happens after a failure — is the
 * database's, taken under a row lock (0017). Results are `SchedulerResult`s: a refusal is
 * a value with a code, never an exception, except for failures nobody anticipated.
 *
 * Deliberately generic. Nothing here knows about Lead Recovery, n8n or any runner: an
 * action is a type from the vocabulary, a time, a key, a payload the scheduler carries
 * without reading, and optionally a connection reference. Lead conversations and their
 * seven action types stay with the Lead Recovery engine, which shares the same tables.
 */

import {
  type ActionAttempt,
  type ActionLease,
  actionType,
  type AutomationAction,
  type AutomationRun,
  findSecretShaped,
  isPlainObject,
  ok,
  refuse,
  type RunKind,
  type RunMode,
  RUN_MODES,
  SchedulerError,
  type SchedulerResult,
  SCHEDULER_RUN_KINDS,
} from './model.ts';
import type { FinishResult, SchedulerStore, SettleResult, StartResult } from './store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const RUNNER = /^[a-z][a-z0-9_]{1,40}$/;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isKey = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** A store refusal becomes a result; anything else is a real failure and propagates. */
async function attempt<T>(fn: () => Promise<T>): Promise<SchedulerResult<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof SchedulerError) return refuse(error.code, error.message);
    throw error;
  }
}

export type SchedulerActor = { type: 'system'; id: null } | { type: 'operator'; id: string };
export const SYSTEM: SchedulerActor = Object.freeze({ type: 'system' as const, id: null });

/* ── runs ─────────────────────────────────────────────────── */

export interface CreateRunInput {
  tenantId: string;
  runKind: RunKind;
  moduleKey: string;
  /** the immutable snapshot the run's behaviour is pinned to. required: nothing runs unpinned. */
  configSnapshotId: string;
  runMode: RunMode;
  correlationId: string;
  /** a retried "start this" is one run. */
  idempotencyKey: string;
  runnerKind?: string | null;
  createdBy?: SchedulerActor;
}

/**
 * A run the scheduler owns — a connector test or an observation window. The database
 * pins it, stamps the module version and lifecycle state it started under, and refuses it
 * if the lifecycle does not allow its mode (0015's guard).
 */
export async function createAutomationRun(store: SchedulerStore, input: CreateRunInput): Promise<SchedulerResult<{ run: AutomationRun; created: boolean }>> {
  if (!isUuid(input.tenantId)) return refuse('invalid_request', 'tenantId is a uuid');
  if (!SCHEDULER_RUN_KINDS.includes(input.runKind)) {
    return refuse('invalid_request', `the scheduler creates ${SCHEDULER_RUN_KINDS.join(' or ')} runs; a lead conversation is the Lead Recovery engine's`);
  }
  if (typeof input.moduleKey !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(input.moduleKey)) return refuse('invalid_request', 'moduleKey is a registry key');
  if (!isUuid(input.configSnapshotId)) return refuse('invalid_request', 'a run is pinned to a configuration snapshot');
  if (!RUN_MODES.includes(input.runMode)) return refuse('invalid_request', `runMode is ${RUN_MODES.join(', ')}`);
  if (!isUuid(input.correlationId)) return refuse('invalid_request', 'correlationId is a uuid');
  if (!isKey(input.idempotencyKey)) return refuse('invalid_request', 'idempotencyKey is 1–200 characters');
  if (input.runnerKind != null && !RUNNER.test(input.runnerKind)) return refuse('invalid_runner', 'runnerKind is a lower-case identifier');
  const createdBy = input.createdBy ?? SYSTEM;
  if (createdBy.type === 'operator' && !isUuid(createdBy.id)) return refuse('invalid_actor', 'an operator actor carries their user id');

  return await attempt(() => store.createRun({
    tenantId: input.tenantId,
    runKind: input.runKind,
    moduleKey: input.moduleKey,
    configSnapshotId: input.configSnapshotId,
    runMode: input.runMode,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    runnerKind: input.runnerKind ?? null,
    createdBy,
  }));
}

/* ── scheduling ───────────────────────────────────────────── */

export interface ScheduleInput {
  tenantId: string;
  runId: string;
  actionType: string;
  /** when it is due. a future time is simply not claimable until then. */
  runAt: string;
  /**
   * The durable identity of this logical action — and, for an external effect, the key
   * it is sent under. Stable across every retry; the same key for a different action is
   * refused.
   */
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number | null;
  /** ARC connection metadata, required by a type that needs one. never a credential. */
  connectionId?: string | null;
}

export async function scheduleAutomationAction(store: SchedulerStore, input: ScheduleInput): Promise<SchedulerResult<{ action: AutomationAction; created: boolean }>> {
  if (!isUuid(input.tenantId) || !isUuid(input.runId)) return refuse('invalid_request', 'tenantId and runId are uuids');
  const type = actionType(input.actionType);
  if (!type) return refuse('unknown_action_type', `${String(input.actionType)} is not in the vocabulary`);
  if (type.dispatcher !== 'scheduler') {
    return refuse('not_scheduler_action', `${type.key} is dispatched by the Lead Recovery engine`);
  }
  if (!isIso(input.runAt)) return refuse('invalid_request', 'runAt is a timestamp');
  if (!isKey(input.idempotencyKey)) return refuse('invalid_request', 'idempotencyKey is 1–200 characters');
  const payload = input.payload ?? {};
  if (!isPlainObject(payload)) return refuse('invalid_request', 'payload is a plain object');
  const secret = findSecretShaped(payload);
  if (secret) return refuse('secret_in_payload', `payload ${secret} looks like a credential — a payload never carries one; reference a connection instead`);
  const maxAttempts = input.maxAttempts ?? null;
  if (maxAttempts !== null && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)) {
    return refuse('invalid_request', 'maxAttempts is an integer from 1 to 20');
  }
  const connectionId = input.connectionId ?? null;
  if (connectionId !== null && !isUuid(connectionId)) return refuse('invalid_request', 'connectionId is a uuid');
  if (type.connectionRequirement !== 'none' && connectionId === null) {
    return refuse('connection_required', `${type.key} needs a connection`);
  }

  return await attempt(() => store.scheduleAction({
    tenantId: input.tenantId,
    runId: input.runId,
    actionType: type.key,
    runAt: new Date(input.runAt).toISOString(),
    idempotencyKey: input.idempotencyKey,
    payload,
    maxAttempts,
    connectionId,
  }));
}

/* ── claiming ─────────────────────────────────────────────── */

export interface ClaimedAction {
  action: AutomationAction;
  lease: ActionLease;
}

/**
 * Claim due, ungated work. `tenantId: null` is every tenant and has to be written out;
 * anything short of the production dispatcher passes a tenant.
 */
export async function claimDueActions(
  store: SchedulerStore,
  options: { tenantId: string | null; worker: string; limit?: number; leaseSeconds?: number },
): Promise<SchedulerResult<ClaimedAction[]>> {
  if (options.tenantId !== null && !isUuid(options.tenantId)) return refuse('tenant_required', 'tenantId is a uuid, or null for every tenant');
  const worker = text(options.worker, 100);
  if (!worker) return refuse('invalid_request', 'a claim names its worker');
  const limit = options.limit ?? 25;
  const leaseSeconds = options.leaseSeconds ?? 120;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return refuse('invalid_request', 'limit is 1–500');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) return refuse('invalid_request', 'leaseSeconds is 30–3600');

  const claimed = await attempt(() => store.claimActions({ tenantId: options.tenantId, limit, worker, leaseSeconds }));
  if (!claimed.ok) return claimed;
  return ok(claimed.value.map((action) => ({
    action,
    lease: { actionId: action.id, tenantId: action.tenantId, leaseToken: action.leaseToken as string },
  })));
}

/* ── the holder's writes ──────────────────────────────────── */

/**
 * Cross the line after which an external effect's outcome may be unknown. The gate is
 * re-read first; if it no longer allows the action, nothing starts, the charge is
 * refunded and the refusal says why.
 */
export async function startAttempt(store: SchedulerStore, lease: ActionLease, options: { runnerKind?: string | null } = {}): Promise<SchedulerResult<StartResult>> {
  const runnerKind = options.runnerKind ?? null;
  if (runnerKind !== null && !RUNNER.test(runnerKind)) return refuse('invalid_runner', 'runnerKind is a lower-case identifier');
  const started = await attempt(() => store.startAttempt(lease, runnerKind));
  if (!started.ok) return started;
  return started.value.started ? started : refuse(started.value.code, started.value.detail ?? started.value.code);
}

export interface OutcomeDetail {
  errorCode?: string | null;
  message?: string | null;
  externalRequestId?: string | null;
  runnerExecutionId?: string | null;
  evidence?: Record<string, unknown>;
  evidenceRef?: string | null;
}

async function settle(
  store: SchedulerStore,
  lease: ActionLease,
  outcome: 'succeeded' | 'failed' | 'ambiguous' | 'skipped',
  detail: OutcomeDetail,
  extra: { retryable: boolean | null; retryAt: string | null },
): Promise<SchedulerResult<SettleResult>> {
  const errorCode = detail.errorCode ?? null;
  if (errorCode !== null && !CODE.test(errorCode)) return refuse('invalid_code', 'errorCode is a lower-case code');
  const evidence = detail.evidence ?? {};
  if (!isPlainObject(evidence)) return refuse('invalid_request', 'evidence is a plain object');
  const secret = findSecretShaped(evidence) ?? (detail.evidenceRef ? findSecretShaped(detail.evidenceRef, '$evidenceRef') : null);
  if (secret) return refuse('secret_in_evidence', `evidence ${secret} looks like a credential — evidence is what happened, never how to authenticate`);
  if (extra.retryAt !== null && !isIso(extra.retryAt)) return refuse('invalid_request', 'retryAt is a timestamp');

  const settled = await attempt(() => store.settleAttempt(lease, {
    outcome,
    errorCode,
    // the database replaces a secret-shaped message rather than storing it.
    errorMessage: text(detail.message, 500),
    retryable: extra.retryable,
    externalRequestId: text(detail.externalRequestId, 200),
    runnerExecutionId: text(detail.runnerExecutionId, 200),
    evidence,
    evidenceRef: text(detail.evidenceRef, 300),
    retryAt: extra.retryAt ? new Date(extra.retryAt).toISOString() : null,
  }));
  if (!settled.ok) return settled;
  return settled.value.settled ? settled : refuse(settled.value.code, `the attempt could not be settled: ${settled.value.code}`);
}

/** The action did what it was for. Terminal. */
export const completeSuccess = (store: SchedulerStore, lease: ActionLease, detail: OutcomeDetail = {}) =>
  settle(store, lease, 'succeeded', detail, { retryable: null, retryAt: null });

/**
 * It failed. `retryable: true` asserts it provably did not take effect and may be tried
 * again — back on the queue after the backoff, or dead-lettered at the cap. `false` is a
 * terminal failure. If you do not know whether it took effect, it is `markAmbiguous`.
 */
export const completeFailure = (store: SchedulerStore, lease: ActionLease, detail: OutcomeDetail & { retryable: boolean }) =>
  settle(store, lease, 'failed', detail, { retryable: detail.retryable === true, retryAt: null });

/** A retryable failure with a caller's preferred time — honoured only if later than the backoff. */
export const rescheduleRetry = (store: SchedulerStore, lease: ActionLease, detail: OutcomeDetail & { retryAt: string }) =>
  settle(store, lease, 'failed', detail, { retryable: true, retryAt: detail.retryAt });

/**
 * The effect may or may not have happened — a timeout after the request left, a crash
 * mid-call. The action is blocked for a person and nothing resends it.
 */
export const markAmbiguous = (store: SchedulerStore, lease: ActionLease, detail: OutcomeDetail = {}) =>
  settle(store, lease, 'ambiguous', detail, { retryable: false, retryAt: null });

/** Nothing to do after all. Terminal. */
export const completeSkipped = (store: SchedulerStore, lease: ActionLease, detail: OutcomeDetail = {}) =>
  settle(store, lease, 'skipped', detail, { retryable: null, retryAt: null });

/* ── a person's decisions ─────────────────────────────────── */

/**
 * Reconcile an ambiguous outcome. `effect_happened` closes the action — nothing is resent.
 * `effect_absent` puts it back for a new attempt (or dead-letters it with none left).
 */
export async function resolveAmbiguousAction(
  store: SchedulerStore,
  input: { tenantId: string; actionId: string; resolution: 'effect_happened' | 'effect_absent'; operatorId: string; note?: string | null },
): Promise<SchedulerResult<string>> {
  if (!isUuid(input.tenantId) || !isUuid(input.actionId)) return refuse('invalid_request', 'tenantId and actionId are uuids');
  if (!isUuid(input.operatorId)) return refuse('forbidden', 'reconciliation is an operator decision');
  if (input.resolution !== 'effect_happened' && input.resolution !== 'effect_absent') {
    return refuse('invalid_resolution', 'effect_happened or effect_absent');
  }
  return await attempt(() => store.resolveAmbiguous({
    tenantId: input.tenantId, actionId: input.actionId, resolution: input.resolution,
    actorId: input.operatorId, note: text(input.note, 300),
  }));
}

/* ── run control ──────────────────────────────────────────── */

type RunControl = { tenantId: string; runId: string; code?: string | null; reason?: string | null };

type Refusal = Extract<SchedulerResult<never>, { ok: false }>;

/** A refusal for a malformed run-control request, or null when it is well formed. */
function checkRunControl(input: RunControl): Refusal | null {
  if (!isUuid(input.tenantId) || !isUuid(input.runId)) return { ok: false, code: 'invalid_request', message: 'tenantId and runId are uuids' };
  if (input.code != null && !CODE.test(input.code)) return { ok: false, code: 'invalid_code', message: 'code is a lower-case code' };
  return null;
}

/** Hold a run's actions. Only types that touch nothing outside ARC still proceed. */
export async function pauseRun(store: SchedulerStore, input: RunControl & { actor?: SchedulerActor }): Promise<SchedulerResult<string>> {
  const bad = checkRunControl(input);
  if (bad) return bad;
  return await attempt(() => store.setRunStatus({
    tenantId: input.tenantId, runId: input.runId, status: 'paused', code: input.code ?? 'paused',
    reason: text(input.reason, 300), actor: input.actor ?? SYSTEM,
  }));
}

/** Hold a run's actions because something must be resolved first — safety, a lifecycle gate. */
export async function blockRun(store: SchedulerStore, input: RunControl & { actor?: SchedulerActor }): Promise<SchedulerResult<string>> {
  const bad = checkRunControl(input);
  if (bad) return bad;
  return await attempt(() => store.setRunStatus({
    tenantId: input.tenantId, runId: input.runId, status: 'blocked', code: input.code ?? 'blocked',
    reason: text(input.reason, 300), actor: input.actor ?? SYSTEM,
  }));
}

/** An operator's. The system pauses and blocks; it never resumes. */
export async function resumeRun(store: SchedulerStore, input: RunControl & { operatorId: string }): Promise<SchedulerResult<string>> {
  const bad = checkRunControl(input);
  if (bad) return bad;
  if (!isUuid(input.operatorId)) return refuse('forbidden', 'the system never resumes a run — an operator does');
  return await attempt(() => store.setRunStatus({
    tenantId: input.tenantId, runId: input.runId, status: 'running', code: null, reason: null,
    actor: { type: 'operator', id: input.operatorId },
  }));
}

/** Cancel what is still waiting — never what a worker holds, never an ambiguous outcome. */
export async function cancelFutureActions(
  store: SchedulerStore,
  input: { tenantId: string; runId: string; reason: string; types?: string[] | null },
): Promise<SchedulerResult<number>> {
  if (!isUuid(input.tenantId) || !isUuid(input.runId)) return refuse('invalid_request', 'tenantId and runId are uuids');
  const reason = text(input.reason, 300);
  if (!reason) return refuse('invalid_request', 'a cancellation says why');
  const types = input.types ?? null;
  if (types !== null && !types.every((k) => actionType(k))) return refuse('unknown_action_type', 'every type is in the vocabulary');
  return await attempt(() => store.cancelRunActions({ tenantId: input.tenantId, runId: input.runId, reason, types }));
}

/** Cancel the run: waiting actions are cancelled; in-flight ones settle; ambiguous ones stay for a person. */
export async function cancelRun(store: SchedulerStore, input: { tenantId: string; runId: string; code: string; reason?: string | null }): Promise<SchedulerResult<FinishResult>> {
  return finishRun(store, { ...input, status: 'cancelled' });
}

/** Completed or failed only once nothing is waiting, in flight or ambiguous. */
export async function finishRun(
  store: SchedulerStore,
  input: { tenantId: string; runId: string; status: 'completed' | 'failed' | 'cancelled'; code: string; reason?: string | null },
): Promise<SchedulerResult<FinishResult>> {
  const bad = checkRunControl(input);
  if (bad) return bad;
  if (!CODE.test(input.code ?? '')) return refuse('invalid_code', 'a finished run names why, as a code');
  if (!['completed', 'failed', 'cancelled'].includes(input.status)) return refuse('invalid_status', 'completed, failed or cancelled');
  return await attempt(() => store.finishRun({
    tenantId: input.tenantId, runId: input.runId, status: input.status, code: input.code, reason: text(input.reason, 300),
  }));
}

/* ── visibility ───────────────────────────────────────────── */

/** What is due now, for a worker or a console. Includes work the gate is holding — see `gate`. */
export async function listDueActions(
  store: SchedulerStore,
  options: { tenantId: string | null; asOf: string; limit?: number },
): Promise<SchedulerResult<AutomationAction[]>> {
  if (options.tenantId !== null && !isUuid(options.tenantId)) return refuse('tenant_required', 'tenantId is a uuid, or null for every tenant');
  if (!isIso(options.asOf)) return refuse('invalid_request', 'asOf is a timestamp');
  return await attempt(() => store.listDueActions({ tenantId: options.tenantId, asOf: new Date(options.asOf).toISOString(), limit: options.limit ?? 100 }));
}

/** The future the scheduler is holding: pending work due after `from` and up to `until`. */
export async function listUpcomingActions(
  store: SchedulerStore,
  options: { tenantId: string | null; from: string; until: string; limit?: number },
): Promise<SchedulerResult<AutomationAction[]>> {
  if (options.tenantId !== null && !isUuid(options.tenantId)) return refuse('tenant_required', 'tenantId is a uuid, or null for every tenant');
  if (!isIso(options.from) || !isIso(options.until)) return refuse('invalid_request', 'from and until are timestamps');
  return await attempt(() => store.listUpcomingActions({
    tenantId: options.tenantId, from: new Date(options.from).toISOString(), until: new Date(options.until).toISOString(), limit: options.limit ?? 100,
  }));
}

export type TimelineEntry =
  | { at: string; kind: 'run_created'; run: AutomationRun }
  | { at: string; kind: 'action_scheduled'; action: AutomationAction }
  | { at: string; kind: 'attempt'; attempt: ActionAttempt; actionType: string };

export interface RunTimeline {
  run: AutomationRun;
  actions: AutomationAction[];
  attempts: ActionAttempt[];
  /** every event in order: the run, each action as queued, each attempt as claimed. */
  entries: TimelineEntry[];
}

/** One run's history, for a console or a debugger. Nothing here is a figure: figures come from events. */
export async function listRunTimeline(store: SchedulerStore, input: { tenantId: string; runId: string }): Promise<SchedulerResult<RunTimeline>> {
  if (!isUuid(input.tenantId) || !isUuid(input.runId)) return refuse('invalid_request', 'tenantId and runId are uuids');
  return await attempt(async () => {
    const run = await store.getRun(input.tenantId, input.runId);
    if (!run) throw new SchedulerError('not_found', 'no such run for this tenant');
    const [actions, attempts] = await Promise.all([
      store.listActionsForRun(input.tenantId, input.runId),
      store.listAttemptsForRun(input.tenantId, input.runId),
    ]);
    const typeOf = new Map(actions.map((a) => [a.id, a.actionType]));
    const entries: TimelineEntry[] = [
      { at: run.createdAt, kind: 'run_created', run },
      ...actions.map((action): TimelineEntry => ({ at: action.createdAt, kind: 'action_scheduled', action })),
      ...attempts.map((a): TimelineEntry => ({ at: a.claimedAt, kind: 'attempt', attempt: a, actionType: typeOf.get(a.actionId) ?? 'unknown' })),
    ];
    entries.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
    return { run, actions, attempts, entries };
  });
}
