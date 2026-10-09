/* ARC-GO-310 — the thirteen gaps the readiness map found, each closed by a test named after
 * the promise.
 *
 * `ARC_LEAD_RECOVERY_READINESS.md` listed what stood between the code and a real homeowner's
 * phone. Six of the gaps were confirmed by running scratch scenarios that were never kept;
 * this file is those scenarios, and the rest, as tests. Each `describe` is one row of the
 * map's section 4, in its order.
 *
 * Nothing here touches a network, Twilio or a model: the engine runs on its in-memory store
 * with senders that record. What only a real line can prove is still a hosted check.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALERT_CHANNELS,
  defaultConfig,
  FORWARDING_MODES,
  validateLeadRecoveryConfig,
} from '../supabase/functions/_shared/lead-recovery-config.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import {
  CLOSE_AFTER_HOURS,
  handleInboundMessage,
  handleMessageStatus,
  intakeLead,
  listUnknownSends,
  markBooked,
  runDueActions,
  settleUnknownSend,
  takeOverLead,
} from '../supabase/functions/_shared/engine/runtime.ts';
import { transition } from '../supabase/functions/_shared/engine/state-machine.ts';
import { followupAt, renderReplyAck } from '../supabase/functions/_shared/engine/templates.ts';
import { FakeClassifier } from '../supabase/functions/_shared/classifier.ts';
import { missedCallGreeting, RecordingSender, voiceResponse } from '../supabase/functions/_shared/twilio.ts';
import { MAX_VISIT_DAYS_AHEAD, MAX_VISIT_DAYS_BEHIND, answerOutcome, recordVisit, standing } from '../supabase/functions/_shared/ledger/service.ts';
import { layoutsFor } from '../supabase/functions/_shared/registry/layouts.ts';
import { LEAD_RECOVERY_ACTIONS } from '../supabase/functions/ops/lead-recovery.ts';
import { NEED_KINDS, VISIT_WINDOW_DAYS, ownerNeeds } from '../src/portal/lib/owner.js';
import { seedPublishedConfig } from './config-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

/* ── fixtures ───────────────────────────────────────────── */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ARC_NUMBER = '+16145550100';
const CUSTOMER = '+16145559911';
const SHOP = '+16145550137';
const OWNER_PHONE = '+16145550188';
const NEEDS_YOU = 'https://arc.example/portal/dashboard/needs-you';

/* a Wednesday at 10:00 Eastern: inside the default opening hours. */
const NOW = new Date('2026-09-16T14:00:00.000Z');
/* the same Wednesday at 10:30pm Eastern: well outside them. */
const LATE = new Date('2026-09-17T02:30:00.000Z');
const HOUR = 3_600_000;

function goodConfig(overrides = {}) {
  return {
    ...defaultConfig(),
    company_name: 'Halstead Heating',
    timezone: 'America/New_York',
    services: ['furnace repair', 'water heater'],
    service_area: { zips: ['43215'], cities: [], note: null },
    forwarding: { destination: SHOP, timeout_seconds: 20 },
    staff_alerts: [{ name: 'Dana', channel: 'sms', address: OWNER_PHONE }],
    compliance: { status: 'approved', brand_registered: true, campaign_ref: 'CMP123', reviewed_at: null, opt_out_language: 'Reply STOP to opt out.' },
    twilio: { subaccount_sid: null, messaging_service_sid: 'MG0123456789abcdef0123456789abcdef', phone_number: ARC_NUMBER, phone_number_sid: null },
    ...overrides,
  };
}

function setup({ config, tenants = [TENANT_A] } = {}) {
  const store = new MemoryStore();
  const validated = validateLeadRecoveryConfig(config ?? goodConfig());
  assert.equal(validated.ok, true, `the fixture config must be valid: ${validated.ok ? '' : validated.errors.join('; ')}`);
  for (const tenantId of tenants) seedPublishedConfig(store, { tenantId, config: validated.config });
  return store;
}

/* a classifier that qualifies what it reads, and keeps what it was shown. */
class ListeningClassifier extends FakeClassifier {
  heard = [];

  async classify(input) {
    this.heard.push(input.text);
    return super.classify(input);
  }
}

/* a provider that behaves for everybody except the customer. */
class PickySender extends RecordingSender {
  constructor(toCustomer) {
    super();
    this.toCustomer = toCustomer;
  }

  async send(args) {
    const result = await super.send(args);
    return args.to === CUSTOMER ? { ...result, ok: false, sid: null, status: null, ...this.toCustomer } : result;
  }
}

const UNKNOWN = { errorMessage: 'no answer in 10s', permanent: false, ambiguous: true };
const REFUSED_FOR_GOOD = { errorCode: '21211', errorMessage: 'invalid number', permanent: true, ambiguous: false };
const REFUSED_FOR_NOW = { errorCode: '20429', errorMessage: 'too many requests', permanent: false, ambiguous: false };

let counter = 0;
function deps(store, options = {}) {
  const liveSender = options.liveSender ?? new RecordingSender();
  let clock = options.now ?? NOW;
  return {
    store,
    liveSender,
    canarySender: new RecordingSender(),
    now: () => clock,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    classifierFor: () => options.classifier ?? new FakeClassifier(),
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status', ownerNeedsYou: () => NEEDS_YOU },
    uuid: () => `cccccccc-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
    worker: 'test',
  };
}

const missedCall = (overrides = {}) => ({
  tenantId: TENANT_A,
  source: 'missed_call',
  externalRef: `CA${String((counter += 1)).padStart(32, '0')}`,
  phone: CUSTOMER,
  intakeRef: ARC_NUMBER,
  consentSms: true,
  consentSource: 'inbound_call',
  ...overrides,
});

const reply = (d, body, sid) =>
  handleInboundMessage(d, { tenantId: TENANT_A, from: CUSTOMER, to: ARC_NUMBER, body, providerMessageId: sid ?? `SM${String((counter += 1)).padStart(32, '0')}` });

/* run the queue until it is empty of work due now. */
async function drain(d, rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    const summary = await runDueActions(d, { tenantId: null });
    if (summary.claimed === 0) return;
  }
}

/* a missed call whose first text has gone out: the run is waiting on the customer. */
async function texted(d, overrides) {
  const intake = await intakeLead(d, missedCall(overrides));
  await drain(d);
  assert.equal((await d.store.getRun(TENANT_A, intake.run.id)).state, 'awaiting_reply');
  return intake;
}

const runOf = (d, intake) => d.store.getRun(TENANT_A, intake.run.id);
const to = (sender, number) => sender.sent.filter((message) => message.to === number);
const openHandoffs = (store) => store.handoffs.filter((handoff) => handoff.status === 'open');
const owner = (tenantId = TENANT_A, userId = 'user-owner') => ({ kind: 'client_user', userId, tenantId, role: 'owner' });

/* the ledger's two reads, answered from the same rows the engine wrote. */
function ledgerDeps(engine) {
  const ids = new Map();
  const idOf = (row) => {
    if (!ids.has(row)) ids.set(row, `eeeeeeee-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
    return ids.get(row);
  };
  return {
    engine,
    evidence: async (tenantId, correlationId) =>
      engine.store.events
        .filter((row) => row.tenantId === tenantId && row.event.correlation_id === correlationId && !row.event.is_canary)
        .map((row) => ({ id: idOf(row), eventType: row.event.event_type, occurredAt: row.event.occurred_at, payload: row.event.payload ?? null })),
    hasTerms: async () => true,
  };
}

/* ══ 1. every reply is read ═══════════════════════════════ */

describe('every reply is read by the safety rules, whatever the run is doing', () => {
  test('a second reply after the first was read does not make the webhook fail', async () => {
    const d = deps(setup());
    const intake = await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    assert.equal((await runOf(d, intake)).state, 'qualified');

    const second = await reply(d, 'also the side door is the one to use');
    assert.equal(second.ok, true);
    assert.equal((await runOf(d, intake)).lastError, null, 'no illegal transition was attempted');
    await drain(d);
    assert.equal((await runOf(d, intake)).state, 'qualified');
  });

  test('"actually I can smell gas", sent after the lead was qualified, goes to a person and the owner is told', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    const intake = await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    const alertsBefore = to(sender, OWNER_PHONE).length;

    const second = await reply(d, 'actually I can smell gas in the basement');
    assert.match(second.outcome, /safety/);
    assert.equal((await runOf(d, intake)).state, 'handoff_required');
    await drain(d);

    const [handoff] = openHandoffs(d.store);
    assert.equal(handoff.isSafety, true);
    assert.equal(handoff.reasonCode, 'safety');
    assert.ok((await d.store.getLead(TENANT_A, intake.lead.id)).safetyFlags.includes('gas'));
    assert.equal(to(sender, OWNER_PHONE).length, alertsBefore + 1, 'the owner is alerted about the second message');
    assert.match(to(sender, OWNER_PHONE).at(-1).body, /SAFETY: .*gas/);
  });

  test('a second text sent while the first is still waiting to be read is assessed too', async () => {
    const d = deps(setup());
    const intake = await texted(d);
    await reply(d, 'my furnace stopped');
    await reply(d, 'there is smoke coming out of it');
    await drain(d);

    const [handoff] = openHandoffs(d.store);
    assert.equal(handoff.reasonCode, 'safety', 'the word smoke was read, not dropped');
    assert.ok((await d.store.getLead(TENANT_A, intake.lead.id)).safetyFlags.includes('smoke'));
    assert.equal(d.store.eventsOfType('routed').length, 0, 'a safety reply is never routed as an ordinary lead');
  });

  test('the model reads everything the customer wrote, not only the first message', async () => {
    const classifier = new ListeningClassifier();
    const d = deps(setup(), { classifier });
    await texted(d);
    await reply(d, 'the water heater is leaking a little');
    await reply(d, 'we are in 43215');
    await drain(d);

    assert.ok(classifier.heard.some((text) => /water heater/.test(text) && /43215/.test(text)), classifier.heard.join(' | '));
  });

  test('a worse message on a lead a person already has alerts them again', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    const intake = await texted(d);
    await takeOverLead(d, { tenantId: TENANT_A, leadId: intake.lead.id, actor: 'ops' });
    assert.equal(to(sender, OWNER_PHONE).length, 0);

    await reply(d, 'now there is smoke and I am scared');
    await drain(d);
    assert.equal(to(sender, OWNER_PHONE).length, 1);
    assert.match(to(sender, OWNER_PHONE)[0].body, /a new message on a lead you already have/);
    assert.equal((await runOf(d, intake)).state, 'handed_off', 'the person keeps it — nothing was resumed');
  });

  test('a safety message on a lead that already finished becomes a lead of its own, handed to a person', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    const intake = await texted(d);
    await markBooked(d, { tenantId: TENANT_A, leadId: intake.lead.id, outcome: 'booked', appointmentAt: '2026-09-18T15:00:00.000Z' });

    const result = await reply(d, 'there is a burning smell and smoke from the unit');
    assert.notEqual(result.lead.id, intake.lead.id);
    await drain(d);

    assert.equal(openHandoffs(d.store).length, 1);
    assert.equal(openHandoffs(d.store)[0].leadId, result.lead.id);
    assert.equal(to(sender, OWNER_PHONE).length, 1);
  });

  test('a redelivered second reply is still one message', async () => {
    const d = deps(setup());
    await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    const first = await reply(d, 'actually I can smell gas', 'SMredelivered0000000000000000000001');
    const again = await reply(d, 'actually I can smell gas', 'SMredelivered0000000000000000000001');
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    await drain(d);
    assert.equal(openHandoffs(d.store).length, 1);
  });

  test('the engine wrote no invalid event along any of these paths', async () => {
    const d = deps(setup());
    await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    await reply(d, 'actually I can smell gas');
    await drain(d);
    assert.deepEqual(d.store.invalidEvents, []);
  });
});

/* ══ 2. every handoff alerts ══════════════════════════════ */

describe('every handoff that says to alert the owner does', () => {
  test('a text the carrier could not deliver', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await texted(d);
    const sid = d.store.messages.find((message) => message.direction === 'outbound').providerMessageId;

    const status = await handleMessageStatus(d, { tenantId: TENANT_A, providerMessageId: sid, status: 'undelivered', errorCode: '30003', errorClass: 'delivery', permanent: true });
    assert.match(status.outcome, /handed to a person/);
    assert.equal(openHandoffs(d.store).length, 1, 'the handoff is open before any worker runs');
    await drain(d);

    assert.equal(to(sender, OWNER_PHONE).length, 1);
    assert.match(to(sender, OWNER_PHONE)[0].body, /has not heard from anyone/);
  });

  test('a redelivered delivery failure alerts once', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await texted(d);
    const sid = d.store.messages.find((message) => message.direction === 'outbound').providerMessageId;
    const failure = { tenantId: TENANT_A, providerMessageId: sid, status: 'undelivered', errorCode: '30003', errorClass: 'delivery', permanent: true };
    await handleMessageStatus(d, failure);
    await handleMessageStatus(d, failure);
    await drain(d);
    assert.equal(to(sender, OWNER_PHONE).length, 1);
  });

  test('a send whose outcome is unknown', async () => {
    const sender = new PickySender(UNKNOWN);
    const d = deps(setup(), { liveSender: sender });
    await intakeLead(d, missedCall());
    await drain(d);

    assert.equal(openHandoffs(d.store).length, 1);
    assert.equal(to(sender, OWNER_PHONE).length, 1);
    assert.match(to(sender, OWNER_PHONE)[0].body, /check the provider/);
  });

  test('a send the provider refused for good', async () => {
    const sender = new PickySender(REFUSED_FOR_GOOD);
    const d = deps(setup(), { liveSender: sender });
    await intakeLead(d, missedCall());
    await drain(d);

    assert.equal(openHandoffs(d.store).length, 1);
    assert.equal(to(sender, OWNER_PHONE).length, 1);
    assert.match(to(sender, OWNER_PHONE)[0].body, /could not be sent/);
  });

  test('retries running out', async () => {
    const sender = new PickySender(REFUSED_FOR_NOW);
    const d = deps(setup(), { liveSender: sender });
    await intakeLead(d, missedCall());
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runDueActions(d, { tenantId: null });
      d.advance(HOUR);
    }

    assert.equal(openHandoffs(d.store).length, 1);
    assert.equal(to(sender, OWNER_PHONE).length, 1, 'one alert, however many attempts');
    assert.match(to(sender, OWNER_PHONE)[0].body, /gave up/);
  });

  test('a sequence that was rightly stopped is not called a failure, and wakes nobody', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await intakeLead(d, missedCall());
    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 1);

    /* the same action put back, the way an operator's retry would. the text already went. */
    const first = d.store.actions.find((action) => action.actionType === 'send_first_response');
    first.status = 'pending';
    first.attempts = 0;
    await drain(d);

    assert.equal(to(sender, CUSTOMER).length, 1);
    assert.equal(openHandoffs(d.store).length, 0);
    assert.equal(to(sender, OWNER_PHONE).length, 0);
    assert.equal(first.status, 'cancelled');
  });
});

/* ══ 3. the alert's link ══════════════════════════════════ */

describe('the alert links to the owner\'s needs-you screen', () => {
  test('the link in an alert is the owner\'s own screen', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await texted(d);
    await reply(d, 'actually I can smell gas');
    await drain(d);
    const [alert] = to(sender, OWNER_PHONE);
    assert.ok(alert.body.includes(NEEDS_YOU), alert.body);
    assert.doesNotMatch(alert.body, /\/ops\//);
  });

  test('no function that sends an alert builds a link to the operator console', () => {
    for (const file of ['twilio/index.ts', 'dispatch/index.ts', 'lead-intake/index.ts', 'ops/lead-recovery.ts']) {
      const source = read(`supabase/functions/${file}`);
      assert.match(source, /ownerNeedsYou: \(\) => \(.*\/portal\/dashboard\/needs-you/, file);
      assert.doesNotMatch(source, /\/ops\/console\/clients\/\$\{tenantId\}/, file);
    }
  });
});

/* ══ 4. a bare "yes" ══════════════════════════════════════ */

describe('a bare "yes" tells the owner and leaves the lead able to close', () => {
  test('"yes" to "sorry we missed your call" is a customer waiting for a call, and the owner is told', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    const intake = await texted(d);

    const result = await reply(d, 'Yes');
    assert.equal(result.intent, 'acknowledgement');
    await drain(d);

    assert.equal(to(sender, OWNER_PHONE).length, 1);
    assert.match(to(sender, OWNER_PHONE)[0].body, /replied "Yes" — they are waiting to hear from you/);
    assert.equal(to(sender, CUSTOMER).length, 1, 'no follow-up chases somebody who answered');
    assert.equal((await runOf(d, intake)).state, 'awaiting_reply');
  });

  test('and the lead still closes itself if nothing more happens', async () => {
    const d = deps(setup());
    const intake = await texted(d);
    await reply(d, 'ok');
    await drain(d);
    assert.ok(d.store.pendingActions(TENANT_A).some((action) => action.actionType === 'close_run'), 'a deadline is back on the queue');

    d.advance((CLOSE_AFTER_HOURS + 1) * HOUR);
    await drain(d);
    assert.equal((await runOf(d, intake)).state, 'closed');
  });

  test('a lead that was read and routed closes itself too', async () => {
    const d = deps(setup());
    const intake = await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    assert.equal((await runOf(d, intake)).state, 'qualified');

    d.advance((CLOSE_AFTER_HOURS + 1) * HOUR);
    await drain(d);
    assert.equal((await runOf(d, intake)).state, 'closed');
  });

  test('an "ok" after the business already has the lead does not alert them twice', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    const before = to(sender, OWNER_PHONE).length;
    await reply(d, 'ok thanks');
    await reply(d, 'thanks');
    await drain(d);
    assert.equal(to(sender, OWNER_PHONE).length, before);
  });
});

/* ══ 5. the follow-up's hours ═════════════════════════════ */

describe('the follow-up respects the business\'s hours', () => {
  const anyHour = () => goodConfig({ after_hours: { behaviour: 'same_response', callback_window: 'in the morning' } });

  test('a call missed at 10:30pm is answered at once and chased when the shop opens, not at 11:30pm', async () => {
    const sender = new RecordingSender();
    const d = deps(setup({ config: anyHour() }), { liveSender: sender, now: LATE });
    await intakeLead(d, missedCall());
    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 1, 'the first text answers the call the customer just made');

    const followup = d.store.pendingActions(TENANT_A).find((action) => action.actionType === 'send_followup');
    /* thursday 08:00 eastern. */
    assert.equal(followup.runAt, '2026-09-17T12:00:00.000Z');

    d.advance(2 * HOUR);
    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 1, 'nothing at half past midnight');

    d.advance(8 * HOUR);
    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 2, 'the follow-up goes once they are open');
  });

  test('inside opening hours it goes an hour later, as before', async () => {
    const d = deps(setup());
    await intakeLead(d, missedCall());
    await drain(d);
    const followup = d.store.pendingActions(TENANT_A).find((action) => action.actionType === 'send_followup');
    assert.equal(followup.runAt, new Date(NOW.getTime() + HOUR).toISOString());
  });

  test('the lead\'s own deadline runs from when the follow-up will go', async () => {
    const d = deps(setup({ config: anyHour() }), { now: LATE });
    await intakeLead(d, missedCall());
    await drain(d);
    const close = d.store.pendingActions(TENANT_A).find((action) => action.actionType === 'close_run');
    assert.equal(close.runAt, new Date(Date.parse('2026-09-17T12:00:00.000Z') + CLOSE_AFTER_HOURS * HOUR).toISOString());
  });

  test('a business with no opening hours in the next fortnight gets no follow-up at all', async () => {
    const closed = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, []]));
    const config = validateLeadRecoveryConfig({ ...anyHour(), business_hours: closed }).config;
    assert.equal(followupAt(config, NOW), null);

    const d = deps(setup({ config: { ...anyHour(), business_hours: closed } }));
    await intakeLead(d, missedCall());
    await drain(d);
    assert.equal(d.store.actions.some((action) => action.actionType === 'send_followup'), false);
    assert.ok(d.store.pendingActions(TENANT_A).some((action) => action.actionType === 'close_run'));
  });

  test('a weekend is skipped: a friday evening call is chased on monday morning', () => {
    const config = validateLeadRecoveryConfig(goodConfig()).config;
    /* friday 18:00 eastern. */
    assert.equal(followupAt(config, new Date('2026-09-18T22:00:00.000Z')).toISOString(), '2026-09-21T12:00:00.000Z');
  });
});

/* ══ 6. a booked visit can be recorded ════════════════════ */

describe('a booked visit can be recorded by the owner', () => {
  const VISIT = '2026-09-18T15:00:00.000Z';

  async function replied(d) {
    const intake = await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    return intake.lead;
  }

  test('the owner saves the time, and the lead is booked with it on the record', async () => {
    const d = deps(setup());
    const lead = await replied(d);
    const ledger = ledgerDeps(d);

    const result = await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: VISIT });
    assert.deepEqual(result, { ok: true, result: { appointmentAt: VISIT } });

    const [booked] = d.store.eventsOfType('lead_booked');
    assert.equal(booked.event.payload.appointment_at, VISIT);
    assert.equal(booked.event.payload.recorded_by, 'user-owner');
    assert.equal((await d.store.getLead(TENANT_A, lead.id)).bookingOutcome, 'booked');
    assert.equal((await d.store.getRunForLead(TENANT_A, lead.id)).state, 'booked');
    assert.equal(d.store.pendingActions(TENANT_A).length, 0, 'the automation has stopped on this lead');

    const state = standing(await ledger.evidence(TENANT_A, lead.correlationId), new Date('2026-09-19T00:00:00.000Z'));
    assert.deepEqual([state.booked, state.appointmentAt, state.visitPassed], [true, VISIT, true]);
  });

  test('once the visit has passed the owner can answer about it — the chain reaches its last link', async () => {
    const d = deps(setup());
    const lead = await replied(d);
    const ledger = ledgerDeps(d);
    await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: VISIT });

    d.advance(72 * HOUR);
    const answer = await answerOutcome(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, input: { answer: 'happened' } });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(d.store.eventsOfType('lead_outcome_recorded').length, 1);
  });

  test('a changed time is a second row, and the first stays', async () => {
    const d = deps(setup());
    const lead = await replied(d);
    const ledger = ledgerDeps(d);
    await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: VISIT });
    await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: VISIT });
    assert.equal(d.store.eventsOfType('lead_booked').length, 1, 'the same time twice is one row');

    d.advance(HOUR);
    await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: '2026-09-19T15:00:00.000Z' });
    assert.equal(d.store.eventsOfType('lead_booked').length, 2);
    const state = standing(await ledger.evidence(TENANT_A, lead.correlationId), d.now());
    assert.equal(state.appointmentAt, '2026-09-19T15:00:00.000Z');
  });

  test('who is saving it comes from the sign-in: another client\'s member finds nothing', async () => {
    const d = deps(setup({ tenants: [TENANT_A, TENANT_B] }));
    const lead = await replied(d);
    const ledger = ledgerDeps(d);

    const stranger = await recordVisit(ledger, owner(TENANT_B), { tenantId: TENANT_B, lead: lead.correlationId, appointmentAt: VISIT });
    assert.deepEqual([stranger.ok, stranger.code], [false, 'not_found']);
    const claimed = await recordVisit(ledger, owner(TENANT_B), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: VISIT });
    assert.deepEqual([claimed.ok, claimed.code], [false, 'forbidden']);
    const nobody = await recordVisit(ledger, null, { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: VISIT });
    assert.deepEqual([nobody.ok, nobody.code], [false, 'unauthorized']);
    assert.equal(d.store.eventsOfType('lead_booked').length, 0);
  });

  test('a time that cannot be a visit is refused', async () => {
    const d = deps(setup());
    const lead = await replied(d);
    const ledger = ledgerDeps(d);
    const far = new Date(NOW.getTime() + (MAX_VISIT_DAYS_AHEAD + 2) * 24 * HOUR).toISOString();
    const long = new Date(NOW.getTime() - (MAX_VISIT_DAYS_BEHIND + 2) * 24 * HOUR).toISOString();
    for (const appointmentAt of ['tuesday', '', null, long, far]) {
      const result = await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt });
      assert.deepEqual([result.ok, result.code], [false, 'invalid'], String(appointmentAt));
    }
    assert.equal(d.store.eventsOfType('lead_booked').length, 0);
  });

  test('a visit somebody has already answered about cannot be moved from this screen', async () => {
    const d = deps(setup());
    const lead = await replied(d);
    const ledger = ledgerDeps(d);
    await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: VISIT });
    d.advance(72 * HOUR);
    await answerOutcome(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, input: { answer: 'happened' } });

    const moved = await recordVisit(ledger, owner(), { tenantId: TENANT_A, lead: lead.correlationId, appointmentAt: '2026-09-25T15:00:00.000Z' });
    assert.deepEqual([moved.ok, moved.code], [false, 'conflict']);
  });

  test('a customer who opted out has no visit to record', async () => {
    const d = deps(setup());
    const intake = await texted(d);
    await reply(d, 'STOP');
    const result = await recordVisit(ledgerDeps(d), owner(), { tenantId: TENANT_A, lead: intake.lead.correlationId, appointmentAt: VISIT });
    assert.deepEqual([result.ok, result.code], [false, 'invalid']);
  });

  test('a booking is a stop condition from every state a run can be working in', () => {
    for (const from of ['new', 'response_queued', 'awaiting_reply', 'qualifying', 'qualified', 'handoff_required', 'handed_off']) {
      assert.equal(transition(from, 'booked').ok, true, from);
    }
    for (const from of ['closed', 'suppressed', 'failed']) assert.equal(transition(from, 'booked').ok, false, from);
  });

  test('the needs-you screen lists the customers who wrote back and have no visit yet', () => {
    const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
    const lead = (id, over = {}) => ({ id, phone: '+16145550101', startedAt: at(30), replied: true, repliedAt: at(20), booked: false, handoff: null, suppressed: false, ...over });
    const data = {
      tenant: { id: TENANT_A, timezone: 'America/New_York' },
      generatedFor: NOW.toISOString(),
      attention: { items: [] },
      threads: [
        lead('waiting'),
        lead('quiet', { replied: false, repliedAt: null }),
        lead('booked', { booked: true }),
        lead('handed', { handoff: { reason: 'gas' } }),
        lead('opted-out', { suppressed: true }),
        lead('old', { repliedAt: at((VISIT_WINDOW_DAYS + 1) * 24) }),
      ],
    };
    const needs = ownerNeeds(data);
    const group = needs.groups.find((entry) => entry.key === 'visit');
    assert.deepEqual(group.items.map((item) => item.lead), ['waiting']);
    assert.match(group.items[0].reason, /cannot count/);
    assert.deepEqual(NEED_KINDS.map((kind) => kind.key), ['outcome', 'visit', 'handoff', 'other']);
  });

  test('the screen sends the business\'s own clock as an instant, through the ledger function', () => {
    const page = read('src/portal/pages/dash/NeedsYou.jsx');
    assert.match(page, /DateTime\.fromISO\(when, \{ zone: timezone \}\)/);
    assert.match(page, /ledgerApi\(tenantId\)\.visit\(item\.lead, appointmentAt\)/);
    assert.match(read('src/portal/lib/crm.js'), /run\('visit-booked', \{ lead, appointment_at: appointmentAt \}\)/);
    assert.match(read('supabase/functions/ledger/handler.ts'), /'visit-booked'/);
  });
});

/* ══ 7. one message after the customer replies ════════════ */

describe('the customer gets one reviewed message after replying', () => {
  test('once the reply has been read and passed on, the customer is told', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);

    const texts = to(sender, CUSTOMER);
    assert.equal(texts.length, 2);
    assert.equal(texts[1].body, 'Thanks — Halstead Heating has your message and will call you to set a time. Reply STOP to opt out.');
    const evidence = d.store.eventsOfType('sms_sent').map((row) => row.event);
    assert.deepEqual(evidence.map((event) => event.payload.template), ['first_response', 'reply_ack']);
    assert.equal(evidence[1].latency_ms ?? null, null, 'a message after the reply is not a response time');
  });

  test('with a booking link set, the message carries it', async () => {
    const sender = new RecordingSender();
    const d = deps(setup({ config: goodConfig({ booking_url: 'https://book.example/halstead' }) }), { liveSender: sender });
    await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    assert.match(to(sender, CUSTOMER)[1].body, /Pick a time here: https:\/\/book\.example\/halstead/);
    assert.equal(d.store.eventsOfType('sms_sent').at(-1).event.payload.template, 'reply_ack_booking');
  });

  test('it is sent once per lead, however many replies are read', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    await drain(d);
    await reply(d, 'the water heater too');
    await reply(d, 'and it is in 43215');
    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 2);
  });

  test('a lead handed to a person gets the handoff message instead, never both', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    await texted(d);
    await reply(d, 'I can smell gas');
    await drain(d);
    const texts = to(sender, CUSTOMER).map((message) => message.body);
    assert.equal(texts.length, 2);
    assert.match(texts[1], /picking this up now/);
  });

  test('the words are a reviewed template, and the booking wording never sends an empty gap', () => {
    const plain = validateLeadRecoveryConfig(goodConfig());
    assert.equal(plain.ok, true, 'the default booking wording does not need a link to be set');
    assert.equal(renderReplyAck(plain.config).templateKey, 'reply_ack');
    assert.doesNotMatch(renderReplyAck(plain.config).body, /\{\{|  /);

    const custom = validateLeadRecoveryConfig(goodConfig({ templates: { reply_ack: 'Got it — book at {{booking_url}}' } }));
    assert.equal(custom.ok, false);
    assert.ok(custom.errors.some((error) => /templates\.reply_ack uses \{\{booking_url\}\}/.test(error)));

    const unknown = validateLeadRecoveryConfig(goodConfig({ templates: { reply_ack: 'Got it {{anything}}' } }));
    assert.equal(unknown.ok, false);
  });

  test('the settings screen offers both wordings', () => {
    const parts = layoutsFor('lead_recovery_config').templates.parts.map((part) => part.key);
    assert.ok(parts.includes('reply_ack') && parts.includes('reply_ack_booking'));
  });
});

/* ══ 8. the telephony setup ═══════════════════════════════ */

describe('the telephony setup the site promises is one the engine supports', () => {
  const forwarded = (over = {}) => goodConfig({ forwarding: { destination: SHOP, timeout_seconds: 20, mode: 'business_first', ...over } });

  test('a configuration says which number customers dial, and one published before the choice existed means what it always did', () => {
    assert.deepEqual([...FORWARDING_MODES], ['arc_first', 'business_first']);
    assert.equal(validateLeadRecoveryConfig(goodConfig()).config.forwarding.mode, 'arc_first');
    assert.equal(validateLeadRecoveryConfig(forwarded()).config.forwarding.mode, 'business_first');
    const wrong = validateLeadRecoveryConfig(forwarded({ mode: 'both' }));
    assert.equal(wrong.ok, false);
    assert.ok(wrong.errors.some((error) => /forwarding\.mode must be one of/.test(error)));
  });

  test('where the business keeps its number, the caller is not made to hear a second phone ring', () => {
    const config = validateLeadRecoveryConfig(forwarded()).config;
    const answer = voiceResponse(config, { dialStatus: 'https://example.test/twilio/dial-status' });
    assert.equal(answer.missed, true, 'the call arriving is itself the missed call');
    assert.doesNotMatch(answer.twiml, /<Dial|<Number/);
    assert.match(answer.twiml, /<Say[^>]*>Thanks for calling Halstead Heating\. Sorry we missed you\./);
    assert.match(answer.twiml, /<Hangup\/>/);
    assert.doesNotMatch(missedCallGreeting('Halstead Heating'), /text/i, 'it promises nothing the gates have not decided');
  });

  test('where arc\'s number is in front, the business is rung and the dial result decides', () => {
    const config = validateLeadRecoveryConfig(goodConfig()).config;
    const answer = voiceResponse(config, { dialStatus: 'https://example.test/twilio/dial-status' });
    assert.equal(answer.missed, false);
    assert.match(answer.twiml, new RegExp(`<Number>\\${SHOP}</Number>`));
    assert.match(answer.twiml, /action="https:\/\/example\.test\/twilio\/dial-status"/);
  });

  test('a company name cannot break out of the spoken sentence', () => {
    const config = validateLeadRecoveryConfig(forwarded()).config;
    const answer = voiceResponse({ ...config, company_name: 'A & B <Heating>' }, { dialStatus: 'x' });
    assert.match(answer.twiml, /A &amp; B &lt;Heating&gt;/);
  });

  test('the webhook records the lead from the forwarded call itself, and ignores a dial result for that setup', () => {
    const webhook = read('supabase/functions/twilio/handler.ts');
    assert.match(webhook, /const answer = voiceResponse\(config/);
    assert.match(webhook, /if \(answer\.missed\) \{[\s\S]*?source: 'missed_call',[\s\S]*?externalRef: callSid,/);
    assert.match(webhook, /forwarding\.mode === 'business_first'\) return twiml\(emptyTwiml\(\)\)/);
  });

  test('a forwarded call is one lead and one text, like any other missed call', async () => {
    const sender = new RecordingSender();
    const d = deps(setup({ config: forwarded() }), { liveSender: sender });
    const call = missedCall();
    await intakeLead(d, call);
    await intakeLead(d, call);
    await drain(d);
    assert.equal(d.store.leads.length, 1);
    assert.equal(to(sender, CUSTOMER).length, 1);
  });

  test('the console and the settings screen both offer the choice', () => {
    const parts = layoutsFor('lead_recovery_config').forwarding.parts;
    assert.deepEqual(parts.find((part) => part.key === 'mode').options, FORWARDING_MODES);
    const panel = read('src/portal/components/LeadRecoveryPanel.jsx');
    assert.match(panel, /form\.forwarding_mode !== 'arc_first' \? \{ mode: form\.forwarding_mode \} : \{\}/, 'saving from the console keeps the setup that was chosen');
    assert.match(read('supabase/functions/ops/lead-recovery.ts'), /mode: config\.forwarding\.mode/);
  });
});

/* ══ 9. a voicemail pickup ════════════════════════════════ */

describe('a voicemail pickup does not read as an answered call', () => {
  test('in the setup the pilot uses there is no pickup to misread: arc dials nobody', () => {
    const config = validateLeadRecoveryConfig(goodConfig({ forwarding: { destination: SHOP, timeout_seconds: 20, mode: 'business_first' } }));
    assert.doesNotMatch(voiceResponse(config.config, { dialStatus: 'x' }).twiml, /<Dial/);
    assert.equal(config.warnings.some((warning) => /voicemail/.test(warning)), false);
  });

  test('the other setup says so every time it is validated, rather than leaving it to be found out', () => {
    const config = validateLeadRecoveryConfig(goodConfig());
    assert.equal(config.ok, true);
    assert.ok(config.warnings.some((warning) => /voicemail that picks up inside forwarding\.timeout_seconds reads as an answered call/.test(warning)));
  });
});

/* ══ 10. an unknown send can be settled ═══════════════════ */

describe('an unknown send can be settled by an operator', () => {
  async function held(options = {}) {
    const sender = new PickySender(UNKNOWN);
    const d = deps(setup({ tenants: [TENANT_A, TENANT_B] }), { liveSender: sender, ...options });
    const intake = await intakeLead(d, missedCall());
    await drain(d);
    const [attempt] = (await listUnknownSends(d, { tenantId: TENANT_A })).filter((row) => row.effectType === 'customer_sms');
    assert.equal(attempt.state, 'reconciliation_required');
    return { d, sender, intake, attempt };
  }

  test('"the provider shows it was sent" records the send once, and resends nothing', async () => {
    const { d, sender, intake, attempt } = await held();
    assert.equal(d.store.eventsOfType('sms_sent').length, 0);

    const result = await settleUnknownSend(d, { tenantId: TENANT_A, attemptId: attempt.id, verdict: 'sent', providerMessageId: 'SM0123456789abcdef0123456789abcdef', actorId: 'op-1' });
    assert.equal(result.ok, true, result.outcome);

    const settled = d.store.effects.find((effect) => effect.id === attempt.id);
    assert.deepEqual([settled.state, settled.providerMessageId], ['accepted', 'SM0123456789abcdef0123456789abcdef']);
    const [sent] = d.store.eventsOfType('sms_sent');
    assert.equal(sent.event.payload.reconciled, true);
    assert.equal(sent.event.payload.reconciled_by, 'op-1');
    assert.equal(sent.event.payload.template, 'first_response');

    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 1, 'the one attempt, never a second');
    assert.equal((await runOf(d, intake)).state, 'handoff_required', 'the lead stays with a person');
    assert.equal((await listUnknownSends(d, { tenantId: TENANT_A })).some((row) => row.id === attempt.id), false);
    assert.deepEqual(d.store.invalidEvents, []);
  });

  test('"the provider shows nothing" records that nobody texted the customer', async () => {
    const { d, sender, attempt } = await held();
    const result = await settleUnknownSend(d, { tenantId: TENANT_A, attemptId: attempt.id, verdict: 'not_sent' });
    assert.equal(result.ok, true);
    assert.match(result.outcome, /nobody has texted this customer/);
    assert.equal(d.store.effects.find((effect) => effect.id === attempt.id).state, 'rejected');
    assert.equal(d.store.eventsOfType('sms_sent').length, 0, 'a text that did not go is never counted');
    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 1);
  });

  test('it is settled once, by its own client, with a real verdict', async () => {
    const { d, attempt } = await held();
    for (const [args, pattern] of [
      [{ tenantId: TENANT_B, attemptId: attempt.id, verdict: 'sent' }, /no held send/],
      [{ tenantId: TENANT_A, attemptId: attempt.id, verdict: 'probably' }, /sent or not_sent/],
      [{ tenantId: TENANT_A, attemptId: attempt.id, verdict: 'sent', providerMessageId: 'not-an-id' }, /not a message id/],
      [{ tenantId: TENANT_A, attemptId: 'nope', verdict: 'sent' }, /no held send/],
    ]) {
      const result = await settleUnknownSend(d, args);
      assert.equal(result.ok, false);
      assert.match(result.outcome, pattern);
    }
    assert.equal((await settleUnknownSend(d, { tenantId: TENANT_A, attemptId: attempt.id, verdict: 'sent' })).ok, true);
    const again = await settleUnknownSend(d, { tenantId: TENANT_A, attemptId: attempt.id, verdict: 'not_sent' });
    assert.equal(again.ok, false, 'a settled send is not on the list any more');
  });

  test('a send still inside its own request is not offered for settling', async () => {
    const { d, attempt } = await held();
    const live = d.store.effects.find((effect) => effect.id === attempt.id);
    live.state = 'dispatching';
    live.dispatchStartedAt = d.now().toISOString();
    assert.equal((await listUnknownSends(d, { tenantId: TENANT_A })).some((row) => row.id === attempt.id), false);
    d.advance(HOUR);
    assert.equal((await listUnknownSends(d, { tenantId: TENANT_A })).some((row) => row.id === attempt.id), true, 'a worker that died mid-send is');
  });

  test('the console has the action and the two buttons', () => {
    assert.ok(LEAD_RECOVERY_ACTIONS.includes('lead-recovery-settle-send'));
    const panel = read('src/portal/components/LeadRecoveryPanel.jsx');
    assert.match(panel, /settleUnknownSend\(tenantId, attempt\.id/);
    assert.match(panel, /the provider shows it was sent/);
    assert.match(panel, /the provider shows nothing/);
  });
});

/* ══ 11. an email recipient ═══════════════════════════════ */

describe('an alert recipient on email is refused until email alerts exist', () => {
  test('the validator refuses one, and says what to do instead', () => {
    const result = validateLeadRecoveryConfig(goodConfig({ staff_alerts: [{ name: 'Dana', channel: 'email', address: 'dana@example.com' }] }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /email alerts are not built yet/.test(error)), result.errors.join('; '));
  });

  test('so nobody can publish a list that reads as set up and alerts no one', () => {
    assert.deepEqual([...ALERT_CHANNELS], ['sms']);
    const mixed = validateLeadRecoveryConfig(
      goodConfig({ staff_alerts: [{ name: 'Dana', channel: 'sms', address: OWNER_PHONE }, { name: 'Office', channel: 'email', address: 'office@example.com' }] }),
    );
    assert.equal(mixed.ok, false);
    assert.deepEqual(layoutsFor('lead_recovery_config').staff_alerts.items.columns.find((column) => column.key === 'channel').options, ['sms']);
  });
});

/* ══ 12. the operator's minimum ═══════════════════════════ */

describe('an operator can stop any lead, suppress a number, and book or close a lead', () => {
  test('stopping an ordinary lead cancels everything queued for it', async () => {
    const sender = new RecordingSender();
    const d = deps(setup(), { liveSender: sender });
    const intake = await texted(d);
    assert.ok(d.store.pendingActions(TENANT_A).length > 0);

    const result = await takeOverLead(d, { tenantId: TENANT_A, leadId: intake.lead.id, note: 'stopped from the console' });
    assert.equal(result.ok, true);
    assert.equal(d.store.pendingActions(TENANT_A).length, 0);
    d.advance(5 * HOUR);
    await drain(d);
    assert.equal(to(sender, CUSTOMER).length, 1, 'no follow-up after a person stopped it');
  });

  test('a lead still being read can be booked or closed by a person', async () => {
    const d = deps(setup());
    const intake = await texted(d);
    await reply(d, 'furnace repair please, we are in 43215');
    assert.equal((await runOf(d, intake)).state, 'qualifying');
    await markBooked(d, { tenantId: TENANT_A, leadId: intake.lead.id, outcome: 'booked', appointmentAt: '2026-09-18T15:00:00.000Z' });
    assert.equal((await runOf(d, intake)).state, 'booked');
    assert.equal(d.store.pendingActions(TENANT_A).length, 0);
  });

  test('every one of them has a button, on any lead and not only one already handed off', () => {
    const panel = read('src/portal/components/LeadRecoveryPanel.jsx');
    assert.match(panel, /<LeadControls tenantId=\{tenantId\} lead=\{lead\}/);
    assert.match(panel, /takeOverLead\(tenantId, lead\.id/);
    assert.match(panel, /recordLeadOutcome\(tenantId, lead\.id, 'booked', null, at\.toUTC\(\)\.toISO\(\)\)/);
    assert.match(panel, /recordLeadOutcome\(tenantId, lead\.id, outcome\)/);
    assert.match(panel, /suppressLeadContact\(tenantId, \{ address: number\.trim\(\) \}\)/);
    for (const action of ['lead-recovery-take-over', 'lead-recovery-book', 'lead-recovery-suppress']) {
      assert.ok(LEAD_RECOVERY_ACTIONS.includes(action), action);
    }
  });
});

/* ══ 13. the documents ════════════════════════════════════ */

describe('the documents say what the code does', () => {
  test('nothing claims the first text is sent by the webhook', () => {
    for (const file of ['DEPLOYMENT.md', 'supabase/functions/dispatch/index.ts']) {
      assert.doesNotMatch(read(file), /webhook's own dispatch call/, file);
    }
    assert.match(read('DEPLOYMENT.md'), /within about a minute/);
    for (const file of ['supabase/functions/twilio/index.ts', 'supabase/functions/twilio/handler.ts', 'supabase/functions/lead-intake/index.ts']) {
      assert.doesNotMatch(read(file), /runDueActions/, `${file} queues and returns`);
    }
  });

  test('the deployment guide lists every migration in the folder up to the last one applied', () => {
    const guide = read('DEPLOYMENT.md');
    for (const migration of ['0025', '0026', '0027', '0028']) assert.match(guide, new RegExp(`\\b${migration}_`), migration);
    assert.doesNotMatch(guide, /module_configs\.config\.twilio/);
  });

  test('the caller\'s network name is never used as the customer\'s name', () => {
    for (const file of ['index.ts', 'handler.ts']) {
      assert.doesNotMatch(read(`supabase/functions/twilio/${file}`), /CallerName/, file);
    }
  });

  test('the readiness map has no code gap left', () => {
    const map = read('docs/architecture/ARC_LEAD_RECOVERY_READINESS.md');
    const table = map.slice(map.indexOf('## 2. The map'), map.indexOf('## 3. Item by item'));
    assert.doesNotMatch(table, /\*\*Gap\*\*|\*\*gap\*\*/);
    assert.match(map, /ARC-GO-310/);
  });
});
