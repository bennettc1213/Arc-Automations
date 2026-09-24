/* fixtures for ARC-110's versioned configuration.
 *
 * Since 0014 the engine reads configuration from published versions, never from
 * `module_configs.config`. The runtime suites need a tenant "configured like this" in one
 * synchronous line, so this builds exactly the rows `publish_config_draft` would — a
 * closed draft and a numbered version per scope, the switch row, an operator — without
 * going through the engine's async publish path. The publish path itself is what
 * `tests/config-engine.test.js` and `tests/config-contract.test.js` exercise; these
 * fixtures only stand a tenant up.
 *
 * Only a scope whose content changed gets a new version, which is what the console's
 * save button does, so "edit the configuration mid-sequence" in a test is one more call.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../supabase/functions/_shared/canonical-json.ts';
import { splitEffective } from '../supabase/functions/_shared/config/compose.ts';
import { analyseChange, auditSafeImpact } from '../supabase/functions/_shared/config/impact.ts';
import { defaultConfig, REQUIRED_STEPS, validateLeadRecoveryConfig } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { reconcileConfigChange } from '../supabase/functions/_shared/lifecycle/impact.ts';
import { resolveModuleRuntime } from '../supabase/functions/_shared/registry/index.ts';
import { tenantSettingsSchema } from '../supabase/functions/_shared/registry/schemas.ts';

export const FIXTURE_OPERATOR = 'eeeeeeee-0000-4000-8000-00000000000a';

/**
 * Every onboarding step activation needs, attested — what a genuinely onboarded module
 * has. Connection readiness reads `twilio_connected` and `routing_tested` from it.
 */
export const ONBOARDED_STEPS = [...REQUIRED_STEPS];

/** A complete, valid, activatable Lead Recovery configuration — normalised. */
export function leadRecoveryConfig(overrides = {}) {
  const result = validateLeadRecoveryConfig({
    ...defaultConfig(),
    company_name: 'Halstead Heating',
    timezone: 'America/New_York',
    services: ['furnace repair', 'water heater'],
    service_area: { zips: ['43215'], cities: [], note: null },
    forwarding: { destination: '+16145550137', timeout_seconds: 20 },
    staff_alerts: [{ name: 'Dana', channel: 'sms', address: '+16145550188' }],
    compliance: {
      status: 'approved', brand_registered: true, campaign_ref: 'CMP123',
      reviewed_at: null, opt_out_language: 'Reply STOP to opt out.',
    },
    twilio: {
      subaccount_sid: null, messaging_service_sid: 'MG0123456789abcdef0123456789abcdef',
      phone_number: '+16145550100', phone_number_sid: null,
    },
    ...overrides,
  });
  if (!result.ok) throw new Error(`leadRecoveryConfig fixture is invalid: ${result.errors.join('; ')}`);
  return result.config;
}

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Split a complete effective configuration into its two stored documents. */
export function splitForStorage(config, moduleKey = 'lead_recovery') {
  const runtime = resolveModuleRuntime(moduleKey);
  const validated = runtime.schema.validate(config);
  if (!validated.ok) throw new Error(`the fixture config must be valid: ${validated.errors.join('; ')}`);
  return { ...splitEffective(runtime.schema, validated.config), schema: runtime.schema, effective: validated.config };
}

function publishRows(store, tenantId, scope, schema, doc) {
  const moduleKey = scope.kind === 'module' ? scope.moduleKey : null;
  const versions = scope.kind === 'tenant' ? store.tenantConfigVersions : store.moduleConfigVersions;
  const mine = versions.filter((v) => v.tenantId === tenantId && v.moduleKey === moduleKey);
  const head = mine.reduce((best, v) => (!best || v.version > best.version ? v : best), null);
  if (head && canonicalJson(head.config) === canonicalJson(doc)) return head;

  const now = new Date().toISOString();
  const draftId = crypto.randomUUID();
  /* the audit-safe impact publication records, computed the way `publishDraft` computes it —
     the lifecycle prices every change from exactly this. */
  const changeImpact = auditSafeImpact(analyseChange(schema, head?.config ?? {}, doc));
  const version = {
    id: crypto.randomUUID(),
    tenantId,
    scope: scope.kind,
    moduleKey,
    version: (head?.version ?? 0) + 1,
    schemaKey: schema.key,
    schemaVersion: schema.version,
    config: clone(doc),
    configHash: sha256(doc),
    parentVersionId: head?.id ?? null,
    rollbackOfVersionId: null,
    source: 'draft',
    publishedFromDraftId: draftId,
    provenance: { fixture: true, draft_revision: 1 },
    changeImpact,
    createdBy: FIXTURE_OPERATOR,
    publishedBy: FIXTURE_OPERATOR,
    publishedAt: now,
    note: null,
  };
  store.configDrafts.push({
    id: draftId,
    tenantId,
    scope: scope.kind,
    moduleKey,
    schemaKey: schema.key,
    schemaVersion: schema.version,
    baseVersionId: head?.id ?? null,
    baseVersion: head?.version ?? 0,
    config: clone(doc),
    revision: 2,
    status: 'published',
    publishedVersionId: version.id,
    origin: {},
    createdBy: FIXTURE_OPERATOR,
    updatedBy: FIXTURE_OPERATOR,
    createdAt: now,
    updatedAt: now,
    closedAt: now,
  });
  versions.push(deepFreeze(version));
  return version;
}

/**
 * Stand a tenant up with this configuration published, on a `MemoryStore`.
 *
 * `config` is a complete effective Lead Recovery configuration, validated here so a
 * fixture that would not pass the registered validator fails loudly rather than
 * producing a tenant the resolver then refuses.
 */
export function seedPublishedConfig(store, { tenantId, config, enabled = true, moduleKey = 'lead_recovery', lifecycle: withLifecycle = true }) {
  const { tenant, module, schema } = splitForStorage(config, moduleKey);
  const tenantVersion = publishRows(store, tenantId, { kind: 'tenant' }, tenantSettingsSchema(), tenant);
  const moduleVersion = publishRows(store, tenantId, { kind: 'module', moduleKey }, schema, module);
  if (!store.operators.includes(FIXTURE_OPERATOR)) store.operators.push(FIXTURE_OPERATOR);

  /* the lifecycle an operator would have left behind (ARC-120): switched on means selected,
     tested and activated on exactly these versions; switched off means selected and under
     test — a canary may run, nothing live may. a tenant that already has a lifecycle keeps
     it: a later publication is priced by `reconcileConfigChange`, as in production.
     `lifecycle: false` leaves the module unselected, as a fresh publication does. */
  if (withLifecycle && !store.lifecycles.some((l) => l.tenantId === tenantId && l.moduleKey === moduleKey)) {
    seedLifecycle(store, { tenantId, moduleKey, state: enabled ? 'active' : 'testing' });
  }
  const lifecycle = store.lifecycles.find((l) => l.tenantId === tenantId && l.moduleKey === moduleKey);
  const row = store.configs.find((c) => c.tenantId === tenantId && c.moduleKey === moduleKey);
  if (row) row.enabled = lifecycle?.state === 'active';
  else store.configs.push({ tenantId, moduleKey, enabled: lifecycle?.state === 'active', schemaVersion: 1, configVersion: 1, config: {} });
  return { tenantVersion, moduleVersion };
}

function headPair(store, tenantId, moduleKey) {
  const top = (list) => list.reduce((best, v) => (!best || v.version > best.version ? v : best), null);
  const tenant = top(store.tenantConfigVersions.filter((v) => v.tenantId === tenantId));
  const module = top(store.moduleConfigVersions.filter((v) => v.tenantId === tenantId && v.moduleKey === moduleKey));
  return tenant && module ? { tenant, module, pair: { tenantVersionId: tenant.id, moduleVersionId: module.id } } : null;
}

/**
 * Stand a tenant module's lifecycle up at `state`, on the current published versions, as
 * the operator path would leave it — rows written directly, like the version rows above.
 *
 *   active     selected, onboarded, a passing test of these versions, authorised on them
 *   paused     the same, then paused by an operator
 *   testing    selected and onboarded, nothing tested or authorised yet
 *   shadow     tested, in shadow
 *   configuring / unselected   as named
 *
 * The engine's own transitions are exercised by `tests/lifecycle-engine.test.js`; this
 * only stands a tenant up so the runtime suites can say "live" in one line.
 */
export function seedLifecycle(store, { tenantId, moduleKey = 'lead_recovery', state = 'active', health = 'unverified', pending = [] }) {
  const heads = headPair(store, tenantId, moduleKey);
  if (!heads && ['active', 'paused', 'shadow'].includes(state)) throw new Error(`seedLifecycle(${state}) needs published configuration first`);
  const now = new Date().toISOString();

  for (const stepKey of ONBOARDED_STEPS) {
    if (!store.onboardingSteps.some((s) => s.tenantId === tenantId && s.moduleKey === moduleKey && s.stepKey === stepKey)) {
      store.onboardingSteps.push({ tenantId, moduleKey, stepKey, doneAt: now });
    }
  }

  const existing = store.lifecycles.find((l) => l.tenantId === tenantId && l.moduleKey === moduleKey);
  const tested = ['active', 'paused', 'shadow'].includes(state);
  let evidenceId = null;
  if (tested) {
    evidenceId = crypto.randomUUID();
    store.lifecycleEvidence.push({
      id: evidenceId,
      tenantId,
      moduleKey,
      lifecycleId: existing?.id ?? null,
      kind: 'test',
      outcome: 'passed',
      runMode: 'test',
      versions: { ...heads.pair },
      configHash: heads.module.configHash,
      capabilities: [],
      runId: null,
      simulated: true,
      summary: { fixture: true },
      actorType: 'operator',
      recordedBy: FIXTURE_OPERATOR,
      recordedAt: now,
    });
  }
  const row = {
    id: existing?.id ?? crypto.randomUUID(),
    tenantId,
    moduleKey,
    state,
    stateVersion: (existing?.stateVersion ?? 0) + 1,
    pendingRequirements: [...pending],
    observed: heads ? { ...heads.pair } : null,
    authorized: ['active', 'paused'].includes(state) ? { ...heads.pair } : null,
    tested: tested ? { ...heads.pair } : null,
    testEvidenceId: evidenceId,
    shadowed: null,
    shadowEvidenceId: null,
    healthStatus: health,
    healthReason: null,
    healthEvidence: health === 'unverified' ? {} : { source: 'fixture' },
    healthCheckedAt: health === 'unverified' ? null : now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (evidenceId) store.lifecycleEvidence.at(-1).lifecycleId = row.id;
  if (existing) Object.assign(existing, row);
  else store.lifecycles.push(row);
  store.lifecycleTransitions.push({
    id: crypto.randomUUID(),
    tenantId,
    moduleKey,
    lifecycleId: row.id,
    stateVersion: row.stateVersion,
    transition: existing ? 'fixture' : 'select',
    fromState: existing?.state ?? 'unselected',
    toState: state,
    actorType: 'operator',
    actorId: FIXTURE_OPERATOR,
    reasonCode: 'fixture',
    reason: null,
    idempotencyKey: `fixture:${row.id}:${row.stateVersion}`,
    correlationId: null,
    versions: heads ? { ...heads.pair } : null,
    previousVersions: null,
    evidenceId,
    impact: {},
    policy: {},
    pendingBefore: [],
    pendingAfter: [...pending],
    healthBefore: null,
    healthAfter: health,
    metadata: { fixture: true },
    occurredAt: now,
  });
  const switchRow = store.configs.find((c) => c.tenantId === tenantId && c.moduleKey === moduleKey);
  if (switchRow) switchRow.enabled = state === 'active';
  if (!store.operators.includes(FIXTURE_OPERATOR)) store.operators.push(FIXTURE_OPERATOR);
  return row;
}

/**
 * Publish an edit to a seeded tenant: the current effective configuration with `patch`
 * applied, as the next version of whichever scopes it changes — and then priced by the
 * lifecycle exactly as a real publication is (`reconcileConfigChange`). What "the operator
 * changed the configuration mid-sequence" is, now that nothing edits a row in place.
 */
export async function republish(store, tenantId, patch, { moduleKey = 'lead_recovery' } = {}) {
  const head = (list) => list
    .filter((v) => v.tenantId === tenantId && (list === store.tenantConfigVersions || v.moduleKey === moduleKey))
    .reduce((best, v) => (!best || v.version > best.version ? v : best), null);
  const tenant = head(store.tenantConfigVersions);
  const module = head(store.moduleConfigVersions);
  if (!tenant || !module) throw new Error('republish needs a tenant seeded with seedPublishedConfig first');
  const published = seedPublishedConfig(store, {
    tenantId,
    moduleKey,
    config: { ...clone(module.config), ...clone(tenant.config), ...patch },
  });
  const lifecycle = await reconcileConfigChange(store, { tenantId, moduleKey });
  return { ...published, lifecycle };
}

/**
 * The same lifecycle, as snake_case rows for `supabaseDouble` — what 0015's tables would
 * hold for a tenant whose versions are `rows` (from `publishedConfigRows`).
 */
export function lifecycleRows(tenantId, rows, { moduleKey = 'lead_recovery', state = 'active' } = {}) {
  const tenantVersion = rows.tenant_config_versions.at(-1);
  const moduleVersion = rows.module_config_versions.at(-1);
  const now = new Date().toISOString();
  const lifecycleId = crypto.randomUUID();
  const tested = ['active', 'paused', 'shadow'].includes(state);
  const evidenceId = tested ? crypto.randomUUID() : null;
  const pairCols = (prefix, on) => ({
    [`${prefix}_tenant_config_version_id`]: on ? tenantVersion.id : null,
    [`${prefix}_module_config_version_id`]: on ? moduleVersion.id : null,
  });
  return {
    tenant_modules: [{
      id: lifecycleId,
      tenant_id: tenantId,
      module_key: moduleKey,
      state,
      state_version: 1,
      pending_requirements: [],
      ...pairCols('observed', true),
      ...pairCols('authorized', ['active', 'paused'].includes(state)),
      ...pairCols('tested', tested),
      test_evidence_id: evidenceId,
      ...pairCols('shadow', false),
      shadow_evidence_id: null,
      health_status: 'unverified',
      health_reason: null,
      health_evidence: {},
      health_checked_at: null,
      created_at: now,
      updated_at: now,
    }],
    module_onboarding: ONBOARDED_STEPS.map((step_key) => ({ tenant_id: tenantId, module_key: moduleKey, step_key, done_at: now })),
    tenant_module_evidence: tested
      ? [{
        id: evidenceId, tenant_id: tenantId, module_key: moduleKey, lifecycle_id: lifecycleId, kind: 'test', outcome: 'passed',
        run_mode: 'test', tenant_config_version_id: tenantVersion.id, module_config_version_id: moduleVersion.id,
        config_hash: moduleVersion.config_hash, capabilities: [], run_id: null, simulated: true, summary: { fixture: true },
        actor_type: 'operator', recorded_by: FIXTURE_OPERATOR, recorded_at: now,
      }]
      : [],
  };
}

/**
 * The same, as snake_case rows for `supabaseDouble` — what 0014's tables would hold.
 */
export function publishedConfigRows(tenantId, config, { moduleKey = 'lead_recovery', versions = { tenant: 1, module: 1 } } = {}) {
  const { tenant, module, schema } = splitForStorage(config, moduleKey);
  const now = new Date().toISOString();
  const row = (scope, doc, schemaKey, schemaVersion, version) => ({
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    ...(scope === 'module' ? { module_key: moduleKey } : {}),
    version,
    schema_key: schemaKey,
    schema_version: schemaVersion,
    config: clone(doc),
    config_hash: sha256(doc),
    parent_version_id: null,
    rollback_of_version_id: null,
    source: 'draft',
    published_from_draft_id: crypto.randomUUID(),
    provenance: { fixture: true },
    change_impact: {},
    created_by: FIXTURE_OPERATOR,
    published_by: FIXTURE_OPERATOR,
    published_at: now,
    note: null,
  });
  const tenantSchema = tenantSettingsSchema();
  return {
    tenant_config_versions: [row('tenant', tenant, tenantSchema.key, tenantSchema.version, versions.tenant)],
    module_config_versions: [row('module', module, schema.key, schema.version, versions.module)],
  };
}
