/* ARC-MK-230 — the offer's three lines, shown in the portal.
 *
 * The promises, each tested by name:
 *   - a lead's five handling lines say only what the record holds, and a line that does not
 *     apply says so rather than reading as a gap;
 *   - the time to the text is the one the text's own record carries — an example shows none;
 *   - whether a customer is in the area is read, never typed;
 *   - the three cards are the homepage's three lines, and a figure that cannot be shown is
 *     null with its reason, never a zero.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HANDLING_LABELS,
  HANDLING_SOURCES,
  URGENCY_WORDS,
  handlingLines,
  leadHandlingFacts,
  learnedSummary,
  ownerHandling,
  spokenDuration,
  summariseFacts,
  summariseHandling,
  urgencyWords,
} from '../src/portal/lib/handling.js';
import { buildDashboardData } from '../src/portal/lib/dashboard-data.js';
import { ownerJobs, ownerNeeds } from '../src/portal/lib/owner.js';
import { PROOF_LEDGER_LEADS, PROOF_LEDGER_ZIPS, buildProofLedger, handlingFacts } from '../src/portal/demo/proof-ledger.js';
import { buildDemoAccountSettings } from '../src/portal/demo/owner-account.js';
import { ownerCopyProblem } from '../src/lib/owner-copy.js';
import { site } from '../src/data/site.js';
import { LEDGER_NOW, LEDGER_TENANT, chain, daysAgo, event } from './ledger-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const covers = site.leaks.covers.items;
const on = (id, type, at, overrides = {}) => event(type, at, { correlationId: id, ...overrides });

/* what the engine writes once a reply has been read, and once the business has been told. */
const readReply = (id, at, payload) => on(id, 'lead_qualified', at, { payload: { outcome: 'qualified', ...payload } });
const told = (id, at, tech = '+16145550188') => on(id, 'routed', at, { payload: { tech, queue: 'on-call' } });

const data = (events) => buildDashboardData(LEDGER_TENANT, events, LEDGER_NOW);
const jobsByKey = (events) => Object.fromEntries(ownerJobs(data(events)).jobs.map((job) => [job.key, job]));
const values = (job) => job.handling.map((line) => [line.value, line.held]);

/* ── words ──────────────────────────────────────────────── */

describe('the words', () => {
  test('a length of time is said the way a person says it', () => {
    assert.equal(spokenDuration(400), 'under a second');
    assert.equal(spokenDuration(1000), '1 second');
    assert.equal(spokenDuration(4000), '4 seconds');
    assert.equal(spokenDuration(60_000), '1 min');
    assert.equal(spokenDuration(95_000), '1 min 35 sec');
    assert.equal(spokenDuration(3_600_000), '1 hr');
    assert.equal(spokenDuration(3_900_000), '1 hr 5 min');
    for (const junk of [null, undefined, NaN, -1, '4000', Infinity]) assert.equal(spokenDuration(junk), null, String(junk));
  });

  test('how soon has words for the reader’s four answers, and none for "unknown"', () => {
    const classifier = read('supabase/functions/_shared/classifier.ts');
    const urgencies = /URGENCIES = \[([^\]]+)\]/.exec(classifier)[1].match(/'([a-z_]+)'/g).map((u) => u.slice(1, -1));
    assert.deepEqual(Object.keys(URGENCY_WORDS).sort(), urgencies.filter((u) => u !== 'unknown').sort());
    assert.equal(urgencyWords('unknown'), null);
    assert.equal(urgencyWords('same day'), 'today', 'the generated demo writes it with a space');
    assert.equal(urgencyWords(null), null);
  });

  test('every word an owner reads here is an owner’s word', () => {
    const lines = PROOF_LEDGER_LEADS.flatMap((lead) => handlingLines(handlingFacts(lead)));
    for (const line of lines) assert.equal(ownerCopyProblem(`${line.label} ${line.value}`), null, line.value);
    for (const label of HANDLING_LABELS) assert.equal(ownerCopyProblem(label), null, label);
    for (const step of ownerHandling({ proofLedger: buildProofLedger() }, { covers }).steps) {
      for (const figure of step.figures) assert.equal(ownerCopyProblem(`${figure.label} ${figure.note ?? ''}`), null, figure.label);
    }
  });
});

/* ── one lead ───────────────────────────────────────────── */

describe('a lead’s five lines', () => {
  test('are the same five, in the same order, on every lead', () => {
    const jobs = jobsByKey([...chain('a'), ...chain('b', { reply: false }), ...chain('c', { source: 'web_form' })]);
    for (const job of Object.values(jobs)) assert.deepEqual(job.handling.map((line) => line.label), HANDLING_LABELS);
    for (const lead of buildProofLedger().leads) assert.deepEqual(lead.handling.map((line) => line.label), HANDLING_LABELS);
  });

  test('a reply that was read shows what they need, where, how soon and who was told', () => {
    const events = [
      ...chain('a', { arrived: daysAgo(1) }),
      readReply('a', daysAgo(1, -1), { job_type: 'furnace repair', zip: '43215', in_service_area: true, urgency: 'same_day' }),
      told('a', daysAgo(1, -1)),
    ];
    assert.deepEqual(values(jobsByKey(events).a), [
      ['4 seconds after the missed call', true],
      ['furnace repair', true],
      ['43215 — in your area', true],
      ['today', true],
      ['the phone ending 0188, with these answers', true],
    ]);
  });

  test('a customer who has not replied is not a gap: the questions do not apply yet', () => {
    const lines = values(jobsByKey(chain('a', { reply: false })).a);
    assert.deepEqual(lines[0], ['4 seconds after the missed call', true]);
    for (const [value, held] of lines.slice(1, 4)) {
      assert.equal(value, 'not answered — the customer has not replied');
      assert.equal(held, null);
    }
    assert.deepEqual(lines[4], ['nobody — there was nothing to pass on', null]);
  });

  test('a reply nobody has read yet is the gap, said plainly', () => {
    const lines = values(jobsByKey(chain('a')).a);
    for (const [value, held] of lines.slice(1, 4)) assert.deepEqual([value, held], ['their reply has not been read yet', false]);
  });

  test('outside the area is marked, and a zip nothing checked says so', () => {
    const outside = [...chain('a'), readReply('a', daysAgo(5), { job_type: 'ac repair', zip: '90210', in_service_area: false, urgency: 'this_week' })];
    assert.deepEqual(values(jobsByKey(outside).a)[2], ['90210 — outside your area', false]);
    const unchecked = [...chain('a'), readReply('a', daysAgo(5), { job_type: 'ac repair', zip: '43215', in_service_area: null })];
    assert.deepEqual(values(jobsByKey(unchecked).a)[2], ['43215 — not checked against your area', null]);
    assert.deepEqual(values(jobsByKey(unchecked).a)[3], ['they did not say', false]);
  });

  test('a text that failed has no time, and one that never went has none either', () => {
    assert.deepEqual(values(jobsByKey(chain('a', { textFailed: true, reply: false })).a)[0], ['the text did not send', false]);
    assert.deepEqual(values(jobsByKey(chain('a', { text: false, reply: false })).a)[0], ['no text went out', false]);
  });

  test('a website request is timed from when it came in, and keeps the zip it stated', () => {
    const [lead, ...rest] = chain('w', { source: 'web_form', reply: false });
    const withZip = [{ ...lead, payload: { ...lead.payload, zip: '43215' } }, ...rest];
    const job = jobsByKey(withZip).w;
    assert.equal(job.source, 'web_form');
    assert.deepEqual(values(job)[0], ['4 seconds after the request came in', true]);
    assert.deepEqual(values(job)[2], ['43215 — not checked against your area', null]);
  });

  test('a safety handoff reads as an emergency, and the owner is who has it', () => {
    const events = [
      ...chain('a', { handoff: 'smelled gas' }),
      readReply('a', daysAgo(5), { outcome: 'needs_human', job_type: 'gas smell', urgency: 'emergency', safety_flags: ['gas'] }),
    ];
    const lines = values(jobsByKey(events).a);
    assert.deepEqual(lines[3], ['an emergency — gas concern', true]);
    assert.deepEqual(lines[4], ['you — handed over, and arc stopped texting', true]);
  });

  test('a phone number is never printed whole, and no reply is kept', () => {
    const facts = leadHandlingFacts({ source: 'missed_call', latencyMs: 4000, replied: true, routingDestination: '+1 (614) 555-0188', qualification: { jobType: 'x'.repeat(200) } });
    assert.equal(facts.toldTo, 'the phone ending 0188');
    assert.ok(facts.need.length <= 80);
    assert.equal(leadHandlingFacts({ routingDestination: 'Dana' }).toldTo, 'Dana');
  });

  test('the answers fit in one breath on the needs-you screen', () => {
    const events = [
      ...chain('a', { name: 'Robin Example', arrived: daysAgo(1) }),
      readReply('a', daysAgo(1, -1), { job_type: 'furnace repair', zip: '43215', in_service_area: true, urgency: 'same_day' }),
    ];
    const [visit] = ownerNeeds(data(events)).groups.find((group) => group.key === 'visit').items;
    assert.match(visit.detail, /^wrote back .* — furnace repair · 43215, in your area · today$/);
    assert.equal(learnedSummary(leadHandlingFacts({ replied: true })), null);
    const [plainVisit] = ownerNeeds(data(chain('b', { arrived: daysAgo(1) }))).groups.find((group) => group.key === 'visit').items;
    assert.doesNotMatch(plainVisit.detail, / — /);
  });
});

/* ── the examples ───────────────────────────────────────── */

describe('the seven examples', () => {
  test('state no time: how fast the text goes out is measured, not written', () => {
    for (const lead of buildProofLedger().leads) {
      assert.deepEqual([lead.handling[0].value, lead.handling[0].held], ['not shown for an example', null], lead.key);
      for (const line of lead.handling) assert.doesNotMatch(String(line.value), /\d+\s?(seconds?|sec|min|hr)\b|\d{1,2}:\d{2}/, lead.key);
    }
    const summary = buildProofLedger().handling;
    for (const source of HANDLING_SOURCES) assert.equal(summary.bySource[source].medianMs, null);
  });

  test('whether an example is in the area is read off the example company’s own zip codes', () => {
    assert.deepEqual(PROOF_LEDGER_ZIPS, buildDemoAccountSettings().service_area.zips);
    const lead = PROOF_LEDGER_LEADS.find((row) => row.key === 'confirmed');
    assert.equal(handlingFacts(lead).inArea, true);
    assert.equal(handlingFacts(lead, ['90210']).inArea, false);
    assert.equal(handlingLines(handlingFacts(lead, ['90210']))[2].value, '43214 — outside your area');
    for (const row of PROOF_LEDGER_LEADS) assert.equal('inArea' in row || 'zip' in row, false, `${row.key} must not state its area`);
  });

  test('the wrong number and the silent caller are asked nothing', () => {
    const byKey = Object.fromEntries(buildProofLedger().leads.map((lead) => [lead.key, lead.handling]));
    assert.equal(byKey['wrong-number'][1].value, 'nothing to ask — it was a wrong number');
    assert.equal(byKey['no-reply'][1].value, 'not answered — the customer has not replied');
    assert.equal(byKey.handoff[4].value, 'you — handed over, and arc stopped texting');
    assert.equal(byKey.confirmed[4].value, 'you, by text, with these answers');
  });
});

/* ── the three cards ────────────────────────────────────── */

describe('the three cards', () => {
  const figures = (handling, key) => Object.fromEntries(handling.steps.find((step) => step.key === key).figures.map((f) => [f.label, f]));

  test('are the homepage’s three lines, by name and in order', () => {
    const handling = ownerHandling({ proofLedger: buildProofLedger() }, { covers });
    assert.deepEqual(handling.steps.map((step) => step.key), ['missed-call', 'web-request', 'questions']);
    assert.deepEqual(handling.steps.map((step) => step.name), covers.map((item) => item.name));
    assert.deepEqual(handling.steps.map((step) => step.what), covers.map((item) => item.what));
    assert.deepEqual(handling.steps.map((step) => step.source), ['missed_call', 'web_form', null]);
    assert.doesNotMatch(read('src/portal/lib/handling.js').replace(/\/\*[\s\S]*?\*\//g, ''), /gets a text back|gets one too/, 'no second copy of the words');
  });

  test('in the demo they are counted from the seven, and show no time', () => {
    const handling = ownerHandling({ proofLedger: buildProofLedger() }, { covers });
    assert.equal(handling.example, true);
    assert.equal(handling.window, 'the seven examples');
    const calls = figures(handling, 'missed-call');
    assert.deepEqual([calls['missed calls in'].value, calls['texted back'].value], [6, 6]);
    assert.equal(calls['typical time to the text'].value, null);
    assert.match(calls['typical time to the text'].note, /measured on a real phone line/);
    assert.equal(figures(handling, 'web-request')['website requests in'].value, 1);
    const asked = figures(handling, 'questions');
    assert.deepEqual(
      [asked['customers who answered'].value, asked['in your area'].value, asked['outside your area'].value, asked['handed to a person'].value],
      [6, 4, 0, 1],
    );
  });

  test('signed in, the time is the middle one measured on the client’s own line', () => {
    const slow = chain('b', { arrived: daysAgo(2) }).map((row) => (row.eventType === 'sms_sent' ? { ...row, latencyMs: 90_000 } : row));
    const third = chain('c', { arrived: daysAgo(3) }).map((row) => (row.eventType === 'sms_sent' ? { ...row, latencyMs: 10_000 } : row));
    const handling = ownerHandling(data([...chain('a', { arrived: daysAgo(1) }), ...slow, ...third]), { covers });
    const calls = figures(handling, 'missed-call');
    assert.equal(handling.window, 'last 30 days');
    assert.deepEqual([calls['missed calls in'].value, calls['texted back'].value], [3, 3]);
    assert.equal(calls['typical time to the text'].value, '10 seconds');
    assert.equal(calls['typical time to the text'].note, 'the slowest took 1 min 30 sec');
  });

  test('no website request is a count of none, with why none can have arrived', () => {
    const web = figures(ownerHandling(data(chain('a', { arrived: daysAgo(1) })), { covers }), 'web-request');
    assert.equal(web['website requests in'].value, 0);
    assert.match(web['website requests in'].note, /once the form is on your website/);
    assert.equal(web['typical time to the text'].value, null);
    assert.equal(web['typical time to the text'].note, 'no website request in the last 30 days');
  });

  test('replies nobody has read are not "none in your area"', () => {
    const asked = figures(ownerHandling(data(chain('a', { arrived: daysAgo(1) })), { covers }), 'questions');
    assert.equal(asked['customers who answered'].value, 1);
    assert.equal(asked['in your area'].value, null);
    assert.equal(asked['in your area'].note, 'no reply has been read yet');
    assert.equal(asked['outside your area'].available, false);
  });

  test('a failed text is said beside the count, and a lead older than the window is left out', () => {
    const events = [
      ...chain('a', { arrived: daysAgo(1) }),
      ...chain('b', { arrived: daysAgo(2), textFailed: true, reply: false }),
      ...chain('old', { arrived: daysAgo(45) }),
    ];
    const calls = figures(ownerHandling(data(events), { covers }), 'missed-call');
    assert.deepEqual([calls['missed calls in'].value, calls['texted back'].value, calls['texted back'].note], [2, 1, '1 did not send']);
    assert.equal(calls['typical time to the text'].note, 'one text measured so far');
  });

  test('a line that is not on yet shows no figure at all', () => {
    const off = data([]);
    assert.equal(off.availability.lead_capture.state, 'awaiting');
    for (const step of ownerHandling(off, { covers }).steps) {
      for (const figure of step.figures) {
        assert.equal(figure.value, null, figure.label);
        assert.equal(figure.available, false);
        assert.ok(figure.note.length > 10, figure.label);
      }
    }
  });

  test('the counts are over every lead, not the list a page is handed', () => {
    const many = Array.from({ length: 160 }, (_, i) => chain(`lead-${i}`, { arrived: daysAgo(1, i / 10), reply: false })).flat();
    const built = data(many);
    assert.equal(built.threads.length, 150);
    assert.equal(built.handling.bySource.missed_call.in, 160);
    assert.equal(summariseHandling(built.threads, LEDGER_NOW).bySource.missed_call.in, 150);
  });

  test('a canary is never counted', () => {
    const built = data([...chain('a', { arrived: daysAgo(1) }), ...chain('probe', { arrived: daysAgo(1), canary: true })]);
    assert.equal(built.handling.bySource.missed_call.in, 1);
  });

  test('summing nothing is nothing, not an error', () => {
    const empty = summariseFacts([]);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.bySource.web_form, { in: 0, texted: 0, failed: 0, timed: 0, medianMs: null, slowestMs: null });
  });
});

/* ── where it is drawn ──────────────────────────────────── */

describe('where the three lines are drawn', () => {
  test('on the owner’s front page and on the console’s client page, from one component', () => {
    assert.match(read('src/portal/pages/dash/ThisMonth.jsx'), /<HandlingPanel data=\{data\} base=\{base\} \/>/);
    assert.match(read('src/portal/pages/ops/ClientDetail.jsx'), /<HandlingPanel data=\{data\} /);
    const panel = read('src/portal/components/HandlingPanel.jsx');
    assert.match(panel, /site\.leaks\.covers\.items/);
    assert.match(panel, /<span className="ws-sr">not available<\/span>/, 'a dash is spoken as what it means');
  });

  test('nothing here reads a table or calls a function: it is the event log, already derived', () => {
    for (const file of ['src/portal/lib/handling.js', 'src/portal/components/HandlingPanel.jsx']) {
      assert.doesNotMatch(read(file), /supabase|fetch\(|\.from\(|crmApi|invoke\(/, file);
    }
  });
});
