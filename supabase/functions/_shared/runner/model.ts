/**
 * ARC-210 — the `AutomationRunner` contract (ADR ARC-010 §30).
 *
 * A runner moves authorised work; it does not know why the work was authorised. It never
 * decides whether an action may run, never reads or resolves tenant configuration, never
 * holds a credential, never writes operational state, never chooses retry timing and never
 * emits business evidence. ARC's scheduler (ARC-200) owns all of that, and the
 * orchestrator (`orchestrator.ts`) is the only code that turns what a runner says into a
 * durable write — through the scheduler's own service functions.
 *
 * The ADR's nine conceptual operations, and where each one lives:
 *
 *   dispatch              `AutomationRunner.dispatch`
 *   describeCapabilities  `AutomationRunner.describeCapabilities`
 *   classifyFailure       `AutomationRunner.classifyFailure`
 *   queryStatus           `AutomationRunner.queryStatus` — diagnostic, never authoritative
 *   requestCancellation   `AutomationRunner.requestCancellation` — best-effort only
 *   correlate             the result's `runnerExecutionId`, recorded on the attempt
 *   onCompletion          `settlementFor` + the orchestrator: a result proposes, ARC disposes
 *   onFailure             the same path — a failure is a result with a category
 *   handleTimeout         the orchestrator: an external effect that timed out is unknown,
 *                         never failed
 *
 * Nothing here names a particular runner. `FakeTestRunner` is one implementation; the
 * signed n8n bridge (ARC-220) and the direct worker are others, and all of them pass the
 * same contract suite (`tests/runner-contract.js`).
 */

import {
  type EffectClass,
  findSecretShaped,
  isPlainObject,
  type RunMode,
} from '../scheduler/model.ts';

/** Bumped only with a migration of every runner; a mismatch is refused, never guessed at. */
export const RUNNER_CONTRACT_VERSION = 1 as const;

/** The shape a runner kind takes — the same one 0017 checks on `runner_kind`. */
export const RUNNER_KIND = /^[a-z][a-z0-9_]{1,40}$/;

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/* ── the request ──────────────────────────────────────────── */

/** ARC connection metadata (0016). Never a credential: the runner asks the gateway for one. */
export interface RunnerConnectionRef {
  connectionId: string;
  connectorKey: string | null;
}

/**
 * Everything a runner is told. Identifiers and references, the scheduler's own payload
 * (already refused at scheduling if it held anything secret-shaped), and nothing it could
 * use to authenticate or to read configuration the run is not pinned to.
 */
export interface RunnerRequest {
  contractVersion: typeof RUNNER_CONTRACT_VERSION;
  runnerKind: string;
  tenantId: string;
  runId: string;
  actionId: string;
  attemptId: string;
  /** ARC's attempt number — never the runner's. */
  attemptNumber: number;
  moduleKey: string;
  moduleVersion: number | null;
  actionType: string;
  effectClass: EffectClass;
  /** the immutable snapshot the run is pinned to — a reference, never the values. */
  configSnapshotId: string;
  runMode: RunMode;
  correlationId: string;
  /** stable across every retry of this logical action: the key an external effect is sent under. */
  idempotencyKey: string;
  connection: RunnerConnectionRef | null;
  payload: Record<string, unknown>;
  issuedAt: string;
  /** after this ARC stops waiting; an external effect still running then is unknown. */
  deadline: string;
}

/**
 * Why a request is not fit to hand to any runner, or null when it is. The orchestrator
 * builds requests that pass; every runner may check again, and `FakeTestRunner` does.
 */
export function runnerRequestProblem(request: unknown): string | null {
  if (!isPlainObject(request)) return 'the request is not an object';
  const r = request as Record<string, unknown>;
  if (r.contractVersion !== RUNNER_CONTRACT_VERSION) return `contract version ${String(r.contractVersion)} is not ${RUNNER_CONTRACT_VERSION}`;
  for (const field of ['tenantId', 'runId', 'actionId', 'attemptId', 'moduleKey', 'actionType', 'correlationId', 'issuedAt', 'deadline'] as const) {
    if (typeof r[field] !== 'string' || !(r[field] as string).trim()) return `${field} is missing`;
  }
  if (typeof r.runnerKind !== 'string' || !RUNNER_KIND.test(r.runnerKind)) return 'runnerKind is not a runner kind';
  if (typeof r.configSnapshotId !== 'string' || !r.configSnapshotId) return 'the request is not pinned to a configuration snapshot';
  if (typeof r.idempotencyKey !== 'string' || !r.idempotencyKey.trim()) return 'the request carries no idempotency key';
  if (!Number.isInteger(r.attemptNumber) || (r.attemptNumber as number) < 1) return 'attemptNumber is ARC\'s attempt, from 1';
  if (!['live', 'test', 'shadow'].includes(r.runMode as string)) return 'runMode is live, test or shadow';
  if (!['none', 'external_read', 'external_effect'].includes(r.effectClass as string)) return 'effectClass is not one the scheduler knows';
  if (!isPlainObject(r.payload)) return 'payload is a plain object';
  if (r.connection !== null && !(isPlainObject(r.connection) && typeof (r.connection as Record<string, unknown>).connectionId === 'string')) {
    return 'connection is a reference or null';
  }
  const secret = findSecretShaped(request, '$request');
  if (secret) return `${secret} looks like a credential — a runner is never handed one`;
  return null;
}

/* ── the result ───────────────────────────────────────────── */

export const RUNNER_STATUSES = ['succeeded', 'failed', 'skipped', 'accepted'] as const;
export type RunnerStatus = typeof RUNNER_STATUSES[number];

/**
 * What a runner reports. It proposes; ARC validates it (`validateRunnerResult`) and
 * decides what it means (`settlementFor`).
 *
 * `accepted` — the backend took the work and will report its outcome later, through a
 * signed callback (ARC-220). Nothing is settled: the attempt stays running under its lease,
 * and if no callback settles it before the lease expires, 0017's sweep treats it exactly
 * like a worker that vanished — an external effect becomes ambiguous.
 *
 * `ambiguous` — the effect may or may not have happened. Only a failure can be ambiguous,
 * and an ambiguous failure is never retryable: a person reconciles it.
 * `retryable` — the runner asserts the attempt provably took no effect and may be tried
 * again. ARC's backoff decides when.
 */
export interface RunnerResult {
  status: RunnerStatus;
  retryable: boolean;
  ambiguous: boolean;
  errorCode: string | null;
  /** safe to display. the database replaces a secret-shaped one rather than store it. */
  message: string | null;
  evidence: Record<string, unknown>;
  evidenceRef: string | null;
  externalRequestId: string | null;
  runnerExecutionId: string;
}

const RESULT_FIELDS = new Set([
  'status', 'retryable', 'ambiguous', 'errorCode', 'message', 'evidence', 'evidenceRef', 'externalRequestId', 'runnerExecutionId',
]);

const optionalText = (v: unknown, max: number) => v === null || v === undefined || (typeof v === 'string' && v.length <= max);

export type ResultCheck = { ok: true; result: RunnerResult } | { ok: false; problem: string };

/** A runner's result, strictly: unknown fields and contradictions are refused, not repaired. */
export function validateRunnerResult(value: unknown): ResultCheck {
  const bad = (problem: string): ResultCheck => ({ ok: false, problem });
  if (!isPlainObject(value)) return bad('the result is not an object');
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !RESULT_FIELDS.has(k));
  if (unknown.length) return bad(`unknown result fields: ${unknown.join(', ')}`);
  if (!(RUNNER_STATUSES as readonly string[]).includes(v.status as string)) return bad('status is succeeded, failed, skipped or accepted');
  if (typeof v.retryable !== 'boolean' || typeof v.ambiguous !== 'boolean') return bad('retryable and ambiguous are booleans');
  if (v.status === 'accepted' && v.errorCode) return bad('an accepted dispatch has no error yet');
  if (v.ambiguous && v.status !== 'failed') return bad('only a failure can be ambiguous');
  if (v.ambiguous && v.retryable) return bad('an ambiguous outcome is never retryable — a person reconciles it');
  if (v.retryable && v.status !== 'failed') return bad('only a failure is retryable');
  if (v.errorCode !== null && v.errorCode !== undefined && (typeof v.errorCode !== 'string' || !CODE.test(v.errorCode))) {
    return bad('errorCode is a lower-case code');
  }
  if (v.status === 'failed' && !v.errorCode) return bad('a failure names its error code');
  if (!optionalText(v.message, 500)) return bad('message is text of at most 500 characters');
  if (!optionalText(v.evidenceRef, 300)) return bad('evidenceRef is text of at most 300 characters');
  if (!optionalText(v.externalRequestId, 200)) return bad('externalRequestId is text of at most 200 characters');
  if (typeof v.runnerExecutionId !== 'string' || !v.runnerExecutionId.trim() || v.runnerExecutionId.length > 200) {
    return bad('runnerExecutionId names the execution, in at most 200 characters');
  }
  const evidence = v.evidence ?? {};
  if (!isPlainObject(evidence)) return bad('evidence is a plain object');
  return {
    ok: true,
    result: {
      status: v.status as RunnerStatus,
      retryable: v.retryable,
      ambiguous: v.ambiguous,
      errorCode: (v.errorCode as string | null | undefined) ?? null,
      message: (v.message as string | null | undefined) ?? null,
      evidence,
      evidenceRef: (v.evidenceRef as string | null | undefined) ?? null,
      externalRequestId: (v.externalRequestId as string | null | undefined) ?? null,
      runnerExecutionId: v.runnerExecutionId,
    },
  };
}

/* ── the runner ───────────────────────────────────────────── */

export interface RunnerCapabilities {
  /** the action types this runner can execute. */
  actionTypes: readonly string[];
  /** the run modes it will execute them in. */
  runModes: readonly RunMode[];
}

/**
 * What a runner says about an exception it threw. `effectPossible: false` is a claim that
 * nothing left ARC — without it, an external effect that threw is unknown.
 */
export interface RunnerFailure {
  errorCode: string;
  retryable: boolean;
  effectPossible: boolean;
}

/** Diagnostic only: what the backend believes. ARC's rows stay authoritative. */
export interface RunnerExecutionStatus {
  runnerExecutionId: string;
  known: boolean;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
}

export interface AutomationRunner {
  readonly kind: string;
  describeCapabilities(): RunnerCapabilities;
  /**
   * Execute one authorised attempt. Never decides permission — by the time this is
   * called, the gate has been re-read and the attempt recorded as started. `signal` aborts
   * at the deadline; a runner that cannot stop in time is simply not waited for.
   */
  dispatch(request: RunnerRequest, signal: AbortSignal): Promise<RunnerResult>;
  classifyFailure(error: unknown): RunnerFailure;
  queryStatus(runnerExecutionId: string): Promise<RunnerExecutionStatus>;
  /** best-effort: ARC's own cancellation is authoritative and never waits on this. */
  requestCancellation(request: RunnerRequest): Promise<{ acknowledged: boolean }>;
}

/* ── from a result to a settlement ────────────────────────── */

/** What the orchestrator asks the scheduler to record, in the scheduler's own terms. */
export type Settlement =
  | { outcome: 'succeeded' | 'skipped'; errorCode: string | null; message: string | null }
  | { outcome: 'failed'; retryable: boolean; errorCode: string; message: string | null }
  | { outcome: 'ambiguous'; errorCode: string; message: string | null };

/**
 * The single place a runner's word becomes an outcome. What it may do depends on what the
 * action could have done: an action that touches nothing outside ARC — or only reads — is
 * safe to try again whatever went wrong; one that sends or mutates is not, unless the
 * runner proves it did nothing.
 */
export function settlementFor(
  effectClass: EffectClass,
  report:
    | { kind: 'result'; result: RunnerResult }
    | { kind: 'invalid'; problem: string }
    | { kind: 'timeout'; afterMs: number }
    | { kind: 'threw'; failure: RunnerFailure },
): Settlement {
  const effect = effectClass === 'external_effect';
  switch (report.kind) {
    case 'result': {
      const r = report.result;
      if (r.status === 'accepted') throw new Error('an accepted dispatch has no outcome yet — its callback settles it');
      if (r.status === 'succeeded' || r.status === 'skipped') return { outcome: r.status, errorCode: r.errorCode, message: r.message };
      if (r.ambiguous) return { outcome: 'ambiguous', errorCode: r.errorCode ?? 'ambiguous_outcome', message: r.message };
      return { outcome: 'failed', retryable: r.retryable, errorCode: r.errorCode ?? 'runner_failed', message: r.message };
    }
    case 'invalid':
      return effect
        ? { outcome: 'ambiguous', errorCode: 'runner_result_invalid', message: `the runner's result was refused (${report.problem}); whether the effect happened is unknown` }
        : { outcome: 'failed', retryable: true, errorCode: 'runner_result_invalid', message: `the runner's result was refused: ${report.problem}` };
    case 'timeout':
      return effect
        ? { outcome: 'ambiguous', errorCode: 'runner_timeout', message: `no result after ${report.afterMs} ms; the effect may have happened` }
        : { outcome: 'failed', retryable: true, errorCode: 'runner_timeout', message: `no result after ${report.afterMs} ms` };
    case 'threw': {
      const f = report.failure;
      if (effect && f.effectPossible) {
        return { outcome: 'ambiguous', errorCode: f.errorCode, message: 'the runner failed after the effect may have started' };
      }
      return { outcome: 'failed', retryable: f.retryable, errorCode: f.errorCode, message: 'the runner failed' };
    }
  }
}

/** A runner's own classification, or the safe assumption when it cannot give one. */
export function classifyOrAssume(runner: AutomationRunner, error: unknown): RunnerFailure {
  try {
    const f = runner.classifyFailure(error);
    if (f && typeof f.errorCode === 'string' && CODE.test(f.errorCode) && typeof f.retryable === 'boolean' && typeof f.effectPossible === 'boolean') {
      return f;
    }
  } catch {
    /* fall through: an unclassifiable failure is the worst case */
  }
  return { errorCode: 'runner_error', retryable: false, effectPossible: true };
}
