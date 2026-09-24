/**
 * The engine.
 *
 * One tenant-aware implementation of Lead Recovery, shared by every customer and by every
 * entry point. A missed call, a website form and an inbound text all arrive here, and from
 * the second line of `intakeLead` onwards there is no code that knows which one it was —
 * which is the point. "Process website-form leads through the same engine" is not a
 * statement about tidiness; it is what makes a fix to the stop-on-reply rule apply to both
 * paths instead of one.
 *
 * Read in this order:
 *
 *   intakeLead            a lead exists. decide whether to speak, and queue it.
 *   handleInboundMessage  the customer said something. stop, or classify.
 *   handleMessageStatus   the provider said what happened to a message we sent.
 *   runDueActions         the dispatcher: claim, re-check, act, record, retry.
 *
 * The four operator entry points — take over, resolve, book, close — are at the bottom and
 * are deliberately thin: they are the same state transitions the automation uses, with a
 * person named as the actor.
 *
 * Two invariants hold everywhere in this file:
 *
 * 1. **Nothing sends without re-reading state from the store first.** A decision made when
 *    an action was queued is a decision about the past. The gap between queueing tomorrow's
 *    follow-up and sending it is exactly where the STOP arrives.
 *
 * 2. **A canary can never reach a handset.** `senderFor()` is the only way to obtain a
 *    sender and it switches on `lead.isCanary`, so the guarantee is structural rather than
 *    a check somebody has to remember at each call site.
 */

import {
  applyClassification,
  type Classifier,
  type ClassificationDecision,
} from '../classifier.ts';
import { eventKey } from '../event-writer.ts';
import { canonicalJson, configHash } from '../canonical-json.ts';
import { type Resolution } from '../config/compose.ts';
import { resolveEffectiveConfig } from '../config/engine.ts';
import { authorizeModuleExecution, type ExecutionDecision } from '../lifecycle/authorize.ts';
import { safeSummary } from '../lifecycle/engine.ts';
import { EXECUTION_DENIAL_CODES, type ExecutionDenialCode, LifecycleStoreError, type RunMode } from '../lifecycle/model.ts';
import { type LeadRecoveryConfig } from '../lead-recovery-config.ts';
import { validatorFor } from '../registry/index.ts';
import { normaliseEmail, normalisePhone, maskPhone } from '../phone.ts';
import { isMissedCall, type SendResult, type TwilioSender } from '../twilio.ts';
import { assessSafety } from './rules.ts';
import { classifyReply } from './rules.ts';
import {
  decideFirstResponse,
  renderFollowup,
  renderHandoffAck,
  renderStaffAlert,
} from './templates.ts';
import {
  isTerminal,
  maySend,
  transition,
  type RunState,
  type StopReason,
} from './state-machine.ts';
import {
  AMBIGUOUS_EFFECT_STATES,
  type ActionLease,
  type ActionRow,
  type ActionType,
  type ConfigSnapshotRow,
  type EffectAttemptRow,
  type EffectType,
  type EngineStore,
  type LeadRow,
  type RunRow,
} from './store.ts';

export const MODULE_KEY = 'lead_recovery';

/**
 * The trusted validator for this module, resolved through the registry (ARC-100).
 *
 * The engine used to import `validateLeadRecoveryConfig` by name. It now asks the
 * registry which validator belongs to `lead_recovery`, and the registry answers with
 * that same function — so nothing about what is accepted or rejected changes, and the
 * registry is load-bearing rather than decorative. A module with no registered
 * validator resolves to null and its configuration is refused outright; there is
 * deliberately no permissive fallback.
 */
function validateConfig(input: unknown) {
  const validate = validatorFor(MODULE_KEY);
  if (!validate) {
    return { ok: false as const, errors: [`no validator is registered for ${MODULE_KEY}`] };
  }
  return validate(input);
}

/** How long after the first response we chase, if nothing came back. One follow-up, once. */
export const FOLLOWUP_AFTER_MINUTES = 60;

/** How long a lead with no reply and no handoff stays open before it closes itself. */
export const CLOSE_AFTER_HOURS = 72;

/** The backoff schedule. Bounded, and deliberately not jittered — a deterministic retry
    time is one an operator can read off the queue and wait for. */
export const RETRY_BASE_SECONDS = 60;
export const RETRY_CEILING_SECONDS = 1800;

export function backoffSeconds(attempts: number): number {
  return Math.min(RETRY_CEILING_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Actions that put a person on a lead or close it — bookkeeping that stays safe when a
 * module stops. Every message one of them would send still passes its own gate. The same
 * list 0015's pause leaves on the queue.
 */
const BOOKKEEPING: ActionType[] = ['open_handoff', 'close_run'];
/** Everything else: what reaches somebody, or decides who gets reached. */
const CONTACT_ACTIONS: ActionType[] = ['send_first_response', 'send_followup', 'classify_reply', 'route_to_contractor', 'notify_staff'];

/* ── dependencies ───────────────────────────────────────── */

export interface EngineDeps {
  store: EngineStore;
  now(): Date;
  /** the real provider. never used for a canary — see senderFor(). */
  liveSender: TwilioSender;
  /**
   * the sender a synthetic run gets.
   *
   * Given as a dependency rather than chosen inside a branch so a deployment cannot end up
   * with a canary path that quietly falls back to the live sender when something is
   * undefined. If it is missing, a canary refuses to send at all.
   */
  canarySender: TwilioSender | null;
  classifierFor(config: LeadRecoveryConfig): Classifier;
  /** absolute urls. built from configured secrets, never from a request header. */
  urls?: {
    statusCallback?: string | null;
    leadInConsole?(tenantId: string, leadId: string): string | null;
  };
  uuid(): string;
  worker?: string;
}

/* ── small helpers ──────────────────────────────────────── */

const iso = (at: Date) => at.toISOString();

/**
 * A UUID derived from what it identifies rather than from randomness.
 *
 * This is what makes a redelivered Twilio callback create one lead instead of two, without
 * a second column or a lookup table: the correlation id for `CallSid CAxxx` on tenant T is
 * always the same uuid, so the second insert collides with the unique index and the engine
 * reads back the lead that already exists.
 *
 * SHA-256 folded into the v4 layout — not a real RFC 4122 v5 (which wants SHA-1 and a
 * namespace uuid), and it does not need to be. It needs to be stable, well distributed and
 * shaped like a uuid, and it is all three.
 */
export async function deterministicUuid(...parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join('␟'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

export interface LoadedConfig {
  /** `enabled` is the module switch; `configVersion` the published module version's number. */
  row: { enabled: boolean; configVersion: number };
  config: LeadRecoveryConfig;
  /** exactly which published versions were composed, and the hash of the result (ARC-110). */
  resolution: Resolution;
}

/* ── configuration snapshots (ARC-015, sourced from ARC-110 versions) ── */

/* moved to ../canonical-json.ts so the version store can hash the same way without
   importing the engine; re-exported so every existing caller keeps its import. */
export { canonicalJson, configHash };

/**
 * Freeze the configuration a run is about to begin under.
 *
 * Before ARC-015 a run stored `config_version`, a counter, and then every action
 * reloaded whatever `module_configs` currently held — so the pin recorded a number
 * and proved nothing. This writes the payload itself, hashed, and the run points at
 * it.
 *
 * Since ARC-110 the payload is the resolver's output and the snapshot records the two
 * published versions it was composed from, so "which tenant settings, which module
 * version, which schema, what exact document" is one row away from every run and every
 * action pinned to it. A thousand runs under one pair of versions share one snapshot.
 */
export async function snapshotConfig(
  store: EngineStore,
  tenantId: string,
  loaded: LoadedConfig,
): Promise<ConfigSnapshotRow> {
  const { resolution } = loaded;
  return await store.createConfigSnapshot({
    tenantId,
    moduleKey: MODULE_KEY,
    configVersion: resolution.moduleVersion.version,
    /* the module version's schema, which the resolver has already required to be the
       registry's schema for this module — what 0013 checks a new run's snapshot against. */
    schemaVersion: resolution.moduleVersion.schemaVersion,
    config: resolution.config,
    configHash: resolution.configHash,
    tenantConfigVersionId: resolution.tenantVersion.id,
    moduleConfigVersionId: resolution.moduleVersion.id,
  });
}

/**
 * Resolve the configuration a *running* sequence is bound to.
 *
 * This is the half of the pinning rule that controls ordinary behaviour: templates,
 * hours, service area, forwarding. It reads the run's frozen snapshot and never the
 * mutable row. The other half — live suppression, replies, takeover, tenant status —
 * is re-read fresh in `authorizeLeadRecoveryEffect`, and it overrides this.
 *
 * A run with no snapshot cannot be executed. The claim functions already refuse to
 * offer one, so this is the second line rather than the first.
 */
export async function loadPinnedConfig(
  store: EngineStore,
  run: RunRow,
): Promise<{ ok: true; config: LeadRecoveryConfig; snapshot: ConfigSnapshotRow } | { ok: false; reason: string }> {
  if (!run.configSnapshotId) {
    return {
      ok: false,
      reason: 'this run has no configuration snapshot — it predates ARC-015 and may not send',
    };
  }
  const snapshot = await store.getConfigSnapshot(run.tenantId, run.configSnapshotId);
  if (!snapshot) {
    return { ok: false, reason: 'the configuration snapshot this run was pinned to is missing' };
  }
  /* validated on read, exactly as `loadConfig` validates the mutable row. a snapshot
     written by an older validator must not be able to put the engine into a state
     today's validator would refuse. */
  const result = validateConfig(snapshot.config);
  if (!result.ok) {
    return {
      ok: false,
      reason: `the pinned configuration is not valid: ${result.errors.slice(0, 3).join('; ')}`,
    };
  }
  return { ok: true, config: result.config, snapshot };
}

/**
 * Load and validate a tenant's configuration — what a *new* run would start under.
 *
 * Since ARC-110 this is the canonical resolver's answer and nothing else: the tenant's
 * published settings composed with its published Lead Recovery version, validated by
 * the registered schema on every read. It never reads a draft or the frozen
 * `module_configs.config`; that row contributes only the switch. No published version
 * means no configuration, and a lead that arrives then is recorded with no run —
 * there is no default to fall back to.
 */
export async function loadConfig(
  store: EngineStore,
  tenantId: string,
): Promise<{ ok: true; loaded: LoadedConfig } | { ok: false; reason: string; enabled: boolean }> {
  const [row, resolution] = await Promise.all([
    store.getConfig(tenantId, MODULE_KEY),
    resolveEffectiveConfig(store, tenantId, MODULE_KEY),
  ]);
  const enabled = row?.enabled ?? false;
  if (!resolution.ok) return { ok: false, enabled, reason: resolution.message };

  return {
    ok: true,
    loaded: {
      row: { enabled, configVersion: resolution.moduleVersion.version },
      config: resolution.config as unknown as LeadRecoveryConfig,
      resolution,
    },
  };
}

/** The one place a sender is chosen. A canary cannot be given the live one. */
function senderFor(deps: EngineDeps, lead: { isCanary: boolean }): TwilioSender | null {
  return lead.isCanary ? deps.canarySender : deps.liveSender;
}

/** The lease a claimed action carries, in the shape the fenced writes want. */
export function leaseOf(action: ActionRow): ActionLease | null {
  if (!action.leaseToken) return null;
  return { actionId: action.id, tenantId: action.tenantId, leaseToken: action.leaseToken };
}

/* ── just-in-time authorisation (ARC-015) ───────────────── */

/**
 * Why an effect was refused. Every one of these is a fact read fresh, not a pin.
 *
 * Since ARC-120 the module's own switch (`module_off`) is the lifecycle's answer, and any
 * of its stable codes (`module_paused`, `requirements_pending`, `health_blocks_execution`…)
 * can appear here.
 */
export type EffectDenial =
  | 'no_lease'
  | 'tenant_missing'
  | 'tenant_archived'
  | 'tenant_paused'
  | 'run_terminal'
  | 'run_not_sendable'
  | 'action_not_claimed'
  | 'suppressed'
  | 'customer_replied'
  | 'handoff_open'
  | 'lead_closed'
  | 'lead_booked'
  | 'no_consent'
  | 'compliance_not_approved'
  | 'no_destination'
  | 'no_sender'
  | 'already_attempted'
  | 'ambiguous_outcome'
  | 'config_unpinned'
  | ExecutionDenialCode;

export interface EffectPermit {
  attempt: EffectAttemptRow;
  lease: ActionLease;
  sender: TwilioSender;
  config: LeadRecoveryConfig;
}

export type AuthorizeResult =
  | { ok: true; permit: EffectPermit }
  | { ok: false; denial: EffectDenial; detail: string; terminal: boolean };

const deny = (denial: EffectDenial, detail: string, terminal = true): AuthorizeResult =>
  ({ ok: false, denial, detail, terminal });

/**
 * The one gate every outbound message passes through.
 *
 * Two things happen here and they happen in this order for a reason.
 *
 * **First, the live re-read.** Everything the engine believed when it queued the
 * action is treated as stale: the tenant may have been archived, the customer may
 * have texted STOP, a person may have taken the lead over. `CLAUDE.md` puts it as
 * "nothing sends without re-reading state first", and the gap between queueing
 * tomorrow's follow-up and sending it is exactly where the STOP arrives. Pinned
 * configuration governs *what* the message says; it never governs *whether* it goes.
 *
 * **Then, the reservation.** Only after every guard passes does the effect get
 * reserved, and only the caller that wins the reservation may call the provider. A
 * second worker — a lease race, a redelivery, a retry after an ambiguous timeout —
 * finds the row already held and is refused. That is the send-once boundary, and it
 * is a unique index rather than a promise.
 *
 * Returning a permit that *contains* the sender is deliberate: a provider adapter
 * cannot be called with a bare action, so there is no path that sends without having
 * come through here.
 */
export async function authorizeLeadRecoveryEffect(
  deps: EngineDeps,
  args: {
    action: ActionRow;
    run: RunRow;
    lead: LeadRow;
    config: LeadRecoveryConfig;
    effectType: EffectType;
    /** stable identity of the side effect — never varies by attempt. */
    effectKey: string;
    destination: string | null;
    now: Date;
    /** a staff alert is not gated on the customer's reply or the lead's closure. */
    customerFacing?: boolean;
  },
): Promise<AuthorizeResult> {
  const { store } = deps;
  const { action, run, lead, config, now } = args;
  const customerFacing = args.customerFacing !== false;

  const lease = leaseOf(action);
  if (!lease) return deny('no_lease', 'this action is not held under a lease — refusing to send');
  if (action.status !== 'claimed') {
    return deny('action_not_claimed', `the action is ${action.status}, not claimed`);
  }

  /* ── the tenant. 0010 never asked, so a deboarded client kept being messaged. ── */
  const tenant = await store.getTenant(action.tenantId);
  if (!tenant) return deny('tenant_missing', 'this tenant no longer exists');
  if (tenant.status === 'archived') {
    return deny('tenant_archived', 'this client has been archived — nothing further is sent on their behalf');
  }
  if (tenant.status === 'paused') {
    return deny('tenant_paused', 'this client is paused — nothing is sent while they are');
  }

  /* ── the run ── */
  if (isTerminal(run.state)) return deny('run_terminal', `the run is ${run.state} — nothing further is sent`);
  if (!maySend(run.state)) {
    return deny('run_not_sendable', `the run is ${run.state} — a person has this, so the automation stays quiet`);
  }

  /* ── the lifecycle, just in time (ARC-120). the run's own mode decides what may happen:
     a live run needs the module active and the sending capability proven now; a synthetic
     run needs the module under test and never gets a live sender. this replaces the old
     master switch, which the lifecycle now drives. ── */
  const lifecycle = await authorizeModuleExecution(store, {
    kind: 'effect',
    tenantId: action.tenantId,
    moduleKey: run.moduleKey,
    lead,
    run,
    action,
    config: config as unknown as Record<string, unknown>,
    capability: 'send_sms',
  });
  if (!lifecycle.allowed) return deny(lifecycle.code, lifecycle.detail, lifecycle.terminal);

  /* ── the customer's own state ── */
  if (customerFacing) {
    if (lead.status === 'closed') return deny('lead_closed', 'this lead is closed');
    if (lead.bookingOutcome === 'booked' && action.actionType === 'send_followup') {
      return deny('lead_booked', 'this lead is already booked — no follow-up is sent');
    }
    if (!lead.consentSms) {
      return deny('no_consent', 'there is no recorded SMS consent for this lead');
    }
    const openHandoff = await store.getOpenHandoff(action.tenantId, lead.id);
    if (openHandoff) return deny('handoff_open', 'a person has taken this lead over');

    /* a reply stops the sequence. checked for first responses too, not only
       follow-ups: a customer who texts in during the queue delay has still replied. */
    const conversation = await store.getOrCreateConversation(action.tenantId, lead.id);
    if (conversation.lastInboundAt) {
      return deny('customer_replied', 'the customer replied before this message fired');
    }
  }

  if (config.compliance.status !== 'approved') {
    return deny('compliance_not_approved', `messaging compliance is "${config.compliance.status}"`);
  }

  const destination = args.destination;
  if (!destination) return deny('no_destination', 'there is no number to send to');

  /* suppression last among the reads, so it is the freshest thing checked before the
     reservation. applies to staff alerts too — somebody who left and texted STOP
     does not keep getting lead alerts. */
  const suppression = await store.isSuppressed(action.tenantId, 'sms', destination, iso(now));
  if (suppression) {
    return deny('suppressed', `this number is suppressed (${suppression.reason}) — nothing was sent`);
  }

  const sender = senderFor(deps, lead);
  if (!sender) {
    return deny('no_sender', 'no sender is configured for a synthetic run — refusing to fall back to the live one');
  }

  /* ── the reservation. the database re-reads the lifecycle under a row lock in the same
     transaction (0015), so a pause committed after the check above still stops this. ── */
  let reservation: Awaited<ReturnType<EngineStore['reserveEffect']>>;
  try {
    reservation = await store.reserveEffect({
      tenantId: action.tenantId,
      effectKey: args.effectKey,
      effectType: args.effectType,
      /* stable across attempts. the provider gets this where it supports idempotency,
         and it is what stops ARC and a provider-side retry duplicating each other. */
      idempotencyKey: args.effectKey,
      worker: action.lockedBy ?? deps.worker ?? 'dispatcher',
      leaseToken: lease.leaseToken,
      runId: run.id,
      leadId: lead.id,
      actionId: action.id,
      conversationId: null,
      destinationRef: maskPhone(destination),
      isCanary: lead.isCanary,
    });
  } catch (error) {
    if (error instanceof LifecycleStoreError) return deny(error.code as EffectDenial, error.message);
    throw error;
  }
  const { attempt, reserved } = reservation;

  if (!reserved) {
    if (AMBIGUOUS_EFFECT_STATES.includes(attempt.state)) {
      return deny(
        'ambiguous_outcome',
        `an earlier attempt at this message is ${attempt.state} — refusing to send again until it is resolved`,
      );
    }
    return deny('already_attempted', `this message has already been ${attempt.state}`);
  }

  return { ok: true, permit: { attempt, lease, sender, config } };
}

function baseEvent(lead: LeadRow, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    occurred_at: new Date().toISOString(),
    correlation_id: lead.correlationId,
    entity_type: 'lead',
    entity_id: lead.correlationId,
    source_system: lead.source === 'web_form' ? 'manual' : 'twilio',
    workflow_id: 'arc_lead_recovery',
    is_canary: lead.isCanary,
    actor: 'automation',
    ...overrides,
  };
}

/* ── intake ─────────────────────────────────────────────── */

export interface IntakeInput {
  tenantId: string;
  source: LeadRow['source'];
  /** stable per real-world occurrence: a Twilio CallSid, a form submission id. */
  externalRef: string;
  phone?: string | null;
  email?: string | null;
  customerName?: string | null;
  serviceRequest?: string | null;
  zip?: string | null;
  locationText?: string | null;
  intakeRef?: string | null;
  consentSms?: boolean;
  consentSource?: LeadRow['consentSource'];
  isCanary?: boolean;
  occurredAt?: Date;
}

export interface IntakeResult {
  ok: boolean;
  created: boolean;
  lead: LeadRow | null;
  run: RunRow | null;
  /** what the engine decided to do, in a sentence, for the ops console and the logs. */
  outcome: string;
  queued: ActionType[];
}

/**
 * A lead exists. Decide what happens.
 *
 * Idempotent by construction: the correlation id is derived from `externalRef`, so the
 * second delivery of the same webhook finds the lead already there and returns it with
 * `created: false` having queued nothing. That is the mechanism behind "duplicate Twilio
 * callbacks must not duplicate leads, runs or messages" — not a de-dup table, not a
 * timestamp window, a unique index on a value that cannot differ between the two calls.
 */
export async function intakeLead(deps: EngineDeps, input: IntakeInput): Promise<IntakeResult> {
  const { store } = deps;
  const now = input.occurredAt ?? deps.now();
  const phone = normalisePhone(input.phone);
  const email = normaliseEmail(input.email);
  const isCanary = input.isCanary === true;

  const correlationId = await deterministicUuid(input.tenantId, MODULE_KEY, input.source, input.externalRef);

  const existing = await store.getLeadByCorrelation(input.tenantId, correlationId);
  if (existing) {
    const run = await store.getRunForLead(input.tenantId, existing.id, MODULE_KEY);
    return {
      ok: true,
      created: false,
      lead: existing,
      run,
      outcome: 'already recorded — this is a repeat delivery of the same event',
      queued: [],
    };
  }

  const loaded = await loadConfig(store, input.tenantId);

  /* the lead is recorded either way. a tenant whose module is off or misconfigured still
     had somebody try to reach them, and throwing that away to keep the table tidy would
     lose the one fact the client most needs when they ask why nothing happened. */
  const lead = await store.createLead({
    id: deps.uuid(),
    tenantId: input.tenantId,
    correlationId,
    source: input.source,
    intakeRef: input.intakeRef ?? null,
    customerName: input.customerName?.trim() || null,
    phone,
    email,
    serviceRequest: input.serviceRequest?.trim() || null,
    locationZip: input.zip?.trim() || null,
    locationText: input.locationText?.trim() || null,
    urgency: null,
    safetyFlags: [],
    aiSummary: null,
    status: 'new',
    consentSms: input.consentSms === true,
    consentSource: input.consentSource ?? null,
    consentAt: input.consentSms === true ? iso(now) : null,
    assignedTo: null,
    bookingOutcome: null,
    bookedAt: null,
    isCanary,
  });

  await store.getOrCreateConversation(input.tenantId, lead.id);

  /* the evidence, in the shape the portal has always read. `call_missed` first so the
     thread's first step is the call, not the lead it produced. */
  const events: Record<string, unknown>[] = [];
  if (input.source === 'missed_call') {
    events.push(
      baseEvent(lead, {
        event_type: 'call_missed',
        occurred_at: iso(now),
        event_key: eventKey('lr', 'call_missed', correlationId),
        payload: { from: phone, caller: lead.customerName, intake: lead.intakeRef },
      }),
    );
  }
  events.push(
    baseEvent(lead, {
      event_type: 'lead_received',
      occurred_at: iso(new Date(now.getTime() + (input.source === 'missed_call' ? 1000 : 0))),
      event_key: eventKey('lr', 'lead_received', correlationId),
      payload: {
        source: input.source,
        caller: lead.customerName,
        phone,
        loss_type: lead.serviceRequest,
        zip: lead.locationZip,
      },
    }),
  );

  /* ── may we speak at all? ──
     no valid configuration means there is nothing to pin, and a run that cannot prove
     which configuration it began under is refused outright (0013). so the lead and its
     evidence are recorded — somebody did try to reach this business — and no run is
     started for it. the ending is still written down, keyed on the lead, so the thread
     says why nothing happened. */
  if (!loaded.ok) {
    events.push(
      baseEvent(lead, {
        event_type: 'automation_completed',
        occurred_at: iso(deps.now()),
        status: 'success',
        event_key: eventKey('lr', 'run_end', correlationId, 'not_permitted'),
        payload: { stop_reason: 'not_permitted', detail: loaded.reason.slice(0, 300), started: false },
      }),
    );
    await store.emit(input.tenantId, events);
    return { ok: false, created: true, lead, run: null, outcome: loaded.reason, queued: [] };
  }

  /* ── may a run start, and in which mode? (ARC-120) ──
     decided now, from the lifecycle as it stands at this moment, never from what a console
     showed when the number was set up. a synthetic lead is a test: it proves the pipeline
     before the module is live and cannot reach a handset (`senderFor()`). a real lead is
     live — which needs the module active on exactly these versions — or shadow while the
     module is gathering shadow evidence. every gate below still applies to all three. */
  const resolution = loaded.loaded.resolution;
  const lifecycle = await store.getLifecycle(input.tenantId, MODULE_KEY);
  const requested: RunMode = isCanary ? 'test' : lifecycle?.state === 'shadow' ? 'shadow' : 'live';
  const authorization = await authorizeModuleExecution(store, {
    kind: 'start',
    mode: requested,
    tenantId: input.tenantId,
    moduleKey: MODULE_KEY,
    lead,
    versions: { tenantVersionId: resolution.tenantVersion.id, moduleVersionId: resolution.moduleVersion.id },
    config: resolution.config,
  });

  /* nothing authorises a run, so none is created: the lead and the reason are recorded,
     keyed on the lead, exactly as for a tenant with no valid configuration. */
  const refused = async (code: string, detail: string): Promise<IntakeResult> => {
    events.push(
      baseEvent(lead, {
        event_type: 'automation_completed',
        occurred_at: iso(deps.now()),
        status: 'success',
        event_key: eventKey('lr', 'run_end', correlationId, 'not_permitted'),
        payload: { stop_reason: 'not_permitted', detail: `${code}: ${detail}`.slice(0, 300), started: false },
      }),
    );
    await store.emit(input.tenantId, events);
    return { ok: false, created: true, lead, run: null, outcome: detail, queued: [] };
  };
  if (!authorization.allowed) return await refused(authorization.code, authorization.detail);

  /* freeze the rules this run will live under, before anything is queued against it.
     the run is created already pinned — the store refuses one that is not — and every
     action queued against it inherits the same snapshot. */
  const snapshot = await snapshotConfig(store, input.tenantId, loaded.loaded);

  let run: RunRow;
  try {
    run = await store.createRun({
      id: deps.uuid(),
      tenantId: input.tenantId,
      leadId: lead.id,
      moduleKey: MODULE_KEY,
      state: 'new',
      configVersion: loaded.loaded.row.configVersion,
      configSnapshotId: snapshot.id,
      /* the mode the lifecycle allowed, fixed on the run. the database authorises it again
         in this insert, under a lock on the lifecycle (0015). */
      runMode: authorization.mode,
      stoppedAt: null,
      completedAt: null,
      stopReason: null,
      lastError: null,
    });
  } catch (error) {
    /* the lifecycle moved between the check above and the insert — a pause landing in
       between is refused by the database, and handled as the refusal it is. */
    if (error instanceof LifecycleStoreError) return await refused(error.code, error.message);
    throw error;
  }

  await store.emit(input.tenantId, events);

  const config = loaded.loaded.config;

  if (authorization.mode === 'shadow') {
    return await evaluateInShadow(deps, { lead, run, config, snapshot, phone, now, authorization });
  }

  const suppression = phone ? await store.isSuppressed(input.tenantId, 'sms', phone, iso(now)) : null;
  if (suppression) {
    const why = `this number is on the suppression list (${suppression.reason}) — nothing was sent`;
    await store.updateLead(input.tenantId, lead.id, { status: 'suppressed' });
    await stopRun(deps, lead, run, 'opted_out', why);
    return { ok: false, created: true, lead, run, outcome: why, queued: [] };
  }

  // ── the deterministic safety pass, before any model ──
  const safety = assessSafety(
    [lead.serviceRequest, lead.locationText].filter(Boolean).join(' '),
    {
      emergencyKeywords: config.safety.emergency_keywords,
      alwaysHandoffServices: config.safety.always_handoff_services,
      requestedService: lead.serviceRequest,
    },
  );

  if (safety.requiresHuman) {
    /* a safety case does not go into a qualification sequence. it goes to a person, now,
       and the customer gets the reviewed acknowledgement rather than a question. */
    await store.updateLead(input.tenantId, lead.id, {
      safetyFlags: safety.flags,
      urgency: 'emergency',
      status: 'handoff_required',
    });
    await moveRun(deps, lead, run, 'handoff_required');
    const queued = await queue(deps, run, 'open_handoff', now, {
      reason: safety.reasons.join('; ') || 'a safety category was detected in the enquiry',
      reason_code: 'safety',
      is_safety: true,
      send_ack: true,
    });
    return {
      ok: true,
      created: true,
      lead,
      run,
      outcome: 'safety rules fired at intake — handed to a person without an automated reply',
      queued: queued ? ['open_handoff'] : [],
    };
  }

  // ── the first response ──
  const decision = decideFirstResponse(config, now, lead.customerName);
  if (!decision.send) {
    await stopRun(deps, lead, run, 'not_permitted', decision.reason);
    return { ok: false, created: true, lead, run, outcome: decision.reason, queued: [] };
  }

  await moveRun(deps, lead, run, 'response_queued');
  await queue(deps, run, 'send_first_response', decision.sendAt, {
    body: decision.body,
    template: decision.templateKey,
    to: phone,
    /* the time the lead landed, so the response-time figure is measured from the customer's
       moment rather than from whenever a worker happened to pick the action up. */
    lead_at: iso(now),
  });

  return {
    ok: true,
    created: true,
    lead,
    run,
    outcome: decision.reason,
    queued: ['send_first_response'],
  };
}

/* ── shadow mode (ARC-120) ──────────────────────────────── */

/**
 * A real lead, judged exactly as the module would judge it live — suppression, the
 * deterministic safety rules, the first-response decision under the pinned configuration —
 * with nothing sent and nothing queued.
 *
 * Structurally incapable of an external effect: no sender is chosen, no action is
 * scheduled (the database refuses one against a shadow run), no effect is reserved (the
 * reservation refuses anything but a live run), and the run is closed before this returns.
 * What it produces is a "would have" — recorded as simulated evidence bound to the pinned
 * versions, and in the lead's thread as `automation_completed` with `not_permitted`, the
 * same ending a lead gets when nothing is switched on. It is never an `sms_sent`, never a
 * booking and never a figure.
 */
async function evaluateInShadow(
  deps: EngineDeps,
  args: {
    lead: LeadRow;
    run: RunRow;
    config: LeadRecoveryConfig;
    snapshot: ConfigSnapshotRow;
    phone: string | null;
    now: Date;
    authorization: ExecutionDecision;
  },
): Promise<IntakeResult> {
  const { store } = deps;
  const { lead, run, config, snapshot, phone, now } = args;

  let wouldHave: 'nothing' | 'handoff' | 'send_first_response';
  let reasonCode: string;
  let detail: string;
  const extra: Record<string, unknown> = {};

  const suppression = phone ? await store.isSuppressed(lead.tenantId, 'sms', phone, iso(now)) : null;
  if (suppression) {
    wouldHave = 'nothing';
    reasonCode = 'suppressed';
    detail = 'the number is on the suppression list, so nothing would have been sent';
  } else {
    const safety = assessSafety(
      [lead.serviceRequest, lead.locationText].filter(Boolean).join(' '),
      {
        emergencyKeywords: config.safety.emergency_keywords,
        alwaysHandoffServices: config.safety.always_handoff_services,
        requestedService: lead.serviceRequest,
      },
    );
    if (safety.requiresHuman) {
      wouldHave = 'handoff';
      reasonCode = 'safety';
      detail = 'the safety rules would have handed this to a person';
      extra.safety_flags = safety.flags.length;
    } else {
      const first = decideFirstResponse(config, now, lead.customerName);
      if (first.send) {
        wouldHave = 'send_first_response';
        reasonCode = 'first_response';
        detail = `would have texted the customer (${first.templateKey})`;
        extra.template = first.templateKey;
        extra.delay_seconds = Math.max(0, Math.round((first.sendAt.getTime() - now.getTime()) / 1000));
      } else {
        wouldHave = 'nothing';
        reasonCode = 'not_permitted';
        detail = first.reason;
      }
    }
  }

  const why = `shadow mode — ${detail}; nothing was sent`;
  await stopRun(deps, lead, run, 'not_permitted', why);

  let recorded = true;
  try {
    await store.recordShadowObservation({
      tenantId: lead.tenantId,
      moduleKey: MODULE_KEY,
      evidence: {
        kind: 'shadow_observation',
        outcome: 'observed',
        runMode: 'shadow',
        versions: { tenantVersionId: snapshot.tenantConfigVersionId!, moduleVersionId: snapshot.moduleConfigVersionId! },
        configHash: snapshot.configHash,
        capabilities: [],
        runId: run.id,
        summary: safeSummary({ would_have: wouldHave, reason_code: reasonCode, source: lead.source, ...extra }),
      },
    });
  } catch (error) {
    /* the module left shadow between this lead arriving and the record being written. the
       run is already closed and nothing was sent; the observation is simply not kept. */
    if (!(error instanceof LifecycleStoreError)) throw error;
    recorded = false;
  }

  return {
    ok: true,
    created: true,
    lead,
    run,
    outcome: recorded ? why : `${why} (not recorded as shadow evidence: the module left shadow)`,
    queued: [],
  };
}

/* ── the missed-call decision ───────────────────────────── */

/**
 * Did this call need recovering?
 *
 * Its own exported function because it is the single most consequential branch in the
 * module and it should be readable, and testable, without a database. An answered call
 * produces nothing at all — no lead, no run, no message. Texting "sorry we missed you" to
 * somebody who has just spoken to you is worse than staying quiet.
 */
export function shouldRecoverCall(dialCallStatus: string | null | undefined): boolean {
  return isMissedCall(dialCallStatus);
}

/* ── inbound messages ───────────────────────────────────── */

export interface InboundMessageInput {
  tenantId: string;
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
  occurredAt?: Date;
}

export interface InboundResult {
  ok: boolean;
  duplicate: boolean;
  lead: LeadRow | null;
  intent: string;
  outcome: string;
  cancelled: number;
}

/**
 * The customer said something.
 *
 * The order here is the safety argument. Recording the message and cancelling pending
 * automation both happen **before** anything is classified, because both must happen even
 * if the classifier is slow, unavailable or under attack. The rule "cancel follow-ups
 * after any substantive customer reply" cannot be conditional on a model answering.
 */
export async function handleInboundMessage(deps: EngineDeps, input: InboundMessageInput): Promise<InboundResult> {
  const { store } = deps;
  const now = input.occurredAt ?? deps.now();
  const from = normalisePhone(input.from);

  if (!from) {
    return { ok: false, duplicate: false, lead: null, intent: 'unknown', outcome: 'the sender number could not be read', cancelled: 0 };
  }

  /* an inbound text with no lead behind it is a lead. somebody texted the business. */
  let lead = await store.findOpenLeadByPhone(input.tenantId, from);
  if (!lead) {
    const intake = await intakeLead(deps, {
      tenantId: input.tenantId,
      source: 'inbound_sms',
      externalRef: input.providerMessageId,
      phone: from,
      serviceRequest: input.body,
      intakeRef: input.to,
      consentSms: true,
      consentSource: 'inbound_sms',
      occurredAt: now,
    });
    lead = intake.lead;
    if (!lead) {
      return { ok: false, duplicate: false, lead: null, intent: 'unknown', outcome: intake.outcome, cancelled: 0 };
    }
  }

  const conversation = await store.getOrCreateConversation(input.tenantId, lead.id);
  const inserted = await store.insertMessage({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    direction: 'inbound',
    providerMessageId: input.providerMessageId,
    body: input.body,
    status: 'received',
    errorClass: null,
    errorDetail: null,
    occurredAt: iso(now),
  });

  /* Twilio redelivers anything it did not get a 2xx for. the provider id is the idempotency
     key and this is where it earns its unique index: a redelivery records nothing, cancels
     nothing and suppresses nothing a second time. */
  if (!inserted.created) {
    return { ok: true, duplicate: true, lead, intent: 'duplicate', outcome: 'this message was already recorded', cancelled: 0 };
  }

  const verdict = classifyReply(input.body);
  const run = await store.getRunForLead(input.tenantId, lead.id, MODULE_KEY);

  await store.emit(input.tenantId, [
    baseEvent(lead, {
      event_type: 'reply_received',
      occurred_at: iso(now),
      event_key: eventKey('lr', 'reply', input.providerMessageId),
      actor: 'human',
      payload: { from, intent: verdict.intent, body: input.body.slice(0, 300) },
    }),
  ]);

  // ── stop, and never speak again ──
  if (verdict.stops && verdict.suppressionReason) {
    await store.addSuppression({
      tenantId: input.tenantId,
      channel: 'sms',
      address: from,
      reason: verdict.suppressionReason,
      source: 'customer',
      createdAt: iso(now),
      expiresAt: null,
    });

    const cancelled = run ? await store.cancelPendingActions(input.tenantId, run.id, `customer ${verdict.intent}`) : 0;
    await store.updateLead(input.tenantId, lead.id, { status: 'suppressed' });
    if (run) await stopRun(deps, lead, run, 'opted_out', `customer replied ${verdict.intent}`);

    await store.emit(input.tenantId, [
      baseEvent(lead, {
        event_type: 'lead_suppressed',
        occurred_at: iso(now),
        event_key: eventKey('lr', 'suppressed', lead.correlationId),
        actor: 'human',
        payload: { reason: verdict.suppressionReason, channel: 'sms', cancelled_actions: cancelled },
      }),
    ]);

    return {
      ok: true,
      duplicate: false,
      lead,
      intent: verdict.intent,
      outcome: `suppressed on ${verdict.suppressionReason} — ${cancelled} pending action(s) cancelled`,
      cancelled,
    };
  }

  /* any reply at all stops the scheduled chasing. an acknowledgement is not something to
     qualify, but it is absolutely something to stop talking over. */
  const cancelled = run
    ? await store.cancelPendingActions(input.tenantId, run.id, 'the customer replied', [
        'send_followup',
        'send_first_response',
        'close_run',
      ])
    : 0;

  if (!run) {
    return { ok: true, duplicate: false, lead, intent: verdict.intent, outcome: 'recorded; this lead has no active run', cancelled };
  }

  /* a person already has it. record the message, cancel the chasing, and stay out of the
     way — re-qualifying a conversation somebody is having is how an automation talks over
     its own colleague. */
  if (run.state === 'handoff_required' || run.state === 'handed_off' || isTerminal(run.state)) {
    return {
      ok: true,
      duplicate: false,
      lead,
      intent: verdict.intent,
      outcome: `recorded against a run that is ${run.state} — no automation resumed`,
      cancelled,
    };
  }

  if (!verdict.substantive) {
    return { ok: true, duplicate: false, lead, intent: verdict.intent, outcome: 'acknowledged; follow-ups cancelled', cancelled };
  }

  await moveRun(deps, lead, run, 'qualifying');
  await queue(deps, run, 'classify_reply', now, { message_id: inserted.message.id, body: input.body.slice(0, 2000) });

  return { ok: true, duplicate: false, lead, intent: verdict.intent, outcome: 'queued for classification', cancelled };
}

/* ── delivery callbacks ─────────────────────────────────── */

type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'undelivered' | 'failed' | 'received' | 'blocked';

export interface MessageStatusInput {
  tenantId: string;
  providerMessageId: string;
  status: string;
  errorCode?: string | null;
  errorClass?: string | null;
  permanent?: boolean;
  occurredAt?: Date;
}

/**
 * The provider told us what happened to something we sent.
 *
 * `sms_sent` has only ever meant "handed to Twilio". Delivery is a later, separate fact,
 * and this is the only place the product is allowed to claim it. A delivery failure is
 * recorded against the message, emitted as evidence, and — when it is permanent — turned
 * into a handoff, because a customer who never received the text is a lead nobody is
 * talking to.
 */
export async function handleMessageStatus(deps: EngineDeps, input: MessageStatusInput): Promise<{ ok: boolean; outcome: string }> {
  const { store } = deps;
  const now = input.occurredAt ?? deps.now();
  const status = input.status.toLowerCase();

  const message = await store.updateMessageByProviderId(input.tenantId, input.providerMessageId, {
    status: (['delivered', 'sent', 'undelivered', 'failed', 'queued', 'sending'] as const).includes(
      status as 'delivered',
    )
      ? (status as MessageStatus)
      : 'sent',
    errorClass: input.errorClass ?? null,
    errorDetail: input.errorCode ? `provider code ${input.errorCode}` : null,
  });

  if (!message) return { ok: false, outcome: 'no message with that provider id — nothing to update' };

  /* settle the effect attempt too (ARC-015).

     Provider acceptance and delivery are different facts, and the attempt row is
     where the difference is kept: `accepted` means Twilio took it, `confirmed` means
     it reached the handset. The callback carries no lease — it is not a worker — so
     it is fenced on the provider reference instead, which only the provider knows.
     A duplicate or out-of-order callback is a no-op rather than an error. */
  if (status === 'delivered' || status === 'failed' || status === 'undelivered') {
    await store.recordEffectDelivery({
      tenantId: input.tenantId,
      providerMessageId: input.providerMessageId,
      state: status === 'delivered' ? 'confirmed' : 'failed_terminal',
      errorCategory: status === 'delivered' ? null : (input.errorClass ?? 'delivery'),
      errorDetail: input.errorCode ? `provider code ${input.errorCode}` : null,
      nowIso: iso(now),
    });
  }

  const conversation = await store.getConversation(input.tenantId, message.conversationId);
  if (!conversation) return { ok: false, outcome: 'the conversation behind that message is gone' };
  const lead = await store.getLead(input.tenantId, conversation.leadId);
  if (!lead) return { ok: false, outcome: 'the lead behind that message is gone' };

  if (status === 'delivered') {
    await store.emit(input.tenantId, [
      baseEvent(lead, {
        event_type: 'message_delivered',
        occurred_at: iso(now),
        event_key: eventKey('lr', 'delivered', input.providerMessageId),
        payload: { provider_message_id: input.providerMessageId },
      }),
    ]);
    return { ok: true, outcome: 'delivered' };
  }

  if (status !== 'failed' && status !== 'undelivered') {
    return { ok: true, outcome: `recorded as ${status}` };
  }

  await store.emit(input.tenantId, [
    baseEvent(lead, {
      event_type: 'message_failed',
      occurred_at: iso(now),
      status: 'failure',
      error_class: input.errorClass ?? 'delivery',
      event_key: eventKey('lr', 'failed', input.providerMessageId),
      payload: { provider_message_id: input.providerMessageId, provider_code: input.errorCode ?? null },
    }),
  ]);

  /* 21610 is the carrier telling us this handset has opted out. honouring it here as well
     as on the inbound STOP matters: a customer can opt out to the carrier without ever
     sending us a message we see. */
  if (String(input.errorCode ?? '') === '21610' && lead.phone) {
    await store.addSuppression({
      tenantId: input.tenantId,
      channel: 'sms',
      address: lead.phone,
      reason: 'opt_out',
      source: 'provider',
      createdAt: iso(now),
      expiresAt: null,
    });
    const run = await store.getRunForLead(input.tenantId, lead.id, MODULE_KEY);
    if (run && !isTerminal(run.state)) {
      await store.cancelPendingActions(input.tenantId, run.id, 'carrier reported the recipient has opted out');
      await store.updateLead(input.tenantId, lead.id, { status: 'suppressed' });
      await stopRun(deps, lead, run, 'opted_out', 'the carrier reported this handset as opted out');
    }
    return { ok: true, outcome: 'the carrier reported an opt-out — suppressed' };
  }

  if (input.permanent) {
    const run = await store.getRunForLead(input.tenantId, lead.id, MODULE_KEY);
    await openHandoffFor(deps, lead, run, {
      reason: `the text could not be delivered (provider code ${input.errorCode ?? 'unknown'}) — this customer has not heard from anyone`,
      reasonCode: 'delivery_failed',
      isSafety: false,
      at: now,
      notifyStaff: true,
    });
    return { ok: true, outcome: 'permanent delivery failure — handed to a person' };
  }

  return { ok: true, outcome: `recorded as ${status}` };
}

/* ── the dispatcher ─────────────────────────────────────── */

export interface DispatchSummary {
  claimed: number;
  done: number;
  cancelled: number;
  retried: number;
  failed: number;
  details: { id: string; actionType: ActionType; outcome: string }[];
}

/**
 * Claim due work and do it.
 *
 * The re-check block at the top of the loop is the part that matters, and it is worth
 * reading as a list of the things that can be true by the time an action fires but were
 * not when it was queued: the run finished, the customer opted out, the customer replied,
 * a person took over. Each one is asked from the store, not from the action's payload,
 * because the payload is a snapshot of the past.
 */
export async function runDueActions(
  deps: EngineDeps,
  options: {
    limit?: number;
    worker?: string;
    leaseSeconds?: number;
    /**
     * Which tenant's work to take.
     *
     * Required, and `null` — every tenant — has to be written out. That is the whole
     * of the S-C1 fix at this level: the operator canary used to call a claim that
     * silently meant "all tenants", so pressing it drained other clients' due texts
     * into a recording sender. There is now no way to ask for that by omission.
     */
    tenantId: string | null;
    /** restrict to synthetic leads. what a canary passes. */
    canaryOnly?: boolean;
  },
): Promise<DispatchSummary> {
  const { store } = deps;
  const now = deps.now();
  const worker = options.worker ?? deps.worker ?? 'dispatcher';
  const claimed = await store.claimActions({
    limit: options.limit ?? 25,
    worker,
    nowIso: iso(now),
    leaseSeconds: options.leaseSeconds ?? 120,
    tenantId: options.tenantId,
    canaryOnly: options.canaryOnly === true,
  });

  const summary: DispatchSummary = { claimed: claimed.length, done: 0, cancelled: 0, retried: 0, failed: 0, details: [] };

  for (const action of claimed) {
    const outcome = await executeAction(deps, action, now);
    summary.details.push({ id: action.id, actionType: action.actionType, outcome: outcome.outcome });
    if (outcome.kind === 'done') summary.done += 1;
    else if (outcome.kind === 'cancelled') summary.cancelled += 1;
    else if (outcome.kind === 'retried') summary.retried += 1;
    else summary.failed += 1;
  }

  return summary;
}

type ActionOutcome = { kind: 'done' | 'cancelled' | 'retried' | 'failed'; outcome: string };

async function executeAction(deps: EngineDeps, action: ActionRow, now: Date): Promise<ActionOutcome> {
  const { store } = deps;

  const lease = leaseOf(action);
  if (!lease) {
    /* a claim always sets a lease token. arriving here means the row was handed over by
       something other than a claim, and an unfenced worker must not touch it. */
    return { kind: 'failed', outcome: 'this action carries no lease token — refusing to execute it' };
  }

  /* the three terminal ways an action ends. a retry does not come through here — it is
     `retryOrGiveUp`'s job, because putting a row back on the queue and closing it out are
     different writes and conflating them is how an action ends up both pending and done.

     fenced since ARC-015: if another worker reclaimed this row while we were working, the
     write matches nothing and we say so rather than reporting success. */
  const finish = async (kind: 'done' | 'cancelled' | 'failed', outcome: string): Promise<ActionOutcome> => {
    const result = await store.completeAction(lease, kind, kind === 'done' ? null : outcome, iso(now));
    if (!result.ok) {
      return { kind: 'failed', outcome: `could not close this action out (${result.reason}): ${result.detail}` };
    }
    return { kind, outcome };
  };

  const run = await store.getRun(action.tenantId, action.runId);
  if (!run) return finish('cancelled', 'the run behind this action no longer exists');

  const lead = await store.getLead(action.tenantId, run.leadId);
  if (!lead) return finish('cancelled', 'the lead behind this action no longer exists');

  // ── the re-checks that apply to every action, send or not ──
  if (isTerminal(run.state)) {
    return finish('cancelled', `the run is ${run.state} — nothing further is sent`);
  }

  /* may this run still act at all? (ARC-120) its pin is never replaced; what is re-read is
     the tenant, the lifecycle, the run's own mode and every identity the action carries.
     the send path asks again, closer still, in `authorizeLeadRecoveryEffect`. */
  const allowed = await authorizeModuleExecution(store, {
    kind: 'continue',
    tenantId: action.tenantId,
    moduleKey: run.moduleKey,
    lead,
    run,
    action,
  });
  if (!allowed.allowed) {
    /* the tenant's own state. 0010 never asked, so an archived client's queue kept
       draining and a deboarded contractor's customers kept being texted. */
    if (allowed.code === 'tenant_missing' || allowed.code === 'tenant_archived' || allowed.code === 'tenant_paused') {
      await store.cancelPendingActions(action.tenantId, run.id, 'the client is archived or paused');
      return finish('cancelled', allowed.detail);
    }
    /* an action whose identities or pins disagree is not a thing to retry or to hand to a
       person as if it were a lead — it is refused, and says why. */
    if (['identity_mismatch', 'snapshot_missing', 'snapshot_mismatch', 'invalid_run_mode'].includes(allowed.code)) {
      return finish('failed', `${allowed.code}: ${allowed.detail}`);
    }
    /* a dependency is failing: not now, and not never. back off and try again. */
    if (!allowed.terminal) return retryOrGiveUp(deps, action, run, lead, `${allowed.code}: ${allowed.detail}`, now);
    /* the module stopped: paused, deselected, not live, or this run cannot prove it was
       ever authorised. a handoff or a close still runs — it puts a person on the lead or
       closes it out — and any message it would send is refused at its own gate. anything
       that would reach somebody is cancelled, with the reason. */
    if (!BOOKKEEPING.includes(action.actionType)) {
      await store.cancelPendingActions(action.tenantId, run.id, `${allowed.code}: ${allowed.detail}`.slice(0, 300), CONTACT_ACTIONS);
      return finish('cancelled', `${allowed.code}: ${allowed.detail}`);
    }
  }

  const sends = action.actionType === 'send_first_response' || action.actionType === 'send_followup';

  /* cheap pre-filters. the authoritative versions of these live in
     `authorizeLeadRecoveryEffect` and run again immediately before the provider call;
     doing them here as well means an obviously-dead action is cancelled without
     reserving an effect it will never use. */
  if (sends) {
    if (!maySend(run.state)) {
      return finish('cancelled', `the run is ${run.state} — a person has this, so the automation stays quiet`);
    }
    if (lead.phone) {
      const suppression = await store.isSuppressed(action.tenantId, 'sms', lead.phone, iso(now));
      if (suppression) {
        await store.cancelPendingActions(action.tenantId, run.id, 'suppressed');
        return finish('cancelled', `this number is suppressed (${suppression.reason}) — nothing was sent`);
      }
    }
    const conversation = await store.getOrCreateConversation(action.tenantId, lead.id);
    if (conversation.lastInboundAt) {
      return finish('cancelled', 'the customer replied before this message fired');
    }
    const openHandoff = await store.getOpenHandoff(action.tenantId, lead.id);
    if (openHandoff) {
      return finish('cancelled', 'a person has taken this lead over');
    }
  }

  /* the pinned configuration. read from the run's frozen snapshot, never from the
     mutable row — an edit made while this sequence was in flight changes what the
     *next* run does, not what this one was authorised to do. */
  const pinned = await loadPinnedConfig(store, run);
  if (!pinned.ok) {
    /* a configuration that has gone invalid under a running sequence is not a transient
       error and retrying it will not help. it becomes a human task immediately. */
    await openHandoffFor(deps, lead, run, {
      reason: pinned.reason,
      reasonCode: 'other',
      isSafety: false,
      at: now,
      notifyStaff: false,
      action,
    });
    return finish('failed', pinned.reason);
  }
  const loaded = { ok: true as const, loaded: { row: { enabled: true, configVersion: pinned.snapshot.configVersion }, config: pinned.config } };

  const config = loaded.loaded.config;

  try {
    switch (action.actionType) {
      case 'send_first_response':
      case 'send_followup': {
        const body =
          action.actionType === 'send_followup'
            ? renderFollowup(config, lead.customerName)
            : String(action.payload.body ?? '');
        const result = await sendMessage(deps, { lead, run, config, body, action, now });

        if (!result.sent) {
          /* the lifecycle refused at the last moment — a pause, a deselection, an archive
             landing between the dispatcher's check and the effect. that is an operator's
             decision, not a delivery failure: nothing went out, so cancel, and say why. */
          if (result.permanent && result.denial && (EXECUTION_DENIAL_CODES as readonly string[]).includes(result.denial)) {
            await store.cancelPendingActions(action.tenantId, run.id, `${result.denial}: ${result.detail}`.slice(0, 300), CONTACT_ACTIONS);
            return finish('cancelled', `${result.denial}: ${result.detail}`);
          }
          /* the ambiguous case gets its own branch and never reaches `retryOrGiveUp`.
             we cannot prove the provider did not take it, so sending again risks a
             duplicate; a person decides instead. Under-send and escalate beats
             double-send, every time. */
          if (result.ambiguous) {
            await openHandoffFor(deps, lead, run, {
              reason: `${result.detail} — check the provider before anyone messages this customer`,
              reasonCode: 'delivery_failed',
              isSafety: false,
              at: now,
              notifyStaff: true,
              action,
            });
            return finish('failed', result.detail);
          }
          if (result.permanent) {
            await recordSendFailure(deps, lead, run, result.detail, now, action);
            await openHandoffFor(deps, lead, run, {
              reason: `the text could not be sent (${result.detail}) — this customer has not heard from anyone`,
              reasonCode: 'delivery_failed',
              isSafety: false,
              at: now,
              notifyStaff: true,
              action,
            });
            return finish('failed', result.detail);
          }
          return retryOrGiveUp(deps, action, run, lead, result.detail, now);
        }

        if (action.actionType === 'send_first_response') {
          await store.updateLead(action.tenantId, lead.id, { status: 'awaiting_reply' });
          await moveRun(deps, lead, run, 'awaiting_reply');
          /* one follow-up, and a self-closing deadline. both are rows on the queue rather
             than timers, so a restarted worker loses nothing. */
          await queue(deps, run, 'send_followup', new Date(now.getTime() + FOLLOWUP_AFTER_MINUTES * 60_000), {});
          await queue(deps, run, 'close_run', new Date(now.getTime() + CLOSE_AFTER_HOURS * 3_600_000), {});
        } else {
          await queue(deps, run, 'close_run', new Date(now.getTime() + CLOSE_AFTER_HOURS * 3_600_000), {});
        }
        return finish('done', `sent (${result.sid ?? 'no sid'})`);
      }

      case 'classify_reply': {
        const decision = await classifyLead(deps, { lead, config, text: String(action.payload.body ?? lead.serviceRequest ?? '') });

        await store.updateLead(action.tenantId, lead.id, {
          urgency: decision.urgency,
          safetyFlags: decision.safetyFlags,
          aiSummary: decision.summary,
          locationZip: decision.zip ?? lead.locationZip,
          serviceRequest: decision.serviceType ?? lead.serviceRequest,
          status: decision.needsHuman ? 'handoff_required' : 'qualified',
        });

        await store.emit(action.tenantId, [
          baseEvent(lead, {
            event_type: 'lead_qualified',
            occurred_at: iso(now),
            event_key: eventKey('lr', 'qualified', lead.correlationId, String(action.attempts)),
            payload: {
              outcome: decision.needsHuman ? 'needs_human' : 'qualified',
              job_type: decision.serviceType,
              zip: decision.zip,
              in_service_area:
                decision.zip && config.service_area.zips.length > 0
                  ? config.service_area.zips.includes(decision.zip)
                  : null,
              urgency: decision.urgency,
              consent: { sms: lead.consentSms },
              source_attribution: lead.source,
              ...(decision.safetyFlags.length ? { safety_flags: decision.safetyFlags } : {}),
              /* provider metadata, never the prompt and never the key. */
              classifier: { provider: decision.provider, model: decision.model, confidence: decision.confidence, ms: decision.ms },
            },
          }),
        ]);

        if (decision.needsHuman) {
          await moveRun(deps, lead, run, 'handoff_required');
          await queue(deps, run, 'open_handoff', now, {
            reason: decision.handoffReason ?? 'a person should look at this',
            reason_code: decision.handoffCode ?? 'other',
            is_safety: decision.safetyFlags.length > 0,
            send_ack: true,
          });
          return finish('done', `handoff required: ${decision.handoffCode}`);
        }

        await moveRun(deps, lead, run, 'qualified');
        await queue(deps, run, 'route_to_contractor', now, {});
        return finish('done', 'qualified');
      }

      case 'route_to_contractor': {
        const destination = config.forwarding.destination;
        await store.updateLead(action.tenantId, lead.id, { assignedTo: destination, status: 'qualified' });
        await notifyStaff(deps, { lead, config, now, summary: lead.aiSummary, urgency: lead.urgency, safetyFlags: lead.safetyFlags, action, run });

        await store.emit(action.tenantId, [
          baseEvent(lead, {
            event_type: 'routed',
            occurred_at: iso(now),
            event_key: eventKey('lr', 'routed', lead.correlationId),
            payload: { tech: destination, loss_type: lead.serviceRequest, queue: 'on-call' },
          }),
        ]);
        await queue(deps, run, 'close_run', new Date(now.getTime() + CLOSE_AFTER_HOURS * 3_600_000), {});
        return finish('done', 'routed to the contractor');
      }

      case 'open_handoff': {
        await openHandoffFor(deps, lead, run, {
          reason: String(action.payload.reason ?? 'a person should look at this'),
          reasonCode: String(action.payload.reason_code ?? 'other'),
          isSafety: action.payload.is_safety === true,
          at: now,
          notifyStaff: true,
          sendAck: action.payload.send_ack === true,
          config,
          action,
        });
        return finish('done', 'handed to a person');
      }

      case 'notify_staff': {
        await notifyStaff(deps, { lead, config, now, summary: lead.aiSummary, urgency: lead.urgency, safetyFlags: lead.safetyFlags, action, run });
        return finish('done', 'staff notified');
      }

      case 'close_run': {
        if (run.state === 'handoff_required' || run.state === 'handed_off') {
          return finish('cancelled', 'a person still has this lead open');
        }
        await store.updateLead(action.tenantId, lead.id, {
          status: 'closed',
          bookingOutcome: lead.bookingOutcome ?? 'no_response',
        });
        await stopRun(deps, lead, run, 'closed', 'closed after the quiet period with no further contact');
        return finish('done', 'closed');
      }

      default:
        return finish('failed', `"${action.actionType}" is not an action this engine performs`);
    }
  } catch (error) {
    return retryOrGiveUp(deps, action, run, lead, (error as Error)?.message ?? 'the action threw', now);
  }
}

/**
 * Bounded exponential backoff, and then a person.
 *
 * The last line is the one that matters: when the retries are gone, the work does not
 * disappear into a failed row nobody reads. It becomes an open handoff and a `task_opened`
 * event, which is exactly what the portal's needs-attention queue is built to surface.
 */
async function retryOrGiveUp(
  deps: EngineDeps,
  action: ActionRow,
  run: RunRow,
  lead: LeadRow,
  detail: string,
  now: Date,
): Promise<ActionOutcome> {
  const { store } = deps;

  const lease = leaseOf(action);
  if (!lease) {
    return { kind: 'failed', outcome: `${detail} — and this action carries no lease, so it was left alone` };
  }

  if (action.attempts < action.maxAttempts) {
    const seconds = backoffSeconds(action.attempts);
    const rescheduled = await store.rescheduleAction(
      lease,
      iso(new Date(now.getTime() + seconds * 1000)),
      detail,
    );
    if (!rescheduled.ok) {
      /* another worker holds it now; it is theirs to retry. putting it back would
         give the row two futures. */
      return { kind: 'failed', outcome: `${detail} — not retried (${rescheduled.reason}): ${rescheduled.detail}` };
    }
    return { kind: 'retried', outcome: `${detail} — retrying in ${seconds}s (attempt ${action.attempts} of ${action.maxAttempts})` };
  }

  const closed = await store.completeAction(lease, 'failed', detail, iso(now));
  if (!closed.ok) {
    return { kind: 'failed', outcome: `${detail} — and it could not be closed out (${closed.reason})` };
  }
  await recordSendFailure(deps, lead, run, detail, now, action);
  await openHandoffFor(deps, lead, run, {
    reason: `${action.actionType.replace(/_/g, ' ')} failed ${action.attempts} times and gave up: ${detail}`,
    reasonCode: 'delivery_failed',
    isSafety: false,
    at: now,
    notifyStaff: true,
    action,
  });
  await store.emit(action.tenantId, [
    baseEvent(lead, {
      event_type: 'task_opened',
      occurred_at: iso(now),
      status: 'failure',
      error_class: 'upstream',
      event_key: eventKey('lr', 'task', action.id),
      payload: { module: 'lead_capture', reason: detail, action: action.actionType, attempts: action.attempts },
    }),
    baseEvent(lead, {
      event_type: 'automation_failed',
      occurred_at: iso(now),
      status: 'failure',
      error_class: 'upstream',
      event_key: eventKey('lr', 'automation_failed', run.id, action.id),
      payload: { reason: detail, action: action.actionType, attempts: action.attempts },
    }),
  ]);
  await store.updateRun(action.tenantId, run.id, { lastError: detail });
  return { kind: 'failed', outcome: `${detail} — out of retries, a person has been given the task` };
}

/* ── the pieces the actions are made of ─────────────────── */

/**
 * Perform a reserved side effect.
 *
 * Only reachable with a permit, which means every guard in
 * `authorizeLeadRecoveryEffect` has already passed and this worker — not another —
 * owns the effect. What is left is the part that can go wrong at the provider, and
 * the three outcomes it has:
 *
 *   accepted   Twilio took it. Record the message and emit `sms_sent`.
 *   rejected   Twilio answered and refused. Provably not sent, so it may be retried.
 *   unknown    No answer came back. It may or may not have gone out, so it is parked
 *              in `outcome_unknown` and **never** retried automatically.
 *
 * The third case is the one this function exists for. Before ARC-015 a 10-second
 * timeout looked exactly like a failure and was retried, which is how one customer
 * got two texts.
 */
async function dispatchEffect(
  deps: EngineDeps,
  args: {
    permit: EffectPermit;
    lead: LeadRow;
    body: string;
    to: string;
    now: Date;
    /** emitted only on acceptance, and only for customer-facing messages. */
    evidence?: { eventKey: string; template?: string | null; latencyFrom?: string | null } | null;
    recordMessage?: boolean;
  },
): Promise<{ sent: boolean; sid: string | null; permanent: boolean; ambiguous: boolean; detail: string }> {
  const { store } = deps;
  const { permit, lead, body, to, now } = args;
  const { attempt, lease, sender, config } = permit;

  await store.settleEffect({
    attemptId: attempt.id,
    tenantId: attempt.tenantId,
    leaseToken: lease.leaseToken,
    state: 'dispatching',
    nowIso: iso(now),
  });

  let result: SendResult;
  try {
    result = await sender.send({
      to,
      body,
      messagingServiceSid: config.twilio.messaging_service_sid,
      from: config.twilio.phone_number,
      statusCallback: deps.urls?.statusCallback ?? null,
    });
  } catch (error) {
    /* the adapter itself threw. we never saw a response, so the outcome is unknown. */
    result = {
      ok: false,
      sid: null,
      status: null,
      errorCode: null,
      errorMessage: (error as Error)?.message ?? 'the provider request threw',
      permanent: false,
      ambiguous: true,
      ms: 0,
    };
  }

  // ── the outcome we cannot resolve ──
  if (!result.ok && result.ambiguous) {
    await store.settleEffect({
      attemptId: attempt.id,
      tenantId: attempt.tenantId,
      leaseToken: lease.leaseToken,
      state: 'reconciliation_required',
      errorCategory: 'provider_unknown',
      errorDetail: (result.errorMessage ?? 'no response from the provider').slice(0, 300),
      retryable: false,
      nowIso: iso(now),
    });
    /* evidence an operator can act on. deliberately not `sms_sent`: we do not know
       that it was, and the portal must never count a maybe as a send. */
    await store.emit(lead.tenantId, [
      baseEvent(lead, {
        event_type: 'automation_failed',
        occurred_at: iso(now),
        status: 'failure',
        error_class: 'upstream',
        event_key: eventKey('lr', 'unknown', attempt.effectKey),
        payload: {
          reason: 'the provider did not answer, so whether this message was sent is unknown',
          effect: attempt.effectType,
          resolution: 'held for reconciliation — no automatic retry',
        },
      }),
    ]);
    return {
      sent: false,
      sid: null,
      permanent: true,
      ambiguous: true,
      detail: `the provider did not answer (${result.errorMessage ?? 'timeout'}) — held for reconciliation rather than retried`,
    };
  }

  // ── a clean refusal ──
  if (!result.ok) {
    await store.settleEffect({
      attemptId: attempt.id,
      tenantId: attempt.tenantId,
      leaseToken: lease.leaseToken,
      state: result.permanent ? 'failed_terminal' : 'rejected',
      errorCategory: 'delivery',
      errorDetail: (result.errorMessage ?? 'send failed').slice(0, 300),
      retryable: !result.permanent,
      nowIso: iso(now),
    });
    return {
      sent: false,
      sid: null,
      permanent: result.permanent,
      ambiguous: false,
      detail: `${result.errorMessage ?? 'send failed'}${result.errorCode ? ` (${result.errorCode})` : ''}`,
    };
  }

  // ── accepted ──
  await store.settleEffect({
    attemptId: attempt.id,
    tenantId: attempt.tenantId,
    leaseToken: lease.leaseToken,
    state: 'accepted',
    providerMessageId: result.sid,
    nowIso: iso(now),
  });

  if (args.recordMessage !== false) {
    const conversation = await store.getOrCreateConversation(lead.tenantId, lead.id);
    await store.insertMessage({
      tenantId: lead.tenantId,
      conversationId: conversation.id,
      direction: 'outbound',
      providerMessageId: result.sid,
      body,
      status: result.status ?? 'queued',
      errorClass: null,
      errorDetail: null,
      occurredAt: iso(now),
    });
  }

  if (args.evidence) {
    /* the latency the portal reports as "response time" is measured from the moment the
       lead landed, which is what the customer experienced — not from when a worker
       picked the action up. */
    const from = args.evidence.latencyFrom ?? lead.createdAt;
    const leadAt = Date.parse(from);
    const latencyMs = Number.isFinite(leadAt) ? Math.max(0, now.getTime() - leadAt) : null;
    await store.emit(lead.tenantId, [
      baseEvent(lead, {
        event_type: 'sms_sent',
        occurred_at: iso(now),
        status: 'success',
        latency_ms: latencyMs,
        /* keyed on the effect, not the attempt. a retried send is one `sms_sent`,
           where 0010 emitted one per attempt and so double-counted. */
        event_key: args.evidence.eventKey,
        payload: {
          to,
          body: body.slice(0, 320),
          provider_message_id: result.sid,
          ...(args.evidence.template ? { template: args.evidence.template } : {}),
        },
      }),
    ]);
  }

  return { sent: true, sid: result.sid, permanent: false, ambiguous: false, detail: 'sent' };
}

/** Authorise, then dispatch. The only path to a customer-facing message. */
async function sendMessage(
  deps: EngineDeps,
  args: { lead: LeadRow; run: RunRow; config: LeadRecoveryConfig; body: string; action: ActionRow; now: Date },
): Promise<{ sent: boolean; sid: string | null; permanent: boolean; ambiguous: boolean; detail: string; denial?: EffectDenial }> {
  const { lead, action, now } = args;

  /* stable for the life of the effect: one first response per run, one follow-up per
     run. it is the reservation key, the provider idempotency key and the event key. */
  const effectKey = eventKey('lr', 'effect', action.idempotencyKey);

  const authorized = await authorizeLeadRecoveryEffect(deps, {
    action,
    run: args.run,
    lead,
    config: args.config,
    effectType: 'customer_sms',
    effectKey,
    destination: lead.phone,
    now,
  });

  if (!authorized.ok) {
    return {
      sent: false,
      sid: null,
      permanent: authorized.terminal,
      ambiguous: authorized.denial === 'ambiguous_outcome',
      detail: authorized.detail,
      denial: authorized.denial,
    };
  }

  return await dispatchEffect(deps, {
    permit: authorized.permit,
    lead,
    body: args.body,
    to: lead.phone as string,
    now,
    evidence: {
      eventKey: eventKey('lr', 'sms', action.idempotencyKey),
      template: typeof action.payload.template === 'string' ? action.payload.template : null,
      latencyFrom: typeof action.payload.lead_at === 'string' ? action.payload.lead_at : null,
    },
  });
}

async function recordSendFailure(deps: EngineDeps, lead: LeadRow, run: RunRow, detail: string, now: Date, action: ActionRow) {
  await deps.store.emit(lead.tenantId, [
    baseEvent(lead, {
      event_type: 'message_failed',
      occurred_at: iso(now),
      status: 'failure',
      error_class: 'delivery',
      event_key: eventKey('lr', 'send_failed', action.id, String(action.attempts)),
      payload: { reason: detail.slice(0, 300), action: action.actionType },
    }),
  ]);
  await deps.store.updateRun(lead.tenantId, run.id, { lastError: detail.slice(0, 300) });
}

async function classifyLead(
  deps: EngineDeps,
  args: { lead: LeadRow; config: LeadRecoveryConfig; text: string },
): Promise<ClassificationDecision> {
  const classifier = deps.classifierFor(args.config);
  const outcome = await classifier.classify({
    text: args.text,
    services: args.config.services,
    zips: args.config.service_area.zips,
    customerName: args.lead.customerName,
  });
  return applyClassification({
    text: args.text,
    outcome,
    config: args.config,
    requestedService: args.lead.serviceRequest,
  });
}

async function notifyStaff(
  deps: EngineDeps,
  args: {
    lead: LeadRow;
    config: LeadRecoveryConfig;
    now: Date;
    summary?: string | null;
    urgency?: string | null;
    safetyFlags?: string[];
    /** the claimed action this alert belongs to. absent only for unfenced callers. */
    action?: ActionRow | null;
    /** the run that action belongs to — what the lifecycle authorises against. */
    run?: RunRow | null;
  },
): Promise<number> {
  const { lead, config, now } = args;
  const recipients = config.staff_alerts.filter((r) => r.channel === 'sms');
  if (recipients.length === 0) return 0;

  /* a staff text is an external effect like any other (ARC-120): only from a claimed
     action of a run the lifecycle still lets act. an unfenced caller reaches nobody. */
  if (!args.action || !args.run) return 0;
  const lifecycle = await authorizeModuleExecution(deps.store, {
    kind: 'effect',
    tenantId: lead.tenantId,
    moduleKey: args.run.moduleKey,
    lead,
    run: args.run,
    action: args.action,
    config: config as unknown as Record<string, unknown>,
    capability: 'send_sms',
  });
  if (!lifecycle.allowed) return 0;

  const sender = senderFor(deps, lead);
  if (!sender) return 0;

  const body = renderStaffAlert({
    config,
    customerName: lead.customerName,
    maskedPhone: maskPhone(lead.phone),
    summary: args.summary ?? null,
    urgency: args.urgency ?? null,
    safetyFlags: args.safetyFlags ?? [],
    portalUrl: deps.urls?.leadInConsole?.(lead.tenantId, lead.id) ?? null,
  });

  let sent = 0;
  for (const recipient of recipients) {
    /* a staff member's own suppression is honoured. somebody who left the company and
       texted STOP does not keep getting lead alerts. */
    const suppressed = await deps.store.isSuppressed(lead.tenantId, 'sms', recipient.address, iso(now));
    if (suppressed) continue;

    /* a staff alert is an external effect too, and duplicating one is how a
       contractor gets woken twice for the same lead. reserved per (action, recipient)
       so each destination is its own logical effect. */
    let reservation: Awaited<ReturnType<EngineStore['reserveEffect']>>;
    try {
      reservation = await deps.store.reserveEffect({
        tenantId: lead.tenantId,
        effectKey: eventKey('lr', 'staff', args.action.idempotencyKey, recipient.address),
        effectType: 'staff_sms',
        idempotencyKey: eventKey('lr', 'staff', args.action.idempotencyKey, recipient.address),
        worker: args.action.lockedBy ?? deps.worker ?? 'dispatcher',
        leaseToken: args.action.leaseToken ?? 'unleased',
        runId: args.action.runId,
        leadId: lead.id,
        actionId: args.action.id,
        destinationRef: maskPhone(recipient.address),
        isCanary: lead.isCanary,
      });
    } catch (error) {
      /* the lifecycle stopped between the check and the reservation (0015). */
      if (error instanceof LifecycleStoreError) return sent;
      throw error;
    }
    if (!reservation.reserved) continue;

    const result = await sender.send({
      to: recipient.address,
      body,
      messagingServiceSid: config.twilio.messaging_service_sid,
      from: config.twilio.phone_number,
    });

    await deps.store.settleEffect({
      attemptId: reservation.attempt.id,
      tenantId: lead.tenantId,
      leaseToken: reservation.attempt.leaseToken as string,
      state: result.ok ? 'accepted' : result.ambiguous ? 'reconciliation_required' : 'rejected',
      providerMessageId: result.sid,
      errorCategory: result.ok ? null : result.ambiguous ? 'provider_unknown' : 'delivery',
      errorDetail: result.ok ? null : (result.errorMessage ?? 'send failed').slice(0, 300),
      retryable: result.ok ? null : !result.ambiguous && !result.permanent,
      nowIso: iso(now),
    });
    if (result.ok) sent += 1;
  }
  return sent;
}

async function openHandoffFor(
  deps: EngineDeps,
  lead: LeadRow,
  run: RunRow | null,
  args: {
    reason: string;
    reasonCode: string;
    isSafety: boolean;
    at: Date;
    notifyStaff?: boolean;
    sendAck?: boolean;
    assignedTo?: string | null;
    config?: LeadRecoveryConfig;
    /** present when this handoff came from a claimed action, so effects can be fenced. */
    action?: ActionRow | null;
  },
): Promise<void> {
  const { store } = deps;
  const opened = await store.openHandoff({
    tenantId: lead.tenantId,
    leadId: lead.id,
    runId: run?.id ?? null,
    reason: args.reason.slice(0, 480),
    reasonCode: args.reasonCode,
    isSafety: args.isSafety,
    assignedTo: args.assignedTo ?? null,
    openedAt: iso(args.at),
  });

  if (run && !isTerminal(run.state) && run.state !== 'handoff_required' && run.state !== 'handed_off') {
    await moveRun(deps, lead, run, 'handoff_required');
  }
  await store.updateLead(lead.tenantId, lead.id, { status: 'handoff_required' });

  /* every scheduled message stops the moment a person is involved. */
  if (run) await store.cancelPendingActions(lead.tenantId, run.id, 'handed to a person', ['send_followup', 'send_first_response']);

  if (opened.created) {
    await store.emit(lead.tenantId, [
      baseEvent(lead, {
        event_type: 'handoff_requested',
        occurred_at: iso(args.at),
        event_key: eventKey('lr', 'handoff', lead.correlationId, args.reasonCode),
        payload: { reason: args.reason.slice(0, 300), reason_code: args.reasonCode, safety: args.isSafety, assigned_to: args.assignedTo ?? null },
      }),
    ]);
  }

  const config = args.config;
  if (config && args.notifyStaff) {
    await notifyStaff(deps, {
      lead,
      config,
      now: args.at,
      summary: args.reason,
      urgency: lead.urgency,
      safetyFlags: lead.safetyFlags,
      action: args.action ?? null,
      run,
    });
  }

  /* the acknowledgement is a customer-facing effect: from a claimed action of a run the
     lifecycle still lets act (ARC-120), or not at all. the handoff itself — a person on
     the lead — stands either way. */
  const ackAllowed = config && args.sendAck && lead.phone && config.compliance.status === 'approved' && run && args.action
    ? (await authorizeModuleExecution(store, {
      kind: 'effect',
      tenantId: lead.tenantId,
      moduleKey: run.moduleKey,
      lead,
      run,
      action: args.action,
      config: config as unknown as Record<string, unknown>,
      capability: 'send_sms',
    })).allowed
    : false;

  if (config && ackAllowed && lead.phone) {
    const sender = senderFor(deps, lead);
    const suppressed = await store.isSuppressed(lead.tenantId, 'sms', lead.phone, iso(args.at));
    if (sender && !suppressed) {
      const conversation = await store.getOrCreateConversation(lead.tenantId, lead.id);
      const body = renderHandoffAck(config, lead.customerName);

      /* one acknowledgement per lead, whatever re-opens the handoff. */
      const ackKey = eventKey('lr', 'ack', lead.correlationId);
      let reservation: Awaited<ReturnType<EngineStore['reserveEffect']>> | null = null;
      try {
        reservation = await store.reserveEffect({
          tenantId: lead.tenantId,
          effectKey: ackKey,
          effectType: 'customer_sms',
          idempotencyKey: ackKey,
          worker: args.action?.lockedBy ?? deps.worker ?? 'dispatcher',
          leaseToken: args.action?.leaseToken ?? 'unleased',
          runId: run?.id ?? null,
          leadId: lead.id,
          actionId: args.action?.id ?? null,
          conversationId: conversation.id,
          destinationRef: maskPhone(lead.phone),
          isCanary: lead.isCanary,
        });
      } catch (error) {
        /* the lifecycle stopped between the check and the reservation (0015). */
        if (!(error instanceof LifecycleStoreError)) throw error;
      }

      if (reservation?.reserved) {
        const result = await sender.send({
          to: lead.phone,
          body,
          messagingServiceSid: config.twilio.messaging_service_sid,
          from: config.twilio.phone_number,
          statusCallback: deps.urls?.statusCallback ?? null,
        });

        await store.settleEffect({
          attemptId: reservation.attempt.id,
          tenantId: lead.tenantId,
          leaseToken: reservation.attempt.leaseToken as string,
          state: result.ok ? 'accepted' : result.ambiguous ? 'reconciliation_required' : 'rejected',
          providerMessageId: result.sid,
          errorCategory: result.ok ? null : result.ambiguous ? 'provider_unknown' : 'delivery',
          errorDetail: result.ok ? null : (result.errorMessage ?? 'send failed').slice(0, 300),
          retryable: result.ok ? null : !result.ambiguous && !result.permanent,
          nowIso: iso(args.at),
        });

        if (result.ok) {
          await store.insertMessage({
            tenantId: lead.tenantId,
            conversationId: conversation.id,
            direction: 'outbound',
            providerMessageId: result.sid,
            body,
            status: result.status ?? 'queued',
            errorClass: null,
            errorDetail: null,
            occurredAt: iso(args.at),
          });
          /* emitted only on acceptance. 0010 wrote `sms_sent` with status failure for a
             send that never happened, which the portal then counted as an attempt. */
          await store.emit(lead.tenantId, [
            baseEvent(lead, {
              event_type: 'sms_sent',
              occurred_at: iso(args.at),
              status: 'success',
              event_key: ackKey,
              payload: { to: lead.phone, body: body.slice(0, 320), template: 'handoff_ack' },
            }),
          ]);
        }
      }
    }
  }
}

/* ── state plumbing ─────────────────────────────────────── */

/**
 * Change a run's state, or fail loudly.
 *
 * An invalid transition throws rather than returning a flag. It cannot be handled at the
 * call site in any useful way — the engine believed something about this run that is not
 * true — and swallowing it would let the next line send a message the state machine had
 * just refused.
 */
async function moveRun(deps: EngineDeps, _lead: LeadRow, run: RunRow, to: RunState): Promise<RunRow> {
  const result = transition(run.state, to);
  if (!result.ok) {
    await deps.store.updateRun(run.tenantId, run.id, { lastError: result.error });
    throw new Error(`invalid transition on run ${run.id}: ${result.error}`);
  }
  const updated = await deps.store.updateRun(run.tenantId, run.id, { state: to });
  run.state = to;
  return updated;
}

async function stopRun(deps: EngineDeps, lead: LeadRow, run: RunRow, reason: StopReason, detail: string): Promise<void> {
  const now = iso(deps.now());
  const landing: RunState = reason === 'opted_out' ? 'suppressed' : reason === 'booked' ? 'booked' : reason === 'failed' ? 'failed' : 'closed';

  const result = transition(run.state, landing);
  if (result.ok) {
    await deps.store.updateRun(run.tenantId, run.id, {
      state: landing,
      stoppedAt: now,
      completedAt: reason === 'failed' ? null : now,
      stopReason: reason,
      lastError: reason === 'failed' ? detail : null,
    });
    run.state = landing;
  } else {
    /* the run is already finished. record why we tried rather than throwing: a second stop
       is a race, not a bug. */
    await deps.store.updateRun(run.tenantId, run.id, { lastError: `${detail} (run was already ${run.state})` });
  }

  await deps.store.emit(run.tenantId, [
    baseEvent(lead, {
      event_type: reason === 'failed' ? 'automation_failed' : 'automation_completed',
      occurred_at: now,
      status: reason === 'failed' ? 'failure' : 'success',
      error_class: reason === 'failed' ? 'unknown' : null,
      event_key: eventKey('lr', 'run_end', run.id, reason),
      payload: { stop_reason: reason, detail: detail.slice(0, 300), final_state: run.state },
    }),
  ]);
}

async function queue(
  deps: EngineDeps,
  run: RunRow,
  actionType: ActionType,
  runAt: Date,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const result = await deps.store.scheduleAction({
    tenantId: run.tenantId,
    runId: run.id,
    actionType,
    runAt: iso(runAt),
    /* the idempotency key is the action's identity: one first response per run, one
       follow-up per run, one close per run. a second attempt to queue the same thing finds
       the row already there and adds nothing. */
    idempotencyKey: eventKey(run.id, actionType),
    /* every action carries its run's snapshot. the store and 0013 both refuse one that
       differs, so this is the run's pin restated, never a fresh choice. */
    configSnapshotId: run.configSnapshotId,
    payload,
  });
  return result.created;
}

/* ── operator actions ───────────────────────────────────── */

/**
 * A person takes the lead over.
 *
 * One of the five stop conditions, and the one most likely to race with the automation —
 * somebody in the office picks up the phone at the moment a follow-up is due. So it
 * cancels first and transitions second.
 */
export async function takeOverLead(
  deps: EngineDeps,
  args: { tenantId: string; leadId: string; actor?: string | null; note?: string | null },
): Promise<{ ok: boolean; outcome: string }> {
  const { store } = deps;
  const now = deps.now();
  const lead = await store.getLead(args.tenantId, args.leadId);
  if (!lead) return { ok: false, outcome: 'no lead with that id for this client' };

  const run = await store.getRunForLead(args.tenantId, lead.id, MODULE_KEY);
  const cancelled = run ? await store.cancelPendingActions(args.tenantId, run.id, 'a person took this lead over') : 0;

  const opened = await store.openHandoff({
    tenantId: args.tenantId,
    leadId: lead.id,
    runId: run?.id ?? null,
    reason: args.note?.trim() || 'taken over by a person',
    reasonCode: 'staff_request',
    isSafety: false,
    assignedTo: args.actor ?? null,
    openedAt: iso(now),
  });

  await store.updateLead(args.tenantId, lead.id, { status: 'handed_off', assignedTo: args.actor ?? lead.assignedTo });

  if (run && !isTerminal(run.state)) {
    const toRequired = transition(run.state, 'handoff_required');
    if (toRequired.ok) await store.updateRun(args.tenantId, run.id, { state: 'handoff_required' });
    await store.updateRun(args.tenantId, run.id, {
      state: 'handed_off',
      stoppedAt: iso(now),
      stopReason: 'human_takeover',
    });
  }

  await store.emit(args.tenantId, [
    baseEvent(lead, {
      event_type: 'handoff_requested',
      occurred_at: iso(now),
      actor: 'human',
      event_key: eventKey('lr', 'takeover', lead.correlationId, opened.handoff.id),
      payload: { reason: args.note?.slice(0, 300) ?? 'taken over by a person', assigned_to: args.actor ?? null, reason_code: 'staff_request' },
    }),
  ]);

  return { ok: true, outcome: `taken over — ${cancelled} pending action(s) cancelled` };
}

export async function resolveHandoffFor(
  deps: EngineDeps,
  args: { tenantId: string; handoffId: string; resolution: string; actorId?: string | null },
): Promise<{ ok: boolean; outcome: string }> {
  const now = deps.now();
  const handoff = await deps.store.resolveHandoff(args.tenantId, args.handoffId, args.resolution.slice(0, 480), iso(now));
  if (!handoff) return { ok: false, outcome: 'no handoff with that id for this client' };

  const lead = await deps.store.getLead(args.tenantId, handoff.leadId);
  if (lead) {
    await deps.store.emit(args.tenantId, [
      baseEvent(lead, {
        event_type: 'task_resolved',
        occurred_at: iso(now),
        actor: 'human',
        event_key: eventKey('lr', 'handoff_resolved', handoff.id),
        payload: { module: 'lead_capture', resolution: args.resolution.slice(0, 300), reason_code: handoff.reasonCode },
      }),
    ]);
  }
  return { ok: true, outcome: 'resolved' };
}

/**
 * The lead turned into work.
 *
 * The only conversion claim this product makes, and it is only ever made by a person or by
 * the contractor's own system saying so — never inferred from a customer having replied
 * enthusiastically. That is the same discipline `buildEstimates` applies to the word
 * "recovered".
 */
export async function markBooked(
  deps: EngineDeps,
  args: { tenantId: string; leadId: string; outcome?: LeadRow['bookingOutcome']; valueCents?: number | null; actor?: string | null },
): Promise<{ ok: boolean; outcome: string }> {
  const { store } = deps;
  const now = deps.now();
  const lead = await store.getLead(args.tenantId, args.leadId);
  if (!lead) return { ok: false, outcome: 'no lead with that id for this client' };

  const run = await store.getRunForLead(args.tenantId, lead.id, MODULE_KEY);
  if (run) await store.cancelPendingActions(args.tenantId, run.id, 'the lead was booked');

  const booking = args.outcome ?? 'booked';
  await store.updateLead(args.tenantId, lead.id, {
    status: booking === 'booked' ? 'booked' : 'closed',
    bookingOutcome: booking,
    bookedAt: booking === 'booked' ? iso(now) : null,
  });

  if (run && !isTerminal(run.state)) {
    const result = transition(run.state, booking === 'booked' ? 'booked' : 'closed');
    if (result.ok) {
      await store.updateRun(args.tenantId, run.id, {
        state: booking === 'booked' ? 'booked' : 'closed',
        stoppedAt: iso(now),
        completedAt: iso(now),
        stopReason: booking === 'booked' ? 'booked' : 'closed',
      });
    }
  }

  await store.emit(args.tenantId, [
    baseEvent(lead, {
      event_type: booking === 'booked' ? 'lead_booked' : 'automation_completed',
      occurred_at: iso(now),
      actor: 'human',
      event_key: eventKey('lr', 'booking', lead.correlationId, booking),
      payload:
        booking === 'booked'
          ? { outcome: booking, value_cents: typeof args.valueCents === 'number' ? Math.round(args.valueCents) : null, recorded_by: args.actor ?? null }
          : { stop_reason: 'closed', detail: `closed as ${booking}` },
    }),
  ]);

  return { ok: true, outcome: booking };
}

/** An operator adding somebody to the suppression list by hand. */
export async function suppressContact(
  deps: EngineDeps,
  args: { tenantId: string; channel: 'sms' | 'email'; address: string; reason: string; note?: string | null },
): Promise<{ ok: boolean; outcome: string }> {
  const address = args.channel === 'sms' ? normalisePhone(args.address) : normaliseEmail(args.address);
  if (!address) return { ok: false, outcome: `"${args.address}" is not a ${args.channel === 'sms' ? 'phone number' : 'email address'}` };

  await deps.store.addSuppression({
    tenantId: args.tenantId,
    channel: args.channel,
    address,
    reason: args.reason,
    source: 'operator',
    createdAt: iso(deps.now()),
    expiresAt: null,
  });
  return { ok: true, outcome: `${address} will not be contacted` };
}
