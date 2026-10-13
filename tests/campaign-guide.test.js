import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, newCampaign, readiness, validateCampaign } from '../src/portal/product/model.js';
import { applyRecommended, guideSteps, isRecommended, journey, messageTemplates, oneLine, readinessItems, recommend, recommendKind, suggestedServices, templateOf } from '../src/portal/product/guide.js';
import { demoState } from '../src/portal/demo/product-demo.js';

const kinds = Object.keys(KINDS);

test('a recommended campaign is one the model accepts, with no field the model does not have', () => {
  const s = demoState();
  for (const kind of kinds) {
    const base = newCampaign(kind, s.tenantId);
    const c = applyRecommended(base, s);
    assert.deepEqual(validateCampaign(c, s.business), [], `${kind} recommended setup fails validation`);
    // the server refuses a draft with an unknown key, and a stored value nothing reads looks like it does something
    assert.deepEqual(Object.keys(c).sort(), Object.keys(base).sort());
    for (const q of c.questions) assert.deepEqual(Object.keys(q).sort(), ['key', 'required', 'text']);
    assert.equal(isRecommended(c, s), true);
    assert.equal(isRecommended({ ...c, delay: 15 }, s), false);
  }
});

test('every written first text names the business and carries the opt-out line', () => {
  const s = demoState();
  for (const kind of kinds) {
    const templates = messageTemplates(kind);
    assert.ok(templates.some(t => t.text === newCampaign(kind).message), `${kind}: the model default is one of the templates`);
    assert.equal(new Set(templates.map(t => t.id)).size, templates.length);
    for (const t of templates) {
      assert.deepEqual(validateCampaign({ ...newCampaign(kind), message: t.text }, s.business), [], `${kind}/${t.id}`);
      assert.equal(templateOf({ kind, message: t.text }), t.id);
    }
    assert.ok(templates.some(t => t.id === recommend(kind, s).message.value), `${kind}: the recommended text exists`);
  }
  assert.equal(templateOf({ kind: 'missed', message: 'Something of my own. {{business}} STOP' }), 'custom');
});

test('a missed caller is not addressed by a name ARC does not have', () => {
  const s = demoState();
  const pick = messageTemplates('missed').find(t => t.id === recommend('missed', s).message.value);
  assert.doesNotMatch(pick.text, /first_name/);
});

test('a recommendation is read off the business, and says why', () => {
  const s = demoState();
  const hvac = recommend('missed', s);
  assert.match(hvac.questions.urgency.reason, /HVAC/);
  assert.match(hvac.afterHours.reason, /8 am to 5 pm/);
  const painter = recommend('missed', { ...s, business: { ...s.business, trade: 'Bookkeeping', services: 'Tax returns', area: '' } });
  assert.doesNotMatch(painter.questions.urgency.reason, /urgent/);
  assert.match(painter.questions.location.reason, /Add your service area/);
  for (const kind of kinds) {
    const r = recommend(kind, s);
    for (const pick of [r.message, r.delay, r.afterHours, r.followupHours, r.approval, r.limits, ...Object.values(r.questions)]) assert.ok(pick.reason.length > 20);
  }
});

test('only a connected source earns a recommended campaign', () => {
  assert.equal(recommendKind(demoState()).value, 'missed');
  assert.equal(recommendKind(demoState(true)).value, null);
  const s = demoState(true);
  s.connections.find(c => c.id === 'form').state = 'connected';
  assert.equal(recommendKind(s).value, 'inbound');
});

test('the readiness list and the model agree on when a campaign is ready', () => {
  const states = [demoState(), demoState(true), { ...demoState(), mode: 'production' }];
  const untested = demoState(); untested.connections[0].routingTested = false; states.push(untested);
  const pending = demoState(); pending.connections.find(c => c.id === 'messaging').state = 'pending_review'; states.push(pending);
  for (const s of states) {
    for (const kind of kinds) {
      for (const c of [newCampaign(kind, s.tenantId), { ...newCampaign(kind, s.tenantId), message: 'Hello' }]) {
        const items = readinessItems(c, s);
        assert.equal(items.every(item => item.done), readiness(c, s).length === 0, `${s.mode}/${kind}`);
        for (const item of items) assert.ok(item.label && item.todo, 'each item says what is left');
        // an open item either says where to fix it or why it cannot be fixed here
        for (const item of items.filter(item => !item.done)) assert.ok(item.to || item.step || item.detail, item.id);
      }
    }
  }
});

test('a real account is never told that switching a campaign on works', () => {
  const s = { ...demoState(), mode: 'production' };
  const publish = readinessItems(newCampaign('missed', s.tenantId), s).find(item => item.id === 'publish');
  assert.equal(publish.done, false);
  assert.match(publish.detail, /Not available yet/);
  assert.equal(readinessItems(newCampaign('missed'), demoState()).some(item => item.id === 'publish'), false);
});

test('the journey is the campaign in order, with every placeholder filled in', () => {
  const s = demoState();
  for (const kind of kinds) {
    const c = applyRecommended(newCampaign(kind, s.tenantId), s);
    const steps = journey(c, s.business);
    assert.equal(steps[0].who, 'trigger');
    assert.equal(steps.at(-1).who, 'stop');
    assert.doesNotMatch(JSON.stringify(steps), /\{\{/);
    assert.equal(steps.find(step => step.items).items.length, c.questions.length);
    assert.ok(steps.some(step => /^No reply after/.test(step.title)));
    // one text only means no check-in is promised
    assert.equal(journey({ ...c, maxContacts: 1 }, s.business).some(step => /^No reply after/.test(step.title)), false);
    assert.equal(journey({ ...c, questions: [] }, s.business).some(step => step.items), false);
    assert.ok(oneLine(c).length > 20);
  }
  const texted = journey(newCampaign('missed'), { ...s.business, alerts: 'Inbox and owner text', ownerPhone: '+15551234567' });
  assert.match(texted.find(step => step.who === 'owner').title, /by text/);
  // no number on file: the alert is not promised by text
  assert.doesNotMatch(journey(newCampaign('missed'), { ...s.business, alerts: 'Inbox and owner text', ownerPhone: '' }).find(step => step.who === 'owner').title, /by text/);
});

test('the guide asks the same questions for every kind, plus who for a follow-up', () => {
  assert.deepEqual(guideSteps('missed').map(step => step.id), ['goal', 'message', 'questions', 'timing', 'followup', 'limits', 'review']);
  assert.deepEqual(guideSteps('followup').map(step => step.id), ['goal', 'audience', 'message', 'questions', 'timing', 'followup', 'limits', 'review']);
});

test('suggested services come from the trade and leave out what is already listed', () => {
  assert.deepEqual(suggestedServices({ trade: 'hvac ', services: 'AC repair, heating repair' }), ['Maintenance', 'Installation']);
  assert.deepEqual(suggestedServices({ trade: 'Unicorn grooming', services: '' }), []);
});
