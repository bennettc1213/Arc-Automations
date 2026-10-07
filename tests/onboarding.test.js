/* ARC-390 — route-aware onboarding: the model, with no database.
 *
 * What a business can do today, who provides each part of it from now on, and what is still
 * missing — as plain functions over plain data. `tests/onboarding-db.test.js` holds the same
 * promises against real SQL; this file holds the reasoning.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  answersRemaining,
  CAPABILITIES,
  CAPABILITY_KEYS,
  capabilityMatrix,
  EMPTY_ANSWERS,
  EMPTY_FACTS,
  getCapability,
  impactLines,
  isGap,
  MATRIX_STATES,
  onboardingCopy,
  onboardingModelProblems,
  onboardingSteps,
  onboardingSummary,
  OWNING_CAPABILITIES,
  parseAnswersInput,
  parsePlanInput,
  policyMatches,
  PROVISION_STATES,
  recommendPlan,
  REGISTRY_VIEW,
  registryReach,
  SOURCES,
  STEP_KEYS,
  targetPolicy,
} from '../supabase/functions/_shared/onboarding/model.ts';
import { OBJECT_TYPES } from '../supabase/functions/_shared/crm/model.ts';
import { CONNECTORS, PROVIDER_CATEGORIES } from '../supabase/functions/_shared/registry/connectors.ts';
import { getRoute, ROUTE_DISCOVERY, ROUTE_KEYS, routeCopyProblem } from '../supabase/functions/_shared/routes/model.ts';
import { glossFor } from '../src/portal/lib/glossary.js';
import { readFileSync } from 'node:fs';

/* ── fixtures ───────────────────────────────────────────── */

const arc = { source: 'arc', connector_key: null, tool: null };
const out = { source: 'not_needed', connector_key: null, tool: null };
const kept = (connector_key, tool = null) => ({ source: 'external', connector_key, tool });

const discovery = (answers) => Object.fromEntries(ROUTE_DISCOVERY.map((q) => [q.key, answers[q.key]]));
const NOTHING_IN_PLACE = discovery({ crm: 'none', lead_tracking: 'no', online_booking: 'no', follow_up: 'no', keep: 'nothing' });
const SOME_TOOLS = discovery({ crm: 'none', lead_tracking: 'partial', online_booking: 'yes', follow_up: 'no', keep: 'some' });
const FULL_SYSTEM = discovery({ crm: 'established', lead_tracking: 'yes', online_booking: 'yes', follow_up: 'partial', keep: 'everything' });

const nothing = { uses: 'nothing' };
const own = (keep, connector_key = null, tool = null) => ({ uses: 'own_tool', keep, connector_key, tool });
const tools = (overrides = {}) => Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, overrides[key] ?? nothing]));

const facts = (overrides = {}) => ({ ...EMPTY_FACTS, ...overrides });
const row = (matrix, key) => matrix.find((r) => r.capability === key);

/** the registry, plus one provider a client connects themselves — which the registry does not have yet. */
const WITH_A_CONNECTABLE_CRM = {
  ...REGISTRY_VIEW,
  known: (key) => key === 'test_crm' || REGISTRY_VIEW.known(key),
  name: (key) => (key === 'test_crm' ? 'Test CRM' : REGISTRY_VIEW.name(key)),
  category: (key) => (key === 'test_crm' ? 'crm' : REGISTRY_VIEW.category(key)),
  reach: (key) => (key === 'test_crm' ? 'client' : REGISTRY_VIEW.reach(key)),
};

const NATIVE_PLAN = {
  route: 'native',
  capabilities: {
    customer_records: arc, lead_intake: arc, lead_pipeline: arc, website_form: arc, messaging: arc,
    email: out, calendar: arc, booking: arc, field_service: out, accounting: out,
  },
};

/* ── the vocabulary ─────────────────────────────────────── */

describe('capabilities', () => {
  test('the model is well formed, and every line of it may be read to an owner', () => {
    assert.deepEqual(onboardingModelProblems(), []);
    for (const { where, text } of onboardingCopy()) assert.equal(routeCopyProblem(text), null, where);
  });

  test('a capability is something a business does: no capability, question or step names a product', () => {
    const products = CONNECTORS.flatMap((c) => [c.key, c.displayName]).filter((name) => name.length > 3);
    for (const { where, text } of onboardingCopy()) {
      for (const product of products) assert.ok(!text.toLowerCase().includes(product.toLowerCase()), `${where} names ${product}`);
    }
    for (const capability of CAPABILITIES) {
      assert.ok(capability.providers.every((category) => PROVIDER_CATEGORIES.includes(category)), capability.key);
    }
  });

  test('the four things a capability can be are the roadmap\'s four, and one of them is never chosen', () => {
    assert.deepEqual([...PROVISION_STATES], ['arc', 'external', 'not_needed', 'blocked']);
    assert.deepEqual([...SOURCES], ['arc', 'external', 'not_needed']);
    assert.ok(!SOURCES.includes('blocked'), 'blocked is found, not chosen');
    assert.deepEqual([...MATRIX_STATES], [...PROVISION_STATES, 'undecided']);
  });

  test('three capabilities decide who keeps a kind of record, and they are ARC-340\'s kinds', () => {
    assert.deepEqual(OWNING_CAPABILITIES, [
      { capability: 'customer_records', object: 'contact' },
      { capability: 'lead_pipeline', object: 'lead' },
      { capability: 'calendar', object: 'appointment' },
    ]);
    for (const { object } of OWNING_CAPABILITIES) assert.ok(OBJECT_TYPES.includes(object), object);
  });

  test('no step asks anybody to open, edit or copy a workflow', () => {
    for (const key of STEP_KEYS) assert.doesNotMatch(key, /n8n|workflow|node/);
    const steps = onboardingSteps({ answers: null, plan: NATIVE_PLAN, facts: facts() });
    for (const step of steps) {
      assert.doesNotMatch(`${step.label} ${step.detail}`, /\bn8n\b|workflow|\bnode\b/i, step.key);
      assert.equal(routeCopyProblem(step.label), null, step.key);
      assert.equal(routeCopyProblem(step.detail), null, step.key);
    }
    for (const r of capabilityMatrix(NATIVE_PLAN, facts())) assert.equal(routeCopyProblem(r.reason), null, r.capability);
  });
});

/* ── what they said ─────────────────────────────────────── */

describe('the questionnaire', () => {
  test('it is the route questions, one per capability, and whether there is a list to bring in', () => {
    assert.equal(answersRemaining(null).length, ROUTE_DISCOVERY.length + CAPABILITIES.length + 1);
    const parsed = parseAnswersInput({ discovery: NOTHING_IN_PLACE, tools: tools(), existing_records: 'none' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(answersRemaining(parsed.value), []);
  });

  test('an answer the question does not offer is a problem, not something dropped', () => {
    const parsed = parseAnswersInput({
      discovery: { crm: 'sometimes', nonsense: 'yes' },
      tools: { customer_records: { uses: 'maybe' }, payroll: nothing, calendar: { uses: 'nothing', keep: true } },
      existing_records: 'in a drawer',
      route: 'native',
    });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((e) => e.field).sort(), [
      'discovery.crm', 'discovery.nonsense', 'existing_records', 'route',
      'tools.calendar', 'tools.customer_records.uses', 'tools.payroll',
    ]);
  });

  test('a tool is named, never signed into: a credential-shaped name is refused', () => {
    const secret = ['sk', 'live', 'a1b2c3d4e5f6g7h8'].join('_');
    const parsed = parseAnswersInput({ tools: { accounting: own(true, null, secret) } });
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors[0].message, /credential/);
    const plan = parsePlanInput({ route: 'hybrid', capabilities: { accounting: kept(null, secret) } });
    assert.equal(plan.ok, false);
    assert.match(plan.errors[0].message, /credential/);
  });

  test('a system can only be named for what that kind of system holds', () => {
    const parsed = parseAnswersInput({ tools: { accounting: own(true, 'google_calendar'), calendar: own(true, 'google_calendar') } });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((e) => e.field), ['tools.accounting.connector_key']);
  });
});

/* ── the recommendation ─────────────────────────────────── */

describe('the recommendation', () => {
  test('nothing is suggested until the business has answered the route questions', () => {
    const partial = recommendPlan({ ...EMPTY_ANSWERS, discovery: { crm: 'none' } });
    assert.equal(partial.complete, false);
    assert.equal(partial.plan, null);
    assert.equal(partial.route, null);
    assert.match(partial.notice, /suggestion/i);
  });

  test('a business with nothing in place is ARC Native, and its plan names no other system', () => {
    const suggestion = recommendPlan({ discovery: NOTHING_IN_PLACE, tools: tools(), existing_records: 'none' });
    assert.equal(suggestion.route, 'native');
    const choices = Object.values(suggestion.plan.capabilities);
    assert.equal(choices.length, CAPABILITIES.length);
    assert.ok(choices.every((c) => c.source !== 'external' && c.connector_key === null && c.tool === null));
    assert.equal(suggestion.plan.capabilities.customer_records.source, 'arc');
    assert.equal(suggestion.plan.capabilities.accounting.source, 'not_needed', 'ARC does not keep books, so it does not offer to');
    assert.equal(parsePlanInput(suggestion.plan).ok, true);
  });

  test('starting fresh is ARC Native even for a business that had a CRM: every record is ARC\'s', () => {
    const suggestion = recommendPlan({
      discovery: discovery({ crm: 'partial', lead_tracking: 'partial', online_booking: 'no', follow_up: 'no', keep: 'nothing' }),
      tools: tools({ customer_records: own(true, 'jobber'), accounting: own(true, null, 'their books') }),
      existing_records: 'spreadsheet',
    });
    assert.equal(suggestion.route, 'native');
    assert.equal(suggestion.plan.capabilities.customer_records.source, 'arc');
    assert.deepEqual(suggestion.plan.capabilities.accounting, kept(null, 'their books'), 'a tool that owns no ARC record can still be kept');
    assert.equal(parsePlanInput(suggestion.plan).ok, true);
  });

  test('keeping some tools is ARC Hybrid: ARC for the gaps, their system for what they keep', () => {
    const suggestion = recommendPlan({
      discovery: SOME_TOOLS,
      tools: tools({ calendar: own(true, 'google_calendar'), booking: own(true, 'google_calendar'), messaging: own(false, null, 'a personal phone') }),
      existing_records: 'spreadsheet',
    });
    assert.equal(suggestion.route, 'hybrid');
    const plan = suggestion.plan.capabilities;
    assert.deepEqual(plan.calendar, kept('google_calendar'));
    assert.deepEqual(plan.booking, kept('google_calendar'));
    assert.deepEqual(plan.customer_records, arc);
    assert.deepEqual(plan.messaging, arc, 'a tool they do not want to keep is a gap ARC fills');
    assert.equal(parsePlanInput(suggestion.plan).ok, true);
  });

  test('an established system kept whole is ARC Connected, and the customer list stays theirs', () => {
    const suggestion = recommendPlan({
      discovery: FULL_SYSTEM,
      tools: tools({
        customer_records: own(true, 'servicetitan'), lead_pipeline: own(true, 'servicetitan'), lead_intake: own(true, 'servicetitan'),
        calendar: own(true, 'servicetitan'), field_service: own(true, 'servicetitan'), accounting: own(true, null, 'their books'),
      }),
      existing_records: 'their_system',
    });
    assert.equal(suggestion.route, 'connected');
    assert.deepEqual(suggestion.plan.capabilities.customer_records, kept('servicetitan'));
    assert.deepEqual(suggestion.plan.capabilities.field_service, kept('servicetitan'));
    assert.equal(parsePlanInput(suggestion.plan).ok, true);
  });

  test('on ARC Connected an unnamed customer system is left undecided, never quietly given to ARC', () => {
    const suggestion = recommendPlan({ discovery: FULL_SYSTEM, tools: tools({ customer_records: own(true) }), existing_records: 'their_system' });
    assert.equal(suggestion.route, 'connected');
    assert.equal(suggestion.plan.capabilities.customer_records, undefined);
    assert.equal(row(capabilityMatrix(suggestion.plan, facts()), 'customer_records').state, 'undecided');
  });

  test('a recommendation is data: it has nothing to select, activate, publish or connect with', () => {
    const suggestion = recommendPlan({ discovery: NOTHING_IN_PLACE, tools: tools(), existing_records: 'none' });
    assert.deepEqual(Object.keys(suggestion).sort(), ['complete', 'notice', 'plan', 'reasons', 'remaining', 'route']);
    assert.deepEqual(Object.keys(suggestion.plan).sort(), ['capabilities', 'route']);
    assert.doesNotMatch(JSON.stringify(suggestion.plan), /module|lead_recovery|active|publish/);
  });
});

/* ── the plan ───────────────────────────────────────────── */

describe('a plan', () => {
  test('ARC Native keeps every record in ARC', () => {
    const parsed = parsePlanInput({ route: 'native', capabilities: { customer_records: kept('jobber'), calendar: kept('google_calendar'), accounting: kept(null, 'their books') } });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((e) => e.field).sort(), ['capabilities.calendar.source', 'capabilities.customer_records.source']);
    assert.match(parsed.errors[0].message, /ARC Native keeps/);
  });

  test('ARC Connected keeps the customer list in their system', () => {
    for (const choice of [arc, out]) {
      const parsed = parsePlanInput({ route: 'connected', capabilities: { customer_records: choice } });
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.errors.map((e) => e.field), ['capabilities.customer_records.source']);
    }
    assert.equal(parsePlanInput({ route: 'connected', capabilities: { customer_records: kept('servicetitan') } }).ok, true);
    assert.equal(parsePlanInput({ route: 'connected', capabilities: {} }).ok, true, 'a plan may be saved before every line is decided');
  });

  test('ARC Hybrid names at least one system they keep, once everything is decided', () => {
    const everything = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c.arc ? arc : out]));
    const all = parsePlanInput({ route: 'hybrid', capabilities: everything });
    assert.equal(all.ok, false);
    assert.deepEqual(all.errors.map((e) => e.field), ['route']);
    assert.equal(parsePlanInput({ route: 'hybrid', capabilities: { customer_records: arc } }).ok, true, 'not yet, while it is still being filled in');
    assert.equal(parsePlanInput({ route: 'hybrid', capabilities: { ...everything, accounting: kept(null, 'their books') } }).ok, true);
  });

  test('ARC is not offered for what ARC does not do, and ARC\'s own account is not their system', () => {
    const parsed = parsePlanInput({ route: 'hybrid', capabilities: { accounting: arc, field_service: arc, messaging: kept('twilio') } });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((e) => e.field).sort(), ['capabilities.accounting.source', 'capabilities.field_service.source', 'capabilities.messaging.connector_key']);
    assert.match(parsed.errors.find((e) => e.field === 'capabilities.messaging.connector_key').message, /ARC's own account/);
    assert.equal(registryReach('twilio'), 'arc_owned');
    assert.equal(registryReach('jobber'), 'none');
  });

  test('another system is named, by a connector ARC knows or by what the business calls it', () => {
    const unnamed = parsePlanInput({ route: 'hybrid', capabilities: { accounting: kept(null, null) } });
    assert.equal(unnamed.ok, false);
    assert.match(unnamed.errors[0].message, /name the system/);
    const unknown = parsePlanInput({ route: 'hybrid', capabilities: { accounting: kept('not_a_connector') } });
    assert.equal(unknown.ok, false);
    const both = parsePlanInput({ route: 'hybrid', capabilities: { calendar: kept('google_calendar', 'the shared calendar') } });
    assert.deepEqual(both.value.capabilities.calendar, kept('google_calendar'), 'the connector is the name once ARC has one');
    const mixed = parsePlanInput({ route: 'hybrid', capabilities: { customer_records: { source: 'arc', connector_key: 'jobber' } } });
    assert.equal(mixed.ok, false);
  });

  test('every problem comes back at once, and an unknown field is one of them', () => {
    const parsed = parsePlanInput({ route: 'sideways', activate: true, capabilities: { payroll: arc, calendar: { source: 'ours' }, booking: { source: 'arc', when: 'now' } } });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((e) => e.field).sort(), ['activate', 'capabilities.booking.when', 'capabilities.calendar.source', 'capabilities.payroll', 'route']);
  });
});

/* ── the matrix ─────────────────────────────────────────── */

describe('the capability matrix', () => {
  test('with no plan every capability is a gap, and the table still lists all of them', () => {
    const matrix = capabilityMatrix(null, facts());
    assert.deepEqual(matrix.map((r) => r.capability), [...CAPABILITY_KEYS]);
    assert.ok(matrix.every((r) => r.state === 'undecided' && isGap(r)));
  });

  test('a capability given to ARC is ARC\'s only once the ARC piece exists', () => {
    const bare = capabilityMatrix(NATIVE_PLAN, facts());
    assert.equal(row(bare, 'customer_records').state, 'arc');
    assert.equal(row(bare, 'lead_intake').state, 'arc', 'a lead can always be typed in or imported');
    for (const key of ['lead_pipeline', 'website_form', 'calendar', 'booking', 'messaging']) assert.equal(row(bare, key).state, 'blocked', key);
    assert.match(row(bare, 'website_form').reason, /No form/);
    assert.match(row(bare, 'calendar').reason, /opening hours/);

    const drafted = capabilityMatrix(NATIVE_PLAN, facts({ forms: { total: 1, published: 0 }, appointment_types: 1, booking_pages: { total: 1, published: 0 } }));
    assert.match(row(drafted, 'website_form').reason, /drafted and not published/);
    assert.match(row(drafted, 'booking').reason, /drafted and not published/);

    const ready = capabilityMatrix(NATIVE_PLAN, facts({
      pipeline: true, hours_set: true, services: 2, forms: { total: 1, published: 1 }, appointment_types: 1, booking_pages: { total: 1, published: 1 },
    }));
    for (const key of ['customer_records', 'lead_intake', 'lead_pipeline', 'website_form', 'calendar', 'booking']) assert.equal(row(ready, key).state, 'arc', key);
    assert.equal(row(ready, 'email').state, 'not_needed');
    assert.equal(row(ready, 'accounting').state, 'not_needed');
  });

  test('ARC sending a person\'s message is blocked until a channel exists — and says what still sends', () => {
    const none = row(capabilityMatrix(NATIVE_PLAN, facts()), 'messaging');
    assert.equal(none.state, 'blocked');
    assert.match(none.reason, /No channel is switched on/);
    assert.match(none.reason, /Automated follow-up texts/);
    assert.equal(row(capabilityMatrix(NATIVE_PLAN, facts({ channels: ['sms'] })), 'messaging').state, 'arc');
  });

  test('a system they keep is external only once ARC can reach it', () => {
    const plan = { route: 'connected', capabilities: { customer_records: kept('servicetitan'), accounting: kept(null, 'their books') } };
    const noAdapter = row(capabilityMatrix(plan, facts()), 'customer_records');
    assert.equal(noAdapter.state, 'blocked');
    assert.equal(noAdapter.provider, 'ServiceTitan');
    assert.match(noAdapter.reason, /no connection to ServiceTitan yet/);
    assert.match(noAdapter.reason, /keeps its own copy/);

    /* what ARC does not touch is simply theirs. */
    const books = row(capabilityMatrix(plan, facts()), 'accounting');
    assert.equal(books.state, 'external');
    assert.match(books.reason, /ARC does not read or write it/);
  });

  test('with a provider a client can connect: authority, then connection, then it is external', () => {
    const plan = { route: 'connected', capabilities: { customer_records: kept('test_crm') } };
    const view = WITH_A_CONNECTABLE_CRM;
    assert.equal(parsePlanInput(plan, view).ok, true);

    const planned = row(capabilityMatrix(plan, facts(), view), 'customer_records');
    assert.equal(planned.state, 'blocked');
    assert.equal(planned.next, 'authority');

    const handed = facts({ policies: [{ object_type: 'contact', authority: 'external', connector_key: 'test_crm' }] });
    const unconnected = row(capabilityMatrix(plan, handed, view), 'customer_records');
    assert.equal(unconnected.state, 'blocked');
    assert.equal(unconnected.next, 'connections');
    assert.match(unconnected.reason, /not connected yet/);

    const pending = row(capabilityMatrix(plan, { ...handed, connections: [{ connector_key: 'test_crm', status: 'connected_unverified' }] }, view), 'customer_records');
    assert.equal(pending.state, 'blocked', 'a token is not readiness');
    assert.match(pending.reason, /not verified/);

    for (const status of ['verified', 'degraded']) {
      const done = row(capabilityMatrix(plan, { ...handed, connections: [{ connector_key: 'test_crm', status }] }, view), 'customer_records');
      assert.equal(done.state, 'external', status);
    }
  });

  test('their own form or lead system reaches ARC through an endpoint, with no connector at all', () => {
    const plan = { route: 'hybrid', capabilities: { website_form: kept(null, 'the form on their site'), lead_intake: kept('jobber') } };
    const before = capabilityMatrix(plan, facts());
    assert.equal(row(before, 'website_form').state, 'blocked');
    assert.match(row(before, 'website_form').reason, /endpoint/);
    const after = capabilityMatrix(plan, facts({ endpoints: 1 }));
    assert.equal(row(after, 'website_form').state, 'external');
    assert.equal(row(after, 'lead_intake').state, 'external');
  });

  test('a plan that gives a record back to ARC is blocked until the authority is moved', () => {
    const still = facts({ policies: [{ object_type: 'contact', authority: 'external', connector_key: 'servicetitan' }] });
    const blocked = row(capabilityMatrix(NATIVE_PLAN, still), 'customer_records');
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.next, 'authority');
    assert.match(blocked.reason, /ServiceTitan is still recorded/);
  });

  test('ARC booking over their calendar is a preferred time, and says so', () => {
    const plan = { route: 'hybrid', capabilities: { calendar: kept('google_calendar'), booking: arc } };
    const ready = facts({ appointment_types: 1, booking_pages: { total: 1, published: 1 } });
    assert.match(row(capabilityMatrix(plan, ready), 'booking').reason, /preferred time/);
  });
});

/* ── authority ──────────────────────────────────────────── */

describe('who keeps a record', () => {
  test('their system is the authority only where the plan names a connector ARC has an entry for', () => {
    assert.deepEqual(targetPolicy(kept('servicetitan')), { authority: 'external', connector_key: 'servicetitan' });
    assert.deepEqual(targetPolicy(kept(null, 'a spreadsheet')), { authority: 'arc', connector_key: null });
    assert.deepEqual(targetPolicy(arc), { authority: 'arc', connector_key: null });
    assert.deepEqual(targetPolicy(out), { authority: 'arc', connector_key: null });
    assert.deepEqual(targetPolicy(undefined), { authority: 'arc', connector_key: null });
  });

  test('a field-by-field split an operator made with the same system is left alone', () => {
    const want = { authority: 'external', connector_key: 'servicetitan' };
    assert.equal(policyMatches({ authority: 'external', connector_key: 'servicetitan' }, want), true);
    assert.equal(policyMatches({ authority: 'hybrid', connector_key: 'servicetitan' }, want), true);
    assert.equal(policyMatches({ authority: 'hybrid', connector_key: 'jobber' }, want), false);
    assert.equal(policyMatches({ authority: 'arc', connector_key: null }, want), false);
    assert.equal(policyMatches({ authority: 'hybrid', connector_key: 'jobber' }, { authority: 'arc', connector_key: null }), false);
  });

  test('what a change will do is said in counts, and never as a deletion or a send', () => {
    const toTheirs = impactLines({
      digest: 'x', route: { from: 'native', to: 'connected' },
      changes: [{ object_type: 'contact', capability: 'customer_records', from: { authority: 'arc', connector_key: null }, to: { authority: 'external', connector_key: 'servicetitan' }, records: 12, mapped: 4 }],
    });
    assert.match(toTheirs[0], /from ARC Native to ARC Connected/);
    assert.match(toTheirs[0], /No customer, lead, message or appointment is deleted/);
    assert.match(toTheirs[1], /ARC holds 12 customer records/);
    assert.match(toTheirs[1], /8 of them are not linked to a record in ServiceTitan yet/);
    assert.match(toTheirs.join(' '), /no connection to ServiceTitan yet/);

    const back = impactLines({
      digest: 'y', route: null,
      changes: [{ object_type: 'appointment', capability: 'calendar', from: { authority: 'external', connector_key: 'google_calendar' }, to: { authority: 'arc', connector_key: null }, records: 3, mapped: 3 }],
    });
    assert.match(back[0], /ARC becomes where appointments are kept, in place of Google Calendar/);
    assert.match(back[0], /3 of them keep their link to Google Calendar as history/);
    assert.match(back[0], /Nothing is sent to Google Calendar/);
    assert.match(back[1], /starts offering times/);
    for (const line of [...toTheirs, ...back]) assert.equal(routeCopyProblem(line), null, line);

    /* one record is one record, and none is said as none — never "0 of them". */
    const one = impactLines({
      digest: 'z', route: null,
      changes: [
        { object_type: 'contact', capability: 'customer_records', from: { authority: 'arc', connector_key: null }, to: { authority: 'external', connector_key: 'servicetitan' }, records: 1, mapped: 0 },
        { object_type: 'lead', capability: 'lead_pipeline', from: { authority: 'arc', connector_key: null }, to: { authority: 'external', connector_key: 'servicetitan' }, records: 0, mapped: 0 },
        { object_type: 'appointment', capability: 'calendar', from: { authority: 'arc', connector_key: null }, to: { authority: 'external', connector_key: 'servicetitan' }, records: 2, mapped: 2 },
      ],
    }).join(' ');
    assert.match(one, /ARC holds 1 customer record\. /);
    assert.match(one, /1 of them is not linked/);
    assert.match(one, /ARC holds no leads yet\./);
    assert.match(one, /Every one is linked to a record in ServiceTitan/);
    assert.doesNotMatch(one, /\b0 of them\b|holds 0\b/);
  });
});

/* ── the steps ──────────────────────────────────────────── */

describe('the steps', () => {
  const step = (steps, key) => steps.find((s) => s.key === key);

  test('before anything is said, nothing is done and nothing is pretended', () => {
    const steps = onboardingSteps({ answers: null, plan: null, facts: facts() });
    assert.deepEqual(steps.map((s) => s.key), [...STEP_KEYS]);
    assert.ok(steps.every((s) => s.status !== 'done'), JSON.stringify(steps.filter((s) => s.status === 'done')));
    const summary = onboardingSummary(steps, capabilityMatrix(null, facts()));
    assert.equal(summary.done, 0);
    assert.equal(summary.gaps, CAPABILITIES.length);
    assert.equal(summary.ready_for_handoff, false);
  });

  test('a step is done because the thing exists, so the same rows always give the same answer', () => {
    const answers = { discovery: NOTHING_IN_PLACE, tools: tools(), existing_records: 'spreadsheet' };
    const plan = { ...NATIVE_PLAN, capabilities: { ...NATIVE_PLAN.capabilities, messaging: out } };
    const built = facts({
      route: 'native', pipeline: true, hours_set: true, services: 1, forms: { total: 1, published: 1 }, appointment_types: 1,
      booking_pages: { total: 1, published: 1 }, modules: [{ module_key: 'lead_recovery', state: 'configuring' }],
    });
    const steps = onboardingSteps({ answers, plan, facts: built });
    assert.deepEqual(onboardingSteps({ answers, plan, facts: structuredClone(built) }), steps);
    for (const key of ['stack', 'route', 'capabilities', 'business', 'authority', 'lead_capture', 'booking', 'modules']) assert.equal(step(steps, key).status, 'done', key);
    assert.equal(step(steps, 'connections').status, 'not_needed', 'ARC Native connects nothing');
    assert.equal(step(steps, 'mapping').status, 'not_needed');
    assert.equal(step(steps, 'import').status, 'todo', 'they said there is a list in a file');
    assert.equal(step(steps, 'activation').status, 'todo');
    assert.match(step(steps, 'activation').detail, /lead_recovery is configuring/);
    assert.match(step(steps, 'activation').detail, /activation page/);

    const summary = onboardingSummary(steps, capabilityMatrix(plan, built));
    assert.deepEqual(summary.outstanding, ['import']);
    assert.equal(summary.ready_for_handoff, false);

    const imported = onboardingSteps({ answers, plan, facts: { ...built, imports: { completed: 1 } } });
    assert.equal(onboardingSummary(imported, capabilityMatrix(plan, built)).ready_for_handoff, true);
    assert.equal(step(imported, 'activation').status, 'todo', 'ready to hand over is not live');
  });

  test('a route in the plan is not a route on record until it is applied', () => {
    const steps = onboardingSteps({ answers: null, plan: NATIVE_PLAN, facts: facts(), pending: { digest: 'd', route: { from: null, to: 'native' }, changes: [] } });
    assert.equal(step(steps, 'route').status, 'todo');
    assert.equal(step(steps, 'authority').status, 'todo');
    assert.match(step(steps, 'authority').detail, /1 change waiting/);
  });

  test('a system ARC cannot reach blocks the connection step; one it can reach is to do', () => {
    const plan = { route: 'connected', capabilities: { customer_records: kept('servicetitan') } };
    const handed = facts({ policies: [{ object_type: 'contact', authority: 'external', connector_key: 'servicetitan' }] });
    assert.equal(step(onboardingSteps({ answers: null, plan, facts: handed }), 'connections').status, 'blocked');

    const reachable = { route: 'connected', capabilities: { customer_records: kept('test_crm') } };
    const view = WITH_A_CONNECTABLE_CRM;
    const mine = facts({ policies: [{ object_type: 'contact', authority: 'external', connector_key: 'test_crm' }] });
    assert.equal(step(onboardingSteps({ answers: null, plan: reachable, facts: mine }, view), 'connections').status, 'todo');
    const connected = { ...mine, connections: [{ connector_key: 'test_crm', status: 'verified' }] };
    assert.equal(step(onboardingSteps({ answers: null, plan: reachable, facts: connected }, view), 'connections').status, 'done');
  });

  test('records ARC already holds are counted until each is linked to its counterpart', () => {
    const plan = { route: 'connected', capabilities: { customer_records: kept('servicetitan') } };
    const policies = [{ object_type: 'contact', authority: 'external', connector_key: 'servicetitan' }];
    const base = { contact: { total: 5, mapped: { servicetitan: 2 } }, lead: { total: 0, mapped: {} }, appointment: { total: 0, mapped: {} } };
    const some = step(onboardingSteps({ answers: null, plan, facts: facts({ policies, records: base }) }), 'mapping');
    assert.equal(some.status, 'todo');
    assert.match(some.detail, /3 of 5 customer records are not linked to a record in ServiceTitan/);
    const all = { ...base, contact: { total: 5, mapped: { servicetitan: 5 } } };
    assert.equal(step(onboardingSteps({ answers: null, plan, facts: facts({ policies, records: all }) }), 'mapping').status, 'done');
  });

  test('every state and every route the page prints has its meaning in the glossary, under its own word', () => {
    for (const state of MATRIX_STATES) {
      const entry = glossFor(`onb_${state}`);
      assert.ok(entry, state);
      assert.equal(entry.label.toLowerCase(), state.replace('_', ' '), 'the word on screen is the system\'s word');
    }
    for (const key of ROUTE_KEYS) assert.equal(glossFor(`route_${key}`).label, getRoute(key).name);
    assert.ok(glossFor('record_authority'));
  });

  test('the page is drawn from the model and decides nothing of its own', () => {
    const page = readFileSync(new URL('../src/portal/components/OnboardingPanel.jsx', import.meta.url), 'utf8');
    for (const name of ['parseAnswersInput', 'parsePlanInput', 'recommendPlan', 'CAPABILITIES']) assert.match(page, new RegExp(`\\b${name}\\b`), name);
    /* its four writes are the four actions; a module's lifecycle is not among them. */
    assert.doesNotMatch(page, /selectModule|activateLeadRecovery|module-select|module-activate|setIntakeFormStatus/);
    assert.doesNotMatch(page, /\bn8n\b/i);
    const workspace = readFileSync(new URL('../src/portal/components/OpsWorkspace.jsx', import.meta.url), 'utf8');
    assert.match(workspace, /path="clients\/:tenantId\/onboarding" element=\{<ClientOnboarding/);
  });

  test('getCapability answers only for a capability', () => {
    assert.equal(getCapability('calendar').object, 'appointment');
    assert.equal(getCapability('toString'), null);
    assert.equal(getCapability(null), null);
  });
});
