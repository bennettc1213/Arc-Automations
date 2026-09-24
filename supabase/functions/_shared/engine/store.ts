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
import type { ConfigStore } from '../config/store.ts';
import { MemoryLifecycleStore } from '../lifecycle/memory.ts';
import { LifecycleStoreError, type RunMode } from '../lifecycle/model.ts';
import type { LifecycleStore } from '../lifecycle/store.ts';
import { SELECTABLE_STATUSES } from '../registry/capabilities.ts';
import { getModule } from '../registry/modules.ts';
import type { RunState, StopReason } from './state-machine.ts';

/* ── row shapes ─────────────────────────────────────────── */

/**
 * A `module_configs` row. Since 0014 it carries the module's switch (`enabled`) and
 * nothing the engine reads for behaviour: `config` is frozen legacy content, and the
 * configuration a run uses is resolved from published versions (`config/engine.ts`).
 */
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
  /**
   * The immutable configuration this run began under (0011).
   *
   * `configVersion` is the counter the mutable row happened to carry; this is the
   * thing that actually answers "what was this run allowed to do". A run without
   * one predates snapshotting and may not send — see `claim_actions_internal`.
   */
  configSnapshotId: string | null;
  /**
   * How this run may touch the world — `live`, `test` or `shadow` (0015, ARC-120) — fixed
   * when it is created, when the lifecycle authorised it. Null only on runs created before
   * lifecycle authorisation existed; nothing proves those were allowed to start, so they
   * may not act.
   */
  runMode: RunMode | null;
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  completedAt: string | null;
  stopReason: StopReason | null;
  lastError: string | null;
}

/** A frozen, hashed copy of the validated config a run started under (0011). */
export interface ConfigSnapshotRow {
  id: string;
  tenantId: string;
  moduleKey: string;
  /** since 0014: the module version's number. before it: the mutable row's counter. */
  configVersion: number;
  schemaVersion: number;
  config: Record<string, unknown>;
  configHash: string;
  /**
   * The published versions this snapshot was composed from (ARC-110, 0014). Null on
   * every snapshot written before versioning — that provenance cannot be proven, so it
   * is not invented. Both or neither.
   */
  tenantConfigVersionId: string | null;
  moduleConfigVersionId: string | null;
  createdAt: string;
}

/** Only what the engine needs in order to refuse to act for a stopped client. */
export interface TenantRow {
  id: string;
  status: 'onboarding' | 'active' | 'paused' | 'archived';
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
  /** `blocked` (0011): queued before snapshots existed, so it may never send. */
  status: 'pending' | 'claimed' | 'done' | 'cancelled' | 'failed' | 'blocked';
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  lockedAt: string | null;
  lockedBy: string | null;
  /**
   * The fence (0011).
   *
   * `lockedBy` is not one: the dispatcher's worker name is a constant, so the same
   * identifier reclaims the same row a minute later and a stale worker's late write
   * would still match it. A fresh uuid per claim is what makes "are you still the
   * holder?" answerable.
   */
  leaseToken: string | null;
  fence: number;
  /**
   * The configuration snapshot this action was queued under (0011 column, 0013 rule).
   *
   * Always its run's snapshot: the database derives it from the run on insert, refuses
   * a mismatch, and never lets it change. Null only on legacy rows queued before
   * pinning existed, and a null pin is never claimable.
   */
  configSnapshotId: string | null;
  lastError: string | null;
  payload: Record<string, unknown>;
  completedAt: string | null;
}

/** What a worker must present to mutate an action it claimed. */
export interface ActionLease {
  actionId: string;
  tenantId: string;
  leaseToken: string;
}

/* ── typed store results ────────────────────────────────── */

/**
 * Why a fenced write did nothing.
 *
 * The point of this union is that no caller can read a zero-row update as success.
 * Before 0011 `completeAction` returned void, so "the row you thought you held was
 * taken by somebody else" and "done" were the same value.
 */
export type StoreFailure =
  | 'not_found'
  | 'wrong_tenant'
  | 'lost_lease'
  | 'invalid_state'
  | 'already_completed'
  | 'already_attempted'
  | 'blocked_by_guard'
  | 'outcome_unknown'
  | 'retryable_error'
  | 'terminal_error';

export type StoreResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; reason: StoreFailure; detail: string };

export const storeOk = <T>(value: T): StoreResult<T> => ({ ok: true, value });
export const storeFail = <T = void>(reason: StoreFailure, detail: string): StoreResult<T> =>
  ({ ok: false, reason, detail });

/* ── external effects ───────────────────────────────────── */

export type EffectType = 'customer_sms' | 'staff_sms';

/**
 * The lifecycle of one customer- or employee-affecting side effect.
 *
 * The split that matters is between states that *prove the provider never took it*
 * — `rejected`, `failed_retryable`, `cancelled_before_send` — and every other
 * non-terminal state. Only the first group may be retried automatically. The rest
 * are ambiguous, and an ambiguous send is resolved by a person or a reconciler,
 * never by sending again and hoping.
 */
export type EffectState =
  | 'reserved'
  | 'cancelled_before_send'
  | 'dispatching'
  | 'accepted'
  | 'confirmed'
  | 'rejected'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'outcome_unknown'
  | 'reconciliation_required';

/** States from which a fresh provider call is provably safe. */
export const RETRYABLE_EFFECT_STATES: EffectState[] = [
  'rejected',
  'failed_retryable',
  'cancelled_before_send',
];

/** States that mean "we cannot prove this was not sent" — never auto-retry. */
export const AMBIGUOUS_EFFECT_STATES: EffectState[] = [
  'dispatching',
  'outcome_unknown',
  'reconciliation_required',
];

export interface EffectAttemptRow {
  id: string;
  tenantId: string;
  runId: string | null;
  leadId: string | null;
  actionId: string | null;
  conversationId: string | null;
  effectType: EffectType;
  effectKey: string;
  idempotencyKey: string;
  worker: string | null;
  leaseToken: string | null;
  fence: number;
  attemptNo: number;
  provider: string;
  destinationRef: string | null;
  state: EffectState;
  providerMessageId: string | null;
  errorCategory: string | null;
  errorDetail: string | null;
  retryable: boolean | null;
  isCanary: boolean;
  reservedAt: string;
  dispatchStartedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
}

export interface ReserveEffectInput {
  tenantId: string;
  effectKey: string;
  effectType: EffectType;
  idempotencyKey: string;
  worker: string;
  leaseToken: string;
  runId?: string | null;
  leadId?: string | null;
  actionId?: string | null;
  conversationId?: string | null;
  destinationRef?: string | null;
  isCanary?: boolean;
}

export interface ReserveEffectResult {
  attempt: EffectAttemptRow;
  /** true = this caller owns the effect and may call the provider. */
  reserved: boolean;
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

export interface EngineStore extends ConfigStore, LifecycleStore {
  /* the module switch, a mirror of `tenant_modules.state = 'active'` since 0015 — read by
     nothing that decides. configuration itself is resolved from versions (ConfigStore). */
  getConfig(tenantId: string, moduleKey?: string): Promise<TenantConfigRow | null>;
  /**
   * Which tenant owns the number Twilio just called — the only routing rule there is.
   * Read from each tenant's *published* Lead Recovery version (0014); a number claimed by
   * two tenants throws rather than guessing.
   */
  findTenantByTwilioNumber(phone: string): Promise<{ tenantId: string; moduleKey: string } | null>;
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
  /**
   * Refuses a run with no snapshot, another tenant's snapshot, or a snapshot for a
   * different module or an unregistered schema (0013). The run's pin never changes.
   */
  createRun(row: Omit<RunRow, 'startedAt' | 'updatedAt'>): Promise<RunRow>;
  updateRun(tenantId: string, runId: string, patch: Partial<RunRow>): Promise<RunRow>;

  /* the queue */
  /**
   * The action inherits its run's snapshot. Passing `configSnapshotId` is allowed and
   * must equal the run's; omitting it lets the database derive it. Queueing against a
   * run with no snapshot is refused (0013).
   */
  scheduleAction(row: Omit<ActionRow, 'id' | 'status' | 'attempts' | 'lockedAt' | 'lockedBy' | 'leaseToken' | 'fence' | 'lastError' | 'completedAt' | 'configSnapshotId'> & {
    maxAttempts?: number;
    configSnapshotId?: string | null;
  }): Promise<{ action: ActionRow; created: boolean }>;
  cancelPendingActions(tenantId: string, runId: string, reason: string, types?: ActionType[]): Promise<number>;
  /**
   * Claim due work.
   *
   * `tenantId` is required for anything but the production dispatcher, and
   * `canaryOnly` restricts a claim to synthetic leads. Before 0011 there was one
   * unscoped function and the operator canary used it, so pressing "run canary"
   * drained whatever was due for every other client into a recording sender.
   */
  claimActions(options: {
    limit: number;
    worker: string;
    nowIso: string;
    leaseSeconds?: number;
    /** null means every tenant, and only the dispatcher may pass it. */
    tenantId: string | null;
    canaryOnly?: boolean;
  }): Promise<ActionRow[]>;
  /** Fenced. A stale worker gets `lost_lease`, never a silent success. */
  completeAction(lease: ActionLease, status: 'done' | 'failed' | 'cancelled', error: string | null, nowIso: string): Promise<StoreResult>;
  rescheduleAction(lease: ActionLease, runAt: string, error: string | null): Promise<StoreResult>;
  listActionsForRun(tenantId: string, runId: string): Promise<ActionRow[]>;
  listFailedActions(tenantId: string, limit: number): Promise<ActionRow[]>;
  /** Only a failed, pinned action goes back on the queue; a legacy unpinned one stays put. */
  retryAction(tenantId: string, actionId: string, runAt: string): Promise<ActionRow | null>;

  /* suppression */
  isSuppressed(tenantId: string, channel: 'sms' | 'email', address: string, nowIso: string): Promise<SuppressionRow | null>;
  addSuppression(row: SuppressionRow): Promise<void>;

  /* handoffs */
  openHandoff(row: Omit<HandoffRow, 'id' | 'status' | 'resolution' | 'resolvedAt'>): Promise<{ handoff: HandoffRow; created: boolean }>;
  getOpenHandoff(tenantId: string, leadId: string): Promise<HandoffRow | null>;
  resolveHandoff(tenantId: string, handoffId: string, resolution: string, at: string): Promise<HandoffRow | null>;

  /* tenant state — the live stop condition 0010 never checked */
  getTenant(tenantId: string): Promise<TenantRow | null>;

  /* configuration snapshots (0011) */
  createConfigSnapshot(row: Omit<ConfigSnapshotRow, 'id' | 'createdAt'>): Promise<ConfigSnapshotRow>;
  getConfigSnapshot(tenantId: string, snapshotId: string): Promise<ConfigSnapshotRow | null>;

  /* external effects (0011) */
  reserveEffect(input: ReserveEffectInput): Promise<ReserveEffectResult>;
  settleEffect(args: {
    attemptId: string;
    tenantId: string;
    leaseToken: string;
    state: EffectState;
    providerMessageId?: string | null;
    errorCategory?: string | null;
    errorDetail?: string | null;
    retryable?: boolean | null;
    nowIso: string;
  }): Promise<StoreResult>;
  getEffectByKey(tenantId: string, effectKey: string): Promise<EffectAttemptRow | null>;
  /** Provider callbacks carry no lease; they are fenced on the provider reference. */
  recordEffectDelivery(args: {
    tenantId: string;
    providerMessageId: string;
    state: 'accepted' | 'confirmed' | 'failed_terminal';
    errorCategory?: string | null;
    errorDetail?: string | null;
    nowIso: string;
  }): Promise<StoreResult>;
  listOpenEffects(tenantId: string, limit: number): Promise<EffectAttemptRow[]>;

  /* evidence */
  emit(tenantId: string, events: unknown[]): Promise<{ written: number; invalid: string[] }>;
}

/* ── the in-memory implementation ───────────────────────── */

/**
 * Whether a snapshot's schema version is one the registry says this module runs.
 *
 * The same question `automation_runs_guard_snapshot()` asks of
 * `registry_module_versions` in 0013, asked here of the typed registry it is seeded
 * from — so neither store keeps a second list of module names.
 */
function registeredSnapshotSchema(moduleKey: string, schemaVersion: number): boolean {
  return (getModule(moduleKey)?.versions ?? []).some(
    (v) => SELECTABLE_STATUSES.includes(v.status) && v.configSchemaKey !== null && v.configSchemaVersion === schemaVersion,
  );
}

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  /* uuid-shaped, because the schema's columns are uuids and a test fixture that is not a
     uuid would pass here and fail against Postgres. */
  const hex = counter.toString(16).padStart(12, '0');
  return `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${hex}`;
}

/**
 * The configuration tables, the switch rows (`configs`), `arc_admins` (`operators`) and
 * `admin_actions` are inherited from `MemoryConfigStore` (ARC-110); the lifecycle tables,
 * and the runs, leads, actions, snapshots and intake keys their guards read, from
 * `MemoryLifecycleStore` (ARC-120). A test holds one object for the whole database.
 */
export class MemoryStore extends MemoryLifecycleStore implements EngineStore {
  conversations: ConversationRow[] = [];
  messages: MessageRow[] = [];
  handoffs: HandoffRow[] = [];
  suppressions: SuppressionRow[] = [];
  events: { tenantId: string; event: Record<string, unknown> }[] = [];
  invalidEvents: string[] = [];
  effects: EffectAttemptRow[] = [];
  /**
   * Tenants the test has declared. An unknown tenant reads as `active`, which keeps
   * the several hundred existing fixtures working; a test that cares about archive
   * or pause declares the row.
   */
  tenants: TenantRow[] = [];

  /** Set by a test to make the next write fail the way a transient database error does. */
  failNextEmit: string | null = null;

  // ── config & routing ──
  // deno-lint-ignore require-await
  async getConfig(tenantId: string, moduleKey = 'lead_recovery') {
    return this.configs.find((c) => c.tenantId === tenantId && c.moduleKey === moduleKey) ?? null;
  }

  /** Mirrors the adapter's read of `module_config_heads` (0014): published versions only. */
  async findTenantByTwilioNumber(phone: string) {
    const tenants = [...new Set(this.moduleConfigVersions.filter((v) => v.moduleKey === 'lead_recovery').map((v) => v.tenantId))];
    const claimants: string[] = [];
    for (const tenantId of tenants) {
      const head = await this.getConfigHead(tenantId, { kind: 'module', moduleKey: 'lead_recovery' });
      if ((head?.config as { twilio?: { phone_number?: string } } | undefined)?.twilio?.phone_number === phone) {
        claimants.push(tenantId);
      }
    }
    if (claimants.length > 1) throw new Error(`${phone} is claimed by more than one tenant — refusing to guess`);
    return claimants.length === 1 ? { tenantId: claimants[0], moduleKey: 'lead_recovery' } : null;
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

  /** Mirrors `automation_runs_guard_snapshot()` (0013): a new run is pinned or refused. */
  // deno-lint-ignore require-await
  async createRun(row: Omit<RunRow, 'startedAt' | 'updatedAt'>) {
    if (!row.configSnapshotId) {
      throw new Error('automation_runs: a new run must be pinned to a configuration snapshot');
    }
    const snapshot = this.snapshots.find((s) => s.id === row.configSnapshotId && s.tenantId === row.tenantId);
    if (!snapshot) {
      throw new Error(`automation_runs: snapshot ${row.configSnapshotId} does not belong to tenant ${row.tenantId}`);
    }
    if (snapshot.moduleKey !== row.moduleKey) {
      throw new Error(`automation_runs: snapshot is for module ${snapshot.moduleKey}, not ${row.moduleKey}`);
    }
    if (!registeredSnapshotSchema(row.moduleKey, snapshot.schemaVersion)) {
      throw new Error(
        `automation_runs: schema version ${snapshot.schemaVersion} is not a registered configuration schema for ${row.moduleKey}`,
      );
    }
    /* 0014: a tenant whose configuration is versioned starts versioned runs. */
    if (!snapshot.moduleConfigVersionId && this.hasModuleVersions(row.tenantId, row.moduleKey)) {
      throw new Error(
        `automation_runs: ${row.moduleKey} configuration for this tenant is versioned, so a new run must be pinned to a snapshot that names its versions`,
      );
    }
    /* 0015: a new run states its mode, and the lifecycle must allow that mode now — a live
       run only on exactly the versions an operator authorised. */
    this.guardRunLifecycle(row);
    if (this.runs.some((r) => r.tenantId === row.tenantId && r.leadId === row.leadId && r.moduleKey === row.moduleKey)) {
      throw new Error('duplicate key value violates unique constraint "automation_runs_tenant_id_lead_id_module_key_key"');
    }
    const now = new Date().toISOString();
    const run: RunRow = { ...row, startedAt: now, updatedAt: now };
    this.runs.push(run);
    return run;
  }

  /** A run's pin and identity are fixed at creation, as the 0013 trigger enforces. */
  // deno-lint-ignore require-await
  async updateRun(tenantId: string, runId: string, patch: Partial<RunRow>) {
    const run = this.runs.find((r) => r.id === runId && r.tenantId === tenantId);
    if (!run) throw new Error(`no run ${runId} for tenant ${tenantId}`);
    for (const key of ['configSnapshotId', 'tenantId', 'leadId', 'moduleKey', 'runMode'] as const) {
      if (key in patch && patch[key] !== run[key]) {
        throw new Error(`automation_runs: ${key} is fixed when the run is created and cannot be changed`);
      }
    }
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    return run;
  }

  // ── queue ──
  /**
   * Mirrors `scheduled_actions_guard_snapshot()` (0013). The pin comes from the run —
   * derived when omitted, refused when it disagrees — and the check runs before the
   * idempotency lookup because in Postgres a BEFORE INSERT trigger fires before the
   * unique index is consulted.
   */
  // deno-lint-ignore require-await
  async scheduleAction(row: Omit<ActionRow, 'id' | 'status' | 'attempts' | 'lockedAt' | 'lockedBy' | 'leaseToken' | 'fence' | 'lastError' | 'completedAt' | 'configSnapshotId'> & { maxAttempts?: number; configSnapshotId?: string | null }) {
    const run = this.runs.find((r) => r.id === row.runId && r.tenantId === row.tenantId);
    if (!run) throw new Error(`scheduled_actions: run ${row.runId} does not belong to tenant ${row.tenantId}`);
    if (!run.configSnapshotId) {
      throw new Error(`scheduled_actions: run ${row.runId} has no configuration snapshot — nothing may be queued against it`);
    }
    if (row.configSnapshotId && row.configSnapshotId !== run.configSnapshotId) {
      throw new Error(
        `scheduled_actions: snapshot ${row.configSnapshotId} is not the snapshot of run ${row.runId} (${run.configSnapshotId})`,
      );
    }
    /* scheduled_actions_lifecycle_guard (0015): a shadow run acts on nothing. */
    if (run.runMode === 'shadow') {
      throw new LifecycleStoreError('shadow_no_effects', 'a shadow run records what would have happened and queues nothing');
    }

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
      leaseToken: null,
      fence: 0,
      configSnapshotId: run.configSnapshotId,
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

  /**
   * Claim due work, mirroring `claim_actions_internal` (0011, tightened in 0013).
   *
   * The filters that are not obvious, and that the SQL also applies: an action is
   * offered only when it and its run carry the same non-null snapshot, an action at
   * its attempt cap is never re-offered by an expired lease, and `canaryOnly`
   * restricts the claim to synthetic leads so an operator's test cannot touch real
   * work.
   */
  // deno-lint-ignore require-await
  async claimActions(options: {
    limit: number;
    worker: string;
    nowIso: string;
    leaseSeconds?: number;
    tenantId: string | null;
    canaryOnly?: boolean;
  }) {
    const { limit, worker, nowIso, tenantId, canaryOnly = false } = options;
    const leaseSeconds = options.leaseSeconds ?? 120;
    const leaseCutoff = new Date(Date.parse(nowIso) - Math.max(leaseSeconds, 30) * 1000).toISOString();

    const due = this.actions
      .filter((a) => {
        if (tenantId !== null && a.tenantId !== tenantId) return false;
        const run = this.runs.find((r) => r.id === a.runId && r.tenantId === a.tenantId);
        if (!run || !run.configSnapshotId) return false;
        if (!a.configSnapshotId || a.configSnapshotId !== run.configSnapshotId) return false;
        if (a.attempts >= a.maxAttempts) return false;
        if (canaryOnly) {
          const lead = this.leads.find((l) => l.id === run.leadId && l.tenantId === run.tenantId);
          if (!lead?.isCanary) return false;
        }
        return (
          (a.status === 'pending' && a.runAt <= nowIso) ||
          (a.status === 'claimed' && a.lockedAt !== null && a.lockedAt < leaseCutoff)
        );
      })
      .sort((a, b) => a.runAt.localeCompare(b.runAt))
      .slice(0, Math.max(1, limit));

    /* the atomic half. in Postgres the select and the update are one statement under
       `for update skip locked`; here the flip happens before anything is returned, which
       gives a second concurrent caller nothing to take. */
    for (const action of due) {
      action.status = 'claimed';
      action.lockedAt = nowIso;
      action.lockedBy = worker;
      action.leaseToken = id('lease');
      action.fence += 1;
      action.attempts += 1;
    }
    return due.map((a) => ({ ...a }));
  }

  /** Fenced on (action, tenant, lease). A stale worker changes nothing. */
  // deno-lint-ignore require-await
  async completeAction(lease: ActionLease, status: 'done' | 'failed' | 'cancelled', error: string | null, nowIso: string): Promise<StoreResult> {
    const action = this.actions.find((a) => a.id === lease.actionId);
    if (!action) return storeFail('not_found', `no action ${lease.actionId}`);
    if (action.tenantId !== lease.tenantId) return storeFail('wrong_tenant', 'that action belongs to another tenant');
    if (action.status !== 'claimed') {
      return storeFail('already_completed', `the action is ${action.status}, not claimed`);
    }
    if (action.leaseToken !== lease.leaseToken) {
      return storeFail('lost_lease', 'another worker holds this action now');
    }
    action.status = status;
    action.lastError = error;
    action.completedAt = nowIso;
    action.lockedAt = null;
    action.lockedBy = null;
    action.leaseToken = null;
    return storeOk(undefined);
  }

  // deno-lint-ignore require-await
  async rescheduleAction(lease: ActionLease, runAt: string, error: string | null): Promise<StoreResult> {
    const action = this.actions.find((a) => a.id === lease.actionId);
    if (!action) return storeFail('not_found', `no action ${lease.actionId}`);
    if (action.tenantId !== lease.tenantId) return storeFail('wrong_tenant', 'that action belongs to another tenant');
    if (action.status !== 'claimed') {
      return storeFail('already_completed', `the action is ${action.status}, not claimed`);
    }
    if (action.leaseToken !== lease.leaseToken) {
      return storeFail('lost_lease', 'another worker holds this action now');
    }
    action.status = 'pending';
    action.runAt = runAt;
    action.lastError = error;
    action.lockedAt = null;
    action.lockedBy = null;
    action.leaseToken = null;
    return storeOk(undefined);
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
    /* a legacy unpinned action could never be claimed again, so putting it back on
       the queue would only strand it there looking alive. 0013 refuses it too. */
    if (!action.configSnapshotId) return null;
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

  // ── tenant state ──
  /* an undeclared tenant reads as active: the existing fixtures predate this method
     and none of them is testing archive behaviour. a test that cares declares the row. */
  // deno-lint-ignore require-await
  async getTenant(tenantId: string): Promise<TenantRow | null> {
    return this.tenants.find((t) => t.id === tenantId) ?? { id: tenantId, status: 'active' };
  }

  // ── configuration snapshots ──
  private hasModuleVersions(tenantId: string, moduleKey: string): boolean {
    return this.moduleConfigVersions.some((v) => v.tenantId === tenantId && v.moduleKey === moduleKey);
  }

  /**
   * Mirrors 0011's table as 0014 leaves it, and `lead_recovery_config_snapshots_guard_sources()`.
   *
   * A versioned snapshot is one per (tenant version, module version) pair — a rollback
   * republishes old content as a new version, and its runs must record that version
   * rather than borrow the snapshot of the one it copied. An unversioned snapshot is
   * one per content hash, and is allowed only for a tenant with no module versions yet.
   */
  // deno-lint-ignore require-await
  async createConfigSnapshot(row: Omit<ConfigSnapshotRow, 'id' | 'createdAt'>) {
    const tenantVersionId = row.tenantConfigVersionId ?? null;
    const moduleVersionId = row.moduleConfigVersionId ?? null;
    if ((tenantVersionId === null) !== (moduleVersionId === null)) {
      throw new Error('new row violates check constraint "lead_recovery_config_snapshots_sources_paired"');
    }

    if (moduleVersionId === null) {
      if (this.hasModuleVersions(row.tenantId, row.moduleKey)) {
        throw new Error(
          `arc_config:forbidden: ${row.moduleKey} configuration for this tenant is versioned, so a snapshot must name the versions it was resolved from`,
        );
      }
      const legacy = this.snapshots.find(
        (s) => s.tenantId === row.tenantId && s.moduleConfigVersionId === null && s.configHash === row.configHash,
      );
      if (legacy) return legacy;
    } else {
      const moduleVersion = this.moduleConfigVersions.find(
        (v) => v.id === moduleVersionId && v.tenantId === row.tenantId && v.moduleKey === row.moduleKey,
      );
      const tenantVersion = this.tenantConfigVersions.find((v) => v.id === tenantVersionId && v.tenantId === row.tenantId);
      if (!moduleVersion || !tenantVersion) {
        throw new Error(`arc_config:tenant_mismatch: those versions are not this tenant's ${row.moduleKey} versions`);
      }
      if (row.configVersion !== moduleVersion.version || row.schemaVersion !== moduleVersion.schemaVersion) {
        throw new Error(
          `arc_config:validation_failed: a snapshot records its module version's number and schema (${moduleVersion.version} / ${moduleVersion.schemaVersion})`,
        );
      }
      const pinned = this.snapshots.find(
        (s) => s.tenantId === row.tenantId && s.tenantConfigVersionId === tenantVersionId && s.moduleConfigVersionId === moduleVersionId,
      );
      if (pinned) return pinned;
    }

    const snapshot: ConfigSnapshotRow = {
      ...row,
      tenantConfigVersionId: tenantVersionId,
      moduleConfigVersionId: moduleVersionId,
      id: id('snap'),
      createdAt: new Date().toISOString(),
    };
    /* frozen, because the table's trigger refuses UPDATE and DELETE outright and a
       test that mutates one here would be testing something Postgres forbids. */
    Object.freeze(snapshot.config);
    this.snapshots.push(snapshot);
    return snapshot;
  }

  // deno-lint-ignore require-await
  async getConfigSnapshot(tenantId: string, snapshotId: string) {
    return this.snapshots.find((s) => s.id === snapshotId && s.tenantId === tenantId) ?? null;
  }

  // ── external effects ──
  /**
   * Reserve a side effect, mirroring `reserve_lead_recovery_effect` in 0011.
   *
   * The insert-or-refuse shape is the send-once guarantee: whoever inserts the row
   * owns the effect. A second caller only gets to retry from a state that proves the
   * provider never took it.
   */
  // deno-lint-ignore require-await
  async reserveEffect(input: ReserveEffectInput): Promise<ReserveEffectResult> {
    /* 0015: re-read under the reservation, so a pause committed after the engine's own
       check still stops the effect. a synthetic effect must belong to a synthetic lead. */
    this.guardEffectLifecycle(input);
    const existing = this.effects.find(
      (e) => e.tenantId === input.tenantId && e.effectKey === input.effectKey,
    );

    if (!existing) {
      const attempt: EffectAttemptRow = {
        id: id('eff'),
        tenantId: input.tenantId,
        runId: input.runId ?? null,
        leadId: input.leadId ?? null,
        actionId: input.actionId ?? null,
        conversationId: input.conversationId ?? null,
        effectType: input.effectType,
        effectKey: input.effectKey,
        idempotencyKey: input.idempotencyKey,
        worker: input.worker,
        leaseToken: input.leaseToken,
        fence: 0,
        attemptNo: 1,
        provider: 'twilio',
        destinationRef: input.destinationRef ?? null,
        state: 'reserved',
        providerMessageId: null,
        errorCategory: null,
        errorDetail: null,
        retryable: null,
        isCanary: input.isCanary === true,
        reservedAt: new Date().toISOString(),
        dispatchStartedAt: null,
        acceptedAt: null,
        completedAt: null,
      };
      this.effects.push(attempt);
      return { attempt: { ...attempt }, reserved: true };
    }

    if (RETRYABLE_EFFECT_STATES.includes(existing.state)) {
      existing.state = 'reserved';
      existing.worker = input.worker;
      existing.leaseToken = input.leaseToken;
      existing.attemptNo += 1;
      existing.errorCategory = null;
      existing.errorDetail = null;
      existing.retryable = null;
      existing.dispatchStartedAt = null;
      existing.completedAt = null;
      return { attempt: { ...existing }, reserved: true };
    }

    /* reserved / dispatching / accepted / confirmed / outcome_unknown /
       reconciliation_required / failed_terminal — somebody else owns this, or it
       already happened, or we cannot prove it did not. Do not send. */
    return { attempt: { ...existing }, reserved: false };
  }

  // deno-lint-ignore require-await
  async settleEffect(args: {
    attemptId: string;
    tenantId: string;
    leaseToken: string;
    state: EffectState;
    providerMessageId?: string | null;
    errorCategory?: string | null;
    errorDetail?: string | null;
    retryable?: boolean | null;
    nowIso: string;
  }): Promise<StoreResult> {
    const attempt = this.effects.find((e) => e.id === args.attemptId);
    if (!attempt) return storeFail('not_found', `no effect attempt ${args.attemptId}`);
    if (attempt.tenantId !== args.tenantId) return storeFail('wrong_tenant', 'that attempt belongs to another tenant');
    if (attempt.leaseToken !== args.leaseToken) {
      return storeFail('lost_lease', 'this attempt was reserved under a different lease');
    }
    attempt.state = args.state;
    if (args.providerMessageId) attempt.providerMessageId = args.providerMessageId;
    attempt.errorCategory = args.errorCategory ?? null;
    attempt.errorDetail = args.errorDetail ?? null;
    attempt.retryable = args.retryable ?? null;
    if (args.state === 'dispatching') attempt.dispatchStartedAt ??= args.nowIso;
    if (args.state === 'accepted' || args.state === 'confirmed') attempt.acceptedAt ??= args.nowIso;
    if (['confirmed', 'rejected', 'failed_terminal', 'cancelled_before_send'].includes(args.state)) {
      attempt.completedAt = args.nowIso;
    }
    return storeOk(undefined);
  }

  // deno-lint-ignore require-await
  async getEffectByKey(tenantId: string, effectKey: string) {
    const found = this.effects.find((e) => e.tenantId === tenantId && e.effectKey === effectKey);
    return found ? { ...found } : null;
  }

  // deno-lint-ignore require-await
  async recordEffectDelivery(args: {
    tenantId: string;
    providerMessageId: string;
    state: 'accepted' | 'confirmed' | 'failed_terminal';
    errorCategory?: string | null;
    errorDetail?: string | null;
    nowIso: string;
  }): Promise<StoreResult> {
    const attempt = this.effects.find(
      (e) => e.tenantId === args.tenantId && e.providerMessageId === args.providerMessageId,
    );
    if (!attempt) return storeFail('not_found', 'no attempt carries that provider reference');
    /* a duplicate callback is a no-op rather than a churn, and a late one cannot
       reopen something that was rejected or cancelled before it ever went out. */
    if (attempt.state === args.state) return storeFail('invalid_state', 'already in that state');
    if (attempt.state === 'rejected' || attempt.state === 'cancelled_before_send') {
      return storeFail('invalid_state', `a ${attempt.state} attempt cannot be reopened by a callback`);
    }
    attempt.state = args.state;
    if (args.errorCategory) attempt.errorCategory = args.errorCategory;
    if (args.errorDetail) attempt.errorDetail = args.errorDetail;
    if (args.state === 'confirmed' || args.state === 'failed_terminal') attempt.completedAt = args.nowIso;
    return storeOk(undefined);
  }

  // deno-lint-ignore require-await
  async listOpenEffects(tenantId: string, limit: number) {
    return this.effects
      .filter((e) => e.tenantId === tenantId && AMBIGUOUS_EFFECT_STATES.includes(e.state))
      .slice(0, limit)
      .map((e) => ({ ...e }));
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
