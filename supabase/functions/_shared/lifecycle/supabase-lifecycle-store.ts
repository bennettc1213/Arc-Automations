/**
 * The production adapter for ARC-120's lifecycle tables (0015).
 *
 * Every column the service relies on is named here explicitly, in both directions — the
 * ARC-015B defect was an insert that left one out while the in-memory store kept the whole
 * object. `tests/lifecycle-adapter.test.js` asserts the payloads through a double that
 * stores only what it is sent, and `tests/lifecycle-db.test.js` runs the same promises over
 * real SQL where PGlite is available.
 *
 * Every transition is one RPC, `apply_tenant_module_transition`; the database's refusals
 * arrive as `arc_lifecycle:<code>: …` and become `LifecycleStoreError`, so the service sees
 * the same thing from either store.
 */

import {
  type EvidenceRow,
  type LifecycleRow,
  parseLifecycleStoreError,
  type TransitionRow,
  type VersionPair,
} from './model.ts';
import type { LifecycleStore, TransitionRequest } from './store.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? 'unknown database error'}`);
}

/** Our own refusal if it is one, otherwise the generic failure. */
export function raiseLifecycle(what: string, error: { message?: string }): never {
  const parsed = parseLifecycleStoreError(error.message);
  if (parsed) throw parsed;
  fail(what, error);
}

// deno-lint-ignore no-explicit-any
const pair = (row: any, prefix: string): VersionPair | null =>
  row[`${prefix}_tenant_config_version_id`] && row[`${prefix}_module_config_version_id`]
    ? { tenantVersionId: row[`${prefix}_tenant_config_version_id`], moduleVersionId: row[`${prefix}_module_config_version_id`] }
    : null;

const pairOut = (value: VersionPair | null | undefined) =>
  value ? { tenant_version_id: value.tenantVersionId, module_version_id: value.moduleVersionId } : null;

// deno-lint-ignore no-explicit-any
export const toLifecycle = (row: any): LifecycleRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  moduleKey: row.module_key,
  state: row.state,
  stateVersion: Number(row.state_version),
  pendingRequirements: row.pending_requirements ?? [],
  observed: pair(row, 'observed'),
  authorized: pair(row, 'authorized'),
  tested: pair(row, 'tested'),
  testEvidenceId: row.test_evidence_id ?? null,
  shadowed: pair(row, 'shadow'),
  shadowEvidenceId: row.shadow_evidence_id ?? null,
  healthStatus: row.health_status,
  healthReason: row.health_reason ?? null,
  healthEvidence: row.health_evidence ?? {},
  healthCheckedAt: row.health_checked_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// deno-lint-ignore no-explicit-any
export const toTransition = (row: any): TransitionRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  moduleKey: row.module_key,
  lifecycleId: row.lifecycle_id,
  stateVersion: Number(row.state_version),
  transition: row.transition,
  fromState: row.from_state ?? null,
  toState: row.to_state,
  actorType: row.actor_type,
  actorId: row.actor_id ?? null,
  reasonCode: row.reason_code,
  reason: row.reason ?? null,
  idempotencyKey: row.idempotency_key,
  correlationId: row.correlation_id ?? null,
  versions: row.tenant_config_version_id && row.module_config_version_id
    ? { tenantVersionId: row.tenant_config_version_id, moduleVersionId: row.module_config_version_id }
    : null,
  previousVersions: pair(row, 'previous'),
  evidenceId: row.evidence_id ?? null,
  impact: row.impact ?? {},
  policy: row.policy ?? {},
  pendingBefore: row.pending_before ?? [],
  pendingAfter: row.pending_after ?? [],
  healthBefore: row.health_before ?? null,
  healthAfter: row.health_after ?? null,
  metadata: row.metadata ?? {},
  occurredAt: row.occurred_at,
});

// deno-lint-ignore no-explicit-any
export const toEvidence = (row: any): EvidenceRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  moduleKey: row.module_key,
  lifecycleId: row.lifecycle_id,
  kind: row.kind,
  outcome: row.outcome,
  runMode: row.run_mode ?? null,
  versions: { tenantVersionId: row.tenant_config_version_id, moduleVersionId: row.module_config_version_id },
  configHash: row.config_hash,
  capabilities: row.capabilities ?? [],
  runId: row.run_id ?? null,
  simulated: true,
  summary: row.summary ?? {},
  actorType: row.actor_type,
  recordedBy: row.recorded_by ?? null,
  recordedAt: row.recorded_at,
});

/** The change, as the SQL function reads it: snake_case, pairs as objects, nothing implied. */
export function transitionChangePayload(change: TransitionRequest['change']): Record<string, unknown> {
  const out: Record<string, unknown> = {
    pending_requirements: change.pendingRequirements,
  };
  if (change.observed) out.observed = pairOut(change.observed);
  if (change.authorized !== undefined) out.authorized = pairOut(change.authorized);
  if (change.evidence) {
    out.evidence = {
      kind: change.evidence.kind,
      outcome: change.evidence.outcome,
      run_mode: change.evidence.runMode,
      tenant_version_id: change.evidence.versions.tenantVersionId,
      module_version_id: change.evidence.versions.moduleVersionId,
      config_hash: change.evidence.configHash,
      capabilities: change.evidence.capabilities,
      run_id: change.evidence.runId,
      summary: change.evidence.summary,
    };
  }
  if (change.applyEvidenceAs) out.apply_evidence_as = change.applyEvidenceAs;
  if (change.health) out.health = { status: change.health.status, reason: change.health.reason, evidence: change.health.evidence };
  if (change.versions) out.versions = pairOut(change.versions);
  if (change.previousVersions) out.previous_versions = pairOut(change.previousVersions);
  if (change.impact) out.impact = change.impact;
  if (change.policy) out.policy = change.policy;
  if (change.metadata) out.metadata = change.metadata;
  return out;
}

export function supabaseLifecycleStore(db: Db): LifecycleStore {
  const store: LifecycleStore = {
    async getLifecycle(tenantId, moduleKey) {
      const { data, error } = await db.from('tenant_modules').select('*').eq('tenant_id', tenantId).eq('module_key', moduleKey).maybeSingle();
      if (error) fail('lifecycle read', error);
      return data ? toLifecycle(data) : null;
    },

    async listLifecycles(tenantId) {
      const { data, error } = await db.from('tenant_modules').select('*').eq('tenant_id', tenantId);
      if (error) fail('lifecycle list', error);
      return (data ?? []).map(toLifecycle);
    },

    async listTransitions(tenantId, moduleKey, limit) {
      const { data, error } = await db
        .from('tenant_module_transitions')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('module_key', moduleKey)
        .order('state_version', { ascending: false })
        .limit(limit);
      if (error) fail('lifecycle history read', error);
      return (data ?? []).map(toTransition);
    },

    async findTransitionByKey(tenantId, moduleKey, idempotencyKey) {
      const { data, error } = await db
        .from('tenant_module_transitions')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('module_key', moduleKey)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (error) fail('lifecycle idempotency read', error);
      return data ? toTransition(data) : null;
    },

    async getEvidence(tenantId, moduleKey, evidenceId) {
      const { data, error } = await db
        .from('tenant_module_evidence')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('module_key', moduleKey)
        .eq('id', evidenceId)
        .maybeSingle();
      if (error) fail('evidence read', error);
      return data ? toEvidence(data) : null;
    },

    async listEvidence(tenantId, moduleKey, options) {
      let query = db.from('tenant_module_evidence').select('*').eq('tenant_id', tenantId).eq('module_key', moduleKey);
      if (options.kind) query = query.eq('kind', options.kind);
      if (options.versions) {
        query = query
          .eq('tenant_config_version_id', options.versions.tenantVersionId)
          .eq('module_config_version_id', options.versions.moduleVersionId);
      }
      const { data, error } = await query.order('recorded_at', { ascending: false }).limit(options.limit);
      if (error) fail('evidence list', error);
      return (data ?? []).map(toEvidence);
    },

    async applyLifecycleTransition(request) {
      const { data, error } = await db.rpc('apply_tenant_module_transition', {
        p_tenant: request.tenantId,
        p_module_key: request.moduleKey,
        p_transition: request.transition,
        p_expected_state_version: request.expectedStateVersion,
        p_actor_type: request.actor.type,
        p_actor: request.actor.id,
        p_reason_code: request.reasonCode,
        p_reason: request.reason,
        p_idempotency_key: request.idempotencyKey,
        p_change: transitionChangePayload(request.change),
        p_correlation_id: request.correlationId ?? null,
      });
      if (error) raiseLifecycle('lifecycle transition', error);
      if (!data || typeof data !== 'object' || !data.transition || !data.lifecycle) {
        fail('lifecycle transition', { message: 'the database returned no transition' });
      }
      return {
        replayed: data.replayed === true,
        transition: toTransition(data.transition),
        lifecycle: toLifecycle(data.lifecycle),
        evidence: data.evidence ? toEvidence(data.evidence) : null,
        cancelledActions: Number(data.cancelled_actions ?? 0),
      };
    },

    async recordShadowObservation(input) {
      /* evidence, not a transition — a direct insert the 0015 trigger checks: the module is
         in shadow, and the run is a shadow run of this tenant and module, pinned to exactly
         the versions named. */
      const lifecycle = await store.getLifecycle(input.tenantId, input.moduleKey);
      if (!lifecycle) raiseLifecycle('shadow observation', { message: 'arc_lifecycle:module_not_selected: no lifecycle to record against' });
      const { data, error } = await db
        .from('tenant_module_evidence')
        .insert({
          tenant_id: input.tenantId,
          module_key: input.moduleKey,
          lifecycle_id: lifecycle!.id,
          kind: input.evidence.kind,
          outcome: input.evidence.outcome,
          run_mode: input.evidence.runMode,
          tenant_config_version_id: input.evidence.versions.tenantVersionId,
          module_config_version_id: input.evidence.versions.moduleVersionId,
          config_hash: input.evidence.configHash,
          capabilities: input.evidence.capabilities,
          run_id: input.evidence.runId,
          summary: input.evidence.summary,
          actor_type: 'system',
          recorded_by: null,
        })
        .select('*')
        .single();
      if (error) raiseLifecycle('shadow observation', error);
      return toEvidence(data);
    },

    async listCompletedOnboardingSteps(tenantId, moduleKey) {
      const { data, error } = await db.from('module_onboarding').select('step_key, done_at').eq('tenant_id', tenantId).eq('module_key', moduleKey);
      if (error) fail('onboarding read', error);
      return (data ?? []).filter((r: { done_at: string | null }) => r.done_at).map((r: { step_key: string }) => r.step_key);
    },

    async hasActiveIntakeKey(tenantId) {
      const { data, error } = await db.from('intake_keys').select('id').eq('tenant_id', tenantId).is('revoked_at', null).limit(1);
      if (error) fail('intake key read', error);
      return (data ?? []).length > 0;
    },
  };
  return store;
}
