/**
 * The Postgres half of the engine's storage seam.
 *
 * Every method here is the direct counterpart of one in `MemoryStore`, and the two are
 * meant to be read side by side. Where the memory store *asserts* a constraint in
 * JavaScript, this one *relies* on the schema enforcing it — `insertMessage` does not check
 * for a duplicate provider id, it attempts the insert and reads the unique-violation back,
 * because a check-then-insert has a race in it and a unique index does not.
 *
 * Deliberately untyped against `@supabase/supabase-js`: it takes a structural interface, so
 * this file carries no `jsr:` import and the test runner can load it. What it cannot do
 * without a database is run, which is correct — the behaviour worth testing lives in the
 * engine, and the behaviour worth testing *here* is the schema's, which is tested by
 * applying the migration.
 */

import { supabaseEventSink, writeEvents, type EventSink } from './event-writer.ts';
import { validateEvent } from './event-validation.ts';
import type {
  ActionLease,
  ActionRow,
  ActionType,
  ConfigSnapshotRow,
  ConversationRow,
  EffectAttemptRow,
  EffectState,
  EngineStore,
  HandoffRow,
  IntakeKeyRow,
  LeadRow,
  MessageRow,
  ReserveEffectInput,
  ReserveEffectResult,
  RunRow,
  StoreResult,
  SuppressionRow,
  TenantConfigRow,
  TenantRow,
} from './engine/store.ts';
import { storeFail, storeOk } from './engine/store.ts';

/* the shape of the client this needs. `any` on the builder because PostgREST's fluent
   builder is not worth restating, and every call below is one line. */
// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(name: string, args?: Record<string, unknown>): any };

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === UNIQUE_VIOLATION;
}

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? 'unknown database error'}`);
}

/* ── row mappers ────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const toConfig = (row: any): TenantConfigRow => ({
  tenantId: row.tenant_id,
  moduleKey: row.module_key,
  enabled: row.enabled,
  schemaVersion: row.schema_version,
  configVersion: row.config_version,
  config: row.config ?? {},
});

// deno-lint-ignore no-explicit-any
const toLead = (row: any): LeadRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  correlationId: row.correlation_id,
  source: row.source,
  intakeRef: row.intake_ref ?? null,
  customerName: row.customer_name ?? null,
  phone: row.phone ?? null,
  email: row.email ?? null,
  serviceRequest: row.service_request ?? null,
  locationZip: row.location_zip ?? null,
  locationText: row.location_text ?? null,
  urgency: row.urgency ?? null,
  safetyFlags: row.safety_flags ?? [],
  aiSummary: row.ai_summary ?? null,
  status: row.status,
  consentSms: row.consent_sms ?? false,
  consentSource: row.consent_source ?? null,
  consentAt: row.consent_at ?? null,
  assignedTo: row.assigned_to ?? null,
  bookingOutcome: row.booking_outcome ?? null,
  bookedAt: row.booked_at ?? null,
  isCanary: row.is_canary ?? false,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const leadPatch = (patch: Partial<LeadRow>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (patch.customerName !== undefined) out.customer_name = patch.customerName;
  if (patch.phone !== undefined) out.phone = patch.phone;
  if (patch.email !== undefined) out.email = patch.email;
  if (patch.serviceRequest !== undefined) out.service_request = patch.serviceRequest;
  if (patch.locationZip !== undefined) out.location_zip = patch.locationZip;
  if (patch.locationText !== undefined) out.location_text = patch.locationText;
  if (patch.urgency !== undefined) out.urgency = patch.urgency;
  if (patch.safetyFlags !== undefined) out.safety_flags = patch.safetyFlags;
  if (patch.aiSummary !== undefined) out.ai_summary = patch.aiSummary;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.consentSms !== undefined) out.consent_sms = patch.consentSms;
  if (patch.assignedTo !== undefined) out.assigned_to = patch.assignedTo;
  if (patch.bookingOutcome !== undefined) out.booking_outcome = patch.bookingOutcome;
  if (patch.bookedAt !== undefined) out.booked_at = patch.bookedAt;
  out.updated_at = new Date().toISOString();
  return out;
};

// deno-lint-ignore no-explicit-any
const toConversation = (row: any): ConversationRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  leadId: row.lead_id,
  channel: row.channel,
  status: row.status,
  providerRef: row.provider_ref ?? null,
  lastInboundAt: row.last_inbound_at ?? null,
  lastOutboundAt: row.last_outbound_at ?? null,
});

// deno-lint-ignore no-explicit-any
const toMessage = (row: any): MessageRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  conversationId: row.conversation_id,
  direction: row.direction,
  providerMessageId: row.provider_message_id ?? null,
  body: row.body ?? null,
  status: row.status,
  errorClass: row.error_class ?? null,
  errorDetail: row.error_detail ?? null,
  occurredAt: row.occurred_at,
});

// deno-lint-ignore no-explicit-any
const toRun = (row: any): RunRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  leadId: row.lead_id,
  moduleKey: row.module_key,
  state: row.state,
  configVersion: row.config_version,
  configSnapshotId: row.config_snapshot_id ?? null,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  stoppedAt: row.stopped_at ?? null,
  completedAt: row.completed_at ?? null,
  stopReason: row.stop_reason ?? null,
  lastError: row.last_error ?? null,
});

// deno-lint-ignore no-explicit-any
const toAction = (row: any): ActionRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  runId: row.run_id,
  actionType: row.action_type,
  runAt: row.run_at,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  lockedAt: row.locked_at ?? null,
  lockedBy: row.locked_by ?? null,
  leaseToken: row.lease_token ?? null,
  fence: row.fence ?? 0,
  configSnapshotId: row.config_snapshot_id ?? null,
  lastError: row.last_error ?? null,
  payload: row.payload ?? {},
  completedAt: row.completed_at ?? null,
});

// deno-lint-ignore no-explicit-any
const toSnapshot = (row: any): ConfigSnapshotRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  moduleKey: row.module_key,
  configVersion: row.config_version,
  schemaVersion: row.schema_version,
  config: row.config ?? {},
  configHash: row.config_hash,
  createdAt: row.created_at,
});

// deno-lint-ignore no-explicit-any
const toEffect = (row: any): EffectAttemptRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  runId: row.run_id ?? null,
  leadId: row.lead_id ?? null,
  actionId: row.action_id ?? null,
  conversationId: row.conversation_id ?? null,
  effectType: row.effect_type,
  effectKey: row.effect_key,
  idempotencyKey: row.idempotency_key,
  worker: row.worker ?? null,
  leaseToken: row.lease_token ?? null,
  fence: row.fence ?? 0,
  attemptNo: row.attempt_no ?? 1,
  provider: row.provider ?? 'twilio',
  destinationRef: row.destination_ref ?? null,
  state: row.state,
  providerMessageId: row.provider_message_id ?? null,
  errorCategory: row.error_category ?? null,
  errorDetail: row.error_detail ?? null,
  retryable: row.retryable ?? null,
  isCanary: row.is_canary === true,
  reservedAt: row.reserved_at,
  dispatchStartedAt: row.dispatch_started_at ?? null,
  acceptedAt: row.accepted_at ?? null,
  completedAt: row.completed_at ?? null,
});

// deno-lint-ignore no-explicit-any
const toHandoff = (row: any): HandoffRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  leadId: row.lead_id,
  runId: row.run_id ?? null,
  reason: row.reason,
  reasonCode: row.reason_code,
  isSafety: row.is_safety ?? false,
  assignedTo: row.assigned_to ?? null,
  status: row.status,
  resolution: row.resolution ?? null,
  openedAt: row.opened_at,
  resolvedAt: row.resolved_at ?? null,
});

const LEAD_COLUMNS =
  'id, tenant_id, correlation_id, source, intake_ref, customer_name, phone, email, service_request, location_zip, location_text, urgency, safety_flags, ai_summary, status, consent_sms, consent_source, consent_at, assigned_to, booking_outcome, booked_at, is_canary, created_at, updated_at';

/* ── the store ──────────────────────────────────────────── */

export function supabaseStore(db: Db): EngineStore {
  const sink: EventSink = supabaseEventSink(db as never);

  return {
    async getConfig(tenantId, moduleKey = 'lead_recovery') {
      const { data, error } = await db
        .from('module_configs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('module_key', moduleKey)
        .maybeSingle();
      if (error) fail('module_configs read', error);
      return data ? toConfig(data) : null;
    },

    /**
     * Resolve a Twilio number to a tenant.
     *
     * The only routing rule in the module, and it is a JSON containment query rather than a
     * column because the number lives in the validated config blob. Indexed adequately by
     * the tenant count: a book of a few hundred contractors is a sequential scan of a few
     * hundred small rows, and the alternative — denormalising the number into a column —
     * would be a second source of truth for which number belongs to whom.
     */
    async findTenantByTwilioNumber(phone) {
      const { data, error } = await db
        .from('module_configs')
        .select('*')
        .eq('module_key', 'lead_recovery')
        .contains('config', { twilio: { phone_number: phone } })
        .limit(2);
      if (error) fail('tenant lookup by number', error);
      const rows = data ?? [];
      /* two tenants claiming one number is a misconfiguration that must not be resolved by
         picking the first: it would route one company's calls to another. */
      if (rows.length > 1) throw new Error(`${phone} is claimed by more than one tenant — refusing to guess`);
      return rows.length === 1 ? toConfig(rows[0]) : null;
    },

    async findIntakeKey(publicKey) {
      const { data, error } = await db
        .from('intake_keys')
        .select('id, tenant_id, public_key, allowed_origins, revoked_at')
        .eq('public_key', publicKey)
        .is('revoked_at', null)
        .maybeSingle();
      if (error) fail('intake key lookup', error);
      if (!data) return null;
      const row: IntakeKeyRow = {
        id: data.id,
        tenantId: data.tenant_id,
        publicKey: data.public_key,
        allowedOrigins: data.allowed_origins ?? [],
        revokedAt: data.revoked_at ?? null,
      };
      return row;
    },

    async touchIntakeKey(id) {
      await db.from('intake_keys').update({ last_used_at: new Date().toISOString() }).eq('id', id);
    },

    async getLead(tenantId, leadId) {
      const { data, error } = await db
        .from('leads')
        .select(LEAD_COLUMNS)
        .eq('tenant_id', tenantId)
        .eq('id', leadId)
        .maybeSingle();
      if (error) fail('lead read', error);
      return data ? toLead(data) : null;
    },

    async getLeadByCorrelation(tenantId, correlationId) {
      const { data, error } = await db
        .from('leads')
        .select(LEAD_COLUMNS)
        .eq('tenant_id', tenantId)
        .eq('correlation_id', correlationId)
        .maybeSingle();
      if (error) fail('lead read by correlation', error);
      return data ? toLead(data) : null;
    },

    async findOpenLeadByPhone(tenantId, phone) {
      const { data, error } = await db
        .from('leads')
        .select(LEAD_COLUMNS)
        .eq('tenant_id', tenantId)
        .eq('phone', phone)
        .not('status', 'in', '("closed","suppressed")')
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) fail('open lead lookup', error);
      return data?.length ? toLead(data[0]) : null;
    },

    async createLead(row) {
      const { data, error } = await db
        .from('leads')
        .insert({
          id: row.id,
          tenant_id: row.tenantId,
          correlation_id: row.correlationId,
          source: row.source,
          intake_ref: row.intakeRef,
          customer_name: row.customerName,
          phone: row.phone,
          email: row.email,
          service_request: row.serviceRequest,
          location_zip: row.locationZip,
          location_text: row.locationText,
          urgency: row.urgency,
          safety_flags: row.safetyFlags,
          ai_summary: row.aiSummary,
          status: row.status,
          consent_sms: row.consentSms,
          consent_source: row.consentSource,
          consent_at: row.consentAt,
          assigned_to: row.assignedTo,
          booking_outcome: row.bookingOutcome,
          booked_at: row.bookedAt,
          is_canary: row.isCanary,
        })
        .select(LEAD_COLUMNS)
        .single();
      if (error) fail('lead insert', error);
      return toLead(data);
    },

    async updateLead(tenantId, leadId, patch) {
      const { data, error } = await db
        .from('leads')
        .update(leadPatch(patch))
        .eq('tenant_id', tenantId)
        .eq('id', leadId)
        .select(LEAD_COLUMNS)
        .single();
      if (error) fail('lead update', error);
      return toLead(data);
    },

    async getOrCreateConversation(tenantId, leadId, channel = 'sms') {
      const existing = await db
        .from('conversations')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('lead_id', leadId)
        .eq('channel', channel)
        .maybeSingle();
      if (existing.error) fail('conversation read', existing.error);
      if (existing.data) return toConversation(existing.data);

      const { data, error } = await db
        .from('conversations')
        .insert({ tenant_id: tenantId, lead_id: leadId, channel })
        .select('*')
        .single();

      /* two webhooks for the same lead can land in the same second. the unique index is
         what decides; losing the race is normal and means the row now exists. */
      if (error) {
        if (!isUniqueViolation(error)) fail('conversation insert', error);
        const retry = await db
          .from('conversations')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('lead_id', leadId)
          .eq('channel', channel)
          .single();
        if (retry.error) fail('conversation re-read', retry.error);
        return toConversation(retry.data);
      }
      return toConversation(data);
    },

    async getConversation(tenantId, conversationId) {
      const { data, error } = await db
        .from('conversations')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('id', conversationId)
        .maybeSingle();
      if (error) fail('conversation read', error);
      return data ? toConversation(data) : null;
    },

    async insertMessage(row) {
      const { data, error } = await db
        .from('messages')
        .insert({
          tenant_id: row.tenantId,
          conversation_id: row.conversationId,
          direction: row.direction,
          provider_message_id: row.providerMessageId,
          body: row.body,
          status: row.status,
          error_class: row.errorClass,
          error_detail: row.errorDetail,
          occurred_at: row.occurredAt,
        })
        .select('*')
        .single();

      /* the idempotency point. attempted rather than checked first, because the check and
         the insert are two statements and Twilio redelivers fast enough to sit between
         them. */
      if (error) {
        if (!isUniqueViolation(error) || !row.providerMessageId) fail('message insert', error);
        const existing = await db
          .from('messages')
          .select('*')
          .eq('tenant_id', row.tenantId)
          .eq('provider_message_id', row.providerMessageId)
          .single();
        if (existing.error) fail('message re-read', existing.error);
        return { message: toMessage(existing.data), created: false };
      }

      await db
        .from('conversations')
        .update({
          [row.direction === 'inbound' ? 'last_inbound_at' : 'last_outbound_at']: row.occurredAt,
          updated_at: new Date().toISOString(),
        })
        .eq('tenant_id', row.tenantId)
        .eq('id', row.conversationId);

      return { message: toMessage(data), created: true };
    },

    async updateMessageByProviderId(tenantId, providerMessageId, patch) {
      const update: Record<string, unknown> = {};
      if (patch.status !== undefined) update.status = patch.status;
      if (patch.errorClass !== undefined) update.error_class = patch.errorClass;
      if (patch.errorDetail !== undefined) update.error_detail = patch.errorDetail;

      const { data, error } = await db
        .from('messages')
        .update(update)
        .eq('tenant_id', tenantId)
        .eq('provider_message_id', providerMessageId)
        .select('*')
        .maybeSingle();
      if (error) fail('message update', error);
      return data ? toMessage(data) : null;
    },

    async listMessages(tenantId, conversationId) {
      const { data, error } = await db
        .from('messages')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('conversation_id', conversationId)
        .order('occurred_at', { ascending: true })
        .limit(200);
      if (error) fail('message list', error);
      return (data ?? []).map(toMessage);
    },

    async getRun(tenantId, runId) {
      const { data, error } = await db
        .from('automation_runs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('id', runId)
        .maybeSingle();
      if (error) fail('run read', error);
      return data ? toRun(data) : null;
    },

    async getRunForLead(tenantId, leadId, moduleKey = 'lead_recovery') {
      const { data, error } = await db
        .from('automation_runs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('lead_id', leadId)
        .eq('module_key', moduleKey)
        .maybeSingle();
      if (error) fail('run read for lead', error);
      return data ? toRun(data) : null;
    },

    /**
     * The run and the snapshot it is pinned to, in one insert.
     *
     * `config_snapshot_id` was missing from this payload until ARC-015B: the engine
     * built a snapshot and handed it over, and the column stayed null, so the claim
     * functions refused every action and nothing ran in production. 0013 now refuses
     * an unpinned, foreign-tenant or wrong-module run outright, so the omission would
     * fail loudly rather than silently.
     */
    async createRun(row) {
      const { data, error } = await db
        .from('automation_runs')
        .insert({
          id: row.id,
          tenant_id: row.tenantId,
          lead_id: row.leadId,
          module_key: row.moduleKey,
          state: row.state,
          config_version: row.configVersion,
          config_snapshot_id: row.configSnapshotId,
        })
        .select('*')
        .single();
      if (error) fail('run insert', error);
      return toRun(data);
    },

    async updateRun(tenantId, runId, patch) {
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.state !== undefined) update.state = patch.state;
      if (patch.stoppedAt !== undefined) update.stopped_at = patch.stoppedAt;
      if (patch.completedAt !== undefined) update.completed_at = patch.completedAt;
      if (patch.stopReason !== undefined) update.stop_reason = patch.stopReason;
      if (patch.lastError !== undefined) update.last_error = patch.lastError;
      if (patch.configVersion !== undefined) update.config_version = patch.configVersion;

      const { data, error } = await db
        .from('automation_runs')
        .update(update)
        .eq('tenant_id', tenantId)
        .eq('id', runId)
        .select('*')
        .single();
      if (error) fail('run update', error);
      return toRun(data);
    },

    /* the pin is sent when the caller has it and derived by the 0013 trigger when it
       does not; either way the database refuses one that differs from the run's. */
    async scheduleAction(row) {
      const { data, error } = await db
        .from('scheduled_actions')
        .insert({
          tenant_id: row.tenantId,
          run_id: row.runId,
          action_type: row.actionType,
          run_at: row.runAt,
          idempotency_key: row.idempotencyKey,
          max_attempts: row.maxAttempts ?? 5,
          payload: row.payload ?? {},
          config_snapshot_id: row.configSnapshotId ?? null,
        })
        .select('*')
        .single();

      if (error) {
        if (!isUniqueViolation(error)) fail('action insert', error);
        const existing = await db
          .from('scheduled_actions')
          .select('*')
          .eq('tenant_id', row.tenantId)
          .eq('idempotency_key', row.idempotencyKey)
          .single();
        if (existing.error) fail('action re-read', existing.error);
        return { action: toAction(existing.data), created: false };
      }
      return { action: toAction(data), created: true };
    },

    async cancelPendingActions(tenantId, runId, reason, types?: ActionType[]) {
      let query = db
        .from('scheduled_actions')
        .update({ status: 'cancelled', last_error: reason, completed_at: new Date().toISOString() })
        .eq('tenant_id', tenantId)
        .eq('run_id', runId)
        .eq('status', 'pending');
      if (types?.length) query = query.in('action_type', types);
      const { data, error } = await query.select('id');
      if (error) fail('action cancel', error);
      return data?.length ?? 0;
    },

    /**
     * The claim.
     *
     * A single RPC, because the guarantee lives in `for update skip locked` inside the
     * function and cannot be reproduced by a select followed by an update from here — two
     * statements from two workers interleave, and both would send.
     */
    async claimActions(options) {
      const { limit, worker, tenantId, canaryOnly = false } = options;
      const leaseSeconds = options.leaseSeconds ?? 120;

      /* two functions, not one with an optional argument. `claim_scheduled_actions`
         took no tenant at all, so the operator canary drained every client's due work
         (S-C1); the replacement makes "all tenants" something only the dispatcher can
         ask for, by name. */
      const { data, error } = tenantId === null
        ? await db.rpc('claim_scheduled_actions_global', {
          p_limit: limit,
          p_worker: worker,
          p_lease_seconds: leaseSeconds,
        })
        : await db.rpc('claim_tenant_scheduled_actions', {
          p_tenant: tenantId,
          p_limit: limit,
          p_worker: worker,
          p_lease_seconds: leaseSeconds,
          p_canary_only: canaryOnly,
        });
      if (error) fail('claim', error);
      return (data ?? []).map(toAction);
    },

    /**
     * Fenced completion (0011).
     *
     * `complete_scheduled_action` matches on (id, tenant, lease_token, status='claimed')
     * and returns whether it changed a row. A stale worker changes nothing and is told
     * so — where before this returned void and every caller read silence as success.
     */
    async completeAction(lease: ActionLease, status, error, nowIso): Promise<StoreResult> {
      const { data, error: rpcError } = await db.rpc('complete_scheduled_action', {
        p_action: lease.actionId,
        p_tenant: lease.tenantId,
        p_lease: lease.leaseToken,
        p_status: status,
        p_error: error,
        p_now: nowIso,
      });
      if (rpcError) return storeFail('retryable_error', rpcError.message ?? 'action complete failed');
      return data === true
        ? storeOk(undefined)
        : storeFail('lost_lease', 'this action was reclaimed, completed or belongs to another tenant');
    },

    async rescheduleAction(lease: ActionLease, runAt, error): Promise<StoreResult> {
      const { data, error: rpcError } = await db.rpc('reschedule_scheduled_action', {
        p_action: lease.actionId,
        p_tenant: lease.tenantId,
        p_lease: lease.leaseToken,
        p_run_at: runAt,
        p_error: error,
      });
      if (rpcError) return storeFail('retryable_error', rpcError.message ?? 'action reschedule failed');
      return data === true
        ? storeOk(undefined)
        : storeFail('lost_lease', 'this action was reclaimed, completed or belongs to another tenant');
    },

    async listActionsForRun(tenantId, runId) {
      const { data, error } = await db
        .from('scheduled_actions')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('run_id', runId)
        .order('run_at', { ascending: true });
      if (error) fail('action list', error);
      return (data ?? []).map(toAction);
    },

    async listFailedActions(tenantId, limit) {
      const { data, error } = await db
        .from('scheduled_actions')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('status', 'failed')
        .order('completed_at', { ascending: false })
        .limit(limit);
      if (error) fail('failed action list', error);
      return (data ?? []).map(toAction);
    },

    async retryAction(tenantId, actionId, runAt) {
      const { data, error } = await db
        .from('scheduled_actions')
        .update({ status: 'pending', run_at: runAt, attempts: 0, completed_at: null, locked_at: null, locked_by: null })
        .eq('tenant_id', tenantId)
        .eq('id', actionId)
        .eq('status', 'failed')
        /* a legacy unpinned action can never be claimed, so re-queueing it would only
           strand it looking alive. 0013 refuses the transition as well. */
        .not('config_snapshot_id', 'is', null)
        .select('*')
        .maybeSingle();
      if (error) fail('action retry', error);
      return data ? toAction(data) : null;
    },

    async isSuppressed(tenantId, channel, address, nowIso) {
      const { data, error } = await db
        .from('suppressions')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('channel', channel)
        .eq('address', address)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .maybeSingle();
      if (error) fail('suppression read', error);
      if (!data) return null;
      const row: SuppressionRow = {
        tenantId: data.tenant_id,
        channel: data.channel,
        address: data.address,
        reason: data.reason,
        source: data.source ?? null,
        createdAt: data.created_at,
        expiresAt: data.expires_at ?? null,
      };
      return row;
    },

    async addSuppression(row) {
      const { error } = await db.from('suppressions').upsert(
        {
          tenant_id: row.tenantId,
          channel: row.channel,
          address: row.address,
          reason: row.reason,
          source: row.source,
          expires_at: row.expiresAt,
        },
        { onConflict: 'tenant_id,channel,address' },
      );
      if (error) fail('suppression write', error);
    },

    async openHandoff(row) {
      const existing = await db
        .from('handoffs')
        .select('*')
        .eq('tenant_id', row.tenantId)
        .eq('lead_id', row.leadId)
        .eq('status', 'open')
        .maybeSingle();
      if (existing.error) fail('handoff read', existing.error);
      /* one open handoff per lead. a second reason on the same lead is a note, not a second
         row — two rows would be two items in the needs-a-person queue for one problem. */
      if (existing.data) return { handoff: toHandoff(existing.data), created: false };

      const { data, error } = await db
        .from('handoffs')
        .insert({
          tenant_id: row.tenantId,
          lead_id: row.leadId,
          run_id: row.runId,
          reason: row.reason,
          reason_code: row.reasonCode,
          is_safety: row.isSafety,
          assigned_to: row.assignedTo,
          opened_at: row.openedAt,
        })
        .select('*')
        .single();
      if (error) fail('handoff insert', error);
      return { handoff: toHandoff(data), created: true };
    },

    async getOpenHandoff(tenantId, leadId) {
      const { data, error } = await db
        .from('handoffs')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('lead_id', leadId)
        .eq('status', 'open')
        .maybeSingle();
      if (error) fail('handoff read', error);
      return data ? toHandoff(data) : null;
    },

    async resolveHandoff(tenantId, handoffId, resolution, at) {
      const { data, error } = await db
        .from('handoffs')
        .update({ status: 'resolved', resolution, resolved_at: at })
        .eq('tenant_id', tenantId)
        .eq('id', handoffId)
        .select('*')
        .maybeSingle();
      if (error) fail('handoff resolve', error);
      return data ? toHandoff(data) : null;
    },

    /**
     * Evidence, through the same door an outside workflow uses.
     *
     * Validated here rather than trusted, for the reason given at the top of
     * `event-writer.ts`: an internal writer with a looser path is a second door into the
     * only append-only table in the system.
     */
    /* -- tenant state -- */

    async getTenant(tenantId): Promise<TenantRow | null> {
      const { data, error } = await db
        .from('tenants')
        .select('id, status')
        .eq('id', tenantId)
        .maybeSingle();
      if (error) fail('tenant lookup', error);
      return data ? { id: data.id, status: data.status } : null;
    },

    /* -- configuration snapshots -- */

    async createConfigSnapshot(row): Promise<ConfigSnapshotRow> {
      /* unique (tenant_id, config_hash). identical configuration across a thousand
         runs is one row, so this attempts the insert and reads the unique violation
         back rather than checking first, which would have a race in it. */
      const { data, error } = await db
        .from('lead_recovery_config_snapshots')
        .insert({
          tenant_id: row.tenantId,
          module_key: row.moduleKey,
          config_version: row.configVersion,
          schema_version: row.schemaVersion,
          config: row.config,
          config_hash: row.configHash,
        })
        .select('*')
        .maybeSingle();

      if (error) {
        if (!isUniqueViolation(error)) fail('snapshot create', error);
        const { data: existing, error: readError } = await db
          .from('lead_recovery_config_snapshots')
          .select('*')
          .eq('tenant_id', row.tenantId)
          .eq('config_hash', row.configHash)
          .maybeSingle();
        if (readError) fail('snapshot read-back', readError);
        if (!existing) fail('snapshot read-back', { message: 'the snapshot vanished between insert and read' });
        return toSnapshot(existing);
      }
      return toSnapshot(data);
    },

    async getConfigSnapshot(tenantId, snapshotId): Promise<ConfigSnapshotRow | null> {
      const { data, error } = await db
        .from('lead_recovery_config_snapshots')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('id', snapshotId)
        .maybeSingle();
      if (error) fail('snapshot lookup', error);
      return data ? toSnapshot(data) : null;
    },

    /* -- external effects -- */

    async reserveEffect(input: ReserveEffectInput): Promise<ReserveEffectResult> {
      const { data, error } = await db.rpc('reserve_lead_recovery_effect', {
        p_tenant: input.tenantId,
        p_effect_key: input.effectKey,
        p_effect_type: input.effectType,
        p_idempotency: input.idempotencyKey,
        p_worker: input.worker,
        p_lease: input.leaseToken,
        p_run: input.runId ?? null,
        p_lead: input.leadId ?? null,
        p_action: input.actionId ?? null,
        p_conversation: input.conversationId ?? null,
        p_destination: input.destinationRef ?? null,
        p_is_canary: input.isCanary === true,
      });
      if (error) fail('effect reserve', error);

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) fail('effect reserve', { message: 'the reservation returned no row' });

      const { data: attemptRow, error: readError } = await db
        .from('lead_recovery_effect_attempts')
        .select('*')
        .eq('tenant_id', input.tenantId)
        .eq('id', row.attempt_id)
        .maybeSingle();
      if (readError) fail('effect read-back', readError);
      if (!attemptRow) fail('effect read-back', { message: 'the reserved attempt could not be read back' });

      return { attempt: toEffect(attemptRow), reserved: row.reserved === true };
    },

    async settleEffect(args): Promise<StoreResult> {
      const { data, error } = await db.rpc('settle_lead_recovery_effect', {
        p_attempt: args.attemptId,
        p_tenant: args.tenantId,
        p_lease: args.leaseToken,
        p_state: args.state,
        p_provider_message_id: args.providerMessageId ?? null,
        p_error_category: args.errorCategory ?? null,
        p_error_detail: args.errorDetail ?? null,
        p_retryable: args.retryable ?? null,
        p_now: args.nowIso,
      });
      if (error) return storeFail('retryable_error', error.message ?? 'effect settle failed');
      return data === true
        ? storeOk(undefined)
        : storeFail('lost_lease', 'this attempt was reserved under a different lease');
    },

    async getEffectByKey(tenantId, effectKey): Promise<EffectAttemptRow | null> {
      const { data, error } = await db
        .from('lead_recovery_effect_attempts')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('effect_key', effectKey)
        .maybeSingle();
      if (error) fail('effect lookup', error);
      return data ? toEffect(data) : null;
    },

    async recordEffectDelivery(args): Promise<StoreResult> {
      const { data, error } = await db.rpc('record_lead_recovery_delivery', {
        p_tenant: args.tenantId,
        p_provider_message_id: args.providerMessageId,
        p_state: args.state,
        p_error_category: args.errorCategory ?? null,
        p_error_detail: args.errorDetail ?? null,
        p_now: args.nowIso,
      });
      if (error) return storeFail('retryable_error', error.message ?? 'delivery record failed');
      /* false means the callback was a duplicate, arrived out of order, or named an
         attempt that cannot be reopened. all three are no-ops, not errors. */
      return data === true
        ? storeOk(undefined)
        : storeFail('invalid_state', 'the callback did not move this attempt');
    },

    async listOpenEffects(tenantId, limit): Promise<EffectAttemptRow[]> {
      const { data, error } = await db
        .from('lead_recovery_effect_attempts')
        .select('*')
        .eq('tenant_id', tenantId)
        .in('state', ['outcome_unknown', 'reconciliation_required', 'dispatching'])
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) fail('open effect list', error);
      return (data ?? []).map(toEffect);
    },

    async emit(tenantId, events) {
      const valid = [];
      const invalid: string[] = [];
      for (const [i, event] of events.entries()) {
        const result = validateEvent(event);
        if (result.ok) valid.push(result.event);
        else invalid.push(...result.errors.map((e) => `events[${i}]: ${e}`));
      }
      if (invalid.length > 0) {
        /* a malformed internal event is a bug in Arc's own code. it is logged loudly and
           the rest of the batch still lands — dropping the good rows as well would lose
           real evidence to punish a typo. */
        console.error('lead-recovery emitted an invalid event', invalid);
      }
      if (valid.length === 0) return { written: 0, invalid };
      const result = await writeEvents(sink, tenantId, valid);
      if (result.error) throw new Error(`event write failed: ${result.error}`);
      return { written: result.written, invalid };
    },
  };
}
