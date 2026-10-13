/* the owner's portal reads readiness, it does not decide it (ARC SaaS foundation, 0033).
 *
 * `self_service_readiness` answers in SQL (tests/saas-operations-db.test.js). These hold the
 * other half: the portal turns those answers into connection states and sentences, and with
 * no answer it shows nothing as ready.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { productionState, READINESS_CHECKS } from '../src/portal/product/production.js';
import { accountReadinessItems, usageWarning } from '../src/portal/product/guide.js';

const tenant = { id: 'tenant-a', name: 'Fictional Glassworks', timezone: 'America/Denver' };
const answers = (overrides = {}) => ({
  available: true,
  ...Object.fromEntries(READINESS_CHECKS.map((key) => [key, { ok: true, code: 'done' }])),
  ...overrides,
});
const state = (readiness, form = { available: true, public_key: 'arcw_x', last_used_at: '2026-10-01T00:00:00Z', module_state: 'active', module_health: 'healthy' }) =>
  productionState({ tenant, generatedFor: '2026-10-13T00:00:00Z', threads: [], product: { available: true, form, readiness } });
const connection = (s, id) => s.connections.find((c) => c.id === id);

describe('readiness in the owner portal', () => {
  test('setup is complete only when every check is true', () => {
    assert.equal(state(answers()).setupComplete, true);
    for (const key of READINESS_CHECKS) {
      assert.equal(state(answers({ [key]: { ok: false, code: 'x' } })).setupComplete, false, key);
    }
  });

  test('with no answer nothing is ready, and an active module alone is not a connection', () => {
    for (const readiness of [undefined, { available: false, error: 'function not found' }]) {
      const s = state(readiness);
      assert.equal(s.setupComplete, false);
      assert.equal(s.readiness, null);
      assert.deepEqual(accountReadinessItems(s), []);
      assert.notEqual(connection(s, 'messaging').state, 'connected');
      assert.notEqual(connection(s, 'phone').state, 'connected');
      assert.equal(Boolean(connection(s, 'phone').routingTested), false);
    }
    assert.equal(state({ available: false, error: 'function not found' }).readinessError, 'function not found');
  });

  test('texting is connected only with an approved number and a passed test; the phone only with a tested line', () => {
    assert.equal(connection(state(answers()), 'messaging').state, 'connected');
    assert.equal(connection(state(answers({ test: { ok: false, code: 'not_run' } })), 'messaging').state, 'in_progress');
    assert.notEqual(connection(state(answers({ sender: { ok: false, code: 'pending_review' } })), 'messaging').state, 'connected');

    const tested = connection(state(answers()), 'phone');
    assert.deepEqual([tested.state, tested.routingTested], ['connected', true]);
    const untested = connection(state(answers({ routing: { ok: false, code: 'not_tested' } })), 'phone');
    assert.notEqual(untested.state, 'connected');
    assert.equal(untested.routingTested, false);
  });

  test('the owner’s own pause shows as not sending, in their words, even with every check passed', () => {
    const product = (sending) => productionState({ tenant, generatedFor: '2026-10-13T00:00:00Z', threads: [],
      product: { available: true, form: { available: true, module_state: 'active' }, readiness: answers(), sending } });
    const paused = product({ available: true, paused: true, changedAt: '2026-10-12T15:00:00Z' });
    assert.equal(paused.setupComplete, false);
    assert.deepEqual(paused.readiness.active, { ok: false, code: 'paused_by_owner' });
    assert.match(accountReadinessItems(paused).find((item) => item.id === 'account-active').detail, /You paused your texts/);
    assert.equal(paused.sending.paused, true);

    assert.equal(product({ available: true, paused: false, changedAt: null }).setupComplete, true);
    /* where the switch does not exist the page is given none, so it draws no button. */
    const absent = product({ available: false });
    assert.deepEqual([absent.sending, absent.setupComplete], [null, true]);
    assert.equal(product(undefined).sending, null);
  });

  test('a health problem outranks every passed check', () => {
    const s = state(answers(), { available: true, public_key: 'arcw_x', last_used_at: null, module_state: 'active', module_health: 'failing' });
    assert.equal(connection(s, 'messaging').state, 'needs_attention');
    assert.equal(connection(s, 'phone').state, 'needs_attention');
  });

  test('each answer is one plain line, and an unknown code is never shown as done', () => {
    const all = accountReadinessItems(state(answers()));
    assert.equal(all.length, READINESS_CHECKS.length);
    assert.ok(all.every((item) => item.done && item.detail === ''));

    const s = state(answers({
      subscription: { ok: false, code: 'past_due' },
      active: { ok: false, code: 'sending_stopped' },
      sender: { ok: false, code: 'a_code_added_later' },
    }));
    const by = Object.fromEntries(accountReadinessItems(s).map((item) => [item.id, item]));
    assert.match(by['account-subscription'].detail, /payment is overdue/);
    assert.equal(by['account-subscription'].to, 'billing');
    assert.match(by['account-active'].detail, /paused texting for every business/);
    assert.deepEqual([by['account-sender'].done, by['account-sender'].detail], [false, 'ARC is checking this.']);
    /* what ARC does for the owner has no button: there is nothing for them to press. */
    assert.equal(by['account-sender'].to, undefined);
    /* the owner is never shown the machine's words for it. */
    const words = JSON.stringify(accountReadinessItems(s));
    assert.doesNotMatch(words, /lifecycle|module|tenant|n8n|twilio|webhook|canary|10dlc/i);
  });
});

describe('the usage warning', () => {
  test('nothing below four fifths, a warning from there, and a plain stop at the cap', () => {
    assert.equal(usageWarning(0, 500), null);
    assert.equal(usageWarning(399, 500), null);
    assert.equal(usageWarning(400, 500).level, 'near');
    assert.equal(usageWarning(500, 500).level, 'at');
    assert.equal(usageWarning(620, 500).level, 'at');
    assert.match(usageWarning(500, 500).text, /New inquiries still arrive/);
  });

  test('an unknown count warns of nothing rather than of zero', () => {
    assert.equal(usageWarning(null, 500), null);
    assert.equal(usageWarning(3, null), null);
    assert.equal(usageWarning(3, 0), null);
  });
});
