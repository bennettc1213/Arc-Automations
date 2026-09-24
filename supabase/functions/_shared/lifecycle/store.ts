/**
 * The seam between the lifecycle service and the database (ARC-120).
 *
 * Two implementations, as for configuration: `MemoryLifecycleStore` (which `MemoryStore`
 * extends, so a test holds one object for the whole database) and the production adapter
 * in `supabase-lifecycle-store.ts`. The in-memory one enforces what 0015's function and
 * triggers enforce, named after them; `tests/lifecycle-db.test.js` runs the same promises
 * against real Postgres where PGlite is available.
 *
 * Every lifecycle change is ONE call — `applyLifecycleTransition` — which in Postgres is
 * one function in one transaction: the history row, the evidence row, the lifecycle row,
 * the module switch, the cancellation of queued work and the audit row, or none of them.
 */

import type {
  ActorType,
  EvidenceRow,
  HealthStatus,
  LifecycleRow,
  NewEvidence,
  Requirement,
  TransitionKey,
  TransitionRow,
  VersionPair,
} from './model.ts';

export interface TransitionChange {
  /** the complete requirement set after this transition. */
  pendingRequirements: Requirement[];
  /** move the evaluated baseline — only ever to the current published versions. */
  observed?: VersionPair;
  /** set, clear (null), or leave (undefined) the versions live runs may start under. */
  authorized?: VersionPair | null;
  /** evidence written in the same transaction, before the history row names it. */
  evidence?: NewEvidence;
  /** accept that evidence as the module's test or shadow evidence. */
  applyEvidenceAs?: 'test' | 'shadow' | null;
  health?: { status: HealthStatus; reason: string | null; evidence: Record<string, unknown> };
  /** the versions this transition concerns, for the history row. */
  versions?: VersionPair | null;
  previousVersions?: VersionPair | null;
  impact?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface TransitionRequest {
  tenantId: string;
  moduleKey: string;
  transition: TransitionKey;
  /** the state version the caller read; 0 when there is no lifecycle row yet. */
  expectedStateVersion: number;
  actor: { type: ActorType; id: string | null };
  reasonCode: string;
  reason: string | null;
  /** a repeat of the same key replays the first answer and changes nothing. */
  idempotencyKey: string;
  correlationId?: string | null;
  change: TransitionChange;
}

export interface TransitionResult {
  /** true when this idempotency key had already been applied — nothing changed now. */
  replayed: boolean;
  transition: TransitionRow;
  lifecycle: LifecycleRow;
  evidence: EvidenceRow | null;
  /** queued live work cancelled by a pause or a deselection. */
  cancelledActions: number;
}

export interface LifecycleStore {
  getLifecycle(tenantId: string, moduleKey: string): Promise<LifecycleRow | null>;
  listLifecycles(tenantId: string): Promise<LifecycleRow[]>;
  /** newest first. */
  listTransitions(tenantId: string, moduleKey: string, limit: number): Promise<TransitionRow[]>;
  /** the transition an idempotency key already produced, if any. */
  findTransitionByKey(tenantId: string, moduleKey: string, idempotencyKey: string): Promise<TransitionRow | null>;
  getEvidence(tenantId: string, moduleKey: string, evidenceId: string): Promise<EvidenceRow | null>;
  /** newest first. */
  listEvidence(tenantId: string, moduleKey: string, options: { kind?: EvidenceRow['kind']; versions?: VersionPair; limit: number }): Promise<EvidenceRow[]>;

  /** atomic. throws `LifecycleStoreError` for every refusal the database makes. */
  applyLifecycleTransition(request: TransitionRequest): Promise<TransitionResult>;

  /**
   * A shadow observation is evidence, not a transition: it changes no state, so it writes
   * no history row. The database still refuses one unless the module is in shadow and the
   * run it describes is a shadow run of that tenant and module.
   */
  recordShadowObservation(input: {
    tenantId: string;
    moduleKey: string;
    evidence: NewEvidence;
  }): Promise<EvidenceRow>;

  /* the readiness inputs ARC has today. ARC-130 replaces the second with connections. */
  listCompletedOnboardingSteps(tenantId: string, moduleKey: string): Promise<string[]>;
  hasActiveIntakeKey(tenantId: string): Promise<boolean>;
}
