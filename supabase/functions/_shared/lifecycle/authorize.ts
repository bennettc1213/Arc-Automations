/**
 * ARC-120 — just-in-time execution authorisation. The one decision path.
 *
 * Called as close to the act as the code allows: when a new run would be created
 * (`intakeLead`), when a claimed action is about to execute (`executeAction`), and
 * immediately before an external effect is reserved (`authorizeLeadRecoveryEffect`, and
 * the staff-alert and acknowledgement paths). An earlier check anywhere else — a console
 * showing "live", a run that was allowed yesterday — is never taken as permission now.
 *
 * Three kinds of question, answered differently on purpose:
 *
 *   start     may a NEW run begin, under exactly the configuration it would be pinned to?
 *             live needs the module active, nothing pending, and the versions being pinned
 *             to be the versions an operator authorised.
 *   continue  may an EXISTING run's action execute, under its own immutable pin? the pin
 *             is never replaced; what is re-read is whether the run may still act at all.
 *   effect    may this run reach somebody right now? continue, plus the capability the
 *             effect uses.
 *
 * The decision order is fixed and documented (ARC_TENANT_MODULE_LIFECYCLE.md §10):
 * mode → identity and pins → tenant → registry → lifecycle state → mode against state →
 * requirements and authorised versions → health → configuration → connections. The first
 * refusal is returned with a stable code; nothing here writes, and a refusal reserves
 * nothing. The database re-checks the parts it can under a row lock (0015): a live run
 * cannot be inserted, and a live effect cannot be reserved, unless the lifecycle allows it
 * in that transaction.
 *
 * Customer state — consent, suppression, replies, takeover, safety handoffs — and the
 * send-once reservation are a module's live rules, and stay in the module's own effect
 * gate, which calls this first. Current safety state always overrides pinned behaviour.
 */

import type { ConfigStore } from '../config/store.ts';
import type { ActionRow, EngineStore, LeadRow, RunRow } from '../engine/store.ts';
import { isSelectable } from '../registry/modules.ts';
import {
  type ExecutionDenialCode,
  type LifecycleRow,
  normaliseRequirements,
  parseLifecycleState,
  parseRunMode,
  type RunMode,
  samePair,
  TESTABLE_STATES,
  type VersionPair,
} from './model.ts';
import { healthPermits, healthUseFor } from './policy.ts';
import { capabilityEvidence, currentHeads, evaluateConnectionReadiness } from './readiness.ts';
import type { LifecycleStore } from './store.ts';
import { latestSelectableModuleVersion } from '../registry/modules.ts';

export type AuthorizerStore = ConfigStore & LifecycleStore & Pick<EngineStore, 'getTenant' | 'getConfigSnapshot'>;

export type ExecutionKind = 'start' | 'continue' | 'effect';

export interface ExecutionRequest {
  kind: ExecutionKind;
  tenantId: string;
  moduleKey: string;
  /** for `start`: the mode asked for. for `continue`/`effect`: ignored — the run's own mode. */
  mode?: unknown;
  lead: Pick<LeadRow, 'id' | 'tenantId' | 'isCanary'>;
  run?: RunRow | null;
  action?: ActionRow | null;
  /** for `start`: the versions the new run would be pinned to. */
  versions?: VersionPair | null;
  /** for `start` and `effect`: the configuration in force (resolved, or pinned). */
  config?: Record<string, unknown> | null;
  /** for `effect`: the capability the effect uses, e.g. `send_sms`. */
  capability?: string | null;
}

export interface DecisionProvenance {
  kind: ExecutionKind;
  mode: RunMode | null;
  tenant_id: string;
  module_key: string;
  run_id: string | null;
  action_id: string | null;
  snapshot_id: string | null;
  lifecycle_id: string | null;
  state: string | null;
  state_version: number | null;
  health: string | null;
  authorized: VersionPair | null;
  /** the checks that passed, in order, up to the decision. */
  checks: string[];
}

export type ExecutionDecision =
  | { allowed: true; mode: RunMode; provenance: DecisionProvenance }
  | { allowed: false; code: ExecutionDenialCode; detail: string; terminal: boolean; mode: RunMode | null; provenance: DecisionProvenance };

export async function authorizeModuleExecution(store: AuthorizerStore, req: ExecutionRequest): Promise<ExecutionDecision> {
  const provenance: DecisionProvenance = {
    kind: req.kind,
    mode: null,
    tenant_id: req.tenantId,
    module_key: req.moduleKey,
    run_id: req.run?.id ?? null,
    action_id: req.action?.id ?? null,
    snapshot_id: req.run?.configSnapshotId ?? null,
    lifecycle_id: null,
    state: null,
    state_version: null,
    health: null,
    authorized: null,
    checks: [],
  };
  const deny = (code: ExecutionDenialCode, detail: string, terminal = true): ExecutionDecision =>
    ({ allowed: false, code, detail, terminal, mode: provenance.mode, provenance });
  const passed = (check: string) => provenance.checks.push(check);

  /* ── 1. the mode. missing or unknown is never live. ── */
  let mode: RunMode | null;
  if (req.kind === 'start') {
    mode = parseRunMode(req.mode);
    if (!mode) return deny('invalid_run_mode', `"${String(req.mode)}" is not a run mode — nothing starts without one`);
  } else {
    if (!req.run) return deny('identity_mismatch', 'an existing run is required to continue');
    mode = parseRunMode(req.run.runMode);
    if (!mode) {
      return deny('run_authorization_unproven', 'this run predates lifecycle authorisation (ARC-120), so nothing proves it was allowed to start — it may not act');
    }
  }
  provenance.mode = mode;
  passed('mode');

  /* ── 2. identity and pins: tenant, module, run, action, snapshot all agree. ── */
  if (req.lead.tenantId !== req.tenantId) return deny('identity_mismatch', 'the lead belongs to another tenant');
  if (req.run) {
    if (req.run.tenantId !== req.tenantId) return deny('identity_mismatch', 'the run belongs to another tenant');
    if (req.run.moduleKey !== req.moduleKey) return deny('identity_mismatch', `the run is ${req.run.moduleKey}, not ${req.moduleKey}`);
    if (req.run.leadId !== req.lead.id) return deny('identity_mismatch', 'the run is for a different lead');
    if (!req.run.configSnapshotId) return deny('snapshot_missing', 'the run is not pinned to a configuration snapshot');
  }
  if (req.action) {
    if (!req.run || req.action.runId !== req.run.id) return deny('identity_mismatch', 'the action belongs to a different run');
    if (req.action.tenantId !== req.tenantId) return deny('identity_mismatch', 'the action belongs to another tenant');
    if (!req.action.configSnapshotId) return deny('snapshot_missing', 'the action carries no configuration snapshot — a legacy row may never act');
    if (req.action.configSnapshotId !== req.run.configSnapshotId) {
      return deny('snapshot_mismatch', 'the action is pinned to a different snapshot than its run');
    }
  }
  if (req.run?.configSnapshotId) {
    const snapshot = await store.getConfigSnapshot(req.tenantId, req.run.configSnapshotId);
    if (!snapshot) return deny('snapshot_missing', 'the snapshot this run is pinned to cannot be read for this tenant');
    if (snapshot.tenantId !== req.tenantId || snapshot.moduleKey !== req.moduleKey) {
      return deny('snapshot_mismatch', 'the snapshot belongs to another tenant or module');
    }
  }
  if (mode === 'test' && !req.lead.isCanary) return deny('mode_not_permitted', 'test mode is for synthetic leads only');
  if (mode !== 'test' && req.lead.isCanary) return deny('mode_not_permitted', `a synthetic lead may only run in test mode, never ${mode}`);
  if (mode === 'shadow' && req.kind !== 'start') {
    return deny('shadow_no_effects', 'a shadow run records what would have happened — it never acts');
  }
  passed('identity');

  /* ── 3. the tenant. ── */
  const tenant = await store.getTenant(req.tenantId);
  if (!tenant) return deny('tenant_missing', 'this tenant no longer exists');
  if (tenant.status === 'archived') return deny('tenant_archived', 'this client has been archived — nothing further runs for them');
  if (tenant.status === 'paused') return deny('tenant_paused', 'this client is paused — nothing runs while they are');
  passed('tenant');

  /* ── 4. the registry still offers the module. ── */
  if (!isSelectable(req.moduleKey)) return deny('module_unavailable', `${req.moduleKey} has no selectable version in the registry`);
  passed('registry');

  /* ── 5. the lifecycle. ── */
  const lifecycle = await store.getLifecycle(req.tenantId, req.moduleKey);
  const state = lifecycle ? parseLifecycleState(lifecycle.state) : 'unselected';
  if (lifecycle) {
    provenance.lifecycle_id = lifecycle.id;
    provenance.state = lifecycle.state;
    provenance.state_version = lifecycle.stateVersion;
    provenance.health = lifecycle.healthStatus;
    provenance.authorized = lifecycle.authorized;
  }
  if (!state) return deny('lifecycle_state_unknown', `the stored lifecycle state "${lifecycle?.state}" is not one this build knows`);
  if (state === 'unselected') return deny('module_not_selected', `${req.moduleKey} is not selected for this client`);
  passed('lifecycle');

  /* ── 6. the mode against the state. ── */
  if (mode === 'live' && state !== 'active') {
    return state === 'paused'
      ? deny('module_paused', `${req.moduleKey} is paused — nothing live runs until an operator resumes it`)
      : deny('module_not_active', `${req.moduleKey} is ${state}, not active — nothing live runs`);
  }
  if (mode === 'test' && !TESTABLE_STATES.includes(state)) {
    return deny('module_not_active', `${req.moduleKey} is ${state} — begin testing before running a synthetic test`);
  }
  if (mode === 'shadow' && state !== 'shadow') {
    return deny('module_not_active', `${req.moduleKey} is ${state}, not in shadow`);
  }
  passed('state');

  /* ── 7. a new live run: nothing pending, and exactly the authorised versions. ── */
  if (mode === 'live' && req.kind === 'start') {
    const pending = normaliseRequirements(lifecycle!.pendingRequirements);
    if (pending.length > 0) {
      return deny('requirements_pending', `a published change requires ${pending.join(', ')} before new live runs`);
    }
    const heads = await currentHeads(store, req.tenantId, req.moduleKey);
    if (!heads || !samePair(lifecycle!.authorized, heads)) {
      return deny('authorization_stale', 'the published configuration is not the one an operator authorised — new live runs are held');
    }
    if (!req.versions || !samePair(req.versions, heads)) {
      return deny('authorization_stale', 'this run would be pinned to configuration other than the authorised current versions');
    }
    passed('authorized_versions');
  }

  /* ── 8. health. an overlay: it can stop execution, it never changes the state. ── */
  const health = lifecycle!.healthStatus;
  if (!healthPermits(health, healthUseFor(mode, req.kind))) {
    return deny('health_blocks_execution', `health is ${health}${lifecycle!.healthReason ? ` — ${lifecycle!.healthReason}` : ''}`, false);
  }
  passed('health');

  /* ── 9. configuration, for a new run: the caller resolved it or it does not start.
     before connections, which are judged against it. ── */
  if (req.kind === 'start') {
    if (!req.config || !req.versions) return deny('config_not_ready', 'there is no resolved configuration to pin a run to');
    passed('config');
  }

  /* ── 10. connections, for anything that reaches the world. ── */
  if (mode === 'live' && req.kind !== 'continue') {
    const version = latestSelectableModuleVersion(req.moduleKey);
    const [completedSteps, hasIntakeKey] = await Promise.all([
      store.listCompletedOnboardingSteps(req.tenantId, req.moduleKey),
      store.hasActiveIntakeKey(req.tenantId),
    ]);
    const unhealthy = unhealthyCapabilities(lifecycle!);
    const evidence = { config: req.config ?? null, completedSteps, hasActiveIntakeKey: hasIntakeKey, unhealthyCapabilities: unhealthy };
    if (req.kind === 'start') {
      const readiness = evaluateConnectionReadiness(version!, evidence);
      if (!readiness.ready) {
        return deny('connection_not_ready', readiness.blockers.map((b) => b.message).join('; ') || 'a required capability cannot be proven ready');
      }
    } else if (req.capability) {
      const one = capabilityEvidence(req.capability, evidence);
      if (one.status !== 'ready') return deny('connection_not_ready', `${req.capability} is ${one.status}: ${one.reason}`);
    }
    passed('connections');
  }

  return { allowed: true, mode, provenance };
}

function unhealthyCapabilities(lifecycle: LifecycleRow): string[] {
  const list = lifecycle.healthEvidence?.capabilities;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
}
