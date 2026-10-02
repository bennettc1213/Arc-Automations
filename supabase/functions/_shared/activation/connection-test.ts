/**
 * ARC-320 — testing a provider connection, durably.
 *
 * "Test connection" on the activation console is not a fetch the browser waits on. It is
 * ARC-200 work, recorded before anything happens:
 *
 *   1. the request is checked: an operator, a connection of this client that has not ended
 *      and is past authorisation, a provider this module could use, and a module whose
 *      lifecycle allows a test run (testing, shadow, active or paused — 0015's own rule);
 *   2. a `connector_test` run in `test` mode is created, pinned to a snapshot of the
 *      module's current published configuration, and a `test_connection` action is queued
 *      on it naming the connection — never a credential (0017 refuses one in a payload);
 *   3. the console's pass executes it through the ARC-210 orchestrator — claim, re-read the
 *      gate at the start, dispatch with a deadline, settle — so the attempt row, its outcome
 *      and its evidence are the same rows a scheduler worker would have written.
 *
 * The runner that does the work in every environment is `ConnectionTestRunner`: ARC's own
 * in-process worker, which asks ARC-130's `verifyConnection` — through the provider's
 * registered adapter only, with the credential resolved inside that service for that one
 * verification. It holds no credential and writes nothing itself; the connection's new
 * status is written by ARC-130's service under ARC-130's rules. Tests hand the same queue to
 * `FakeTestRunner` instead, which contacts nothing.
 *
 * The console's pass is deliberately narrow. It claims by tenant, so it runs only when
 * everything due for this client is work its runners execute; otherwise the test stays
 * queued for the scheduler worker, and the console says so rather than failing somebody
 * else's action as "unsupported".
 */

import { ConnectionError, parseConnectionStatus } from '../connections/model.ts';
import { type ConnectionServiceDeps, verifyConnection } from '../connections/service.ts';
import type { ConnectorCatalog } from '../connections/catalog.ts';
import { resolveEffectiveConfig } from '../config/engine.ts';
import type { ConfigStore } from '../config/store.ts';
import type { ConfigSnapshotRow } from '../engine/store.ts';
import { parseLifecycleState, TESTABLE_STATES } from '../lifecycle/model.ts';
import type { LifecycleStore } from '../lifecycle/store.ts';
import { getModule, latestSelectableModuleVersion } from '../registry/modules.ts';
import { requiredCapabilities } from '../registry/resolve.ts';
import { actionType, type AutomationAction, type AutomationRun } from '../scheduler/model.ts';
import { createAutomationRun, listDueActions, scheduleAutomationAction } from '../scheduler/service.ts';
import type { SchedulerStore } from '../scheduler/store.ts';
import { toAction, toAttempt } from '../scheduler/supabase-scheduler-store.ts';
import { executeDueActions, type ExecutionReport } from '../runner/orchestrator.ts';
import type { RunnerRegistry } from '../runner/registry.ts';
import {
  type AutomationRunner,
  type RunnerCapabilities,
  type RunnerExecutionStatus,
  type RunnerFailure,
  type RunnerRequest,
  runnerRequestProblem,
  type RunnerResult,
} from '../runner/model.ts';

export const CONNECTION_TEST_ACTION = 'test_connection';
export const CONNECTION_TEST_RUNNER = 'arc_connection_test';

/* ── the runner ─────────────────────────────────────────── */

/** Provider trouble that says nothing about the grant: trying again later is the right answer. */
const TRANSIENT = new Set(['provider_unavailable', 'refresh_in_progress', 'rate_limited', 'vault_unavailable']);

/**
 * ARC's in-process runner for `test_connection`, in test mode only. A verification reads the
 * provider and changes nothing there (`external_read`), so any failure is safe to retry —
 * but only a transient one is worth retrying, and the scheduler's backoff decides when.
 */
export class ConnectionTestRunner implements AutomationRunner {
  readonly kind = CONNECTION_TEST_RUNNER;
  private readonly executions = new Map<string, RunnerExecutionStatus['state']>();
  private readonly connections: ConnectionServiceDeps;

  constructor(connections: ConnectionServiceDeps) {
    this.connections = connections;
  }

  describeCapabilities(): RunnerCapabilities {
    return Object.freeze({ actionTypes: Object.freeze([CONNECTION_TEST_ACTION]), runModes: Object.freeze(['test' as const]) });
  }

  async dispatch(request: RunnerRequest, _signal: AbortSignal): Promise<RunnerResult> {
    const problem = runnerRequestProblem(request)
      ?? (request.actionType !== CONNECTION_TEST_ACTION ? `${request.actionType} is not a connection test` : null)
      ?? (request.runMode !== 'test' ? 'a connection test runs in test mode only' : null)
      ?? (!request.connection?.connectionId ? 'a connection test names its connection' : null);
    const executionId = `${this.kind}:${request.attemptId}`;
    const base = {
      retryable: false, ambiguous: false, errorCode: null, message: null, evidence: {}, evidenceRef: null,
      externalRequestId: null, runnerExecutionId: executionId,
    };
    if (problem) {
      this.executions.set(executionId, 'failed');
      return { ...base, status: 'failed', errorCode: 'runner_request_refused', message: problem };
    }

    this.executions.set(executionId, 'running');
    try {
      const { connection } = await verifyConnection(this.connections, {
        tenantId: request.tenantId,
        connectionId: request.connection!.connectionId,
        actorId: null,
        correlationId: request.correlationId,
      });
      const evidence = {
        connector_key: connection.connector_key,
        connection_status: connection.status,
        verified_capabilities: [...connection.verified_capabilities],
        serves: connection.usable,
      };
      if (connection.usable) {
        this.executions.set(executionId, 'succeeded');
        return { ...base, status: 'succeeded', evidence };
      }
      this.executions.set(executionId, 'failed');
      return {
        ...base, status: 'failed', evidence, errorCode: 'capability_mismatch',
        message: `the provider answered, but the connection is ${connection.status} — it does not serve what it was granted for`,
      };
    } catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      this.executions.set(executionId, 'failed');
      /* ARC's own code and sentence. a provider's body never reaches a ConnectionError. */
      return { ...base, status: 'failed', errorCode: error.code, message: error.message.slice(0, 300), retryable: TRANSIENT.has(error.code) };
    }
  }

  classifyFailure(error: unknown): RunnerFailure {
    /* dispatch returns every failure it understands; what reaches here is not understood,
       and the contract's safe assumption is that it may have done something. */
    return { errorCode: error instanceof ConnectionError ? error.code : 'runner_error', retryable: false, effectPossible: true };
  }

  // deno-lint-ignore require-await
  async queryStatus(runnerExecutionId: string): Promise<RunnerExecutionStatus> {
    const state = this.executions.get(runnerExecutionId);
    return { runnerExecutionId, known: state !== undefined, state: state ?? 'unknown' };
  }

  /** An in-process verification cannot be interrupted; ARC's own cancellation still stands. */
  // deno-lint-ignore require-await
  async requestCancellation(_request: RunnerRequest): Promise<{ acknowledged: boolean }> {
    return { acknowledged: false };
  }
}

/* ── requesting a test ──────────────────────────────────── */

/** What `requestConnectionTest` reads: configuration, lifecycle, snapshots and connections. */
export type ConnectionTestStore = ConfigStore & Pick<LifecycleStore, 'getLifecycle'> & {
  createConfigSnapshot(row: Omit<ConfigSnapshotRow, 'id' | 'createdAt'>): Promise<ConfigSnapshotRow>;
  getConnection(tenantId: string, connectionId: string): Promise<{ id: string; tenantId: string; connectorKey: string; status: string; statusVersion: number } | null>;
  readonly connectorCatalog?: ConnectorCatalog;
};

export const CONNECTION_TEST_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  unauthorized: 401,
  invalid_request: 400,
  module_not_found: 404,
  not_found: 404,
  connection_ended: 409,
  connection_not_testable: 409,
  connection_not_used: 422,
  module_not_testing: 409,
  config_not_ready: 409,
});

export type ConnectionTestRefusal = { ok: false; code: string; message: string };
export type Requested = { ok: true; run: AutomationRun; action: AutomationAction; created: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (code: string, message: string): ConnectionTestRefusal => ({ ok: false, code, message });

/** The connectors a module version could use, read from the catalog this runtime serves. */
function connectorsFor(moduleKey: string, catalog: ConnectorCatalog | undefined): Set<string> {
  const version = latestSelectableModuleVersion(moduleKey);
  if (!version || !catalog) return new Set();
  const all = requiredCapabilities(version);
  const capabilities = [...new Set([...all.required, ...all.optional, ...all.conditional])];
  return new Set(capabilities.flatMap((c) => catalog.connectorsProviding(c).map((v) => v.connectorKey)));
}

export async function requestConnectionTest(
  deps: { store: ConnectionTestStore; scheduler: SchedulerStore },
  input: { tenantId: string; moduleKey: string; connectionId: unknown; actorId: string | null; idempotencyKey?: unknown; runnerKind?: string; now?: Date },
): Promise<Requested | ConnectionTestRefusal> {
  if (!input.actorId) return refuse('unauthorized', 'not signed in');
  if (!UUID.test(input.tenantId)) return refuse('invalid_request', 'tenant_id is a uuid');
  if (!getModule(input.moduleKey)) return refuse('module_not_found', `${input.moduleKey} is not a registered module`);
  const connectionId = typeof input.connectionId === 'string' && UUID.test(input.connectionId) ? input.connectionId : null;
  if (!connectionId) return refuse('invalid_request', 'connection_id is required');

  /* another client's connection and no connection are the same answer. */
  const connection = await deps.store.getConnection(input.tenantId, connectionId);
  if (!connection) return refuse('not_found', 'no such connection for this client');
  const status = parseConnectionStatus(connection.status);
  if (status === 'revoked' || status === 'disconnected') {
    return refuse('connection_ended', `this connection was ${status} — reconnect the provider; a new connection is tested, never this one`);
  }
  if (!status || status === 'authorization_pending' || status === 'failed') {
    return refuse('connection_not_testable', status ? `this connection is ${status} — finish authorising it before testing it` : 'this connection is in a status this build does not know');
  }
  if (!connectorsFor(input.moduleKey, deps.store.connectorCatalog).has(connection.connectorKey)) {
    return refuse('connection_not_used', `${input.moduleKey} does not use ${connection.connectorKey} — test it from a module that does`);
  }

  const lifecycle = await deps.store.getLifecycle(input.tenantId, input.moduleKey);
  const state = lifecycle ? parseLifecycleState(lifecycle.state) : 'unselected';
  if (!state || !TESTABLE_STATES.includes(state)) {
    return refuse('module_not_testing', `${input.moduleKey} is ${state ?? 'in an unknown state'} — a test run needs it in testing, shadow, active or paused. Begin testing first.`);
  }

  const resolution = await resolveEffectiveConfig(deps.store, input.tenantId, input.moduleKey);
  if (!resolution.ok) return refuse('config_not_ready', `the configuration a test is pinned to cannot be resolved: ${resolution.message}`);
  const snapshot = await deps.store.createConfigSnapshot({
    tenantId: input.tenantId,
    moduleKey: input.moduleKey,
    configVersion: resolution.moduleVersion.version,
    schemaVersion: resolution.moduleVersion.schemaVersion,
    config: resolution.config,
    configHash: resolution.configHash,
    tenantConfigVersionId: resolution.tenantVersion.id,
    moduleConfigVersionId: resolution.moduleVersion.id,
  });

  const key = typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(input.idempotencyKey)
    ? input.idempotencyKey
    : crypto.randomUUID();
  const created = await createAutomationRun(deps.scheduler, {
    tenantId: input.tenantId,
    runKind: 'connector_test',
    moduleKey: input.moduleKey,
    configSnapshotId: snapshot.id,
    runMode: 'test',
    correlationId: crypto.randomUUID(),
    idempotencyKey: `connection-test:${key}`,
    runnerKind: input.runnerKind ?? CONNECTION_TEST_RUNNER,
    createdBy: { type: 'operator', id: input.actorId },
  });
  if (!created.ok) return refuse(created.code, created.message);
  const run = created.value.run;

  const queued = await scheduleAutomationAction(deps.scheduler, {
    tenantId: input.tenantId,
    runId: run.id,
    actionType: CONNECTION_TEST_ACTION,
    runAt: (input.now ?? new Date()).toISOString(),
    idempotencyKey: `${CONNECTION_TEST_ACTION}:${run.id}`,
    connectionId: connection.id,
    /* the connection is named by reference; the database records its connector. */
    payload: { requested_by: 'activation_console' },
  });
  if (!queued.ok) return refuse(queued.code, queued.message);
  return { ok: true, run, action: queued.value.action, created: created.value.created };
}

/* ── the console's pass ─────────────────────────────────── */

export interface ConsolePass {
  executed: ExecutionReport[];
  /** set when the pass did not run: what was due that this pass's runners do not execute. */
  deferred: { reason: string; waiting: number } | null;
}

/**
 * Execute this client's due work through the given runners — but only if every due action
 * is one they execute. A claim is by tenant, and an action claimed by a worker that cannot
 * run it is failed as unsupported; so rather than risk someone else's work, the pass defers.
 */
export async function runConsolePass(
  deps: { store: SchedulerStore; runners: RunnerRegistry; worker: string },
  tenantId: string,
): Promise<ConsolePass> {
  const due = await listDueActions(deps.store, { tenantId, asOf: new Date().toISOString(), limit: 50 });
  if (!due.ok) return { executed: [], deferred: { reason: due.message, waiting: 0 } };
  const executable = new Set(deps.runners.kinds().flatMap((k) => deps.runners.resolve(k)?.describeCapabilities().actionTypes ?? []));
  /* only the scheduler's own types are ever claimed here; the Lead Recovery engine's are
     claimed by its dispatcher and never by this path, so they are not in the way. */
  const claimable = due.value.filter((a) => actionType(a.actionType)?.dispatcher === 'scheduler');
  const foreign = claimable.filter((a) => !executable.has(a.actionType));
  if (foreign.length > 0) {
    return {
      executed: [],
      deferred: {
        reason: `other work is due for this client (${[...new Set(foreign.map((a) => a.actionType))].join(', ')}) — the test waits for the scheduler worker`,
        waiting: claimable.length,
      },
    };
  }
  if (claimable.length === 0) return { executed: [], deferred: null };
  const result = await executeDueActions(
    { store: deps.store, runners: deps.runners, worker: deps.worker },
    { tenantId, limit: Math.min(claimable.length, 10), leaseSeconds: 60, timeoutMs: 20_000 },
  );
  return result.ok ? { executed: result.value, deferred: null } : { executed: [], deferred: { reason: result.message, waiting: claimable.length } };
}

/* ── reading the results back ───────────────────────────── */

export interface ConnectionTestRecord {
  connection_id: string | null;
  connector_key: string | null;
  run_id: string;
  action_id: string;
  run_status: string;
  action_status: string;
  requested_at: string;
  completed_at: string | null;
  attempts: number;
  outcome: string | null;
  error_code: string | null;
  /** ARC's own sentence; 0017 replaces a secret-shaped one before it is stored. */
  message: string | null;
  evidence: Record<string, unknown>;
  gate: { code: string; detail: string | null } | null;
}

/** Where the console reads connection tests from. */
export interface ConnectionTestLog {
  recent(tenantId: string, limit?: number): Promise<ConnectionTestRecord[]>;
}

/**
 * The connection tests of one client, newest first, from ARC's own rows: the action, its
 * run, and its last attempt. Evidence is what the runner reported and 0017 accepted — the
 * scheduler refuses anything credential-shaped in it before it is written.
 */
// deno-lint-ignore no-explicit-any
export function supabaseConnectionTestLog(db: { from(table: string): any }): ConnectionTestLog {
  return {
    async recent(tenantId, limit = 20) {
      const actions = await db.from('scheduled_actions').select('*')
        .eq('tenant_id', tenantId).eq('action_type', CONNECTION_TEST_ACTION)
        .order('created_at', { ascending: false }).limit(limit);
      if (actions.error) throw new Error(`connection test read: ${actions.error.message}`);
      const rows = (actions.data ?? []).map(toAction);
      if (rows.length === 0) return [];
      const runIds = [...new Set(rows.map((a: AutomationAction) => a.runId))];
      const [runs, attempts] = await Promise.all([
        db.from('automation_runs').select('id, status').eq('tenant_id', tenantId).in('id', runIds),
        db.from('automation_action_attempts').select('*').eq('tenant_id', tenantId).in('action_id', rows.map((a: AutomationAction) => a.id)),
      ]);
      if (runs.error) throw new Error(`connection test run read: ${runs.error.message}`);
      if (attempts.error) throw new Error(`connection test attempt read: ${attempts.error.message}`);
      const runStatus = new Map<string, string>((runs.data ?? []).map((r: { id: string; status: string }) => [r.id, r.status]));
      const last = new Map<string, ReturnType<typeof toAttempt>>();
      for (const attempt of (attempts.data ?? []).map(toAttempt)) {
        const seen = last.get(attempt.actionId);
        if (!seen || attempt.attemptNo > seen.attemptNo) last.set(attempt.actionId, attempt);
      }
      return rows.map((action: AutomationAction): ConnectionTestRecord => {
        const attempt = last.get(action.id) ?? null;
        const outcome = attempt ? ({ succeeded: 'succeeded', failed: 'failed', ambiguous: 'ambiguous', skipped: 'skipped' } as Record<string, string>)[attempt.status] ?? null : null;
        return {
          connection_id: action.connectionId,
          connector_key: action.connectorKey,
          run_id: action.runId,
          action_id: action.id,
          run_status: runStatus.get(action.runId) ?? 'unknown',
          action_status: action.status,
          requested_at: action.createdAt,
          completed_at: action.completedAt,
          attempts: action.attempts,
          outcome,
          error_code: attempt?.errorCode ?? null,
          message: attempt?.errorMessage ?? action.lastError ?? null,
          evidence: attempt?.evidence ?? {},
          gate: action.gate && action.gate.code !== 'ok' ? { code: action.gate.code, detail: action.gate.detail } : null,
        };
      });
    },
  };
}
