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
import { validateLeadRecoveryConfig, type LeadRecoveryConfig } from '../lead-recovery-config.ts';
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
import type { ActionRow, ActionType, EngineStore, LeadRow, RunRow } from './store.ts';

export const MODULE_KEY = 'lead_recovery';

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
  row: { enabled: boolean; configVersion: number };
  config: LeadRecoveryConfig;
}

/**
 * Load and validate a tenant's configuration.
 *
 * Validated on read as well as on write. Configuration written by an older release, or
 * edited straight into the database, must not be able to put the engine into a state its
 * own validator would have refused — and "the row exists" is not the same claim as "the
 * row is usable".
 */
export async function loadConfig(
  store: EngineStore,
  tenantId: string,
): Promise<{ ok: true; loaded: LoadedConfig } | { ok: false; reason: string; enabled: boolean }> {
  const row = await store.getConfig(tenantId, MODULE_KEY);
  if (!row) return { ok: false, reason: 'this tenant has no lead_recovery configuration', enabled: false };

  const result = validateLeadRecoveryConfig(row.config);
  if (!result.ok) {
    return {
      ok: false,
      enabled: row.enabled,
      reason: `configuration is not valid: ${result.errors.slice(0, 3).join('; ')}`,
    };
  }

  return { ok: true, loaded: { row: { enabled: row.enabled, configVersion: row.configVersion }, config: result.config } };
}

/** The one place a sender is chosen. A canary cannot be given the live one. */
function senderFor(deps: EngineDeps, lead: { isCanary: boolean }): TwilioSender | null {
  return lead.isCanary ? deps.canarySender : deps.liveSender;
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

  const run = await store.createRun({
    id: deps.uuid(),
    tenantId: input.tenantId,
    leadId: lead.id,
    moduleKey: MODULE_KEY,
    state: 'new',
    configVersion: loaded.ok ? loaded.loaded.row.configVersion : 0,
    stoppedAt: null,
    completedAt: null,
    stopReason: null,
    lastError: null,
  });

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
  await store.emit(input.tenantId, events);

  // ── may we speak at all? ──
  if (!loaded.ok) {
    await stopRun(deps, lead, run, 'not_permitted', loaded.reason);
    return { ok: false, created: true, lead, run, outcome: loaded.reason, queued: [] };
  }
  /* a canary is exempt from the master switch, and only from that. it exists to prove the
     pipeline works *before* the module is switched on — that is where it sits in the
     onboarding checklist — and it cannot reach a real handset, because `senderFor()` gives
     a synthetic run the recording sender. Every other gate below still applies to it,
     compliance included: a canary that sent on an unapproved campaign would be proving the
     wrong thing. */
  if (!loaded.loaded.row.enabled && !isCanary) {
    const why = 'lead recovery is not switched on for this tenant — the lead is recorded, nothing was sent';
    await stopRun(deps, lead, run, 'not_permitted', why);
    return { ok: false, created: true, lead, run, outcome: why, queued: [] };
  }

  const config = loaded.loaded.config;

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
  options: { limit?: number; worker?: string; leaseSeconds?: number } = {},
): Promise<DispatchSummary> {
  const { store } = deps;
  const now = deps.now();
  const worker = options.worker ?? deps.worker ?? 'dispatcher';
  const claimed = await store.claimActions(options.limit ?? 25, worker, iso(now), options.leaseSeconds ?? 120);

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

  /* the three terminal ways an action ends. a retry does not come through here — it is
     `retryOrGiveUp`'s job, because putting a row back on the queue and closing it out are
     different writes and conflating them is how an action ends up both pending and done. */
  const finish = async (kind: 'done' | 'cancelled' | 'failed', outcome: string): Promise<ActionOutcome> => {
    await store.completeAction(action.id, kind, kind === 'done' ? null : outcome, iso(now));
    return { kind, outcome };
  };

  const run = await store.getRun(action.tenantId, action.runId);
  if (!run) return finish('cancelled', 'the run behind this action no longer exists');

  const lead = await store.getLead(action.tenantId, run.leadId);
  if (!lead) return finish('cancelled', 'the lead behind this action no longer exists');

  // ── the re-checks ──
  if (isTerminal(run.state)) {
    return finish('cancelled', `the run is ${run.state} — nothing further is sent`);
  }

  const sends = action.actionType === 'send_first_response' || action.actionType === 'send_followup';

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
    /* a reply that landed after this action was queued. the inbound handler already
       cancels, and this is the second line in case a claim and a reply raced. */
    if (action.actionType === 'send_followup' && conversation.lastInboundAt) {
      return finish('cancelled', 'the customer replied before this follow-up fired');
    }
    const openHandoff = await store.getOpenHandoff(action.tenantId, lead.id);
    if (openHandoff) {
      return finish('cancelled', 'a person has taken this lead over');
    }
  }

  const loaded = await loadConfig(store, action.tenantId);
  if (!loaded.ok) {
    /* a configuration that has gone invalid under a running sequence is not a transient
       error and retrying it will not help. it becomes a human task immediately. */
    await openHandoffFor(deps, lead, run, {
      reason: loaded.reason,
      reasonCode: 'other',
      isSafety: false,
      at: now,
      notifyStaff: false,
    });
    return finish('failed', loaded.reason);
  }
  if (!loaded.loaded.row.enabled && sends && !lead.isCanary) {
    await store.cancelPendingActions(action.tenantId, run.id, 'the module was switched off');
    return finish('cancelled', 'lead recovery was switched off for this tenant before this action fired');
  }

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
          if (result.permanent) {
            await recordSendFailure(deps, lead, run, result.detail, now, action);
            await openHandoffFor(deps, lead, run, {
              reason: `the text could not be sent (${result.detail}) — this customer has not heard from anyone`,
              reasonCode: 'delivery_failed',
              isSafety: false,
              at: now,
              notifyStaff: true,
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
        await notifyStaff(deps, { lead, config, now, summary: lead.aiSummary, urgency: lead.urgency, safetyFlags: lead.safetyFlags });

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
        });
        return finish('done', 'handed to a person');
      }

      case 'notify_staff': {
        await notifyStaff(deps, { lead, config, now, summary: lead.aiSummary, urgency: lead.urgency, safetyFlags: lead.safetyFlags });
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

  if (action.attempts < action.maxAttempts) {
    const seconds = backoffSeconds(action.attempts);
    await store.rescheduleAction(action.id, iso(new Date(now.getTime() + seconds * 1000)), detail);
    return { kind: 'retried', outcome: `${detail} — retrying in ${seconds}s (attempt ${action.attempts} of ${action.maxAttempts})` };
  }

  await store.completeAction(action.id, 'failed', detail, iso(now));
  await recordSendFailure(deps, lead, run, detail, now, action);
  await openHandoffFor(deps, lead, run, {
    reason: `${action.actionType.replace(/_/g, ' ')} failed ${action.attempts} times and gave up: ${detail}`,
    reasonCode: 'delivery_failed',
    isSafety: false,
    at: now,
    notifyStaff: true,
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

async function sendMessage(
  deps: EngineDeps,
  args: { lead: LeadRow; run: RunRow; config: LeadRecoveryConfig; body: string; action: ActionRow; now: Date },
): Promise<{ sent: boolean; sid: string | null; permanent: boolean; detail: string }> {
  const { store } = deps;
  const { lead, config, body, now } = args;

  if (!lead.phone) return { sent: false, sid: null, permanent: true, detail: 'this lead has no phone number' };

  if (config.compliance.status !== 'approved') {
    return { sent: false, sid: null, permanent: true, detail: `messaging compliance is "${config.compliance.status}"` };
  }

  const sender = senderFor(deps, lead);
  if (!sender) {
    return { sent: false, sid: null, permanent: true, detail: 'no sender is configured for a synthetic run — refusing to fall back to the live one' };
  }

  const conversation = await store.getOrCreateConversation(lead.tenantId, lead.id);
  let result: SendResult;
  try {
    result = await sender.send({
      to: lead.phone,
      body,
      messagingServiceSid: config.twilio.messaging_service_sid,
      from: config.twilio.phone_number,
      statusCallback: deps.urls?.statusCallback ?? null,
    });
  } catch (error) {
    return { sent: false, sid: null, permanent: false, detail: (error as Error)?.message ?? 'the provider request threw' };
  }

  /* the latency the portal reports as "response time" is measured from the moment the lead
     landed, which is what the customer experienced — not from when a worker picked the
     action up. */
  const leadAt = typeof args.action.payload.lead_at === 'string' ? Date.parse(args.action.payload.lead_at) : Date.parse(lead.createdAt);
  const latencyMs = Number.isFinite(leadAt) ? Math.max(0, now.getTime() - leadAt) : null;

  await store.insertMessage({
    tenantId: lead.tenantId,
    conversationId: conversation.id,
    direction: 'outbound',
    providerMessageId: result.sid,
    body,
    status: result.ok ? (result.status ?? 'queued') : 'failed',
    errorClass: result.ok ? null : 'delivery',
    errorDetail: result.ok ? null : result.errorMessage,
    occurredAt: iso(now),
  });

  await store.emit(lead.tenantId, [
    baseEvent(lead, {
      event_type: 'sms_sent',
      occurred_at: iso(now),
      status: result.ok ? 'success' : 'failure',
      latency_ms: result.ok ? latencyMs : null,
      error_class: result.ok ? null : 'delivery',
      event_key: eventKey('lr', 'sms', args.action.idempotencyKey, String(args.action.attempts)),
      payload: result.ok
        ? { to: lead.phone, body: body.slice(0, 320), provider_message_id: result.sid }
        : { to: lead.phone, error: result.errorMessage ?? 'send failed', provider_code: result.errorCode },
    }),
  ]);

  return {
    sent: result.ok,
    sid: result.sid,
    permanent: result.permanent,
    detail: result.ok ? 'sent' : `${result.errorMessage ?? 'send failed'}${result.errorCode ? ` (${result.errorCode})` : ''}`,
  };
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
  },
): Promise<number> {
  const { lead, config, now } = args;
  const recipients = config.staff_alerts.filter((r) => r.channel === 'sms');
  if (recipients.length === 0) return 0;

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
    const result = await sender.send({
      to: recipient.address,
      body,
      messagingServiceSid: config.twilio.messaging_service_sid,
      from: config.twilio.phone_number,
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
    });
  }

  if (config && args.sendAck && lead.phone && config.compliance.status === 'approved') {
    const sender = senderFor(deps, lead);
    const suppressed = await store.isSuppressed(lead.tenantId, 'sms', lead.phone, iso(args.at));
    if (sender && !suppressed) {
      const conversation = await store.getOrCreateConversation(lead.tenantId, lead.id);
      const body = renderHandoffAck(config, lead.customerName);
      const result = await sender.send({
        to: lead.phone,
        body,
        messagingServiceSid: config.twilio.messaging_service_sid,
        from: config.twilio.phone_number,
        statusCallback: deps.urls?.statusCallback ?? null,
      });
      await store.insertMessage({
        tenantId: lead.tenantId,
        conversationId: conversation.id,
        direction: 'outbound',
        providerMessageId: result.sid,
        body,
        status: result.ok ? (result.status ?? 'queued') : 'failed',
        errorClass: result.ok ? null : 'delivery',
        errorDetail: result.ok ? null : result.errorMessage,
        occurredAt: iso(args.at),
      });
      await store.emit(lead.tenantId, [
        baseEvent(lead, {
          event_type: 'sms_sent',
          occurred_at: iso(args.at),
          status: result.ok ? 'success' : 'failure',
          error_class: result.ok ? null : 'delivery',
          event_key: eventKey('lr', 'ack', lead.correlationId),
          payload: result.ok
            ? { to: lead.phone, body: body.slice(0, 320), template: 'handoff_ack' }
            : { to: lead.phone, error: result.errorMessage ?? 'send failed' },
        }),
      ]);
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
