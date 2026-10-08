/* ARC-MK-210 — one lead's events, written the way the engine writes them.
 *
 * shared by the ledger's tests and the owner portal's, so both read the rule off the same
 * shape of log. everything is relative to a frozen NOW: a test here cannot start failing at
 * midnight or on the first of a month.
 */

import { DateTime } from 'luxon';

export const LEDGER_NOW = DateTime.fromISO('2026-10-20T16:00:00.000Z', { zone: 'utc' });

export const LEDGER_TENANT = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: 'Example Heating',
  slug: 'example',
  timezone: 'America/New_York',
  status: 'active',
  createdAt: LEDGER_NOW.minus({ days: 200 }).toISO(),
  modules: ['lead_capture'],
};

let counter = 0;

export function event(eventType, occurredAt, overrides = {}) {
  counter += 1;
  return {
    id: overrides.id ?? `ev-${counter}`,
    tenantId: LEDGER_TENANT.id,
    eventType,
    workflowId: 'arc_lead_recovery',
    executionId: null,
    correlationId: null,
    status: 'success',
    payload: {},
    latencyMs: null,
    isCanary: false,
    occurredAt,
    recordedAt: occurredAt,
    eventKey: `key-${counter}`,
    entityType: null,
    entityId: null,
    sourceSystem: 'twilio',
    externalId: null,
    actor: 'automation',
    errorClass: null,
    ...overrides,
  };
}

export const daysAgo = (days, hours = 0) => LEDGER_NOW.minus({ days, hours }).toISO();
export const daysAhead = (days) => LEDGER_NOW.plus({ days }).toISO();

/**
 * one lead's log. the default is the whole chain up to a visit that has passed and that
 * nobody has answered about; every option removes or adds one link.
 *
 *   arrived     ISO time of the call (default: six days ago)
 *   source      'missed_call' | 'web_form'
 *   text        false: arc never texted.    textFailed  true: the send failed.
 *   reply       false: nobody wrote back.   replyBeforeText  true: they wrote first.
 *   visitAt     ISO time of the visit; null: booked with no time; undefined: not booked
 *   bookings    extra `lead_booked` rows: [{ at, visitAt }]
 *   askedAt     when arc asked whether the job happened
 *   answers     [{ id, at, outcome, reason }]
 *   settlements [{ at, decision, disputeId }]
 */
export function chain(id, options = {}) {
  const arrived = DateTime.fromISO(options.arrived ?? daysAgo(6), { zone: 'utc' });
  const at = (minutes) => arrived.plus({ minutes }).toISO();
  const on = (eventType, occurredAt, overrides = {}) => event(eventType, occurredAt, { correlationId: id, ...overrides });
  const phone = options.phone ?? '+16145550101';
  const source = options.source ?? 'missed_call';
  const events = [];

  if (source === 'missed_call') events.push(on('call_missed', at(0), { payload: { from: phone, caller: options.name ?? null } }));
  events.push(on('lead_received', at(0.02), { payload: { source, phone, caller: options.name ?? null }, isCanary: options.canary === true }));

  if (options.text !== false) {
    events.push(
      on('sms_sent', at(0.1), options.textFailed ? { status: 'failure', payload: { error: 'refused' } } : { latencyMs: 4000 }),
    );
  }
  if (options.deliveryFailed) events.push(on('message_failed', at(0.3), { status: 'failure', payload: { provider_code: '30003' } }));
  if (options.reply !== false) events.push(on('reply_received', options.replyBeforeText ? at(0.05) : at(4)));
  if (options.handoff) events.push(on('handoff_requested', at(5), { payload: { reason: options.handoff, reason_code: 'safety', safety: true } }));
  if (options.suppressed) events.push(on('lead_suppressed', at(options.suppressedAfter ?? 5), { actor: 'human', payload: { reason: options.suppressed } }));
  if (options.outOfArea) events.push(on('lead_qualified', at(5), { payload: { outcome: 'out_of_area', in_service_area: false } }));

  if (options.visitAt !== undefined) {
    events.push(
      on('lead_booked', options.bookedAt ?? at(120), {
        actor: 'human',
        payload: { outcome: 'booked', appointment_at: options.visitAt, ...(options.bookedBy ? { booked_by: options.bookedBy } : {}) },
      }),
    );
  }
  for (const booking of options.bookings ?? []) {
    events.push(on('lead_booked', booking.at, { actor: 'human', payload: { outcome: 'booked', appointment_at: booking.visitAt } }));
  }
  if (options.askedAt) events.push(on('lead_outcome_requested', options.askedAt));
  for (const answer of options.answers ?? []) {
    events.push(
      on('lead_outcome_recorded', answer.at, {
        id: answer.id,
        actor: 'human',
        payload: { outcome: answer.outcome, reason: answer.reason ?? null, answered_by: answer.by ?? 'owner' },
      }),
    );
  }
  for (const settlement of options.settlements ?? []) {
    events.push(
      on('lead_dispute_settled', settlement.at, {
        actor: 'human',
        payload: { decision: settlement.decision, dispute_id: settlement.disputeId ?? null },
      }),
    );
  }
  if (options.canary) return events.map((row) => ({ ...row, isCanary: true }));
  return events;
}

export const terms = (occurredAt, payload = {}) =>
  event('pilot_terms_recorded', occurredAt, {
    actor: 'human',
    sourceSystem: 'manual',
    payload: { base_cents: 20000, per_job_cents: 9000, cap_cents: 100000, dispute_window_days: 7, ...payload },
  });
