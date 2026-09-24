/**
 * The lifecycle tables, in memory — `MemoryStore`'s half of ARC-120.
 *
 * Each rule here is one 0015 enforces, named after the object that enforces it, so a test
 * that passes against this store is a test about behaviour Postgres also guarantees:
 *
 *   applyLifecycleTransition   apply_tenant_module_transition()
 *   guardEvidence              tenant_module_evidence_guard()
 *   guardLifecycleChange       tenant_modules_guard()
 *   guardRunLifecycle          automation_runs_guard_lifecycle()
 *   guardEffectLifecycle       the lifecycle check 0015 adds to reserve_lead_recovery_effect()
 *
 * `tests/lifecycle-db.test.js` runs the same promises against real SQL where PGlite is
 * available. `MemoryStore` extends this class, so one test object holds the whole database;
 * the operational tables the guards read (runs, leads, actions, snapshots, intake keys) are
 * declared here for that reason and filled by `MemoryStore`.
 */

import { MemoryConfigStore } from '../config/memory.ts';
import type { ActionRow, ConfigSnapshotRow, IntakeKeyRow, LeadRow, RunRow } from '../engine/store.ts';
import { getModule, getModuleVersion, isSelectable } from '../registry/modules.ts';
import { classifyChain, versionsBetween } from './impact.ts';
import {
  type EvidenceRow,
  expandedTransitionRules,
  type LifecycleRow,
  LifecycleStoreError,
  type NewEvidence,
  normaliseRequirements,
  parseLifecycleState,
  parseRunMode,
  samePair,
  TESTABLE_STATES,
  type TransitionRow,
  type VersionPair,
} from './model.ts';
import type { ImpactClassification } from './policy.ts';
import type { LifecycleStore, TransitionRequest, TransitionResult } from './store.ts';

export interface OnboardingStepRow {
  tenantId: string;
  moduleKey: string;
  stepKey: string;
  doneAt: string | null;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const SECRET_SHAPED = /(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )/i;
const refuse = (code: ConstructorParameters<typeof LifecycleStoreError>[0], message: string): never => {
  throw new LifecycleStoreError(code, message);
};

/** Action types that put a person on a lead or close it out — bookkeeping, not contact. */
const BOOKKEEPING_ACTIONS = ['open_handoff', 'close_run'];

export class MemoryLifecycleStore extends MemoryConfigStore implements LifecycleStore {
  /* the operational tables 0015's guards read. `MemoryStore` owns their behaviour. */
  intakeKeys: IntakeKeyRow[] = [];
  leads: LeadRow[] = [];
  runs: RunRow[] = [];
  actions: ActionRow[] = [];
  snapshots: ConfigSnapshotRow[] = [];

  /* 0015 */
  lifecycles: LifecycleRow[] = [];
  lifecycleTransitions: TransitionRow[] = [];
  lifecycleEvidence: EvidenceRow[] = [];
  /** module_onboarding (0010): the operator checklist. */
  onboardingSteps: OnboardingStepRow[] = [];

  // ── reads ──
  // deno-lint-ignore require-await
  async getLifecycle(tenantId: string, moduleKey: string) {
    const row = this.lifecycles.find((l) => l.tenantId === tenantId && l.moduleKey === moduleKey);
    return row ? clone(row) : null;
  }

  // deno-lint-ignore require-await
  async listLifecycles(tenantId: string) {
    return this.lifecycles.filter((l) => l.tenantId === tenantId).map(clone);
  }

  // deno-lint-ignore require-await
  async listTransitions(tenantId: string, moduleKey: string, limit: number) {
    return this.lifecycleTransitions
      .filter((t) => t.tenantId === tenantId && t.moduleKey === moduleKey)
      .sort((a, b) => b.stateVersion - a.stateVersion)
      .slice(0, limit)
      .map(clone);
  }

  // deno-lint-ignore require-await
  async findTransitionByKey(tenantId: string, moduleKey: string, idempotencyKey: string) {
    const row = this.lifecycleTransitions.find((t) => t.tenantId === tenantId && t.moduleKey === moduleKey && t.idempotencyKey === idempotencyKey);
    return row ? clone(row) : null;
  }

  // deno-lint-ignore require-await
  async getEvidence(tenantId: string, moduleKey: string, evidenceId: string) {
    const row = this.lifecycleEvidence.find((e) => e.id === evidenceId && e.tenantId === tenantId && e.moduleKey === moduleKey);
    return row ? clone(row) : null;
  }

  // deno-lint-ignore require-await
  async listEvidence(tenantId: string, moduleKey: string, options: { kind?: EvidenceRow['kind']; versions?: VersionPair; limit: number }) {
    return this.lifecycleEvidence
      .filter((e) => e.tenantId === tenantId && e.moduleKey === moduleKey)
      .filter((e) => !options.kind || e.kind === options.kind)
      .filter((e) => !options.versions || samePair(e.versions, options.versions))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, options.limit)
      .map(clone);
  }

  // deno-lint-ignore require-await
  async listCompletedOnboardingSteps(tenantId: string, moduleKey: string) {
    return this.onboardingSteps.filter((s) => s.tenantId === tenantId && s.moduleKey === moduleKey && s.doneAt).map((s) => s.stepKey);
  }

  // deno-lint-ignore require-await
  async hasActiveIntakeKey(tenantId: string) {
    return this.intakeKeys.some((k) => k.tenantId === tenantId && k.revokedAt === null);
  }

  // ── helpers the guards share ──

  protected heads(tenantId: string, moduleKey: string): VersionPair | null {
    const top = (rows: { id: string; version: number }[]) => rows.reduce<{ id: string; version: number } | null>((b, v) => (!b || v.version > b.version ? v : b), null);
    const tenant = top(this.tenantConfigVersions.filter((v) => v.tenantId === tenantId));
    const module = top(this.moduleConfigVersions.filter((v) => v.tenantId === tenantId && v.moduleKey === moduleKey));
    return tenant && module ? { tenantVersionId: tenant.id, moduleVersionId: module.id } : null;
  }

  /** `lifecycle_chain_classes()`: the recorded impact of every version from `from` to `to`. */
  protected chainClasses(tenantId: string, moduleKey: string, from: VersionPair, to: VersionPair): Set<ImpactClassification> {
    const tenant = versionsBetween(this.tenantConfigVersions.filter((v) => v.tenantId === tenantId), from.tenantVersionId, to.tenantVersionId);
    const module = versionsBetween(
      this.moduleConfigVersions.filter((v) => v.tenantId === tenantId && v.moduleKey === moduleKey),
      from.moduleVersionId,
      to.moduleVersionId,
    );
    if (!tenant.ok || !module.ok) return new Set(['unclassified']);
    return new Set(classifyChain(moduleKey, { tenant: tenant.steps, module: module.steps }).flatMap((s) => s.classifications));
  }

  private versionsBelong(tenantId: string, moduleKey: string, pair: VersionPair): boolean {
    return this.tenantConfigVersions.some((v) => v.id === pair.tenantVersionId && v.tenantId === tenantId)
      && this.moduleConfigVersions.some((v) => v.id === pair.moduleVersionId && v.tenantId === tenantId && v.moduleKey === moduleKey);
  }

  private snapshotPair(tenantId: string, snapshotId: string | null): VersionPair | null {
    const s = this.snapshots.find((x) => x.id === snapshotId && x.tenantId === tenantId);
    return s?.tenantConfigVersionId && s.moduleConfigVersionId
      ? { tenantVersionId: s.tenantConfigVersionId, moduleVersionId: s.moduleConfigVersionId }
      : null;
  }

  // ── tenant_module_evidence_guard ──
  protected guardEvidence(
    tenantId: string,
    moduleKey: string,
    lifecycle: LifecycleRow,
    evidence: NewEvidence,
    actor: { type: string; id: string | null },
  ): void {
    if (!this.versionsBelong(tenantId, moduleKey, evidence.versions)) {
      refuse('evidence_invalid', 'evidence must name this tenant\'s own versions of this module');
    }
    if (!/^[0-9a-f]{64}$/.test(evidence.configHash)) refuse('evidence_invalid', 'evidence carries the hash of the configuration it concerns');
    if (SECRET_SHAPED.test(JSON.stringify(evidence.summary ?? {}))) {
      throw new Error('new row violates check constraint "tenant_module_evidence_no_secrets"');
    }
    const run = evidence.runId ? this.runs.find((r) => r.id === evidence.runId && r.tenantId === tenantId) : null;
    if (evidence.kind === 'test') {
      if (!run || run.moduleKey !== moduleKey) refuse('evidence_invalid', 'a test names the synthetic run it came from');
      if (run!.runMode !== 'test' || evidence.runMode !== 'test') refuse('evidence_invalid', 'only a run in test mode is evidence of a test');
      const lead = this.leads.find((l) => l.id === run!.leadId && l.tenantId === tenantId);
      if (!lead?.isCanary) refuse('evidence_invalid', 'a test is a synthetic lead');
      if (!samePair(this.snapshotPair(tenantId, run!.configSnapshotId), evidence.versions)) {
        refuse('evidence_invalid', 'a test is evidence only for the versions its run was pinned to');
      }
      if (evidence.outcome !== 'passed' && evidence.outcome !== 'failed') refuse('evidence_invalid', 'a test passed or failed');
    } else if (evidence.kind === 'shadow_observation') {
      if (!run || run.moduleKey !== moduleKey || run.runMode !== 'shadow' || evidence.runMode !== 'shadow') {
        refuse('evidence_invalid', 'a shadow observation names the shadow run it describes');
      }
      if (!samePair(this.snapshotPair(tenantId, run!.configSnapshotId), evidence.versions)) {
        refuse('evidence_invalid', 'a shadow observation is evidence only for the versions its run was pinned to');
      }
      if (evidence.outcome !== 'observed') refuse('evidence_invalid', 'a shadow observation is observed, not passed');
      if (parseLifecycleState(lifecycle.state) !== 'shadow') refuse('module_not_active', 'shadow observations are recorded only in shadow');
    } else if (evidence.kind === 'shadow_review') {
      if (evidence.runId !== null) refuse('evidence_invalid', 'a shadow review covers observations, not one run');
      if (evidence.outcome !== 'passed' && evidence.outcome !== 'failed') refuse('evidence_invalid', 'a review passed or failed');
      if (actor.type !== 'operator') refuse('forbidden', 'a shadow review is an operator\'s');
      if (!this.lifecycleEvidence.some((e) => e.tenantId === tenantId && e.moduleKey === moduleKey && e.kind === 'shadow_observation' && samePair(e.versions, evidence.versions))) {
        refuse('shadow_observations_missing', 'nothing was observed in shadow under these versions');
      }
    } else {
      refuse('evidence_invalid', `unknown evidence kind ${String((evidence as { kind: unknown }).kind)}`);
    }
  }

  private insertEvidence(tenantId: string, moduleKey: string, lifecycle: LifecycleRow, evidence: NewEvidence, actor: { type: string; id: string | null }): EvidenceRow {
    this.guardEvidence(tenantId, moduleKey, lifecycle, evidence, actor);
    const row: EvidenceRow = Object.freeze({
      ...clone(evidence),
      id: this.configId(),
      tenantId,
      moduleKey,
      lifecycleId: lifecycle.id,
      simulated: true as const,
      actorType: actor.type as EvidenceRow['actorType'],
      recordedBy: actor.id,
      recordedAt: new Date().toISOString(),
    });
    this.lifecycleEvidence.push(row);
    return row;
  }

  // ── tenant_modules_guard ──
  protected guardLifecycleChange(old: LifecycleRow | null, next: LifecycleRow, history: TransitionRow): void {
    const heads = this.heads(next.tenantId, next.moduleKey);
    if (old) {
      if (next.stateVersion !== old.stateVersion + 1) refuse('stale_state', 'the state version moves by exactly one per change');
      if (!samePair(next.observed, old.observed) && !samePair(next.observed, heads)) {
        refuse('illegal_transition', 'the evaluated baseline can only move to the current published versions');
      }
    }
    if (next.authorized && (!old || !samePair(next.authorized, old.authorized)) && !samePair(next.authorized, heads)) {
      refuse('authorization_stale', 'only the current published versions can be authorised');
    }
    if (next.testEvidenceId !== (old?.testEvidenceId ?? null)) {
      const e = this.lifecycleEvidence.find((x) => x.id === next.testEvidenceId);
      if (!e || e.kind !== 'test' || e.outcome !== 'passed' || !samePair(e.versions, next.tested)) {
        refuse('evidence_invalid', 'accepted test evidence is a passing test of exactly the tested versions');
      }
    }
    if (next.shadowEvidenceId !== (old?.shadowEvidenceId ?? null)) {
      const e = this.lifecycleEvidence.find((x) => x.id === next.shadowEvidenceId);
      if (!e || e.kind !== 'shadow_review' || e.outcome !== 'passed' || !samePair(e.versions, next.shadowed)) {
        refuse('evidence_invalid', 'accepted shadow evidence is a passing review of exactly the shadowed versions');
      }
    }

    const wasActive = old?.state === 'active';
    const isActive = next.state === 'active';
    if (isActive && !wasActive) {
      if (history.actorType !== 'operator') refuse('forbidden', 'only an operator switches a module on');
      if (!heads || !samePair(next.authorized, heads)) refuse('authorization_stale', 'activation authorises exactly the current published versions');
      if (!samePair(next.observed, heads)) refuse('requirements_pending', 'a published change has not been evaluated');
      if (!next.testEvidenceId || !samePair(next.tested, heads)) refuse('test_evidence_missing', 'no passing test of the current versions');
      if (next.pendingRequirements.length > 0) refuse('requirements_pending', `still pending: ${next.pendingRequirements.join(', ')}`);
      if (['failing', 'blocking'].includes(next.healthStatus)) refuse('health_blocks_activation', `health is ${next.healthStatus}`);
      const shadowRequired = (old?.pendingRequirements ?? []).includes('shadow') || this.requiresShadowMode(next.moduleKey);
      if (shadowRequired && (!next.shadowEvidenceId || !samePair(next.shadowed, heads))) {
        refuse('shadow_evidence_missing', 'no passing shadow review of the current versions');
      }
    } else if (isActive && wasActive && !samePair(next.authorized, old!.authorized)) {
      if (!heads || !samePair(next.authorized, heads) || !samePair(next.observed, heads)) {
        refuse('authorization_stale', 'live authorisation only ever moves to the current, evaluated versions');
      }
      const classes = old!.authorized ? this.chainClasses(next.tenantId, next.moduleKey, old!.authorized, heads!) : new Set<ImpactClassification>(['unclassified']);
      if (history.transition === 'apply_config_change' && history.actorType === 'system') {
        if ([...classes].some((c) => c !== 'no_consequence')) {
          refuse('requirements_pending', 'a change with consequences cannot carry live authorisation forward');
        }
      } else if (history.transition === 'record_test' && history.actorType === 'operator') {
        if (!next.testEvidenceId || !samePair(next.tested, heads) || next.pendingRequirements.length > 0) {
          refuse('test_evidence_missing', 'a retest authorises the versions it passed for, with nothing else pending');
        }
        if ([...classes].some((c) => c !== 'no_consequence' && c !== 'requires_retest')) {
          refuse('requirements_pending', 'a change that needed more than a retest needs an operator\'s reactivation');
        }
      } else {
        refuse('illegal_transition', 'live authorisation moves only by activation, a consequence-free change or a passing retest');
      }
    }
  }

  private requiresShadowMode(moduleKey: string): boolean {
    return (getModule(moduleKey)?.versions ?? []).some((v) => ['pilot', 'available'].includes(v.status) && getModuleVersion(moduleKey, v.version)?.safety.requiresShadowMode);
  }

  // ── automation_runs_guard_lifecycle ──
  protected guardRunLifecycle(row: Pick<RunRow, 'tenantId' | 'leadId' | 'moduleKey' | 'configSnapshotId' | 'runMode'>): void {
    const mode = parseRunMode(row.runMode);
    if (!mode) refuse('invalid_run_mode', 'a new run states its mode: live, test or shadow');
    const lead = this.leads.find((l) => l.id === row.leadId && l.tenantId === row.tenantId);
    const lifecycle = this.lifecycles.find((l) => l.tenantId === row.tenantId && l.moduleKey === row.moduleKey);
    const state = lifecycle ? parseLifecycleState(lifecycle.state) : null;
    if (mode === 'test') {
      if (!lead?.isCanary) refuse('mode_not_permitted', 'a test run is a synthetic lead');
      if (!state || !TESTABLE_STATES.includes(state)) refuse('module_not_active', `a test run needs the module in testing, shadow, active or paused — it is ${state ?? 'not selected'}`);
      return;
    }
    if (lead?.isCanary) refuse('mode_not_permitted', `a synthetic lead cannot start a ${mode} run`);
    const pinned = this.snapshotPair(row.tenantId, row.configSnapshotId);
    if (mode === 'shadow') {
      if (state !== 'shadow') refuse('module_not_active', 'a shadow run needs the module in shadow');
      if (!pinned) refuse('snapshot_missing', 'a shadow run is pinned to published versions');
      if (lifecycle!.healthStatus === 'blocking') refuse('health_blocks_execution', 'health is blocking');
      return;
    }
    if (state !== 'active') refuse(state === 'paused' ? 'module_paused' : 'module_not_active', `a live run needs the module active — it is ${state ?? 'not selected'}`);
    if (lifecycle!.pendingRequirements.length > 0) refuse('requirements_pending', `pending: ${lifecycle!.pendingRequirements.join(', ')}`);
    if (['failing', 'blocking'].includes(lifecycle!.healthStatus)) refuse('health_blocks_execution', `health is ${lifecycle!.healthStatus}`);
    if (!pinned || !samePair(pinned, lifecycle!.authorized)) {
      refuse('authorization_stale', 'a live run is pinned to exactly the versions an operator authorised');
    }
  }

  // ── reserve_lead_recovery_effect, 0015's lifecycle check ──
  protected guardEffectLifecycle(input: { tenantId: string; runId?: string | null; leadId?: string | null; isCanary?: boolean }): void {
    const run = input.runId ? this.runs.find((r) => r.id === input.runId && r.tenantId === input.tenantId) : null;
    if (input.isCanary === true) {
      const lead = this.leads.find((l) => l.id === input.leadId && l.tenantId === input.tenantId);
      if (!lead?.isCanary) refuse('mode_not_permitted', 'a synthetic effect must belong to a synthetic lead');
      return;
    }
    const moduleKey = run?.moduleKey ?? 'lead_recovery';
    const lifecycle = this.lifecycles.find((l) => l.tenantId === input.tenantId && l.moduleKey === moduleKey);
    if (!lifecycle || lifecycle.state !== 'active') {
      refuse(lifecycle?.state === 'paused' ? 'module_paused' : 'module_not_active', `${moduleKey} is not active — nothing live may be reserved`);
    }
    if (['failing', 'blocking'].includes(lifecycle!.healthStatus)) refuse('health_blocks_execution', `health is ${lifecycle!.healthStatus}`);
    if (run && run.runMode !== 'live') {
      refuse(run.runMode ? 'mode_not_permitted' : 'run_authorization_unproven', 'only a live run reserves a live effect');
    }
  }

  // ── apply_tenant_module_transition ──
  // deno-lint-ignore require-await
  async applyLifecycleTransition(request: TransitionRequest): Promise<TransitionResult> {
    const { tenantId, moduleKey, change } = request;

    if (request.actor.type === 'operator') {
      if (!request.actor.id || !this.operators.includes(request.actor.id)) refuse('forbidden', 'lifecycle transitions are an operator action');
    } else if (request.actor.type === 'system') {
      if (request.actor.id !== null) refuse('forbidden', 'the system acts as nobody in particular');
    } else {
      refuse('forbidden', 'unknown actor type');
    }
    if (!getModule(moduleKey)) refuse('module_not_found', `${moduleKey} is not a registered module`);

    /* the idempotency key, before anything else: a repeat is the first answer. */
    const previous = this.lifecycleTransitions.find((t) => t.tenantId === tenantId && t.moduleKey === moduleKey && t.idempotencyKey === request.idempotencyKey);
    if (previous) {
      if (previous.transition !== request.transition) refuse('idempotency_conflict', `that key was used for ${previous.transition}`);
      const lifecycle = this.lifecycles.find((l) => l.id === previous.lifecycleId)!;
      const evidence = previous.evidenceId ? this.lifecycleEvidence.find((e) => e.id === previous.evidenceId) ?? null : null;
      return { replayed: true, transition: clone(previous), lifecycle: clone(lifecycle), evidence: clone(evidence), cancelledActions: 0 };
    }

    const existing = this.lifecycles.find((l) => l.tenantId === tenantId && l.moduleKey === moduleKey) ?? null;
    const from = existing ? parseLifecycleState(existing.state) : 'unselected';
    if (!from) refuse('lifecycle_state_unknown', `stored state "${existing!.state}" is not recognised`);
    const version = existing?.stateVersion ?? 0;
    if (request.expectedStateVersion !== version) refuse('stale_state', `the lifecycle is at version ${version}, not ${request.expectedStateVersion}`);

    const rule = expandedTransitionRules().find((r) => r.transition === request.transition && r.from === from && r.actor === request.actor.type);
    if (!rule) {
      const anyActor = expandedTransitionRules().some((r) => r.transition === request.transition && r.from === from);
      refuse(anyActor ? 'forbidden' : 'illegal_transition', `${request.transition} is not permitted from ${from} for ${request.actor.type}`);
    }
    if (request.transition === 'select' && !isSelectable(moduleKey)) refuse('module_unavailable', `${moduleKey} has no selectable version`);
    for (const key of ['metadata', 'impact', 'policy'] as const) {
      if (SECRET_SHAPED.test(JSON.stringify(change[key] ?? {}))) throw new Error('new row violates check constraint "tenant_module_transitions_no_secrets"');
    }

    const now = new Date().toISOString();
    const base: LifecycleRow = existing ? clone(existing) : {
      id: this.configId(),
      tenantId,
      moduleKey,
      state: 'unselected',
      stateVersion: 0,
      pendingRequirements: [],
      observed: null,
      authorized: null,
      tested: null,
      testEvidenceId: null,
      shadowed: null,
      shadowEvidenceId: null,
      healthStatus: 'unverified',
      healthReason: null,
      healthEvidence: {},
      healthCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const evidence = change.evidence ? this.insertEvidence(tenantId, moduleKey, base, change.evidence, request.actor) : null;

    const next: LifecycleRow = {
      ...base,
      state: rule!.to,
      stateVersion: version + 1,
      pendingRequirements: normaliseRequirements(change.pendingRequirements),
      updatedAt: now,
    };
    if (change.observed) next.observed = clone(change.observed);
    if (change.authorized !== undefined) next.authorized = clone(change.authorized);
    if (change.applyEvidenceAs) {
      if (!evidence) refuse('evidence_invalid', 'there is no evidence in this transition to accept');
      const heads = this.heads(tenantId, moduleKey);
      if (evidence!.outcome !== 'passed' || !samePair(evidence!.versions, heads)) {
        refuse('evidence_invalid', 'only a pass for the current published versions is accepted');
      }
      if (change.applyEvidenceAs === 'test') {
        if (evidence!.kind !== 'test') refuse('evidence_invalid', 'that is not a test');
        next.tested = clone(evidence!.versions);
        next.testEvidenceId = evidence!.id;
      } else {
        if (evidence!.kind !== 'shadow_review') refuse('evidence_invalid', 'that is not a shadow review');
        next.shadowed = clone(evidence!.versions);
        next.shadowEvidenceId = evidence!.id;
      }
    }
    if (change.health) {
      next.healthStatus = change.health.status;
      next.healthReason = change.health.reason;
      next.healthEvidence = clone(change.health.evidence ?? {});
      next.healthCheckedAt = now;
    }

    const history: TransitionRow = {
      id: this.configId(),
      tenantId,
      moduleKey,
      lifecycleId: next.id,
      stateVersion: next.stateVersion,
      transition: request.transition,
      fromState: from,
      toState: next.state,
      actorType: request.actor.type,
      actorId: request.actor.id,
      reasonCode: request.reasonCode,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      correlationId: request.correlationId ?? null,
      versions: clone(change.versions ?? null),
      previousVersions: clone(change.previousVersions ?? null),
      evidenceId: evidence?.id ?? null,
      impact: clone(change.impact ?? {}),
      policy: clone(change.policy ?? {}),
      pendingBefore: [...(existing?.pendingRequirements ?? [])],
      pendingAfter: [...next.pendingRequirements],
      healthBefore: existing?.healthStatus ?? null,
      healthAfter: next.healthStatus,
      metadata: clone(change.metadata ?? {}),
      occurredAt: now,
    };

    this.guardLifecycleChange(existing, next, history);

    /* the switch follows the lifecycle, and nothing else moves it (0015). */
    const switchRow = this.configs.find((c) => c.tenantId === tenantId && c.moduleKey === moduleKey);
    if (switchRow) switchRow.enabled = next.state === 'active';
    else if (request.transition === 'select') this.configs.push({ tenantId, moduleKey, enabled: false, schemaVersion: 1, configVersion: 1, config: {} });

    /* leaving live: queued work that would reach somebody is cancelled. handoffs and closes
       still run — they put a person on the lead or close it, and any message they would send
       is refused separately at its own gate. synthetic test runs are left alone. */
    let cancelledActions = 0;
    if (['pause', 'system_pause', 'deselect'].includes(request.transition)) {
      const liveRuns = new Set(this.runs.filter((r) => r.tenantId === tenantId && r.moduleKey === moduleKey && r.runMode !== 'test').map((r) => r.id));
      for (const action of this.actions) {
        if (action.tenantId !== tenantId || !liveRuns.has(action.runId) || action.status !== 'pending') continue;
        if (BOOKKEEPING_ACTIONS.includes(action.actionType)) continue;
        action.status = 'cancelled';
        action.lastError = `the module was ${request.transition === 'deselect' ? 'deselected' : 'paused'} (${request.reasonCode})`;
        action.completedAt = now;
        cancelledActions += 1;
      }
    }

    if (existing) Object.assign(existing, next);
    else this.lifecycles.push(next);
    this.lifecycleTransitions.push(Object.freeze(history) as TransitionRow);

    this.adminActions.push({
      actorUserId: request.actor.id,
      action: `module.${request.transition}`,
      targetType: 'tenant',
      targetId: tenantId,
      metadata: {
        module_key: moduleKey,
        from_state: from,
        to_state: next.state,
        state_version: next.stateVersion,
        reason_code: request.reasonCode,
        transition_id: history.id,
        evidence_id: evidence?.id ?? null,
        pending: next.pendingRequirements,
        cancelled_actions: cancelledActions,
      },
      occurredAt: now,
    });

    return { replayed: false, transition: clone(history), lifecycle: clone(next), evidence: clone(evidence), cancelledActions };
  }

  // deno-lint-ignore require-await
  async recordShadowObservation(input: { tenantId: string; moduleKey: string; evidence: NewEvidence }): Promise<EvidenceRow> {
    const lifecycle = this.lifecycles.find((l) => l.tenantId === input.tenantId && l.moduleKey === input.moduleKey);
    if (!lifecycle) refuse('module_not_selected', 'no lifecycle to record against');
    if (input.evidence.kind !== 'shadow_observation') refuse('evidence_invalid', 'only a shadow observation is recorded without a transition');
    return clone(this.insertEvidence(input.tenantId, input.moduleKey, lifecycle!, input.evidence, { type: 'system', id: null }));
  }
}
