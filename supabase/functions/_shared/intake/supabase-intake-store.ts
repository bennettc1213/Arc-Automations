/**
 * ARC-350's store over Supabase. As in ARC-340's, every read carries `tenant_id` in its
 * filter — the service role bypasses RLS, so the tenant scope is here. The two exceptions are
 * the lookups a public request starts from, each by a value only that request can hold: a
 * form's public key, and the hash of an endpoint's token.
 *
 * 0024's refusals (`arc_crm:<code>: …`) become a `CrmStoreError`, the same class and codes
 * the CRM service already turns into a status. Tested over real SQL in
 * `tests/intake-db.test.js` (PGlite).
 */

import { CrmStoreError, type Row, type RowQuery } from '../crm/service.ts';
import { parseCrmStoreError } from '../crm/supabase-crm-store.ts';
import type { ArrivalResult, IntakeStore, IntakeTable } from './service.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };
type DbError = { code?: string | null; message?: string; details?: string | null };

function fail(what: string, error: DbError): never {
  const refusal = parseCrmStoreError(error.message);
  if (refusal) throw refusal;
  if (error.code === '23505') throw new CrmStoreError('conflict', 'that already exists for this client');
  if (error.code === '23503') throw new CrmStoreError('not_found', 'that refers to something that does not exist for this client');
  if (error.code === '23514') throw new CrmStoreError('invalid', 'that value is not allowed for this field');
  throw new Error(`intake ${what}: ${error.message || 'unknown database error'}`);
}

export function supabaseIntakeStore(db: Db): IntakeStore {
  return {
    async rows(table: IntakeTable | 'crm_source_events', tenantId: string, query: RowQuery = {}) {
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

    async insertMany(table, rows) {
      if (rows.length === 0) return;
      const { error } = await db.from(table).insert(rows);
      if (error) fail(`insert ${table}`, error);
    },

    async update(table, tenantId, id, patch) {
      const { data, error } = await db.from(table).update(patch).eq('tenant_id', tenantId).eq('id', id).select('*').maybeSingle();
      if (error) fail(`update ${table}`, error);
      return data ?? null;
    },

    async formByPublicKey(publicKey) {
      const { data, error } = await db.from('crm_intake_forms').select('*').eq('public_key', publicKey).maybeSingle();
      if (error) fail('form lookup', error);
      return data ?? null;
    },

    async endpointByTokenHash(hash) {
      const { data, error } = await db.from('crm_intake_endpoints').select('*').eq('token_hash', hash).maybeSingle();
      if (error) fail('endpoint lookup', error);
      return data ?? null;
    },

    async arrival(tenantId, arrival) {
      const { data, error } = await db.rpc('crm_intake_arrival', { p_tenant: tenantId, p_arrival: arrival });
      if (error) fail('arrival', error);
      return data as ArrivalResult;
    },

    async annotateImport(tenantId, importId) {
      const { error } = await db.rpc('crm_import_annotate', { p_tenant: tenantId, p_import: importId });
      if (error) fail('annotate import', error);
    },

    async importSummary(tenantId, importId) {
      const { data, error } = await db.rpc('crm_import_summary', { p_tenant: tenantId, p_import: importId });
      if (error) fail('import summary', error);
      return { by_status: (data as Row)?.by_status ?? {}, by_match: (data as Row)?.by_match ?? {} };
    },

    async commitImport(request) {
      const { data, error } = await db.rpc('crm_import_commit', {
        p_tenant: request.tenantId,
        p_import: request.importId,
        p_actor_type: request.actorType,
        p_actor: request.actorId,
        p_limit: request.limit,
      });
      if (error) fail('commit import', error);
      return data as { processed: number; remaining: number; status: string };
    },
  };
}
