/* ARC-120 — the tenant module lifecycle: its state machine, what a published change does
 * to it, just-in-time execution authorisation, and shadow mode's promise to touch nobody.
 *
 * Against `MemoryStore`, which enforces what 0015 enforces (named after each object in
 * `_shared/lifecycle/memory.ts`); `tests/lifecycle-db.test.js` holds the same promises
 * against real Postgres. Every test is named after the promise it keeps.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import {
  authorizeLeadRecoveryEffect,
  handleInboundMessage,
  intakeLead,
  loadPinnedConfig,
  runDueActions,
  takeOverLead,
} from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { publishEffectiveConfig, listHistory, rollbackConfig } from '../supabase/functions/_shared/config/engine.ts';
import { moduleScope, TENANT_SCOPE } from '../supabase/functions/_shared/config/model.ts';
import {
  activateModule,
  beginTesting,
  deselectModule,
  effectiveStatus,
  enterShadow,
  exitShadow,
  getLifecycleStatus,
  pauseModule,
  recordShadowReview,
  recordTestResult,
  reportHealth,
  resumeModule,
  selectModule,
  stopTesting,
} from '../supabase/functions/_shared/lifecycle/engine.ts';
import { authorizeModuleExecution } from '../supabase/functions/_shared/lifecycle/authorize.ts';
import { reconcileConfigChange } from '../supabase/functions/_shared/lifecycle/impact.ts';
import {
  EXECUTION_DENIAL_CODES,
  expandedTransitionRules,
  legalDestination,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  LifecycleStoreError,
  operatorTransitionsFrom,
  TRANSITION_KEYS,
} from '../supabase/functions/_shared/lifecycle/model.ts';
import {
  CHANGE_IMPACT_POLICY,
  classifyRecordedImpact,
  combineConsequences,
  HEALTH_POLICY,
  healthPermits,
  IMPACT_CLASSIFICATIONS,
} from '../supabase/functions/_shared/lifecycle/policy.ts';
import { getField, LEAD_RECOVERY_SCHEMA, TENANT_SETTINGS_SCHEMA } from '../supabase/functions/_shared/registry/schemas.ts';
import { FIXTURE_OPERATOR, leadRecoveryConfig, ONBOARDED_STEPS, seedLifecycle, seedPublishedConfig } from './config-fixtures.js';

const SQL = readFileSync(new URL('../supabase/migrations/0015_tenant_module_lifecycle.sql', import.meta.url), 'utf8');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const LR = 'lead_recovery';
const OPERATOR = { type: 'operator', id: FIXTURE_OPERATOR };
const STRANGER = { type: 'operator', id: 'ffffffff-0000-4000-8000-00000000000f' };
const CUSTOMER = '+16145559911';
const NOW = new Date('2026-09-16T14:00:00.000Z'); // a Wednesday, 10:00 in New York — open

/* ── fixtures ───────────────────────────────────────────── */

let counter = 0;
const next = () => (counter += 1);

function deps(store, { live = new RecordingSender(), canary = new RecordingSender(), now = NOW } = {}) {
  return {
    store,
    liveSender: live,
    canarySender: canary,
    now: () => now,
    classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'no classifier here' }) }),
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' },
    uuid: () => crypto.randomUUID(),
    worker: 'test',
  };
}

const missedCall = (overrides = {}) => ({
  tenantId: TENANT_A,
  source: 'missed_call',
  externalRef: `CA${String(next()).padStart(32, '0')}`,
  phone: CUSTOMER,
  customerName: 'Dana Reyes',
  intakeRef: '+16145550100',
  consentSms: true,
  consentSource: 'inbound_call',
  ...overrides,
});

const canaryLead = (overrides = {}) => missedCall({
  source: 'web_form', externalRef: `canary:${next()}`, phone: '+15005550006', customerName: 'Arc canary',
  serviceRequest: 'no heat upstairs', intakeRef: 'arc-canary', consentSource: 'operator', isCanary: true, ...overrides,
});

/** Published configuration, and no lifecycle: the module is unselected. */
function published(store = new MemoryStore(), tenantId = TENANT_A, config = leadRecoveryConfig()) {
  seedPublishedConfig(store, { tenantId, config, lifecycle: false });
  return store;
}

const at = async (store, tenantId = TENANT_A) => (await store.getLifecycle(tenantId, LR))?.stateVersion ?? 0;
const req = async (store, extra = {}) => ({ tenantId: TENANT_A, moduleKey: LR, actor: OPERATOR, expectedStateVersion: await at(store, extra.tenantId ?? TENANT_A), ...extra });

function onboard(store, tenantId = TENANT_A, steps = ONBOARDED_STEPS) {
  for (const stepKey of steps) {
    if (!store.onboardingSteps.some((s) => s.tenantId === tenantId && s.stepKey === stepKey)) {
      store.onboardingSteps.push({ tenantId, moduleKey: LR, stepKey, doneAt: NOW.toISOString() });
    }
  }
}

function must(result, what = 'operation') {
  assert.equal(result.ok, true, result.ok ? '' : `${what}: ${result.code} — ${result.message} ${JSON.stringify(result.blockers ?? [])}`);
  return result.result;
}

/** A synthetic canary through the whole engine; returns its run. */
async function canaryRun(store, tenantId = TENANT_A) {
  const d = deps(store);
  const intake = await intakeLead(d, canaryLead({ tenantId }));
  await runDueActions(d, { tenantId, canaryOnly: true, worker: 'canary', limit: 10 });
  return { intake, run: intake.run ? await store.getRun(tenantId, intake.run.id) : null, sender: d.canarySender };
}

/** Selected, onboarded and under test. */
async function underTest(store) {
  must(await selectModule(store, await req(store)), 'select');
  onboard(store);
  must(await beginTesting(store, await req(store)), 'begin testing');
  return store;
}

/** A passing test of the current versions, recorded. */
async function passTest(store) {
  const { run } = await canaryRun(store);
  assert.equal(run.state, 'awaiting_reply', 'the canary went end to end');
  return must(await recordTestResult(store, { ...(await req(store)), runId: run.id, passed: true }), 'record test');
}

/** The whole operator path to live, through the service. */
async function live(store = published()) {
  await underTest(store);
  await passTest(store);
  must(await activateModule(store, await req(store)), 'activate');
  return store;
}

/** Publish an edit through the real engine — and so through the lifecycle hook. */
async function publish(store, patch, tenantId = TENANT_A) {
  const [tenant, module] = await Promise.all([store.getConfigHead(tenantId, TENANT_SCOPE), store.getConfigHead(tenantId, moduleScope(LR))]);
  const current = { ...module.config, ...tenant.config };
  const result = await publishEffectiveConfig(store, {
    tenantId, moduleKey: LR, config: { ...current, ...patch },
    expected: { tenant: tenant.version, module: module.version }, actor: { kind: 'operator', userId: FIXTURE_OPERATOR },
  });
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  return result;
}

const lifecycleOf = (store, tenantId = TENANT_A) => store.lifecycles.find((l) => l.tenantId === tenantId && l.moduleKey === LR);

/* `live()` and `underTest()` run a canary first, so position is never identity: the real
   run, lead and actions are picked out by what they are. */
const realRun = (store) => store.runs.find((r) => r.runMode !== 'test');
const realLead = (store) => store.leads.find((l) => !l.isCanary);
const actionsOf = (store, run) => store.actions.filter((a) => a.runId === run.id);
const realActions = (store) => store.actions.filter((a) => store.runs.some((r) => r.id === a.runId && r.runMode !== 'test'));
const realEffects = (store) => store.effects.filter((e) => !e.isCanary);
const realEvents = (store) => store.events.filter((e) => e.event.is_canary !== true);

async function heads(store, tenantId = TENANT_A) {
  const [t, m] = await Promise.all([store.getConfigHead(tenantId, TENANT_SCOPE), store.getConfigHead(tenantId, moduleScope(LR))]);
  return { tenantVersionId: t.id, moduleVersionId: m.id };
}

/* ══ 1. one policy ════════════════════════════════════════ */

describe('there is one legal-transition policy, and the database holds the same one', () => {
  test('every transition key has exactly one rule, and every (transition, from) lands in one place', () => {
    assert.deepEqual(LIFECYCLE_TRANSITIONS.map((r) => r.transition).sort(), [...TRANSITION_KEYS].sort());
    const seen = new Map();
    for (const row of expandedTransitionRules()) {
      const key = `${row.transition}|${row.from}`;
      if (seen.has(key)) assert.equal(seen.get(key), row.to, `${key} lands in two places`);
      seen.set(key, row.to);
    }
  });

  test('0015 seeds exactly the typed rules — the build fails on drift', () => {
    const block = SQL.slice(SQL.indexOf('insert into public.lifecycle_transition_rules'), SQL.indexOf('on conflict (transition, from_state, actor_type) do nothing'));
    const sqlRows = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)'\)/g)]
      .map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}`).sort();
    const codeRows = expandedTransitionRules().map((r) => `${r.transition}|${r.from}|${r.to}|${r.actor}`).sort();
    assert.deepEqual(sqlRows, codeRows);
  });

  test('no transition takes a module to active except an operator activation or resumption', () => {
    const intoActive = expandedTransitionRules().filter((r) => r.to === 'active' && r.from !== 'active');
    assert.deepEqual(intoActive.map((r) => `${r.transition}:${r.actor}`).sort(), ['activate:operator', 'activate:operator', 'resume:operator']);
  });

  test('the system can pause, evaluate and report — never select, activate or resume', () => {
    const system = new Set(expandedTransitionRules().filter((r) => r.actor === 'system' && !['backfill_selected', 'backfill_paused'].includes(r.transition)).map((r) => r.transition));
    assert.deepEqual([...system].sort(), ['apply_config_change', 'report_health', 'system_pause']);
  });

  test('a console is offered exactly the operator transitions legal from where it is', () => {
    assert.deepEqual(operatorTransitionsFrom('active').sort(), ['deselect', 'pause', 'record_test', 'report_health']);
    assert.deepEqual(operatorTransitionsFrom('unselected'), ['select']);
  });
});

/* ══ 2. the state machine ═════════════════════════════════ */

describe('every transition the matrix allows is allowed, and every other one is refused', () => {
  const operatorRules = expandedTransitionRules().filter((r) => !['backfill_selected', 'backfill_paused'].includes(r.transition));

  for (const from of LIFECYCLE_STATES) {
    for (const transition of TRANSITION_KEYS.filter((t) => !t.startsWith('backfill'))) {
      const allowed = operatorRules.filter((r) => r.transition === transition && r.from === from);
      const actor = allowed[0]?.actor ?? 'operator';
      test(`${transition} from ${from}: ${allowed.length ? `→ ${allowed[0].to}` : 'refused'}`, () => {
        const decision = legalDestination(transition, from, actor);
        if (allowed.length) {
          assert.equal(decision.ok, true);
          assert.equal(decision.to, allowed[0].to);
        } else {
          assert.equal(decision.ok, false);
          assert.equal(decision.code, 'illegal_transition');
        }
      });
    }
  }

  test('the store refuses an illegal transition and changes nothing', async () => {
    const store = await live();
    const before = structuredClone(lifecycleOf(store));
    await assert.rejects(
      store.applyLifecycleTransition({
        tenantId: TENANT_A, moduleKey: LR, transition: 'begin_testing', expectedStateVersion: before.stateVersion,
        actor: OPERATOR, reasonCode: 'test', reason: null, idempotencyKey: 'illegal-1', change: { pendingRequirements: [] },
      }),
      (error) => error instanceof LifecycleStoreError && error.code === 'illegal_transition',
    );
    assert.deepEqual(lifecycleOf(store), before);
  });

  test('a system actor cannot activate, and an operator cannot author a system pause', async () => {
    const store = await live();
    const lc = lifecycleOf(store);
    await assert.rejects(
      store.applyLifecycleTransition({
        tenantId: TENANT_A, moduleKey: LR, transition: 'system_pause', expectedStateVersion: lc.stateVersion,
        actor: OPERATOR, reasonCode: 'test', reason: null, idempotencyKey: 'sp-1', change: { pendingRequirements: [] },
      }),
      (error) => error.code === 'forbidden',
    );
    must(await pauseModule(store, await req(store)));
    await assert.rejects(
      store.applyLifecycleTransition({
        tenantId: TENANT_A, moduleKey: LR, transition: 'resume', expectedStateVersion: lifecycleOf(store).stateVersion,
        actor: { type: 'system', id: null }, reasonCode: 'test', reason: null, idempotencyKey: 'sys-resume',
        change: { pendingRequirements: [], authorized: await heads(store) },
      }),
      (error) => error.code === 'forbidden',
    );
  });
});

describe('selection is explicit, audited, and the gate to everything else', () => {
  test('an unselected module cannot test, shadow, activate or execute', async () => {
    const store = published();
    assert.equal((await beginTesting(store, await req(store))).code, 'illegal_transition');
    assert.equal((await activateModule(store, await req(store))).code, 'illegal_transition');
    assert.equal((await enterShadow(store, await req(store))).code, 'illegal_transition');
    assert.equal((await pauseModule(store, await req(store))).code, 'illegal_transition');

    const sender = new RecordingSender();
    const result = await intakeLead(deps(store, { live: sender, canary: sender }), missedCall());
    assert.equal(result.ok, false);
    assert.equal(store.runs.length, 0);
    const canary = await intakeLead(deps(store, { live: sender, canary: sender }), canaryLead());
    assert.equal(canary.run, null, 'not even a synthetic test runs on an unselected module');
    assert.equal(sender.sent.length, 0);
  });

  test('selecting records who, when and why, and starts configuring with the current versions as its baseline', async () => {
    const store = published();
    const result = must(await selectModule(store, { ...(await req(store)), reason: 'client bought lead recovery' }));
    assert.equal(result.lifecycle.state, 'configuring');
    assert.deepEqual(result.lifecycle.observed, await heads(store));
    assert.equal(result.transition.actorId, FIXTURE_OPERATOR);
    assert.equal(result.transition.reason, 'client bought lead recovery');
    assert.equal(store.adminActions.at(-1).action, 'module.select');
    assert.equal(store.configs.find((c) => c.tenantId === TENANT_A).enabled, false, 'the switch exists, off');
  });

  test('a planned module cannot be selected', async () => {
    const store = published();
    const result = await selectModule(store, { ...(await req(store)), moduleKey: 'estimate_recovery' });
    assert.equal(result.code, 'module_unavailable');
  });

  test('an archived client cannot have anything selected', async () => {
    const store = published();
    store.tenants.push({ id: TENANT_A, status: 'archived' });
    assert.equal((await selectModule(store, await req(store))).code, 'tenant_inactive');
  });
});

describe('testing: readiness to enter, and evidence bound to the exact versions tested', () => {
  test('testing cannot begin without a published, valid configuration', async () => {
    const store = new MemoryStore();
    store.operators.push(FIXTURE_OPERATOR);
    must(await selectModule(store, await req(store)));
    const result = await beginTesting(store, await req(store));
    assert.equal(result.code, 'config_not_ready');
    assert.equal(lifecycleOf(store).state, 'configuring');
  });

  test('a passing canary is accepted as evidence for exactly the versions its run was pinned to', async () => {
    const store = await underTest(published());
    const result = await passTest(store);
    const snapshot = store.snapshots.find((s) => s.id === store.runs[0].configSnapshotId);
    assert.deepEqual(result.lifecycle.tested, { tenantVersionId: snapshot.tenantConfigVersionId, moduleVersionId: snapshot.moduleConfigVersionId });
    assert.equal(result.evidence.kind, 'test');
    assert.equal(result.evidence.simulated, true);
    assert.equal(result.lifecycle.testEvidenceId, result.evidence.id);
    assert.ok(result.evidence.capabilities.includes('send_sms'), 'the connector context it was judged against');
  });

  test('a failed test is recorded and authorises nothing', async () => {
    const store = await underTest(published());
    const { run } = await canaryRun(store);
    const result = must(await recordTestResult(store, { ...(await req(store)), runId: run.id, passed: false }));
    assert.equal(result.evidence.outcome, 'failed');
    assert.equal(result.lifecycle.testEvidenceId, null);
    const refused = await activateModule(store, await req(store));
    assert.equal(refused.code, 'test_evidence_missing');
    assert.equal(lifecycleOf(store).state, 'testing');
  });

  test('a real run is not evidence of a test, and a run cannot be claimed for another module', async () => {
    const store = await live();
    await intakeLead(deps(store), missedCall());
    const real = store.runs.find((r) => r.runMode === 'live');
    const result = await recordTestResult(store, { ...(await req(store)), runId: real.id, passed: true });
    assert.equal(result.code, 'evidence_invalid');
  });

  test('a test of old versions does not satisfy a newer configuration', async () => {
    const store = await underTest(published());
    const { run } = await canaryRun(store);
    await publish(store, { services: ['furnace repair'] });
    const result = must(await recordTestResult(store, { ...(await req(store)), runId: run.id, passed: true }));
    assert.equal(result.lifecycle.testEvidenceId, null, 'evidence for the old versions is kept, and not accepted');
    const refused = await activateModule(store, await req(store));
    assert.equal(refused.code, 'test_evidence_missing');
  });

  test('stopping testing returns to configuring and keeps the evidence', async () => {
    const store = await underTest(published());
    await passTest(store);
    const result = must(await stopTesting(store, await req(store)));
    assert.equal(result.lifecycle.state, 'configuring');
    assert.equal(store.lifecycleEvidence.length, 1);
  });
});

describe('activation is explicit, authorised and gated on everything at once', () => {
  test('activation authorises exactly the current versions, turns the switch on, and is audited', async () => {
    const store = await live();
    const lc = lifecycleOf(store);
    assert.equal(lc.state, 'active');
    assert.deepEqual(lc.authorized, await heads(store));
    assert.equal(store.configs.find((c) => c.tenantId === TENANT_A).enabled, true);
    assert.equal(store.adminActions.filter((a) => a.action === 'module.activate').length, 1);
    assert.equal(store.lifecycleTransitions.at(-1).transition, 'activate');
  });

  test('every blocker is reported at once, not the first', async () => {
    const store = published(new MemoryStore(), TENANT_A, leadRecoveryConfig({ compliance: { ...leadRecoveryConfig().compliance, status: 'pending' } }));
    must(await selectModule(store, await req(store)));
    must(await beginTesting(store, await req(store)));
    const result = await activateModule(store, await req(store));
    assert.equal(result.ok, false);
    const codes = result.blockers.map((b) => b.code);
    for (const code of ['activation_checks_failed', 'onboarding_incomplete', 'connection_not_ready', 'test_evidence_missing']) {
      assert.ok(codes.includes(code), `${code} missing from ${codes}`);
    }
  });

  test('missing connection evidence blocks activation — a configured number is not proof', async () => {
    const store = await underTest(published());
    await passTest(store);
    store.onboardingSteps = store.onboardingSteps.filter((s) => s.stepKey !== 'twilio_connected');
    const result = await activateModule(store, await req(store));
    assert.ok(result.blockers.some((b) => b.code === 'connection_not_ready' && /send_sms is unknown/.test(b.message)), JSON.stringify(result.blockers));
  });

  test('failing health blocks activation; unverified does not', async () => {
    const store = await underTest(published());
    await passTest(store);
    must(await reportHealth(store, { ...(await req(store)), status: 'failing', evidence: { source: 'monitor' } }));
    assert.equal((await activateModule(store, await req(store))).code, 'health_blocks_activation');
    must(await reportHealth(store, { ...(await req(store)), status: 'unverified', evidence: { source: 'monitor' } }));
    must(await activateModule(store, await req(store)));
  });

  test('the store refuses an activation without evidence, whatever the service was told', async () => {
    const store = await underTest(published());
    await assert.rejects(
      store.applyLifecycleTransition({
        tenantId: TENANT_A, moduleKey: LR, transition: 'activate', expectedStateVersion: lifecycleOf(store).stateVersion,
        actor: OPERATOR, reasonCode: 'forged', reason: null, idempotencyKey: 'forged-1',
        change: { pendingRequirements: [], authorized: await heads(store) },
      }),
      (error) => error.code === 'test_evidence_missing',
    );
    assert.equal(lifecycleOf(store).state, 'testing');
  });
});

describe('pause, resumption and deselection', () => {
  test('pausing blocks new runs at once, cancels queued contact, and keeps configuration, evidence and history', async () => {
    const store = await live();
    const sender = new RecordingSender();
    await intakeLead(deps(store, { live: sender }), missedCall());
    const history = store.lifecycleTransitions.length;
    const result = must(await pauseModule(store, await req(store)));
    assert.equal(result.cancelledActions, 1);
    assert.equal(store.configs.find((c) => c.tenantId === TENANT_A).enabled, false);
    const second = await intakeLead(deps(store, { live: sender }), missedCall({ phone: '+16145559922' }));
    assert.equal(second.run, null);
    await runDueActions(deps(store, { live: sender }), { tenantId: null });
    assert.equal(sender.sent.length, 0);
    assert.ok(store.moduleConfigVersions.length > 0 && store.lifecycleEvidence.length > 0);
    assert.equal(store.lifecycleTransitions.length, history + 1);
  });

  test('resumption is explicit and re-checks every gate against today', async () => {
    const store = await live();
    must(await pauseModule(store, await req(store)));
    store.onboardingSteps = store.onboardingSteps.filter((s) => s.stepKey !== 'twilio_connected');
    const refused = await resumeModule(store, await req(store));
    assert.equal(refused.ok, false);
    assert.ok(refused.blockers.some((b) => b.code === 'connection_not_ready'));
    onboard(store);
    const resumed = must(await resumeModule(store, await req(store)));
    assert.equal(resumed.lifecycle.state, 'active');
  });

  test('health recovering never brings a paused module back', async () => {
    const store = await live();
    must(await pauseModule(store, await req(store)));
    must(await reportHealth(store, { ...(await req(store)), status: 'failing', evidence: { source: 'monitor' } }));
    must(await reportHealth(store, { ...(await req(store)), status: 'healthy', evidence: { source: 'monitor' } }));
    assert.equal(lifecycleOf(store).state, 'paused');
    assert.equal(store.configs.find((c) => c.tenantId === TENANT_A).enabled, false);
  });

  test('deselecting blocks execution, cancels queued contact and keeps history; selecting again starts over', async () => {
    const store = await live();
    const sender = new RecordingSender();
    await intakeLead(deps(store, { live: sender }), missedCall());
    const result = must(await deselectModule(store, await req(store)));
    assert.equal(result.lifecycle.state, 'unselected');
    assert.equal(result.cancelledActions, 1);
    assert.equal((await intakeLead(deps(store, { live: sender }), missedCall({ phone: '+16145559933' }))).run, null);
    must(await selectModule(store, await req(store)));
    assert.equal(lifecycleOf(store).state, 'configuring');
    assert.equal((await activateModule(store, await req(store))).code, 'illegal_transition');
    assert.ok(store.lifecycleTransitions.length >= 6, 'every step is still on the record');
  });

  test('a handoff queued before a pause still opens — a person still gets the lead — but sends nothing', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { live: sender });
    await intakeLead(d, missedCall({ serviceRequest: 'I smell gas in the kitchen' }));
    const queued = store.actions.find((a) => a.actionType === 'open_handoff');
    assert.ok(queued, 'the safety rules queued a handoff');
    must(await pauseModule(store, await req(store)));
    assert.equal(queued.status, 'pending', 'a pause leaves a handoff on the queue');
    await runDueActions(d, { tenantId: null });
    assert.equal(store.handoffs.length, 1);
    assert.equal(sender.sent.length, 0, 'no staff alert and no acknowledgement while paused');
  });
});

describe('concurrency and idempotency', () => {
  test('a stale expected version is refused and nothing moves', async () => {
    const store = await live();
    const stale = lifecycleOf(store).stateVersion - 1;
    const result = await pauseModule(store, { ...(await req(store)), expectedStateVersion: stale });
    assert.equal(result.code, 'stale_state');
    assert.equal(lifecycleOf(store).state, 'active');
  });

  test('an expected version is required', async () => {
    const store = await live();
    assert.equal((await pauseModule(store, { ...(await req(store)), expectedStateVersion: undefined })).code, 'stale_state');
  });

  test('the same idempotency key twice is one transition, and the second answer is the first', async () => {
    const store = await live();
    const request = { ...(await req(store)), idempotencyKey: 'pause-once' };
    const first = must(await pauseModule(store, request));
    const again = must(await pauseModule(store, request));
    assert.equal(again.replayed, true);
    assert.equal(again.transition.id, first.transition.id);
    assert.equal(store.lifecycleTransitions.filter((t) => t.idempotencyKey === 'pause-once').length, 1);
  });

  test('an idempotency key reused for a different transition is refused', async () => {
    const store = await live();
    must(await pauseModule(store, { ...(await req(store)), idempotencyKey: 'k-1' }));
    const result = await resumeModule(store, { ...(await req(store)), idempotencyKey: 'k-1' });
    assert.equal(result.code, 'idempotency_conflict');
  });

  test('two operators acting on the same version: exactly one wins, the other is told it is stale', async () => {
    const store = await live();
    const version = lifecycleOf(store).stateVersion;
    const [pause, deselect] = await Promise.all([
      pauseModule(store, { tenantId: TENANT_A, moduleKey: LR, actor: OPERATOR, expectedStateVersion: version }),
      deselectModule(store, { tenantId: TENANT_A, moduleKey: LR, actor: OPERATOR, expectedStateVersion: version }),
    ]);
    assert.equal([pause, deselect].filter((r) => r.ok).length, 1);
    assert.equal([pause, deselect].find((r) => !r.ok).code, 'stale_state');
    assert.equal(lifecycleOf(store).stateVersion, version + 1);
  });
});

describe('unknown and legacy states fail closed', () => {
  test('a state this build does not know refuses every transition and every run', async () => {
    const store = await live();
    lifecycleOf(store).state = 'retired';
    assert.equal((await pauseModule(store, await req(store))).code, 'lifecycle_state_unknown');
    const sender = new RecordingSender();
    const result = await intakeLead(deps(store, { live: sender }), missedCall());
    assert.equal(result.run, null);
    assert.match(store.eventsOfType('automation_completed').at(-1).event.payload.detail, /^lifecycle_state_unknown:/);
    const outcome = await reconcileConfigChange(store, { tenantId: TENANT_A, moduleKey: LR });
    assert.equal(outcome.applied, false, 'nothing is written on top of a state nobody understands');
  });

  test('a legacy run with no run mode cannot act, even on an active module', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { live: sender });
    await intakeLead(d, missedCall());
    realRun(store).runMode = null; // what every run created before 0015 looks like
    const summary = await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0);
    assert.match(summary.details[0].outcome, /^run_authorization_unproven/);
  });
});

describe('permissions', () => {
  test('somebody who is not an operator is refused by the store, whatever the service passes', async () => {
    const store = published();
    const result = await selectModule(store, { ...(await req(store)), actor: STRANGER });
    assert.equal(result.code, 'forbidden');
    assert.equal(store.lifecycles.length, 0);
  });

  test('an actor with no identity is refused', async () => {
    const store = published();
    assert.equal((await selectModule(store, { ...(await req(store)), actor: { type: 'operator', id: null } })).code, 'unauthorized');
  });

  test('a health report needs evidence naming its source', async () => {
    const store = await live();
    assert.equal((await reportHealth(store, { ...(await req(store)), status: 'healthy', evidence: {} })).code, 'evidence_invalid');
    assert.equal((await reportHealth(store, { ...(await req(store)), status: 'splendid', evidence: { source: 'x' } })).code, 'evidence_invalid');
  });
});

/* ══ 3. change impact ═════════════════════════════════════ */

describe('every change-impact classification has one lifecycle consequence', () => {
  test('the policy covers every classification the registry and the recorder can produce', () => {
    assert.deepEqual(Object.keys(CHANGE_IMPACT_POLICY).sort(), [...IMPACT_CLASSIFICATIONS].sort());
    for (const c of IMPACT_CLASSIFICATIONS) {
      const p = CHANGE_IMPACT_POLICY[c];
      assert.equal(p.inFlightMayContinue, p.mayRemainActive, `${c}: a module that leaves active runs nothing in flight`);
      if (p.authorizationCarriesForward) assert.equal(p.requires.length, 0, `${c}: carrying forward means nothing is required`);
    }
  });

  test('an unknown or unreadable impact gets the most conservative treatment there is', () => {
    const everything = combineConsequences(['unknown_field']);
    assert.deepEqual(everything.requires, ['retest', 'shadow', 'review', 'reactivation']);
    assert.equal(everything.mayRemainActive, false);
    assert.deepEqual(classifyRecordedImpact({}, { scope: 'module', moduleKey: LR }), ['unclassified']);
    assert.deepEqual(classifyRecordedImpact(null, { scope: 'module', moduleKey: LR }), ['unclassified']);
    assert.deepEqual(combineConsequences(['not_a_classification']), combineConsequences(['unclassified']));
  });

  test('each registry field classifies by its own metadata — never by its name', () => {
    for (const schema of [LEAD_RECOVERY_SCHEMA, TENANT_SETTINGS_SCHEMA]) {
      for (const field of schema.fields) {
        const impact = { requires_retest: field.requiresRetest, requires_shadow: field.requiresShadow, requires_reactivation: field.requiresReactivation, unknown_fields: [], affected_modules: [LR] };
        const classes = classifyRecordedImpact(impact, { scope: schema.scope === 'tenant' ? 'tenant' : 'module', moduleKey: LR });
        const expected = [
          ...(field.requiresRetest ? ['requires_retest'] : []),
          ...(field.requiresShadow ? ['requires_shadow'] : []),
          ...(field.requiresReactivation ? ['requires_reactivation'] : []),
        ];
        assert.deepEqual(classes, expected.length ? expected : ['no_consequence'], `${schema.key}.${field.key}`);
      }
    }
  });

  test('a tenant-settings change a module does not read is no consequence to it', () => {
    const impact = { requires_retest: true, requires_shadow: false, requires_reactivation: false, unknown_fields: [], affected_modules: ['some_other_module'] };
    assert.deepEqual(classifyRecordedImpact(impact, { scope: 'tenant', moduleKey: LR }), ['no_consequence']);
  });
});

describe('what a publication does to a live module', () => {
  test('no consequence (services): stays live, authorisation carries to the new versions, and the decision names both', async () => {
    const store = await live();
    const before = lifecycleOf(store).authorized;
    const result = await publish(store, { services: ['furnace repair'] });
    const lc = lifecycleOf(store);
    assert.equal(lc.state, 'active');
    assert.deepEqual(lc.authorized, await heads(store));
    const decision = store.lifecycleTransitions.at(-1);
    assert.equal(decision.transition, 'apply_config_change');
    assert.deepEqual(decision.previousVersions, before);
    assert.deepEqual(decision.versions, await heads(store));
    assert.deepEqual(decision.impact.classifications, ['no_consequence']);
    assert.equal(result.published.at(-1).lifecycle[0].note, 'consequence-free: live authorisation carried to the new versions');
    const next = await intakeLead(deps(store), missedCall());
    assert.equal(next.ok, true, 'new live runs start under the new versions');
  });

  test('requires retest (templates): stays active, holds new runs, in-flight runs keep their words, a passing retest resumes it', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { live: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });
    const followup = realActions(store).find((a) => a.actionType === 'send_followup');

    const templates = { ...leadRecoveryConfig().templates, followup: '{{company}} again — checking in. Reply with what you need.' };
    await publish(store, { templates });
    assert.equal(lifecycleOf(store).state, 'active', 'the operator\'s decision stands');
    assert.deepEqual(lifecycleOf(store).pendingRequirements, ['retest']);

    const held = await intakeLead(d, missedCall({ phone: '+16145559922' }));
    assert.equal(held.run, null);
    assert.match(store.eventsOfType('automation_completed').at(-1).event.payload.detail, /^requirements_pending:/);

    followup.runAt = NOW.toISOString();
    await runDueActions(d, { tenantId: null });
    assert.match(sender.sent.at(-1).body, /just checking we've got this right/, 'the in-flight follow-up sent its pinned words');

    const retest = await passTest(store);
    assert.deepEqual(retest.lifecycle.authorized, await heads(store), 'a passing retest authorises the new versions');
    assert.deepEqual(retest.lifecycle.pendingRequirements, []);
    assert.equal(retest.lifecycle.state, 'active', 'no reactivation was needed');
    assert.equal((await intakeLead(d, missedCall({ phone: '+16145559933' }))).ok, true);
  });

  test('requires reactivation (compliance): pauses as the system, stops in-flight work, and needs an operator', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { live: sender });
    await intakeLead(d, missedCall());
    await publish(store, { compliance: { ...leadRecoveryConfig().compliance, campaign_ref: 'CMP999' } });
    const lc = lifecycleOf(store);
    assert.equal(lc.state, 'paused');
    assert.deepEqual(lc.pendingRequirements, ['retest', 'review', 'reactivation']);
    const pause = store.lifecycleTransitions.at(-1);
    assert.equal(pause.transition, 'system_pause');
    assert.equal(pause.actorType, 'system');
    assert.equal(pause.reasonCode, 'config_change_requires_reactivation');
    assert.equal(store.configs.find((c) => c.tenantId === TENANT_A).enabled, false);
    await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0, 'the queued first response under the withdrawn configuration never sent');

    const refused = await resumeModule(store, await req(store));
    assert.ok(refused.blockers.some((b) => b.code === 'test_evidence_missing' && /earlier configuration/.test(b.message)), 'old test evidence is rejected');
    await passTest(store);
    assert.equal(lifecycleOf(store).state, 'paused', 'a passing test alone never brings it back');
    must(await resumeModule(store, await req(store)));
    assert.equal(lifecycleOf(store).state, 'active');
    assert.deepEqual(lifecycleOf(store).pendingRequirements, []);
  });

  test('requires shadow (safety): pauses, and resumption needs shadow evidence of the new versions', async () => {
    const store = await live();
    await publish(store, { safety: { ...leadRecoveryConfig().safety, emergency_keywords: ['sparks'] } });
    const lc = lifecycleOf(store);
    assert.equal(lc.state, 'paused');
    assert.deepEqual(lc.pendingRequirements, ['retest', 'shadow', 'review', 'reactivation']);

    await passTest(store);
    const noShadow = await resumeModule(store, await req(store));
    assert.ok(noShadow.blockers.some((b) => b.code === 'shadow_evidence_missing'));

    must(await enterShadow(store, await req(store)));
    assert.equal((await recordShadowReview(store, { ...(await req(store)), passed: true })).code, 'shadow_observations_missing');
    const observed = await intakeLead(deps(store), missedCall());
    assert.match(observed.outcome, /shadow mode — would have texted the customer/);
    must(await recordShadowReview(store, { ...(await req(store)), passed: true }));
    assert.deepEqual(lifecycleOf(store).pendingRequirements, ['review', 'reactivation']);
    must(await activateModule(store, await req(store)));
    assert.equal(lifecycleOf(store).state, 'active');
  });

  test('requires reactivation (sending number): the same stop, from a different field', async () => {
    const store = await live();
    await publish(store, { twilio: { ...leadRecoveryConfig().twilio, messaging_service_sid: 'MG99999999999999999999999999999999' } });
    assert.equal(lifecycleOf(store).state, 'paused');
    assert.ok(lifecycleOf(store).pendingRequirements.includes('reactivation'));
  });

  test('a tenant-settings change the module reads (timezone) needs a retest; one that carries no flag carries forward', async () => {
    const store = await live();
    await publish(store, { company_name: 'Halstead HVAC' });
    assert.deepEqual(lifecycleOf(store).authorized, await heads(store));
    await publish(store, { timezone: 'America/Chicago' });
    assert.equal(lifecycleOf(store).state, 'active');
    assert.deepEqual(lifecycleOf(store).pendingRequirements, ['retest']);
  });

  test('an unknown field on a published version pauses with every requirement', async () => {
    const store = await live();
    const head = await store.getConfigHead(TENANT_A, moduleScope(LR));
    store.moduleConfigVersions.push(Object.freeze({
      ...structuredClone(head), id: crypto.randomUUID(), version: head.version + 1, parentVersionId: head.id,
      changeImpact: { requires_retest: false, requires_shadow: false, requires_reactivation: false, unknown_fields: ['mystery'], changed_fields: ['mystery'] },
    }));
    const outcome = await reconcileConfigChange(store, { tenantId: TENANT_A, moduleKey: LR });
    assert.deepEqual(outcome.classifications, ['unknown_field']);
    assert.equal(lifecycleOf(store).state, 'paused');
    assert.deepEqual(lifecycleOf(store).pendingRequirements, ['retest', 'shadow', 'review', 'reactivation']);
  });

  test('an impact nobody can read pauses with every requirement', async () => {
    const store = await live();
    const head = await store.getConfigHead(TENANT_A, moduleScope(LR));
    store.moduleConfigVersions.push(Object.freeze({ ...structuredClone(head), id: crypto.randomUUID(), version: head.version + 1, parentVersionId: head.id, changeImpact: {} }));
    const outcome = await reconcileConfigChange(store, { tenantId: TENANT_A, moduleKey: LR });
    assert.deepEqual(outcome.classifications, ['unclassified']);
    assert.equal(lifecycleOf(store).state, 'paused');
  });

  test('a publication the lifecycle never heard about holds new runs rather than riding in', async () => {
    const store = await live();
    const head = await store.getConfigHead(TENANT_A, moduleScope(LR));
    store.moduleConfigVersions.push(Object.freeze({
      ...structuredClone(head), id: crypto.randomUUID(), version: head.version + 1, parentVersionId: head.id,
      changeImpact: { requires_retest: false, requires_shadow: false, requires_reactivation: false, unknown_fields: [] },
    }));
    const held = await intakeLead(deps(store), missedCall());
    assert.equal(held.run, null);
    assert.match(store.eventsOfType('automation_completed').at(-1).event.payload.detail, /^authorization_stale:/);
    await reconcileConfigChange(store, { tenantId: TENANT_A, moduleKey: LR });
    assert.equal((await intakeLead(deps(store), missedCall({ phone: '+16145559922' }))).ok, true, 'evaluated, it carries forward');
  });

  test('evaluating the same publication twice is one decision', async () => {
    const store = await live();
    await publish(store, { services: ['furnace repair'] });
    const count = store.lifecycleTransitions.length;
    const again = await reconcileConfigChange(store, { tenantId: TENANT_A, moduleKey: LR });
    assert.equal(again.applied, false);
    assert.equal(store.lifecycleTransitions.length, count);
  });

  test('the store refuses to carry authorisation across a change with consequences, whatever it is told', async () => {
    const store = await live();
    await publish(store, { templates: { ...leadRecoveryConfig().templates, followup: '{{company}} — still here if you need us.' } });
    const lc = lifecycleOf(store);
    await assert.rejects(
      store.applyLifecycleTransition({
        tenantId: TENANT_A, moduleKey: LR, transition: 'apply_config_change', expectedStateVersion: lc.stateVersion,
        actor: { type: 'system', id: null }, reasonCode: 'forged', reason: null, idempotencyKey: 'forged-carry',
        change: { pendingRequirements: [], authorized: await heads(store) },
      }),
      (error) => error.code === 'requirements_pending',
    );
  });

  test('publication never activates: a module under test stays under test, whatever changed', async () => {
    const store = await underTest(published());
    await passTest(store);
    await publish(store, { services: ['water heater'] });
    assert.equal(lifecycleOf(store).state, 'testing');
    assert.equal(store.configs.find((c) => c.tenantId === TENANT_A).enabled, false);
  });

  test('restoring an old version is a new version, priced like any other; history is untouched', async () => {
    const store = await live();
    await publish(store, { booking_url: 'https://two.example/book' });
    const [v2, v1] = await listHistory(store, TENANT_A, moduleScope(LR));
    const frozen = structuredClone(v1);
    const rolled = await rollbackConfig(store, { tenantId: TENANT_A, scope: moduleScope(LR), versionId: v1.id, expectedVersion: v2.version, actor: { kind: 'operator', userId: FIXTURE_OPERATOR } });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.version.version, 3);
    assert.deepEqual(structuredClone(v1), frozen);
    assert.throws(() => { v1.config.company_name = 'rewritten'; }, TypeError, 'a published version cannot be edited');
    assert.deepEqual(lifecycleOf(store).authorized, await heads(store), 'a consequence-free rollback carries forward');
    assert.equal(rolled.lifecycle[0].transition, 'apply_config_change');
  });

  test('no run is ever repinned by a publication', async () => {
    const store = await live();
    await intakeLead(deps(store), missedCall());
    const pin = store.runs[0].configSnapshotId;
    await publish(store, { compliance: { ...leadRecoveryConfig().compliance, campaign_ref: 'CMP777' } });
    assert.equal(store.runs[0].configSnapshotId, pin);
    assert.ok(store.actions.every((a) => a.configSnapshotId === pin));
    assert.match((await loadPinnedConfig(store, store.runs[0])).config.compliance.campaign_ref, /CMP123/);
  });
});

/* ══ 4. just-in-time authorisation ═══════════════════════ */

describe('just-in-time authorisation refuses', () => {
  const start = async (store, { lead: leadOverrides = {}, ...overrides } = {}) => {
    const lead = { id: crypto.randomUUID(), tenantId: TENANT_A, isCanary: false, ...leadOverrides };
    const h = await heads(store);
    const resolved = await store.getConfigHead(TENANT_A, moduleScope(LR));
    return authorizeModuleExecution(store, {
      kind: 'start', tenantId: TENANT_A, moduleKey: LR, mode: 'live', lead, versions: h, config: resolved.config, ...overrides,
    });
  };

  test('an unselected module', async () => {
    assert.equal((await start(published())).code, 'module_not_selected');
  });

  test('a paused module', async () => {
    const store = await live();
    must(await pauseModule(store, await req(store)));
    assert.equal((await start(store)).code, 'module_paused');
  });

  test('live execution of a module that is not active', async () => {
    assert.equal((await start(await underTest(published()))).code, 'module_not_active');
  });

  test('failing or blocking health, and a health status nobody defined', async () => {
    for (const status of ['failing', 'blocking']) {
      const store = await live();
      must(await reportHealth(store, { ...(await req(store)), status, evidence: { source: 'monitor' } }));
      assert.equal((await start(store)).code, 'health_blocks_execution', status);
    }
    const store = await live();
    lifecycleOf(store).healthStatus = 'mystery';
    assert.equal((await start(store)).code, 'health_blocks_execution');
    assert.equal(healthPermits('mystery', 'test'), true, 'a synthetic test is how somebody finds out');
  });

  test('missing configuration', async () => {
    const store = await live();
    assert.equal((await start(store, { config: null })).code, 'config_not_ready');
  });

  test('a required connection that cannot be proven', async () => {
    const store = await live();
    store.onboardingSteps = store.onboardingSteps.filter((s) => s.stepKey !== 'twilio_connected');
    assert.equal((await start(store)).code, 'connection_not_ready');
  });

  test('a pending requirement: missing test evidence, or a missing review', async () => {
    const store = await live();
    lifecycleOf(store).pendingRequirements = ['retest'];
    assert.equal((await start(store)).code, 'requirements_pending');
    lifecycleOf(store).pendingRequirements = ['review'];
    assert.equal((await start(store)).code, 'requirements_pending');
  });

  test('stale activation evidence: the published versions are not the authorised ones', async () => {
    const store = await live();
    const head = await store.getConfigHead(TENANT_A, moduleScope(LR));
    store.moduleConfigVersions.push(Object.freeze({ ...structuredClone(head), id: crypto.randomUUID(), version: head.version + 1, parentVersionId: head.id }));
    assert.equal((await start(store)).code, 'authorization_stale');
  });

  test('a run pinned to anything but the authorised versions', async () => {
    const store = await live();
    assert.equal((await start(store, { versions: { tenantVersionId: 'x', moduleVersionId: 'y' } })).code, 'authorization_stale');
  });

  test('cross-tenant, mismatched module, mismatched run, action or snapshot, and a missing or legacy pin', async () => {
    const store = await live();
    await intakeLead(deps(store), missedCall());
    const run = realRun(store);
    const action = actionsOf(store, run)[0];
    const lead = realLead(store);
    const cont = (overrides) => authorizeModuleExecution(store, { kind: 'continue', tenantId: TENANT_A, moduleKey: LR, lead, run, action, ...overrides });

    assert.equal((await cont({ lead: { ...lead, tenantId: TENANT_B } })).code, 'identity_mismatch');
    assert.equal((await cont({ run: { ...run, tenantId: TENANT_B } })).code, 'identity_mismatch');
    assert.equal((await cont({ moduleKey: 'estimate_recovery' })).code, 'identity_mismatch');
    assert.equal((await cont({ action: { ...action, runId: crypto.randomUUID() } })).code, 'identity_mismatch');
    assert.equal((await cont({ action: { ...action, configSnapshotId: crypto.randomUUID() } })).code, 'snapshot_mismatch');
    assert.equal((await cont({ action: { ...action, configSnapshotId: null } })).code, 'snapshot_missing', 'a legacy unpinned action');
    assert.equal((await cont({ run: { ...run, configSnapshotId: null } })).code, 'snapshot_missing');
    assert.equal((await cont({ run: { ...run, configSnapshotId: crypto.randomUUID() }, action: { ...action, configSnapshotId: null } })).code, 'snapshot_missing');
  });

  test('a missing or invalid run mode — never treated as live', async () => {
    const store = await live();
    for (const mode of [undefined, null, 'LIVE', 'production']) {
      assert.equal((await start(store, { mode })).code, 'invalid_run_mode', String(mode));
    }
    assert.equal((await start(store, { lead: { isCanary: true } })).code, 'mode_not_permitted', 'a synthetic lead is never live');
  });

  test('customer state: an opt-out, a reply, a takeover, a safety escalation — and a second attempt at the same message', async () => {
    const cases = {
      suppressed: async (store) => store.addSuppression({ tenantId: TENANT_A, channel: 'sms', address: CUSTOMER, reason: 'opt_out', source: 'customer', createdAt: NOW.toISOString(), expiresAt: null }),
      customer_replied: async (store) => { (await store.getOrCreateConversation(TENANT_A, realLead(store).id)).lastInboundAt = NOW.toISOString(); },
      handoff_open: async (store) => { await takeOverLead(deps(store), { tenantId: TENANT_A, leadId: realLead(store).id }); realRun(store).state = 'response_queued'; },
    };
    for (const [code, arrange] of Object.entries(cases)) {
      const store = await live();
      await intakeLead(deps(store), missedCall());
      const [claimed] = await store.claimActions({ limit: 1, worker: 'w', nowIso: NOW.toISOString(), tenantId: TENANT_A });
      assert.equal(claimed.runId, realRun(store).id);
      await arrange(store);
      const result = await authorizeLeadRecoveryEffect(deps(store), {
        action: claimed, run: realRun(store), lead: realLead(store), config: (await loadPinnedConfig(store, realRun(store))).config,
        effectType: 'customer_sms', effectKey: `lr:effect:${claimed.idempotencyKey}`, destination: CUSTOMER, now: NOW,
      });
      assert.equal(result.ok, false, code);
      assert.equal(result.denial, code);
    }

    /* a safety escalation is an open handoff: the automation stays quiet. */
    const store = await live();
    await intakeLead(deps(store), missedCall({ serviceRequest: 'there is a gas smell' }));
    assert.ok(store.handoffs.length === 0 && realActions(store).some((a) => a.actionType === 'open_handoff'));
    await runDueActions(deps(store), { tenantId: null });
    assert.equal(store.handoffs[0].isSafety, true);

    /* the same message twice: the reservation refuses the second. */
    const twice = await live();
    const sender = new RecordingSender();
    await intakeLead(deps(twice, { live: sender }), missedCall());
    const [claimed] = await twice.claimActions({ limit: 1, worker: 'w', nowIso: NOW.toISOString(), tenantId: TENANT_A });
    const effect = async () => authorizeLeadRecoveryEffect(deps(twice, { live: sender }), {
      action: claimed, run: realRun(twice), lead: realLead(twice), config: (await loadPinnedConfig(twice, realRun(twice))).config,
      effectType: 'customer_sms', effectKey: 'lr:effect:twice', destination: CUSTOMER, now: NOW,
    });
    assert.equal((await effect()).ok, true);
    assert.equal((await effect()).denial, 'already_attempted');
  });

  test('a pause that lands after the dispatcher checked but before the reservation still stops the send', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { live: sender });
    await intakeLead(d, missedCall());
    /* the suppression read is the last thing `authorizeLeadRecoveryEffect` does before it
       reserves — after its own lifecycle check. pause in exactly that gap. */
    const original = store.isSuppressed.bind(store);
    let calls = 0;
    store.isSuppressed = async (...args) => {
      calls += 1;
      if (calls === 2) must(await pauseModule(store, await req(store)));
      return original(...args);
    };
    const summary = await runDueActions(d, { tenantId: null });
    assert.equal(sender.sent.length, 0);
    assert.match(summary.details[0].outcome, /^module_paused:/);
    assert.equal(realEffects(store).length, 0, 'nothing was reserved');
    assert.equal(store.handoffs.length, 0, 'an operator\'s pause is not a delivery failure');
  });

  test('the reservation refuses a live effect for a module that is not active, whoever asks', async () => {
    const store = await live();
    await intakeLead(deps(store), missedCall());
    must(await pauseModule(store, await req(store)));
    await assert.rejects(
      store.reserveEffect({ tenantId: TENANT_A, effectKey: 'x', effectType: 'customer_sms', idempotencyKey: 'x', worker: 'w', leaseToken: 'l', runId: realRun(store).id, leadId: realLead(store).id, isCanary: false }),
      (error) => error.code === 'module_paused',
    );
    await assert.rejects(
      store.reserveEffect({ tenantId: TENANT_A, effectKey: 'y', effectType: 'customer_sms', idempotencyKey: 'y', worker: 'w', leaseToken: 'l', runId: realRun(store).id, leadId: realLead(store).id, isCanary: true }),
      (error) => error.code === 'mode_not_permitted',
      'claiming a real lead is a canary does not get past it',
    );
  });

  test('every denial code the authoriser can return is a stable, documented one', () => {
    const source = readFileSync(new URL('../supabase/functions/_shared/lifecycle/authorize.ts', import.meta.url), 'utf8');
    const used = new Set([...source.matchAll(/deny\('([a-z_]+)'/g)].map((m) => m[1]));
    for (const code of used) assert.ok(EXECUTION_DENIAL_CODES.includes(code), `${code} is not in EXECUTION_DENIAL_CODES`);
  });
});

describe('just-in-time authorisation allows', () => {
  test('a synthetic test of a module under test, through the recording sender only', async () => {
    const store = await underTest(published());
    const live = new RecordingSender();
    const canary = new RecordingSender();
    const intake = await intakeLead(deps(store, { live, canary }), canaryLead());
    await runDueActions(deps(store, { live, canary }), { tenantId: TENANT_A, canaryOnly: true });
    assert.equal(store.runs[0].runMode, 'test');
    assert.equal(intake.ok, true);
    assert.equal(live.sent.length, 0);
    assert.equal(canary.sent.length, 1);
  });

  test('a new live run under exactly the authorised current versions', async () => {
    const store = await live();
    const result = await intakeLead(deps(store), missedCall());
    assert.equal(result.ok, true);
    assert.equal(realRun(store).runMode, 'live');
    const snapshot = store.snapshots.find((s) => s.id === realRun(store).configSnapshotId);
    assert.deepEqual({ tenantVersionId: snapshot.tenantConfigVersionId, moduleVersionId: snapshot.moduleConfigVersionId }, lifecycleOf(store).authorized);
  });

  test('an existing run continuing under its original snapshot when state and safety permit', async () => {
    const store = await live();
    const sender = new RecordingSender();
    const d = deps(store, { live: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });
    await publish(store, { services: ['water heater'] });
    const followup = realActions(store).find((a) => a.actionType === 'send_followup');
    followup.runAt = NOW.toISOString();
    await runDueActions(d, { tenantId: null });
    assert.equal(followup.status, 'done');
    assert.equal(sender.sent.length, 2);
  });

  test('a degraded dependency does not stop live work — by explicit policy', async () => {
    assert.equal(HEALTH_POLICY.degraded.live_start, true);
    const store = await live();
    must(await reportHealth(store, { ...(await req(store)), status: 'degraded', evidence: { source: 'monitor' } }));
    assert.equal((await intakeLead(deps(store), missedCall())).ok, true);
    assert.match(effectiveStatus(lifecycleOf(store), await heads(store)).headline, /active · health degraded/);
  });
});

/* ══ 5. shadow ═════════════════════════════════════════════ */

describe('shadow mode touches nobody', () => {
  async function inShadow() {
    const store = await underTest(published());
    await passTest(store);
    must(await enterShadow(store, await req(store)));
    return store;
  }

  test('a real lead in shadow: no provider is called, nothing is queued or reserved, and the outcome is a labelled "would have"', async () => {
    const store = await inShadow();
    const live = new RecordingSender();
    const canary = new RecordingSender();
    const result = await intakeLead(deps(store, { live, canary }), missedCall());
    await runDueActions(deps(store, { live, canary }), { tenantId: null });

    assert.equal(live.sent.length + canary.sent.length, 0);
    assert.equal(realActions(store).length, 0);
    assert.equal(realEffects(store).length, 0);
    assert.equal(realRun(store).runMode, 'shadow');
    assert.equal(realRun(store).stopReason, 'not_permitted');
    assert.match(result.outcome, /^shadow mode — would have texted the customer \(first_response\); nothing was sent/);

    const [observation] = store.lifecycleEvidence.filter((e) => e.kind === 'shadow_observation');
    assert.equal(observation.simulated, true);
    assert.equal(observation.summary.would_have, 'send_first_response');
    assert.doesNotMatch(JSON.stringify(observation.summary), /Dana|\+1614/, 'no names or numbers in evidence');
  });

  test('shadow outcomes are never real outcomes: no sms_sent, no delivery, no booking, no routing', async () => {
    const store = await inShadow();
    await intakeLead(deps(store), missedCall());
    await intakeLead(deps(store), missedCall({ phone: '+16145559922', serviceRequest: 'smell of gas' }));
    const types = new Set(realEvents(store).map((e) => e.event.event_type));
    for (const real of ['sms_sent', 'message_delivered', 'lead_booked', 'routed', 'lead_qualified', 'handoff_requested']) {
      assert.ok(!types.has(real), `${real} was emitted for a shadow run`);
    }
    assert.deepEqual(store.lifecycleEvidence.filter((e) => e.kind === 'shadow_observation').map((e) => e.summary.would_have).sort(), ['handoff', 'send_first_response']);
  });

  test('nothing can be queued against a shadow run, and no effect can be reserved for one', async () => {
    const store = await inShadow();
    await intakeLead(deps(store), missedCall());
    const run = realRun(store);
    await assert.rejects(store.scheduleAction({ tenantId: TENANT_A, runId: run.id, actionType: 'send_followup', runAt: NOW.toISOString(), idempotencyKey: 'shadow-q', payload: {} }), (e) => e.code === 'shadow_no_effects');
    const lead = realLead(store);
    const decision = await authorizeModuleExecution(store, { kind: 'effect', tenantId: TENANT_A, moduleKey: LR, lead, run, capability: 'send_sms' });
    assert.equal(decision.code, 'shadow_no_effects');
    await assert.rejects(
      store.reserveEffect({ tenantId: TENANT_A, effectKey: 's', effectType: 'customer_sms', idempotencyKey: 's', worker: 'w', leaseToken: 'l', runId: run.id, leadId: lead.id, isCanary: false }),
      (e) => e.code === 'module_not_active',
    );
  });

  test('a reply to a shadow lead is recorded and starts nothing', async () => {
    const store = await inShadow();
    const live = new RecordingSender();
    await intakeLead(deps(store, { live }), missedCall());
    const reply = await handleInboundMessage(deps(store, { live }), { tenantId: TENANT_A, from: CUSTOMER, to: '+16145550100', body: 'yes please', providerMessageId: 'SMshadow1', occurredAt: NOW });
    assert.equal(reply.ok, true);
    assert.equal(realActions(store).length, 0);
    assert.equal(live.sent.length, 0);
  });

  test('a synthetic lead is never shadow, and a real lead is never test', async () => {
    const store = await inShadow();
    const canary = await intakeLead(deps(store), canaryLead());
    assert.equal(canary.run.runMode, 'test');
    await assert.rejects(
      store.createRun({ id: crypto.randomUUID(), tenantId: TENANT_A, leadId: store.leads.find((l) => l.isCanary).id, moduleKey: LR, state: 'new', configVersion: 1, configSnapshotId: store.snapshots[0].id, runMode: 'shadow', stoppedAt: null, completedAt: null, stopReason: null, lastError: null }),
      (e) => e.code === 'mode_not_permitted',
    );
  });

  test('leaving shadow stops observation, and the observations stay as evidence', async () => {
    const store = await inShadow();
    await intakeLead(deps(store), missedCall());
    must(await exitShadow(store, await req(store)));
    const after = await intakeLead(deps(store), missedCall({ phone: '+16145559922' }));
    assert.equal(after.run, null);
    assert.equal(store.lifecycleEvidence.filter((e) => e.kind === 'shadow_observation').length, 1);
  });
});

/* ══ 6. the effective status keeps lifecycle and health apart ═ */

describe('lifecycle and health are separate facts, explained together', () => {
  test('active and held reads as active, never as paused', async () => {
    const store = await live();
    must(await reportHealth(store, { ...(await req(store)), status: 'failing', evidence: { source: 'monitor', capabilities: ['send_sms'] } }));
    const status = await getLifecycleStatus(store, TENANT_A, LR);
    assert.equal(status.effective.state, 'active');
    assert.equal(status.effective.health, 'failing');
    assert.equal(status.effective.live, false);
    assert.ok(status.effective.holds.some((h) => h.code === 'health_blocks_execution'));
    assert.equal(lifecycleOf(store).state, 'active', 'the overlay never rewrites the operator\'s decision');
  });

  test('unverified is never reported as healthy', async () => {
    const store = await live();
    const status = await getLifecycleStatus(store, TENANT_A, LR);
    assert.equal(status.effective.health, 'unverified');
    assert.match(status.effective.headline, /health unverified/);
  });

  test('a capability the overlay names as failing is unhealthy in connection readiness', async () => {
    const store = await live();
    must(await reportHealth(store, { ...(await req(store)), status: 'degraded', evidence: { source: 'monitor', capabilities: ['send_sms'] } }));
    const status = await getLifecycleStatus(store, TENANT_A, LR);
    assert.equal(status.activation.connections.capabilities.find((c) => c.capability === 'send_sms').status, 'unhealthy');
  });
});

/* ══ 7. the fixtures are what the tests say ═══════════════ */

describe('the lifecycle fixture is what the runtime suites assume', () => {
  test('a seeded active lifecycle is authorised on the current versions with a passing test behind it', async () => {
    const store = new MemoryStore();
    seedPublishedConfig(store, { tenantId: TENANT_A, config: leadRecoveryConfig() });
    const lc = lifecycleOf(store);
    assert.equal(lc.state, 'active');
    assert.deepEqual(lc.authorized, await heads(store));
    assert.equal(store.lifecycleEvidence.find((e) => e.id === lc.testEvidenceId).outcome, 'passed');
    assert.ok(getField(LR === 'lead_recovery' ? 'lead_recovery_config' : '', 'templates').requiresRetest);
  });

  test('seedLifecycle refuses to invent an authorisation without published configuration', () => {
    assert.throws(() => seedLifecycle(new MemoryStore(), { tenantId: TENANT_A, state: 'active' }), /needs published configuration/);
  });
});
