/**
 * The production adapter for ARC-110's configuration tables (0014).
 *
 * Every column the engine relies on is named here explicitly, in both directions — the
 * ARC-015B defect was an insert that left one out while the in-memory store kept the
 * whole object. `tests/config-adapter.test.js` asserts these exact payloads through a
 * double that stores only what it is sent, and `tests/config-contract.test.js` runs the
 * shared contract against real Postgres where PGlite is installed.
 *
 * Publication and rollback are one RPC each; the database's refusals arrive as
 * `arc_config:<code>: …` and are turned back into `ConfigStoreError` so the engine sees
 * the same thing from either store.
 */

import {
  type ConfigDraftRow,
  type ConfigScope,
  ConfigStoreError,
  type ConfigVersionRow,
  parseConfigStoreError,
  scopeModuleKey,
} from './model.ts';
import type { ConfigStore, NewDraftInput, PublishDraftInput, RollbackInput } from './store.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

const UNIQUE_VIOLATION = '23505';

const TABLES = {
  tenant: { versions: 'tenant_config_versions', heads: 'tenant_config_heads', drafts: 'tenant_config_drafts' },
  module: { versions: 'module_config_versions', heads: 'module_config_heads', drafts: 'module_config_drafts' },
} as const;

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? 'unknown database error'}`);
}

/** Our own refusal if it is one, otherwise the generic failure. */
function raise(what: string, error: { code?: string; message?: string }): never {
  const parsed = parseConfigStoreError(error.message);
  if (parsed) throw parsed;
  fail(what, error);
}

// deno-lint-ignore no-explicit-any
export const toConfigVersion = (row: any): ConfigVersionRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  scope: row.module_key ? 'module' : 'tenant',
  moduleKey: row.module_key ?? null,
  version: row.version,
  schemaKey: row.schema_key,
  schemaVersion: row.schema_version,
  config: row.config ?? {},
  configHash: row.config_hash,
  parentVersionId: row.parent_version_id ?? null,
  rollbackOfVersionId: row.rollback_of_version_id ?? null,
  source: row.source,
  publishedFromDraftId: row.published_from_draft_id ?? null,
  provenance: row.provenance ?? {},
  changeImpact: row.change_impact ?? {},
  createdBy: row.created_by ?? null,
  publishedBy: row.published_by ?? null,
  publishedAt: row.published_at,
  note: row.note ?? null,
});

// deno-lint-ignore no-explicit-any
export const toConfigDraft = (row: any): ConfigDraftRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  scope: row.module_key ? 'module' : 'tenant',
  moduleKey: row.module_key ?? null,
  schemaKey: row.schema_key,
  schemaVersion: row.schema_version,
  baseVersionId: row.base_version_id ?? null,
  baseVersion: row.base_version,
  config: row.config ?? {},
  revision: row.revision,
  status: row.status,
  publishedVersionId: row.published_version_id ?? null,
  origin: row.origin ?? {},
  createdBy: row.created_by ?? null,
  updatedBy: row.updated_by ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at ?? null,
});

export function supabaseConfigStore(db: Db): ConfigStore {
  /** a query on a scope's table, already narrowed to one tenant (and one module). */
  function scoped(table: string, tenantId: string, scope: ConfigScope, columns = '*') {
    let query = db.from(table).select(columns).eq('tenant_id', tenantId);
    if (scope.kind === 'module') query = query.eq('module_key', scope.moduleKey);
    return query;
  }

  function scopedUpdate(table: string, tenantId: string, scope: ConfigScope, draftId: string, payload: Record<string, unknown>) {
    let query = db.from(table).update(payload).eq('id', draftId).eq('tenant_id', tenantId);
    if (scope.kind === 'module') query = query.eq('module_key', scope.moduleKey);
    return query;
  }

  return {
    async getConfigHead(tenantId, scope) {
      const { data, error } = await scoped(TABLES[scope.kind].heads, tenantId, scope).maybeSingle();
      if (error) fail(`${scope.kind} config head read`, error);
      return data ? toConfigVersion(data) : null;
    },

    async getConfigVersion(tenantId, scope, versionId) {
      const { data, error } = await scoped(TABLES[scope.kind].versions, tenantId, scope).eq('id', versionId).maybeSingle();
      if (error) fail(`${scope.kind} config version read`, error);
      return data ? toConfigVersion(data) : null;
    },

    async listConfigVersions(tenantId, scope, limit) {
      const { data, error } = await scoped(TABLES[scope.kind].versions, tenantId, scope)
        .order('version', { ascending: false })
        .limit(limit);
      if (error) fail(`${scope.kind} config history read`, error);
      return (data ?? []).map(toConfigVersion);
    },

    async listModuleConfigHeads(tenantId) {
      const { data, error } = await db.from('module_config_heads').select('*').eq('tenant_id', tenantId);
      if (error) fail('module config heads read', error);
      return (data ?? []).map(toConfigVersion);
    },

    async getOpenDraft(tenantId, scope) {
      const { data, error } = await scoped(TABLES[scope.kind].drafts, tenantId, scope).eq('status', 'open').maybeSingle();
      if (error) fail(`${scope.kind} open draft read`, error);
      return data ? toConfigDraft(data) : null;
    },

    async getDraft(tenantId, scope, draftId) {
      const { data, error } = await scoped(TABLES[scope.kind].drafts, tenantId, scope).eq('id', draftId).maybeSingle();
      if (error) fail(`${scope.kind} draft read`, error);
      return data ? toConfigDraft(data) : null;
    },

    async listOpenDrafts(tenantId) {
      const out: ConfigDraftRow[] = [];
      for (const table of [TABLES.tenant.drafts, TABLES.module.drafts]) {
        let query = db.from(table).select('*').eq('status', 'open');
        if (tenantId !== null) query = query.eq('tenant_id', tenantId);
        const { data, error } = await query;
        if (error) fail('open draft list', error);
        out.push(...(data ?? []).map(toConfigDraft));
      }
      return out;
    },

    async insertDraft(input: NewDraftInput) {
      const moduleKey = scopeModuleKey(input.scope);
      const payload: Record<string, unknown> = {
        tenant_id: input.tenantId,
        schema_key: input.schemaKey,
        schema_version: input.schemaVersion,
        base_version_id: input.baseVersionId,
        base_version: input.baseVersion,
        config: input.config,
        origin: input.origin ?? {},
        created_by: input.actorId,
      };
      if (moduleKey) payload.module_key = moduleKey;
      const { data, error } = await db.from(TABLES[input.scope.kind].drafts).insert(payload).select('*').single();
      if (error) {
        /* the one-open-draft partial unique index. */
        if (error.code === UNIQUE_VIOLATION) throw new ConfigStoreError('draft_exists', 'this scope already has an open draft');
        raise('draft insert', error);
      }
      return toConfigDraft(data);
    },

    async updateDraftContent(args) {
      /* one conditional UPDATE. the trigger bumps `revision`; a caller holding a stale one
         matches no row and gets null — never a silent overwrite. */
      const { data, error } = await scopedUpdate(TABLES[args.scope.kind].drafts, args.tenantId, args.scope, args.draftId, {
        config: args.config,
        updated_by: args.actorId,
      })
        .eq('status', 'open')
        .eq('revision', args.expectedRevision)
        .select('*')
        .maybeSingle();
      if (error) raise('draft update', error);
      return data ? toConfigDraft(data) : null;
    },

    async closeDraft(args) {
      const { data, error } = await scopedUpdate(TABLES[args.scope.kind].drafts, args.tenantId, args.scope, args.draftId, {
        status: args.status,
        updated_by: args.actorId,
      })
        .eq('status', 'open')
        .eq('revision', args.expectedRevision)
        .select('*')
        .maybeSingle();
      if (error) raise('draft close', error);
      return data ? toConfigDraft(data) : null;
    },

    async publishConfigDraft(input: PublishDraftInput) {
      const { data, error } = await db.rpc('publish_config_draft', {
        p_scope: input.scope.kind,
        p_tenant: input.tenantId,
        p_module_key: scopeModuleKey(input.scope),
        p_draft_id: input.draftId,
        p_expected_draft_revision: input.expectedDraftRevision,
        p_expected_version: input.expectedHeadVersion,
        p_config_hash: input.configHash,
        p_change_impact: input.changeImpact,
        p_actor: input.actorId,
        p_note: input.note,
      });
      if (error) {
        /* two publishers past the lock is impossible, but the unique (scope, version)
           index is the last word and its answer is the same: somebody got there first. */
        if (error.code === UNIQUE_VIOLATION) throw new ConfigStoreError('publication_conflict', 'another version was published first');
        raise('config publish', error);
      }
      if (!data || typeof data !== 'object') fail('config publish', { message: 'the database returned no version' });
      return toConfigVersion(data);
    },

    async rollbackConfigVersion(input: RollbackInput) {
      const { data, error } = await db.rpc('rollback_config_version', {
        p_scope: input.scope.kind,
        p_tenant: input.tenantId,
        p_module_key: scopeModuleKey(input.scope),
        p_source_version_id: input.sourceVersionId,
        p_expected_version: input.expectedHeadVersion,
        p_change_impact: input.changeImpact,
        p_actor: input.actorId,
        p_note: input.note,
      });
      if (error) {
        if (error.code === UNIQUE_VIOLATION) throw new ConfigStoreError('publication_conflict', 'another version was published first');
        raise('config rollback', error);
      }
      if (!data || typeof data !== 'object') fail('config rollback', { message: 'the database returned no version' });
      return toConfigVersion(data);
    },
  };
}
