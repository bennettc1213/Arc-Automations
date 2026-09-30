/**
 * ARC-310 — what the settings screen needs from the configuration engine, and nothing it
 * decides.
 *
 * Three read-only projections over what ARC-110 and ARC-120 already own:
 *
 *   schemaProjection   the registry's field metadata for one scope, as the screen draws it:
 *                      which fields this scope stores, which the operator may write, which
 *                      it only shows because another scope stores them. Never a validator,
 *                      never a default value — the server validates, always.
 *   compareDocuments   ARC-110's own `analyseChange` between any two documents, so a version
 *                      comparison redacts exactly what a publish preview redacts.
 *   lifecycleEffect    what ARC-120 will make of a change for each module it reaches, from
 *                      the same classification the publication is judged by
 *                      (`classifyRecordedImpact` over `auditSafeImpact`) and the module's
 *                      state now. A forecast in words; the publication decides.
 */

import { writableFields } from './engine.ts';
import { analyseChange, auditSafeImpact, type ChangeImpactReport } from './impact.ts';
import type { ConfigActor, ConfigScope } from './model.ts';
import { classifyRecordedImpact, combineConsequences } from '../lifecycle/policy.ts';
import { type FieldLayout, fieldLayout } from '../registry/layouts.ts';
import { getModule } from '../registry/modules.ts';
import type { ConfigSchema } from '../registry/schemas.ts';

export interface FieldProjection {
  key: string;
  type: string;
  label: string;
  help: string;
  required: boolean;
  control: string;
  /** the operator may change it in this scope. */
  editable: boolean;
  protected: boolean;
  sensitive_display: boolean;
  requires_retest: boolean;
  requires_shadow: boolean;
  requires_reactivation: boolean;
  visible_when: { field: string; equals: unknown } | null;
  deprecated: boolean;
  /** how to draw its parts or items (`registry/layouts.ts`); null draws a JSON box. */
  layout: FieldLayout | null;
}

export interface SchemaProjection {
  key: string;
  version: number;
  display_name: string;
  scope: 'tenant' | 'module';
  fields: FieldProjection[];
  /** module scope: the fields it reads from the client settings, which are edited there. */
  from_tenant: { key: string; label: string }[];
}

export function schemaProjection(schema: ConfigSchema, actor: ConfigActor): SchemaProjection {
  const writable = new Set(writableFields(schema, actor));
  return {
    key: schema.key,
    version: schema.version,
    display_name: schema.displayName,
    scope: schema.scope,
    fields: schema.fields
      .filter((f) => f.ownerScope === undefined)
      .map((f) => ({
        key: f.key,
        type: f.type,
        label: f.label,
        help: f.help,
        required: f.required,
        control: f.control,
        editable: writable.has(f.key),
        protected: f.protected,
        sensitive_display: f.sensitiveDisplay,
        requires_retest: f.requiresRetest,
        requires_shadow: f.requiresShadow,
        requires_reactivation: f.requiresReactivation,
        visible_when: f.visibleWhen ?? null,
        deprecated: f.deprecated === true,
        layout: fieldLayout(schema.key, f.key),
      })),
    from_tenant: schema.fields.filter((f) => f.ownerScope === 'tenant').map((f) => ({ key: f.key, label: f.label })),
  };
}

export function compareDocuments(
  schema: ConfigSchema,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangeImpactReport {
  return analyseChange(schema, before, after);
}

export interface ModuleEffect {
  module_key: string;
  module_name: string;
  state: string;
  requires: string[];
  /** true when nothing about the module changes. */
  none: boolean;
  headline: string;
}

/**
 * For each module the change reaches: what its lifecycle is expected to do.
 *
 * `lifecycles` is every lifecycle row of the tenant (state per module). A module scope
 * reaches only its own module; a tenant scope reaches the modules that read a changed
 * field, and those only if they have a lifecycle at all.
 */
export function lifecycleEffect(
  report: ChangeImpactReport,
  scope: ConfigScope,
  lifecycles: readonly { moduleKey: string; state: string }[],
): ModuleEffect[] {
  if (report.changedFields.length === 0) return [];
  const recorded = auditSafeImpact(report);
  const reached = scope.kind === 'module'
    ? lifecycles.filter((l) => l.moduleKey === scope.moduleKey)
    : lifecycles.filter((l) => report.affectedModules.some((m) => m.moduleKey === l.moduleKey));

  return reached.map((lifecycle) => {
    const consequence = combineConsequences(
      classifyRecordedImpact(recorded, { scope: scope.kind, moduleKey: lifecycle.moduleKey }),
    );
    const requires = [...consequence.requires];
    const needs = requires.join(', ');
    const name = getModule(lifecycle.moduleKey)?.displayName ?? lifecycle.moduleKey;
    const none = consequence.authorizationCarriesForward;
    let headline: string;
    switch (lifecycle.state) {
      case 'active':
        headline = none
          ? 'stays live — nothing further is needed'
          : consequence.mayRemainActive
            ? 'stays active, but new leads are held until a test passes on the new version; ones already in progress keep their approved wording'
            : `is paused: it needs ${needs} before it goes live again`;
        break;
      case 'paused':
        headline = none ? 'stays paused, with nothing new needed to resume' : `stays paused, and resuming will also need ${needs}`;
        break;
      case 'testing':
      case 'shadow':
        headline = none ? 'no effect on its testing' : 'its test results were for the previous version — it must be tested again';
        break;
      default:
        headline = 'not live, so nothing running changes';
    }
    return { module_key: lifecycle.moduleKey, module_name: name, state: lifecycle.state, requires, none, headline };
  });
}
