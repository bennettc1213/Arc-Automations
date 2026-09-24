/**
 * ARC-120 — applying a published configuration change to a module's lifecycle.
 *
 * Publication and activation are separate decisions (ARC-110 publishes; this decides what
 * the publication means). The comparison is between the version a lifecycle last
 * evaluated (`observed`) and the current published head, and it uses the impact ARC-110
 * already recorded on each version in between — the registry's own flags, written when
 * that version was published — so the answer here and the database's check of it read
 * the same rows.
 *
 * Idempotent and complete by construction: every version after the baseline is evaluated
 * exactly once, whatever called this and however many times. A publication whose follow-up
 * never ran (a crash, a missed call site) leaves `observed` behind the head, and a module in
 * that state cannot start a live run — its authorised versions are not the head — until
 * `reconcileConfigChange` runs again. Nothing is repinned: runs keep their snapshots.
 */

import type { ConfigVersionRow } from '../config/model.ts';
import { moduleScope, TENANT_SCOPE } from '../config/model.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  type LifecycleRow,
  LifecycleStoreError,
  normaliseRequirements,
  parseLifecycleState,
  type Requirement,
  samePair,
  SYSTEM_ACTOR,
  type TransitionKey,
  type VersionPair,
} from './model.ts';
import {
  classifyRecordedImpact,
  combineConsequences,
  type ImpactClassification,
  type LifecycleConsequence,
} from './policy.ts';
import type { LifecycleStore } from './store.ts';

export interface ChainStep {
  scope: 'tenant' | 'module';
  version: number;
  versionId: string;
  classifications: ImpactClassification[];
}

/**
 * The versions published after `from` up to and including `to`, in one scope, oldest
 * first. Each step's recorded impact is relative to its parent, and the parent chain is
 * linear, so the union over the steps over-approximates the net change — never under.
 */
export function versionsBetween(
  all: readonly ConfigVersionRow[],
  fromId: string | null,
  toId: string,
): { ok: true; steps: ConfigVersionRow[] } | { ok: false } {
  const byId = new Map(all.map((v) => [v.id, v]));
  const to = byId.get(toId);
  if (!to) return { ok: false };
  const fromNumber = fromId === null ? 0 : byId.get(fromId)?.version;
  if (fromNumber === undefined) return { ok: false };
  if (fromNumber > to.version) return { ok: false };
  return {
    ok: true,
    steps: all.filter((v) => v.version > fromNumber && v.version <= to.version).sort((a, b) => a.version - b.version),
  };
}

/** Classify each step of both scopes' chains for one module. */
export function classifyChain(
  moduleKey: string,
  chains: { tenant: readonly ConfigVersionRow[]; module: readonly ConfigVersionRow[] },
): ChainStep[] {
  return [
    ...chains.tenant.map((v) => ({
      scope: 'tenant' as const,
      version: v.version,
      versionId: v.id,
      classifications: classifyRecordedImpact(v.changeImpact, { scope: 'tenant', moduleKey }),
    })),
    ...chains.module.map((v) => ({
      scope: 'module' as const,
      version: v.version,
      versionId: v.id,
      classifications: classifyRecordedImpact(v.changeImpact, { scope: 'module', moduleKey }),
    })),
  ];
}

export interface ConfigChangeOutcome {
  moduleKey: string;
  applied: boolean;
  transition: TransitionKey | null;
  classifications: ImpactClassification[];
  consequence: LifecycleConsequence | null;
  state: string | null;
  pending: Requirement[];
  note: string;
}

const HISTORY_LIMIT = 200;

/**
 * Evaluate every published change a module's lifecycle has not seen yet.
 *
 * On an active module:
 *   - a consequence-free change carries live authorisation to the new versions, provided
 *     authorisation was current before it (nothing was already pending);
 *   - a change the registry says needs only a retest keeps the module active — the
 *     operator's decision stands, in-flight runs keep their pinned words — and holds new
 *     live runs until a passing test of the new versions is recorded;
 *   - anything else (shadow, reactivation, an unknown field, an unreadable impact) pauses
 *     it, as a system-authored transition naming the cause. Nothing ever un-pauses it
 *     automatically.
 * On any other selected module the requirements are recorded against it, so the next
 * activation has to meet them.
 */
export async function reconcileConfigChange(
  store: ConfigStore & LifecycleStore,
  args: { tenantId: string; moduleKey: string; correlationId?: string | null },
): Promise<ConfigChangeOutcome> {
  const { tenantId, moduleKey } = args;
  const none = (note: string, lifecycle: LifecycleRow | null = null): ConfigChangeOutcome => ({
    moduleKey,
    applied: false,
    transition: null,
    classifications: [],
    consequence: null,
    state: lifecycle?.state ?? null,
    pending: normaliseRequirements(lifecycle?.pendingRequirements ?? []),
    note,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lifecycle = await store.getLifecycle(tenantId, moduleKey);
    if (!lifecycle) return none('this module is not selected — nothing to evaluate');
    const state = parseLifecycleState(lifecycle.state);
    /* an unknown state is refused by every authorisation already; guessing a transition
       for it here would be writing on top of something this build does not understand. */
    if (!state) return none(`the stored state "${lifecycle.state}" is not one this build knows — left alone, and it fails closed`, lifecycle);
    if (state === 'unselected') return none('this module is deselected — nothing to evaluate', lifecycle);

    const [tenantHead, moduleHead] = await Promise.all([
      store.getConfigHead(tenantId, TENANT_SCOPE),
      store.getConfigHead(tenantId, moduleScope(moduleKey)),
    ]);
    if (!tenantHead || !moduleHead) return none('no published configuration to evaluate', lifecycle);
    const heads: VersionPair = { tenantVersionId: tenantHead.id, moduleVersionId: moduleHead.id };
    if (samePair(lifecycle.observed, heads)) return none('already evaluated', lifecycle);

    const pendingBefore = normaliseRequirements(lifecycle.pendingRequirements);
    let classifications: ImpactClassification[];
    let chain: ChainStep[] = [];
    let baseline = false;

    if (!lifecycle.observed) {
      /* the first configuration this lifecycle sees. there is no earlier version it was
         tested or authorised against, so there is no change to price: the baseline is set,
         and an activation still needs a test of exactly these versions. */
      baseline = true;
      classifications = [];
    } else {
      const [tenantVersions, moduleVersions] = await Promise.all([
        store.listConfigVersions(tenantId, TENANT_SCOPE, HISTORY_LIMIT),
        store.listConfigVersions(tenantId, moduleScope(moduleKey), HISTORY_LIMIT),
      ]);
      const tenantSteps = versionsBetween(tenantVersions, lifecycle.observed.tenantVersionId, heads.tenantVersionId);
      const moduleSteps = versionsBetween(moduleVersions, lifecycle.observed.moduleVersionId, heads.moduleVersionId);
      if (!tenantSteps.ok || !moduleSteps.ok) {
        classifications = ['unclassified'];
      } else {
        chain = classifyChain(moduleKey, { tenant: tenantSteps.steps, module: moduleSteps.steps });
        classifications = [...new Set(chain.flatMap((s) => s.classifications))];
      }
    }

    const consequence = combineConsequences(classifications);
    const pendingAfter = normaliseRequirements([...pendingBefore, ...(baseline ? [] : consequence.requires)]);

    let transition: TransitionKey = 'apply_config_change';
    let authorized: VersionPair | undefined;
    if (state === 'active' && !baseline) {
      if (!consequence.mayRemainActive) {
        transition = 'system_pause';
      } else if (
        consequence.authorizationCarriesForward
        && samePair(lifecycle.authorized, lifecycle.observed)
        && !pendingBefore.some((r) => r === 'retest' || r === 'shadow')
      ) {
        authorized = heads;
      }
    }

    const impact = {
      baseline,
      classifications,
      chain: chain.map((s) => ({ scope: s.scope, version: s.version, version_id: s.versionId, classifications: s.classifications })),
    };
    const policy = {
      authorization_carries_forward: consequence.authorizationCarriesForward,
      requires: consequence.requires,
      may_remain_active: consequence.mayRemainActive,
      new_runs_may_start: consequence.newRunsMayStart,
      in_flight_may_continue: consequence.inFlightMayContinue,
      authorization_advanced: Boolean(authorized),
    };

    try {
      const result = await store.applyLifecycleTransition({
        tenantId,
        moduleKey,
        transition,
        expectedStateVersion: lifecycle.stateVersion,
        actor: SYSTEM_ACTOR,
        reasonCode: baseline ? 'baseline_established' : transition === 'system_pause' ? 'config_change_requires_reactivation' : 'config_change_evaluated',
        reason: baseline
          ? 'the first published configuration this lifecycle has seen'
          : transition === 'system_pause'
            ? `a published change (${classifications.join(', ')}) may not stay live — paused until an operator re-activates it`
            : `a published change (${classifications.join(', ') || 'none'}) was evaluated`,
        /* the pair of heads is the change's identity: evaluating it twice is one decision. */
        idempotencyKey: `config:${moduleKey}:${heads.tenantVersionId}:${heads.moduleVersionId}`,
        correlationId: args.correlationId ?? null,
        change: {
          pendingRequirements: pendingAfter,
          observed: heads,
          ...(authorized ? { authorized } : {}),
          versions: heads,
          previousVersions: lifecycle.observed,
          impact,
          policy,
        },
      });
      return {
        moduleKey,
        applied: !result.replayed,
        transition,
        classifications,
        consequence,
        state: result.lifecycle.state,
        pending: normaliseRequirements(result.lifecycle.pendingRequirements),
        note: result.replayed ? 'this change had already been evaluated' : policy.authorization_advanced
          ? 'consequence-free: live authorisation carried to the new versions'
          : transition === 'system_pause'
            ? 'paused: the change may not stay live'
            : pendingAfter.length > 0
              ? `recorded: ${pendingAfter.join(', ')} required before new live runs`
              : 'recorded',
      };
    } catch (error) {
      /* somebody else moved the lifecycle between the read and the write — read again. */
      if (error instanceof LifecycleStoreError && error.code === 'stale_state') continue;
      throw error;
    }
  }
  return none('the lifecycle kept changing underneath this evaluation — it will be retried by the next reconciliation');
}

/**
 * After a publication in either scope: evaluate it for every selected module the tenant
 * has. A tenant-settings change reaches every module that composes those settings.
 */
export async function reconcileAfterPublication(
  store: ConfigStore & LifecycleStore,
  args: { tenantId: string; moduleKey: string | null; correlationId?: string | null },
): Promise<ConfigChangeOutcome[]> {
  const lifecycles = await store.listLifecycles(args.tenantId);
  const keys = args.moduleKey ? [args.moduleKey] : lifecycles.map((l) => l.moduleKey);
  const out: ConfigChangeOutcome[] = [];
  for (const moduleKey of [...new Set(keys)]) {
    out.push(await reconcileConfigChange(store, { tenantId: args.tenantId, moduleKey, correlationId: args.correlationId }));
  }
  return out;
}

/** Whether a store carries the lifecycle half — every production and test store does. */
export function hasLifecycle(store: unknown): store is ConfigStore & LifecycleStore {
  return typeof (store as { applyLifecycleTransition?: unknown })?.applyLifecycleTransition === 'function';
}
