/**
 * ARC-110 — the vocabulary of versioned tenant configuration.
 *
 * Two scopes, one lifecycle:
 *
 *   tenant  one document per tenant: the facts every module shares (tenant_settings@1)
 *   module  one document per (tenant, module): what only that module means
 *
 * Each scope has an append-only history of **published versions** and at most one
 * **open draft**. A draft is mutable, guarded by a revision counter, and never read by
 * anything that executes. A version is immutable, numbered 1, 2, 3… per scope, and the
 * highest number *is* the current configuration — there is no pointer to fall out of
 * step, and a rollback is simply the next number with older content.
 *
 * Nothing here touches a database. `store.ts` is the seam, `engine.ts` the rules.
 */

export type ScopeKind = 'tenant' | 'module';

export type ConfigScope = { kind: 'tenant' } | { kind: 'module'; moduleKey: string };

export const TENANT_SCOPE: ConfigScope = Object.freeze({ kind: 'tenant' as const });

export function moduleScope(moduleKey: string): ConfigScope {
  return { kind: 'module', moduleKey };
}

export function scopeModuleKey(scope: ConfigScope): string | null {
  return scope.kind === 'module' ? scope.moduleKey : null;
}

export function describeScope(scope: ConfigScope): string {
  return scope.kind === 'tenant' ? 'tenant settings' : `${scope.moduleKey} configuration`;
}

/** An immutable published configuration version. */
export interface ConfigVersionRow {
  id: string;
  tenantId: string;
  scope: ScopeKind;
  moduleKey: string | null;
  /** 1, 2, 3… per scope. The highest is the current configuration. */
  version: number;
  schemaKey: string;
  schemaVersion: number;
  /** the complete, validated, normalised document for this scope. */
  config: Record<string, unknown>;
  configHash: string;
  /** the version this one replaced. null only for version 1. */
  parentVersionId: string | null;
  /** set on a rollback: the historical version whose content was republished. */
  rollbackOfVersionId: string | null;
  source: 'draft' | 'rollback';
  publishedFromDraftId: string | null;
  /** where the content came from, when that is not simply "a draft": e.g. the legacy row. */
  provenance: Record<string, unknown>;
  /** the audit-safe change-impact summary: paths and flags, never values. */
  changeImpact: Record<string, unknown>;
  createdBy: string | null;
  publishedBy: string | null;
  publishedAt: string;
  note: string | null;
}

export type DraftStatus = 'open' | 'published' | 'discarded' | 'superseded';

/** Work in progress. Mutable while open, frozen once closed, never executed. */
export interface ConfigDraftRow {
  id: string;
  tenantId: string;
  scope: ScopeKind;
  moduleKey: string | null;
  schemaKey: string;
  schemaVersion: number;
  /** the version this draft was written against; 0 and null when there was none. */
  baseVersionId: string | null;
  baseVersion: number;
  config: Record<string, unknown>;
  /** the optimistic-concurrency token. the database bumps it on every write. */
  revision: number;
  status: DraftStatus;
  publishedVersionId: string | null;
  /** provenance carried into the published version (e.g. `{ legacy: {...} }`). */
  origin: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/**
 * Who is asking. Always derived from an authenticated context by the caller — the `ops`
 * function takes it from the verified JWT, never from a request body.
 *
 * `client` exists so the field-permission rule is enforced for the audience ARC-310 may
 * one day open a path to. Today every field is `clientEditable: false`, so a client
 * actor can read the rule's answer ("no") and nothing else; there is no HTTP route that
 * builds one.
 */
export type ConfigActor =
  | { kind: 'operator'; userId: string }
  | { kind: 'client'; userId: string; tenantId: string };

export interface FieldError {
  /** dotted path into the document, or '' for a whole-document problem. */
  path: string;
  message: string;
}

export type ConfigErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'tenant_mismatch'
  | 'module_not_found'
  | 'schema_not_supported'
  | 'validation_failed'
  | 'edit_permission_denied'
  | 'draft_conflict'
  | 'draft_exists'
  | 'draft_not_found'
  | 'draft_closed'
  | 'stale_draft'
  | 'publication_conflict'
  | 'version_not_found'
  | 'rollback_incompatible'
  | 'missing_published_configuration'
  | 'number_claimed'
  | 'no_change';

export const CONFIG_ERROR_CODES: readonly ConfigErrorCode[] = Object.freeze([
  'unauthorized', 'forbidden', 'tenant_mismatch', 'module_not_found', 'schema_not_supported',
  'validation_failed', 'edit_permission_denied', 'draft_conflict', 'draft_exists', 'draft_not_found',
  'draft_closed', 'stale_draft', 'publication_conflict', 'version_not_found', 'rollback_incompatible',
  'missing_published_configuration', 'number_claimed', 'no_change',
]);

/** The HTTP status each failure maps to at the `ops` boundary. */
export const CONFIG_ERROR_STATUS: Readonly<Record<ConfigErrorCode, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  tenant_mismatch: 403,
  module_not_found: 404,
  schema_not_supported: 422,
  validation_failed: 422,
  edit_permission_denied: 403,
  draft_conflict: 409,
  draft_exists: 409,
  draft_not_found: 404,
  draft_closed: 409,
  stale_draft: 409,
  publication_conflict: 409,
  version_not_found: 404,
  rollback_incompatible: 422,
  missing_published_configuration: 404,
  number_claimed: 409,
  no_change: 409,
});

export interface ConfigFailure {
  ok: false;
  code: ConfigErrorCode;
  message: string;
  fieldErrors?: FieldError[];
  detail?: Record<string, unknown>;
}

export function failure(
  code: ConfigErrorCode,
  message: string,
  extra: { fieldErrors?: FieldError[]; detail?: Record<string, unknown> } = {},
): ConfigFailure {
  return { ok: false, code, message, ...extra };
}

/**
 * A structured refusal from the store — the database's own words, parsed.
 *
 * The SQL functions in 0014 raise `arc_config:<code>: <sentence>`; the production adapter
 * turns that back into this, and `MemoryStore` throws the same thing directly, so the
 * engine handles one shape whichever store it is given.
 */
export class ConfigStoreError extends Error {
  code: ConfigErrorCode;
  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = 'ConfigStoreError';
    this.code = code;
  }
}

const RAISED = /arc_config:([a-z_]+):\s*([\s\S]*)$/;

/** Parse a database error raised by a 0014 function. null when it is not one of ours. */
export function parseConfigStoreError(message: string | null | undefined): ConfigStoreError | null {
  const match = RAISED.exec(message ?? '');
  if (!match) return null;
  const code = match[1] as ConfigErrorCode;
  if (!CONFIG_ERROR_CODES.includes(code)) return null;
  return new ConfigStoreError(code, match[2].trim());
}
