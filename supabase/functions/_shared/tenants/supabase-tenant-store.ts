/**
 * ARC-300's store over Supabase: one RPC to create, one select to read the record.
 *
 * Tested over real SQL in `tests/tenant-creation-db.test.js` (PGlite), where the payload
 * sent is exactly the payload 0021 receives — there is no in-memory twin to drift from.
 */

import { type CreatedTenant, type CreationRow, parseTenantStoreError, TenantStoreError, type TenantStore } from './service.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

// deno-lint-ignore no-explicit-any
export const toCreation = (row: any): CreationRow => ({
  tenantId: row.tenant_id,
  actorUserId: row.actor_user_id,
  idempotencyKey: row.idempotency_key,
  slug: row.slug,
  modules: [...(row.modules ?? [])],
  createdAt: row.created_at,
});

export function supabaseTenantStore(db: Db): TenantStore {
  return {
    async createTenant(request): Promise<CreatedTenant> {
      const { data, error } = await db.rpc('create_tenant', {
        p_actor: request.actorId,
        p_tenant: request.tenant,
        p_modules: request.modules,
        p_idempotency_key: request.idempotencyKey,
      });
      if (error) {
        const refusal = parseTenantStoreError(error.message);
        if (refusal) throw refusal;
        throw new Error(`create tenant: ${error.message ?? 'unknown database error'}`);
      }
      if (!data || typeof data !== 'object' || !data.tenant || !data.creation) {
        throw new Error('create tenant: the database returned no tenant');
      }
      return {
        replayed: data.replayed === true,
        tenant: data.tenant,
        creation: toCreation(data.creation),
        lifecycles: Array.isArray(data.lifecycles) ? data.lifecycles : [],
      };
    },

    async purgeTestTenant(request) {
      const { data, error } = await db.rpc('purge_test_tenant', {
        p_actor: request.actorId,
        p_tenant: request.tenantId,
        p_confirm_slug: request.confirmSlug,
      });
      if (error) {
        const refusal = parseTenantStoreError(error.message);
        if (refusal) throw refusal;
        /* a malformed id is a client that does not exist, not a server failure. */
        if (/invalid input syntax for type uuid/.test(error.message ?? '')) throw new TenantStoreError('not_found', 'this client does not exist');
        throw new Error(`purge tenant: ${error.message ?? 'unknown database error'}`);
      }
      if (!data || typeof data !== 'object' || !data.tenant_id) throw new Error('purge tenant: the database returned no record');
      return {
        tenantId: data.tenant_id,
        actorUserId: data.actor_user_id,
        name: data.name,
        slug: data.slug,
        clientId: data.client_id ?? null,
        purgedAt: data.purged_at,
      };
    },

    async getTenantCreation(tenantId) {
      const { data, error } = await db.from('tenant_creations').select('*').eq('tenant_id', tenantId).maybeSingle();
      if (error) {
        /* before 0021 there is no record to read, and a tenant created the old way never has one. */
        if (/tenant_creations/.test(error.message ?? '') && /does not exist/.test(error.message ?? '')) return null;
        throw new Error(`tenant creation: ${error.message}`);
      }
      return data ? toCreation(data) : null;
    },
  };
}
