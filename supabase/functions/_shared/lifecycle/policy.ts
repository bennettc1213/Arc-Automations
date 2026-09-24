/**
 * ARC-120 — what a configuration change, and what a health observation, mean for a
 * module's lifecycle. The two policy tables, and nothing else.
 *
 * **Change impact.** The registry is the authority on what a change *costs*
 * (`registry/schemas.ts` `changeImpact()`: `requiresRetest`, `requiresShadow`,
 * `requiresReactivation`, and an unrecognised field is maximally consequential). ARC-110
 * records that answer, audit-safe, on every published version (`change_impact`). This
 * file maps each of those classifications to lifecycle consequences — once, here — and
 * never re-derives the classification from field names.
 *
 * **Health.** An explicit table per status and per kind of execution, so "degraded
 * allows, failing denies" is a row somebody can read rather than a branch somebody has to
 * find.
 */

import type { HealthStatus, Requirement, RunMode } from './model.ts';

/* ── the change-impact classifications ──────────────────── */

/**
 * Every classification a recorded change impact can produce.
 *
 *   no_consequence          fields whose registry metadata carries no flag (holidays,
 *                           services, company name…)
 *   requires_retest         the registry's `requiresRetest`
 *   requires_shadow         the registry's `requiresShadow`
 *   requires_reactivation   the registry's `requiresReactivation`
 *   unknown_field           the registry did not recognise a changed field
 *   unclassified            the impact could not be read at all: missing, malformed, or
 *                           from a schema this build does not run
 */
export const IMPACT_CLASSIFICATIONS = [
  'no_consequence',
  'requires_retest',
  'requires_shadow',
  'requires_reactivation',
  'unknown_field',
  'unclassified',
] as const;
export type ImpactClassification = typeof IMPACT_CLASSIFICATIONS[number];

export interface LifecycleConsequence {
  /**
   * live authorisation, and the evidence behind it, carries to the new versions without
   * anything further. true only for a consequence-free change: evidence itself is always
   * bound to exact versions, so an activation always needs a test of what it authorises.
   */
  authorizationCarriesForward: boolean;
  /** requirements this change adds. */
  requires: readonly Requirement[];
  /** an active module may stay active (its operator's intent is unchanged). */
  mayRemainActive: boolean;
  /** new live runs may start under the new versions without anything further. */
  newRunsMayStart: boolean;
  /**
   * runs already in flight may keep going under their pinned snapshots. always equal to
   * `mayRemainActive`: a module that leaves `active` runs nothing live, in flight or new.
   */
  inFlightMayContinue: boolean;
}

/**
 * The one mapping from classification to lifecycle consequence.
 *
 * Read with the registry's own reasoning (ARC-100 §8–9): a template edit needs retesting
 * but not reactivation, because every run is pinned to a snapshot — an in-flight sequence
 * keeps its approved words and only new runs see the change. A compliance or sending-number
 * change must stop a live module until somebody re-approves it. Loosening a safety rule is
 * the change most worth watching before it is live.
 *
 * `unknown_field` and `unclassified` get every requirement there is: a typo must not slip a
 * change past a gate, and neither must an impact nobody could read.
 */
export const CHANGE_IMPACT_POLICY: Readonly<Record<ImpactClassification, LifecycleConsequence>> = Object.freeze({
  no_consequence: {
    authorizationCarriesForward: true,
    requires: [],
    mayRemainActive: true,
    newRunsMayStart: true,
    inFlightMayContinue: true,
  },
  requires_retest: {
    authorizationCarriesForward: false,
    requires: ['retest'],
    mayRemainActive: true,
    newRunsMayStart: false,
    inFlightMayContinue: true,
  },
  requires_shadow: {
    authorizationCarriesForward: false,
    requires: ['shadow', 'review'],
    /* shadow is a non-live state. a module cannot be live and gathering shadow evidence
       at once, so a change that needs shadow evidence takes it out of service — and a
       module out of service runs nothing, in flight or new. */
    mayRemainActive: false,
    newRunsMayStart: false,
    inFlightMayContinue: false,
  },
  requires_reactivation: {
    authorizationCarriesForward: false,
    requires: ['review', 'reactivation'],
    mayRemainActive: false,
    newRunsMayStart: false,
    /* "must block a live module until somebody re-approves" — including what was already
       queued under the configuration that is now withdrawn. */
    inFlightMayContinue: false,
  },
  unknown_field: {
    authorizationCarriesForward: false,
    requires: ['retest', 'shadow', 'review', 'reactivation'],
    mayRemainActive: false,
    newRunsMayStart: false,
    inFlightMayContinue: false,
  },
  unclassified: {
    authorizationCarriesForward: false,
    requires: ['retest', 'shadow', 'review', 'reactivation'],
    mayRemainActive: false,
    newRunsMayStart: false,
    inFlightMayContinue: false,
  },
});

/**
 * Classify one version's recorded change impact, as it concerns one module.
 *
 * `impact` is the audit-safe copy ARC-110 writes on the version row (`auditSafeImpact`):
 * `requires_retest`, `requires_shadow`, `requires_reactivation`, `unknown_fields`, and for a
 * tenant-scope version `affected_modules`. A tenant-scope change the module does not read
 * is `no_consequence` for it — the flags describe fields this module never sees.
 */
export function classifyRecordedImpact(
  impact: unknown,
  options: { scope: 'tenant' | 'module'; moduleKey: string },
): ImpactClassification[] {
  if (typeof impact !== 'object' || impact === null || Array.isArray(impact)) return ['unclassified'];
  const record = impact as Record<string, unknown>;
  const flags = ['requires_retest', 'requires_shadow', 'requires_reactivation'] as const;
  if (flags.some((f) => typeof record[f] !== 'boolean') || !Array.isArray(record.unknown_fields)) {
    return ['unclassified'];
  }

  if (options.scope === 'tenant') {
    if (!Array.isArray(record.affected_modules)) return ['unclassified'];
    if (!record.affected_modules.includes(options.moduleKey)) return ['no_consequence'];
  }

  const out: ImpactClassification[] = [];
  if ((record.unknown_fields as unknown[]).length > 0) out.push('unknown_field');
  if (record.requires_retest === true) out.push('requires_retest');
  if (record.requires_shadow === true) out.push('requires_shadow');
  if (record.requires_reactivation === true) out.push('requires_reactivation');
  return out.length > 0 ? out : ['no_consequence'];
}

/**
 * The combined consequence of several classifications: every requirement any of them
 * adds, and a permission only where all of them grant it. The most restrictive wins.
 */
export function combineConsequences(classifications: readonly ImpactClassification[]): LifecycleConsequence {
  const list = classifications.length > 0 ? classifications : (['no_consequence'] as const);
  const requires = new Set<Requirement>();
  let authorizationCarriesForward = true;
  let mayRemainActive = true;
  let newRunsMayStart = true;
  let inFlightMayContinue = true;
  for (const c of list) {
    const policy = CHANGE_IMPACT_POLICY[c] ?? CHANGE_IMPACT_POLICY.unclassified;
    policy.requires.forEach((r) => requires.add(r));
    authorizationCarriesForward &&= policy.authorizationCarriesForward;
    mayRemainActive &&= policy.mayRemainActive;
    newRunsMayStart &&= policy.newRunsMayStart;
    inFlightMayContinue &&= policy.inFlightMayContinue;
  }
  return {
    authorizationCarriesForward,
    requires: (['retest', 'shadow', 'review', 'reactivation'] as const).filter((r) => requires.has(r)),
    mayRemainActive,
    newRunsMayStart,
    inFlightMayContinue,
  };
}

/* ── the health overlay's execution policy ──────────────── */

export type HealthUse = 'activate' | 'live_start' | 'live_continue' | 'test' | 'shadow';

/**
 * What each health status permits.
 *
 * `unverified` is the honest default — no monitor has spoken — and it is never shown as
 * healthy. It does not by itself stop live work, and the reason is specific rather than
 * convenient: every live run already needs the operator's activation evidence (a passing
 * synthetic test of exactly the versions being run, connection readiness proven, onboarding
 * attested), and every effect re-reads consent, suppression, replies, takeover and the
 * send-once reservation immediately before it happens. What `unverified` lacks is a
 * *monitor*, which is ARC-LR-450's to add; when it does, changing this row to `false` is the
 * whole change. `failing` and `blocking` are negative evidence and always stop live work.
 * A synthetic test is allowed under any status — it is how a person finds out what is wrong.
 */
export const HEALTH_POLICY: Readonly<Record<HealthStatus, Readonly<Record<HealthUse, boolean>>>> = Object.freeze({
  unverified: { activate: true, live_start: true, live_continue: true, test: true, shadow: true },
  healthy: { activate: true, live_start: true, live_continue: true, test: true, shadow: true },
  degraded: { activate: true, live_start: true, live_continue: true, test: true, shadow: true },
  failing: { activate: false, live_start: false, live_continue: false, test: true, shadow: true },
  blocking: { activate: false, live_start: false, live_continue: false, test: true, shadow: false },
});

/** Whether health permits a use. An unknown status permits nothing but a test. */
export function healthPermits(status: string, use: HealthUse): boolean {
  const row = HEALTH_POLICY[status as HealthStatus];
  if (!row) return use === 'test';
  return row[use];
}

export function healthUseFor(mode: RunMode, kind: 'start' | 'continue' | 'effect'): HealthUse {
  if (mode === 'test') return 'test';
  if (mode === 'shadow') return 'shadow';
  return kind === 'start' ? 'live_start' : 'live_continue';
}
