/**
 * ARC-380's store over Supabase. As in ARC-340's, every read carries `tenant_id` in its filter
 * — the service role bypasses RLS, so the tenant scope is here. The two exceptions are the
 * lookups a public request starts from, each by a value only that request can hold: a booking
 * page's public key, and the hash of a customer's own link.
 *
 * 0027's refusals (`arc_crm:<code>: …`) become a `CrmStoreError`, the same class and codes the
 * CRM service already turns into a status. Tested over real SQL in `tests/booking-db.test.js`
 * (PGlite).
 */

import { CrmStoreError, type Row } from '../crm/service.ts';
import { parseCrmStoreError } from '../crm/supabase-crm-store.ts';
import type { BookingRules } from './model.ts';
import type { BookingQuery, BookingStore, BookingTable, BookResult, ReportResult } from './service.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };
type DbError = { code?: string | null; message?: string; details?: string | null };

function fail(what: string, error: DbError): never {
  const refusal = parseCrmStoreError(error.message);
  if (refusal) throw refusal;
  const message = error.message ?? '';
  if (error.code === '23505') {
    if (/_key_key|_tenant_id_key/.test(message)) throw new CrmStoreError('key_taken', 'that key is already in use for this client');
    throw new CrmStoreError('conflict', 'that already exists for this client');
  }
  if (error.code === '23503') throw new CrmStoreError('not_found', 'that refers to something that does not exist for this client');
  if (error.code === '23514') throw new CrmStoreError('invalid', 'that value is not allowed for this field');
  throw new Error(`booking ${what}: ${message || 'unknown database error'}`);
}

export function supabaseBookingStore(db: Db): BookingStore {
  return {
    async rows(table: BookingTable, tenantId: string, query: BookingQuery = {}) {
      let q = db.from(table).select('*').eq('tenant_id', tenantId);
      for (const [column, value] of Object.entries(query.eq ?? {})) q = q.eq(column, value);
      for (const column of query.isNull ?? []) q = q.is(column, null);
      for (const column of query.notNull ?? []) q = q.not(column, 'is', null);
      if (query.in) q = q.in(query.in[0], query.in[1]);
      if (query.after) q = q.gt(query.after[0], query.after[1]);
      if (query.before) q = q.lt(query.before[0], query.before[1]);
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

    async saveSettings(tenantId, patch) {
      /* an update first: an upsert would write the defaults over what was not sent. */
      const { data: changed, error: updateError } = await db.from('crm_booking_settings').update(patch).eq('tenant_id', tenantId).select('*').maybeSingle();
      if (updateError) fail('save booking settings', updateError);
      if (changed) return changed;
      const { data, error } = await db.from('crm_booking_settings').insert({ tenant_id: tenantId, ...patch }).select('*').single();
      if (error) fail('save booking settings', error);
      return data;
    },

    async rules(tenantId) {
      const { data, error } = await db.rpc('crm_booking_rules', { p_tenant: tenantId });
      if (error) fail('booking rules', error);
      return (data as BookingRules | null) ?? null;
    },

    async pageByPublicKey(publicKey) {
      const { data, error } = await db.from('crm_booking_pages').select('*').eq('public_key', publicKey).maybeSingle();
      if (error) fail('booking page lookup', error);
      return data ?? null;
    },

    async linkByTokenHash(hash) {
      const { data, error } = await db.from('crm_appointment_links').select('*').eq('token_hash', hash).maybeSingle();
      if (error) fail('booking link lookup', error);
      return data ?? null;
    },

    async book(tenantId, booking) {
      const { data, error } = await db.rpc('crm_book_appointment', { p_tenant: tenantId, p_booking: booking });
      if (error) fail('book', error);
      return data as BookResult;
    },

    async change(tenantId, appointmentId, change, actorType, actorId) {
      const { data, error } = await db.rpc('crm_appointment_change', {
        p_tenant: tenantId, p_appointment: appointmentId, p_change: change, p_actor_type: actorType, p_actor: actorId,
      });
      if (error) fail('change appointment', error);
      return data as Row;
    },

    async externalReport(tenantId, report) {
      const { data, error } = await db.rpc('crm_appointment_external_report', { p_tenant: tenantId, p_report: report });
      if (error) fail('calendar report', error);
      return data as ReportResult;
    },

    async reconcile(tenantId, appointmentId, resolution, actorType, actorId) {
      const { data, error } = await db.rpc('crm_appointment_reconcile', {
        p_tenant: tenantId, p_appointment: appointmentId, p_resolution: resolution, p_actor_type: actorType, p_actor: actorId,
      });
      if (error) fail('reconcile appointment', error);
      return data as Row;
    },
  };
}
