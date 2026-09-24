/**
 * ARC-120 — the vocabulary of a tenant module's lifecycle.
 *
 * Three separate questions, kept as three separate pieces of data because collapsing
 * them into one status string is how "paused because the operator said so" and "blocked
 * because Twilio is down" become indistinguishable:
 *
 *   lifecycle state   what an operator has decided: selected, tested, live, paused.
 *                     changes only through a legal transition (`LIFECYCLE_TRANSITIONS`).
 *   requirements      what a published configuration change has made necessary before
 *                     new live work may start: a retest, shadow evidence, a review, an
 *                     explicit reactivation. derived from the registry's change impact.
 *   health overlay    what the system has observed about its dependencies. never
 *                     rewrites the lifecycle state, and never brings a module back.
 *
 * Nothing here touches a database. `store.ts` is the seam, `engine.ts` the service,
 * `authorize.ts` the just-in-time gate.
 */

/* ── lifecycle states ───────────────────────────────────── */

export const LIFECYCLE_STATES = ['unselected', 'configuring', 'testing', 'shadow', 'active', 'paused'] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];

/**
 * Parse a stored state. Anything unrecognised — a legacy value, a typo, a state a newer
 * build wrote — is null, and every caller treats null as "may not run".
 */
export function parseLifecycleState(value: unknown): LifecycleState | null {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value)
    ? (value as LifecycleState)
    : null;
}

/** States in which the module is selected at all. */
export const SELECTED_STATES: readonly LifecycleState[] = ['configuring', 'testing', 'shadow', 'active', 'paused'];

/** States in which a synthetic test may run: selected, and past configuration. */
export const TESTABLE_STATES: readonly LifecycleState[] = ['testing', 'shadow', 'active', 'paused'];

/* ── requirements a configuration change can impose ─────── */

export const REQUIREMENTS = ['retest', 'shadow', 'review', 'reactivation'] as const;
export type Requirement = typeof REQUIREMENTS[number];

/** Satisfied by evidence: a synthetic test, a shadow review. */
export const EVIDENCE_REQUIREMENTS: readonly Requirement[] = ['retest', 'shadow'];
/** Satisfied only by an operator's explicit activation or resumption. */
export const OPERATOR_REQUIREMENTS: readonly Requirement[] = ['review', 'reactivation'];

export function normaliseRequirements(values: readonly string[]): Requirement[] {
  return REQUIREMENTS.filter((r) => values.includes(r));
}

/* ── the health overlay ─────────────────────────────────── */

/**
 * The portal's own words (`src/portal/lib/health.js`) where they exist — `unverified` is
 * "we have no evidence", never a synonym for healthy — plus `blocking`, which the portal
 * has no need for: a condition an operator or monitor says must stop execution outright.
 */
export const HEALTH_STATUSES = ['unverified', 'healthy', 'degraded', 'failing', 'blocking'] as const;
export type HealthStatus = typeof HEALTH_STATUSES[number];

export function parseHealthStatus(value: unknown): HealthStatus | null {
  return typeof value === 'string' && (HEALTH_STATUSES as readonly string[]).includes(value)
    ? (value as HealthStatus)
    : null;
}

/* ── run modes ──────────────────────────────────────────── */

/**
 * How a run is allowed to touch the world. Stored on the run (`automation_runs.run_mode`,
 * 0015) and fixed when the run is created, so an action can always be re-authorised
 * against the mode its run began in.
 *
 *   live    real customers, real provider effects
 *   test    a synthetic lead through the whole engine with a recording sender
 *   shadow  real traffic, evaluated and recorded as "would have" — nothing sent
 *
 * Not the registry's `ExecutionMode` (direct / n8n / hybrid), which says *where* a module
 * runs; this says *whether it may reach anyone*.
 */
export const RUN_MODES = ['live', 'test', 'shadow'] as const;
export type RunMode = typeof RUN_MODES[number];

/** A missing or unrecognised mode is never live. */
export function parseRunMode(value: unknown): RunMode | null {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value) ? (value as RunMode) : null;
}

/* ── actors ─────────────────────────────────────────────── */

/**
 * Who asked. `operator` is a member of `arc_admins`, taken from the verified JWT by the
 * `ops` function and checked again inside the database. `system` is the engine itself
 * acting on a published change or a health observation. There is deliberately no client
 * actor: no lifecycle transition is a client's to make (ADR-010 §13 — no client write
 * path), and an operator-only review cannot be satisfied by a tenant role because no
 * tenant role can reach any of this.
 */
export const ACTOR_TYPES = ['operator', 'system'] as const;
export type ActorType = typeof ACTOR_TYPES[number];

export type LifecycleActor =
  | { type: 'operator'; id: string }
  | { type: 'system'; id: null };

export const SYSTEM_ACTOR: LifecycleActor = Object.freeze({ type: 'system' as const, id: null });

/* ── the one legal-transition policy ────────────────────── */

export const TRANSITION_KEYS = [
  'select',
  'begin_testing',
  'stop_testing',
  'enter_shadow',
  'exit_shadow',
  'activate',
  'pause',
  'resume',
  'deselect',
  'system_pause',
  'apply_config_change',
  'record_test',
  'record_shadow_review',
  'report_health',
  'backfill_selected',
  'backfill_paused',
] as const;
export type TransitionKey = typeof TRANSITION_KEYS[number];

export interface TransitionRule {
  transition: TransitionKey;
  from: readonly LifecycleState[];
  /** `same` records a decision without changing the state. */
  to: LifecycleState | 'same';
  actors: readonly ActorType[];
  /** the gates, in words — enforced by `engine.ts` and, structurally, by 0015. */
  requires: readonly string[];
  /** what else happens in the same transaction. */
  effects: readonly string[];
  /** written by the migration's backfill only; the service never requests it. */
  migrationOnly?: true;
}

/**
 * The legal transitions. The only list: the service reads it to decide, `0015` seeds
 * `lifecycle_transition_rules` from the same rows and `tests/lifecycle-engine.test.js`
 * fails the build if the two disagree. No caller — console, handler, worker, adapter —
 * decides legality for itself.
 */
export const LIFECYCLE_TRANSITIONS: readonly TransitionRule[] = Object.freeze([
  {
    transition: 'select',
    from: ['unselected'],
    to: 'configuring',
    actors: ['operator'],
    requires: ['the registry lists a selectable version of the module'],
    effects: ['the module switch row exists, off', 'the current configuration versions become the observed baseline'],
  },
  {
    transition: 'begin_testing',
    from: ['configuring', 'paused'],
    to: 'testing',
    actors: ['operator'],
    requires: ['configuration ready: published, resolvable and valid'],
    effects: [],
  },
  {
    transition: 'stop_testing',
    from: ['testing'],
    to: 'configuring',
    actors: ['operator'],
    requires: [],
    effects: [],
  },
  {
    transition: 'enter_shadow',
    from: ['testing', 'paused'],
    to: 'shadow',
    actors: ['operator'],
    requires: ['configuration ready', 'connections ready', 'a passing synthetic test of the current versions'],
    effects: ['real leads are evaluated and recorded as "would have"; nothing is sent'],
  },
  {
    transition: 'exit_shadow',
    from: ['shadow'],
    to: 'testing',
    actors: ['operator'],
    requires: [],
    effects: [],
  },
  {
    transition: 'activate',
    from: ['testing', 'shadow'],
    to: 'active',
    actors: ['operator'],
    requires: [
      'configuration ready', 'connections ready', 'module activation checks pass',
      'required onboarding steps done', 'a passing synthetic test of the current versions',
      'shadow evidence for the current versions when shadow is required',
      'no evidence requirement pending', 'health neither failing nor blocking',
    ],
    effects: ['the current versions become the authorised versions', 'the module switch turns on'],
  },
  {
    transition: 'pause',
    from: ['active'],
    to: 'paused',
    actors: ['operator'],
    requires: [],
    effects: ['the module switch turns off', 'queued live work that would reach somebody is cancelled'],
  },
  {
    transition: 'resume',
    from: ['paused'],
    to: 'active',
    actors: ['operator'],
    requires: ['every activation gate, re-checked against today\'s configuration and evidence'],
    effects: ['the current versions become the authorised versions', 'the module switch turns on'],
  },
  {
    transition: 'deselect',
    from: ['configuring', 'testing', 'shadow', 'active', 'paused'],
    to: 'unselected',
    actors: ['operator'],
    requires: [],
    effects: ['the module switch turns off', 'queued live work that would reach somebody is cancelled', 'configuration, evidence and history are kept'],
  },
  {
    transition: 'system_pause',
    from: ['active'],
    to: 'paused',
    actors: ['system'],
    requires: ['a published change the policy says may not stay live'],
    effects: ['the module switch turns off', 'queued live work that would reach somebody is cancelled'],
  },
  {
    transition: 'apply_config_change',
    from: ['configuring', 'testing', 'shadow', 'active', 'paused'],
    to: 'same',
    actors: ['system'],
    requires: ['a published change not yet evaluated'],
    effects: ['the change becomes the observed baseline', 'its requirements are added', 'a consequence-free change carries live authorisation forward'],
  },
  {
    transition: 'record_test',
    from: ['testing', 'shadow', 'active', 'paused'],
    to: 'same',
    actors: ['operator'],
    requires: ['a synthetic run in test mode, pinned to the versions it claims'],
    effects: ['a pass for the current versions satisfies "retest"', 'an active module with nothing else pending is authorised for the current versions'],
  },
  {
    transition: 'record_shadow_review',
    from: ['shadow'],
    to: 'same',
    actors: ['operator'],
    requires: ['at least one shadow observation of the current versions'],
    effects: ['a pass satisfies "shadow"'],
  },
  {
    transition: 'report_health',
    from: ['configuring', 'testing', 'shadow', 'active', 'paused'],
    to: 'same',
    actors: ['operator', 'system'],
    requires: [],
    effects: ['the overlay changes; the lifecycle state never does'],
  },
  {
    transition: 'backfill_selected',
    from: ['unselected'],
    to: 'configuring',
    actors: ['system'],
    requires: ['a module_configs row existed before 0015'],
    effects: [],
    migrationOnly: true,
  },
  {
    transition: 'backfill_paused',
    from: ['unselected'],
    to: 'paused',
    actors: ['system'],
    requires: ['a module_configs row was switched on before 0015 — an activation not bound to any version'],
    effects: ['retest, review and reactivation are required before it runs again'],
    migrationOnly: true,
  },
]);

/** The rule for a transition, or null when there is none. */
export function transitionRule(transition: string): TransitionRule | null {
  return LIFECYCLE_TRANSITIONS.find((r) => r.transition === transition) ?? null;
}

/**
 * Where a transition from `from` lands, or why it may not happen.
 *
 * Deterministic: each (transition, from) pair has at most one destination, so the
 * database can compute the same answer from the same rows.
 */
export function legalDestination(
  transition: string,
  from: LifecycleState,
  actor: ActorType,
): { ok: true; to: LifecycleState } | { ok: false; code: 'illegal_transition' | 'forbidden'; message: string } {
  const rule = transitionRule(transition);
  if (!rule || rule.migrationOnly) {
    return { ok: false, code: 'illegal_transition', message: `"${transition}" is not a lifecycle transition` };
  }
  if (!rule.from.includes(from)) {
    return { ok: false, code: 'illegal_transition', message: `a module that is ${from} cannot ${transition.replace(/_/g, ' ')}` };
  }
  if (!rule.actors.includes(actor)) {
    return { ok: false, code: 'forbidden', message: `${transition.replace(/_/g, ' ')} is not a ${actor} action` };
  }
  return { ok: true, to: rule.to === 'same' ? from : rule.to };
}

/** The transitions an operator could ask for from this state — for a console to offer. */
export function operatorTransitionsFrom(state: LifecycleState): TransitionKey[] {
  return LIFECYCLE_TRANSITIONS
    .filter((r) => !r.migrationOnly && r.actors.includes('operator') && r.from.includes(state))
    .map((r) => r.transition);
}

/** Every (transition, from, to, actor) row, as 0015 seeds `lifecycle_transition_rules`. */
export function expandedTransitionRules(): { transition: TransitionKey; from: LifecycleState; to: LifecycleState; actor: ActorType }[] {
  const rows: { transition: TransitionKey; from: LifecycleState; to: LifecycleState; actor: ActorType }[] = [];
  for (const rule of LIFECYCLE_TRANSITIONS) {
    for (const from of rule.from) {
      for (const actor of rule.actors) {
        rows.push({ transition: rule.transition, from, to: rule.to === 'same' ? from : rule.to, actor });
      }
    }
  }
  return rows;
}

/* ── rows ───────────────────────────────────────────────── */

/** A tenant settings version and a module version, together — what a run pins. */
export interface VersionPair {
  tenantVersionId: string;
  moduleVersionId: string;
}

export const samePair = (a: VersionPair | null | undefined, b: VersionPair | null | undefined): boolean =>
  Boolean(a && b && a.tenantVersionId === b.tenantVersionId && a.moduleVersionId === b.moduleVersionId);

/** `tenant_modules` (0015): the one lifecycle record per tenant and module. */
export interface LifecycleRow {
  id: string;
  tenantId: string;
  moduleKey: string;
  /** raw, because a stored value this build does not know must fail closed, not crash. */
  state: string;
  /** the optimistic-concurrency token. +1 on every change, with exactly one history row. */
  stateVersion: number;
  pendingRequirements: string[];
  /** the configuration versions whose change impact has been evaluated. */
  observed: VersionPair | null;
  /** the versions new live runs may start under. set only by an operator activation, a
      passing retest of an active module, or a change the registry says is consequence-free. */
  authorized: VersionPair | null;
  /** the versions the accepted synthetic test ran against, and that test. */
  tested: VersionPair | null;
  testEvidenceId: string | null;
  /** the versions an operator's shadow review covered, and that review. */
  shadowed: VersionPair | null;
  shadowEvidenceId: string | null;
  healthStatus: string;
  healthReason: string | null;
  healthEvidence: Record<string, unknown>;
  healthCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `tenant_module_transitions` (0015): append-only. One row per lifecycle change. */
export interface TransitionRow {
  id: string;
  tenantId: string;
  moduleKey: string;
  lifecycleId: string;
  /** the lifecycle's `stateVersion` after this transition. */
  stateVersion: number;
  transition: string;
  fromState: string | null;
  toState: string;
  actorType: ActorType;
  actorId: string | null;
  reasonCode: string;
  reason: string | null;
  idempotencyKey: string;
  correlationId: string | null;
  /** the versions this transition concerns: authorised, tested, or newly observed. */
  versions: VersionPair | null;
  /** for a configuration change: the baseline it was measured from. */
  previousVersions: VersionPair | null;
  evidenceId: string | null;
  impact: Record<string, unknown>;
  policy: Record<string, unknown>;
  pendingBefore: string[];
  pendingAfter: string[];
  healthBefore: string | null;
  healthAfter: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export const EVIDENCE_KINDS = ['test', 'shadow_observation', 'shadow_review'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export const EVIDENCE_OUTCOMES = ['passed', 'failed', 'observed'] as const;
export type EvidenceOutcome = typeof EVIDENCE_OUTCOMES[number];

/**
 * `tenant_module_evidence` (0015): append-only, version-bound, always simulated.
 *
 * Nothing in here is a real outcome. A shadow observation is what the engine *would have*
 * done with a real lead; a test is a synthetic lead through a recording sender. No figure
 * on any page reads this table (the event log stays the only source), so a "would have"
 * can never be counted as a message, a booking or revenue.
 */
export interface EvidenceRow {
  id: string;
  tenantId: string;
  moduleKey: string;
  lifecycleId: string;
  kind: EvidenceKind;
  outcome: EvidenceOutcome;
  runMode: 'test' | 'shadow' | null;
  versions: VersionPair;
  configHash: string;
  /** the capabilities the evaluation treated as available — the connector context tested. */
  capabilities: string[];
  runId: string | null;
  simulated: true;
  /** safe summary: states, action types, decision codes. no names, numbers or bodies. */
  summary: Record<string, unknown>;
  actorType: ActorType;
  recordedBy: string | null;
  recordedAt: string;
}

export type NewEvidence = Omit<EvidenceRow, 'id' | 'tenantId' | 'moduleKey' | 'lifecycleId' | 'simulated' | 'recordedAt' | 'actorType' | 'recordedBy'>;

/* ── failures ───────────────────────────────────────────── */

export type LifecycleErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'module_not_found'
  | 'module_unavailable'
  | 'module_not_selected'
  | 'lifecycle_state_unknown'
  | 'illegal_transition'
  | 'stale_state'
  | 'idempotency_conflict'
  | 'config_not_ready'
  | 'connection_not_ready'
  | 'activation_checks_failed'
  | 'onboarding_incomplete'
  | 'test_evidence_missing'
  | 'shadow_evidence_missing'
  | 'shadow_observations_missing'
  | 'requirements_pending'
  | 'health_blocks_activation'
  | 'evidence_invalid'
  | 'tenant_inactive';

export const LIFECYCLE_ERROR_CODES: readonly LifecycleErrorCode[] = Object.freeze([
  'unauthorized', 'forbidden', 'module_not_found', 'module_unavailable', 'module_not_selected',
  'lifecycle_state_unknown', 'illegal_transition', 'stale_state', 'idempotency_conflict',
  'config_not_ready', 'connection_not_ready', 'activation_checks_failed', 'onboarding_incomplete',
  'test_evidence_missing', 'shadow_evidence_missing', 'shadow_observations_missing',
  'requirements_pending', 'health_blocks_activation', 'evidence_invalid', 'tenant_inactive',
]);

export const LIFECYCLE_ERROR_STATUS: Readonly<Record<LifecycleErrorCode, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  module_not_found: 404,
  module_unavailable: 409,
  module_not_selected: 409,
  lifecycle_state_unknown: 409,
  illegal_transition: 409,
  stale_state: 409,
  idempotency_conflict: 409,
  config_not_ready: 409,
  connection_not_ready: 409,
  activation_checks_failed: 409,
  onboarding_incomplete: 409,
  test_evidence_missing: 409,
  shadow_evidence_missing: 409,
  shadow_observations_missing: 409,
  requirements_pending: 409,
  health_blocks_activation: 409,
  evidence_invalid: 422,
  tenant_inactive: 409,
});

export interface LifecycleFailure {
  ok: false;
  code: LifecycleErrorCode;
  message: string;
  /** every reason, not the first — an operator working through a gate wants the list. */
  blockers?: { code: string; message: string }[];
  detail?: Record<string, unknown>;
}

export function lifecycleFailure(
  code: LifecycleErrorCode,
  message: string,
  extra: { blockers?: { code: string; message: string }[]; detail?: Record<string, unknown> } = {},
): LifecycleFailure {
  return { ok: false, code, message, ...extra };
}

/**
 * A refusal from the store — the database's own words, parsed.
 *
 * 0015's functions and triggers raise `arc_lifecycle:<code>: <sentence>`; the production
 * adapter turns that back into this and `MemoryLifecycleStore` throws it directly, so the
 * engine handles one shape whichever store it is given.
 */
export class LifecycleStoreError extends Error {
  code: LifecycleErrorCode | ExecutionDenialCode;
  constructor(code: LifecycleErrorCode | ExecutionDenialCode, message: string) {
    super(message);
    this.name = 'LifecycleStoreError';
    this.code = code;
  }
}

const RAISED = /arc_lifecycle:([a-z_]+):\s*([\s\S]*)$/;

export function parseLifecycleStoreError(message: string | null | undefined): LifecycleStoreError | null {
  const match = RAISED.exec(message ?? '');
  if (!match) return null;
  const code = match[1];
  if (!(LIFECYCLE_ERROR_CODES as readonly string[]).includes(code) && !(EXECUTION_DENIAL_CODES as readonly string[]).includes(code)) {
    return null;
  }
  return new LifecycleStoreError(code as LifecycleErrorCode, match[2].trim());
}

/* ── execution denials ──────────────────────────────────── */

/**
 * Why the just-in-time authoriser refused. Stable and machine-readable: these are what a
 * run's stop reason, an action's `last_error` and an effect denial carry.
 */
export const EXECUTION_DENIAL_CODES = [
  'invalid_run_mode',
  'tenant_missing',
  'tenant_archived',
  'tenant_paused',
  'module_unavailable',
  'module_not_selected',
  'lifecycle_state_unknown',
  'module_paused',
  'module_not_active',
  'mode_not_permitted',
  'requirements_pending',
  'authorization_stale',
  'config_not_ready',
  'connection_not_ready',
  'health_blocks_execution',
  'identity_mismatch',
  'snapshot_missing',
  'snapshot_mismatch',
  'run_authorization_unproven',
  'shadow_no_effects',
] as const;
export type ExecutionDenialCode = typeof EXECUTION_DENIAL_CODES[number];
