/**
 * The operator surface of ARC-110's configuration engine.
 *
 * Behind the `ops` function's existing admin check, like everything else in this
 * directory: by the time a request reaches here the caller's JWT has been verified and
 * `is_arc_admin()` has said yes, and the actor id is the one taken from that token —
 * never a field in the body. This file translates HTTP to `config/engine.ts` and back;
 * every rule lives in the engine, so the tests exercise the rules, not the plumbing.
 *
 *   config-get             current versions, open drafts and (for a module) the resolution
 *   config-history         the version list of one scope, newest first, metadata only
 *   config-version         one historical version, in full
 *   config-resolve         the effective configuration a new run would start under
 *   config-draft-create    open a draft from the current version (or the schema defaults)
 *   config-draft-get       the open draft of a scope
 *   config-draft-update    change fields; needs expected_revision
 *   config-draft-validate  validate without writing
 *   config-draft-preview   the change against the current version, and its impact
 *   config-draft-discard   close a draft without publishing; needs expected_revision
 *   config-publish         publish a draft; needs expected_revision and expected_version
 *   config-rollback        republish a historical version as the next; needs expected_version
 *   config-import-legacy   validate and publish the drafts 0014 copied from module_configs
 *
 * ARC-310's settings screen reads through three more, none of which writes:
 *
 *   config-scope             one scope in one round trip: its fields from the registry (which
 *                            the operator may edit), the current version, the open draft, and
 *                            the lifecycle state of the modules it reaches
 *   config-compare           two versions of one scope, field by field, redacted as a preview is
 *   config-rollback-preview  what restoring a version would change against the current one,
 *                            and what the lifecycle would make of it
 *
 * `config-draft-preview` also carries `lifecycle_effect`: for each module the change reaches,
 * what ARC-120 is expected to do with it (stay live, hold new runs, pause).
 *
 * Publication and rollback write their own audit row inside the same transaction as the
 * version (0014 §9), so they are not logged again here. Draft writes and the import are
 * logged through the `ops` audit helper, with field names and never values.
 */

import { type Resolution } from '../_shared/config/compose.ts';
import {
  createDraft,
  discardDraft,
  importLegacyConfig,
  listHistory,
  previewDraft,
  publishDraft,
  readHistoricalVersion,
  resolveEffectiveConfig,
  rollbackConfig,
  updateDraft,
  validateDraft,
} from '../_shared/config/engine.ts';
import { type ChangeImpactReport } from '../_shared/config/impact.ts';
import {
  CONFIG_ERROR_STATUS,
  type ConfigActor,
  type ConfigDraftRow,
  type ConfigFailure,
  type ConfigScope,
  type ConfigVersionRow,
  moduleScope,
  TENANT_SCOPE,
} from '../_shared/config/model.ts';
import type { ConfigStore } from '../_shared/config/store.ts';
import { compareDocuments, lifecycleEffect, schemaProjection } from '../_shared/config/settings.ts';
import { schemaForScope } from '../_shared/config/engine.ts';
import { latestSelectableModuleVersion, MODULES } from '../_shared/registry/modules.ts';

export const CONFIG_ACTIONS = [
  'config-get',
  'config-history',
  'config-version',
  'config-resolve',
  'config-draft-create',
  'config-draft-get',
  'config-draft-update',
  'config-draft-validate',
  'config-draft-preview',
  'config-draft-discard',
  'config-publish',
  'config-rollback',
  'config-import-legacy',
  'config-scope',
  'config-compare',
  'config-rollback-preview',
];

/* the lifecycle rows of a tenant, when the store has them (the ops function's always does). */
async function lifecycleStates(store: ConfigStore, tenantId: string): Promise<{ moduleKey: string; state: string }[]> {
  const lister = (store as unknown as { listLifecycles?: (t: string) => Promise<{ moduleKey: string; state: string }[]> }).listLifecycles;
  if (typeof lister !== 'function') return [];
  return (await lister.call(store, tenantId)).map((l) => ({ moduleKey: l.moduleKey, state: l.state }));
}

export interface ConfigActionContext {
  store: ConfigStore;
  body: Record<string, unknown>;
  /** from the verified JWT. null only if the caller somehow has no user. */
  actorId: string | null;
  audit(verb: string, targetType: string | null, targetId: string | null, metadata?: Record<string, unknown>): Promise<boolean>;
  /**
   * tick an onboarding step (0010's `module_onboarding`). optional: the ops function passes it,
   * and a publish from the settings page then ticks "business rules" exactly as the Lead
   * Recovery panel's save always has.
   */
  markStep?(tenantId: string, moduleKey: string, stepKey: string): Promise<void>;
}

/* the modules that onboard on "business rules" — the ones whose activation lists it. */
const BUSINESS_RULES_MODULES = MODULES
  .filter((m) => latestSelectableModuleVersion(m.key)?.safety.activationTestKeys.includes('business_rules'))
  .map((m) => m.key);

/**
 * after a publish or a restore: for each module the scope feeds that onboards on business
 * rules, tick the step if its effective configuration now resolves valid. a resolution that
 * fails ticks nothing — the step means "saved and valid".
 */
async function tickBusinessRules(context: ConfigActionContext, tenantId: string, scope: ConfigScope): Promise<string[]> {
  if (!context.markStep) return [];
  const modules = scope.kind === 'module' ? [scope.moduleKey] : BUSINESS_RULES_MODULES;
  const ticked: string[] = [];
  for (const moduleKey of modules.filter((m) => BUSINESS_RULES_MODULES.includes(m))) {
    const resolved = await resolveEffectiveConfig(context.store, tenantId, moduleKey);
    if (!resolved.ok) continue;
    await context.markStep(tenantId, moduleKey, 'business_rules');
    ticked.push(moduleKey);
  }
  return ticked;
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

const ok = (body: Record<string, unknown>): ActionResponse => ({ body: { ok: true, ...body }, status: 200 });

export function failed(result: ConfigFailure): ActionResponse {
  return {
    status: CONFIG_ERROR_STATUS[result.code] ?? 400,
    body: {
      error: result.message,
      code: result.code,
      ...(result.fieldErrors ? { field_errors: result.fieldErrors } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    },
  };
}

const bad = (message: string, code: ConfigFailure['code'] = 'validation_failed'): ActionResponse =>
  failed({ ok: false, code, message });

/* ── wire shapes: snake_case, as every ops response is ── */

export function versionOut(v: ConfigVersionRow, options: { includeConfig?: boolean } = {}) {
  return {
    id: v.id,
    scope: v.scope,
    module_key: v.moduleKey,
    version: v.version,
    schema_key: v.schemaKey,
    schema_version: v.schemaVersion,
    config_hash: v.configHash,
    parent_version_id: v.parentVersionId,
    rollback_of_version_id: v.rollbackOfVersionId,
    source: v.source,
    published_from_draft_id: v.publishedFromDraftId,
    provenance: v.provenance,
    change_impact: v.changeImpact,
    created_by: v.createdBy,
    published_by: v.publishedBy,
    published_at: v.publishedAt,
    note: v.note,
    ...(options.includeConfig ? { config: v.config } : {}),
  };
}

export function draftOut(d: ConfigDraftRow) {
  return {
    id: d.id,
    scope: d.scope,
    module_key: d.moduleKey,
    schema_key: d.schemaKey,
    schema_version: d.schemaVersion,
    base_version_id: d.baseVersionId,
    base_version: d.baseVersion,
    config: d.config,
    revision: d.revision,
    status: d.status,
    published_version_id: d.publishedVersionId,
    origin: d.origin,
    created_by: d.createdBy,
    updated_by: d.updatedBy,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    closed_at: d.closedAt,
  };
}

export function resolutionOut(r: Resolution) {
  return {
    tenant_id: r.tenantId,
    module_key: r.moduleKey,
    tenant_version: { id: r.tenantVersion.id, version: r.tenantVersion.version, schema: `${r.tenantVersion.schemaKey}@${r.tenantVersion.schemaVersion}` },
    module_version: { id: r.moduleVersion.id, version: r.moduleVersion.version, schema: `${r.moduleVersion.schemaKey}@${r.moduleVersion.schemaVersion}` },
    config: r.config,
    config_hash: r.configHash,
    warnings: r.warnings,
  };
}

function impactOut(i: ChangeImpactReport) {
  return {
    schema: `${i.schemaKey}@${i.schemaVersion}`,
    changed_fields: i.changedFields,
    changes: i.changes.map((c) => ({
      path: c.path,
      field: c.field,
      known: c.known,
      redacted: c.redacted,
      ...(c.redacted ? {} : { before: c.before ?? null, after: c.after ?? null }),
      requires_retest: c.requiresRetest,
      requires_shadow: c.requiresShadow,
      requires_reactivation: c.requiresReactivation,
    })),
    requires_retest: i.aggregate.requiresRetest,
    requires_shadow: i.aggregate.requiresShadow,
    requires_reactivation: i.aggregate.requiresReactivation,
    unknown_fields: i.aggregate.unknownFields,
    editable: i.editable,
    affected_modules: i.affectedModules,
  };
}

/* ── request parsing ── */

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const integer = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function scopeFrom(body: Record<string, unknown>): ConfigScope | ActionResponse {
  const scope = text(body.scope);
  if (scope === 'tenant') return TENANT_SCOPE;
  if (scope === 'module') {
    const moduleKey = text(body.module_key);
    if (!moduleKey) return bad('module_key is required for scope "module"');
    return moduleScope(moduleKey);
  }
  return bad('scope must be "tenant" or "module"');
}

const isResponse = (v: unknown): v is ActionResponse =>
  typeof v === 'object' && v !== null && 'status' in v && 'body' in v;

export async function handleConfigAction(action: string, context: ConfigActionContext): Promise<ActionResponse> {
  const { store, body } = context;
  if (!context.actorId) return failed({ ok: false, code: 'unauthorized', message: 'not signed in' });
  const actor: ConfigActor = { kind: 'operator', userId: context.actorId };

  if (action === 'config-import-legacy') {
    const tenantId = text(body.tenant_id) || null;
    const result = await importLegacyConfig(store, { tenantId, actor });
    if (!result.ok) return failed(result);
    const counts: Record<string, number> = {};
    for (const r of result.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const logged = await context.audit('config.legacy_imported', tenantId ? 'tenant' : null, tenantId, { counts });
    return ok({
      results: result.results.map((r) => ({
        tenant_id: r.tenantId,
        status: r.status,
        message: r.message,
        versions: r.versions ?? null,
        field_errors: r.fieldErrors ?? [],
      })),
      counts,
      logged,
    });
  }

  const tenantId = text(body.tenant_id);
  if (!tenantId) return bad('tenant_id is required');

  if (action === 'config-resolve') {
    const moduleKey = text(body.module_key);
    if (!moduleKey) return bad('module_key is required');
    const resolution = await resolveEffectiveConfig(store, tenantId, moduleKey);
    if (!resolution.ok) return failed(resolution);
    return ok({ resolution: resolutionOut(resolution) });
  }

  if (action === 'config-get') {
    const moduleKey = text(body.module_key) || null;
    const [tenantHead, tenantDraft, moduleHeads] = await Promise.all([
      store.getConfigHead(tenantId, TENANT_SCOPE),
      store.getOpenDraft(tenantId, TENANT_SCOPE),
      store.listModuleConfigHeads(tenantId),
    ]);
    const modules = await Promise.all(moduleHeads.map(async (head) => ({
      module_key: head.moduleKey,
      current: versionOut(head, { includeConfig: true }),
      open_draft: await store.getOpenDraft(tenantId, moduleScope(head.moduleKey!)).then((d) => (d ? draftOut(d) : null)),
    })));
    let resolution: Record<string, unknown> | null = null;
    if (moduleKey) {
      const resolved = await resolveEffectiveConfig(store, tenantId, moduleKey);
      resolution = resolved.ok
        ? { ok: true, ...resolutionOut(resolved) }
        : { ok: false, code: resolved.code, error: resolved.message, field_errors: resolved.fieldErrors ?? [] };
    }
    return ok({
      tenant: {
        current: tenantHead ? versionOut(tenantHead, { includeConfig: true }) : null,
        open_draft: tenantDraft ? draftOut(tenantDraft) : null,
      },
      modules,
      resolution,
    });
  }

  const scope = scopeFrom(body);
  if (isResponse(scope)) return scope;

  switch (action) {
    case 'config-history': {
      const limit = integer(body.limit) ?? 50;
      const versions = await listHistory(store, tenantId, scope, limit);
      return ok({ versions: versions.map((v) => versionOut(v)) });
    }

    case 'config-version': {
      const versionId = text(body.version_id);
      if (!versionId) return bad('version_id is required');
      const result = await readHistoricalVersion(store, tenantId, scope, versionId);
      if (!result.ok) return failed(result);
      return ok({ version: versionOut(result.version, { includeConfig: true }) });
    }

    case 'config-draft-get': {
      const draft = await store.getOpenDraft(tenantId, scope);
      return ok({ draft: draft ? draftOut(draft) : null });
    }

    case 'config-draft-create': {
      const result = await createDraft(store, { tenantId, scope, actor });
      if (!result.ok) return failed(result);
      const logged = await context.audit('config.draft_created', 'tenant', tenantId, {
        scope: scope.kind,
        module_key: scope.kind === 'module' ? scope.moduleKey : null,
        draft_id: result.draft.id,
        base_version: result.draft.baseVersion,
      });
      return ok({ draft: draftOut(result.draft), logged });
    }

    case 'config-draft-update': {
      const draftId = text(body.draft_id);
      if (!draftId) return bad('draft_id is required');
      const expectedRevision = integer(body.expected_revision);
      if (expectedRevision === null) {
        return failed({ ok: false, code: 'draft_conflict', message: 'expected_revision is required — a write without it would overwrite whatever is there' });
      }
      const patch = body.patch;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return bad('patch must be an object of field → value');
      const result = await updateDraft(store, {
        tenantId, scope, draftId, expectedRevision, patch: patch as Record<string, unknown>, actor,
      });
      if (!result.ok) return failed(result);
      const logged = await context.audit('config.draft_updated', 'tenant', tenantId, {
        scope: scope.kind,
        module_key: scope.kind === 'module' ? scope.moduleKey : null,
        draft_id: draftId,
        revision: result.draft.revision,
        fields: Object.keys(patch as Record<string, unknown>),
      });
      return ok({ draft: draftOut(result.draft), warnings: result.warnings, logged });
    }

    case 'config-draft-validate': {
      const draftId = text(body.draft_id);
      if (!draftId) return bad('draft_id is required');
      const result = await validateDraft(store, { tenantId, scope, draftId });
      if (!result.ok) return failed(result);
      return ok({
        valid: result.check.valid,
        error: result.check.message,
        field_errors: result.check.fieldErrors,
        warnings: result.check.warnings,
        revision: result.draft.revision,
      });
    }

    case 'config-draft-preview': {
      const draftId = text(body.draft_id);
      if (!draftId) return bad('draft_id is required');
      const result = await previewDraft(store, { tenantId, scope, draftId, actor });
      if (!result.ok) return failed(result);
      return ok({
        valid: result.check.valid,
        error: result.check.message,
        field_errors: result.check.fieldErrors,
        warnings: result.check.warnings,
        revision: result.draft.revision,
        base_version: result.draft.baseVersion,
        base_is_current: result.baseIsCurrent,
        denied_fields: result.deniedFields,
        impact: impactOut(result.impact),
        lifecycle_effect: lifecycleEffect(result.impact, scope, await lifecycleStates(store, tenantId)),
      });
    }

    case 'config-scope': {
      const schema = schemaForScope(scope);
      if (!schema.ok) return failed(schema);
      const [current, draft, lifecycles] = await Promise.all([
        store.getConfigHead(tenantId, scope),
        store.getOpenDraft(tenantId, scope),
        lifecycleStates(store, tenantId),
      ]);
      return ok({
        schema: schemaProjection(schema.schema, actor),
        current: current ? versionOut(current, { includeConfig: true }) : null,
        open_draft: draft ? draftOut(draft) : null,
        lifecycles: lifecycles.map((l) => ({ module_key: l.moduleKey, state: l.state })),
      });
    }

    case 'config-compare': {
      const schema = schemaForScope(scope);
      if (!schema.ok) return failed(schema);
      const fromId = text(body.from_version_id);
      const toId = text(body.to_version_id);
      if (!fromId || !toId) return bad('from_version_id and to_version_id are required');
      const [from, to] = await Promise.all([
        readHistoricalVersion(store, tenantId, scope, fromId),
        readHistoricalVersion(store, tenantId, scope, toId),
      ]);
      if (!from.ok) return failed(from);
      if (!to.ok) return failed(to);
      return ok({
        from: versionOut(from.version),
        to: versionOut(to.version),
        impact: impactOut(compareDocuments(schema.schema, from.version.config, to.version.config)),
      });
    }

    case 'config-rollback-preview': {
      const schema = schemaForScope(scope);
      if (!schema.ok) return failed(schema);
      const versionId = text(body.version_id);
      if (!versionId) return bad('version_id is required');
      const [target, current] = await Promise.all([
        readHistoricalVersion(store, tenantId, scope, versionId),
        store.getConfigHead(tenantId, scope),
      ]);
      if (!target.ok) return failed(target);
      if (!current) return bad('this scope has no published version to restore over', 'version_not_found');
      const impact = compareDocuments(schema.schema, current.config, target.version.config);
      return ok({
        current: versionOut(current),
        target: versionOut(target.version),
        impact: impactOut(impact),
        lifecycle_effect: lifecycleEffect(impact, scope, await lifecycleStates(store, tenantId)),
      });
    }

    case 'config-draft-discard': {
      const draftId = text(body.draft_id);
      if (!draftId) return bad('draft_id is required');
      const expectedRevision = integer(body.expected_revision);
      if (expectedRevision === null) return failed({ ok: false, code: 'draft_conflict', message: 'expected_revision is required' });
      const result = await discardDraft(store, { tenantId, scope, draftId, expectedRevision, actor });
      if (!result.ok) return failed(result);
      const logged = await context.audit('config.draft_discarded', 'tenant', tenantId, {
        scope: scope.kind,
        module_key: scope.kind === 'module' ? scope.moduleKey : null,
        draft_id: draftId,
      });
      return ok({ draft: draftOut(result.draft), logged });
    }

    case 'config-publish': {
      const draftId = text(body.draft_id);
      if (!draftId) return bad('draft_id is required');
      const expectedRevision = integer(body.expected_revision);
      const expectedVersion = integer(body.expected_version);
      if (expectedRevision === null || expectedVersion === null) {
        return failed({ ok: false, code: 'publication_conflict', message: 'expected_revision and expected_version are both required' });
      }
      const result = await publishDraft(store, {
        tenantId, scope, draftId, expectedRevision, expectedVersion, actor,
        note: typeof body.note === 'string' ? body.note : null,
      });
      if (!result.ok) return failed(result);
      return ok({
        version_id: result.version.id,
        version: result.version.version,
        schema_key: result.version.schemaKey,
        schema_version: result.version.schemaVersion,
        impact: impactOut(result.impact),
        warnings: result.warnings,
        onboarding_ticked: await tickBusinessRules(context, tenantId, scope),
        /* written by publish_config_draft in the same transaction as the version. */
        logged: true,
      });
    }

    case 'config-rollback': {
      const versionId = text(body.version_id);
      if (!versionId) return bad('version_id is required');
      const expectedVersion = integer(body.expected_version);
      if (expectedVersion === null) return failed({ ok: false, code: 'publication_conflict', message: 'expected_version is required' });
      const result = await rollbackConfig(store, {
        tenantId, scope, versionId, expectedVersion, actor,
        note: typeof body.note === 'string' ? body.note : null,
      });
      if (!result.ok) return failed(result);
      return ok({
        version_id: result.version.id,
        version: result.version.version,
        rollback_of_version_id: result.version.rollbackOfVersionId,
        schema_key: result.version.schemaKey,
        schema_version: result.version.schemaVersion,
        impact: impactOut(result.impact),
        onboarding_ticked: await tickBusinessRules(context, tenantId, scope),
        logged: true,
      });
    }

    default:
      return bad(`"${action}" is not a configuration action`);
  }
}
