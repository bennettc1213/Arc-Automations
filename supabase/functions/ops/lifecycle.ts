/**
 * The operator surface of ARC-120's module lifecycle.
 *
 * Behind the `ops` function's existing admin check, like everything else in this
 * directory: by the time a request reaches here the caller's JWT has been verified and
 * `is_arc_admin()` has said yes, and the actor is the one taken from that token — never a
 * field in the body. This file translates HTTP to `lifecycle/engine.ts` and back; every
 * rule lives in the service and in 0015, so the tests exercise the rules, not the plumbing.
 *
 *   module-lifecycle-get     state, health, effective status, readiness, history
 *   module-lifecycle-history transitions, newest first
 *   module-select            unselected → configuring
 *   module-begin-testing     configuring | paused → testing
 *   module-stop-testing      testing → configuring
 *   module-enter-shadow      testing | paused → shadow
 *   module-exit-shadow       shadow → testing
 *   module-shadow-review     record an operator's review of shadow observations
 *   module-activate          testing | shadow → active
 *   module-pause             active → paused
 *   module-resume            paused → active, every gate re-checked
 *   module-deselect          any selected state → unselected
 *   module-health-report     set the health overlay, with evidence
 *   module-reconcile         evaluate any published change the lifecycle has not seen
 *
 * Every mutation needs `expected_state_version` — the version the operator's screen was
 * drawn from — and may carry an `idempotency_key`; a repeat of the key returns the first
 * answer. Each transition writes its own audit row inside the same transaction as the
 * change (0015 §9), so nothing is logged twice here.
 *
 * This is the backend contract ARC-320's console will render. It is not that console.
 */

import type { EngineStore } from '../_shared/engine/store.ts';
import { reconcileConfigChange } from '../_shared/lifecycle/impact.ts';
import {
  activateModule,
  beginTesting,
  deselectModule,
  enterShadow,
  exitShadow,
  getLifecycleStatus,
  type LifecycleOutcome,
  type LifecycleStatus,
  type OperatorRequest,
  pauseModule,
  recordShadowReview,
  reportHealth,
  resumeModule,
  selectModule,
  stopTesting,
} from '../_shared/lifecycle/engine.ts';
import {
  type EvidenceRow,
  LIFECYCLE_ERROR_STATUS,
  type LifecycleFailure,
  type LifecycleRow,
  type TransitionRow,
  type VersionPair,
} from '../_shared/lifecycle/model.ts';
import { canonicalModuleKey } from '../_shared/registry/modules.ts';

export const LIFECYCLE_ACTIONS = [
  'module-lifecycle-get',
  'module-lifecycle-history',
  'module-select',
  'module-begin-testing',
  'module-stop-testing',
  'module-enter-shadow',
  'module-exit-shadow',
  'module-shadow-review',
  'module-activate',
  'module-pause',
  'module-resume',
  'module-deselect',
  'module-health-report',
  'module-reconcile',
];

export interface LifecycleActionContext {
  store: EngineStore;
  body: Record<string, unknown>;
  /** from the verified JWT. null only if the caller somehow has no user. */
  actorId: string | null;
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

const ok = (body: Record<string, unknown>): ActionResponse => ({ body: { ok: true, ...body }, status: 200 });

export function lifecycleFailed(result: LifecycleFailure): ActionResponse {
  return {
    status: LIFECYCLE_ERROR_STATUS[result.code] ?? 409,
    body: {
      error: result.message,
      code: result.code,
      ...(result.blockers ? { blockers: result.blockers } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    },
  };
}

/* ── wire shapes: snake_case, as every ops response is ── */

const pairOut = (p: VersionPair | null) => (p ? { tenant_version_id: p.tenantVersionId, module_version_id: p.moduleVersionId } : null);

export function lifecycleOut(row: LifecycleRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    module_key: row.moduleKey,
    state: row.state,
    state_version: row.stateVersion,
    pending_requirements: row.pendingRequirements,
    observed: pairOut(row.observed),
    authorized: pairOut(row.authorized),
    tested: pairOut(row.tested),
    test_evidence_id: row.testEvidenceId,
    shadowed: pairOut(row.shadowed),
    shadow_evidence_id: row.shadowEvidenceId,
    health: { status: row.healthStatus, reason: row.healthReason, evidence: row.healthEvidence, checked_at: row.healthCheckedAt },
    updated_at: row.updatedAt,
  };
}

export function transitionOut(t: TransitionRow) {
  return {
    id: t.id,
    state_version: t.stateVersion,
    transition: t.transition,
    from_state: t.fromState,
    to_state: t.toState,
    actor_type: t.actorType,
    actor_id: t.actorId,
    reason_code: t.reasonCode,
    reason: t.reason,
    versions: pairOut(t.versions),
    previous_versions: pairOut(t.previousVersions),
    evidence_id: t.evidenceId,
    impact: t.impact,
    policy: t.policy,
    pending_before: t.pendingBefore,
    pending_after: t.pendingAfter,
    health_before: t.healthBefore,
    health_after: t.healthAfter,
    occurred_at: t.occurredAt,
  };
}

export function evidenceOut(e: EvidenceRow | null) {
  if (!e) return null;
  return {
    id: e.id,
    kind: e.kind,
    outcome: e.outcome,
    run_mode: e.runMode,
    versions: pairOut(e.versions),
    capabilities: e.capabilities,
    run_id: e.runId,
    simulated: true,
    summary: e.summary,
    recorded_at: e.recordedAt,
  };
}

export function statusOut(status: LifecycleStatus) {
  const { activation } = status;
  return {
    lifecycle: lifecycleOut(status.lifecycle),
    effective: status.effective,
    heads: pairOut(status.heads),
    readiness: {
      ok: activation.ok,
      blockers: activation.blockers,
      configuration: activation.config.ready
        ? { ready: true, versions: pairOut(activation.config.versions) }
        : { ready: false, code: activation.config.code, message: activation.config.message, field_errors: activation.config.fieldErrors },
      connections: activation.connections
        ? { ready: activation.connections.ready, capabilities: activation.connections.capabilities, blockers: activation.connections.blockers }
        : null,
      onboarding: activation.onboarding,
      test: { satisfied: activation.test.satisfied, evidence_id: activation.test.evidenceId, tested: pairOut(activation.test.testedVersions) },
      shadow: { required: activation.shadow.required, satisfied: activation.shadow.satisfied, evidence_id: activation.shadow.evidenceId },
      pending: activation.pending,
      health: activation.health,
    },
    transitions: status.transitions,
    history: status.history.map(transitionOut),
  };
}

function outcomeOut(result: LifecycleOutcome): ActionResponse {
  if (!result.ok) return lifecycleFailed(result);
  return ok({
    replayed: result.result.replayed,
    lifecycle: lifecycleOut(result.result.lifecycle),
    transition: transitionOut(result.result.transition),
    evidence: evidenceOut(result.result.evidence),
    cancelled_actions: result.result.cancelledActions,
    /* written by apply_tenant_module_transition in the same transaction as the change. */
    logged: true,
  });
}

/* ── request parsing ── */

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const integer = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

export async function handleLifecycleAction(action: string, context: LifecycleActionContext): Promise<ActionResponse> {
  const { store, body } = context;
  if (!context.actorId) return lifecycleFailed({ ok: false, code: 'unauthorized', message: 'not signed in' });

  const tenantId = text(body.tenant_id);
  if (!tenantId) return lifecycleFailed({ ok: false, code: 'module_not_found', message: 'tenant_id is required' });
  const moduleKey = canonicalModuleKey(text(body.module_key) || 'lead_recovery');
  if (!moduleKey) return lifecycleFailed({ ok: false, code: 'module_not_found', message: `"${text(body.module_key)}" is not a module` });

  const request: OperatorRequest = {
    tenantId,
    moduleKey,
    actor: { type: 'operator', id: context.actorId },
    expectedStateVersion: integer(body.expected_state_version),
    idempotencyKey: text(body.idempotency_key) || null,
    reason: text(body.reason) || null,
  };

  switch (action) {
    case 'module-lifecycle-get':
      return ok(statusOut(await getLifecycleStatus(store, tenantId, moduleKey, { historyLimit: integer(body.limit) ?? 10 })));

    case 'module-lifecycle-history': {
      const limit = Math.min(Math.max(integer(body.limit) ?? 50, 1), 200);
      const history = await store.listTransitions(tenantId, moduleKey, limit);
      return ok({ history: history.map(transitionOut) });
    }

    case 'module-select': return outcomeOut(await selectModule(store, request));
    case 'module-begin-testing': return outcomeOut(await beginTesting(store, request));
    case 'module-stop-testing': return outcomeOut(await stopTesting(store, request));
    case 'module-enter-shadow': return outcomeOut(await enterShadow(store, request));
    case 'module-exit-shadow': return outcomeOut(await exitShadow(store, request));
    case 'module-activate': return outcomeOut(await activateModule(store, request));
    case 'module-pause': return outcomeOut(await pauseModule(store, request));
    case 'module-resume': return outcomeOut(await resumeModule(store, request));
    case 'module-deselect': return outcomeOut(await deselectModule(store, request));

    case 'module-shadow-review': {
      const outcome = text(body.outcome);
      if (outcome !== 'passed' && outcome !== 'failed') {
        return lifecycleFailed({ ok: false, code: 'evidence_invalid', message: 'outcome must be "passed" or "failed"' });
      }
      return outcomeOut(await recordShadowReview(store, { ...request, passed: outcome === 'passed' }));
    }

    case 'module-health-report': {
      const evidence = typeof body.evidence === 'object' && body.evidence !== null && !Array.isArray(body.evidence)
        ? body.evidence as Record<string, unknown>
        : { source: 'operator' };
      return outcomeOut(await reportHealth(store, { ...request, status: body.status, evidence }));
    }

    case 'module-reconcile': {
      const outcome = await reconcileConfigChange(store, { tenantId, moduleKey });
      const lifecycle = await store.getLifecycle(tenantId, moduleKey);
      return ok({ outcome, lifecycle: lifecycleOut(lifecycle), logged: outcome.applied });
    }

    default:
      return lifecycleFailed({ ok: false, code: 'illegal_transition', message: `"${action}" is not a lifecycle action` });
  }
}
