/* ARC-MK-220 — the owner answers one question per booked visit, in one place.
 *
 * The promises, each tested by name:
 *   - the six answers are the ledger's three outcomes and seven reasons, and nothing else;
 *   - the write takes who is answering from the sign-in: a body cannot claim a tenant, a
 *     role or `answered_by`, and another client's lead is not found;
 *   - a repeat answer is one row, a changed mind is a second row naming the first, and an
 *     answer over somebody else's is refused rather than written;
 *   - asking opens the dispute window once, and only where there is a real question under
 *     terms on record;
 *   - the owner sees their dispute and its reason, and an operator sees what counts, what is
 *     disputed and what is waiting, per client, with the pattern of disputes on good leads.
 *
 * The screens are rendered to static markup, so a word hardcoded in a component is read too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISPUTE_PATTERN_MIN, disputePattern } from '../src/portal/lib/ledger.js';
import { CHANGE_WINDOW_HOURS, ownerNeeds } from '../src/portal/lib/owner.js';
import { buildDashboardData } from '../src/portal/lib/dashboard-data.js';
import { buildProofLedger } from '../src/portal/demo/proof-ledger.js';
import { ownerCopyProblem } from '../src/lib/owner-copy.js';
import {
  DISPUTE_REASON_KEYS,
  OWNER_ANSWERS,
  askedEventKey,
  ownerAnswerFor,
  parseOwnerAnswer,
} from '../supabase/functions/_shared/ledger/model.ts';
import { MAX_ASKED_PER_CALL, answerOutcome, markAsked, standing } from '../supabase/functions/_shared/ledger/service.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { intakeLead, markBooked, recordPilotTerms, settleDispute } from '../supabase/functions/_shared/engine/runtime.ts';
import { FakeClassifier } from '../supabase/functions/_shared/classifier.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { leadRecoveryConfig, seedPublishedConfig } from './config-fixtures.js';
import { LEDGER_NOW, LEDGER_TENANT, chain, daysAgo, daysAhead, terms } from './ledger-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-14T15:00:00.000Z');
const PASSED = '2026-10-13T14:00:00.000Z';
const AHEAD = '2026-10-15T14:00:00.000Z';

const owner = (tenantId = TENANT_A, userId = 'user-owner') => ({ kind: 'client_user', userId, tenantId, role: 'owner' });
const TERMS = { base_cents: 20000, per_job_cents: 9000, cap_cents: null, dispute_window_days: 7 };

/* the engine on its in-memory store, with the ledger's two reads answered from the same
   rows — each given the uuid the database would have given it. */
function setup() {
  const store = new MemoryStore();
  seedPublishedConfig(store, { tenantId: TENANT_A, config: leadRecoveryConfig() });
  seedPublishedConfig(store, { tenantId: TENANT_B, config: leadRecoveryConfig() });
  let n = 0;
  const engine = {
    store,
    liveSender: new RecordingSender(),
    canarySender: new RecordingSender(),
    now: () => NOW,
    classifierFor: () => new FakeClassifier(),
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' },
    uuid: () => `aaaaaaaa-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    worker: 'test',
  };
  const ids = new Map();
  const idOf = (row) => {
    if (!ids.has(row)) ids.set(row, `eeeeeeee-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`);
    return ids.get(row);
  };
  const deps = {
    engine,
    evidence: async (tenantId, correlationId) =>
      store.events
        .filter((row) => row.tenantId === tenantId && row.event.correlation_id === correlationId && !row.event.is_canary)
        .map((row) => ({ id: idOf(row), eventType: row.event.event_type, occurredAt: row.event.occurred_at, payload: row.event.payload ?? null })),
    hasTerms: async (tenantId) => store.events.some((row) => row.tenantId === tenantId && row.event.event_type === 'pilot_terms_recorded'),
  };
  const answers = () => store.eventsOfType('lead_outcome_recorded');
  const answerId = () => idOf(answers().at(-1));
  return { store, engine, deps, answers, answerId, idOf };
}

let calls = 0;
async function bookedLead(engine, { tenantId = TENANT_A, appointmentAt = PASSED, book = true } = {}) {
  calls += 1;
  const intake = await intakeLead(engine, {
    tenantId,
    source: 'missed_call',
    externalRef: `CA${String(calls).padStart(32, '0')}`,
    phone: `+1614555${String(1000 + calls)}`,
    intakeRef: '+16145550100',
    consentSms: true,
    consentSource: 'inbound_call',
  });
  if (book) assert.equal((await markBooked(engine, { tenantId, leadId: intake.lead.id, outcome: 'booked', appointmentAt })).ok, true);
  return intake.lead;
}

const answer = (deps, lead, input, actor = owner()) =>
  answerOutcome(deps, actor, { tenantId: actor?.tenantId ?? TENANT_A, lead: lead.correlationId, input });

/* ── the six answers ────────────────────────────────────── */

describe('the six answers', () => {
  test('are the roadmap’s six, in an owner’s words', () => {
    assert.deepEqual(
      OWNER_ANSWERS.map((choice) => choice.label),
      ['sold, or the job happened', 'quoted, not sold yet', 'did not happen', 'not a real job', 'customer cancelled', 'duplicate, or already handled'],
    );
    for (const choice of OWNER_ANSWERS) assert.equal(ownerCopyProblem(choice.label), null, choice.label);
  });

  test('cover the three outcomes and each of the seven reasons exactly once', () => {
    assert.deepEqual([...new Set(OWNER_ANSWERS.map((choice) => choice.outcome))], ['happened', 'quoted', 'not_counted']);
    assert.deepEqual(OWNER_ANSWERS.flatMap((choice) => choice.reasons).sort(), [...DISPUTE_REASON_KEYS].sort());
    for (const choice of OWNER_ANSWERS) assert.equal(choice.counts, choice.outcome !== 'not_counted', choice.key);
  });

  test('one reason is implied, several must be picked, and nothing else is accepted', () => {
    assert.deepEqual(parseOwnerAnswer({ answer: 'customer_cancelled' }).value, {
      outcome: 'not_counted',
      reason: 'customer_cancelled',
      answeredBy: 'owner',
      replaces: 'first',
    });
    assert.equal(parseOwnerAnswer({ answer: 'not_real' }).ok, false, 'which kind of not real?');
    assert.equal(parseOwnerAnswer({ answer: 'not_real', reason: 'duplicate' }).ok, false, 'a reason from another answer');
    assert.equal(parseOwnerAnswer({ answer: 'not_real', reason: 'spam' }).value.reason, 'spam');
    assert.equal(parseOwnerAnswer({ answer: 'happened', reason: 'spam' }).ok, false);
    assert.equal(parseOwnerAnswer({ answer: 'sold' }).ok, false);
    assert.equal(parseOwnerAnswer({ outcome: 'happened' }).ok, false, 'an outcome is not one of the six taps');
  });

  test('a body cannot say who answered', () => {
    const parsed = parseOwnerAnswer({ answer: 'happened', answered_by: 'operator', answeredBy: 'operator' });
    assert.equal(parsed.value.answeredBy, 'owner');
  });

  test('an answer on record reads back as the tap it came from', () => {
    assert.equal(ownerAnswerFor('not_counted', 'owner_first').key, 'already_handled');
    assert.equal(ownerAnswerFor('quoted', null).key, 'quoted');
    assert.equal(ownerAnswerFor('refunded', null), null);
  });
});

/* ── the write ──────────────────────────────────────────── */

describe('an owner’s answer', () => {
  test('is appended as the signed-in person’s own claim, and touches nothing else', async () => {
    const { store, engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    const before = JSON.stringify([store.leads, store.runs, store.actions]);
    const result = await answer(deps, lead, { answer: 'happened', answered_by: 'operator', recorded_by: 'someone-else' });
    assert.deepEqual(result, { ok: true, result: { outcome: 'happened', reason: null, written: true } });
    assert.equal(answers().length, 1);
    const row = answers()[0].event;
    assert.deepEqual(
      [row.actor, row.correlation_id, row.payload.answered_by, row.payload.recorded_by, row.payload.replaces],
      ['human', lead.correlationId, 'owner', 'user-owner', 'first'],
    );
    assert.equal(JSON.stringify([store.leads, store.runs, store.actions]), before, 'no lead, run or queued action changed');
    assert.deepEqual(store.invalidEvents, []);
  });

  test('a double tap is one row', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    const first = await answer(deps, lead, { answer: 'quoted' });
    const second = await answer(deps, lead, { answer: 'quoted' });
    assert.deepEqual([first.result.written, second.ok, second.result.written], [true, true, false]);
    assert.equal(answers().length, 1);
  });

  test('a changed mind names the answer it replaces, and both stay on the record', async () => {
    const { engine, deps, answers, answerId } = setup();
    const lead = await bookedLead(engine);
    await answer(deps, lead, { answer: 'happened' });
    const changed = await answer(deps, lead, { answer: 'did_not_happen', replaces: answerId() });
    assert.equal(changed.result.written, true);
    assert.deepEqual(answers().map((row) => row.event.payload.outcome), ['happened', 'not_counted']);
    assert.equal(answers()[1].event.payload.reason, 'did_not_happen');
  });

  test('a different answer over somebody else’s is refused, not written', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    await answer(deps, lead, { answer: 'happened' }, owner(TENANT_A, 'user-office'));
    const late = await answer(deps, lead, { answer: 'not_real', reason: 'spam' });
    assert.deepEqual([late.ok, late.code], [false, 'conflict']);
    assert.equal(answers().length, 1);
    assert.equal(answers()[0].event.payload.recorded_by, 'user-office');
  });

  test('a made-up “replaces” is refused', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    const result = await answer(deps, lead, { answer: 'happened', replaces: 'cccccccc-0000-4000-8000-000000000001' });
    assert.equal(result.code, 'conflict');
    assert.equal(answers().length, 0);
  });

  test('“it happened” waits for the visit time; a cancellation does not', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine, { appointmentAt: AHEAD });
    for (const key of ['happened', 'quoted']) assert.equal((await answer(deps, lead, { answer: key })).code, 'too_early', key);
    assert.equal(answers().length, 0);
    assert.equal((await answer(deps, lead, { answer: 'customer_cancelled' })).ok, true);
  });

  test('there is nothing to answer until a visit is booked', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine, { book: false });
    const result = await answer(deps, lead, { answer: 'happened' });
    assert.deepEqual([result.ok, result.code], [false, 'invalid']);
    assert.equal(answers().length, 0);
  });

  test('an answer an operator settled is closed to the owner', async () => {
    const { engine, deps, answers, answerId } = setup();
    const lead = await bookedLead(engine);
    await answer(deps, lead, { answer: 'did_not_happen' });
    const disputeId = answerId();
    await settleDispute(engine, { tenantId: TENANT_A, leadId: lead.id, input: { decision: 'rejected', dispute_id: disputeId, note: 'the visit is on the calendar' } });
    const again = await answer(deps, lead, { answer: 'not_real', reason: 'spam', replaces: disputeId });
    assert.deepEqual([again.ok, again.code], [false, 'settled']);
    assert.equal(answers().length, 1);
  });
});

describe('who may answer', () => {
  test('nobody signed in, and nobody without a client', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    assert.equal((await answerOutcome(deps, null, { tenantId: TENANT_A, lead: lead.correlationId, input: { answer: 'happened' } })).code, 'unauthorized');
    assert.equal((await answer(deps, lead, { answer: 'happened' }, { kind: 'client_user', userId: 'u', tenantId: TENANT_A, role: 'owner' })).ok, true);
    assert.equal(answers().length, 1);
  });

  test('a member of another client cannot name this client', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    const result = await answerOutcome(deps, owner(TENANT_B), { tenantId: TENANT_A, lead: lead.correlationId, input: { answer: 'not_real', reason: 'spam' } });
    assert.deepEqual([result.ok, result.code], [false, 'forbidden']);
    assert.equal(answers().length, 0);
  });

  test('another client’s lead is not found — the same answer as one that does not exist', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    const theirs = await answerOutcome(deps, owner(TENANT_B), { tenantId: TENANT_B, lead: lead.correlationId, input: { answer: 'not_real', reason: 'spam' } });
    const nobody = await answerOutcome(deps, owner(TENANT_B), { tenantId: TENANT_B, lead: 'no-such-lead', input: { answer: 'not_real', reason: 'spam' } });
    assert.deepEqual([theirs.code, theirs.message], [nobody.code, nobody.message]);
    assert.equal(theirs.code, 'not_found');
    assert.equal(answers().length, 0);
  });

  test('an operator does not answer through the owner’s door', async () => {
    const { engine, deps, answers } = setup();
    const lead = await bookedLead(engine);
    const result = await answerOutcome(deps, { kind: 'operator', userId: 'op-1' }, { tenantId: TENANT_A, lead: lead.correlationId, input: { answer: 'happened' } });
    assert.equal(result.code, 'forbidden');
    assert.equal(answers().length, 0);
  });

  test('a canary is not a job anyone can answer for', async () => {
    const { engine, deps } = setup();
    const lead = await bookedLead(engine);
    lead.isCanary = true;
    assert.equal((await answer(deps, lead, { answer: 'happened' })).code, 'not_found');
  });

  test('the door reads the member from the sign-in, never from the body', () => {
    const door = read('supabase/functions/ledger/index.ts');
    assert.match(door, /caller\.auth\.getUser\(\)/);
    assert.match(door, /\.from\('tenant_members'\)[\s\S]*?\.eq\('tenant_id', body\.tenant_id\)[\s\S]*?\.eq\('user_id', userId\)/);
    assert.match(door, /clientActor\(userId, body\.tenant_id, membership\)/);
    assert.doesNotMatch(door, /body\.(user_id|role|answered_by|actor)/);
    assert.doesNotMatch(door, /TwilioRestSender|classifierFor\(config/, 'nothing at this door can reach a customer');
  });

  test('the service writes through the engine’s own writers and nothing else', () => {
    const service = read('supabase/functions/_shared/ledger/service.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(service, /\.(insert|update|upsert|delete|rpc)\(/);
    assert.doesNotMatch(service, /store\.(updateLead|updateRun|cancelPendingActions|createLead|emit)\(/);
  });
});

/* ── asking ─────────────────────────────────────────────── */

describe('asking the owner', () => {
  const ask = (deps, leads, actor = owner()) => markAsked(deps, actor, { tenantId: actor.tenantId, leads: leads.map((lead) => lead.correlationId) });

  test('is recorded once per lead, however often the question is shown', async () => {
    const { store, engine, deps } = setup();
    const lead = await bookedLead(engine);
    await recordPilotTerms(engine, { tenantId: TENANT_A, input: TERMS });
    assert.deepEqual((await ask(deps, [lead, lead])).result, { asked: 1 });
    assert.deepEqual((await ask(deps, [lead])).result, { asked: 0 });
    const rows = store.eventsOfType('lead_outcome_requested');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event.event_key, askedEventKey(lead.correlationId));
    assert.deepEqual(rows[0].event.payload, { asked_via: 'portal', shown_to: 'user-owner' });
    assert.deepEqual(store.invalidEvents, []);
  });

  test('opens no window before there are terms to open it under', async () => {
    const { store, engine, deps } = setup();
    const lead = await bookedLead(engine);
    assert.deepEqual((await ask(deps, [lead])).result, { asked: 0 });
    assert.equal(store.eventsOfType('lead_outcome_requested').length, 0);
  });

  test('skips a visit still ahead, a job already answered, and a lead with no visit', async () => {
    const { store, engine, deps } = setup();
    await recordPilotTerms(engine, { tenantId: TENANT_A, input: TERMS });
    const ahead = await bookedLead(engine, { appointmentAt: AHEAD });
    const answered = await bookedLead(engine);
    const unbooked = await bookedLead(engine, { book: false });
    await answer(deps, answered, { answer: 'happened' });
    assert.deepEqual((await ask(deps, [ahead, answered, unbooked])).result, { asked: 0 });
    assert.equal(store.eventsOfType('lead_outcome_requested').length, 0);
  });

  test('cannot be said for another client’s lead, or in bulk', async () => {
    const { store, engine, deps } = setup();
    const lead = await bookedLead(engine);
    await recordPilotTerms(engine, { tenantId: TENANT_A, input: TERMS });
    await recordPilotTerms(engine, { tenantId: TENANT_B, input: TERMS });
    assert.deepEqual((await ask(deps, [lead], owner(TENANT_B))).result, { asked: 0 });
    assert.equal((await markAsked(deps, owner(TENANT_B), { tenantId: TENANT_A, leads: [lead.correlationId] })).code, 'forbidden');
    const many = Array.from({ length: MAX_ASKED_PER_CALL + 1 }, (_, index) => `lead-${index}`);
    assert.equal((await markAsked(deps, owner(), { tenantId: TENANT_A, leads: many })).code, 'invalid');
    assert.equal(store.eventsOfType('lead_outcome_requested').length, 0);
  });

  test('`standing` reads the visit that stands, the asking, the answer and its settlement', () => {
    const row = (eventType, occurredAt, payload = {}, id = null) => ({ id, eventType, occurredAt, payload });
    const state = standing(
      [
        row('lead_booked', '2026-10-10T10:00:00.000Z', { appointment_at: '2026-10-12T14:00:00.000Z' }),
        row('lead_booked', '2026-10-11T10:00:00.000Z', { appointment_at: AHEAD }),
        row('lead_outcome_requested', '2026-10-13T10:00:00.000Z'),
        row('lead_outcome_recorded', '2026-10-13T11:00:00.000Z', { outcome: 'not_counted', reason: 'spam', replaces: 'first' }, 'ans-1'),
        row('lead_dispute_settled', '2026-10-13T12:00:00.000Z', { decision: 'accepted', dispute_id: 'ans-0' }),
      ],
      NOW,
    );
    assert.deepEqual([state.appointmentAt, state.visitPassed, state.asked, state.answer.id, state.settled], [AHEAD, false, true, 'ans-1', false]);
  });
});

/* ── what each side then sees ───────────────────────────── */

const data = (events, now = LEDGER_NOW) => buildDashboardData(LEDGER_TENANT, events, now);
const lead = (events, id = 'lead-1') => data(events).threads.find((thread) => thread.id === id);

describe('what the owner sees', () => {
  test('a question carries what the buttons send, and when silence would count', () => {
    const plainQuestion = ownerNeeds(data(chain('lead-1', { visitAt: daysAgo(2) }))).groups[0].items[0];
    assert.deepEqual([plainQuestion.lead, plainQuestion.replaces, plainQuestion.asked, plainQuestion.countsAt], ['lead-1', null, false, null]);

    const asked = ownerNeeds(data([...chain('lead-1', { visitAt: daysAgo(2), askedAt: daysAgo(1) }), terms(daysAgo(30))])).groups[0].items[0];
    assert.equal(asked.asked, true);
    assert.match(asked.countsAt, /^Oct 26/, 'seven days from the asking');
  });

  test('a dispute is theirs to see, with the reason they gave', () => {
    const disputed = lead(chain('lead-1', { visitAt: daysAgo(4), answers: [{ id: 'ans-1', at: daysAgo(3), outcome: 'not_counted', reason: 'did_not_happen' }] }));
    assert.equal(disputed.ledger.status, 'disputed');
    assert.match(disputed.ledger.reason, /you said this one should not count: job did not happen\. it is not billed while we look at it\./);
    assert.deepEqual([disputed.ledger.answer.by, disputed.ledger.settlement], ['owner', null]);
  });

  test('an answer from the last day can be changed, and one from before cannot', () => {
    const recent = chain('lead-1', { visitAt: daysAgo(4), answers: [{ id: 'ans-1', at: daysAgo(0, 3), outcome: 'happened' }] });
    const old = chain('lead-2', { phone: '+16145550102', visitAt: daysAgo(4), answers: [{ id: 'ans-2', at: daysAgo(0, CHANGE_WINDOW_HOURS + 1), outcome: 'happened' }] });
    const needs = ownerNeeds(data([...recent, ...old]));
    assert.deepEqual(needs.answered.map((item) => [item.lead, item.replaces, item.said]), [['lead-1', 'ans-1', 'the job happened']]);
    assert.equal(needs.total, 0, 'an answered job is not waiting on anyone');
  });

  test('an operator’s entry and a settled dispute are not offered for changing', () => {
    const byOperator = chain('lead-1', { visitAt: daysAgo(4), answers: [{ id: 'ans-1', at: daysAgo(0, 2), outcome: 'happened', by: 'operator' }] });
    const settled = chain('lead-2', {
      phone: '+16145550102',
      visitAt: daysAgo(4),
      answers: [{ id: 'ans-2', at: daysAgo(0, 2), outcome: 'not_counted', reason: 'spam' }],
      settlements: [{ at: daysAgo(0, 1), decision: 'accepted', disputeId: 'ans-2' }],
    });
    assert.deepEqual(ownerNeeds(data([...byOperator, ...settled])).answered, []);
  });

  test('the demo offers no change list: its examples were never answered by anyone', () => {
    assert.deepEqual(ownerNeeds({ proofLedger: buildProofLedger(), threads: [] }).answered, []);
  });
});

describe('what an operator sees', () => {
  const dispute = (id, phone, extra = {}) =>
    chain(id, { phone, visitAt: daysAgo(6), answers: [{ id: `ans-${id}`, at: daysAgo(5), outcome: 'not_counted', reason: 'did_not_happen' }], ...extra });
  const yes = (id, phone) => chain(id, { phone, visitAt: daysAgo(6), answers: [{ id: `ans-${id}`, at: daysAgo(5), outcome: 'happened' }] });

  test('counts, disputed and waiting on the owner, for one client', () => {
    const { ledger } = data([
      ...yes('lead-1', '+16145550101'),
      ...dispute('lead-2', '+16145550102'),
      ...chain('lead-3', { phone: '+16145550103', visitAt: daysAgo(2) }),
    ]);
    assert.deepEqual([ledger.totals.billed, ledger.totals.disputed, ledger.totals.needs_owner], [1, 1, 1]);
  });

  test('the disputes on good leads are counted by how each ended', () => {
    const { ledger } = data([
      ...yes('lead-1', '+16145550101'),
      ...dispute('lead-2', '+16145550102'),
      ...dispute('lead-3', '+16145550103', { settlements: [{ at: daysAgo(4), decision: 'accepted', disputeId: 'ans-lead-3' }] }),
      ...dispute('lead-4', '+16145550104', { settlements: [{ at: daysAgo(4), decision: 'rejected', disputeId: 'ans-lead-4' }] }),
      /* ruled out before the visit: nothing to dispute, so not a dispute of a good lead. */
      ...chain('lead-5', { phone: '+16145550105', visitAt: daysAhead(2), answers: [{ id: 'ans-5', at: daysAgo(1), outcome: 'not_counted', reason: 'customer_cancelled' }] }),
      /* never texted: the answer is about a lead that never counted anyway. */
      ...chain('lead-6', { phone: '+16145550106', text: false, visitAt: daysAgo(6), answers: [{ id: 'ans-6', at: daysAgo(5), outcome: 'not_counted', reason: 'spam' }] }),
    ]);
    assert.deepEqual(ledger.disputes, { answered: 4, open: 1, accepted: 1, rejected: 1, late: 0, saidNo: 3 });
  });

  test('a pattern is flagged only when most of several good leads were disputed, and decides nothing', () => {
    assert.equal(disputePattern({ answered: 0, saidNo: 0 }).flagged, false);
    assert.equal(disputePattern({ answered: 10, saidNo: DISPUTE_PATTERN_MIN - 1 }).flagged, false, 'too few to call a pattern');
    assert.equal(disputePattern({ answered: 10, saidNo: 4 }).flagged, false, 'fewer than half');
    const flagged = disputePattern({ answered: 4, saidNo: 3 });
    assert.equal(flagged.flagged, true);
    assert.match(flagged.reason, /3 of the 4 good leads this owner answered about were disputed/);

    const source = read('src/portal/lib/ledger.js');
    const rule = source.slice(source.indexOf('export function ledgerStatus'), source.indexOf('/* ── from the event log'));
    assert.doesNotMatch(rule, /disputePattern|disputes\./, 'the pattern is not an input to whether a job counts');
  });

  test('the console can settle and record by the reference the event log knows a lead by', () => {
    const door = read('supabase/functions/ops/lead-recovery.ts');
    assert.match(door, /getLeadByCorrelation\(tenantId, body\.correlation_id\)/);
    assert.equal([...door.matchAll(/await ledgerLeadId\(db, tenantId, body\)/g)].length, 2);
  });
});

/* ── from the tap to the status ─────────────────────────── */

describe('from the tap to the ledger', () => {
  test('asked, then silence past the window, then a late dispute an operator concedes', async () => {
    const { store, engine, deps, answerId, idOf } = setup();
    const booked = await bookedLead(engine);
    await recordPilotTerms(engine, { tenantId: TENANT_A, input: TERMS });
    await markAsked(deps, owner(), { tenantId: TENANT_A, leads: [booked.correlationId] });

    const tenant = { ...LEDGER_TENANT, id: TENANT_A };
    const { toEvent } = await import('../src/portal/lib/event-row.js');
    const at = (minutes) => new Date(Date.parse('2026-10-13T10:00:00.000Z') + minutes * 60_000).toISOString();
    const row = (eventType, occurredAt, over = {}) =>
      toEvent({ id: `x-${eventType}`, tenant_id: TENANT_A, event_type: eventType, occurred_at: occurredAt, correlation_id: booked.correlationId, status: 'success', payload: {}, is_canary: false, ...over });
    const log = () => [
      ...store.events
        .filter((entry) => entry.tenantId === TENANT_A)
        .map((entry) => toEvent({ id: idOf(entry), tenant_id: TENANT_A, ...entry.event }))
        .map((event) => (event.eventType === 'call_missed' || event.eventType === 'lead_received' ? { ...event, occurredAt: at(0) } : event))
        .map((event) => (event.eventType === 'lead_booked' ? { ...event, occurredAt: at(30) } : event)),
      row('sms_sent', at(1), { latency_ms: 4000 }),
      row('reply_received', at(5)),
    ];
    const status = (now) => buildDashboardData(tenant, log(), now).threads[0].ledger;

    const soon = LEDGER_NOW.set({ year: 2026, month: 10, day: 15 });
    assert.equal(status(soon).status, 'needs_owner');
    assert.equal(status(soon).asked, true);

    const later = soon.plus({ days: 10 });
    assert.equal(status(later).status, 'billable', 'asked, unanswered and past the window');

    /* the owner's answer after the window is recorded and flagged, and unbills nothing. */
    engine.now = () => later.toJSDate();
    assert.equal((await answer(deps, booked, { answer: 'did_not_happen' })).ok, true);
    const flagged = status(later.plus({ hours: 1 }));
    assert.deepEqual([flagged.status, flagged.lateDispute], ['billable', true]);

    await settleDispute(engine, { tenantId: TENANT_A, leadId: booked.id, input: { decision: 'accepted', dispute_id: answerId() } });
    assert.equal(status(later.plus({ hours: 2 })).status, 'not_billable');
    assert.deepEqual(store.invalidEvents, []);
  });
});

/* ── the rendered screens ───────────────────────────────── */

async function loadPages() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { MemoryRouter } from 'react-router-dom';",
        "import NeedsYou from './src/portal/pages/dash/NeedsYou.jsx';",
        "import LedgerPanel from './src/portal/components/LedgerPanel.jsx';",
        'const PAGES = { NeedsYou, LedgerPanel };',
        'export const render = (name, props) => renderToStaticMarkup(createElement(MemoryRouter, null,',
        '  createElement(PAGES[name], props)));',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx', '.woff2': 'empty' },
    define: { 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'owner-answers-'));
  const file = path.join(dir, 'pages.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render } = await loadPages();
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

describe('the answer screen, rendered', () => {
  const waiting = [
    ...chain('lead-1', { visitAt: daysAgo(2), askedAt: daysAgo(1) }),
    ...chain('lead-2', { phone: '+16145550102', visitAt: daysAgo(4), answers: [{ id: 'ans-2', at: daysAgo(0, 2), outcome: 'not_counted', reason: 'spam' }] }),
    terms(daysAgo(30)),
  ];
  const live = { data: data(waiting), base: '/portal/dashboard', live: true };
  const demo = { data: { tenant: LEDGER_TENANT, proofLedger: buildProofLedger(), threads: [] }, base: '/demo', live: false };

  test('each question has the six answers as thumb-sized buttons, signed in and in the demo', () => {
    for (const props of [live, demo]) {
      const html = render('NeedsYou', props);
      for (const choice of OWNER_ANSWERS) assert.ok(html.includes(`>${choice.label.replace(/'/g, '&#x27;')}</button>`), `${props.base}: ${choice.label}`);
      for (const [tag] of html.matchAll(/<button[^>]*>/g)) assert.match(tag, /class="ws-btn ow-tap/, tag);
    }
  });

  test('it says what each kind of answer does, and when silence counts', () => {
    const text = plain(render('NeedsYou', live));
    assert.match(text, /the first two count\. any other answer means the job is not billed while we look at it\./);
    assert.match(text, /if nobody answers, it counts by itself after Oct 26/);
  });

  test('an answer from the last day is shown with what was said, and can be changed', () => {
    const text = plain(render('NeedsYou', live));
    assert.match(text, /you said it should not count — spam\. it reads “disputed”\./);
    assert.match(text, /change my answer/);
  });

  test('the mailbox is offered only where an answer cannot be recorded', () => {
    assert.doesNotMatch(render('NeedsYou', live), /mailto:/);
    assert.doesNotMatch(render('NeedsYou', demo), /mailto:/);
    assert.match(render('NeedsYou', { ...live, live: false }), /mailto:/, 'a preview cannot write');
  });

  test('the screen is written in an owner’s words', () => {
    for (const props of [live, demo]) assert.equal(ownerCopyProblem(plain(render('NeedsYou', props))), null, props.base);
  });

  test('the screen decides nothing: it sends a tap and reloads', () => {
    const page = read('src/portal/pages/dash/NeedsYou.jsx').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(page, /ledgerStatus|buildLedger|getSupabase|\.from\(/);
    assert.match(page, /ledgerApi\(tenantId\)\.answer\(item\.lead, \{ answer: answer\.key, reason, replaces: item\.replaces \}\)/);
    assert.match(page, /await onChanged\?\.\(\);/);
  });
});

describe('the console’s ledger panel, rendered', () => {
  const tenant = LEDGER_TENANT;
  const events = [
    ...chain('lead-1', { name: 'Pat Example', visitAt: daysAgo(6), answers: [{ id: 'ans-1', at: daysAgo(5), outcome: 'happened' }] }),
    ...chain('lead-2', { name: 'Sam Example', phone: '+16145550102', visitAt: daysAgo(6), answers: [{ id: 'ans-2', at: daysAgo(5), outcome: 'not_counted', reason: 'owner_first' }] }),
    ...chain('lead-3', { name: 'Lee Example', phone: '+16145550103', visitAt: daysAgo(2) }),
  ];
  const props = (extra = []) => ({ data: data([...events, ...extra]), tenant, reload() {} });

  test('shows what counts, what is disputed and what is waiting, with the owner’s reason', () => {
    const text = plain(render('LedgerPanel', props()));
    assert.match(text, /counts 1 /);
    assert.match(text, /disputed 1 /);
    assert.match(text, /waiting on the owner 1 /);
    assert.match(text, /Sam Example .* the owner said: you got there first/);
    assert.match(text, /Lee Example .* not asked yet/);
  });

  test('the fee is a dash and the reason until terms are on record', () => {
    assert.match(render('LedgerPanel', props()), /<span class="ws-sr">not available\. <\/span> <span class="ops-muted">no pilot terms on record<\/span>/);
    assert.match(plain(render('LedgerPanel', props([terms(daysAgo(30))]))), /fee owed this month \$290/);
  });

  test('settling says what it will do before it is pressed, and a past client’s panel has no controls', () => {
    const html = render('LedgerPanel', props());
    assert.match(html, />the job stops counting and is not billed\.</);
    assert.match(html, />the job counts and is billed in the month you settle it\.</);
    assert.doesNotMatch(render('LedgerPanel', { ...props(), readOnly: true }), /<button|<input|<select/);
  });

  test('a pattern of disputes on good leads is called out', () => {
    const many = ['a', 'b', 'c'].flatMap((id, index) =>
      chain(`more-${id}`, { phone: `+1614555020${index}`, visitAt: daysAgo(6), answers: [{ id: `ans-${id}`, at: daysAgo(5), outcome: 'not_counted', reason: 'did_not_happen' }] }),
    );
    assert.match(plain(render('LedgerPanel', props(many))), /this owner disputes most of the good leads they answer about/);
    assert.doesNotMatch(render('LedgerPanel', props()), /disputes most of the good leads/);
  });

  test('the client page draws it from the dashboard object the client sees', () => {
    assert.match(read('src/portal/pages/ops/ClientDetail.jsx'), /<LedgerPanel data=\{data\} tenant=\{tenant\} reload=\{reload\} readOnly=\{archived\} \/>/);
  });
});
