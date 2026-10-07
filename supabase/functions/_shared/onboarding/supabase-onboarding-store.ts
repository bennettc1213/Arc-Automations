/**
 * ARC-390's store over Supabase. Every read and every function call carries the tenant — the
 * service role bypasses RLS, so the scope is here.
 *
 * 0028's refusals (`arc_onboarding:<code>: …`) become an `OnboardingStoreError`. Applying a
 * change of authority writes 0023's own tables through their own guards, so a refusal of
 * theirs (`arc_crm:<code>: …`) can come back too, and is passed on under its own code.
 *
 * Tested over real SQL in `tests/onboarding-db.test.js` (PGlite) — there is no in-memory twin.
 */

import { type OnboardingStore, OnboardingStoreError } from './service.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };
type DbError = { code?: string | null; message?: string; details?: string | null };

/** `arc_onboarding:<code>: …` or `arc_crm:<code>: …` → an OnboardingStoreError, or null. */
export function parseOnboardingStoreError(message: string | undefined): OnboardingStoreError | null {
  const match = /arc_(?:onboarding|crm):([a-z_]+): (.*)$/s.exec(message ?? '');
  return match ? new OnboardingStoreError(match[1], match[2]) : null;
}

function fail(what: string, error: DbError): never {
  const refusal = parseOnboardingStoreError(error.message);
  if (refusal) throw refusal;
  /* a connector the registry table does not hold: 0023's foreign key, not a broken database. */
  if (error.code === '23503') throw new OnboardingStoreError('invalid', 'that names a system ARC has no connector entry for');
  throw new Error(`onboarding ${what}: ${error.message || 'unknown database error'}`);
}

export function supabaseOnboardingStore(db: Db): OnboardingStore {
  return {
    async get(tenantId) {
      const { data, error } = await db.from('tenant_onboarding').select('*').eq('tenant_id', tenantId).maybeSingle();
      if (error) fail('read', error);
      return data ?? null;
    },

    async facts(tenantId) {
      const { data, error } = await db.rpc('onboarding_facts', { p_tenant: tenantId });
      if (error) fail('facts', error);
      return data;
    },

    async pendingAuthority(tenantId) {
      const { data, error } = await db.rpc('onboarding_authority_pending', { p_tenant: tenantId });
      if (error) fail('pending authority', error);
      return data;
    },

    async save(request) {
      const { data, error } = await db.rpc('onboarding_save', {
        p_tenant: request.tenantId,
        p_actor: request.actorId,
        p_expected: request.expectedRevision,
        p_answers: request.answers ?? null,
        p_plan: request.plan ?? null,
      });
      if (error) fail('save', error);
      return data;
    },

    async applyAuthority(request) {
      const { data, error } = await db.rpc('onboarding_apply_authority', {
        p_tenant: request.tenantId,
        p_actor: request.actorId,
        p_digest: request.digest,
      });
      if (error) fail('apply authority', error);
      return data;
    },

    async record(request) {
      const { error } = await db.rpc('onboarding_record', { p_tenant: request.tenantId, p_actor: request.actorId, p_detail: request.detail });
      if (error) fail('record', error);
    },

    async events(tenantId, limit) {
      const { data, error } = await db.from('tenant_onboarding_events').select('*').eq('tenant_id', tenantId)
        .order('seq', { ascending: false }).limit(limit);
      if (error) fail('read history', error);
      return data ?? [];
    },
  };
}
