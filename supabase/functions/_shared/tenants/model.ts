/**
 * ARC-300 — what a new tenant is, and which modules one may be given.
 *
 * **Portal-safe.** The ops console imports this file to check the form as the operator
 * types and to draw the module picker; the `ops` function imports the same file and checks
 * again, and `create_tenant()` (0021) checks a third time inside the transaction. The
 * browser's copy is a convenience, never the decision.
 *
 * Module choice is read off the registry (`registry/modules.ts`) and nothing else: a key the
 * registry does not know, a `planned` reporting bucket, or a module whose blocking
 * requirements no connector ARC offers could meet is refused, with the reason. Choosing a
 * module selects it — `unselected → configuring` — and never activates it; activation is
 * ARC-120's gate and nothing here goes near it.
 */

import { getCapability } from '../registry/capabilities.ts';
import { connectorsProviding, getConnector } from '../registry/connectors.ts';
import {
  canonicalModuleKey,
  getModule,
  isSelectable,
  latestSelectableModuleVersion,
  modulesInPortalOrder,
} from '../registry/modules.ts';
import { unsupportedRequirements } from '../registry/resolve.ts';

/* ── the tenant ─────────────────────────────────────────── */

/** a new client starts in one of these; `archived` is reached only by deboarding. */
export const CREATION_STATUSES = ['onboarding', 'active', 'paused'] as const;
export type CreationStatus = typeof CREATION_STATUSES[number];

export const DEFAULT_TIMEZONE = 'America/Denver';
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CLIENT_ID_PATTERN = /^ARC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LIMITS = Object.freeze({ name: 120, slug: 64, short: 120, notes: 2000, modules: 10 });

/** the wire shape, snake_case as every ops request is. */
export interface TenantInput {
  name: string;
  slug: string;
  client_id: string | null;
  company: string | null;
  timezone: string;
  status: CreationStatus;
  plan: string | null;
  notes: string | null;
  login_email: string | null;
  contact_name: string | null;
  contact_phone: string | null;
}

export interface FieldError {
  field: string;
  message: string;
  /** set on a module refusal: module_not_found, module_unavailable or connector_unsupported. */
  code?: SelectionProblemCode;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const optional = (v: unknown) => str(v) || null;

/** whether the runtime knows this IANA zone. Deno, node and every browser answer the same. */
export function isTimezone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every problem with the form at once, keyed by field — never the first one only. */
export function parseTenantInput(raw: unknown): Parsed<TenantInput> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const errors: FieldError[] = [];
  const need = (field: string, message: string) => errors.push({ field, message });

  const name = str(source.name);
  if (!name) need('name', 'a business name is required');
  else if (name.length > LIMITS.name) need('name', `at most ${LIMITS.name} characters`);

  const slug = str(source.slug);
  if (!slug) need('slug', 'an account handle is required');
  else if (slug.length > LIMITS.slug || !SLUG_PATTERN.test(slug)) {
    need('slug', 'lowercase letters, digits and single dashes only, e.g. cascade-restoration');
  }

  const clientId = optional(source.client_id);
  if (clientId && !CLIENT_ID_PATTERN.test(clientId)) need('client_id', 'a client ID looks like ARC-4K7P-92QX');

  const timezone = str(source.timezone) || DEFAULT_TIMEZONE;
  if (!isTimezone(timezone)) need('timezone', `"${timezone}" is not a timezone`);

  const status = (str(source.status) || 'onboarding') as CreationStatus;
  if (!CREATION_STATUSES.includes(status)) need('status', `a new client is ${CREATION_STATUSES.join(', ')}`);

  const loginEmail = optional(source.login_email)?.toLowerCase() ?? null;
  if (loginEmail && !EMAIL_PATTERN.test(loginEmail)) need('login_email', 'not an email address');

  const shortFields = ['company', 'plan', 'contact_name', 'contact_phone'] as const;
  for (const field of shortFields) {
    if ((optional(source[field])?.length ?? 0) > LIMITS.short) need(field, `at most ${LIMITS.short} characters`);
  }
  const notes = optional(source.notes);
  if ((notes?.length ?? 0) > LIMITS.notes) need('notes', `at most ${LIMITS.notes} characters`);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      slug,
      client_id: clientId,
      company: optional(source.company),
      timezone,
      status,
      plan: optional(source.plan),
      notes,
      login_email: loginEmail,
      contact_name: optional(source.contact_name),
      contact_phone: optional(source.contact_phone),
    },
  };
}

/* ── the modules ────────────────────────────────────────── */

export type SelectionProblemCode = 'module_not_found' | 'module_unavailable' | 'connector_unsupported';

export interface SelectionProblem {
  code: SelectionProblemCode;
  message: string;
}

/**
 * Why this key cannot be given to a client, or null when it can.
 *
 * Canonical keys only. `lead_capture` is an alias the portal reads events by; a request to
 * *select* by it is refused with the key to use, so the audit record always names the
 * module the way the lifecycle does.
 */
export function moduleSelectionProblem(key: string): SelectionProblem | null {
  const module = getModule(key);
  if (!module) {
    const canonical = canonicalModuleKey(key);
    return {
      code: 'module_not_found',
      message: canonical ? `"${key}" is an alias — select ${canonical}` : `"${key}" is not a registered module`,
    };
  }
  if (!isSelectable(key)) {
    return { code: 'module_unavailable', message: `${module.displayName} is ${module.status} — it cannot be given to a client yet` };
  }
  const unsupported = unsupportedRequirements(latestSelectableModuleVersion(key)!);
  if (unsupported.length > 0) {
    return {
      code: 'connector_unsupported',
      message: `${module.displayName} needs what no connector ARC offers provides: ${unsupported.map((o) => o.explanation).join('; ')}`,
    };
  }
  return null;
}

/** A list of module keys, deduplicated and sorted, or every reason it is not one. */
export function parseModuleSelection(raw: unknown): Parsed<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) {
    return { ok: false, errors: [{ field: 'modules', message: 'modules is a list of module keys' }] };
  }
  const keys = [...new Set(raw.map((k: string) => k.trim()))].sort();
  if (keys.length > LIMITS.modules) return { ok: false, errors: [{ field: 'modules', message: `at most ${LIMITS.modules} modules` }] };
  const errors = keys.flatMap((key) => {
    const problem = moduleSelectionProblem(key);
    return problem ? [{ field: `modules.${key}`, message: problem.message, code: problem.code }] : [];
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: keys };
}

/* ── the catalog the picker draws ───────────────────────── */

export interface CatalogCapability {
  key: string;
  description: string;
  externalSideEffect: boolean;
  /** connector versions that could provide it, named for an operator. */
  connectors: { key: string; name: string; version: number; status: string }[];
}

export interface CatalogRequirement {
  key: string;
  kind: 'all_of' | 'any_of' | 'optional' | 'conditional';
  description: string;
  capabilities: CatalogCapability[];
}

export interface CatalogEntry {
  key: string;
  name: string;
  description: string;
  status: string;
  selectable: boolean;
  /** why it cannot be selected, when it cannot. */
  problem: SelectionProblem | null;
  version: number | null;
  executionMode: string | null;
  requirements: CatalogRequirement[];
  /** the onboarding steps this version's activation is gated on. */
  activationSteps: string[];
  configSchemaKey: string | null;
}

/**
 * Every registered module, in portal order, with what selecting it would need.
 *
 * Planned modules are listed rather than hidden: an operator deciding what to sell should
 * see what exists and why it is not on offer yet.
 */
export function moduleCatalog(): CatalogEntry[] {
  return modulesInPortalOrder().map((module) => {
    const version = latestSelectableModuleVersion(module.key);
    const problem = moduleSelectionProblem(module.key);
    return {
      key: module.key,
      name: module.displayName,
      description: module.description,
      status: module.status,
      selectable: problem === null,
      problem,
      version: version?.version ?? null,
      executionMode: version?.runtime.executionMode ?? null,
      requirements: (version?.requirements ?? []).map((requirement) => ({
        key: requirement.key,
        kind: requirement.kind,
        description: requirement.description,
        capabilities: requirement.capabilities.map((capability) => ({
          key: capability,
          description: getCapability(capability)?.description ?? capability,
          externalSideEffect: getCapability(capability)?.externalSideEffect ?? false,
          connectors: connectorsProviding(capability).map((c) => ({
            key: c.connectorKey,
            name: getConnector(c.connectorKey)?.displayName ?? c.connectorKey,
            version: c.version,
            status: c.status,
          })),
        })),
      })),
      activationSteps: [...(version?.safety.activationTestKeys ?? [])],
      configSchemaKey: version?.configSchemaKey ?? null,
    };
  });
}
