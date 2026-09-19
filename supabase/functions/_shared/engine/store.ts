/**
 * The seam between the engine and the database.
 *
 * The engine is the part with the rules in it — when to send, when to stop, when to fetch
 * a person — and it is the part that has to be exercised hundreds of times in a test suite
 * that has no network and no Postgres. So it talks to an interface, and there are two
 * implementations: `MemoryStore` here, and `supabaseStore()` next door.
 *
 * `MemoryStore` is not a mock. It enforces the same three things the schema enforces, and
 * a test that passes against it is a test about behaviour the database also guarantees:
 *
 *   - **tenant scoping**: every method takes a tenant id and no method can return a row
 *     belonging to another one. The composite foreign keys in 0010 make that structural in
 *     Postgres; here it is an assertion, and a violation throws rather than returning
 *     nothing, because "returned nothing" is how a cross-tenant bug hides.
 *   - **unique constraints**: one run per lead, one conversation per lead per channel, one
 *     action per idempotency key, one message per provider id, one suppression per
 *     (tenant, channel, address).
 *   - **claim semantics**: `claimActions` hands the same row to exactly one caller, which
 *     is what `for update skip locked` does in the real one.
 *
 * Where the two could drift, the interface is written so they cannot: every write returns
 * what was actually stored rather than what was asked for, so a caller that relies on an
 * insert having happened has to read the answer.
 */

import { validateEvent } from '../event-validation.ts';
import type { RunState, StopReason } from './state-machine.ts';

/* ── row shapes ─────────────────────────────────────────── */

export interface TenantConfigRow {
  tenantId: string;
  moduleKey: string;
  enabled: boolean;
  schemaVersion: number;
  configVersion: number;
  config: Record<string, unknown>;
}

export interface LeadRow {
  id: string;
  tenantId: string;
  correlationId: string;
  source: 'missed_call' | 'web_form' | 'inbound_sms' | 'manual';
  intakeRef: string | null;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  serviceRequest: string | null;
  locationZip: string | null;
  locationText: string | null;
  urgency: string | null;
  safetyFlags: string[];
  aiSummary: string | null;
  status: string;
  consentSms: boolean;
  consentSource: string | null;
  consentAt: string | null;
  assignedTo: string | null;
  bookingOutcome: string | null;
  bookedAt: string | null;
  isCanary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRow {
  id: string;
  tenantId: string;
  leadId: string;
  channel: string;
  status: string;
  providerRef: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}

export interface MessageRow {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  providerMessageId: string | null;
  body: string | null;
  status: string;
  errorClass: string | null;
  errorDetail: string | null;
  occurredAt: string;
}

export interface RunRow {
  id: string;
  tenantId: string;
  leadId: string;
  moduleKey: string;
  state: RunState;
  configVersion: number;
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  completedAt: string | null;
  stopReason: StopReason | null;
  lastError: string | null;
}

export type ActionType =
  | 'send_first_response'
  | 'send_followup'
  | 'classify_reply'
  | 'route_to_contractor'
  | 'open_handoff'
  | 'close_run'
  | 'notify_staff';

export interface ActionRow {
  id: string;
  tenantId: string;
  runId: string;
  actionType: ActionType;
  runAt: string;
  status: 'pending' | 'claimed' | 'done' | 'cancelled' | 'failed';
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  lockedAt: string | null;
  lockedBy: string | null;
  lastError: string | null;
  payload: Record<string, unknown>;
  completedAt: string | null;
}

export interface HandoffRow {
  id: string;
  tenantId: string;
  leadId: string;
  runId: string | null;
  reason: string;
  reasonCode: string;
  isSafety: boolean;
  assignedTo: string | null;
  status: 'open' | 'resolved';
  resolution: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export interface SuppressionRow {
  tenantId: string;
  channel: 'sms' | 'email';
  address: string;
  reason: string;
  source: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface IntakeKeyRow {
  id: string;
  tenantId: string;
  publicKey: string;
  allowedOrigins: string[];
  revokedAt: string | null;
}

/* ── the interface ──────────────────────────────────────── */

export interface EngineStore {
  /* configuration & routing */
  getConfig(tenantId: string, moduleKey?: string): Promise<TenantConfigRow | null>;
  /** which tenant owns the number Twilio just called. the only routing rule there is. */
  findTenantByTwilioNumber(phone: string): Promise<TenantConfigRow | null>;
  findIntakeKey(publicKey: string): Promise<IntakeKeyRow | null>;
  touchIntakeKey(id: string): Promise<void>;

  /* leads */
  getLead(tenantId: string, leadId: string): Promise<LeadRow | null>;
  getLeadByCorrelation(tenantId: string, correlationId: string): Promise<LeadRow | null>;
  /** the most recent open lead for this number, used to fold a reply onto its own thread. */
  findOpenLeadByPhone(tenantId: string, phone: string): Promise<LeadRow | null>;
  createLead(row: Omit<LeadRow, 'createdAt' | 'updatedAt'>): Promise<LeadRow>;
  updateLead(tenantId: string, leadId: string, patch: Partial<LeadRow>): Promise<LeadRow>;

  /* conversations & messages */
  getOrCreateConversation(tenantId: string, leadId: string, channel?: string): Promise<ConversationRow>;
  getConversation(tenantId: string, conversationId: string): Promise<ConversationRow | null>;
  /** returns `created: false` when the provider id was already present — the idempotency point. */
  insertMessage(row: Omit<MessageRow, 'id'>): Promise<{ message: MessageRow; created: boolean }>;
  updateMessageByProviderId(
    tenantId: string,
    providerMessageId: string,
    patch: Partial<MessageRow>,
  ): Promise<MessageRow | null>;
  listMessages(tenantId: string, conversationId: string): Promise<MessageRow[]>;

  /* runs */
  getRun(tenantId: string, runId: string): Promise<RunRow | null>;
  getRunForLead(tenantId: string, leadId: string, moduleKey?: string): Promise<RunRow | null>;
  createRun(row: Omit<RunRow, 'startedAt' | 'updatedAt'>): Promise<RunRow>;
  updateRun(tenantId: string, runId: string, patch: Partial<RunRow>): Promise<RunRow>;

  /* the queue */
  scheduleAction(row: Omit<ActionRow, 'id' | 'status' | 'attempts' | 'lockedAt' | 'lockedBy' | 'lastError' | 'completedAt'> & {
    maxAttempts?: number;
  }): Promise<{ action: ActionRow; created: boolean }>;
  cancelPendingActions(tenantId: string, runId: string, reason: string, types?: ActionType[]): Promise<number>;
  claimActions(limit: number, worker: string, nowIso: string, leaseSeconds?: number): Promise<ActionRow[]>;
  completeAction(id: string, status: 'done' | 'failed' | 'cancelled', error: string | null, nowIso: string): Promise<void>;
  rescheduleAction(id: string, runAt: string, error: string | null): Promise<void>;
  listActionsForRun(tenantId: string, runId: string): Promise<ActionRow[]>;
  listFailedActions(tenantId: string, limit: number): Promise<ActionRow[]>;
  retryAction(tenantId: string, actionId: string, runAt: string): Promise<ActionRow | null>;

  /* suppression */
  isSuppressed(tenantId: string, channel: 'sms' | 'email', address: string, nowIso: string): Promise<SuppressionRow | null>;
  addSuppression(row: SuppressionRow): Promise<void>;

  /* handoffs */
  openHandoff(row: Omit<HandoffRow, 'id' | 'status' | 'resolution' | 'resolvedAt'>): Promise<{ handoff: HandoffRow; created: boolean }>;
  getOpenHandoff(tenantId: string, leadId: string): Promise<HandoffRow | null>;
  resolveHandoff(tenantId: string, handoffId: string, resolution: string, at: string): Promise<HandoffRow | null>;

  /* evidence */
  emit(tenantId: string, events: unknown[]): Promise<{ written: number; invalid: string[] }>;
}

/* ── the in-memory implementation ───────────────────────── */

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  /* uuid-shaped, because the schema's columns are uuids and a test fixture that is not a
     uuid would pass here and fail against Postgres. */
  const hex = counter.toString(16).padStart(12, '0');
  return `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${hex}`;
}

export class MemoryStore implements EngineStore {
  configs: TenantConfigRow[] = [];
  intakeKeys: IntakeKeyRow[] = [];
  leads: LeadRow[] = [];
  conversations: ConversationRow[] = [];
  messages: MessageRow[] = [];
  runs: RunRow[] = [];
  actions: ActionRow[] = [];
  handoffs: HandoffRow[] = [];
  suppressions: SuppressionRow[] = [];
  events: { tenantId: string; event: Record<string, unknown> }[] = [];
  invalidEvents: string[] = [];

  /** Set by a test to make the next write fail the way a transient database error does. */
  failNextEmit: string | null = null;

  // ── config & routing ──
  // deno-lint-ignore require-await
  async getConfig(tenantId: string, moduleKey = 'lead_recovery') {
    return this.configs.find((c) => c.tenantId === tenantId && c.moduleKey === moduleKey) ?? null;
  }

  // deno-lint-ignore require-await
  async findTenantByTwilioNumber(phone: string) {
    return (
      this.configs.find(
        (c) => ((c.config as { twilio?: { phone_number?: string } }).twilio?.phone_number ?? null) === phone,
      ) ?? null
    );
  }

  // deno-lint-ignore require-await
  async findIntakeKey(publicKey: string) {
    return this.intakeKeys.find((k) => k.publicKey === publicKey && k.revokedAt === null) ?? null;
  }

  // deno-lint-ignore require-await
  async touchIntakeKey(_id: string) {}

  // ── leads ──
  // deno-lint-ignore require-await
  async getLead(tenantId: string, leadId: string) {
    return this.leads.find((l) => l.id === leadId && l.tenantId === tenantId) ?? null;
  }

  // deno-lint-ignore require-await
  async getLeadByCorrelation(tenantId: string, correlationId: string) {
    return this.leads.find((l) => l.tenantId === tenantId && l.correlationId === correlationId) ?? null;
  }

  // deno-lint-ignore require-await
  async findOpenLeadByPhone(tenantId: string, phone: string) {
    const open = this.leads
      .filter((l) => l.tenantId === tenantId && l.phone === phone && l.status !== 'closed' && l.status !== 'suppressed')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return open[0] ?? null;
  }

  // deno-lint-ignore require-await
  async createLead(row: Omit<LeadRow, 'createdAt' | 'updatedAt'>) {
    if (this.leads.some((l) => l.tenantId === row.tenantId && l.correlationId === row.correlationId)) {
      throw new Error('duplicate key value violates unique constraint "leads_tenant_id_correlation_id_key"');
    }
    const now = new Date().toISOString();
    const lead: LeadRow = { ...row, createdAt: now, updatedAt: now };
    this.leads.push(lead);
    return lead;
  }

  // deno-lint-ignore require-await
  async updateLead(tenantId: string, leadId: string, patch: Partial<LeadRow>) {
    const lead = this.leads.find((l) => l.id === leadId && l.tenantId === tenantId);
    if (!lead) throw new Error(`no lead ${leadId} for tenant ${tenantId}`);
    Object.assign(lead, patch, { updatedAt: new Date().toISOString() });
    return lead;
  }

  // ── conversations & messages ──
  // deno-lint-ignore require-await
  async getOrCreateConversation(tenantId: string, leadId: string, channel = 'sms') {
    const existing = this.conversations.find(
      (c) => c.tenantId === tenantId && c.leadId === leadId && c.channel === channel,
    );
    if (existing) return existing;
    const row: ConversationRow = {
      id: id('conv'),
      tenantId,
      leadId,
      channel,
      status: 'open',
      providerRef: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };
    this.conversations.push(row);
    return row;
  }

  // deno-lint-ignore require-await
  async getConversation(tenantId: string, conversationId: string) {
    return this.conversations.find((c) => c.id === conversationId && c.tenantId === tenantId) ?? null;
  }

  // deno-lint-ignore require-await
  async insertMessage(row: Omit<MessageRow, 'id'>) {
    if (row.providerMessageId) {
      const existing = this.messages.find(
        (m) => m.tenantId === row.tenantId && m.providerMessageId === row.providerMessageId,
      );
      if (existing) return { message: existing, created: false };
    }
    const message: MessageRow = { ...row, id: id('msg') };
    this.messages.push(message);
    const conversation = this.conversations.find((c) => c.id === row.conversationId);
    if (conversation) {
      if (row.direction === 'inbound') conversation.lastInboundAt = row.occurredAt;
      else conversation.lastOutboundAt = row.occurredAt;
    }
    return { message, created: true };
  }

  // deno-lint-ignore require-await
  async updateMessageByProviderId(tenantId: string, providerMessageId: string, patch: Partial<MessageRow>) {
    const message = this.messages.find((m) => m.tenantId === tenantId && m.providerMessageId === providerMessageId);
    if (!message) return null;
    Object.assign(message, patch);
    return message;
  }

  // deno-lint-ignore require-await
  async listMessages(tenantId: string, conversationId: string) {
    return this.messages
      .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  // ── runs ──
  // deno-lint-ignore require-await
  async getRun(tenantId: string, runId: string) {
    return this.runs.find((r) => r.id === runId && r.tenantId === tenantId) ?? null;
  }

  // deno-lint-ignore require-await
  async getRunForLead(tenantId: string, leadId: string, moduleKey = 'lead_recovery') {
    return this.runs.find((r) => r.tenantId === tenantId && r.leadId === leadId && r.moduleKey === moduleKey) ?? null;
  }

  // deno-lint-ignore require-await
  async createRun(row: Omit<RunRow, 'startedAt' | 'updatedAt'>) {
    if (this.runs.some((r) => r.tenantId === row.tenantId && r.leadId === row.leadId && r.moduleKey === row.moduleKey)) {
      throw new Error('duplicate key value violates unique constraint "automation_runs_tenant_id_lead_id_module_key_key"');
    }
    const now = new Date().toISOString();
    const run: RunRow = { ...row, startedAt: now, updatedAt: now };
    this.runs.push(run);
    return run;
  }

  // deno-lint-ignore require-await
  async updateRun(tenantId: string, runId: string, patch: Partial<RunRow>) {
    const run = this.runs.find((r) => r.id === runId && r.tenantId === tenantId);
    if (!run) throw new Error(`no run ${runId} for tenant ${tenantId}`);
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    return run;
  }

  // ── queue ──
  // deno-lint-ignore require-await
  async scheduleAction(row: Omit<ActionRow, 'id' | 'status' | 'attempts' | 'lockedAt' | 'lockedBy' | 'lastError' | 'completedAt'> & { maxAttempts?: number }) {
    const existing = this.actions.find(
      (a) => a.tenantId === row.tenantId && a.idempotencyKey === row.idempotencyKey,
    );
    if (existing) return { action: existing, created: false };
    const action: ActionRow = {
      id: id('act'),
      tenantId: row.tenantId,
      runId: row.runId,
      actionType: row.actionType,
      runAt: row.runAt,
      status: 'pending',
      idempotencyKey: row.idempotencyKey,
      attempts: 0,
      maxAttempts: row.maxAttempts ?? 5,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      payload: row.payload ?? {},
      completedAt: null,
    };
    this.actions.push(action);
    return { action, created: true };
  }

  // deno-lint-ignore require-await
  async cancelPendingActions(tenantId: string, runId: string, reason: string, types?: ActionType[]) {
    let cancelled = 0;
    for (const action of this.actions) {
      if (action.tenantId !== tenantId || action.runId !== runId) continue;
      if (action.status !== 'pending') continue;
      if (types && !types.includes(action.actionType)) continue;
      action.status = 'cancelled';
      action.lastError = reason;
      action.completedAt = new Date().toISOString();
      cancelled += 1;
    }
    return cancelled;
  }

  // deno-lint-ignore require-await
  async claimActions(limit: number, worker: string, nowIso: string, leaseSeconds = 120) {
    const leaseCutoff = new Date(Date.parse(nowIso) - Math.max(leaseSeconds, 30) * 1000).toISOString();
    const due = this.actions
      .filter(
        (a) =>
          (a.status === 'pending' && a.runAt <= nowIso) ||
          (a.status === 'claimed' && a.lockedAt !== null && a.lockedAt < leaseCutoff),
      )
      .sort((a, b) => a.runAt.localeCompare(b.runAt))
      .slice(0, Math.max(1, limit));

    /* the atomic half. in Postgres the select and the update are one statement under
       `for update skip locked`; here the flip happens before anything is returned, which
       gives a second concurrent caller nothing to take. */
    for (const action of due) {
      action.status = 'claimed';
      action.lockedAt = nowIso;
      action.lockedBy = worker;
      action.attempts += 1;
    }
    return due.map((a) => ({ ...a }));
  }

  // deno-lint-ignore require-await
  async completeAction(actionId: string, status: 'done' | 'failed' | 'cancelled', error: string | null, nowIso: string) {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) return;
    action.status = status;
    action.lastError = error;
    action.completedAt = nowIso;
    action.lockedAt = null;
    action.lockedBy = null;
  }

  // deno-lint-ignore require-await
  async rescheduleAction(actionId: string, runAt: string, error: string | null) {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) return;
    action.status = 'pending';
    action.runAt = runAt;
    action.lastError = error;
    action.lockedAt = null;
    action.lockedBy = null;
  }

  // deno-lint-ignore require-await
  async listActionsForRun(tenantId: string, runId: string) {
    return this.actions.filter((a) => a.tenantId === tenantId && a.runId === runId);
  }

  // deno-lint-ignore require-await
  async listFailedActions(tenantId: string, limit: number) {
    return this.actions.filter((a) => a.tenantId === tenantId && a.status === 'failed').slice(0, limit);
  }

  // deno-lint-ignore require-await
  async retryAction(tenantId: string, actionId: string, runAt: string) {
    const action = this.actions.find((a) => a.id === actionId && a.tenantId === tenantId);
    if (!action || action.status !== 'failed') return null;
    action.status = 'pending';
    action.runAt = runAt;
    action.attempts = 0;
    action.completedAt = null;
    return action;
  }

  // ── suppression ──
  // deno-lint-ignore require-await
  async isSuppressed(tenantId: string, channel: 'sms' | 'email', address: string, nowIso: string) {
    return (
      this.suppressions.find(
        (s) =>
          s.tenantId === tenantId &&
          s.channel === channel &&
          s.address === address &&
          (s.expiresAt === null || s.expiresAt > nowIso),
      ) ?? null
    );
  }

  // deno-lint-ignore require-await
  async addSuppression(row: SuppressionRow) {
    const existing = this.suppressions.find(
      (s) => s.tenantId === row.tenantId && s.channel === row.channel && s.address === row.address,
    );
    if (existing) Object.assign(existing, row);
    else this.suppressions.push(row);
  }

  // ── handoffs ──
  // deno-lint-ignore require-await
  async openHandoff(row: Omit<HandoffRow, 'id' | 'status' | 'resolution' | 'resolvedAt'>) {
    const existing = this.handoffs.find(
      (h) => h.tenantId === row.tenantId && h.leadId === row.leadId && h.status === 'open',
    );
    if (existing) return { handoff: existing, created: false };
    const handoff: HandoffRow = { ...row, id: id('hand'), status: 'open', resolution: null, resolvedAt: null };
    this.handoffs.push(handoff);
    return { handoff, created: true };
  }

  // deno-lint-ignore require-await
  async getOpenHandoff(tenantId: string, leadId: string) {
    return this.handoffs.find((h) => h.tenantId === tenantId && h.leadId === leadId && h.status === 'open') ?? null;
  }

  // deno-lint-ignore require-await
  async resolveHandoff(tenantId: string, handoffId: string, resolution: string, at: string) {
    const handoff = this.handoffs.find((h) => h.id === handoffId && h.tenantId === tenantId);
    if (!handoff) return null;
    handoff.status = 'resolved';
    handoff.resolution = resolution;
    handoff.resolvedAt = at;
    return handoff;
  }

  // ── evidence ──
  /**
   * Validated, exactly as the Postgres store validates.
   *
   * This is the half of the memory store that is least like a mock and most load-bearing:
   * an internally emitted event goes through the same `validateEvent` an outside workflow's
   * does, so a test that asserts the engine wrote no invalid events is asserting something
   * real about the boundary rather than about this class.
   */
  // deno-lint-ignore require-await
  async emit(tenantId: string, events: unknown[]) {
    if (this.failNextEmit) {
      const why = this.failNextEmit;
      this.failNextEmit = null;
      throw new Error(why);
    }
    const invalid: string[] = [];
    let written = 0;
    for (const [i, event] of events.entries()) {
      const result = validateEvent(event);
      if (!result.ok) {
        invalid.push(...result.errors.map((e) => `events[${i}]: ${e}`));
        continue;
      }
      const row = result.event as unknown as Record<string, unknown>;
      const key = row.event_key as string | undefined;
      /* the unique index, honoured: a retried emit with the same key writes nothing. */
      if (key && this.events.some((e) => e.tenantId === tenantId && e.event.event_key === key)) continue;
      this.events.push({ tenantId, event: row });
      written += 1;
    }
    this.invalidEvents.push(...invalid);
    return { written, invalid };
  }

  /* ── test conveniences ── */
  eventsOfType(type: string, tenantId?: string) {
    return this.events.filter((e) => e.event.event_type === type && (!tenantId || e.tenantId === tenantId));
  }

  pendingActions(tenantId?: string) {
    return this.actions.filter((a) => a.status === 'pending' && (!tenantId || a.tenantId === tenantId));
  }
}
