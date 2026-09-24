/**
 * ARC-110 — the configuration engine: drafts, publication, rollback, resolution.
 *
 * Every rule a caller could get wrong lives here rather than in the `ops` handler, so
 * the handler is a translation from HTTP to these calls and the test suite exercises
 * the rules directly. The order of checks in each operation is deliberate:
 *
 *   1. who is asking (an operator publishes; field permissions come from the registry)
 *   2. what they are writing to (the scope must have a registered schema)
 *   3. whether the content is acceptable (the registered validator, composed across
 *      scopes, because a module document is only meaningful with its tenant's)
 *   4. whether anything moved underneath them (the draft revision and the expected
 *      version — checked here for a clear answer, and again inside the one database
 *      call that writes, because only the second check is race-free)
 *
 * The engine never activates, pauses or retests anything. It reports the registry's
 * change impact, and after each publication hands the change to ARC-120's lifecycle
 * (`lifecycle/impact.ts`), which decides what it means for a live module. Publication and
 * activation stay separate decisions: nothing here ever switches a module on.
 */

import { canonicalJson, configHash } from '../canonical-json.ts';
import { resolveModuleRuntime } from '../registry/index.ts';
import {
  editableFields,
  ownFields,
  tenantOwnedFields,
  tenantSettingsSchema,
  type ConfigSchema,
} from '../registry/schemas.ts';
import {
  composeDocuments,
  composeEffective,
  type Resolution,
  splitEffective,
  toFieldErrors,
} from './compose.ts';
import { analyseChange, auditSafeImpact, changedTopLevelFields, type ChangeImpactReport } from './impact.ts';
import { type ConfigChangeOutcome, hasLifecycle, reconcileAfterPublication } from '../lifecycle/impact.ts';
import {
  type ConfigActor,
  type ConfigDraftRow,
  type ConfigFailure,
  type ConfigScope,
  ConfigStoreError,
  type ConfigVersionRow,
  describeScope,
  failure,
  type FieldError,
  moduleScope,
  TENANT_SCOPE,
} from './model.ts';
import type { ConfigStore } from './store.ts';

type Ok<T> = { ok: true } & T;

/* ── scope and schema ───────────────────────────────────── */

/** The registered schema a scope's documents are written in, or why there is none. */
export function schemaForScope(scope: ConfigScope): { ok: true; schema: ConfigSchema } | ConfigFailure {
  if (scope.kind === 'tenant') return { ok: true, schema: tenantSettingsSchema() };
  const runtime = resolveModuleRuntime(scope.moduleKey);
  if (!runtime) {
    return failure('module_not_found', `${scope.moduleKey} is not a module with a registered configuration schema`);
  }
  return { ok: true, schema: runtime.schema };
}

/** Fields a document of this scope stores — never the ones it takes from the tenant. */
function storedFieldKeys(schema: ConfigSchema): string[] {
  return ownFields(schema.key).map((f) => f.key);
}

/**
 * The fields an actor may write in this scope: the registry's `editableFields()` for
 * their audience, less anything the scope does not store. Protected fields are already
 * excluded by the registry.
 */
export function writableFields(schema: ConfigSchema, actor: ConfigActor): string[] {
  const stored = storedFieldKeys(schema);
  return editableFields(schema.key, actor.kind === 'operator' ? 'operator' : 'client')
    .map((f) => f.key)
    .filter((k) => stored.includes(k));
}

function actorTenantMismatch(actor: ConfigActor, tenantId: string): ConfigFailure | null {
  if (actor.kind === 'client' && actor.tenantId !== tenantId) {
    return failure('tenant_mismatch', 'a client may only address its own tenant');
  }
  return null;
}

function fromStoreError(error: unknown): ConfigFailure {
  if (error instanceof ConfigStoreError) return failure(error.code, error.message);
  throw error;
}

/* ── validation, composed across scopes ─────────────────── */

export interface ValidatedDocument {
  /** the normalised document this scope would store. */
  document: Record<string, unknown>;
  warnings: string[];
}

/**
 * Validate a document for a scope against the registered schema.
 *
 * A module document is validated *composed with the tenant's current settings*,
 * because that composition is what the engine will run; validating the module half
 * alone would accept a document the resolver then refuses. A tenant document is
 * validated on its own and then composed with every module's current version, so a
 * tenant change can never leave a module unresolvable.
 */
export async function validateScopeDocument(
  store: ConfigStore,
  tenantId: string,
  scope: ConfigScope,
  doc: unknown,
  options: { tenantDocument?: Record<string, unknown> } = {},
): Promise<Ok<ValidatedDocument> | ConfigFailure> {
  const resolved = schemaForScope(scope);
  if (!resolved.ok) return resolved;
  const { schema } = resolved;

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return failure('validation_failed', 'a configuration document must be a JSON object', {
      fieldErrors: [{ path: '', message: 'a configuration document must be a JSON object' }],
    });
  }
  const document = doc as Record<string, unknown>;

  if (scope.kind === 'tenant') {
    const result = schema.validate(document);
    if (!result.ok) {
      return failure('validation_failed', 'the tenant settings are not valid', {
        fieldErrors: toFieldErrors(result.errors, schema.fields.map((f) => f.key)),
      });
    }
    const normalised = result.config as Record<string, unknown>;
    for (const head of await store.listModuleConfigHeads(tenantId)) {
      const runtime = resolveModuleRuntime(head.moduleKey!);
      if (!runtime) continue;
      const composed = composeDocuments(runtime.schema, normalised, head.config);
      if (!composed.ok) return composed;
      const check = runtime.schema.validate(composed.merged);
      if (!check.ok) {
        return failure(
          'validation_failed',
          `these tenant settings would make the published ${head.moduleKey} configuration invalid`,
          {
            fieldErrors: toFieldErrors(check.errors, runtime.schema.fields.map((f) => f.key)),
            detail: { module_key: head.moduleKey, module_version: head.version },
          },
        );
      }
    }
    return { ok: true, document: normalised, warnings: result.warnings };
  }

  /* module scope. a key the tenant owns is refused by name, before the validator —
     which would otherwise accept it as the effective value and hide the clash. */
  const tenantKeys = tenantOwnedFields(schema.key);
  const misplaced = Object.keys(document).filter((k) => tenantKeys.includes(k));
  if (misplaced.length > 0) {
    return failure('validation_failed', `${misplaced.join(', ')} ${misplaced.length === 1 ? 'is a' : 'are'} tenant-wide setting${misplaced.length === 1 ? '' : 's'}`, {
      fieldErrors: misplaced.map((path) => ({ path, message: `${path} is stored in the tenant settings, not the ${scope.moduleKey} configuration` })),
    });
  }

  let tenantDocument = options.tenantDocument;
  if (!tenantDocument) {
    const tenantHead = await store.getConfigHead(tenantId, TENANT_SCOPE);
    if (!tenantHead) {
      return failure(
        'missing_published_configuration',
        `publish this tenant's settings first — the ${scope.moduleKey} configuration takes its company name and timezone from them`,
      );
    }
    tenantDocument = tenantHead.config;
  }

  const composed = composeDocuments(schema, tenantDocument, document);
  if (!composed.ok) return composed;
  const result = schema.validate(composed.merged);
  if (!result.ok) {
    return failure('validation_failed', `the ${scope.moduleKey} configuration is not valid`, {
      fieldErrors: toFieldErrors(result.errors, schema.fields.map((f) => f.key)),
    });
  }
  const { module } = splitEffective(schema, result.config as Record<string, unknown>);
  return { ok: true, document: module, warnings: result.warnings };
}

function sameContent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function permissionFailure(fields: string[], actor: ConfigActor): ConfigFailure {
  return failure(
    'edit_permission_denied',
    `${actor.kind === 'operator' ? 'an operator' : 'a client'} may not change ${fields.join(', ')}`,
    { fieldErrors: fields.map((path) => ({ path, message: `${path} is not editable by ${actor.kind === 'operator' ? 'an operator' : 'a client'}` })) },
  );
}

/* ── reads ──────────────────────────────────────────────── */

export async function readCurrentConfig(store: ConfigStore, tenantId: string, scope: ConfigScope) {
  return await store.getConfigHead(tenantId, scope);
}

export async function listHistory(store: ConfigStore, tenantId: string, scope: ConfigScope, limit = 50) {
  return await store.listConfigVersions(tenantId, scope, Math.min(Math.max(limit, 1), 200));
}

export async function readHistoricalVersion(
  store: ConfigStore,
  tenantId: string,
  scope: ConfigScope,
  versionId: string,
): Promise<Ok<{ version: ConfigVersionRow }> | ConfigFailure> {
  const version = await store.getConfigVersion(tenantId, scope, versionId);
  /* the store is tenant-scoped, so another tenant's id reads exactly like a missing one
     — no existence oracle across tenants. */
  if (!version) return failure('version_not_found', `no such ${describeScope(scope)} version for this tenant`);
  return { ok: true, version };
}

/* ── drafts ─────────────────────────────────────────────── */

export async function createDraft(
  store: ConfigStore,
  args: { tenantId: string; scope: ConfigScope; actor: ConfigActor },
): Promise<Ok<{ draft: ConfigDraftRow }> | ConfigFailure> {
  const mismatch = actorTenantMismatch(args.actor, args.tenantId);
  if (mismatch) return mismatch;
  const resolved = schemaForScope(args.scope);
  if (!resolved.ok) return resolved;
  const { schema } = resolved;

  /* a draft is a place to write. an actor who may write nothing in this scope has no
     use for one — that is every client today (clientEditable is false everywhere). */
  if (writableFields(schema, args.actor).length === 0) {
    return failure('edit_permission_denied', `${args.actor.kind === 'operator' ? 'an operator' : 'a client'} may not edit any ${describeScope(args.scope)} field`);
  }

  const head = await store.getConfigHead(args.tenantId, args.scope);
  const stored = storedFieldKeys(schema);
  const start = head
    ? head.config
    : Object.fromEntries(Object.entries(schema.defaults()).filter(([k]) => stored.includes(k)));

  try {
    const draft = await store.insertDraft({
      tenantId: args.tenantId,
      scope: args.scope,
      schemaKey: schema.key,
      schemaVersion: schema.version,
      baseVersionId: head?.id ?? null,
      baseVersion: head?.version ?? 0,
      config: start,
      actorId: args.actor.userId,
    });
    return { ok: true, draft };
  } catch (error) {
    const refused = fromStoreError(error);
    if (refused.code === 'draft_exists') {
      const open = await store.getOpenDraft(args.tenantId, args.scope);
      return failure('draft_exists', `${describeScope(args.scope)} already has an open draft — edit it, publish it or discard it`, {
        detail: open ? { draft_id: open.id, revision: open.revision, base_version: open.baseVersion } : {},
      });
    }
    return refused;
  }
}

async function openDraftFor(
  store: ConfigStore,
  tenantId: string,
  scope: ConfigScope,
  draftId: string,
): Promise<Ok<{ draft: ConfigDraftRow }> | ConfigFailure> {
  const draft = await store.getDraft(tenantId, scope, draftId);
  if (!draft) return failure('draft_not_found', `no such ${describeScope(scope)} draft for this tenant`);
  if (draft.status !== 'open') return failure('draft_closed', `this draft is ${draft.status}`);
  return { ok: true, draft };
}

/**
 * Change some fields of an open draft.
 *
 * `patch` replaces whole top-level fields — the unit the registry's permissions are
 * written in. A nested edit is a new value for its top-level field. Checked in the
 * order unknown field → permission → validity → concurrency, so a client probing a
 * field it may not touch learns it may not touch it, not whether the value was good.
 */
export async function updateDraft(
  store: ConfigStore,
  args: {
    tenantId: string;
    scope: ConfigScope;
    draftId: string;
    expectedRevision: number;
    patch: Record<string, unknown>;
    actor: ConfigActor;
  },
): Promise<Ok<{ draft: ConfigDraftRow; warnings: string[] }> | ConfigFailure> {
  const mismatch = actorTenantMismatch(args.actor, args.tenantId);
  if (mismatch) return mismatch;
  const resolved = schemaForScope(args.scope);
  if (!resolved.ok) return resolved;
  const { schema } = resolved;

  if (typeof args.patch !== 'object' || args.patch === null || Array.isArray(args.patch) || Object.keys(args.patch).length === 0) {
    return failure('validation_failed', 'patch must be an object naming at least one field');
  }
  if (!Number.isInteger(args.expectedRevision)) {
    return failure('draft_conflict', 'expected_revision is required — a write without it would overwrite whatever is there');
  }

  const stored = storedFieldKeys(schema);
  const tenantKeys = scopeTenantKeys(schema, args.scope);
  const keys = Object.keys(args.patch);
  const unknown = keys.filter((k) => !stored.includes(k) && !tenantKeys.includes(k));
  const misplaced = keys.filter((k) => tenantKeys.includes(k));
  if (unknown.length > 0 || misplaced.length > 0) {
    const fieldErrors: FieldError[] = [
      ...unknown.map((path) => ({ path, message: `${path} is not a setting ${describeScope(args.scope)} has` })),
      ...misplaced.map((path) => ({ path, message: `${path} is stored in the tenant settings` })),
    ];
    return failure('validation_failed', fieldErrors.map((e) => e.message).join('; '), { fieldErrors });
  }

  const writable = writableFields(schema, args.actor);
  const denied = keys.filter((k) => !writable.includes(k));
  if (denied.length > 0) return permissionFailure(denied, args.actor);

  const current = await openDraftFor(store, args.tenantId, args.scope, args.draftId);
  if (!current.ok) return current;
  if (current.draft.revision !== args.expectedRevision) {
    return failure('draft_conflict', `the draft is at revision ${current.draft.revision}, not ${args.expectedRevision} — reload it before writing`, {
      detail: { revision: current.draft.revision },
    });
  }

  const candidate = { ...current.draft.config, ...args.patch };
  const validated = await validateScopeDocument(store, args.tenantId, args.scope, candidate);
  if (!validated.ok) return validated;

  const updated = await store.updateDraftContent({
    tenantId: args.tenantId,
    scope: args.scope,
    draftId: args.draftId,
    expectedRevision: args.expectedRevision,
    config: validated.document,
    actorId: args.actor.userId,
  });
  if (!updated) {
    const now = await store.getDraft(args.tenantId, args.scope, args.draftId);
    return failure('draft_conflict', 'the draft changed while this edit was being checked — reload it before writing', {
      detail: { revision: now?.revision ?? null, status: now?.status ?? null },
    });
  }
  return { ok: true, draft: updated, warnings: validated.warnings };
}

/** A tenant scope stores its own fields; a module scope must refuse the tenant's by name. */
function scopeTenantKeys(schema: ConfigSchema, scope: ConfigScope): string[] {
  return scope.kind === 'module' ? tenantOwnedFields(schema.key) : [];
}

export interface DraftCheck {
  valid: boolean;
  fieldErrors: FieldError[];
  warnings: string[];
  message: string | null;
  /** the normalised document, when valid. */
  document: Record<string, unknown> | null;
}

export async function validateDraft(
  store: ConfigStore,
  args: { tenantId: string; scope: ConfigScope; draftId: string },
): Promise<Ok<{ draft: ConfigDraftRow; check: DraftCheck }> | ConfigFailure> {
  const draft = await store.getDraft(args.tenantId, args.scope, args.draftId);
  if (!draft) return failure('draft_not_found', `no such ${describeScope(args.scope)} draft for this tenant`);
  const validated = await validateScopeDocument(store, args.tenantId, args.scope, draft.config);
  const check: DraftCheck = validated.ok
    ? { valid: true, fieldErrors: [], warnings: validated.warnings, message: null, document: validated.document }
    : { valid: false, fieldErrors: validated.fieldErrors ?? [], warnings: [], message: validated.message, document: null };
  return { ok: true, draft, check };
}

/** What publishing this draft would change, and what the registry says that costs. */
export async function previewDraft(
  store: ConfigStore,
  args: { tenantId: string; scope: ConfigScope; draftId: string; actor: ConfigActor },
): Promise<Ok<{ draft: ConfigDraftRow; check: DraftCheck; impact: ChangeImpactReport; deniedFields: string[]; baseIsCurrent: boolean }> | ConfigFailure> {
  const resolved = schemaForScope(args.scope);
  if (!resolved.ok) return resolved;
  const validated = await validateDraft(store, args);
  if (!validated.ok) return validated;
  const head = await store.getConfigHead(args.tenantId, args.scope);
  const proposed = validated.check.document ?? validated.draft.config;
  const impact = analyseChange(resolved.schema, head?.config ?? {}, proposed);
  const writable = writableFields(resolved.schema, args.actor);
  return {
    ok: true,
    draft: validated.draft,
    check: validated.check,
    impact,
    deniedFields: impact.changedFields.filter((f) => !writable.includes(f)),
    baseIsCurrent: validated.draft.baseVersion === (head?.version ?? 0),
  };
}

export async function discardDraft(
  store: ConfigStore,
  args: { tenantId: string; scope: ConfigScope; draftId: string; expectedRevision: number; actor: ConfigActor },
): Promise<Ok<{ draft: ConfigDraftRow }> | ConfigFailure> {
  const mismatch = actorTenantMismatch(args.actor, args.tenantId);
  if (mismatch) return mismatch;
  const current = await openDraftFor(store, args.tenantId, args.scope, args.draftId);
  if (!current.ok) return current;
  const closed = await store.closeDraft({
    tenantId: args.tenantId,
    scope: args.scope,
    draftId: args.draftId,
    expectedRevision: args.expectedRevision,
    status: 'discarded',
    actorId: args.actor.userId,
  });
  if (!closed) {
    return failure('draft_conflict', `the draft is at revision ${current.draft.revision}, not ${args.expectedRevision}`, {
      detail: { revision: current.draft.revision },
    });
  }
  return { ok: true, draft: closed };
}

/* ── publication ────────────────────────────────────────── */

export interface PublishOutcome {
  version: ConfigVersionRow;
  impact: ChangeImpactReport;
  warnings: string[];
  /** what the lifecycle made of this change, per selected module (ARC-120). */
  lifecycle: ConfigChangeOutcome[];
}

/**
 * Hand a publication to the lifecycle. The version already stands; if evaluating it fails,
 * the module's authorised versions are no longer the head, so no new live run can start
 * until a later reconciliation succeeds — failure here fails closed, never open.
 */
async function applyToLifecycle(store: ConfigStore, tenantId: string, scope: ConfigScope): Promise<ConfigChangeOutcome[]> {
  if (!hasLifecycle(store)) return [];
  const moduleKey = scope.kind === 'module' ? scope.moduleKey : null;
  try {
    return await reconcileAfterPublication(store, { tenantId, moduleKey });
  } catch (error) {
    return [{
      moduleKey: moduleKey ?? '*',
      applied: false,
      transition: null,
      classifications: [],
      consequence: null,
      state: null,
      pending: [],
      note: `not evaluated (${(error as Error)?.message ?? 'unknown error'}) — new live runs are held until it is`,
    }];
  }
}

/**
 * Publish an open draft as the next version of its scope.
 *
 * Operator only. The draft is re-validated in full — against today's schema and,
 * for a module, today's tenant settings — its changes are re-checked against the
 * publisher's permissions, and the registry's change impact is computed against the
 * version it replaces. A draft carried over from the legacy table and not yet in
 * normalised form is normalised as one recorded draft revision first, so what is
 * published is always byte-for-byte what the draft holds.
 */
export async function publishDraft(
  store: ConfigStore,
  args: {
    tenantId: string;
    scope: ConfigScope;
    draftId: string;
    expectedRevision: number;
    expectedVersion: number;
    actor: ConfigActor;
    note?: string | null;
  },
): Promise<Ok<PublishOutcome> | ConfigFailure> {
  if (args.actor.kind !== 'operator') return failure('forbidden', 'publishing configuration is an operator action');
  const resolved = schemaForScope(args.scope);
  if (!resolved.ok) return resolved;
  const { schema } = resolved;
  if (!Number.isInteger(args.expectedRevision) || !Number.isInteger(args.expectedVersion)) {
    return failure('publication_conflict', 'expected_revision and expected_version are both required');
  }

  const current = await openDraftFor(store, args.tenantId, args.scope, args.draftId);
  if (!current.ok) return current;
  let draft = current.draft;
  if (draft.revision !== args.expectedRevision) {
    return failure('draft_conflict', `the draft is at revision ${draft.revision}, not ${args.expectedRevision}`, {
      detail: { revision: draft.revision },
    });
  }

  const head = await store.getConfigHead(args.tenantId, args.scope);
  const headVersion = head?.version ?? 0;
  if (headVersion !== args.expectedVersion) {
    return failure('publication_conflict', `the current version is ${headVersion}, not ${args.expectedVersion} — somebody published since this was read`, {
      detail: { current_version: headVersion },
    });
  }
  if (draft.baseVersion !== headVersion) {
    return failure('stale_draft', `this draft was written against version ${draft.baseVersion}; version ${headVersion} has been published since. Start a new draft from it.`, {
      detail: { base_version: draft.baseVersion, current_version: headVersion },
    });
  }

  const validated = await validateScopeDocument(store, args.tenantId, args.scope, draft.config);
  if (!validated.ok) return validated;

  const denied = changedTopLevelFields(head?.config ?? {}, validated.document).filter(
    (f) => !writableFields(schema, args.actor).includes(f),
  );
  if (denied.length > 0) return permissionFailure(denied, args.actor);

  if (!sameContent(validated.document, draft.config)) {
    const normalised = await store.updateDraftContent({
      tenantId: args.tenantId,
      scope: args.scope,
      draftId: draft.id,
      expectedRevision: draft.revision,
      config: validated.document,
      actorId: args.actor.userId,
    });
    if (!normalised) return failure('draft_conflict', 'the draft changed while it was being published — reload it');
    draft = normalised;
  }

  const impact = analyseChange(schema, head?.config ?? {}, validated.document);
  try {
    const version = await store.publishConfigDraft({
      tenantId: args.tenantId,
      scope: args.scope,
      draftId: draft.id,
      expectedDraftRevision: draft.revision,
      expectedHeadVersion: headVersion,
      configHash: await configHash(validated.document),
      changeImpact: auditSafeImpact(impact),
      actorId: args.actor.userId,
      note: typeof args.note === 'string' ? args.note.slice(0, 300) : null,
    });
    const lifecycle = await applyToLifecycle(store, args.tenantId, args.scope);
    return { ok: true, version, impact, warnings: validated.warnings, lifecycle };
  } catch (error) {
    return fromStoreError(error);
  }
}

/**
 * Roll back by publishing an older version's content as the next version.
 *
 * Nothing historical is touched. The content must pass today's validation *unchanged*:
 * a version the current schema would normalise differently, or refuse, is not silently
 * rewritten into something nobody reviewed — it fails as `rollback_incompatible`, and
 * the way forward is a draft.
 */
export async function rollbackConfig(
  store: ConfigStore,
  args: {
    tenantId: string;
    scope: ConfigScope;
    versionId: string;
    expectedVersion: number;
    actor: ConfigActor;
    note?: string | null;
  },
): Promise<Ok<PublishOutcome> | ConfigFailure> {
  if (args.actor.kind !== 'operator') return failure('forbidden', 'rolling back configuration is an operator action');
  const resolved = schemaForScope(args.scope);
  if (!resolved.ok) return resolved;
  const { schema } = resolved;
  if (!Number.isInteger(args.expectedVersion)) return failure('publication_conflict', 'expected_version is required');

  const source = await store.getConfigVersion(args.tenantId, args.scope, args.versionId);
  if (!source) return failure('version_not_found', `no such ${describeScope(args.scope)} version for this tenant`);

  const head = await store.getConfigHead(args.tenantId, args.scope);
  const headVersion = head?.version ?? 0;
  if (headVersion !== args.expectedVersion) {
    return failure('publication_conflict', `the current version is ${headVersion}, not ${args.expectedVersion}`, {
      detail: { current_version: headVersion },
    });
  }
  if (head?.id === source.id) return failure('no_change', `version ${source.version} is already the current version`);

  if (source.schemaKey !== schema.key || source.schemaVersion !== schema.version) {
    return failure(
      'rollback_incompatible',
      `version ${source.version} was written in ${source.schemaKey}@${source.schemaVersion}; ${describeScope(args.scope)} is now ${schema.key}@${schema.version}`,
    );
  }
  const validated = await validateScopeDocument(store, args.tenantId, args.scope, source.config);
  if (!validated.ok) {
    return failure('rollback_incompatible', `version ${source.version} no longer passes today's rules: ${validated.message}`, {
      fieldErrors: validated.fieldErrors,
    });
  }
  if (!sameContent(validated.document, source.config)) {
    return failure(
      'rollback_incompatible',
      `version ${source.version} would be rewritten by today's rules before it could be republished — start a draft from it instead`,
    );
  }

  const denied = changedTopLevelFields(head?.config ?? {}, source.config).filter(
    (f) => !writableFields(schema, args.actor).includes(f),
  );
  if (denied.length > 0) return permissionFailure(denied, args.actor);

  const impact = analyseChange(schema, head?.config ?? {}, source.config);
  try {
    const version = await store.rollbackConfigVersion({
      tenantId: args.tenantId,
      scope: args.scope,
      sourceVersionId: source.id,
      expectedHeadVersion: headVersion,
      changeImpact: auditSafeImpact(impact),
      actorId: args.actor.userId,
      note: typeof args.note === 'string' ? args.note.slice(0, 300) : null,
    });
    const lifecycle = await applyToLifecycle(store, args.tenantId, args.scope);
    return { ok: true, version, impact, warnings: validated.warnings, lifecycle };
  } catch (error) {
    return fromStoreError(error);
  }
}

/* ── resolution ─────────────────────────────────────────── */

/**
 * The effective configuration a new run of `moduleKey` would start under.
 *
 * The single canonical resolver: every production consumer that needs "the tenant's
 * configuration" calls this, and it reads only published versions — never a draft,
 * never the frozen `module_configs.config`. No version, no configuration: there is no
 * default to fall back to, because a default is a plausible wrong answer.
 */
export async function resolveEffectiveConfig(
  store: ConfigStore,
  tenantId: string,
  moduleKey: string,
): Promise<Resolution | ConfigFailure> {
  if (!resolveModuleRuntime(moduleKey)) {
    return failure('module_not_found', `${moduleKey} is not a module with a registered configuration schema`);
  }
  const [tenantHead, moduleHead] = await Promise.all([
    store.getConfigHead(tenantId, TENANT_SCOPE),
    store.getConfigHead(tenantId, moduleScope(moduleKey)),
  ]);
  if (!tenantHead) return failure('missing_published_configuration', 'this tenant has no published tenant settings');
  if (!moduleHead) return failure('missing_published_configuration', `this tenant has no published ${moduleKey} configuration`);
  return await composeEffective(tenantId, moduleKey, tenantHead, moduleHead);
}

/** Resolve exactly the pair of versions named — the historical form of the resolver. */
export async function resolveVersions(
  store: ConfigStore,
  tenantId: string,
  moduleKey: string,
  tenantVersionId: string,
  moduleVersionId: string,
): Promise<Resolution | ConfigFailure> {
  const [tenantVersion, moduleVersion] = await Promise.all([
    store.getConfigVersion(tenantId, TENANT_SCOPE, tenantVersionId),
    store.getConfigVersion(tenantId, moduleScope(moduleKey), moduleVersionId),
  ]);
  if (!tenantVersion || !moduleVersion) return failure('version_not_found', 'one of those versions does not belong to this tenant and module');
  return await composeEffective(tenantId, moduleKey, tenantVersion, moduleVersion);
}

/* ── the console's "save configuration" button ──────────── */

/**
 * Publish a complete effective configuration in one call — what the existing Lead
 * Recovery panel sends.
 *
 * A compatibility path, and the only one: it writes through drafts and the same
 * publish function as everything else, so there is still exactly one way
 * configuration reaches the database. It exists because the panel edits the whole
 * effective document at once, and ARC-310's schema-driven settings UI will replace it
 * (and this function) with direct draft editing.
 *
 * `expected` carries the versions the operator's form was loaded from. Both are
 * checked before anything is written, so a stale form publishes nothing. Tenant
 * settings go first: the module document is validated against them.
 */
export async function publishEffectiveConfig(
  store: ConfigStore,
  args: {
    tenantId: string;
    moduleKey: string;
    config: unknown;
    expected: { tenant: number | null; module: number | null };
    actor: ConfigActor;
    note?: string | null;
  },
): Promise<Ok<{ published: PublishOutcome[]; tenantVersion: number; moduleVersion: number; warnings: string[] }> | ConfigFailure> {
  if (args.actor.kind !== 'operator') return failure('forbidden', 'publishing configuration is an operator action');
  const runtime = resolveModuleRuntime(args.moduleKey);
  if (!runtime) return failure('module_not_found', `${args.moduleKey} is not a module with a registered configuration schema`);

  const whole = runtime.schema.validate(args.config);
  if (!whole.ok) {
    return failure('validation_failed', 'the configuration is not valid', {
      fieldErrors: toFieldErrors(whole.errors, runtime.schema.fields.map((f) => f.key)),
    });
  }
  const { tenant, module } = splitEffective(runtime.schema, whole.config as Record<string, unknown>);

  const scopes: { scope: ConfigScope; document: Record<string, unknown>; expected: number | null }[] = [
    { scope: TENANT_SCOPE, document: tenant, expected: args.expected.tenant },
    { scope: moduleScope(args.moduleKey), document: module, expected: args.expected.module },
  ];

  const heads = await Promise.all(scopes.map((s) => store.getConfigHead(args.tenantId, s.scope)));
  for (const [i, s] of scopes.entries()) {
    const current = heads[i]?.version ?? 0;
    if (!Number.isInteger(s.expected) || s.expected !== current) {
      return failure(
        'publication_conflict',
        `${describeScope(s.scope)} is at version ${current}, and this form was loaded at ${s.expected ?? 'an unknown version'} — reload before saving`,
        { detail: { scope: s.scope.kind, current_version: current } },
      );
    }
  }

  const published: PublishOutcome[] = [];
  for (const [i, s] of scopes.entries()) {
    if (heads[i] && sameContent(heads[i]!.config, s.document)) continue;

    /* an open draft in this scope was written against the head this save is about to
       replace, so it would be stale the moment this publishes. it is closed as
       `superseded` — kept, with its content, not deleted. */
    const open = await store.getOpenDraft(args.tenantId, s.scope);
    if (open) {
      const closed = await store.closeDraft({
        tenantId: args.tenantId, scope: s.scope, draftId: open.id,
        expectedRevision: open.revision, status: 'superseded', actorId: args.actor.userId,
      });
      if (!closed) return failure('draft_conflict', `the open ${describeScope(s.scope)} draft changed while saving — reload`);
    }

    const created = await createDraft(store, { tenantId: args.tenantId, scope: s.scope, actor: args.actor });
    if (!created.ok) return created;
    const written = await store.updateDraftContent({
      tenantId: args.tenantId, scope: s.scope, draftId: created.draft.id,
      expectedRevision: created.draft.revision, config: s.document, actorId: args.actor.userId,
    });
    if (!written) return failure('draft_conflict', `the ${describeScope(s.scope)} draft changed while saving — reload`);

    const outcome = await publishDraft(store, {
      tenantId: args.tenantId,
      scope: s.scope,
      draftId: written.id,
      expectedRevision: written.revision,
      expectedVersion: heads[i]?.version ?? 0,
      actor: args.actor,
      note: args.note,
    });
    if (!outcome.ok) {
      return { ...outcome, detail: { ...(outcome.detail ?? {}), published_before_failure: published.map((p) => ({ scope: p.version.scope, version: p.version.version })) } };
    }
    published.push(outcome);
  }

  const [tenantHead, moduleHead] = await Promise.all(scopes.map((s) => store.getConfigHead(args.tenantId, s.scope)));
  return {
    ok: true,
    published,
    tenantVersion: tenantHead?.version ?? 0,
    moduleVersion: moduleHead?.version ?? 0,
    warnings: whole.warnings,
  };
}

/* ── legacy import (0014 §4) ────────────────────────────── */

export interface LegacyImportResult {
  tenantId: string;
  status: 'imported' | 'quarantined' | 'skipped' | 'failed';
  message: string;
  versions?: { tenant: number; modules: Record<string, number> };
  fieldErrors?: FieldError[];
}

const isLegacy = (draft: ConfigDraftRow) =>
  typeof draft.origin === 'object' && draft.origin !== null && 'legacy' in draft.origin;

/**
 * Validate and publish the drafts 0014 copied out of `module_configs`.
 *
 * Operator only, and idempotent: a tenant whose legacy drafts are published has none
 * left open, so a second run reports nothing for it. A pair that fails validation is
 * left exactly where it is — an open draft, with its provenance, for an operator to
 * correct through the ordinary draft path. Nothing is defaulted, coerced or guessed.
 */
export async function importLegacyConfig(
  store: ConfigStore,
  args: { tenantId: string | null; actor: ConfigActor },
): Promise<Ok<{ results: LegacyImportResult[] }> | ConfigFailure> {
  if (args.actor.kind !== 'operator') return failure('forbidden', 'importing configuration is an operator action');

  const drafts = (await store.listOpenDrafts(args.tenantId)).filter(isLegacy);
  const tenants = [...new Set(drafts.map((d) => d.tenantId))].sort();
  const results: LegacyImportResult[] = [];

  for (const tenantId of tenants) {
    const tenantDraft = drafts.find((d) => d.tenantId === tenantId && d.scope === 'tenant') ?? null;
    const moduleDrafts = drafts.filter((d) => d.tenantId === tenantId && d.scope === 'module');

    const tenantHead = await store.getConfigHead(tenantId, TENANT_SCOPE);
    let tenantDocument: Record<string, unknown>;
    if (tenantDraft) {
      if (tenantHead) {
        results.push({ tenantId, status: 'skipped', message: 'this tenant already has published tenant settings — its legacy drafts are left open for review' });
        continue;
      }
      const tenantCheck = await validateScopeDocument(store, tenantId, TENANT_SCOPE, tenantDraft.config);
      if (!tenantCheck.ok) {
        results.push({ tenantId, status: 'quarantined', message: tenantCheck.message, fieldErrors: tenantCheck.fieldErrors });
        continue;
      }
      tenantDocument = tenantCheck.document;
    } else if (tenantHead) {
      /* the settings went out on an earlier run and a module draft did not — retry it
         against what was published. */
      tenantDocument = tenantHead.config;
    } else {
      results.push({ tenantId, status: 'quarantined', message: 'no legacy tenant settings to compose the module configuration with' });
      continue;
    }

    const moduleChecks = await Promise.all(moduleDrafts.map((d) =>
      validateScopeDocument(store, tenantId, moduleScope(d.moduleKey!), d.config, { tenantDocument })));
    const bad = moduleChecks.find((c) => !c.ok) as ConfigFailure | undefined;
    if (bad) {
      results.push({ tenantId, status: 'quarantined', message: bad.message, fieldErrors: bad.fieldErrors });
      continue;
    }

    let tenantVersion = tenantHead?.version ?? 0;
    if (tenantDraft) {
      const tenantOutcome = await publishDraft(store, {
        tenantId, scope: TENANT_SCOPE, draftId: tenantDraft.id,
        expectedRevision: tenantDraft.revision, expectedVersion: 0, actor: args.actor,
        note: 'imported from module_configs by 0014',
      });
      if (!tenantOutcome.ok) {
        results.push({ tenantId, status: 'failed', message: tenantOutcome.message, fieldErrors: tenantOutcome.fieldErrors });
        continue;
      }
      tenantVersion = tenantOutcome.version.version;
    }
    const modules: Record<string, number> = {};
    let failed: ConfigFailure | null = null;
    for (const draft of moduleDrafts) {
      const outcome = await publishDraft(store, {
        tenantId, scope: moduleScope(draft.moduleKey!), draftId: draft.id,
        expectedRevision: draft.revision, expectedVersion: draft.baseVersion, actor: args.actor,
        note: 'imported from module_configs by 0014',
      });
      if (!outcome.ok) { failed = outcome; break; }
      modules[draft.moduleKey!] = outcome.version.version;
    }
    results.push(failed
      ? { tenantId, status: 'failed', message: failed.message, fieldErrors: failed.fieldErrors, versions: { tenant: tenantVersion, modules } }
      : { tenantId, status: 'imported', message: 'published as version 1', versions: { tenant: tenantVersion, modules } });
  }
  return { ok: true, results };
}
