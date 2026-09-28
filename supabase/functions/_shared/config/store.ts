/**
 * The seam between the configuration engine and the database (ARC-110).
 *
 * Two implementations, as for the execution engine: `MemoryConfigStore` (which
 * `MemoryStore` extends, so a test has one object for both) and the production adapter
 * in `supabase-config-store.ts`. The in-memory one enforces what the 0014 constraints,
 * triggers and functions enforce, and `tests/config-contract.test.js` runs one suite of
 * promises against both — the ARC-015B lesson being that a store which keeps whole
 * objects will happily pass tests the real adapter fails.
 *
 * Writes that must be atomic are single calls here: publishing and rolling back are
 * each one database function, and a draft write is one conditional UPDATE keyed on the
 * revision the caller read.
 */

import type { ConfigDraftRow, ConfigScope, ConfigVersionRow } from './model.ts';

export interface NewDraftInput {
  tenantId: string;
  scope: ConfigScope;
  schemaKey: string;
  schemaVersion: number;
  baseVersionId: string | null;
  baseVersion: number;
  config: Record<string, unknown>;
  origin?: Record<string, unknown>;
  actorId: string | null;
}

export interface PublishDraftInput {
  tenantId: string;
  scope: ConfigScope;
  draftId: string;
  /** the draft revision the caller validated. anything else is a conflict. */
  expectedDraftRevision: number;
  /** the head version the caller believes is current; 0 when there is none. */
  expectedHeadVersion: number;
  /** sha-256 of the draft's canonical content, computed by the engine. */
  configHash: string;
  changeImpact: Record<string, unknown>;
  actorId: string;
  note: string | null;
}

export interface RollbackInput {
  tenantId: string;
  scope: ConfigScope;
  sourceVersionId: string;
  expectedHeadVersion: number;
  changeImpact: Record<string, unknown>;
  actorId: string;
  note: string | null;
}

export interface ConfigStore {
  /** the current published version: the highest-numbered one. */
  getConfigHead(tenantId: string, scope: ConfigScope): Promise<ConfigVersionRow | null>;
  getConfigVersion(tenantId: string, scope: ConfigScope, versionId: string): Promise<ConfigVersionRow | null>;
  /** newest first. */
  listConfigVersions(tenantId: string, scope: ConfigScope, limit: number): Promise<ConfigVersionRow[]>;
  /** every module's current version for this tenant. */
  listModuleConfigHeads(tenantId: string): Promise<ConfigVersionRow[]>;

  getOpenDraft(tenantId: string, scope: ConfigScope): Promise<ConfigDraftRow | null>;
  getDraft(tenantId: string, scope: ConfigScope, draftId: string): Promise<ConfigDraftRow | null>;
  /** open drafts across both scopes; every tenant when `tenantId` is null (legacy import). */
  listOpenDrafts(tenantId: string | null): Promise<ConfigDraftRow[]>;

  /** throws `ConfigStoreError('draft_exists' | 'stale_draft' | 'schema_not_supported')`. */
  insertDraft(input: NewDraftInput): Promise<ConfigDraftRow>;
  /** null when the draft is closed or its revision is no longer `expectedRevision`. */
  updateDraftContent(args: {
    tenantId: string;
    scope: ConfigScope;
    draftId: string;
    expectedRevision: number;
    config: Record<string, unknown>;
    actorId: string | null;
  }): Promise<ConfigDraftRow | null>;
  /** null on the same conditions as `updateDraftContent`. */
  closeDraft(args: {
    tenantId: string;
    scope: ConfigScope;
    draftId: string;
    expectedRevision: number;
    status: 'discarded' | 'superseded';
    actorId: string | null;
  }): Promise<ConfigDraftRow | null>;

  /** atomic: new version, draft closed, audit row. throws `ConfigStoreError`. */
  publishConfigDraft(input: PublishDraftInput): Promise<ConfigVersionRow>;
  /** atomic: new version with the source's content, audit row. throws `ConfigStoreError`. */
  rollbackConfigVersion(input: RollbackInput): Promise<ConfigVersionRow>;
}
