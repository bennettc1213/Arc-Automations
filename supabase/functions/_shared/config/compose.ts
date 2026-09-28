/**
 * Composing the effective configuration — the one definition of "what a tenant's module
 * is configured to do", from exactly two published versions.
 *
 * **Merge rule.** The registry assigns every field to exactly one scope
 * (`FieldMetadata.ownerScope`). A tenant document holds only tenant fields, a module
 * document only the module's own, so the effective configuration is their disjoint
 * union. There is no precedence to get wrong: a key present in both, or in the wrong
 * one, is refused rather than resolved.
 *
 * **Determinism.** The inputs are two immutable rows and the output is a pure function
 * of them — the same two version ids always produce the same effective document and the
 * same hash. Nothing reads a draft, the mutable `module_configs.config` column, or the
 * clock.
 *
 * **Validation on read.** The composed document is validated by the module's registered
 * schema every time, as `loadConfig` always has: a version published under an older
 * validator must not put the engine into a state today's validator would refuse.
 */

import { configHash } from '../canonical-json.ts';
import { resolveModuleRuntime } from '../registry/index.ts';
import { tenantOwnedFields, tenantSettingsSchema, type ConfigSchema } from '../registry/schemas.ts';
import {
  type ConfigFailure,
  type ConfigVersionRow,
  failure,
  type FieldError,
} from './model.ts';

export interface VersionRef {
  id: string;
  version: number;
  schemaKey: string;
  schemaVersion: number;
}

/** Everything needed to reproduce exactly what was resolved. */
export interface Resolution {
  ok: true;
  tenantId: string;
  moduleKey: string;
  tenantVersion: VersionRef;
  moduleVersion: VersionRef;
  /** the validated, normalised effective configuration. */
  config: Record<string, unknown>;
  /** sha-256 of `config`'s canonical form. */
  configHash: string;
  warnings: string[];
}

export const refOf = (row: ConfigVersionRow): VersionRef => ({
  id: row.id,
  version: row.version,
  schemaKey: row.schemaKey,
  schemaVersion: row.schemaVersion,
});

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Turn a validator's sentences into field-level errors.
 *
 * The registered validators report in prose that begins with the path it concerns
 * ("business_hours.mon[0].open must be…"). The path is lifted out when its root is a
 * field the schema knows — or when the sentence is the refusal of an unknown key, whose
 * path is the point — and otherwise the error is whole-document (`path: ''`). The
 * validators themselves are unchanged: this reads their output, it does not reimplement
 * them.
 */
export function toFieldErrors(errors: readonly string[], knownFields: readonly string[]): FieldError[] {
  return errors.map((message) => {
    const token = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+|\[\d+\])*)\s/.exec(message)?.[1] ?? '';
    const root = token.split(/[.[]/)[0];
    const unknownKey = /is not a (setting|tenant-wide setting)/.test(message);
    return { path: token && (knownFields.includes(root) || unknownKey) ? token : '', message };
  });
}

/** Split an effective configuration into the two documents that store it. */
export function splitEffective(
  moduleSchema: ConfigSchema,
  effective: Record<string, unknown>,
): { tenant: Record<string, unknown>; module: Record<string, unknown> } {
  const tenantKeys = tenantOwnedFields(moduleSchema.key);
  const tenant: Record<string, unknown> = {};
  const module: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(effective)) {
    if (tenantKeys.includes(key)) tenant[key] = value;
    else module[key] = value;
  }
  return { tenant, module };
}

/** Keys a module document may not carry, because the tenant document owns them. */
export function tenantKeysIn(moduleSchema: ConfigSchema, doc: Record<string, unknown>): string[] {
  const tenantKeys = tenantOwnedFields(moduleSchema.key);
  return Object.keys(doc).filter((k) => tenantKeys.includes(k));
}

/**
 * The disjoint union, and nothing else.
 *
 * Only the tenant fields this module declares are taken from the tenant document; a
 * tenant field no module reads stays out of the module's configuration.
 */
export function composeDocuments(
  moduleSchema: ConfigSchema,
  tenantDoc: Record<string, unknown>,
  moduleDoc: Record<string, unknown>,
): { ok: true; merged: Record<string, unknown> } | ConfigFailure {
  if (!isPlainObject(tenantDoc) || !isPlainObject(moduleDoc)) {
    return failure('validation_failed', 'a configuration document must be a JSON object');
  }
  const clash = tenantKeysIn(moduleSchema, moduleDoc);
  if (clash.length > 0) {
    return failure(
      'validation_failed',
      `the module document carries ${clash.join(', ')}, which belong to the tenant settings — a field is stored in exactly one scope`,
      { fieldErrors: clash.map((path) => ({ path, message: `${path} is a tenant-wide setting` })) },
    );
  }
  const merged: Record<string, unknown> = { ...moduleDoc };
  for (const key of tenantOwnedFields(moduleSchema.key)) {
    if (key in tenantDoc) merged[key] = tenantDoc[key];
  }
  return { ok: true, merged };
}

/**
 * Resolve a module's effective configuration from one tenant version and one module
 * version. Pure: no store, no clock.
 */
export async function composeEffective(
  tenantId: string,
  moduleKey: string,
  tenantVersion: ConfigVersionRow,
  moduleVersion: ConfigVersionRow,
): Promise<Resolution | ConfigFailure> {
  const runtime = resolveModuleRuntime(moduleKey);
  if (!runtime) return failure('module_not_found', `${moduleKey} is not a module with a registered configuration schema`);

  /* the store is tenant-scoped already; this is the second statement of it, because a
     resolution that crossed tenants would put one company's words in another's texts. */
  if (tenantVersion.tenantId !== tenantId || moduleVersion.tenantId !== tenantId) {
    return failure('tenant_mismatch', 'a configuration version belongs to a different tenant');
  }
  if (tenantVersion.scope !== 'tenant' || moduleVersion.scope !== 'module' || moduleVersion.moduleKey !== moduleKey) {
    return failure('validation_failed', `those versions are not a tenant settings version and a ${moduleKey} version`);
  }

  const tenantSchema = tenantSettingsSchema();
  if (tenantVersion.schemaKey !== tenantSchema.key || tenantVersion.schemaVersion !== tenantSchema.version) {
    return failure(
      'schema_not_supported',
      `tenant settings version ${tenantVersion.version} is ${tenantVersion.schemaKey}@${tenantVersion.schemaVersion}; this build reads ${tenantSchema.key}@${tenantSchema.version}`,
    );
  }
  if (moduleVersion.schemaKey !== runtime.schema.key || moduleVersion.schemaVersion !== runtime.schema.version) {
    return failure(
      'schema_not_supported',
      `${moduleKey} version ${moduleVersion.version} is ${moduleVersion.schemaKey}@${moduleVersion.schemaVersion}; ${moduleKey} runs ${runtime.schema.key}@${runtime.schema.version}`,
    );
  }

  const tenantCheck = tenantSchema.validate(tenantVersion.config);
  if (!tenantCheck.ok) {
    return failure('validation_failed', `the published tenant settings are not valid: ${tenantCheck.errors.slice(0, 3).join('; ')}`, {
      fieldErrors: toFieldErrors(tenantCheck.errors, tenantSchema.fields.map((f) => f.key)),
    });
  }

  const composed = composeDocuments(runtime.schema, tenantVersion.config, moduleVersion.config);
  if (!composed.ok) return composed;

  const result = runtime.schema.validate(composed.merged);
  if (!result.ok) {
    return failure(
      'validation_failed',
      `the published ${moduleKey} configuration is not valid: ${result.errors.slice(0, 3).join('; ')}`,
      { fieldErrors: toFieldErrors(result.errors, runtime.schema.fields.map((f) => f.key)) },
    );
  }

  const config = result.config as Record<string, unknown>;
  return {
    ok: true,
    tenantId,
    moduleKey,
    tenantVersion: refOf(tenantVersion),
    moduleVersion: refOf(moduleVersion),
    config,
    configHash: await configHash(config),
    warnings: result.warnings,
  };
}
