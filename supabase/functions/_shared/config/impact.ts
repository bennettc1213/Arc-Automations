/**
 * What a configuration change touches, and what it costs — read from the registry.
 *
 * `changeImpact()` in `registry/schemas.ts` is the authority on consequences: retest,
 * shadow, reactivation, and the rule that an unrecognised field is maximally
 * consequential. This file does not restate any of it. It finds *which* fields changed
 * (down to nested paths, for the explanation), asks the registry what each one means,
 * and asks `changeImpact()` for the aggregate — so the per-field flags and the total
 * cannot come from two different lists.
 *
 * ARC-110 reports impact. It does not act on it: deciding that a `requiresReactivation`
 * change stops a live module is ARC-120's lifecycle, and nothing here changes state.
 */

import { canonicalJson } from '../canonical-json.ts';
import { MODULES, latestSelectableModuleVersion } from '../registry/modules.ts';
import {
  changeImpact,
  editableFields,
  getField,
  tenantOwnedFields,
  type ConfigSchema,
} from '../registry/schemas.ts';

export interface FieldChange {
  /** a leaf path: `templates.first_response`, `business_hours.mon[0].open`. */
  path: string;
  /** the top-level field the registry describes it under. */
  field: string;
  known: boolean;
  /** present only when the field is safe to display; see `redacted`. */
  before?: unknown;
  after?: unknown;
  /** true when the registry marks the field `sensitiveDisplay` — values withheld. */
  redacted: boolean;
  requiresRetest: boolean;
  requiresShadow: boolean;
  requiresReactivation: boolean;
}

export interface ChangeImpactReport {
  schemaKey: string;
  schemaVersion: number;
  /** top-level fields with any change beneath them. */
  changedFields: string[];
  changes: FieldChange[];
  /** `changeImpact()`'s own answer for `changedFields`. */
  aggregate: {
    requiresRetest: boolean;
    requiresShadow: boolean;
    requiresReactivation: boolean;
    unknownFields: string[];
  };
  /** which fields each audience may change, from `editableFields()`. */
  editable: { operator: string[]; client: string[] };
  /** tenant scope only: the modules that compose a changed tenant-wide field. */
  affectedModules: { moduleKey: string; fields: string[] }[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every leaf path at which two documents differ.
 *
 * Arrays are compared element-wise, so a changed ZIP is `service_area.zips[2]` and a
 * list that grew or shrank reports the positions that differ. A value that changes type
 * (object to list, say) is reported at the path where the types part.
 */
export function diffPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    const out: string[] = [];
    for (let i = 0; i < length; i += 1) out.push(...diffPaths(before[i], after[i], `${prefix}[${i}]`));
    return out;
  }
  return [prefix];
}

const rootOf = (path: string) => path.split(/[.[]/)[0];

function valueAt(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (current === null || current === undefined) return undefined;
    current = /^\d+$/.test(part) && Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The fields at the top of a set of changed paths, in first-seen order. */
export function changedTopLevelFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set(diffPaths(before, after).map(rootOf))];
}

/** Modules whose effective configuration reads any of these tenant-wide fields. */
export function modulesReadingTenantFields(fields: readonly string[]): { moduleKey: string; fields: string[] }[] {
  const out: { moduleKey: string; fields: string[] }[] = [];
  for (const module of MODULES) {
    const version = latestSelectableModuleVersion(module.key);
    if (!version?.configSchemaKey) continue;
    const reads = tenantOwnedFields(version.configSchemaKey).filter((f) => fields.includes(f));
    if (reads.length > 0) out.push({ moduleKey: module.key, fields: reads });
  }
  return out;
}

/**
 * Explain a change from `before` to `after` under `schema`.
 *
 * Values are included for display only where the registry does not mark the field
 * `sensitiveDisplay` (staff mobile numbers, today). The audit copy (`auditSafeImpact`)
 * carries no values at all.
 */
export function analyseChange(
  schema: ConfigSchema,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangeImpactReport {
  const paths = diffPaths(before, after);
  const changes: FieldChange[] = paths.map((path) => {
    const field = rootOf(path);
    const meta = getField(schema.key, field);
    const redacted = meta ? meta.sensitiveDisplay : true;
    const one = changeImpact(schema.key, [field]);
    return {
      path,
      field,
      known: Boolean(meta),
      ...(redacted ? {} : { before: valueAt(before, path), after: valueAt(after, path) }),
      redacted,
      requiresRetest: one.requiresRetest,
      requiresShadow: one.requiresShadow,
      requiresReactivation: one.requiresReactivation,
    };
  });

  const changedFields = [...new Set(changes.map((c) => c.field))];
  const aggregate = changeImpact(schema.key, changedFields);

  return {
    schemaKey: schema.key,
    schemaVersion: schema.version,
    changedFields,
    changes,
    aggregate,
    editable: {
      operator: editableFields(schema.key, 'operator').map((f) => f.key),
      client: editableFields(schema.key, 'client').map((f) => f.key),
    },
    affectedModules: schema.scope === 'tenant' ? modulesReadingTenantFields(changedFields) : [],
  };
}

/**
 * The copy that goes into `admin_actions` and the version row: paths and flags only.
 *
 * A configuration may hold staff phone numbers and the operator's own wording; an audit
 * log readable by every operator is not where either should be repeated. Values are
 * dropped here unconditionally rather than by field, so a field later marked sensitive
 * cannot have been logged before the flag existed.
 */
export function auditSafeImpact(report: ChangeImpactReport): Record<string, unknown> {
  return {
    schema: `${report.schemaKey}@${report.schemaVersion}`,
    changed_fields: report.changedFields,
    changed_paths: report.changes.map((c) => c.path).slice(0, 100),
    requires_retest: report.aggregate.requiresRetest,
    requires_shadow: report.aggregate.requiresShadow,
    requires_reactivation: report.aggregate.requiresReactivation,
    unknown_fields: report.aggregate.unknownFields,
    affected_modules: report.affectedModules.map((m) => m.moduleKey),
  };
}
