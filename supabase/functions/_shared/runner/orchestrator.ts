/**
 * ARC-210 — from a due action to a settled attempt, through a runner.
 *
 *   claim → resolve the runner → start (the gate is re-read) → build the request →
 *   dispatch, with a deadline → settle → finish the run if nothing is left
 *
 * Every write goes through the ARC-200 scheduler service, so every rule 0017 enforces —
 * the lease, the gate, send-once, the backoff, dead-lettering — holds whichever runner ran.
 * The runner is consulted for exactly one thing: what happened. Whether the action may run
 * was decided before it is called, and what its report means is decided after, here and
 * in `settlementFor`, by what the action could have done:
 *
 *   * an action that touches nothing outside ARC, or only reads, is safe to try again
 *     whatever went wrong — a timeout, a crash, a garbled result;
 *   * one that sends or mutates is not. Unless the runner says in a valid result that
 *     it did nothing, an unknown outcome is recorded as ambiguous and the action is
 *     blocked for a person. Nothing here resends it.
 *
 * Actions are claimed one at a time, so each is dispatched on a fresh lease: a slow
 * runner early in a batch cannot eat the lease of the action after it.
 */

import { actionType, findSecretShaped, type AutomationAction, type AutomationRun, ok, refuse, type SchedulerResult } from '../scheduler/model.ts';
import type { SchedulerStore, SettleResult } from '../scheduler/store.ts';
import {
  claimDueActions,
  type ClaimedAction,
  completeFailure,
  completeSkipped,
  completeSuccess,
  finishRun,
  markAmbiguous,
  startAttempt,
} from '../scheduler/service.ts';
import {
  type AutomationRunner,
  classifyOrAssume,
  RUNNER_CONTRACT_VERSION,
  runnerRequestProblem,
  type RunnerRequest,
  type RunnerResult,
  type Settlement,
  settlementFor,
  validateRunnerResult,
} from './model.ts';
import type { RunnerRegistry } from './registry.ts';

/** Time kept back from the lease, so a settlement is written while the lease still holds. */
const LEASE_MARGIN_MS = 10_000;

export interface OrchestratorDeps {
  store: SchedulerStore;
  runners: RunnerRegistry;
  /** names the lease holder on every claim. */
  worker: string;
  now?: () => Date;
}

export interface ExecuteOptions {
  /** one tenant, or `null` for every tenant — written out, as the scheduler requires. */
  tenantId: string | null;
  /** at most this many actions, each claimed on its own. */
  limit?: number;
  leaseSeconds?: number;
  /** how long ARC waits for a runner; must end inside the lease. */
  timeoutMs?: number;
  /** close a run once none of its actions is waiting, in flight or ambiguous. default true. */
  finishSettledRuns?: boolean;
}

/** What happened to one claimed action. */
export interface ExecutionReport {
  actionId: string;
  runId: string;
  tenantId: string;
  actionType: string;
  runnerKind: string | null;
  /** whether the request reached a runner. */
  dispatched: boolean;
  /** the recorded outcome; `accepted` when a callback will settle it; null when nothing was settled. */
  outcome: Settlement['outcome'] | 'accepted' | null;
  /** `ok`, `awaiting_callback`, or why it did not run or did not settle. */
  code: string;
  actionStatus: string | null;
  attemptNumber: number | null;
  /** set when this settlement closed the run. */
  runStatus: string | null;
}

/**
 * Claim and execute due actions until `limit` is reached or nothing is due. A refusal of
 * the claim itself is returned; everything after it is reported per action.
 */
export async function executeDueActions(deps: OrchestratorDeps, options: ExecuteOptions): Promise<SchedulerResult<ExecutionReport[]>> {
  const limit = options.limit ?? 25;
  const leaseSeconds = options.leaseSeconds ?? 120;
  const timeoutMs = options.timeoutMs ?? Math.max(1_000, leaseSeconds * 1000 - 30_000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return refuse('invalid_request', 'limit is 1–500');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > leaseSeconds * 1000 - LEASE_MARGIN_MS) {
    return refuse('invalid_request', `timeoutMs must end at least ${LEASE_MARGIN_MS / 1000}s inside the ${leaseSeconds}s lease`);
  }

  const reports: ExecutionReport[] = [];
  while (reports.length < limit) {
    const claimed = await claimDueActions(deps.store, { tenantId: options.tenantId, worker: deps.worker, limit: 1, leaseSeconds });
    if (!claimed.ok) return reports.length ? ok(reports) : claimed;
    if (!claimed.value.length) break;
    reports.push(await executeClaimedAction(deps, claimed.value[0], { timeoutMs, finishSettledRuns: options.finishSettledRuns ?? true }));
  }
  return ok(reports);
}

/** Execute one action this worker holds the lease on. */
export async function executeClaimedAction(
  deps: OrchestratorDeps,
  claimed: ClaimedAction,
  options: { timeoutMs: number; finishSettledRuns?: boolean },
): Promise<ExecutionReport> {
  const { action, lease } = claimed;
  const now = deps.now ?? (() => new Date());
  const report: ExecutionReport = {
    actionId: action.id, runId: action.runId, tenantId: action.tenantId, actionType: action.actionType,
    runnerKind: null, dispatched: false, outcome: null, code: 'ok', actionStatus: null, attemptNumber: null, runStatus: null,
  };
  const type = actionType(action.actionType);
  const run = await deps.store.getRun(action.tenantId, action.runId);

  /* ── which runner, and can it do this? ── */
  const kind = run?.runnerKind ?? deps.runners.defaultKind;
  const runner = deps.runners.resolve(kind);
  let unfit: { code: string; message: string } | null = null;
  if (!type || !run) {
    unfit = { code: 'runner_request_refused', message: 'the action or its run could not be read' };
  } else if (!runner) {
    unfit = { code: 'runner_unknown', message: `no runner of kind ${kind} is registered in this worker` };
  } else {
    const caps = runner.describeCapabilities();
    if (!caps.actionTypes.includes(action.actionType) || !run.runMode || !caps.runModes.includes(run.runMode)) {
      unfit = { code: 'runner_unsupported', message: `${kind} does not execute ${action.actionType} in ${run.runMode ?? 'an unset'} mode` };
    }
  }

  /* ── start: the gate is re-read; nothing runs on the claim's answer ── */
  // An unknown kind is not stamped on the run: 0017 fixes a run's runner once written.
  const started = await startAttempt(deps.store, lease, { runnerKind: unfit?.code === 'runner_unknown' ? null : kind });
  if (!started.ok) return { ...report, code: started.code };
  report.attemptNumber = started.value.attemptNo;
  report.runnerKind = unfit?.code === 'runner_unknown' ? null : kind;

  if (unfit) return await record(deps, report, lease, run, { outcome: 'failed', retryable: false, errorCode: unfit.code, message: unfit.message }, null, options);

  /* ── the request: references, the scheduler's payload, no secrets ── */
  const issuedAt = now();
  const built = buildRunnerRequest({
    run: run!, action, runnerKind: kind, attemptId: started.value.attemptId!, attemptNumber: started.value.attemptNo!,
    issuedAt: issuedAt.toISOString(), deadline: new Date(issuedAt.getTime() + options.timeoutMs).toISOString(),
  });
  if (!built.ok) {
    return await record(deps, report, lease, run, { outcome: 'failed', retryable: false, errorCode: 'runner_request_refused', message: built.message }, null, options);
  }

  /* ── dispatch, with a deadline ── */
  report.dispatched = true;
  const outcome = await dispatchWithDeadline(runner!, built.value, options.timeoutMs);
  let settlement: Settlement;
  let result: RunnerResult | null = null;
  if (outcome.kind === 'returned') {
    const checked = validateRunnerResult(outcome.value);
    if (checked.ok && checked.result.status === 'accepted') {
      // the backend took it; its signed callback settles the attempt under this lease.
      return { ...report, outcome: 'accepted', code: 'awaiting_callback', actionStatus: 'running' };
    }
    if (checked.ok) {
      result = checked.result;
      settlement = settlementFor(type!.effectClass, { kind: 'result', result });
    } else {
      settlement = settlementFor(type!.effectClass, { kind: 'invalid', problem: checked.problem });
    }
  } else if (outcome.kind === 'timeout') {
    settlement = settlementFor(type!.effectClass, { kind: 'timeout', afterMs: options.timeoutMs });
    // best-effort, and never waited on for the decision above.
    runner!.requestCancellation(built.value).catch(() => {});
  } else {
    settlement = settlementFor(type!.effectClass, { kind: 'threw', failure: classifyOrAssume(runner!, outcome.error) });
  }

  return await record(deps, report, lease, run, settlement, result, options);
}

/* ── the request ──────────────────────────────────────────── */

/**
 * The request for one started attempt. Refused — never repaired — if the run and action
 * disagree about the snapshot, if anything identifying is missing, or if anything in it is
 * shaped like a credential.
 */
export function buildRunnerRequest(input: {
  run: AutomationRun;
  action: AutomationAction;
  runnerKind: string;
  attemptId: string;
  attemptNumber: number;
  issuedAt: string;
  deadline: string;
}): SchedulerResult<RunnerRequest> {
  const { run, action } = input;
  const type = actionType(action.actionType);
  if (!type) return refuse('unknown_action_type', `${action.actionType} is not in the vocabulary`);
  if (!action.configSnapshotId || action.configSnapshotId !== run.configSnapshotId) {
    return refuse('runner_request_refused', 'the action is not pinned to its run\'s configuration snapshot');
  }
  if (run.id !== action.runId || run.tenantId !== action.tenantId) return refuse('runner_request_refused', 'the action does not belong to that run');
  if (!run.runMode) return refuse('runner_request_refused', 'the run has no mode');
  if (!run.correlationId) return refuse('runner_request_refused', 'the run has no correlation id');

  const request: RunnerRequest = {
    contractVersion: RUNNER_CONTRACT_VERSION,
    runnerKind: input.runnerKind,
    tenantId: action.tenantId,
    runId: run.id,
    actionId: action.id,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    moduleKey: action.moduleKey,
    moduleVersion: run.moduleVersion,
    actionType: type.key,
    effectClass: type.effectClass,
    configSnapshotId: action.configSnapshotId,
    runMode: run.runMode,
    correlationId: run.correlationId,
    idempotencyKey: action.idempotencyKey,
    connection: action.connectionId ? { connectionId: action.connectionId, connectorKey: action.connectorKey } : null,
    payload: structuredClone(action.payload ?? {}),
    issuedAt: input.issuedAt,
    deadline: input.deadline,
  };
  const problem = runnerRequestProblem(request);
  if (problem) return refuse('runner_request_refused', problem);
  return ok(request);
}

/* ── the call ─────────────────────────────────────────────── */

type Dispatched =
  | { kind: 'returned'; value: unknown }
  | { kind: 'threw'; error: unknown }
  | { kind: 'timeout' };

async function dispatchWithDeadline(runner: AutomationRunner, request: RunnerRequest, timeoutMs: number): Promise<Dispatched> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Dispatched>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ kind: 'timeout' }); }, timeoutMs);
  });
  // a runner gets its own copy: nothing it does to the request reaches ARC's.
  const call = Promise.resolve()
    .then(() => runner.dispatch(structuredClone(request), controller.signal))
    .then((value): Dispatched => ({ kind: 'returned', value }), (error): Dispatched => ({ kind: 'threw', error }));
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/* ── the settlement ───────────────────────────────────────── */

/**
 * Record a settlement for the attempt this lease holds — from the orchestrator, or from a
 * runner's signed callback (ARC-220), which settles through the same four service calls.
 * Evidence is what happened, never how to authenticate: a result carrying anything
 * secret-shaped has its evidence withheld, and its outcome is still recorded.
 */
export async function settleAttempt(
  store: SchedulerStore,
  lease: ClaimedAction['lease'],
  settlement: Settlement,
  result: RunnerResult | null,
): Promise<SchedulerResult<SettleResult>> {
  let evidence = result?.evidence ?? {};
  let evidenceRef = result?.evidenceRef ?? null;
  if (findSecretShaped(evidence) || (evidenceRef && findSecretShaped(evidenceRef))) {
    evidence = { evidence_withheld: 'credential_shaped' };
    evidenceRef = null;
  }
  const detail = {
    errorCode: settlement.errorCode,
    message: settlement.message,
    evidence,
    evidenceRef,
    externalRequestId: result?.externalRequestId ?? null,
    runnerExecutionId: result?.runnerExecutionId ?? null,
  };
  return settlement.outcome === 'succeeded' ? await completeSuccess(store, lease, detail)
    : settlement.outcome === 'skipped' ? await completeSkipped(store, lease, detail)
    : settlement.outcome === 'ambiguous' ? await markAmbiguous(store, lease, detail)
    : await completeFailure(store, lease, { ...detail, retryable: settlement.retryable });
}

async function record(
  deps: OrchestratorDeps,
  report: ExecutionReport,
  lease: ClaimedAction['lease'],
  run: AutomationRun | null,
  settlement: Settlement,
  result: RunnerResult | null,
  options: { finishSettledRuns?: boolean },
): Promise<ExecutionReport> {
  const settled = await settleAttempt(deps.store, lease, settlement, result);
  if (!settled.ok) return { ...report, code: settled.code };

  const out: ExecutionReport = { ...report, outcome: settlement.outcome, code: 'ok', actionStatus: settled.value.actionStatus };
  if (run && (options.finishSettledRuns ?? true)) out.runStatus = await finishRunIfSettled(deps.store, run.tenantId, run.id);
  return out;
}

const OUTSTANDING = new Set(['pending', 'claimed', 'running', 'blocked']);

/**
 * Close a run whose actions have all reached an end: `failed` if any of them failed or was
 * dead-lettered, `completed` otherwise. A run with anything waiting, in flight or
 * ambiguous is left open — and if another worker queues something in the meantime, the
 * database refuses the close (`actions_outstanding`), which is the answer, not an error.
 * Returns the run's new status, or null when it stays open.
 */
export async function finishRunIfSettled(store: SchedulerStore, tenantId: string, runId: string): Promise<string | null> {
  const actions = await store.listActionsForRun(tenantId, runId);
  if (!actions.length || actions.some((a) => OUTSTANDING.has(a.status))) return null;
  const dead = actions.some((a) => a.status === 'dead_letter');
  const failed = dead || actions.some((a) => a.status === 'failed');
  const finished = await finishRun(store, {
    tenantId, runId,
    status: failed ? 'failed' : 'completed',
    code: dead ? 'action_dead_lettered' : failed ? 'action_failed' : 'actions_settled',
  });
  return finished.ok ? finished.value.runStatus : null;
}
