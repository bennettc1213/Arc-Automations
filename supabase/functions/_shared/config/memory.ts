/**
 * The configuration tables, in memory — `MemoryStore`'s half of ARC-110.
 *
 * Each rule here is one 0014 enforces, named after the object that enforces it, so a
 * test that passes against this store is a test about behaviour Postgres also
 * guarantees. `tests/config-contract.test.js` runs the same promises against the
 * production adapter over real SQL where PGlite is installed; where it is not, this
 * file and the migration are the two statements of the contract and the textual SQL
 * tests keep them aligned.
 *
 * `MemoryStore` extends this class, so one test object holds the whole database.
 */

import { getModuleVersion, MODULES } from '../registry/modules.ts';
import { getConfigSchema } from '../registry/schemas.ts';
import {
  type ConfigDraftRow,
  type ConfigScope,
  ConfigStoreError,
  type ConfigVersionRow,
  scopeModuleKey,
} from './model.ts';
import type { ConfigStore, NewDraftInput, PublishDraftInput, RollbackInput } from './store.ts';
import type { TenantConfigRow } from '../engine/store.ts';

export interface AdminActionRow {
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Mirrors `registry_module_versions` read the way 0014's guards read it. */
function selectableSchema(moduleKey: string, schemaKey: string, schemaVersion: number): boolean {
  const module = MODULES.find((m) => m.key === moduleKey);
  if (!module) return false;
  return module.versions.some((v) => {
    const version = getModuleVersion(moduleKey, v.version);
    return version !== null
      && (version.status === 'pilot' || version.status === 'available')
      && version.configSchemaKey === schemaKey
      && version.configSchemaVersion === schemaVersion;
  });
}

function moduleIsConfigurable(moduleKey: string): boolean {
  const module = MODULES.find((m) => m.key === moduleKey);
  return Boolean(module?.versions.some((v) => v.status === 'pilot' || v.status === 'available'));
}

/** Mirrors `tenant_config_versions_no_secrets` and its siblings. */
const SECRET_SHAPED = /(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )/i;

export class MemoryConfigStore implements ConfigStore {
  /** module_configs: the switch row. `config` is frozen legacy content (0014 §7). */
  configs: TenantConfigRow[] = [];
  tenantConfigVersions: ConfigVersionRow[] = [];
  moduleConfigVersions: ConfigVersionRow[] = [];
  configDrafts: ConfigDraftRow[] = [];
  /** arc_admins. the publish and rollback functions check the actor against it. */
  operators: string[] = [];
  /** admin_actions, as the 0014 functions write it. */
  adminActions: AdminActionRow[] = [];

  protected configId(): string {
    return crypto.randomUUID();
  }

  private versionsFor(scope: ConfigScope): ConfigVersionRow[] {
    return scope.kind === 'tenant' ? this.tenantConfigVersions : this.moduleConfigVersions;
  }

  private inScope(row: { tenantId: string; scope: string; moduleKey: string | null }, tenantId: string, scope: ConfigScope) {
    return row.tenantId === tenantId && row.scope === scope.kind && row.moduleKey === scopeModuleKey(scope);
  }

  private head(tenantId: string, scope: ConfigScope): ConfigVersionRow | null {
    const rows = this.versionsFor(scope).filter((v) => this.inScope(v, tenantId, scope));
    return rows.reduce<ConfigVersionRow | null>((best, v) => (!best || v.version > best.version ? v : best), null);
  }

  // ── reads ──
  // deno-lint-ignore require-await
  async getConfigHead(tenantId: string, scope: ConfigScope) {
    return this.head(tenantId, scope);
  }

  // deno-lint-ignore require-await
  async getConfigVersion(tenantId: string, scope: ConfigScope, versionId: string) {
    return this.versionsFor(scope).find((v) => v.id === versionId && this.inScope(v, tenantId, scope)) ?? null;
  }

  // deno-lint-ignore require-await
  async listConfigVersions(tenantId: string, scope: ConfigScope, limit: number) {
    return this.versionsFor(scope)
      .filter((v) => this.inScope(v, tenantId, scope))
      .sort((a, b) => b.version - a.version)
      .slice(0, limit);
  }

  // deno-lint-ignore require-await
  async listModuleConfigHeads(tenantId: string) {
    const keys = [...new Set(this.moduleConfigVersions.filter((v) => v.tenantId === tenantId).map((v) => v.moduleKey!))];
    return keys.map((moduleKey) => this.head(tenantId, { kind: 'module', moduleKey })!).filter(Boolean);
  }

  // deno-lint-ignore require-await
  async getOpenDraft(tenantId: string, scope: ConfigScope) {
    return this.configDrafts.find((d) => this.inScope(d, tenantId, scope) && d.status === 'open') ?? null;
  }

  // deno-lint-ignore require-await
  async getDraft(tenantId: string, scope: ConfigScope, draftId: string) {
    return this.configDrafts.find((d) => d.id === draftId && this.inScope(d, tenantId, scope)) ?? null;
  }

  // deno-lint-ignore require-await
  async listOpenDrafts(tenantId: string | null) {
    return this.configDrafts.filter((d) => d.status === 'open' && (tenantId === null || d.tenantId === tenantId));
  }

  // ── drafts (config_drafts_guard) ──
  // deno-lint-ignore require-await
  async insertDraft(input: NewDraftInput) {
    const moduleKey = scopeModuleKey(input.scope);
    const schema = getConfigSchema(input.schemaKey, input.schemaVersion);
    if (!schema || schema.scope !== input.scope.kind) {
      throw new ConfigStoreError('schema_not_supported', `${input.schemaKey}@${input.schemaVersion} is not a registered ${input.scope.kind} schema`);
    }
    if (moduleKey && !selectableSchema(moduleKey, input.schemaKey, input.schemaVersion)) {
      throw new ConfigStoreError('schema_not_supported', `${input.schemaKey}@${input.schemaVersion} is not the configuration schema of a selectable ${moduleKey} version`);
    }
    if (SECRET_SHAPED.test(JSON.stringify(input.config))) {
      throw new Error('new row violates check constraint "config_drafts_no_secrets"');
    }
    const head = this.head(input.tenantId, input.scope);
    if (input.baseVersion !== (head?.version ?? 0) || input.baseVersionId !== (head?.id ?? null)) {
      throw new ConfigStoreError('stale_draft', `a new draft must start from the current version (${head?.version ?? 0})`);
    }
    if (this.configDrafts.some((d) => this.inScope(d, input.tenantId, input.scope) && d.status === 'open')) {
      throw new ConfigStoreError('draft_exists', 'this scope already has an open draft');
    }
    const now = new Date().toISOString();
    const draft: ConfigDraftRow = {
      id: this.configId(),
      tenantId: input.tenantId,
      scope: input.scope.kind,
      moduleKey,
      schemaKey: input.schemaKey,
      schemaVersion: input.schemaVersion,
      baseVersionId: input.baseVersionId,
      baseVersion: input.baseVersion,
      config: clone(input.config),
      revision: 1,
      status: 'open',
      publishedVersionId: null,
      origin: clone(input.origin ?? {}),
      createdBy: input.actorId,
      updatedBy: input.actorId,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.configDrafts.push(draft);
    return clone(draft);
  }

  // deno-lint-ignore require-await
  async updateDraftContent(args: {
    tenantId: string; scope: ConfigScope; draftId: string; expectedRevision: number;
    config: Record<string, unknown>; actorId: string | null;
  }) {
    const draft = this.configDrafts.find((d) => d.id === args.draftId && this.inScope(d, args.tenantId, args.scope));
    if (!draft || draft.status !== 'open' || draft.revision !== args.expectedRevision) return null;
    if (SECRET_SHAPED.test(JSON.stringify(args.config))) {
      throw new Error('new row violates check constraint "config_drafts_no_secrets"');
    }
    draft.config = clone(args.config);
    draft.revision += 1;
    draft.updatedBy = args.actorId;
    draft.updatedAt = new Date().toISOString();
    return clone(draft);
  }

  // deno-lint-ignore require-await
  async closeDraft(args: {
    tenantId: string; scope: ConfigScope; draftId: string; expectedRevision: number;
    status: 'discarded' | 'superseded'; actorId: string | null;
  }) {
    const draft = this.configDrafts.find((d) => d.id === args.draftId && this.inScope(d, args.tenantId, args.scope));
    if (!draft || draft.status !== 'open' || draft.revision !== args.expectedRevision) return null;
    draft.status = args.status;
    draft.revision += 1;
    draft.updatedBy = args.actorId;
    draft.updatedAt = draft.closedAt = new Date().toISOString();
    return clone(draft);
  }

  // ── publication (publish_config_draft / rollback_config_version) ──

  private requireOperator(actorId: string | null) {
    if (!actorId || !this.operators.includes(actorId)) {
      throw new ConfigStoreError('forbidden', 'publishing configuration is an operator action');
    }
  }

  private requireScope(scope: ConfigScope) {
    if (scope.kind === 'module' && !moduleIsConfigurable(scope.moduleKey)) {
      throw new ConfigStoreError('module_not_found', `${scope.moduleKey} is not a module a tenant can be configured for`);
    }
  }

  /** G-P5, as `config_require_unclaimed_number` checks it. */
  private requireUnclaimedNumber(tenantId: string, scope: ConfigScope, config: Record<string, unknown>) {
    if (scope.kind !== 'module' || scope.moduleKey !== 'lead_recovery') return;
    const number = (config as { twilio?: { phone_number?: string | null } }).twilio?.phone_number ?? null;
    if (!number) return;
    const tenants = [...new Set(this.moduleConfigVersions.filter((v) => v.moduleKey === 'lead_recovery').map((v) => v.tenantId))];
    for (const other of tenants) {
      if (other === tenantId) continue;
      const head = this.head(other, scope);
      if ((head?.config as { twilio?: { phone_number?: string } } | undefined)?.twilio?.phone_number === number) {
        throw new ConfigStoreError('number_claimed', `${number} already routes to another tenant`);
      }
    }
  }

  /** The version guard: next number, names its parent, schema selectable, no secrets. */
  private insertVersion(row: ConfigVersionRow) {
    const head = this.head(row.tenantId, row.scope === 'tenant' ? { kind: 'tenant' } : { kind: 'module', moduleKey: row.moduleKey! });
    if (row.version !== (head?.version ?? 0) + 1 || row.parentVersionId !== (head?.id ?? null)) {
      throw new ConfigStoreError('publication_conflict', `version ${row.version} is not the next after ${head?.version ?? 0}`);
    }
    if (row.scope === 'module' && !selectableSchema(row.moduleKey!, row.schemaKey, row.schemaVersion)) {
      throw new ConfigStoreError('schema_not_supported', `${row.schemaKey}@${row.schemaVersion} is not the configuration schema of a selectable ${row.moduleKey} version`);
    }
    if (SECRET_SHAPED.test(JSON.stringify(row.config)) || SECRET_SHAPED.test(JSON.stringify(row.changeImpact))) {
      throw new Error('new row violates check constraint "config_versions_no_secrets"');
    }
    /* frozen: the guard refuses UPDATE and DELETE, and a test that mutated one here
       would be testing something Postgres forbids. */
    deepFreeze(row);
    (row.scope === 'tenant' ? this.tenantConfigVersions : this.moduleConfigVersions).push(row);
  }

  private ensureSwitchRow(tenantId: string, moduleKey: string) {
    if (!this.configs.some((c) => c.tenantId === tenantId && c.moduleKey === moduleKey)) {
      this.configs.push({ tenantId, moduleKey, enabled: false, schemaVersion: 1, configVersion: 1, config: {} });
    }
  }

  // deno-lint-ignore require-await
  async publishConfigDraft(input: PublishDraftInput): Promise<ConfigVersionRow> {
    this.requireOperator(input.actorId);
    this.requireScope(input.scope);
    const draft = this.configDrafts.find((d) => d.id === input.draftId && this.inScope(d, input.tenantId, input.scope));
    if (!draft) throw new ConfigStoreError('draft_not_found', `no such ${input.scope.kind} draft for this tenant`);
    const head = this.head(input.tenantId, input.scope);
    const headVersion = head?.version ?? 0;
    if (draft.status !== 'open') throw new ConfigStoreError('draft_closed', `this draft is ${draft.status}`);
    if (draft.revision !== input.expectedDraftRevision) {
      throw new ConfigStoreError('draft_conflict', `the draft is at revision ${draft.revision}, not ${input.expectedDraftRevision}`);
    }
    if (headVersion !== input.expectedHeadVersion) {
      throw new ConfigStoreError('publication_conflict', `the current version is ${headVersion}, not ${input.expectedHeadVersion}`);
    }
    if (draft.baseVersion !== headVersion) {
      throw new ConfigStoreError('stale_draft', `this draft was written against version ${draft.baseVersion}, and version ${headVersion} has been published since`);
    }
    if (!/^[0-9a-f]{64}$/.test(input.configHash)) throw new ConfigStoreError('validation_failed', 'a content hash is required');
    this.requireUnclaimedNumber(input.tenantId, input.scope, draft.config);

    const row: ConfigVersionRow = {
      id: this.configId(),
      tenantId: input.tenantId,
      scope: input.scope.kind,
      moduleKey: scopeModuleKey(input.scope),
      version: headVersion + 1,
      schemaKey: draft.schemaKey,
      schemaVersion: draft.schemaVersion,
      config: clone(draft.config),
      configHash: input.configHash,
      parentVersionId: head?.id ?? null,
      rollbackOfVersionId: null,
      source: 'draft',
      publishedFromDraftId: draft.id,
      provenance: { ...clone(draft.origin), draft_revision: draft.revision },
      changeImpact: clone(input.changeImpact ?? {}),
      createdBy: draft.createdBy,
      publishedBy: input.actorId,
      publishedAt: new Date().toISOString(),
      note: input.note,
    };
    this.insertVersion(row);

    draft.status = 'published';
    draft.publishedVersionId = row.id;
    draft.revision += 1;
    draft.updatedBy = input.actorId;
    draft.updatedAt = draft.closedAt = row.publishedAt;

    if (input.scope.kind === 'module') this.ensureSwitchRow(input.tenantId, input.scope.moduleKey);

    this.adminActions.push({
      actorUserId: input.actorId,
      action: 'config.published',
      targetType: 'tenant',
      targetId: input.tenantId,
      metadata: {
        scope: input.scope.kind,
        module_key: scopeModuleKey(input.scope),
        version: row.version,
        version_id: row.id,
        parent_version_id: row.parentVersionId,
        schema: `${row.schemaKey}@${row.schemaVersion}`,
        draft_id: draft.id,
        draft_revision: row.provenance.draft_revision,
        impact: clone(input.changeImpact ?? {}),
      },
      occurredAt: row.publishedAt,
    });
    return row;
  }

  // deno-lint-ignore require-await
  async rollbackConfigVersion(input: RollbackInput): Promise<ConfigVersionRow> {
    this.requireOperator(input.actorId);
    this.requireScope(input.scope);
    const source = this.versionsFor(input.scope).find((v) => v.id === input.sourceVersionId && this.inScope(v, input.tenantId, input.scope));
    if (!source) throw new ConfigStoreError('version_not_found', `no such ${input.scope.kind} version for this tenant`);
    const head = this.head(input.tenantId, input.scope);
    const headVersion = head?.version ?? 0;
    if (headVersion !== input.expectedHeadVersion) {
      throw new ConfigStoreError('publication_conflict', `the current version is ${headVersion}, not ${input.expectedHeadVersion}`);
    }
    if (head?.id === source.id) throw new ConfigStoreError('no_change', `version ${source.version} is already the current version`);
    this.requireUnclaimedNumber(input.tenantId, input.scope, source.config);

    const row: ConfigVersionRow = {
      id: this.configId(),
      tenantId: input.tenantId,
      scope: input.scope.kind,
      moduleKey: scopeModuleKey(input.scope),
      version: headVersion + 1,
      schemaKey: source.schemaKey,
      schemaVersion: source.schemaVersion,
      config: clone(source.config),
      configHash: source.configHash,
      parentVersionId: head?.id ?? null,
      rollbackOfVersionId: source.id,
      source: 'rollback',
      publishedFromDraftId: null,
      provenance: { rollback_of_version: source.version },
      changeImpact: clone(input.changeImpact ?? {}),
      createdBy: input.actorId,
      publishedBy: input.actorId,
      publishedAt: new Date().toISOString(),
      note: input.note,
    };
    this.insertVersion(row);

    this.adminActions.push({
      actorUserId: input.actorId,
      action: 'config.rolled_back',
      targetType: 'tenant',
      targetId: input.tenantId,
      metadata: {
        scope: input.scope.kind,
        module_key: scopeModuleKey(input.scope),
        version: row.version,
        version_id: row.id,
        parent_version_id: row.parentVersionId,
        rollback_of_version_id: source.id,
        rollback_of_version: source.version,
        schema: `${row.schemaKey}@${row.schemaVersion}`,
        impact: clone(input.changeImpact ?? {}),
      },
      occurredAt: row.publishedAt,
    });
    return row;
  }
}
