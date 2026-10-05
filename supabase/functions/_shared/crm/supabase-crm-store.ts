/**
 * ARC-340's store over Supabase. Every read carries `tenant_id` in its filter — the service
 * role bypasses RLS, so the tenant scope is here, in the one place a query is built.
 *
 * A refusal 0023 makes on purpose (`arc_crm:<code>: …`), and the constraint violations that
 * mean "that is not valid" rather than "the database is broken", become a `CrmStoreError`
 * the service turns into a status. Anything else is thrown as it is.
 *
 * Tested over real SQL in `tests/crm-db.test.js` (PGlite) — there is no in-memory twin to
 * drift from.
 */

import { CRM_ERROR_STATUS, type CrmErrorCode, type CrmStore, CrmStoreError, type CrmTable, type Row, type RowQuery } from './service.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any; auth?: any };
type DbError = { code?: string | null; message?: string; details?: string | null };

/** `arc_crm:<code>: …` → a CrmStoreError, or null for anything else. */
export function parseCrmStoreError(message: string | undefined): CrmStoreError | null {
  const match = /arc_crm:([a-z_]+): (.*)$/s.exec(message ?? '');
  if (!match) return null;
  const code = match[1] in CRM_ERROR_STATUS ? match[1] as CrmErrorCode : 'invalid';
  return new CrmStoreError(code, match[2]);
}

function fail(what: string, error: DbError): never {
  const refusal = parseCrmStoreError(error.message);
  if (refusal) throw refusal;
  const message = error.message ?? '';
  if (error.code === '23505') {
    if (/crm_external_mappings_one_per_external/.test(message)) throw new CrmStoreError('mapping_conflict', 'another record is already mapped to that external id');
    if (/crm_external_mappings_one_per_object/.test(message)) throw new CrmStoreError('mapping_conflict', 'this record is already mapped in that system — remove that mapping first');
    if (/_key_key|_tenant_id_key/.test(message)) throw new CrmStoreError('key_taken', 'that key is already in use for this client');
    if (/one_primary/.test(message)) throw new CrmStoreError('conflict', 'this client already has a primary location');
    if (/one_default/.test(message)) throw new CrmStoreError('conflict', 'this client already has a default pipeline');
    throw new CrmStoreError('conflict', 'that already exists for this client');
  }
  /* a reference to a row that is not this tenant's is a row that does not exist. */
  if (error.code === '23503') throw new CrmStoreError('not_found', 'that refers to something that does not exist for this client');
  if (error.code === '23514') throw new CrmStoreError('invalid', 'that value is not allowed for this field');
  throw new Error(`crm ${what}: ${message || 'unknown database error'}`);
}

export function supabaseCrmStore(db: Db): CrmStore {
  /* crm_source_policies and business_profiles have no id column; nothing reads them by one. */
  return {
    async getTenant(tenantId) {
      const { data, error } = await db.from('tenants').select('id, name, timezone, status').eq('id', tenantId).maybeSingle();
      if (error) fail('tenant lookup', error);
      return data ?? null;
    },

    async rows(table: CrmTable, tenantId: string, query: RowQuery = {}) {
      let q = db.from(table).select('*').eq('tenant_id', tenantId);
      for (const [column, value] of Object.entries(query.eq ?? {})) q = q.eq(column, value);
      for (const column of query.isNull ?? []) q = q.is(column, null);
      for (const column of query.notNull ?? []) q = q.not(column, 'is', null);
      if (query.in) q = q.in(query.in[0], query.in[1]);
      if (query.order) q = q.order(query.order[0], { ascending: query.order[1] === 'asc' });
      if (query.limit) q = q.limit(query.limit);
      const { data, error } = await q;
      if (error) fail(`read ${table}`, error);
      return data ?? [];
    },

    async row(table, tenantId, id) {
      const { data, error } = await db.from(table).select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
      if (error) fail(`read ${table}`, error);
      return data ?? null;
    },

    async insert(table, row) {
      const { data, error } = await db.from(table).insert(row).select('*').single();
      if (error) fail(`insert ${table}`, error);
      return data;
    },

    async update(table, tenantId, id, patch) {
      const { data, error } = await db.from(table).update(patch).eq('tenant_id', tenantId).eq('id', id).select('*').maybeSingle();
      if (error) fail(`update ${table}`, error);
      return data ?? null;
    },

    async upsert(table, row, conflict) {
      const { data, error } = await db.from(table).upsert(row, { onConflict: conflict }).select('*').single();
      if (error) fail(`save ${table}`, error);
      return data;
    },

    async ensureDefaultPipeline(tenantId) {
      const { data, error } = await db.rpc('crm_ensure_default_pipeline', { p_tenant: tenantId });
      if (error) fail('default pipeline', error);
      return data as string;
    },

    async createPipeline(tenantId, pipeline) {
      const { data, error } = await db.rpc('crm_create_pipeline', { p_tenant: tenantId, p_pipeline: pipeline });
      if (error) fail('create pipeline', error);
      return { pipeline: data.pipeline, stages: data.stages ?? [] };
    },

    async mergeContacts(request) {
      const { data, error } = await db.rpc('crm_merge_contacts', {
        p_tenant: request.tenantId,
        p_winner: request.winnerId,
        p_loser: request.loserId,
        p_actor_type: request.actorType,
        p_actor: request.actorId,
      });
      if (error) fail('merge contacts', error);
      return data as Row;
    },

    async suppressions(tenantId, addresses) {
      if (addresses.length === 0) return [];
      const { data, error } = await db.from('suppressions').select('*').eq('tenant_id', tenantId).in('address', addresses);
      if (error) fail('read suppressions', error);
      return data ?? [];
    },

    async people(tenantId, alsoNamed) {
      const { data, error } = await db.from('tenant_members').select('user_id, role').eq('tenant_id', tenantId);
      if (error) fail('read members', error);
      const roles = new Map<string, string | null>((data ?? []).map((m: Row) => [m.user_id as string, m.role as string]));
      const others = [...new Set(alsoNamed)].filter((id) => !roles.has(id));
      if (others.length > 0) {
        const { data: admins, error: adminError } = await db.from('arc_admins').select('user_id').in('user_id', others);
        if (adminError) fail('read operators', adminError);
        const operators = new Set((admins ?? []).map((a: Row) => a.user_id as string));
        /* named on a record but neither a member nor an operator: somebody since unlinked. */
        for (const id of others) roles.set(id, operators.has(id) ? 'operator' : 'former');
      }
      /* a sign-in address lives in auth, which only the admin API reads. without it (a test
         client) a person is still listed, by role. */
      const admin = db.auth?.admin;
      return await Promise.all([...roles].map(async ([userId, role]) => {
        let email: string | null = null;
        if (admin?.getUserById) {
          const { data: found } = await admin.getUserById(userId);
          email = found?.user?.email ?? null;
        }
        return { user_id: userId, email, role };
      }));
    },

    async recoveryStates(tenantId, ids) {
      if (ids.length === 0) return [];
      const { data, error } = await db.from('leads').select('id, status, safety_flags').eq('tenant_id', tenantId).in('id', ids);
      if (error) fail('read recovery leads', error);
      return data ?? [];
    },

    async saveStages(tenantId, pipelineId, stages, actorType, actorId) {
      const { data, error } = await db.rpc('crm_save_stages', {
        p_tenant: tenantId,
        p_pipeline: pipelineId,
        p_stages: stages,
        p_actor_type: actorType,
        p_actor: actorId,
      });
      if (error) fail('save stages', error);
      return data as Row;
    },
  };
}
