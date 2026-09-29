/**
 * ARC-300 — creating a tenant, and reading what it has been given.
 *
 * `createTenant` checks the request against `model.ts` (every problem at once), then makes
 * one call: `create_tenant()` in 0021, which writes the tenant, selects each module through
 * 0015's transition function, ticks the readiness step the creation itself proves, and
 * records who did it — in one transaction. The database checks the operator and the
 * registry again; this layer exists so the answer is a list of field errors rather than the
 * first exception.
 *
 * `tenantModuleOverview` is the read the console's module panel draws: every registered
 * module, and for each one that could be or has been selected, its lifecycle status and
 * readiness (ARC-120's own `getLifecycleStatus`, so the two screens cannot disagree) and
 * which configuration scopes it reads and whether they are published or drafted yet.
 */

import type { ConfigDraftRow, ConfigScope, ConfigVersionRow } from '../config/model.ts';
import { getLifecycleStatus, type LifecycleServiceStore, type LifecycleStatus } from '../lifecycle/engine.ts';
import { tenantSettingsSchema } from '../registry/schemas.ts';
import {
  type CatalogEntry,
  type FieldError,
  moduleCatalog,
  parseModuleSelection,
  parseTenantInput,
  type TenantInput,
} from './model.ts';

/* ── the store ──────────────────────────────────────────── */

export interface CreationRow {
  tenantId: string;
  actorUserId: string;
  idempotencyKey: string;
  slug: string;
  modules: string[];
  createdAt: string;
}

export interface CreatedTenant {
  replayed: boolean;
  // deno-lint-ignore no-explicit-any
  tenant: Record<string, any>;
  creation: CreationRow;
  // deno-lint-ignore no-explicit-any
  lifecycles: Record<string, any>[];
}

export interface CreateTenantRequest {
  actorId: string;
  tenant: TenantInput;
  modules: string[];
  idempotencyKey: string;
}

export interface TenantStore {
  createTenant(request: CreateTenantRequest): Promise<CreatedTenant>;
  getTenantCreation(tenantId: string): Promise<CreationRow | null>;
}

export const TENANT_ERROR_CODES = [
  'unauthorized', 'forbidden', 'invalid', 'module_not_found', 'module_unavailable',
  'connector_unsupported', 'slug_taken', 'client_id_taken', 'idempotency_conflict', 'not_found',
] as const;
export type TenantErrorCode = typeof TENANT_ERROR_CODES[number];

export const TENANT_ERROR_STATUS: Readonly<Record<TenantErrorCode, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  invalid: 422,
  module_not_found: 422,
  module_unavailable: 422,
  connector_unsupported: 422,
  slug_taken: 409,
  client_id_taken: 409,
  idempotency_conflict: 409,
  not_found: 404,
});

/** A refusal the database made on purpose, as opposed to a failure. */
export class TenantStoreError extends Error {
  readonly code: TenantErrorCode;
  constructor(code: TenantErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** `arc_tenant:<code>: …` → a TenantStoreError, or null for anything else. */
export function parseTenantStoreError(message: string | undefined): TenantStoreError | null {
  const match = /arc_tenant:([a-z_]+): (.*)$/s.exec(message ?? '');
  if (!match) return null;
  const code = (TENANT_ERROR_CODES as readonly string[]).includes(match[1]) ? match[1] as TenantErrorCode : 'invalid';
  return new TenantStoreError(code, match[2]);
}

/* ── creating ───────────────────────────────────────────── */

export type TenantOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; code: TenantErrorCode | string; message: string; fieldErrors?: FieldError[] };

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function createTenant(
  store: TenantStore,
  input: { actorId: string | null; tenant: unknown; modules: unknown; idempotencyKey: unknown },
): Promise<TenantOutcome<CreatedTenant>> {
  if (!input.actorId) return { ok: false, code: 'unauthorized', message: 'not signed in' };

  const tenant = parseTenantInput(input.tenant);
  const modules = parseModuleSelection(input.modules);
  const key = text(input.idempotencyKey);
  const fieldErrors: FieldError[] = [
    ...(tenant.ok ? [] : tenant.errors),
    ...(modules.ok ? [] : modules.errors),
    ...(key.length >= 8 && key.length <= 200 ? [] : [{ field: 'idempotency_key', message: 'an idempotency key of 8 to 200 characters is required' }]),
  ];
  if (!tenant.ok || !modules.ok || fieldErrors.length > 0) {
    /* a request whose only problem is a module that is not on offer says which refusal it
       is, so a caller can tell "fix the form" from "that module cannot be sold yet". */
    const moduleCodes = new Set(fieldErrors.map((e) => e.code ?? 'invalid'));
    return {
      ok: false,
      code: moduleCodes.size === 1 ? [...moduleCodes][0] : 'invalid',
      message: fieldErrors.map((e) => `${e.field}: ${e.message}`).join('; '),
      fieldErrors,
    };
  }

  try {
    const result = await store.createTenant({ actorId: input.actorId, tenant: tenant.value, modules: modules.value, idempotencyKey: key });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof TenantStoreError) {
      return { ok: false, code: error.code, message: error.message };
    }
    /* the selection inside create_tenant is 0015's transition function; its refusals keep
       their own prefix and are passed on as they are. */
    const lifecycle = /arc_lifecycle:([a-z_]+): (.*)$/s.exec((error as Error)?.message ?? '');
    if (lifecycle) return { ok: false, code: lifecycle[1], message: lifecycle[2] };
    throw error;
  }
}

/* ── reading ────────────────────────────────────────────── */

export interface ScopeState {
  scope: 'tenant' | 'module';
  schemaKey: string | null;
  published: { id: string; version: number } | null;
  draft: { id: string; revision: number } | null;
}

export interface ModuleOverview {
  catalog: CatalogEntry;
  /** null for a planned module nobody has ever selected — there is nothing to read. */
  status: LifecycleStatus | null;
  configuration: ScopeState[];
}

export interface TenantOverview {
  tenantId: string;
  creation: CreationRow | null;
  modules: ModuleOverview[];
}

type OverviewStore = LifecycleServiceStore & {
  getOpenDraft(tenantId: string, scope: ConfigScope): Promise<ConfigDraftRow | null>;
  getConfigHead(tenantId: string, scope: ConfigScope): Promise<ConfigVersionRow | null>;
};

async function scopeState(store: OverviewStore, tenantId: string, scope: ConfigScope, schemaKey: string | null): Promise<ScopeState> {
  const [head, draft] = await Promise.all([store.getConfigHead(tenantId, scope), store.getOpenDraft(tenantId, scope)]);
  return {
    scope: scope.kind,
    schemaKey,
    published: head ? { id: head.id, version: head.version } : null,
    draft: draft ? { id: draft.id, revision: draft.revision } : null,
  };
}

export async function tenantModuleOverview(
  stores: { lifecycle: OverviewStore; tenants: TenantStore },
  tenantId: string,
): Promise<TenantOutcome<TenantOverview>> {
  const tenant = await stores.lifecycle.getTenant(tenantId);
  if (!tenant) return { ok: false, code: 'not_found', message: 'this client does not exist' };

  const [creation, tenantScope] = await Promise.all([
    stores.tenants.getTenantCreation(tenantId),
    scopeState(stores.lifecycle, tenantId, { kind: 'tenant' }, tenantSettingsSchema().key),
  ]);

  const modules: ModuleOverview[] = [];
  for (const catalog of moduleCatalog()) {
    const lifecycle = await stores.lifecycle.getLifecycle(tenantId, catalog.key);
    /* a planned module has no version to evaluate readiness against; unless somebody
       selected it before it was withdrawn, there is nothing to show but the catalog. */
    const status = catalog.selectable || lifecycle
      ? await getLifecycleStatus(stores.lifecycle, tenantId, catalog.key, { historyLimit: 5 })
      : null;
    const configuration = catalog.configSchemaKey
      ? [tenantScope, await scopeState(stores.lifecycle, tenantId, { kind: 'module', moduleKey: catalog.key }, catalog.configSchemaKey)]
      : [];
    modules.push({ catalog, status, configuration });
  }
  return { ok: true, result: { tenantId, creation, modules } };
}
