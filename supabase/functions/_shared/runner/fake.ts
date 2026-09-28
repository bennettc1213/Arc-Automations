/**
 * ARC-210 — `FakeTestRunner`: a real `AutomationRunner` that does nothing outside the
 * process, scripted per logical action so a test can say exactly what each attempt
 * reports.
 *
 * It contacts nothing — no provider, no n8n, no Supabase, no network — and it is a test
 * double in the ARC-130 sense: it refuses to exist unless the runtime environment is
 * explicitly development or test (`connections/runtime-env.ts`), so a worker that nobody
 * configured cannot report a message as sent when nothing was sent.
 *
 * It also checks what it is handed, as every runner may: a request with anything
 * secret-shaped in it, no pinned snapshot or no idempotency key is a contract violation,
 * recorded in `violations` and refused. Tests assert that list stays empty.
 */

import { assertTestDoubleAllowed, type RuntimeEnvironment } from '../connections/runtime-env.ts';
import { RUN_MODES, type RunMode, schedulerActionTypes } from '../scheduler/model.ts';
import {
  type AutomationRunner,
  type RunnerCapabilities,
  type RunnerExecutionStatus,
  type RunnerFailure,
  type RunnerRequest,
  runnerRequestProblem,
  type RunnerResult,
} from './model.ts';

/** What one attempt of one logical action does. Steps are consumed in order, per idempotency key. */
export type FakeStep =
  | { do: 'succeed'; evidence?: Record<string, unknown>; evidenceRef?: string; externalRequestId?: string; delayMs?: number }
  | { do: 'fail'; retryable: boolean; errorCode?: string; message?: string; delayMs?: number }
  | { do: 'ambiguous'; errorCode?: string; message?: string; delayMs?: number }
  | { do: 'skip'; delayMs?: number }
  /** take the work and report nothing yet — as a backend that answers by callback does. */
  | { do: 'accept'; delayMs?: number }
  /** throw instead of returning; `effectPossible: false` claims nothing left the process. */
  | { do: 'throw'; effectPossible: boolean; retryable?: boolean; errorCode?: string }
  /** never answer; resolves only when ARC gives up at the deadline. */
  | { do: 'hang' }
  /** return this value verbatim, however malformed. */
  | { do: 'return'; value: unknown };

export class FakeRunnerError extends Error {
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly effectPossible: boolean;
  constructor(errorCode: string, message: string, options: { retryable: boolean; effectPossible: boolean }) {
    super(message);
    this.name = 'FakeRunnerError';
    this.errorCode = errorCode;
    this.retryable = options.retryable;
    this.effectPossible = options.effectPossible;
  }
}

const abortError = () => new FakeRunnerError('runner_aborted', 'ARC stopped waiting', { retryable: false, effectPossible: true });

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export interface FakeTestRunnerOptions {
  environment: RuntimeEnvironment;
  kind?: string;
  actionTypes?: readonly string[];
  runModes?: readonly RunMode[];
  /** what an attempt does when nothing was scripted for its action. */
  defaultStep?: FakeStep;
}

export class FakeTestRunner implements AutomationRunner {
  readonly kind: string;
  /** every request, as handed over (frozen copies). */
  readonly received: RunnerRequest[] = [];
  /** every request this runner refused as a breach of the contract. */
  readonly violations: { request: unknown; problem: string }[] = [];
  readonly cancellations: RunnerRequest[] = [];

  private readonly capabilities: RunnerCapabilities;
  private readonly defaultStep: FakeStep;
  private readonly scripts = new Map<string, FakeStep[]>();
  private readonly executions = new Map<string, RunnerExecutionStatus['state']>();

  constructor(options: FakeTestRunnerOptions) {
    assertTestDoubleAllowed(options.environment, 'the fake test runner');
    this.kind = options.kind ?? 'fake_test';
    this.capabilities = Object.freeze({
      actionTypes: Object.freeze([...(options.actionTypes ?? schedulerActionTypes())]),
      runModes: Object.freeze([...(options.runModes ?? RUN_MODES)]),
    });
    this.defaultStep = options.defaultStep ?? { do: 'succeed' };
  }

  /** Queue what the next attempts of the action with this idempotency key will do. */
  script(idempotencyKey: string, ...steps: FakeStep[]): this {
    this.scripts.set(idempotencyKey, [...(this.scripts.get(idempotencyKey) ?? []), ...steps]);
    return this;
  }

  describeCapabilities(): RunnerCapabilities {
    return this.capabilities;
  }

  async dispatch(request: RunnerRequest, signal: AbortSignal): Promise<RunnerResult> {
    const problem = runnerRequestProblem(request)
      ?? (request.runnerKind !== this.kind ? `the request is for ${request.runnerKind}, not ${this.kind}` : null)
      ?? (!this.capabilities.actionTypes.includes(request.actionType) ? `${request.actionType} is not a type this runner executes` : null);
    if (problem) {
      this.violations.push({ request, problem });
      throw new FakeRunnerError('contract_violation', problem, { retryable: false, effectPossible: false });
    }
    this.received.push(deepFreeze(structuredClone(request)));

    const executionId = `${this.kind}:${request.attemptId}`;
    this.executions.set(executionId, 'running');
    const queue = this.scripts.get(request.idempotencyKey);
    const step = queue?.length ? queue.shift()! : this.defaultStep;

    try {
      const result = await this.perform(step, request, executionId, signal);
      this.executions.set(executionId, result.status === 'failed' ? 'failed' : result.status === 'accepted' ? 'running' : 'succeeded');
      return result;
    } catch (error) {
      this.executions.set(executionId, signal.aborted ? 'unknown' : 'failed');
      throw error;
    }
  }

  private async perform(step: FakeStep, request: RunnerRequest, executionId: string, signal: AbortSignal): Promise<RunnerResult> {
    if ('delayMs' in step && step.delayMs) await wait(step.delayMs, signal);
    const base = {
      retryable: false, ambiguous: false, errorCode: null, message: null, evidence: {}, evidenceRef: null,
      externalRequestId: null, runnerExecutionId: executionId,
    };
    switch (step.do) {
      case 'succeed':
        return {
          ...base, status: 'succeeded',
          evidence: step.evidence ?? { runner: this.kind, action_type: request.actionType, attempt: request.attemptNumber },
          evidenceRef: step.evidenceRef ?? null,
          externalRequestId: step.externalRequestId ?? null,
        };
      case 'fail':
        return { ...base, status: 'failed', retryable: step.retryable, errorCode: step.errorCode ?? 'fake_failure', message: step.message ?? null };
      case 'ambiguous':
        return { ...base, status: 'failed', ambiguous: true, errorCode: step.errorCode ?? 'fake_ambiguous', message: step.message ?? null };
      case 'skip':
        return { ...base, status: 'skipped' };
      case 'accept':
        return { ...base, status: 'accepted' };
      case 'throw':
        throw new FakeRunnerError(step.errorCode ?? 'fake_exception', 'the fake runner threw as scripted', {
          retryable: step.retryable ?? false, effectPossible: step.effectPossible,
        });
      case 'hang':
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        throw abortError();
      case 'return':
        return step.value as RunnerResult;
    }
  }

  classifyFailure(error: unknown): RunnerFailure {
    if (error instanceof FakeRunnerError) {
      return { errorCode: error.errorCode, retryable: error.retryable, effectPossible: error.effectPossible };
    }
    return { errorCode: 'runner_error', retryable: false, effectPossible: true };
  }

  // deno-lint-ignore require-await
  async queryStatus(runnerExecutionId: string): Promise<RunnerExecutionStatus> {
    const state = this.executions.get(runnerExecutionId);
    return { runnerExecutionId, known: state !== undefined, state: state ?? 'unknown' };
  }

  // deno-lint-ignore require-await
  async requestCancellation(request: RunnerRequest): Promise<{ acknowledged: boolean }> {
    this.cancellations.push(request);
    const id = `${this.kind}:${request.attemptId}`;
    if (this.executions.get(id) === 'running') this.executions.set(id, 'cancelled');
    return { acknowledged: true };
  }
}
