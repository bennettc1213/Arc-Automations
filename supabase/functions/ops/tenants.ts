/**
 * The operator surface of ARC-300: creating a client, and what each module is doing for one.
 *
 * Behind the `ops` function's admin check like everything in this directory — the actor is
 * the verified token's user, never a field in the body — and `create_tenant()` checks it
 * against `arc_admins` again inside the transaction.
 *
 *   tenant-create    { tenant: {...}, modules: ["lead_recovery"], idempotency_key }
 *                    the tenant, each module selected (configuring, never active), the
 *                    `tenant_created` readiness step, the creation record and the audit
 *                    row — one transaction, 0021. A repeat of the key is the same answer.
 *                    422 with `field_errors` lists every problem with the form at once.
 *
 *   tenant-modules   { tenant_id }
 *                    every registered module: whether it can be selected and why not,
 *                    what it needs and which connectors could provide it, and for each
 *                    one selected or selectable, ARC-120's lifecycle status and readiness,
 *                    and whether its configuration scopes are published or drafted yet.
 *
 * Selecting or deselecting a module on an existing client is ARC-120's `module-select` /
 * `module-deselect`, unchanged; this file adds no second way to do either.
 */

import type { EngineStore } from '../_shared/engine/store.ts';
import { toLifecycle } from '../_shared/lifecycle/supabase-lifecycle-store.ts';
import type { CatalogEntry } from '../_shared/tenants/model.ts';
import {
  createTenant,
  type CreationRow,
  TENANT_ERROR_STATUS,
  type TenantErrorCode,
  tenantModuleOverview,
  type TenantStore,
} from '../_shared/tenants/service.ts';
import { lifecycleOut, statusOut } from './lifecycle.ts';
import { LIFECYCLE_ERROR_STATUS } from '../_shared/lifecycle/model.ts';

export const TENANT_ACTIONS = ['tenant-create', 'tenant-modules'];

export interface TenantActionContext {
  store: EngineStore;
  tenants: TenantStore;
  body: Record<string, unknown>;
  actorId: string | null;
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

function refused(code: string, message: string, fieldErrors?: { field: string; message: string }[]): ActionResponse {
  const status = TENANT_ERROR_STATUS[code as TenantErrorCode]
    ?? (LIFECYCLE_ERROR_STATUS as Record<string, number>)[code]
    ?? 409;
  return {
    status,
    body: { error: message, code, ...(fieldErrors ? { field_errors: fieldErrors.map((e) => ({ field: e.field, message: e.message })) } : {}) },
  };
}

export function creationOut(row: CreationRow | null) {
  if (!row) return null;
  return {
    tenant_id: row.tenantId,
    actor_user_id: row.actorUserId,
    slug: row.slug,
    modules: row.modules,
    created_at: row.createdAt,
  };
}

export function catalogOut(entry: CatalogEntry) {
  return {
    key: entry.key,
    name: entry.name,
    description: entry.description,
    status: entry.status,
    selectable: entry.selectable,
    problem: entry.problem,
    version: entry.version,
    execution_mode: entry.executionMode,
    activation_steps: entry.activationSteps,
    config_schema_key: entry.configSchemaKey,
    requirements: entry.requirements.map((r) => ({
      key: r.key,
      kind: r.kind,
      description: r.description,
      capabilities: r.capabilities.map((c) => ({
        key: c.key,
        description: c.description,
        external_side_effect: c.externalSideEffect,
        connectors: c.connectors,
      })),
    })),
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function handleTenantAction(action: string, context: TenantActionContext): Promise<ActionResponse> {
  const { body } = context;
  if (!context.actorId) return refused('unauthorized', 'not signed in');

  if (action === 'tenant-create') {
    const outcome = await createTenant(context.tenants, {
      actorId: context.actorId,
      tenant: body.tenant,
      modules: body.modules,
      idempotencyKey: body.idempotency_key,
    });
    if (!outcome.ok) return refused(outcome.code, outcome.message, outcome.fieldErrors);
    const { result } = outcome;
    return {
      status: result.replayed ? 200 : 201,
      body: {
        ok: true,
        replayed: result.replayed,
        tenant: result.tenant,
        creation: creationOut(result.creation),
        lifecycles: result.lifecycles.map((row) => lifecycleOut(toLifecycle(row))),
        /* written by create_tenant in the same transaction as the tenant. */
        logged: true,
      },
    };
  }

  if (action === 'tenant-modules') {
    const tenantId = text(body.tenant_id);
    if (!tenantId) return refused('invalid', 'tenant_id is required');
    const outcome = await tenantModuleOverview({ lifecycle: context.store, tenants: context.tenants }, tenantId);
    if (!outcome.ok) return refused(outcome.code, outcome.message);
    const { result } = outcome;
    return {
      status: 200,
      body: {
        ok: true,
        tenant_id: result.tenantId,
        creation: creationOut(result.creation),
        modules: result.modules.map((m) => ({
          ...catalogOut(m.catalog),
          lifecycle: m.status ? statusOut(m.status) : null,
          configuration: m.configuration.map((s) => ({
            scope: s.scope,
            schema_key: s.schemaKey,
            published: s.published,
            draft: s.draft,
          })),
        })),
      },
    };
  }

  return refused('invalid', `"${action}" is not a tenant action`);
}
