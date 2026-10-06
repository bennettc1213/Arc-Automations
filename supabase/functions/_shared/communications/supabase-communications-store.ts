/**
 * ARC-370's store over Supabase. Every read carries `tenant_id` in its filter — the service
 * role bypasses RLS, so the tenant scope is here, in the one place a query is built — and
 * every write is one of 0026's functions, each a decision made under a lock.
 *
 * A refusal 0026 makes on purpose (`arc_crm:<code>: …`) becomes a `CrmStoreError` the service
 * turns into a status, exactly as ARC-340's store does. Anything else is thrown as it is.
 *
 * Tested over real SQL in `tests/communications-db.test.js` (PGlite) — there is no in-memory
 * twin to drift from.
 */

import { type CrmErrorCode, CrmStoreError, type Row, type RowQuery } from '../crm/service.ts';
import { parseCrmStoreError } from '../crm/supabase-crm-store.ts';
import type { BeginSend } from './runner.ts';
import type { ArrivalOutcome, CommunicationsStore, CommunicationTable, GateVerdict } from './service.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };
type DbError = { code?: string | null; message?: string; details?: string | null };

function fail(what: string, error: DbError): never {
  const refusal = parseCrmStoreError(error.message);
  if (refusal) throw refusal;
  const message = error.message ?? '';
  const refuse = (code: CrmErrorCode, text: string): never => { throw new CrmStoreError(code, text); };
  if (error.code === '23505') {
    if (/crm_snippets/.test(message)) refuse('key_taken', 'a canned reply with that key already exists');
    refuse('conflict', 'that already exists for this client');
  }
  /* a reference to a row that is not this tenant's is a row that does not exist. */
  if (error.code === '23503') refuse('not_found', 'that refers to something that does not exist for this client');
  if (error.code === '23514') refuse('invalid', 'that value is not allowed for this field');
  throw new Error(`communications ${what}: ${message || 'unknown database error'}`);
}

/** A single-row RPC result, whichever way the client shaped it. */
// deno-lint-ignore no-explicit-any
const first = (data: any) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

export function supabaseCommunicationsStore(db: Db): CommunicationsStore {
  async function rpc(what: string, name: string, args: Record<string, unknown>) {
    const { data, error } = await db.rpc(name, args);
    if (error) fail(what, error);
    return data;
  }

  return {
    async rows(table: CommunicationTable, tenantId: string, query: RowQuery = {}) {
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

    async gate(tenantId, channel, address, acknowledged) {
      const data = await rpc('gate', 'crm_message_gate', { p_tenant: tenantId, p_channel: channel, p_address: address, p_acknowledged: acknowledged });
      const row = first(data);
      return row?.code ? { code: row.code, detail: row.detail ?? '' } as GateVerdict : null;
    },

    async queueMessage(tenantId, message, actorType, actorId) {
      return first(await rpc('queue message', 'crm_queue_message', { p_tenant: tenantId, p_message: message, p_actor_type: actorType, p_actor: actorId }));
    },

    async arrival(tenantId, message) {
      return first(await rpc('message arrival', 'crm_message_arrival', { p_tenant: tenantId, p_message: message })) as ArrivalOutcome;
    },

    async delivery(tenantId, report) {
      return first(await rpc('delivery report', 'crm_message_delivery', { p_tenant: tenantId, p_report: report })) as Row;
    },

    async suppress(tenantId, request, actorType, actorId) {
      return first(await rpc('do not contact', 'crm_suppress_address', { p_tenant: tenantId, p_request: request, p_actor_type: actorType, p_actor: actorId })) as Row;
    },

    async updateConversation(tenantId, conversationId, change, actorType, actorId) {
      return first(await rpc('conversation update', 'crm_conversation_update', {
        p_tenant: tenantId, p_conversation: conversationId, p_change: change, p_actor_type: actorType, p_actor: actorId,
      })) as Row;
    },

    async cancelMessage(tenantId, messageId, actorType, actorId) {
      return first(await rpc('cancel message', 'crm_message_cancel', { p_tenant: tenantId, p_message: messageId, p_actor_type: actorType, p_actor: actorId })) as Row;
    },

    async reconciled(tenantId, messageId, resolution, actorId) {
      return first(await rpc('reconcile message', 'crm_message_reconciled', { p_tenant: tenantId, p_message: messageId, p_resolution: resolution, p_actor: actorId })) as Row;
    },

    async beginSend(tenantId, messageId, attemptId) {
      return first(await rpc('begin send', 'crm_message_begin_send', { p_tenant: tenantId, p_message: messageId, p_attempt: attemptId })) as BeginSend;
    },

    async finishSend(tenantId, messageId, outcome, detail) {
      return first(await rpc('finish send', 'crm_message_finish_send', {
        p_tenant: tenantId, p_message: messageId, p_outcome: outcome,
        p_external_id: detail.externalId ?? null, p_code: detail.code ?? null, p_detail: detail.message ?? null,
      }));
    },

    async saveSnippet(row) {
      const { data, error } = await db.from('crm_snippets').upsert(row, { onConflict: 'tenant_id,key' }).select('*').single();
      if (error) fail('save canned reply', error);
      return data;
    },

    async actions(tenantId, ids) {
      if (ids.length === 0) return [];
      const { data, error } = await db.from('scheduled_actions')
        .select('id, status, gate_code, gate_detail, last_error, attempts, max_attempts, run_at, completed_at')
        .eq('tenant_id', tenantId).in('id', ids);
      if (error) fail('read actions', error);
      return data ?? [];
    },

    /* metadata only. the credential is in Vault, which nothing here can name. */
    async connections(tenantId) {
      const { data, error } = await db.from('provider_connections')
        .select('id, connector_key, status, verified_capabilities')
        .eq('tenant_id', tenantId);
      if (error) fail('read connections', error);
      return data ?? [];
    },

    async consent(tenantId, channel, address) {
      const { data, error } = await db.from('crm_consent_records')
        .select('granted, captured_at, disclosure')
        .eq('tenant_id', tenantId).eq('channel', channel).eq('address', address)
        .order('captured_at', { ascending: false }).limit(1);
      if (error) fail('read consent', error);
      return data?.[0] ?? null;
    },

    async recoveryLeads(tenantId, phone) {
      const { data, error } = await db.from('leads')
        .select('id, status, safety_flags, consent_sms, is_canary, created_at')
        .eq('tenant_id', tenantId).eq('phone', phone);
      if (error) fail('read recovery leads', error);
      return (data ?? []).filter((lead: Row) => lead.is_canary !== true);
    },

    async recoveryMessages(tenantId, phone) {
      const leads = await this.recoveryLeads(tenantId, phone);
      if (leads.length === 0) return [];
      const conversations = await db.from('conversations').select('id').eq('tenant_id', tenantId).in('lead_id', leads.map((l: Row) => l.id));
      if (conversations.error) fail('read recovery conversations', conversations.error);
      const ids = (conversations.data ?? []).map((c: Row) => c.id);
      if (ids.length === 0) return [];
      const { data, error } = await db.from('messages')
        .select('id, direction, body, status, error_class, occurred_at')
        .eq('tenant_id', tenantId).in('conversation_id', ids)
        .order('occurred_at', { ascending: false }).limit(200);
      if (error) fail('read recovery messages', error);
      return (data ?? []).reverse();
    },
  };
}
