/**
 * ARC-320 — the activation console's two reads and one write that are not already lifecycle
 * or connection actions.
 *
 *   activation-overview  { tenant_id, module_key, limit? }
 *                        one module, everything the console draws: ARC-120's lifecycle,
 *                        effective status, readiness and history; each requirement group with
 *                        its capabilities, ARC-120's verdict on each, and every provider that
 *                        could serve it — with the tenant's connection, as ARC-130's safe
 *                        summary, its display word, its credential hint and its latest test;
 *                        the module's test and shadow evidence; the version numbers behind
 *                        the heads, the authorised pair and the tested pair.
 *
 *   connection-test      { tenant_id, module_key, connection_id, idempotency_key? }
 *                        a `connector_test` run and a `test_connection` action, recorded
 *                        before anything happens (ARC-200), then the console's pass through
 *                        the ARC-210 orchestrator. Answers with the run, the action, what the
 *                        pass did — or why it deferred — and the test as ARC's rows now say.
 *
 * Everything else the console does is an existing action, unchanged: the lifecycle
 * transitions and health reports are ./lifecycle.ts, Lead Recovery's synthetic test is
 * `lead-recovery-canary`, and connecting, reauthorising and disconnecting a provider are the
 * `connections` function's (ARC-130), which checks the same operator again. There is no
 * second way to activate, pause or resume anything.
 *
 * Nothing in a response is a credential: connections leave as `summarize()` output only, and
 * a test's evidence and message are what 0017 accepted — it refuses a credential-shaped
 * payload or evidence, and replaces a credential-shaped message, before either is stored.
 */

import type { EngineStore } from '../_shared/engine/store.ts';
import { getLifecycleStatus } from '../_shared/lifecycle/engine.ts';
import { canonicalModuleKey } from '../_shared/registry/modules.ts';
import type { SchedulerStore } from '../_shared/scheduler/store.ts';
import type { RunnerRegistry } from '../_shared/runner/registry.ts';
import {
  CONNECTION_TEST_ERROR_STATUS,
  type ConnectionTestLog,
  type ConnectionTestStore,
  requestConnectionTest,
  runConsolePass,
} from '../_shared/activation/connection-test.ts';
import { connectionPanel, moduleHeader, pairNumbers, recentTestEvidence } from '../_shared/activation/overview.ts';
import { evidenceOut, statusOut } from './lifecycle.ts';

export const ACTIVATION_ACTIONS = ['activation-overview', 'connection-test'];

export type RunnersFor = () => Promise<{ registry: RunnerRegistry; reason?: undefined } | { registry: null; reason: string }>;

export interface ActivationActionContext {
  store: EngineStore & ConnectionTestStore;
  scheduler: SchedulerStore;
  tests: ConnectionTestLog | null;
  body: Record<string, unknown>;
  /** from the verified JWT. null only if the caller somehow has no user. */
  actorId: string | null;
  audit: (verb: string, targetType: string | null, targetId: string | null, metadata?: Record<string, unknown>) => Promise<boolean>;
  /** the runners the console's pass may use — built only when a test is requested. */
  runners: RunnersFor;
  worker?: string;
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const integer = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const refused = (code: string, message: string, status?: number): ActionResponse => ({
  status: status ?? CONNECTION_TEST_ERROR_STATUS[code] ?? 409,
  body: { error: message, code },
});

export async function handleActivationAction(action: string, context: ActivationActionContext): Promise<ActionResponse> {
  const { store, body } = context;
  if (!context.actorId) return refused('unauthorized', 'not signed in');

  const tenantId = text(body.tenant_id);
  if (!tenantId) return refused('invalid_request', 'tenant_id is required');
  const moduleKey = canonicalModuleKey(text(body.module_key) || 'lead_recovery');
  if (!moduleKey) return refused('module_not_found', `"${text(body.module_key)}" is not a module`);

  if (action === 'activation-overview') {
    const status = await getLifecycleStatus(store, tenantId, moduleKey, { historyLimit: Math.min(Math.max(integer(body.limit) ?? 25, 1), 100) });
    const lifecycle = status.lifecycle;
    const [panel, heads, authorized, tested, current, recent, shadowReview, observations] = await Promise.all([
      connectionPanel(store, { tenantId, moduleKey, capabilities: status.activation.connections?.capabilities ?? [], tests: context.tests }),
      pairNumbers(store, tenantId, moduleKey, status.heads),
      pairNumbers(store, tenantId, moduleKey, lifecycle?.authorized ?? null),
      pairNumbers(store, tenantId, moduleKey, lifecycle?.tested ?? null),
      lifecycle?.testEvidenceId ? store.getEvidence(tenantId, moduleKey, lifecycle.testEvidenceId) : Promise.resolve(null),
      recentTestEvidence(store, tenantId, moduleKey, 5),
      lifecycle?.shadowEvidenceId ? store.getEvidence(tenantId, moduleKey, lifecycle.shadowEvidenceId) : Promise.resolve(null),
      status.heads ? store.listEvidence(tenantId, moduleKey, { kind: 'shadow_observation', versions: status.heads, limit: 500 }) : Promise.resolve([]),
    ]);
    return {
      status: 200,
      body: {
        ok: true,
        module: moduleHeader(moduleKey),
        status: statusOut(status),
        versions: { heads, authorized, tested },
        evidence: {
          test: evidenceOut(current),
          recent_tests: recent.map(evidenceOut),
          shadow_review: evidenceOut(shadowReview),
          shadow_observations: observations.length,
        },
        requirements: panel.requirements,
        connections: panel.connections,
        tests: panel.tests,
      },
    };
  }

  if (action === 'connection-test') {
    /* the runners first: the run names the kind that will execute it, and 0017 fixes that on
       the run for good. without runners the test is still recorded, under ARC's own kind, and
       waits for the scheduler worker. */
    const built = await context.runners();
    const requested = await requestConnectionTest({ store, scheduler: context.scheduler }, {
      tenantId,
      moduleKey,
      connectionId: body.connection_id,
      actorId: context.actorId,
      idempotencyKey: body.idempotency_key,
      runnerKind: built.registry?.defaultKind,
    });
    if (!requested.ok) return refused(requested.code, requested.message);
    const { run, action: queued } = requested;

    const logged = await context.audit('connection.test_requested', 'provider_connection', queued.connectionId, {
      tenant_id: tenantId,
      module_key: moduleKey,
      run_id: run.id,
      action_id: queued.id,
      replayed: !requested.created,
    });

    const pass = built.registry
      ? await runConsolePass({ store: context.scheduler, runners: built.registry, worker: context.worker ?? 'ops-activation' }, tenantId)
      : { executed: [], deferred: { reason: built.reason, waiting: 1 } };
    const test = context.tests ? (await context.tests.recent(tenantId, 20)).find((t) => t.action_id === queued.id) ?? null : null;

    return {
      status: 200,
      body: {
        ok: true,
        replayed: !requested.created,
        run_id: run.id,
        action_id: queued.id,
        pass: {
          executed: pass.executed.map((r) => ({
            action_id: r.actionId,
            action_type: r.actionType,
            runner_kind: r.runnerKind,
            outcome: r.outcome,
            code: r.code,
            action_status: r.actionStatus,
            run_status: r.runStatus,
          })),
          deferred: pass.deferred,
        },
        test,
        logged,
      },
    };
  }

  return refused('invalid_request', `"${action}" is not an activation action`, 400);
}
