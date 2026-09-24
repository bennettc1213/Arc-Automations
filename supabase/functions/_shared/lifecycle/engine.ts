/**
 * ARC-120 — the lifecycle service: selection, testing, shadow, activation, pause,
 * resumption, deselection, evidence and health.
 *
 * Every rule a caller could get wrong lives here rather than in a handler, and every
 * operation has the same shape, in this order:
 *
 *   1. a replayed idempotency key returns the first answer and changes nothing
 *   2. who is asking — only an operator makes an operator transition
 *   3. the state version the caller read — a stale one is refused, never overwritten
 *   4. whether the transition is legal from here (`LIFECYCLE_TRANSITIONS`, the only list)
 *   5. the gates, re-evaluated now from facts (`readiness.ts`) — every reason at once
 *   6. one store call that writes the history, the lifecycle and its side effects
 *      together, and that the database re-checks
 *
 * Nothing here activates anything on its own. The system actor only ever evaluates a
 * published change (`impact.ts`), records health, or pauses; it never selects, never
 * activates and never resumes.
 */

import type { ConfigStore } from '../config/store.ts';
import type { EngineStore } from '../engine/store.ts';
import { getModule, isSelectable } from '../registry/modules.ts';
import { reconcileConfigChange } from './impact.ts';
import {
  type EvidenceRow,
  type HealthStatus,
  type LifecycleActor,
  type LifecycleErrorCode,
  type LifecycleFailure,
  lifecycleFailure,
  type LifecycleRow,
  type LifecycleState,
  LifecycleStoreError,
  legalDestination,
  normaliseRequirements,
  operatorTransitionsFrom,
  parseHealthStatus,
  parseLifecycleState,
  type Requirement,
  samePair,
  type TransitionKey,
  type TransitionRow,
  type VersionPair,
} from './model.ts';
import { healthPermits } from './policy.ts';
import {
  type ActivationReadiness,
  type Blocker,
  currentHeads,
  evaluateActivation,
  evaluateConfigReadiness,
  evaluateConnectionReadiness,
} from './readiness.ts';
import type { LifecycleStore, TransitionChange, TransitionResult } from './store.ts';
import { latestSelectableModuleVersion } from '../registry/modules.ts';

export type LifecycleServiceStore = ConfigStore & LifecycleStore & Pick<EngineStore, 'getRun' | 'getLead' | 'getConfigSnapshot' | 'getTenant'>;

type Ok<T> = { ok: true } & T;
export type LifecycleOutcome = Ok<{ result: TransitionResult }> | LifecycleFailure;

export interface OperatorRequest {
  tenantId: string;
  moduleKey: string;
  actor: LifecycleActor;
  /** the lifecycle's `stateVersion` the caller read; 0 when it read no lifecycle. */
  expectedStateVersion: number | null | undefined;
  idempotencyKey?: string | null;
  reason?: string | null;
  correlationId?: string | null;
}

const BLOCKER_PRIORITY: LifecycleErrorCode[] = [
  'module_unavailable', 'module_not_selected', 'lifecycle_state_unknown', 'tenant_inactive',
  'config_not_ready', 'connection_not_ready', 'activation_checks_failed', 'onboarding_incomplete',
  'test_evidence_missing', 'shadow_evidence_missing', 'requirements_pending', 'health_blocks_activation',
];

function blocked(message: string, blockers: Blocker[]): LifecycleFailure {
  const code = BLOCKER_PRIORITY.find((c) => blockers.some((b) => b.code === c)) ?? 'requirements_pending';
  return lifecycleFailure(code, message, { blockers });
}

function fromStoreError(error: unknown): LifecycleFailure {
  if (error instanceof LifecycleStoreError) {
    return lifecycleFailure(error.code as LifecycleErrorCode, error.message);
  }
  throw error;
}

const note = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null);

/** A tenant that no longer exists or has been archived gets nothing new switched on. */
async function tenantBlocker(store: LifecycleServiceStore, tenantId: string, strict: boolean): Promise<Blocker | null> {
  const tenant = await store.getTenant(tenantId);
  if (!tenant) return { code: 'tenant_inactive', message: 'this client does not exist' };
  if (tenant.status === 'archived') return { code: 'tenant_inactive', message: 'this client is archived' };
  if (strict && tenant.status === 'paused') return { code: 'tenant_inactive', message: 'this client is paused — restore them before switching anything on' };
  return null;
}

/**
 * The one path every transition takes. `build` sees the lifecycle as it is now and returns
 * the change to make, or why not.
 */
async function transition(
  store: LifecycleServiceStore,
  req: OperatorRequest,
  key: TransitionKey,
  build: (ctx: { lifecycle: LifecycleRow | null; from: LifecycleState; to: LifecycleState }) => Promise<TransitionChange | LifecycleFailure>,
  options: { reasonCode: string; defaultReason: string },
): Promise<LifecycleOutcome> {
  const idempotencyKey = note(req.idempotencyKey) ?? crypto.randomUUID();

  /* 1. a repeat of a request that already happened is the same answer, not a second act. */
  if (req.idempotencyKey) {
    const previous = await store.findTransitionByKey(req.tenantId, req.moduleKey, idempotencyKey);
    if (previous) {
      if (previous.transition !== key) {
        return lifecycleFailure('idempotency_conflict', `this idempotency key was already used for ${previous.transition}`);
      }
      const lifecycle = await store.getLifecycle(req.tenantId, req.moduleKey);
      const evidence = previous.evidenceId ? await store.getEvidence(req.tenantId, req.moduleKey, previous.evidenceId) : null;
      return { ok: true, result: { replayed: true, transition: previous, lifecycle: lifecycle!, evidence, cancelledActions: 0 } };
    }
  }

  /* 2. who. */
  if (req.actor.type === 'operator' && !req.actor.id) return lifecycleFailure('unauthorized', 'not signed in');

  /* 3. what they read. */
  if (typeof req.expectedStateVersion !== 'number' || !Number.isInteger(req.expectedStateVersion)) {
    return lifecycleFailure('stale_state', 'expected_state_version is required — a transition without it could overwrite a newer one');
  }
  if (!getModule(req.moduleKey)) return lifecycleFailure('module_not_found', `${req.moduleKey} is not a registered module`);

  const lifecycle = await store.getLifecycle(req.tenantId, req.moduleKey);
  const from = lifecycle ? parseLifecycleState(lifecycle.state) : 'unselected';
  if (!from) {
    return lifecycleFailure('lifecycle_state_unknown', `the stored lifecycle state "${lifecycle!.state}" is not one this build knows — nothing will be changed on top of it`);
  }
  const current = lifecycle?.stateVersion ?? 0;
  if (req.expectedStateVersion !== current) {
    return lifecycleFailure('stale_state', `the lifecycle is at version ${current}, not ${req.expectedStateVersion} — reload before acting`, {
      detail: { state_version: current, state: from },
    });
  }

  /* 4. legal from here, for this actor. */
  const destination = legalDestination(key, from, req.actor.type);
  if (!destination.ok) return lifecycleFailure(destination.code, destination.message, { detail: { state: from } });

  /* 5. the gates. */
  const change = await build({ lifecycle, from, to: destination.to });
  if ('ok' in change && change.ok === false) return change;

  /* 6. one write. */
  try {
    const result = await store.applyLifecycleTransition({
      tenantId: req.tenantId,
      moduleKey: req.moduleKey,
      transition: key,
      expectedStateVersion: current,
      actor: { type: req.actor.type, id: req.actor.id },
      reasonCode: options.reasonCode,
      reason: note(req.reason) ?? options.defaultReason,
      idempotencyKey,
      correlationId: req.correlationId ?? null,
      change: change as TransitionChange,
    });
    return { ok: true, result };
  } catch (error) {
    return fromStoreError(error);
  }
}

/* ── selection ──────────────────────────────────────────── */

export async function selectModule(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await transition(store, req, 'select', async () => {
    if (!isSelectable(req.moduleKey)) {
      return lifecycleFailure('module_unavailable', `${req.moduleKey} has no selectable version — it cannot be given to a client`);
    }
    const tenant = await tenantBlocker(store, req.tenantId, false);
    if (tenant) return blocked('this module cannot be selected', [tenant]);
    const heads = await currentHeads(store, req.tenantId, req.moduleKey);
    return {
      pendingRequirements: [],
      ...(heads ? { observed: heads } : {}),
      authorized: null,
      versions: heads,
    };
  }, { reasonCode: 'operator_selected', defaultReason: 'selected by an operator' });
}

export async function deselectModule(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await transition(store, req, 'deselect', async ({ lifecycle }) => ({
    /* requirements are kept with the record: a module selected again later has to meet
       everything it had not met, and activation needs fresh evidence regardless. */
    pendingRequirements: normaliseRequirements(lifecycle?.pendingRequirements ?? []),
    versions: lifecycle?.authorized ?? null,
  }), { reasonCode: 'operator_deselected', defaultReason: 'deselected by an operator' });
}

/* ── testing ────────────────────────────────────────────── */

export async function beginTesting(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await transition(store, req, 'begin_testing', async ({ lifecycle }) => {
    const tenant = await tenantBlocker(store, req.tenantId, false);
    const config = await evaluateConfigReadiness(store, req.tenantId, req.moduleKey);
    const blockers: Blocker[] = [];
    if (tenant) blockers.push(tenant);
    if (!config.ready) {
      blockers.push({ code: 'config_not_ready', message: config.message });
      blockers.push(...config.fieldErrors.map((e) => ({ code: 'config_not_ready', message: e.path ? `${e.path}: ${e.message}` : e.message })));
    }
    if (blockers.length > 0) return blocked('testing cannot begin — the configuration is not ready', blockers);
    return {
      pendingRequirements: normaliseRequirements(lifecycle?.pendingRequirements ?? []),
      versions: config.ready ? config.versions : null,
    };
  }, { reasonCode: 'operator_began_testing', defaultReason: 'testing begun by an operator' });
}

export async function stopTesting(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await transition(store, req, 'stop_testing', async ({ lifecycle }) => ({
    pendingRequirements: normaliseRequirements(lifecycle?.pendingRequirements ?? []),
  }), { reasonCode: 'operator_stopped_testing', defaultReason: 'testing stopped by an operator' });
}

/**
 * Record what a synthetic run proved, bound to the exact versions its snapshot names.
 *
 * The run is read back from the store, not described by the caller: its mode must be
 * `test`, its lead synthetic, and its snapshot versioned — so a test result cannot be
 * attached to versions it did not run against. A pass for the current versions satisfies
 * a pending retest; on an active module with nothing else pending it authorises the
 * current versions (the registry said no reactivation was needed, or the module would not
 * still be active).
 */
export async function recordTestResult(
  store: LifecycleServiceStore,
  req: OperatorRequest & { runId: string; passed: boolean; summary?: Record<string, unknown> },
): Promise<LifecycleOutcome> {
  const run = await store.getRun(req.tenantId, req.runId);
  if (!run || run.moduleKey !== req.moduleKey) return lifecycleFailure('evidence_invalid', 'no such synthetic run for this client and module');
  if (run.runMode !== 'test') return lifecycleFailure('evidence_invalid', 'only a run in test mode is evidence of a test');
  const lead = await store.getLead(req.tenantId, run.leadId);
  if (!lead?.isCanary) return lifecycleFailure('evidence_invalid', 'a test is a synthetic lead — this run is a real one');
  const snapshot = run.configSnapshotId ? await store.getConfigSnapshot(req.tenantId, run.configSnapshotId) : null;
  if (!snapshot?.tenantConfigVersionId || !snapshot.moduleConfigVersionId) {
    return lifecycleFailure('evidence_invalid', 'this run is not pinned to published versions, so it proves nothing about them');
  }
  const tested: VersionPair = { tenantVersionId: snapshot.tenantConfigVersionId, moduleVersionId: snapshot.moduleConfigVersionId };

  return await transition(store, { ...req, idempotencyKey: req.idempotencyKey ?? `test:${run.id}` }, 'record_test', async ({ lifecycle, from }) => {
    const heads = await currentHeads(store, req.tenantId, req.moduleKey);
    const connections = await connectionContext(store, req.tenantId, req.moduleKey, lifecycle, snapshot.config);
    const pendingBefore = normaliseRequirements(lifecycle?.pendingRequirements ?? []);
    const applies = req.passed && samePair(tested, heads);
    const pendingAfter = applies ? pendingBefore.filter((r) => r !== 'retest') : pendingBefore;
    /* an active module whose only hold was this retest is live again for the new versions —
       its operator never withdrew it, and the registry said the change needed a test, not
       a re-approval. only when the baseline is current, so no unevaluated change rides along. */
    const advance = applies && from === 'active' && pendingAfter.length === 0 && samePair(lifecycle?.observed, heads)
      && !samePair(lifecycle?.authorized, heads);
    return {
      pendingRequirements: pendingAfter,
      evidence: {
        kind: 'test',
        outcome: req.passed ? 'passed' : 'failed',
        runMode: 'test',
        versions: tested,
        configHash: snapshot.configHash,
        capabilities: connections.readyCapabilities,
        runId: run.id,
        summary: safeSummary({ run_state: run.state, ...(req.summary ?? {}) }),
      },
      applyEvidenceAs: applies ? 'test' : null,
      ...(advance ? { authorized: heads! } : {}),
      versions: tested,
      metadata: { current: samePair(tested, heads), authorization_advanced: advance },
    };
  }, { reasonCode: req.passed ? 'synthetic_test_passed' : 'synthetic_test_failed', defaultReason: req.passed ? 'a synthetic run passed' : 'a synthetic run stopped early' });
}

/* ── shadow ─────────────────────────────────────────────── */

export async function enterShadow(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await transition(store, req, 'enter_shadow', async ({ lifecycle }) => {
    const readiness = await evaluateActivation(store, { tenantId: req.tenantId, moduleKey: req.moduleKey, lifecycle, for: 'shadow' });
    const tenant = await tenantBlocker(store, req.tenantId, true);
    const blockers = [...(tenant ? [tenant] : []), ...readiness.blockers];
    if (blockers.length > 0) return blocked('shadow mode cannot begin', blockers);
    return { pendingRequirements: readiness.pending, versions: readiness.versions };
  }, { reasonCode: 'operator_entered_shadow', defaultReason: 'shadow mode begun by an operator' });
}

export async function exitShadow(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await transition(store, req, 'exit_shadow', async ({ lifecycle }) => ({
    pendingRequirements: normaliseRequirements(lifecycle?.pendingRequirements ?? []),
  }), { reasonCode: 'operator_exited_shadow', defaultReason: 'shadow mode ended by an operator' });
}

/**
 * An operator's review of what shadow mode observed. Needs at least one observation of
 * the current versions; a pass satisfies a pending shadow requirement for them.
 */
export async function recordShadowReview(
  store: LifecycleServiceStore,
  req: OperatorRequest & { passed: boolean },
): Promise<LifecycleOutcome> {
  return await transition(store, req, 'record_shadow_review', async ({ lifecycle }) => {
    const config = await evaluateConfigReadiness(store, req.tenantId, req.moduleKey);
    if (!config.ready) return blocked('a shadow review needs a resolvable configuration', [{ code: 'config_not_ready', message: config.message }]);
    const observations = await store.listEvidence(req.tenantId, req.moduleKey, { kind: 'shadow_observation', versions: config.versions, limit: 500 });
    if (observations.length === 0) {
      return lifecycleFailure('shadow_observations_missing', 'nothing has been observed in shadow under the current configuration yet');
    }
    const pendingBefore = normaliseRequirements(lifecycle?.pendingRequirements ?? []);
    return {
      pendingRequirements: req.passed ? pendingBefore.filter((r) => r !== 'shadow') : pendingBefore,
      evidence: {
        kind: 'shadow_review',
        outcome: req.passed ? 'passed' : 'failed',
        runMode: null,
        versions: config.versions,
        configHash: config.configHash,
        capabilities: [],
        runId: null,
        summary: safeSummary({ observations: observations.length, outcomes: tally(observations) }),
      },
      applyEvidenceAs: req.passed ? 'shadow' : null,
      versions: config.versions,
    };
  }, { reasonCode: req.passed ? 'shadow_review_passed' : 'shadow_review_failed', defaultReason: req.passed ? 'shadow results reviewed and accepted' : 'shadow results reviewed and rejected' });
}

function tally(observations: EvidenceRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of observations) {
    const decision = typeof o.summary.would_have === 'string' ? o.summary.would_have : 'unknown';
    out[decision] = (out[decision] ?? 0) + 1;
  }
  return out;
}

/* ── activation, pause, resumption ──────────────────────── */

async function goLive(store: LifecycleServiceStore, req: OperatorRequest, key: 'activate' | 'resume'): Promise<LifecycleOutcome> {
  /* a published change nobody has evaluated would ride in on this activation unexamined.
     evaluate it first — as the system, because that is what it is — and send the operator
     back to look at what it now requires. */
  const lifecycle = await store.getLifecycle(req.tenantId, req.moduleKey);
  if (lifecycle && lifecycle.stateVersion === req.expectedStateVersion) {
    const heads = await currentHeads(store, req.tenantId, req.moduleKey);
    if (heads && !samePair(lifecycle.observed, heads)) {
      await reconcileConfigChange(store, { tenantId: req.tenantId, moduleKey: req.moduleKey, correlationId: req.correlationId ?? null });
      return lifecycleFailure('stale_state', 'a published configuration change had not been evaluated — it has been now. Reload, review what it requires, and try again.');
    }
  }

  return await transition(store, req, key, async ({ lifecycle: current }) => {
    const readiness = await evaluateActivation(store, { tenantId: req.tenantId, moduleKey: req.moduleKey, lifecycle: current, for: 'activate' });
    const tenant = await tenantBlocker(store, req.tenantId, true);
    const blockers = [...(tenant ? [tenant] : []), ...readiness.blockers];
    if (blockers.length > 0) return blocked(`this module cannot be ${key === 'activate' ? 'activated' : 'resumed'} yet`, blockers);
    /* every evidence requirement is met for these versions (or the gate above refused), and
       this operator action is the review and the reactivation. nothing stays pending. */
    return {
      pendingRequirements: [] as Requirement[],
      authorized: readiness.versions!,
      versions: readiness.versions,
      metadata: {
        test_evidence_id: readiness.test.evidenceId,
        shadow_evidence_id: readiness.shadow.required ? readiness.shadow.evidenceId : null,
        ready_capabilities: readiness.connections?.readyCapabilities ?? [],
      },
    };
  }, {
    reasonCode: key === 'activate' ? 'operator_activated' : 'operator_resumed',
    defaultReason: key === 'activate' ? 'activated by an operator' : 'resumed by an operator',
  });
}

export async function activateModule(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await goLive(store, req, 'activate');
}

/** Explicit, and every gate is re-checked: resumption is activation from paused. */
export async function resumeModule(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await goLive(store, req, 'resume');
}

export async function pauseModule(store: LifecycleServiceStore, req: OperatorRequest): Promise<LifecycleOutcome> {
  return await transition(store, req, 'pause', async ({ lifecycle }) => ({
    pendingRequirements: normaliseRequirements(lifecycle?.pendingRequirements ?? []),
    versions: lifecycle?.authorized ?? null,
  }), { reasonCode: 'operator_paused', defaultReason: 'paused by an operator' });
}

/* ── health ─────────────────────────────────────────────── */

/**
 * Record a health observation. The overlay changes; the lifecycle state never does, and a
 * recovery reactivates nothing. `evidence.source` is required for every report — "healthy"
 * in particular is a claim, and a claim without a source is not evidence.
 */
export async function reportHealth(
  store: LifecycleServiceStore,
  req: OperatorRequest & { status: unknown; evidence?: Record<string, unknown> | null },
): Promise<LifecycleOutcome> {
  const status = parseHealthStatus(req.status);
  if (!status) return lifecycleFailure('evidence_invalid', `health must be one of unverified, healthy, degraded, failing, blocking`);
  const evidence = req.evidence && typeof req.evidence === 'object' && !Array.isArray(req.evidence) ? req.evidence : {};
  if (typeof evidence.source !== 'string' || !evidence.source.trim()) {
    return lifecycleFailure('evidence_invalid', 'a health report needs evidence naming its source');
  }
  return await transition(store, req, 'report_health', async ({ lifecycle }) => ({
    pendingRequirements: normaliseRequirements(lifecycle?.pendingRequirements ?? []),
    health: { status, reason: note(req.reason), evidence: safeSummary(evidence) },
  }), { reasonCode: `health_${status}`, defaultReason: `health reported ${status}` });
}

/* ── reading ────────────────────────────────────────────── */

export interface EffectiveStatus {
  state: string;
  health: string;
  pending: Requirement[];
  /** whether a new live run may start right now. */
  live: boolean;
  /** one line for a person: the state, and what is holding it. */
  headline: string;
  holds: Blocker[];
}

/**
 * Lifecycle and health, explained together, kept apart as data. "Active" with a failing
 * dependency reads as active and held, never as paused: the operator's decision and the
 * system's observation are different facts.
 */
export function effectiveStatus(lifecycle: LifecycleRow | null, heads: VersionPair | null): EffectiveStatus {
  const state = lifecycle ? parseLifecycleState(lifecycle.state) : 'unselected';
  const health = lifecycle?.healthStatus ?? 'unverified';
  const pending = normaliseRequirements(lifecycle?.pendingRequirements ?? []);
  const holds: Blocker[] = [];
  if (!state) holds.push({ code: 'lifecycle_state_unknown', message: `stored state "${lifecycle?.state}" is not recognised — nothing runs` });
  if (state === 'active') {
    if (pending.length > 0) holds.push({ code: 'requirements_pending', message: `${pending.join(', ')} required before new live runs` });
    if (!heads) holds.push({ code: 'config_not_ready', message: 'no published configuration' });
    else if (!samePair(lifecycle?.authorized, heads)) holds.push({ code: 'authorization_stale', message: 'the published configuration is not the one that was authorised' });
    if (!healthPermits(health, 'live_start')) holds.push({ code: 'health_blocks_execution', message: `health is ${health}` });
  }
  const live = state === 'active' && holds.length === 0;
  const headline = !state
    ? 'unknown state — nothing runs'
    : state === 'active'
      ? live ? `active · health ${health}` : `active · new live runs held (${holds.map((h) => h.code).join(', ')})`
      : `${state}${pending.length ? ` · requires ${pending.join(', ')}` : ''} · health ${health}`;
  return { state: state ?? lifecycle?.state ?? 'unknown', health, pending, live, headline, holds };
}

export interface LifecycleStatus {
  lifecycle: LifecycleRow | null;
  effective: EffectiveStatus;
  heads: VersionPair | null;
  activation: ActivationReadiness;
  /** the transitions an operator could request from here. */
  transitions: TransitionKey[];
  history: TransitionRow[];
}

export async function getLifecycleStatus(
  store: LifecycleServiceStore,
  tenantId: string,
  moduleKey: string,
  options: { historyLimit?: number } = {},
): Promise<LifecycleStatus> {
  const [lifecycle, heads] = await Promise.all([
    store.getLifecycle(tenantId, moduleKey),
    currentHeads(store, tenantId, moduleKey),
  ]);
  const [activation, history] = await Promise.all([
    evaluateActivation(store, { tenantId, moduleKey, lifecycle, for: 'activate' }),
    store.listTransitions(tenantId, moduleKey, Math.min(Math.max(options.historyLimit ?? 10, 1), 100)),
  ]);
  const state = lifecycle ? parseLifecycleState(lifecycle.state) : 'unselected';
  return {
    lifecycle,
    effective: effectiveStatus(lifecycle, heads),
    heads,
    activation,
    transitions: state ? operatorTransitionsFrom(state) : [],
    history,
  };
}

/* ── the pieces ─────────────────────────────────────────── */

/** Connection readiness for a module, against today's evidence. */
export async function connectionContext(
  store: LifecycleServiceStore,
  tenantId: string,
  moduleKey: string,
  lifecycle: LifecycleRow | null,
  config: Record<string, unknown> | null,
) {
  const version = latestSelectableModuleVersion(moduleKey);
  const [completedSteps, hasIntakeKey] = await Promise.all([
    store.listCompletedOnboardingSteps(tenantId, moduleKey),
    store.hasActiveIntakeKey(tenantId),
  ]);
  const unhealthy = Array.isArray(lifecycle?.healthEvidence?.capabilities)
    ? (lifecycle!.healthEvidence.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  if (!version) return { ready: false, readyCapabilities: [] as string[], capabilities: [], blockers: [{ code: 'module_unavailable', message: `${moduleKey} has no selectable version` }] };
  return evaluateConnectionReadiness(version, { config, completedSteps, hasActiveIntakeKey: hasIntakeKey, unhealthyCapabilities: unhealthy });
}

/**
 * Keep evidence and audit metadata to what is safe to show every operator: short strings,
 * numbers, booleans and lists of them. Anything shaped like a phone number, an email or a
 * credential is dropped rather than stored.
 */
export function safeSummary(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unsafe = /(\+?\d[\d\s().-]{7,}\d)|(@[a-z0-9-]+\.)|(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|secret|private[_-]?key|bearer )/i;
  for (const [key, value] of Object.entries(input).slice(0, 40)) {
    if (!/^[a-z_][a-z0-9_]{0,40}$/i.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (typeof value === 'string') {
      if (!unsafe.test(value)) out[key] = value.slice(0, 200);
    } else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 40)
        .filter((v) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && !unsafe.test(v)) || (typeof v === 'object' && v !== null && depth < 2))
        .map((v) => (typeof v === 'object' && v !== null ? safeSummary(v as Record<string, unknown>, depth + 1) : typeof v === 'string' ? v.slice(0, 120) : v));
    } else if (typeof value === 'object' && value !== null && depth < 2) {
      out[key] = safeSummary(value as Record<string, unknown>, depth + 1);
    }
  }
  return out;
}

export type { HealthStatus };
