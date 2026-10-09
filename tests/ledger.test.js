/* ARC-MK-210 — the proof ledger: what evidence makes a job count.
 *
 * The promises, each tested by name:
 *   - a job counts only with every link on record, in order; remove one and it stops;
 *   - a missing earlier link under a later one is "cannot be proven", never counted;
 *   - silence only counts once the owner was asked and the dispute window has passed;
 *   - an answer is appended, a changed mind is a new row, and a double tap is one row;
 *   - the fee is arithmetic over the log, and with no terms it is null, never a zero;
 *   - the demo's seven examples and a real lead go through the same rule;
 *   - one client's evidence can never count a job for another.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISPUTE_REASONS,
  LEDGER_STATUS,
  LEDGER_STATUSES,
  buildLedger,
  feeOwedCents,
  ledgerStatus,
  termsFromEvents,
} from '../src/portal/lib/ledger.js';
import { buildDashboardData } from '../src/portal/lib/dashboard-data.js';
import { toEvent } from '../src/portal/lib/event-row.js';
import { eventLabel } from '../src/portal/lib/format.js';
import { ACCOUNT_EVENT_TYPES, EVENT_TYPES as PORTAL_EVENT_TYPES, LEAD_CAPTURE_EVENT_TYPES, moduleForEvent } from '../src/portal/lib/types.js';
import { PROOF_LEDGER_LEADS, ledgerVerdict } from '../src/portal/demo/proof-ledger.js';
import { site } from '../src/data/site.js';
import { EVENT_TYPES as BOUNDARY_EVENT_TYPES, validateEvent } from '../supabase/functions/_shared/event-validation.ts';
import {
  DISPUTE_REASON_KEYS,
  LEDGER_OUTCOMES,
  parseOutcomeInput,
  parseSettlementInput,
  parseTermsInput,
} from '../supabase/functions/_shared/ledger/model.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import {
  intakeLead,
  markBooked,
  recordAnsweredCall,
  recordOutcome,
  recordPilotTerms,
  settleDispute,
} from '../supabase/functions/_shared/engine/runtime.ts';
import { FakeClassifier } from '../supabase/functions/_shared/classifier.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { leadRecoveryConfig, seedPublishedConfig } from './config-fixtures.js';
import { LEDGER_NOW as NOW, LEDGER_TENANT as TENANT, chain, daysAgo, daysAhead, event, terms } from './ledger-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const NEW_TYPES = ['call_answered', 'lead_outcome_requested', 'lead_outcome_recorded', 'lead_dispute_settled', 'pilot_terms_recorded'];

/* the whole chain from the log to a lead's verdict, the way the portal runs it. */
const derive = (events, now = NOW) => buildDashboardData(TENANT, events, now);
const verdictOf = (events, id = 'lead-1', now = NOW) => derive(events, now).threads.find((lead) => lead.id === id)?.ledger;
const statusOf = (options, extra = []) => verdictOf([...chain('lead-1', options), ...extra]).status;

const VISIT = daysAgo(4);
const whole = { visitAt: VISIT, answers: [{ id: 'ans-1', at: daysAgo(3), outcome: 'happened' }] };

/* ── the vocabulary ─────────────────────────────────────── */

describe('the ledger’s event types', () => {
  test('the browser and the ingest boundary agree on every event type', () => {
    assert.deepEqual([...PORTAL_EVENT_TYPES].sort(), [...BOUNDARY_EVENT_TYPES].sort());
    assert.equal(new Set(PORTAL_EVENT_TYPES).size, PORTAL_EVENT_TYPES.length, 'no type is listed twice');
  });

  test('the five new types are accepted at the door, and each reads as a sentence', () => {
    for (const type of NEW_TYPES) {
      assert.equal(validateEvent({ event_type: type, occurred_at: NOW.toISO() }).ok, true, type);
      assert.notEqual(eventLabel(type, {}), type.replace(/_/g, ' '), `${type} has its own words`);
    }
  });

  test('four belong to lead capture, and the terms to the account', () => {
    for (const type of NEW_TYPES.slice(0, 4)) assert.ok(LEAD_CAPTURE_EVENT_TYPES.includes(type), type);
    assert.deepEqual(ACCOUNT_EVENT_TYPES, ['pilot_terms_recorded']);
    assert.equal(moduleForEvent('pilot_terms_recorded'), 'account');
  });

  test('terms on record do not make a phone line look live', () => {
    const data = derive([terms(daysAgo(2))]);
    assert.equal(data.availability.lead_capture.state, 'awaiting');
  });

  test('the dispute reasons are the homepage’s seven, in its order and its words', () => {
    assert.deepEqual(DISPUTE_REASONS.map((reason) => reason.label), site.price.disputeReasons);
    assert.equal(new Set(DISPUTE_REASON_KEYS).size, 7);
  });

  test('the contract names every type and counts them', () => {
    const contract = read('EVENT_CONTRACT.md');
    for (const type of BOUNDARY_EVENT_TYPES) assert.ok(contract.includes(`\`${type}\``), `EVENT_CONTRACT.md names ${type}`);
    assert.ok(contract.includes(`${BOUNDARY_EVENT_TYPES.length} types`), 'the count in the contract is the real one');
  });
});

/* ── the rule ───────────────────────────────────────────── */

describe('the rule, on plain facts', () => {
  const base = { answered: false, texted: true, replied: true, booked: true, visit: 'passed', answer: null, asked: false, windowClosed: false };

  test('there are nine statuses, and only a job that counts is billed', () => {
    assert.deepEqual(LEDGER_STATUSES, ['answered', 'unverified', 'not_billable', 'handed_off', 'booked', 'needs_owner', 'disputed', 'confirmed', 'billable']);
    assert.deepEqual(LEDGER_STATUSES.filter((status) => LEDGER_STATUS[status].billed), ['confirmed', 'billable']);
  });

  test('every status comes with a reason, in a sentence', () => {
    const cases = [
      { ...base, answered: true },
      { ...base, texted: false },
      { ...base, texted: false, replied: false, booked: false },
      { ...base, handoff: true },
      { ...base, visit: 'ahead' },
      base,
      { ...base, answer: { outcome: 'not_counted', reason: 'spam' } },
      { ...base, answer: { outcome: 'happened' } },
      { ...base, asked: true, windowClosed: true },
    ];
    assert.deepEqual(
      cases.map((facts) => ledgerStatus(facts).status),
      ['answered', 'unverified', 'not_billable', 'handed_off', 'booked', 'needs_owner', 'disputed', 'confirmed', 'billable'],
    );
    for (const facts of cases) assert.match(ledgerStatus(facts).reason, /[.?]$/);
  });

  test('a call you answered yourself is yours, whatever else is on the lead', () => {
    assert.equal(ledgerStatus({ ...base, answered: true, answer: { outcome: 'happened' } }).billed, false);
  });

  test('a booking a person typed in is not the customer answering — but their own booking is', () => {
    assert.equal(ledgerStatus({ ...base, replied: false, answer: { outcome: 'happened' } }).status, 'unverified');
    assert.equal(ledgerStatus({ ...base, replied: false, customerBooked: true, answer: { outcome: 'happened' } }).status, 'confirmed');
  });
});

/* ── from the event log ─────────────────────────────────── */

describe('a job counts only when every link is on record', () => {
  test('the whole chain counts, and the owner’s yes is what confirms it', () => {
    const verdict = verdictOf(chain('lead-1', whole));
    assert.equal(verdict.status, 'confirmed');
    assert.equal(verdict.billed, true);
    assert.equal(verdict.billableAt, new Date(daysAgo(3)).toISOString());
  });

  for (const [name, broken, status] of [
    ['arc never texted', { text: false }, 'unverified'],
    ['the text failed to send', { textFailed: true }, 'unverified'],
    ['the carrier refused the text and nobody replied', { deliveryFailed: true, reply: false }, 'unverified'],
    ['the customer never replied', { reply: false }, 'unverified'],
    ['the customer wrote before arc texted', { replyBeforeText: true }, 'unverified'],
    ['the booking carries no visit time', { visitAt: null }, 'unverified'],
    ['the visit was booked before the text', { bookedAt: daysAgo(7) }, 'unverified'],
    ['it was a wrong number', { suppressed: 'wrong_contact' }, 'not_billable'],
    ['it was handed to a person', { handoff: 'smelled gas' }, 'handed_off'],
    ['the visit is still ahead', { visitAt: daysAhead(1), answers: [] }, 'booked'],
    ['nobody has answered', { answers: [] }, 'needs_owner'],
  ]) {
    test(`it stops counting when ${name}`, () => {
      const verdict = verdictOf(chain('lead-1', { ...whole, ...broken }));
      assert.equal(verdict.status, status);
      assert.equal(verdict.billed, false);
    });
  }

  test('with nothing booked it does not count, and the reason is the first gap', () => {
    assert.match(verdictOf(chain('lead-1', { reply: false })).reason, /never answered/);
    assert.match(verdictOf(chain('lead-1', {})).reason, /nothing was booked/);
    assert.match(verdictOf(chain('lead-1', { text: false, reply: false })).reason, /never texted/);
    assert.match(verdictOf(chain('lead-1', { suppressed: 'opt_out' })).reason, /no more texts/);
    assert.match(verdictOf(chain('lead-1', { outOfArea: true })).reason, /outside your area/);
  });

  test('a customer who opts out after the visit was booked does not unseat the job', () => {
    assert.equal(statusOf({ ...whole, suppressed: 'opt_out', suppressedAfter: 200 }), 'confirmed');
  });

  test('a website form counts the same way: there was nobody to pick up', () => {
    assert.equal(statusOf({ ...whole, source: 'web_form' }), 'confirmed');
  });

  test('a rescheduled visit is a second row, and the latest one is read', () => {
    const moved = { ...whole, answers: [], bookings: [{ at: daysAgo(4, 12), visitAt: daysAhead(2) }] };
    const verdict = verdictOf(chain('lead-1', moved));
    assert.equal(verdict.status, 'booked', 'the first visit time has passed, the second has not');
    assert.equal(verdict.appointmentAt, daysAhead(2));
  });

  test('a canary is never a job', () => {
    const data = derive(chain('lead-1', { ...whole, canary: true }));
    assert.equal(data.threads.length, 0);
    assert.equal(data.ledger.totals.billed, 0);
  });
});

describe('the same number, calling again before its visit', () => {
  test('is one job, billed once at most', () => {
    const first = chain('lead-1', { arrived: daysAgo(6), visitAt: VISIT, answers: [{ id: 'a1', at: daysAgo(3), outcome: 'happened' }] });
    const again = chain('lead-2', { arrived: daysAgo(5), visitAt: VISIT, answers: [{ id: 'a2', at: daysAgo(3), outcome: 'happened' }] });
    const data = derive([...first, ...again]);
    const byId = Object.fromEntries(data.threads.map((lead) => [lead.id, lead.ledger]));
    assert.equal(byId['lead-1'].status, 'confirmed');
    assert.equal(byId['lead-2'].status, 'not_billable');
    assert.match(byId['lead-2'].reason, /one job/);
    assert.equal(data.ledger.totals.billed, 1);
  });

  test('a call after that visit is a new job', () => {
    const first = chain('lead-1', { arrived: daysAgo(20), visitAt: daysAgo(18), answers: [{ id: 'a1', at: daysAgo(17), outcome: 'happened' }] });
    const later = chain('lead-2', { arrived: daysAgo(6), visitAt: VISIT, answers: [{ id: 'a2', at: daysAgo(3), outcome: 'happened' }] });
    assert.equal(derive([...first, ...later]).ledger.totals.billed, 2);
  });

  test('another customer’s number is never a duplicate', () => {
    const data = derive([...chain('lead-1', whole), ...chain('lead-2', { ...whole, phone: '+16145550202' })]);
    assert.equal(data.ledger.totals.billed, 2);
  });
});

/* ── the owner's answer ─────────────────────────────────── */

describe('the owner’s answer', () => {
  test('“quoted, not sold yet” is a visit that happened', () => {
    const verdict = verdictOf(chain('lead-1', { visitAt: VISIT, answers: [{ id: 'a1', at: daysAgo(3), outcome: 'quoted' }] }));
    assert.equal(verdict.status, 'confirmed');
    assert.match(verdict.reason, /quote is still open/);
  });

  test('a changed mind is a new row, and the latest answer stands', () => {
    const answers = [
      { id: 'a1', at: daysAgo(3), outcome: 'happened' },
      { id: 'a2', at: daysAgo(2), outcome: 'not_counted', reason: 'did_not_happen' },
    ];
    assert.equal(statusOf({ visitAt: VISIT, answers }), 'disputed');
    assert.equal(statusOf({ visitAt: VISIT, answers: [...answers, { id: 'a3', at: daysAgo(1), outcome: 'happened' }] }), 'confirmed');
  });

  test('a cancellation before the visit is not a dispute: there was never a job to bill', () => {
    const verdict = verdictOf(chain('lead-1', { visitAt: VISIT, answers: [{ id: 'a1', at: daysAgo(5), outcome: 'not_counted', reason: 'customer_cancelled' }] }));
    assert.equal(verdict.status, 'not_billable');
    assert.match(verdict.reason, /cancelled before the visit/);
  });

  test('a job disputed after the visit is not billed while it is open', () => {
    const verdict = verdictOf(chain('lead-1', { visitAt: VISIT, answers: [{ id: 'a1', at: daysAgo(3), outcome: 'not_counted', reason: 'owner_first' }] }));
    assert.equal(verdict.status, 'disputed');
    assert.equal(verdict.billed, false);
    assert.match(verdict.reason, /you got there first/);
  });

  test('an operator settles it: accepted is not billed, rejected counts from the day it was settled', () => {
    const dispute = { visitAt: VISIT, answers: [{ id: 'a1', at: daysAgo(3), outcome: 'not_counted', reason: 'spam' }] };
    assert.equal(statusOf({ ...dispute, settlements: [{ at: daysAgo(2), decision: 'accepted', disputeId: 'a1' }] }), 'not_billable');
    const rejected = verdictOf(chain('lead-1', { ...dispute, settlements: [{ at: daysAgo(2), decision: 'rejected', disputeId: 'a1' }] }));
    assert.equal(rejected.status, 'billable');
    assert.equal(rejected.billableAt, daysAgo(2));
  });

  test('a settlement is of one answer: it says nothing about the next one', () => {
    const options = {
      visitAt: VISIT,
      answers: [
        { id: 'a1', at: daysAgo(3), outcome: 'not_counted', reason: 'spam' },
        { id: 'a2', at: daysAgo(1), outcome: 'not_counted', reason: 'duplicate' },
      ],
      settlements: [{ at: daysAgo(2), decision: 'rejected', disputeId: 'a1' }],
    };
    assert.equal(statusOf(options), 'disputed');
  });
});

/* ── silence ────────────────────────────────────────────── */

describe('a job nobody answered about', () => {
  const quiet = { arrived: daysAgo(20), visitAt: daysAgo(18) };

  test('waits on the owner for ever if arc never asked', () => {
    assert.equal(statusOf(quiet, [terms(daysAgo(30))]), 'needs_owner');
  });

  test('waits while the window is open, and counts once it has passed', () => {
    assert.equal(statusOf({ ...quiet, visitAt: daysAgo(3), askedAt: daysAgo(3) }, [terms(daysAgo(30))]), 'needs_owner');
    const verdict = verdictOf([...chain('lead-1', { ...quiet, askedAt: daysAgo(17) }), terms(daysAgo(30))]);
    assert.equal(verdict.status, 'billable');
    assert.equal(verdict.billableAt, daysAgo(10), 'seven days after it was asked, not after the visit');
  });

  test('never counts by silence without terms: there is no window to pass', () => {
    assert.equal(statusOf({ ...quiet, askedAt: daysAgo(17) }), 'needs_owner');
  });

  test('a dispute that arrives after the window is recorded, shown to an operator, and does not unbill the job', () => {
    const late = { ...quiet, askedAt: daysAgo(17), answers: [{ id: 'a1', at: daysAgo(2), outcome: 'not_counted', reason: 'did_not_happen' }] };
    const data = derive([...chain('lead-1', late), terms(daysAgo(30))]);
    const verdict = data.threads[0].ledger;
    assert.equal(verdict.status, 'billable');
    assert.equal(verdict.lateDispute, true);
    assert.equal(data.ledger.lateDisputes, 1);
    assert.equal(data.ledger.ownerSaidNo, 1);
    const conceded = [...chain('lead-1', { ...late, settlements: [{ at: daysAgo(1), decision: 'accepted', disputeId: 'a1' }] }), terms(daysAgo(30))];
    assert.equal(verdictOf(conceded).status, 'not_billable', 'an operator can still concede it');
  });

  test('a late yes still confirms: it is in nobody’s way', () => {
    const options = { ...quiet, askedAt: daysAgo(17), answers: [{ id: 'a1', at: daysAgo(1), outcome: 'happened' }] };
    assert.equal(statusOf(options, [terms(daysAgo(30))]), 'confirmed');
  });
});

/* ── the fee ────────────────────────────────────────────── */

describe('the fee is arithmetic over the log', () => {
  const job = (id, confirmedAt, phone) =>
    chain(id, { phone, arrived: daysAgo(12), visitAt: daysAgo(11), answers: [{ id: `ans-${id}`, at: confirmedAt, outcome: 'happened' }] });

  test('no terms on record: the fee is null, never a zero', () => {
    const data = derive(job('lead-1', daysAgo(3), '+16145550101'));
    assert.equal(data.ledger.terms, null);
    assert.equal(data.ledger.month.billed, 1);
    assert.equal(data.ledger.month.feeCents, null);
    assert.equal(feeOwedCents(null, 3), null);
  });

  test('base plus each job that became billable this month', () => {
    const data = derive([...job('lead-1', daysAgo(3), '+16145550101'), ...job('lead-2', daysAgo(2), '+16145550102'), terms(daysAgo(30))]);
    assert.equal(data.ledger.month.billed, 2);
    assert.equal(data.ledger.month.feeCents, 20000 + 2 * 9000);
    assert.equal(data.ledger.month.capped, false);
  });

  test('a month with no job that counts still owes the base, and nothing more', () => {
    assert.equal(derive([...chain('lead-1', {}), terms(daysAgo(30))]).ledger.month.feeCents, 20000);
  });

  test('it is held at the cap', () => {
    const data = derive([...job('lead-1', daysAgo(3), '+16145550101'), ...job('lead-2', daysAgo(2), '+16145550102'), terms(daysAgo(30), { cap_cents: 25000 })]);
    assert.equal(data.ledger.month.feeCents, 25000);
    assert.equal(data.ledger.month.capped, true);
    assert.equal(feeOwedCents({ baseCents: 100, perJobCents: 50, capCents: null }, 4), 300, 'no cap agreed is no cap');
  });

  test('a job belongs to the month it became billable in, in the business’s own timezone', () => {
    /* 02:00 UTC on the 1st is still the 30th of September in New York. */
    const visited = (id, confirmedAt, phone) =>
      chain(id, { phone, arrived: '2026-09-28T15:00:00.000Z', visitAt: '2026-09-29T15:00:00.000Z', answers: [{ id: `ans-${id}`, at: confirmedAt, outcome: 'happened' }] });
    const data = derive([...visited('lead-1', '2026-10-01T02:00:00.000Z', '+16145550101'), ...visited('lead-2', '2026-10-01T05:00:00.000Z', '+16145550102'), terms(daysAgo(40))]);
    assert.equal(data.ledger.month.key, '2026-10');
    assert.equal(data.ledger.totals.billed, 2);
    assert.equal(data.ledger.month.billed, 1);
  });

  test('disputed and unanswered jobs are in no fee', () => {
    const disputed = chain('lead-1', { visitAt: VISIT, answers: [{ id: 'a1', at: daysAgo(3), outcome: 'not_counted', reason: 'spam' }] });
    const waiting = chain('lead-2', { phone: '+16145550102', visitAt: VISIT });
    assert.equal(derive([...disputed, ...waiting, terms(daysAgo(30))]).ledger.month.feeCents, 20000);
  });

  test('the latest terms on record are the ones in force, and a broken row is not terms', () => {
    const older = terms(daysAgo(30));
    const newer = terms(daysAgo(5), { per_job_cents: 7000 });
    const broken = terms(daysAgo(1), { base_cents: -5 });
    assert.equal(termsFromEvents([newer, older, broken]).perJobCents, 7000);
    assert.equal(termsFromEvents([broken]), null);
  });

  test('answered calls are a count once the line reports one, and unknown before', () => {
    assert.equal(derive(chain('lead-1', {})).ledger.callsAnswered, null);
    const data = derive([...chain('lead-1', {}), event('call_answered', daysAgo(1)), event('call_answered', daysAgo(2))]);
    assert.equal(data.ledger.callsAnswered, 2);
    assert.equal(data.threads.length, 1, 'an answered call is not a lead');
  });
});

/* ── one rule ───────────────────────────────────────────── */

describe('the demo’s seven examples and a real lead go through the same rule', () => {
  /* each written example, as the log a real lead with that story would leave. */
  const asLog = {
    confirmed: whole,
    booked: { visitAt: daysAhead(1) },
    unconfirmed: { visitAt: VISIT },
    'no-reply': { reply: false },
    'wrong-number': { suppressed: 'wrong_contact' },
    cancelled: { source: 'web_form', visitAt: VISIT, answers: [{ id: 'a1', at: daysAgo(5), outcome: 'not_counted', reason: 'customer_cancelled' }] },
    handoff: { handoff: 'the reply sounded unsafe' },
  };

  test('every example lands on the same status and the same reason either way', () => {
    assert.deepEqual(Object.keys(asLog), PROOF_LEDGER_LEADS.map((lead) => lead.key));
    for (const lead of PROOF_LEDGER_LEADS) {
      const written = ledgerVerdict(lead);
      const derived = verdictOf(chain('lead-1', asLog[lead.key]));
      assert.equal(derived.status, written.status, lead.key);
      assert.equal(derived.reason, written.reason, lead.key);
    }
  });

  test('the demo file holds no rule of its own', () => {
    const source = read('src/portal/demo/proof-ledger.js');
    assert.match(source, /ledgerStatus\(ledgerFacts\(lead\)\)/);
    assert.doesNotMatch(source, /billed: (true|false)/);
  });
});

/* ── isolation ──────────────────────────────────────────── */

describe('one client’s evidence never counts a job for another', () => {
  test('an answer stamped with another client is dropped before anything is derived', () => {
    const mine = chain('lead-1', { visitAt: VISIT });
    const theirs = event('lead_outcome_recorded', daysAgo(3), {
      tenantId: 'bbbbbbbb-0000-4000-8000-000000000002',
      correlationId: 'lead-1',
      actor: 'human',
      payload: { outcome: 'happened' },
    });
    const theirTerms = { ...terms(daysAgo(30)), tenantId: 'bbbbbbbb-0000-4000-8000-000000000002' };
    const data = derive([...mine, theirs, theirTerms]);
    assert.equal(data.threads[0].ledger.status, 'needs_owner');
    assert.equal(data.ledger.terms, null);
  });
});

/* ── the writes ─────────────────────────────────────────── */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ENGINE_NOW = new Date('2026-10-14T15:00:00.000Z');

function engine() {
  const store = new MemoryStore();
  seedPublishedConfig(store, { tenantId: TENANT_A, config: leadRecoveryConfig() });
  let n = 0;
  const deps = {
    store,
    liveSender: new RecordingSender(),
    canarySender: new RecordingSender(),
    now: () => ENGINE_NOW,
    classifierFor: () => new FakeClassifier(),
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' },
    uuid: () => `aaaaaaaa-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    worker: 'test',
  };
  return { store, deps };
}

async function bookedLead(deps, appointmentAt = '2026-10-15T14:00:00.000Z') {
  const intake = await intakeLead(deps, {
    tenantId: TENANT_A,
    source: 'missed_call',
    externalRef: 'CA00000000000000000000000000000001',
    phone: '+16145559911',
    intakeRef: '+16145550100',
    consentSms: true,
    consentSource: 'inbound_call',
  });
  const booked = await markBooked(deps, { tenantId: TENANT_A, leadId: intake.lead.id, outcome: 'booked', appointmentAt });
  assert.equal(booked.ok, true);
  return intake.lead;
}

describe('recording a booking', () => {
  test('it carries the visit time, and the same visit twice is one row', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    await markBooked(deps, { tenantId: TENANT_A, leadId: lead.id, outcome: 'booked', appointmentAt: '2026-10-15T14:00:00Z' });
    const rows = store.eventsOfType('lead_booked');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event.payload.appointment_at, '2026-10-15T14:00:00.000Z');
    assert.equal(rows[0].event.actor, 'human');
  });

  test('a rescheduled visit is a second row; nothing is rewritten', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    await markBooked(deps, { tenantId: TENANT_A, leadId: lead.id, outcome: 'booked', appointmentAt: '2026-10-17T14:00:00Z' });
    assert.deepEqual(
      store.eventsOfType('lead_booked').map((row) => row.event.payload.appointment_at),
      ['2026-10-15T14:00:00.000Z', '2026-10-17T14:00:00.000Z'],
    );
  });

  test('a visit time that is not a date is refused, and nothing is written', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    const result = await markBooked(deps, { tenantId: TENANT_A, leadId: lead.id, outcome: 'booked', appointmentAt: 'next tuesday' });
    assert.equal(result.ok, false);
    assert.equal(store.eventsOfType('lead_booked').length, 1);
  });
});

describe('recording an answer', () => {
  test('it is appended as a person’s claim, and a double tap is one row', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    const input = { outcome: 'happened', answered_by: 'owner' };
    const first = await recordOutcome(deps, { tenantId: TENANT_A, leadId: lead.id, input, actorId: 'user-1' });
    const second = await recordOutcome(deps, { tenantId: TENANT_A, leadId: lead.id, input, actorId: 'user-1' });
    assert.deepEqual([first.ok, first.written, second.ok, second.written], [true, true, true, false]);
    const rows = store.eventsOfType('lead_outcome_recorded');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event.actor, 'human');
    assert.equal(rows[0].event.correlation_id, lead.correlationId);
    assert.deepEqual([rows[0].event.payload.outcome, rows[0].event.payload.answered_by], ['happened', 'owner']);
  });

  test('a changed mind names the answer it replaces, and both stay on the record', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    await recordOutcome(deps, { tenantId: TENANT_A, leadId: lead.id, input: { outcome: 'happened' } });
    const replaces = 'cccccccc-0000-4000-8000-000000000001';
    const changed = await recordOutcome(deps, { tenantId: TENANT_A, leadId: lead.id, input: { outcome: 'not_counted', reason: 'did_not_happen', replaces } });
    assert.equal(changed.written, true);
    assert.deepEqual(store.eventsOfType('lead_outcome_recorded').map((row) => row.event.payload.outcome), ['happened', 'not_counted']);
  });

  test('two people answering the same question at once write one row', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    await recordOutcome(deps, { tenantId: TENANT_A, leadId: lead.id, input: { outcome: 'happened' } });
    const other = await recordOutcome(deps, { tenantId: TENANT_A, leadId: lead.id, input: { outcome: 'not_counted', reason: 'spam' } });
    assert.equal(other.written, false, 'the second answer to the same state is not recorded over the first');
    assert.equal(store.eventsOfType('lead_outcome_recorded').length, 1);
  });

  test('there is nothing to answer about until a visit is booked', async () => {
    const { store, deps } = engine();
    const intake = await intakeLead(deps, { tenantId: TENANT_A, source: 'missed_call', externalRef: 'CA2', phone: '+16145559912', consentSms: true });
    const result = await recordOutcome(deps, { tenantId: TENANT_A, leadId: intake.lead.id, input: { outcome: 'happened' } });
    assert.equal(result.ok, false);
    assert.match(result.outcome, /no booked visit/);
    assert.equal(store.eventsOfType('lead_outcome_recorded').length, 0);
  });

  test('another client cannot answer for this lead', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    const result = await recordOutcome(deps, { tenantId: TENANT_B, leadId: lead.id, input: { outcome: 'not_counted', reason: 'spam' } });
    assert.equal(result.ok, false);
    assert.match(result.outcome, /no lead with that id for this client/);
    assert.equal(store.eventsOfType('lead_outcome_recorded').length, 0);
  });

  test('“should not count” needs one of the seven reasons, and “happened” takes none', () => {
    assert.deepEqual(LEDGER_OUTCOMES, ['happened', 'quoted', 'not_counted']);
    assert.equal(parseOutcomeInput({ outcome: 'not_counted' }).ok, false);
    assert.equal(parseOutcomeInput({ outcome: 'not_counted', reason: 'they were rude' }).ok, false);
    assert.equal(parseOutcomeInput({ outcome: 'happened', reason: 'spam' }).ok, false);
    assert.equal(parseOutcomeInput({ outcome: 'sold' }).ok, false);
    assert.equal(parseOutcomeInput({ outcome: 'happened', replaces: 'the last one' }).ok, false);
    for (const reason of DISPUTE_REASON_KEYS) assert.equal(parseOutcomeInput({ outcome: 'not_counted', reason }).ok, true, reason);
  });
});

describe('settling a dispute, and recording terms', () => {
  const disputeId = 'dddddddd-0000-4000-8000-000000000001';

  test('a settlement is of one answer, written once', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps);
    const input = { decision: 'accepted', dispute_id: disputeId };
    await settleDispute(deps, { tenantId: TENANT_A, leadId: lead.id, input, actorId: 'op-1' });
    const again = await settleDispute(deps, { tenantId: TENANT_A, leadId: lead.id, input: { decision: 'rejected', dispute_id: disputeId, note: 'the visit is on the calendar' } });
    assert.equal(again.written, false, 'a settled answer is not settled a second way');
    assert.deepEqual(store.eventsOfType('lead_dispute_settled').map((row) => row.event.payload.decision), ['accepted']);
  });

  test('a rejected dispute never goes unexplained', () => {
    assert.equal(parseSettlementInput({ decision: 'rejected', dispute_id: disputeId }).ok, false);
    assert.equal(parseSettlementInput({ decision: 'rejected', dispute_id: disputeId, note: 'the visit is on the calendar' }).ok, true);
    assert.equal(parseSettlementInput({ decision: 'accepted' }).ok, false);
  });

  test('terms are recorded as evidence, with no lead and no customer on them', async () => {
    const { store, deps } = engine();
    const input = { base_cents: 20000, per_job_cents: 9000, cap_cents: 100000, dispute_window_days: 7 };
    const first = await recordPilotTerms(deps, { tenantId: TENANT_A, input, actorId: 'op-1' });
    const retry = await recordPilotTerms(deps, { tenantId: TENANT_A, input, actorId: 'op-1' });
    assert.deepEqual([first.written, retry.written], [true, false]);
    const [row] = store.eventsOfType('pilot_terms_recorded');
    assert.equal(row.event.correlation_id, null);
    assert.equal(row.event.actor, 'human');
    assert.deepEqual(termsFromEvents([toEvent({ id: 'e1', tenant_id: TENANT_A, ...row.event })]), {
      baseCents: 20000, perJobCents: 9000, capCents: 100000, disputeWindowDays: 7, id: 'e1', recordedAt: ENGINE_NOW.toISOString(),
    });
  });

  test('terms that are not whole are refused', () => {
    for (const bad of [
      { base_cents: 200.5, per_job_cents: 9000, dispute_window_days: 7 },
      { base_cents: 20000, per_job_cents: -1, dispute_window_days: 7 },
      { base_cents: 20000, per_job_cents: 9000, cap_cents: 100, dispute_window_days: 7 },
      { base_cents: 20000, per_job_cents: 9000, dispute_window_days: 0 },
      { base_cents: 20000, per_job_cents: 9000, dispute_window_days: 90 },
      { base_cents: 20000, per_job_cents: 9000 },
    ]) {
      assert.equal(parseTermsInput(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(parseTermsInput({ base_cents: 0, per_job_cents: 9000, dispute_window_days: 7 }).ok, true, 'no cap is allowed');
  });
});

describe('an answered call', () => {
  test('is a count and nothing else: no lead, no number, and a redelivery is one call', async () => {
    const { store, deps } = engine();
    await recordAnsweredCall(deps, { tenantId: TENANT_A, callSid: 'CA9' });
    await recordAnsweredCall(deps, { tenantId: TENANT_A, callSid: 'CA9' });
    const rows = store.eventsOfType('call_answered');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].event.payload, {});
    assert.equal(store.leads.length, 0);
  });

  test('the phone webhook records one only for a call a person picked up', () => {
    const door = read('supabase/functions/twilio/handler.ts');
    assert.match(door, /dialStatus\.toLowerCase\(\) === 'completed'/);
    assert.match(door, /recordAnsweredCall\(deps, \{ tenantId: tenantConfig\.tenantId, callSid \}\)/);
  });
});

describe('the engine’s evidence, read back by the ledger', () => {
  test('nothing it writes is refused at the door, and the job counts end to end', async () => {
    const { store, deps } = engine();
    const lead = await bookedLead(deps, '2026-10-14T13:00:00.000Z');
    await recordOutcome(deps, { tenantId: TENANT_A, leadId: lead.id, input: { outcome: 'happened', answered_by: 'owner' } });
    await recordPilotTerms(deps, { tenantId: TENANT_A, input: { base_cents: 20000, per_job_cents: 9000, cap_cents: null, dispute_window_days: 7 } });
    assert.deepEqual(store.invalidEvents, []);

    const rows = store.events.map((row, index) => toEvent({ id: `e-${index}`, tenant_id: row.tenantId, ...row.event }));
    /* the text and the reply, as the worker and the phone line would have written them. */
    const on = (eventType, seconds, overrides) =>
      event(eventType, new Date(ENGINE_NOW.getTime() - 3600_000 + seconds * 1000).toISOString(), { tenantId: TENANT_A, correlationId: lead.correlationId, ...overrides });
    const tenant = { ...TENANT, id: TENANT_A };
    const withoutText = buildDashboardData(tenant, rows, NOW);
    assert.equal(withoutText.threads[0].ledger.status, 'unverified', 'booked and confirmed, but no text on record');

    const backdated = rows.map((row) => (row.eventType === 'call_missed' || row.eventType === 'lead_received' ? { ...row, occurredAt: on('x', -60).occurredAt } : row));
    const data = buildDashboardData(tenant, [...backdated, on('sms_sent', 5, { latencyMs: 4000 }), on('reply_received', 90)], NOW);
    assert.equal(data.threads[0].ledger.status, 'confirmed');
    assert.equal(data.ledger.month.feeCents, 29000);
  });

  test('the operator’s door offers the three writes, and none of them touches a lead’s state', () => {
    const door = read('supabase/functions/ops/lead-recovery.ts');
    for (const action of ['lead-recovery-record-outcome', 'lead-recovery-settle-dispute', 'lead-recovery-record-terms']) {
      assert.ok(door.includes(`'${action}',`), `${action} is listed`);
      assert.ok(door.includes(`case '${action}':`), `${action} is handled`);
    }
    const runtime = read('supabase/functions/_shared/engine/runtime.ts');
    const writes = runtime.slice(runtime.indexOf('export async function recordOutcome'), runtime.indexOf('export async function suppressContact'));
    assert.doesNotMatch(writes, /store\.(updateLead|updateRun|cancelPendingActions|createLead)\(/);
  });

  test('the ledger reads no table but the log', () => {
    const source = read('src/portal/lib/ledger.js').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(source, /createClient|\.from\(|\.rpc\(|fetch\(/);
    assert.deepEqual(source.match(/from '([^']+)'/g), ["from 'luxon'", "from '../../../supabase/functions/_shared/ledger/model.ts'"]);
  });
});
