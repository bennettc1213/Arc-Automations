/* ARC-015 — the execution-safety promises, each named after the promise it keeps.
 *
 * Every test here corresponds to a defect the repository audit and section 37 of the
 * execution-boundary ADR found in the shipped 0010 engine. They are separated from
 * `lead-recovery.test.js` because that file tests what the module *does* and this one
 * tests what it refuses to do when something has gone wrong underneath it: a lease
 * that expired, a provider that did not answer, an operator pressing a test button
 * while another client's customer is waiting for a text.
 *
 * The failure each one prevents is visible to somebody who is not our customer — a
 * homeowner texted twice, a deboarded contractor's customers still being messaged, a
 * client's dashboard counting a send that never happened.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  defaultConfig,
  validateLeadRecoveryConfig,
} from '../supabase/functions/_shared/lead-recovery-config.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { republish, seedPublishedConfig } from './config-fixtures.js';
import {
  authorizeLeadRecoveryEffect,
  canonicalJson,
  configHash,
  handleMessageStatus,
  intakeLead,
  loadPinnedConfig,
  runDueActions,
} from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender, TwilioRestSender } from '../supabase/functions/_shared/twilio.ts';

/* ── fixtures ───────────────────────────────────────────── */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ARC_NUMBER_A = '+16145550100';
const ARC_NUMBER_B = '+16145550200';
const CUSTOMER = '+16145559911';
const CUSTOMER_B = '+16145559922';
const SHOP = '+16145550137';

const NOW = new Date('2026-09-16T14:00:00.000Z');

function goodConfig(overrides = {}) {
  return {
    ...defaultConfig(),
    company_name: 'Halstead Heating',
    timezone: 'America/New_York',
    services: ['furnace repair', 'water heater'],
    service_area: { zips: ['43215'], cities: [], note: null },
    forwarding: { destination: SHOP, timeout_seconds: 20 },
    staff_alerts: [{ name: 'Dana', channel: 'sms', address: '+16145550188' }],
    compliance: {
      status: 'approved',
      brand_registered: true,
      campaign_ref: 'CMP123',
      reviewed_at: null,
      opt_out_language: 'Reply STOP to opt out.',
    },
    twilio: {
      subaccount_sid: null,
      messaging_service_sid: 'MG0123456789abcdef0123456789abcdef',
      phone_number: ARC_NUMBER_A,
      phone_number_sid: null,
    },
    ...overrides,
  };
}

function configure(store, { tenantId = TENANT_A, number = ARC_NUMBER_A, enabled = true, config } = {}) {
  const base = config ?? goodConfig();
  const validated = validateLeadRecoveryConfig({
    ...base,
    twilio: { ...base.twilio, phone_number: number },
  });
  assert.equal(validated.ok, true, 'the fixture config must be valid');
  seedPublishedConfig(store, { tenantId, config: validated.config, enabled });
  return store;
}

const setup = (options) => configure(new MemoryStore(), options);

let uuidCounter = 0;
function deps(store, options = {}) {
  const liveSender = options.liveSender ?? new RecordingSender();
  const canarySender = options.canarySender === undefined ? new RecordingSender() : options.canarySender;
  let clock = options.now ?? NOW;
  return {
    store,
    liveSender,
    canarySender,
    now: () => clock,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    classifierFor: () => ({
      classify: async () => ({ ok: false, reason: 'no classifier in this fixture' }),
    }),
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' },
    uuid: () => {
      uuidCounter += 1;
      return `bbbbbbbb-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
    },
    worker: 'test',
  };
}

const missedCall = (overrides = {}) => ({
  tenantId: TENANT_A,
  source: 'missed_call',
  externalRef: 'CA00000000000000000000000000000001',
  phone: CUSTOMER,
  customerName: 'Dana Reyes',
  intakeRef: ARC_NUMBER_A,
  consentSms: true,
  consentSource: 'inbound_call',
  ...overrides,
});

const claim = (store, over = {}) => store.claimActions({
  limit: 10,
  worker: 'w',
  nowIso: NOW.toISOString(),
  tenantId: null,
  ...over,
});

/* ══ 1. tenant-scoped claiming ════════════════════════════ */

describe('an operator testing one client cannot touch another client', () => {
  test("a tenant-scoped claim takes only that tenant's work", async () => {
    const store = setup();
    configure(store, { tenantId: TENANT_B, number: ARC_NUMBER_B });

    await intakeLead(deps(store), missedCall());
    await intakeLead(deps(store), missedCall({
      tenantId: TENANT_B,
      externalRef: 'CA00000000000000000000000000000002',
      phone: CUSTOMER_B,
      intakeRef: ARC_NUMBER_B,
    }));

    const claimed = await claim(store, { tenantId: TENANT_A });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].tenantId, TENANT_A);

    const other = store.actions.find((a) => a.tenantId === TENANT_B);
    assert.equal(other.status, 'pending', "tenant B's action is untouched");
    assert.equal(other.lockedBy, null);
  });

  test('a canary press leaves another tenant’s real customer waiting, not silently dropped', async () => {
    const store = setup();
    configure(store, { tenantId: TENANT_B, number: ARC_NUMBER_B });

    /* tenant B has a real customer with a first response due — and, so that tenant
       scoping is the *only* thing protecting them, a synthetic one as well. With just
       `canaryOnly` in place, tenant B's canary action would still be drained by
       tenant A's press. */
    await intakeLead(deps(store), missedCall({
      tenantId: TENANT_B,
      externalRef: 'CA00000000000000000000000000000009',
      phone: CUSTOMER_B,
      intakeRef: ARC_NUMBER_B,
    }));
    await intakeLead(deps(store), missedCall({
      tenantId: TENANT_B,
      externalRef: 'canary:tenant-b',
      phone: CUSTOMER_B,
      intakeRef: ARC_NUMBER_B,
      isCanary: true,
    }));

    /* tenant A runs a canary, the way the ops console does. */
    const canarySender = new RecordingSender();
    const d = deps(store, { canarySender });
    await intakeLead(d, missedCall({ externalRef: 'canary:1', isCanary: true }));
    const summary = await runDueActions(d, { tenantId: TENANT_A, canaryOnly: true, worker: 'ops-canary' });

    assert.equal(summary.claimed, 1, 'the canary claims exactly its own synthetic action');

    for (const victim of store.actions.filter((a) => a.tenantId === TENANT_B)) {
      assert.equal(victim.status, 'pending', "the other tenant's work is still queued");
      assert.equal(victim.attempts, 0, 'and has not burned an attempt');
    }

    /* the defect this replaces produced a successful, non-canary sms_sent for the
       other tenant. nothing at all should exist for them. */
    assert.equal(store.eventsOfType('sms_sent', TENANT_B).length, 0);
  });

  test('a canary claim ignores this tenant’s own real work too', async () => {
    const store = setup();
    const d = deps(store);
    await intakeLead(d, missedCall());              // real
    await intakeLead(d, missedCall({ externalRef: 'canary:2', isCanary: true }));

    const claimed = await claim(store, { tenantId: TENANT_A, canaryOnly: true });
    assert.equal(claimed.length, 1);

    const run = store.runs.find((r) => r.id === claimed[0].runId);
    const lead = store.leads.find((l) => l.id === run.leadId);
    assert.equal(lead.isCanary, true, 'only the synthetic lead was claimed');
  });
});

/* ══ 2. lease fencing ═════════════════════════════════════ */

describe('only the worker holding the lease may change an action', () => {
  test('a claim issues a unique lease token', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());

    const [first] = await claim(store, { worker: 'a' });
    assert.ok(first.leaseToken, 'a claim hands back a fence');
    assert.equal(first.fence, 1);

    /* the same worker name reclaiming later must not produce the same token — that is
       precisely why locked_by is not a fence. */
    const later = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const [again] = await claim(store, { worker: 'a', nowIso: later });
    assert.notEqual(again.leaseToken, first.leaseToken);
    assert.equal(again.fence, 2);
  });

  test('the lease holder can complete', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);

    const result = await store.completeAction(
      { actionId: action.id, tenantId: action.tenantId, leaseToken: action.leaseToken },
      'done', null, NOW.toISOString(),
    );
    assert.equal(result.ok, true);
    assert.equal(store.actions[0].status, 'done');
  });

  test('a stale worker cannot complete an action that was reclaimed', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());

    const [stale] = await claim(store, { worker: 'dead' });
    const later = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const [fresh] = await claim(store, { worker: 'live', nowIso: later });

    assert.notEqual(stale.leaseToken, fresh.leaseToken);

    const result = await store.completeAction(
      { actionId: stale.id, tenantId: stale.tenantId, leaseToken: stale.leaseToken },
      'done', null, later,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lost_lease');
    assert.equal(store.actions[0].status, 'claimed', 'the live worker still holds it');
  });

  test('a wrong-tenant completion changes nothing', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);

    const result = await store.completeAction(
      { actionId: action.id, tenantId: TENANT_B, leaseToken: action.leaseToken },
      'done', null, NOW.toISOString(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong_tenant');
    assert.equal(store.actions[0].status, 'claimed');
  });

  test('a wrong lease token cannot reschedule', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);

    const result = await store.rescheduleAction(
      { actionId: action.id, tenantId: action.tenantId, leaseToken: 'not-the-token' },
      NOW.toISOString(), 'nope',
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lost_lease');
  });

  test('a zero-row fenced write is a typed failure, never a silent success', async () => {
    const store = setup();
    const result = await store.completeAction(
      { actionId: 'aaaaaaaa-0000-4000-8000-000000000404', tenantId: TENANT_A, leaseToken: 'x' },
      'done', null, NOW.toISOString(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
  });

  test('an action at its attempt cap is not re-offered by an expired lease', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    store.actions[0].attempts = store.actions[0].maxAttempts;
    store.actions[0].status = 'claimed';
    store.actions[0].lockedAt = NOW.toISOString();

    const later = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const reoffered = await claim(store, { nowIso: later });
    assert.equal(reoffered.length, 0, 'a burnt-out action stays put for an operator');
  });
});

/* ══ 3. send-once ═════════════════════════════════════════ */

describe('the same message is never sent twice', () => {
  test('two workers cannot both reserve one effect', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);

    const base = {
      tenantId: TENANT_A,
      effectKey: 'lr:effect:one',
      effectType: 'customer_sms',
      idempotencyKey: 'lr:effect:one',
      actionId: action.id,
    };
    const first = await store.reserveEffect({ ...base, worker: 'a', leaseToken: 'lease-a' });
    const second = await store.reserveEffect({ ...base, worker: 'b', leaseToken: 'lease-b' });

    assert.equal(first.reserved, true);
    assert.equal(second.reserved, false, 'the second worker is refused');
    assert.equal(store.effects.length, 1, 'one logical effect is one row');
  });

  test('a lease race sends exactly one text', async () => {
    const store = setup();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());

    /* worker A claims and stalls. worker B takes the expired lease and runs. */
    await claim(store, { worker: 'a' });
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const dLater = deps(store, { liveSender: sender, now: later });
    await runDueActions(dLater, { tenantId: null, worker: 'b' });

    /* now worker A wakes up and tries to do the work it thought it had. */
    const summary = await runDueActions(d, { tenantId: null, worker: 'a' });

    assert.equal(sender.sent.length, 1, 'the customer is texted once, not twice');
    assert.equal(summary.claimed, 0, 'and there is nothing left for the stale worker to take');
  });

  test('an accepted effect blocks a second send', async () => {
    const store = setup();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 1);

    const effect = store.effects[0];
    assert.equal(effect.state, 'accepted');

    /* force the action back onto the queue the way an operator retry would, and prove
       the effect — not the action — is what stops the second send. */
    store.actions[0].status = 'pending';
    store.actions[0].attempts = 0;
    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 1, 'still once');
  });

  test('a confirmed effect blocks a second send', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);
    const base = {
      tenantId: TENANT_A,
      effectKey: 'lr:effect:confirmed',
      effectType: 'customer_sms',
      idempotencyKey: 'lr:effect:confirmed',
      actionId: action.id,
    };
    const first = await store.reserveEffect({ ...base, worker: 'a', leaseToken: 'lease-a' });
    await store.settleEffect({
      attemptId: first.attempt.id,
      tenantId: TENANT_A,
      leaseToken: 'lease-a',
      state: 'confirmed',
      nowIso: NOW.toISOString(),
    });

    const again = await store.reserveEffect({ ...base, worker: 'b', leaseToken: 'lease-b' });
    assert.equal(again.reserved, false);
  });

  test('a provably rejected effect may be retried, and reuses its identity', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);
    const base = {
      tenantId: TENANT_A,
      effectKey: 'lr:effect:rejected',
      effectType: 'customer_sms',
      idempotencyKey: 'lr:effect:rejected',
      actionId: action.id,
    };
    const first = await store.reserveEffect({ ...base, worker: 'a', leaseToken: 'lease-a' });
    await store.settleEffect({
      attemptId: first.attempt.id,
      tenantId: TENANT_A,
      leaseToken: 'lease-a',
      state: 'rejected',
      nowIso: NOW.toISOString(),
    });

    const retry = await store.reserveEffect({ ...base, worker: 'a', leaseToken: 'lease-c' });
    assert.equal(retry.reserved, true, 'the provider answered no, so trying again is safe');
    assert.equal(retry.attempt.attemptNo, 2);
    assert.equal(store.effects.length, 1, 'the retry reuses the same logical effect');
  });

  test('a terminal failure is never retried', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);
    const base = {
      tenantId: TENANT_A,
      effectKey: 'lr:effect:terminal',
      effectType: 'customer_sms',
      idempotencyKey: 'lr:effect:terminal',
      actionId: action.id,
    };
    const first = await store.reserveEffect({ ...base, worker: 'a', leaseToken: 'lease-a' });
    await store.settleEffect({
      attemptId: first.attempt.id,
      tenantId: TENANT_A,
      leaseToken: 'lease-a',
      state: 'failed_terminal',
      nowIso: NOW.toISOString(),
    });
    const again = await store.reserveEffect({ ...base, worker: 'a', leaseToken: 'lease-d' });
    assert.equal(again.reserved, false);
  });

  test('a staff alert is not sent twice either', async () => {
    const store = setup();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall({ serviceRequest: 'I smell gas in the basement' }));

    await runDueActions(d, { tenantId: null });   // open_handoff -> notifies staff
    const before = sender.sent.length;

    store.actions.forEach((a) => {
      if (a.actionType === 'open_handoff') { a.status = 'pending'; a.attempts = 0; }
    });
    await runDueActions(d, { tenantId: null });

    const staffSends = sender.sent.filter((m) => m.to === '+16145550188');
    assert.equal(staffSends.length, 1, 'the contractor is woken once');
    assert.ok(sender.sent.length >= before);
  });
});

/* ══ 4. ambiguous provider outcomes ═══════════════════════ */

describe('an unanswered provider is not a failure and is never retried blindly', () => {
  const timeoutSender = () => new RecordingSender({
    ok: false,
    sid: null,
    errorCode: null,
    errorMessage: 'no answer in 10s',
    permanent: false,
    ambiguous: true,
  });

  test('a timeout becomes reconciliation_required, not failed', async () => {
    const store = setup();
    const d = deps(store, { liveSender: timeoutSender() });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    assert.equal(store.effects.length, 1);
    assert.equal(store.effects[0].state, 'reconciliation_required');
    assert.equal(store.effects[0].retryable, false);
  });

  test('an ambiguous outcome is not retried automatically', async () => {
    const store = setup();
    const sender = timeoutSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 1);

    /* put it back on the queue as a retry would, and prove the effect refuses. */
    store.actions[0].status = 'pending';
    store.actions[0].attempts = 0;
    await runDueActions(d, { tenantId: null });

    assert.equal(sender.sent.length, 1, 'the provider is not called a second time');
  });

  test('an ambiguous outcome never counts as a send', async () => {
    const store = setup();
    const d = deps(store, { liveSender: timeoutSender() });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    assert.equal(store.eventsOfType('sms_sent', TENANT_A).length, 0,
      'the dashboard must not count a maybe');
  });

  test('an ambiguous outcome opens a task for a person', async () => {
    const store = setup();
    const d = deps(store, { liveSender: timeoutSender() });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    const open = store.handoffs.filter((h) => h.status === 'open');
    assert.equal(open.length, 1, 'somebody is told to check the provider');
    assert.ok(store.eventsOfType('automation_failed', TENANT_A).length >= 1);
  });

  test('an operator can see everything waiting on reconciliation', async () => {
    const store = setup();
    const d = deps(store, { liveSender: timeoutSender() });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    const open = await store.listOpenEffects(TENANT_A, 20);
    assert.equal(open.length, 1);
    assert.equal(open[0].state, 'reconciliation_required');
  });
});

/* ══ 4b. the adapter's own classification ═════════════════ */

describe('the provider adapter says whether it knows what happened', () => {
  /* these exercise TwilioRestSender itself rather than a recording double, because
     the ambiguous/not-ambiguous decision is made there — and getting it wrong is what
     turned a Twilio-accepted-but-slow send into a duplicate text. */
  const sender = (fetchImpl, timeoutMs = 10_000) =>
    new TwilioRestSender('ACtest', 'token', fetchImpl, timeoutMs);

  const args = { to: CUSTOMER, body: 'hello', from: ARC_NUMBER_A };

  test('a request that times out is ambiguous', async () => {
    const hang = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    const result = await sender(hang, 10).send(args);

    assert.equal(result.ok, false);
    assert.equal(result.ambiguous, true, 'no answer means we do not know');
    assert.match(result.errorMessage, /no answer/);
  });

  test('a network error before any response is ambiguous', async () => {
    const boom = () => Promise.reject(new Error('socket hang up'));
    const result = await sender(boom).send(args);
    assert.equal(result.ambiguous, true);
  });

  test('a provider refusal is not ambiguous', async () => {
    const refused = () => Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ code: 21610, message: 'unsubscribed' }),
    });
    const result = await sender(refused).send(args);

    assert.equal(result.ok, false);
    assert.equal(result.ambiguous, false, 'the provider answered, so it did not queue it');
    assert.equal(result.permanent, true);
  });

  test('a provider 500 is a clean failure, not an unknown one', async () => {
    const boom = () => Promise.resolve({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ message: 'unavailable' }),
    });
    const result = await sender(boom).send(args);
    assert.equal(result.ambiguous, false, 'it answered; it just said no');
    assert.equal(result.permanent, false, 'and trying again is safe');
  });

  test('an accepted send is not ambiguous', async () => {
    const ok = () => Promise.resolve({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ sid: 'SM123', status: 'queued' }),
    });
    const result = await sender(ok).send(args);
    assert.equal(result.ok, true);
    assert.equal(result.ambiguous, false);
    assert.equal(result.sid, 'SM123');
  });

  test('an adapter timeout reaches the engine as reconciliation, not retry', async () => {
    const store = setup();
    const hang = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const d = deps(store, { liveSender: sender(hang, 10) });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    assert.equal(store.effects[0].state, 'reconciliation_required');
    assert.equal(store.eventsOfType('sms_sent', TENANT_A).length, 0);
  });
});

/* ══ 5. configuration pinning ═════════════════════════════ */

describe('a run keeps the rules it began under', () => {
  test('a run stores an immutable, hashed snapshot', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());

    const run = store.runs[0];
    assert.ok(run.configSnapshotId, 'the run points at a snapshot');

    const snapshot = await store.getConfigSnapshot(TENANT_A, run.configSnapshotId);
    /* since 0014 the number is the published module version's, and the snapshot names
       both versions it was composed from. */
    const moduleVersion = store.moduleConfigVersions.find((v) => v.tenantId === TENANT_A);
    const tenantVersion = store.tenantConfigVersions.find((v) => v.tenantId === TENANT_A);
    assert.equal(snapshot.configVersion, moduleVersion.version, 'the version number is kept for forensics');
    assert.equal(snapshot.moduleConfigVersionId, moduleVersion.id);
    assert.equal(snapshot.tenantConfigVersionId, tenantVersion.id);
    assert.equal(snapshot.configHash.length, 64);
    assert.equal(snapshot.config.company_name, 'Halstead Heating');
  });

  test('the snapshot carries no credential', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const snapshot = store.snapshots[0];
    const text = JSON.stringify(snapshot.config);
    assert.ok(!/auth_token|api_key|"secret"|password|private_key/i.test(text));
  });

  test('editing the live configuration does not change a running sequence', async () => {
    const store = setup();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());

    /* the operator renames the company mid-sequence — a new published version. */
    await republish(store, TENANT_A, { company_name: 'Somebody Else Entirely' });

    const run = store.runs[0];
    const pinned = await loadPinnedConfig(store, run);
    assert.equal(pinned.ok, true);
    assert.equal(pinned.config.company_name, 'Halstead Heating',
      'the run still reads the rules it started under');
  });

  test('a new run picks up the new configuration', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());

    await republish(store, TENANT_A, { company_name: 'Halstead HVAC' });

    await intakeLead(deps(store), missedCall({ externalRef: 'CA2', phone: '+16145559933' }));

    const second = store.runs[1];
    const pinned = await loadPinnedConfig(store, second);
    assert.equal(pinned.config.company_name, 'Halstead HVAC');
    assert.equal(store.snapshots.length, 2, 'a changed configuration is a new snapshot');
  });

  test('identical configuration reuses one snapshot', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    await intakeLead(deps(store), missedCall({ externalRef: 'CA3', phone: '+16145559944' }));
    assert.equal(store.snapshots.length, 1, 'a thousand runs under one rule set is one row');
  });

  test('a legacy action with no snapshot can never be claimed', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());

    /* exactly what every pre-0011 run looks like. */
    store.runs[0].configSnapshotId = null;

    const claimed = await claim(store);
    assert.equal(claimed.length, 0, 'unprovable authorisation means it does not run');
  });

  test('a run whose snapshot is unreadable refuses rather than guessing', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const run = store.runs[0];
    const pinned = await loadPinnedConfig(store, { ...run, configSnapshotId: null });
    assert.equal(pinned.ok, false);
    assert.match(pinned.reason, /no configuration snapshot/);
  });

  test('the hash is stable regardless of key order', async () => {
    const a = await configHash({ b: 2, a: 1, nested: { y: 1, x: 2 } });
    const b = await configHash({ a: 1, nested: { x: 2, y: 1 }, b: 2 });
    assert.equal(a, b);
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  test('a snapshot cannot be read across tenants', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const found = await store.getConfigSnapshot(TENANT_B, store.snapshots[0].id);
    assert.equal(found, null);
  });
});

/* ══ 6. live state beats pinned configuration ═════════════ */

describe('current safety state overrides the rules a run began under', () => {
  async function pending(options = {}) {
    const store = setup();
    const sender = options.sender ?? new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    return { store, sender, d };
  }

  test('an archived client stops sending', async () => {
    const { store, sender, d } = await pending();
    store.tenants.push({ id: TENANT_A, status: 'archived' });

    const summary = await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0, 'a deboarded client texts nobody');
    assert.equal(summary.cancelled, 1);
  });

  test('a paused client stops sending', async () => {
    const { store, sender, d } = await pending();
    store.tenants.push({ id: TENANT_A, status: 'paused' });

    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0);
  });

  test('a suppression added after queueing stops the send', async () => {
    const { store, sender, d } = await pending();
    await store.addSuppression({
      tenantId: TENANT_A, channel: 'sms', address: CUSTOMER,
      reason: 'opt_out', source: 'customer', createdAt: NOW.toISOString(), expiresAt: null,
    });

    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0);
  });

  test('a reply before the first response stops it', async () => {
    const { store, sender, d } = await pending();
    const conversation = store.conversations[0];
    conversation.lastInboundAt = NOW.toISOString();

    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0, 'somebody who already texted in is not autoresponded to');
  });

  test('an open handoff stops the send', async () => {
    const { store, sender, d } = await pending();
    await store.openHandoff({
      tenantId: TENANT_A, leadId: store.leads[0].id, runId: store.runs[0].id,
      reason: 'a person has this', reasonCode: 'other', isSafety: false,
      assignedTo: null, openedAt: NOW.toISOString(),
    });

    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0);
  });

  test('withdrawn consent stops the send even though the run was authorised with it', async () => {
    const { store, sender, d } = await pending();
    const [action] = await claim(store, { tenantId: TENANT_A });
    store.leads[0].consentSms = false;

    const result = await authorizeLeadRecoveryEffect(d, {
      action,
      run: store.runs[0],
      lead: store.leads[0],
      config: (await loadPinnedConfig(store, store.runs[0])).config,
      effectType: 'customer_sms',
      effectKey: 'lr:effect:consent',
      destination: CUSTOMER,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.denial, 'no_consent');
    assert.equal(sender.sent.length, 0);
  });

  test('authorisation denials never reserve an effect', async () => {
    const { store, d } = await pending();
    const [action] = await claim(store, { tenantId: TENANT_A });
    store.tenants.push({ id: TENANT_A, status: 'archived' });

    const result = await authorizeLeadRecoveryEffect(d, {
      action,
      run: store.runs[0],
      lead: store.leads[0],
      config: (await loadPinnedConfig(store, store.runs[0])).config,
      effectType: 'customer_sms',
      effectKey: 'lr:effect:archived',
      destination: CUSTOMER,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.denial, 'tenant_archived');
    assert.equal(store.effects.length, 0, 'a refused send leaves no reservation behind');
  });

  test('an unleased action is refused outright', async () => {
    const { store, d } = await pending();
    const action = store.actions[0];   // never claimed, so no lease

    const result = await authorizeLeadRecoveryEffect(d, {
      action,
      run: store.runs[0],
      lead: store.leads[0],
      config: (await loadPinnedConfig(store, store.runs[0])).config,
      effectType: 'customer_sms',
      effectKey: 'lr:effect:unleased',
      destination: CUSTOMER,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.denial, 'no_lease');
  });
});

/* ══ 7. provider results ══════════════════════════════════ */

describe('a provider result is recorded once and cannot be forged', () => {
  async function sent() {
    const store = setup();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });
    return { store, d, sid: store.effects[0].providerMessageId };
  }

  test('acceptance and delivery are different facts', async () => {
    const { store, d, sid } = await sent();
    assert.equal(store.effects[0].state, 'accepted', 'the provider took it');

    await handleMessageStatus(d, {
      tenantId: TENANT_A, providerMessageId: sid, status: 'delivered', occurredAt: NOW,
    });
    assert.equal(store.effects[0].state, 'confirmed', 'and then it arrived');
  });

  test('a duplicate delivery callback is a no-op', async () => {
    const { store, d, sid } = await sent();
    await handleMessageStatus(d, { tenantId: TENANT_A, providerMessageId: sid, status: 'delivered', occurredAt: NOW });
    await handleMessageStatus(d, { tenantId: TENANT_A, providerMessageId: sid, status: 'delivered', occurredAt: NOW });

    assert.equal(store.eventsOfType('message_delivered', TENANT_A).length, 1);
    assert.equal(store.effects[0].state, 'confirmed');
  });

  test('a wrong-tenant callback moves nothing', async () => {
    const { store, sid } = await sent();
    const result = await store.recordEffectDelivery({
      tenantId: TENANT_B, providerMessageId: sid, state: 'confirmed', nowIso: NOW.toISOString(),
    });
    assert.equal(result.ok, false);
    assert.equal(store.effects[0].state, 'accepted');
  });

  test('an unknown provider reference is refused', async () => {
    const { store } = await sent();
    const result = await store.recordEffectDelivery({
      tenantId: TENANT_A, providerMessageId: 'SMnot-a-real-sid', state: 'confirmed', nowIso: NOW.toISOString(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
  });

  test('a late failure cannot reopen a rejected attempt', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);
    const reserved = await store.reserveEffect({
      tenantId: TENANT_A, effectKey: 'lr:effect:late', effectType: 'customer_sms',
      idempotencyKey: 'lr:effect:late', worker: 'a', leaseToken: 'lease-a', actionId: action.id,
    });
    await store.settleEffect({
      attemptId: reserved.attempt.id, tenantId: TENANT_A, leaseToken: 'lease-a',
      state: 'rejected', providerMessageId: 'SMlate', nowIso: NOW.toISOString(),
    });

    const result = await store.recordEffectDelivery({
      tenantId: TENANT_A, providerMessageId: 'SMlate', state: 'confirmed', nowIso: NOW.toISOString(),
    });
    assert.equal(result.ok, false, 'a message the provider refused cannot later be "delivered"');
  });

  test('settling under the wrong lease is refused', async () => {
    const store = setup();
    await intakeLead(deps(store), missedCall());
    const [action] = await claim(store);
    const reserved = await store.reserveEffect({
      tenantId: TENANT_A, effectKey: 'lr:effect:fence', effectType: 'customer_sms',
      idempotencyKey: 'lr:effect:fence', worker: 'a', leaseToken: 'lease-a', actionId: action.id,
    });
    const result = await store.settleEffect({
      attemptId: reserved.attempt.id, tenantId: TENANT_A, leaseToken: 'lease-somebody-else',
      state: 'accepted', nowIso: NOW.toISOString(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lost_lease');
  });
});

/* ══ 8. evidence ══════════════════════════════════════════ */

describe('the log records what happened, not what was intended', () => {
  test('one send is one sms_sent however many attempts it took', async () => {
    const store = setup();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());

    store.actions[0].attempts = 3;      // as if it had already been retried
    await runDueActions(d, { tenantId: null });

    assert.equal(store.eventsOfType('sms_sent', TENANT_A).length, 1,
      'the event key is the effect, not the attempt');
  });

  test('no sms_sent is written for a message the provider refused', async () => {
    const store = setup();
    const sender = new RecordingSender({
      ok: false, sid: null, errorCode: '21610', errorMessage: 'unsubscribed',
      permanent: true, ambiguous: false,
    });
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    assert.equal(store.eventsOfType('sms_sent', TENANT_A).length, 0);
  });

  test('a canary never writes a non-canary send', async () => {
    const store = setup();
    const canarySender = new RecordingSender();
    const d = deps(store, { canarySender });
    await intakeLead(d, missedCall({ externalRef: 'canary:evidence', isCanary: true }));
    await runDueActions(d, { tenantId: TENANT_A, canaryOnly: true });

    for (const e of store.eventsOfType('sms_sent', TENANT_A)) {
      assert.equal(e.event.is_canary, true, 'a synthetic send is always marked synthetic');
    }
  });

  test('every effect attempt records a masked destination, never a full number', async () => {
    const store = setup();
    const d = deps(store);
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    for (const effect of store.effects) {
      assert.ok(effect.destinationRef);
      assert.ok(!effect.destinationRef.includes('5559911'), 'the full number is not duplicated here');
    }
  });
});

/* ══ 9. the migration ═════════════════════════════════════ */

describe('0011 says in SQL what the engine says in TypeScript', () => {
  const sql = readFileSync(
    new URL('../supabase/migrations/0011_lead_recovery_safety.sql', import.meta.url),
    'utf8',
  );

  test('the unscoped global claim is gone', () => {
    assert.match(sql, /drop function if exists public\.claim_scheduled_actions\(integer, text, integer\)/);
  });

  test('a tenant-scoped claim refuses a null tenant', () => {
    assert.match(sql, /claim_tenant_scheduled_actions requires an explicit tenant/);
  });

  test('completion is fenced on tenant and lease', () => {
    const fn = sql.slice(sql.indexOf('function public.complete_scheduled_action'));
    assert.match(fn, /and tenant_id = p_tenant/);
    assert.match(fn, /and lease_token = p_lease/);
  });

  test('one logical effect is one row', () => {
    assert.match(sql, /unique \(tenant_id, effect_key\)/);
  });

  test('snapshots are append-only', () => {
    assert.match(sql, /before update or delete on public\.lead_recovery_config_snapshots/);
  });

  test('worker functions are revoked from browser roles', () => {
    for (const fn of [
      'claim_scheduled_actions_global',
      'claim_tenant_scheduled_actions',
      'complete_scheduled_action',
      'reserve_lead_recovery_effect',
      'settle_lead_recovery_effect',
    ]) {
      const pattern = new RegExp(`revoke all on function public\\.${fn}[^;]*from public, anon, authenticated`);
      assert.match(sql, pattern, `${fn} must not be callable from a browser`);
    }
  });

  test('legacy pending actions are blocked rather than guessed at', () => {
    assert.match(sql, /set status = 'blocked'/);
    assert.match(sql, /config_snapshot_id is null/);
  });

  test('a claim never offers a run that cannot prove its configuration', () => {
    const fn = sql.slice(sql.indexOf('function public.claim_actions_internal'));
    assert.match(fn, /r\.config_snapshot_id is not null/);
    assert.match(fn, /a\.attempts < a\.max_attempts/);
  });

  test('neither new table is client-readable', () => {
    assert.ok(!/lead_recovery_effect_attempts[\s\S]{0,200}is_tenant_member/.test(sql));
    assert.match(sql, /lead_recovery_effect_attempts_admin_read[\s\S]{0,200}is_arc_admin/);
  });
});
